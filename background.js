/* Extension service worker: downloads, media reads and toolbar events. */
importScripts('content/core.js');

const { MESSAGES, bytesToBase64, safeFilename } = self.ChatExportKit;
const DOWNLOAD_TIMEOUT_MS = 120000;

const SITE_HOSTS = {
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'gemini.google.com': 'gemini',
  'chat.deepseek.com': 'deepseek',
};
const ICONS = {
  chatgpt: { 16: 'icons/chatgpt-16.png', 32: 'icons/chatgpt-32.png' },
  gemini: { 16: 'icons/gemini-16.png', 32: 'icons/gemini-32.png' },
  deepseek: { 16: 'icons/deepseek-16.png', 32: 'icons/deepseek-32.png' },
};
const MEDIA_HOSTS = ['oaiusercontent.com', 'googleusercontent.com', 'usercontent.google.com'];
const pendingDownloads = new Map();

function api(method, argument) {
  return new Promise((resolve, reject) => {
    method(argument, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function validHost(hostname, domains) {
  return domains.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function siteOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? SITE_HOSTS[parsed.hostname] || null : null;
  } catch {
    return null;
  }
}

function senderSite(sender) {
  return siteOf(sender?.url || sender?.tab?.url);
}

function storedRecord(value) {
  if (typeof value === 'number') return { downloadId: value };
  return value && typeof value === 'object' ? value : {};
}

function basename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop();
}

function withSuffix(filename, id, length) {
  const suffix = String(id).replace(/[^a-z0-9_-]/gi, '').slice(0, length) || 'chat';
  return `${filename.replace(/\.md$/i, '')} [${suffix}].md`;
}

async function existsByName(filename, excludedIds = new Set()) {
  const hits = await api(chrome.downloads.search.bind(chrome.downloads), {
    query: [filename.replace(/\.md$/i, '')],
  });
  return hits.some((item) => item.exists !== false && !excludedIds.has(item.id) &&
    basename(item.filename).toLowerCase() === filename.toLowerCase());
}

async function activeDownload(id, filename) {
  if (!id || !filename) return false;
  try {
    const hits = await api(chrome.downloads.search.bind(chrome.downloads), { id });
    return hits.some((item) => item.exists !== false &&
      basename(item.filename).toLowerCase() === filename.toLowerCase());
  } catch {
    return false;
  }
}

async function filenameFor(id, preferred, previous, records) {
  if (previous.preferred === preferred) return preferred;
  const excluded = new Set(previous.downloadId ? [previous.downloadId] : []);

  async function available(filename) {
    for (const [key, value] of Object.entries(records)) {
      if (key === `download-${id}`) continue;
      const other = storedRecord(value);
      if (other.filename?.toLowerCase() === filename.toLowerCase() &&
          await activeDownload(other.downloadId, filename)) return false;
    }
    return !(await existsByName(filename, excluded));
  }

  if (await available(preferred)) return preferred;
  for (const length of [8, 12, 36]) {
    const candidate = withSuffix(preferred, id, length);
    if (await available(candidate)) return candidate;
  }
  for (let sequence = 2; sequence < 10000; sequence++) {
    const candidate = withSuffix(preferred, `${id}-${sequence}`, 48);
    if (await available(candidate)) return candidate;
  }
  throw new Error('无法生成不冲突的下载文件名。');
}

function awaitDownload(id) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;

    function finish(error) {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }

    function state(value, error) {
      if (value === 'complete') finish();
      else if (value === 'interrupted') {
        finish(new Error(`下载未完成（${error || 'interrupted'}）。`));
      }
    }

    function listener(event) {
      if (event?.id === id && event.state) state(event.state.current, event.error?.current);
    }

    chrome.downloads.onChanged.addListener(listener);
    timer = setTimeout(() => finish(new Error('下载完成等待超时。')), DOWNLOAD_TIMEOUT_MS);
    chrome.downloads.search({ id }, (items) => {
      if (chrome.runtime.lastError) return;
      const current = items?.[0];
      if (current) state(current.state, current.error);
    });
  });
}

async function downloadMarkdown(message) {
  const markdown = String(message.markdown || '');
  if (!markdown.trim()) throw new Error('导出内容为空，已取消下载。');

  const id = String(message.conversationId || 'chat');
  const preferred = safeFilename(message.filename || 'Conversation');
  const key = `download-${id}`;
  const records = await api(chrome.storage.local.get.bind(chrome.storage.local), null);
  const previous = storedRecord(records[key]);

  // Only overwrite a file associated with a successful export of this conversation.
  // An initial export always avoids touching unrelated files with the same name.
  const trackedName = previous.filename || '';
  const trackedFile = trackedName && await activeDownload(previous.downloadId, trackedName);
  const otherOwner = trackedFile && (await Promise.all(
    Object.entries(records)
      .filter(([recordKey]) => recordKey !== key && recordKey.startsWith('download-'))
      .map(async ([, value]) => {
        const other = storedRecord(value);
        return other.filename?.toLowerCase() === trackedName.toLowerCase() &&
          await activeDownload(other.downloadId, trackedName);
      }),
  )).some(Boolean);
  const overwrite = Boolean(trackedFile && !otherOwner);
  const filename = overwrite ? trackedName : await filenameFor(id, preferred, previous, records);

  const downloadId = await api(chrome.downloads.download.bind(chrome.downloads), {
    url: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
    filename,
    conflictAction: overwrite ? 'overwrite' : 'uniquify',
    saveAs: false,
  });
  await awaitDownload(downloadId);

  let actualFilename = filename;
  try {
    const [item] = await api(chrome.downloads.search.bind(chrome.downloads), { id: downloadId });
    if (item?.filename) actualFilename = basename(item.filename);
  } catch {}

  let warning = '';
  try {
    await api(chrome.storage.local.set.bind(chrome.storage.local), {
      [key]: {
        downloadId,
        filename: actualFilename,
        preferred,
        tier: message.tier || '',
        updatedAt: Date.now(),
      },
    });
  } catch (error) {
    warning = `File downloaded, but the export record could not be saved: ${error?.message || String(error)}`;
  }

  // A prior export may have been edited by the user. Never delete it automatically.
  return { downloadId, filename: actualFilename, ...(warning ? { warning } : {}) };

}

function queueDownload(message) {
  const id = String(message.conversationId || 'chat');
  const previous = pendingDownloads.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => downloadMarkdown(message));
  pendingDownloads.set(id, current);
  const clear = () => {
    if (pendingDownloads.get(id) === current) pendingDownloads.delete(id);
  };
  current.then(clear, clear);
  return current;
}

function parseMediaUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('资源地址无效。'); }
  if (url.protocol !== 'https:') throw new Error('只允许读取 HTTPS 资源。');
  if (!validHost(url.hostname, MEDIA_HOSTS)) {
    throw new Error(`不允许读取该域名：${url.hostname}`);
  }
  return url;
}

async function readBody(response) {
  if (!response.body?.getReader) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function fetchMedia(message) {
  const url = parseMediaUrl(message.url);
  const options = {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
  };
  if (/(?:^|\.)(?:usercontent\.google\.com|googleusercontent\.com)$/i.test(url.hostname)) {
    options.referrer = 'https://gemini.google.com/';
  }
  const response = await fetch(url.href, options);
  if (!response.ok) throw new Error(`资源请求失败（HTTP ${response.status}）。`);
  const finalUrl = new URL(response.url || url.href);
  if (!validHost(finalUrl.hostname, MEDIA_HOSTS)) {
    throw new Error(`不允许读取该域名：${finalUrl.hostname}`);
  }

  const bytes = await readBody(response);
  if (bytes.length === 0) throw new Error('资源内容为空。');
  return {
    base64: bytesToBase64(bytes),
    mimeType: response.headers.get('content-type') || '',
    size: bytes.length,
  };
}

function respond(work, sendResponse) {
  Promise.resolve().then(work).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) }),
  );
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  const site = senderSite(sender);
  if (!site) {
    if ([MESSAGES.download, MESSAGES.fetchMedia, 'site-detected'].includes(message.type)) {
      sendResponse({ ok: false, error: '不允许的消息来源。' });
    }
    return false;
  }

  if (message.type === 'site-detected') {
    if (sender.tab?.id != null && message.site === site) {
      chrome.action.setIcon({ tabId: sender.tab.id, path: ICONS[site] }, () => {
        void chrome.runtime.lastError;
      });
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === MESSAGES.download) {
    return respond(() => queueDownload(message), sendResponse);
  }
  if (message.type === MESSAGES.fetchMedia) {
    return respond(() => fetchMedia(message), sendResponse);
  }
  return false;
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || !siteOf(tab.url)) return;
  chrome.tabs.sendMessage(tab.id, { type: MESSAGES.run }, () => {
    void chrome.runtime.lastError;
  });
});
