/* Gemini RPC client and conversation parser. */
(function initGeminiAdapter(root) {
  'use strict';

  const NS = root.ChatExportKit;

  const PLATFORM = 'Gemini';
  const READ_CHAT_RPC = 'hNvQHb';
  const LIST_CHATS_RPC = 'MaZiqc';
  const HISTORY_PAGE_SIZE = 100;
  const MAX_HISTORY_PAGES = 200;

  function isConversationPage() {
    return /^(?:\/u\/\d+)?\/app(?:\/|$)/i.test(location.pathname);
  }

  function getAccountPrefix() {
    return (location.pathname.match(/^\/u\/\d+/i) || [''])[0];
  }

  function getConversationId() {
    const match = location.pathname.match(/^(?:\/u\/\d+)?\/app\/([^/?#]+)/i);
    if (!match) throw new Error('请先打开一条具体的 Gemini 对话。');
    return match[1];
  }


  function decodeEmbeddedString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
    }
  }

  function extractEmbeddedValue(source, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(source).match(new RegExp(`"${escapedKey}":"((?:\\\\.|[^"\\\\])*)"`));
    return match ? decodeEmbeddedString(match[1]) : '';
  }

  function extractTokens(source) {
    return {
      accessToken: extractEmbeddedValue(source, 'SNlM0e'),
      buildLabel: extractEmbeddedValue(source, 'cfb2h'),
      sessionId: extractEmbeddedValue(source, 'FdrFJe'),
    };
  }

  async function getGeminiTokens() {
    const scriptSource = [...document.scripts].map((script) => script.textContent || '').join('\n');
    let tokens = extractTokens(scriptSource);
    if (tokens.accessToken) return tokens;

    const prefix = getAccountPrefix();
    const response = await fetch(`${prefix}/app`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`无法初始化 Gemini 会话（HTTP ${response.status}）。`);

    tokens = extractTokens(await response.text());
    if (!tokens.accessToken) {
      throw new Error('未能读取 Gemini 会话令牌，请确认已经登录并刷新页面。');
    }
    return tokens;
  }


  function utf8FrameEnd(source, start, size) {
    let bytes = 0;
    let cursor = start;
    while (cursor < source.length && bytes < size) {
      const point = source.codePointAt(cursor);
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      cursor += point > 0xffff ? 2 : 1;
    }
    return bytes === size ? cursor : -1;
  }

  function parseLengthPrefixedFrames(responseText) {
    const source = String(responseText).replace(/^\)\]\}'\r?\n/, '');
    const frames = [];
    let cursor = 0;

    while (cursor < source.length) {
      while (source[cursor] === '\n' || source[cursor] === '\r' || source[cursor] === ' ') cursor++;
      if (cursor >= source.length) break;

      const newline = source.indexOf('\n', cursor);
      if (newline < 0) break;
      const lengthText = source.slice(cursor, newline).trim();
      if (!/^\d+$/.test(lengthText)) break;

      const length = Number(lengthText);
      const start = newline + 1;
      const end = utf8FrameEnd(source, start, length);
      if (end < 0) break;
      try {
        frames.push(JSON.parse(source.slice(start, end)));
      } catch {
        break;
      }
      cursor = end;
    }

    if (frames.length) return frames;
    return source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('[')).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  function findRpcPayload(value, rpcId) {
    if (!Array.isArray(value)) return null;

    const isEnvelope = (
      (value[0] === 'wrb.fr' && value[1] === rpcId) ||
      value[0] === rpcId ||
      value[1] === rpcId
    );
    if (isEnvelope && typeof value[2] === 'string') {
      try {
        return JSON.parse(value[2]);
      } catch {
        return null;
      }
    }

    for (const child of value) {
      const result = findRpcPayload(child, rpcId);
      if (result !== null) return result;
    }
    return null;
  }

  async function callGeminiRpc(rpcId, rpcArguments, tokens) {
    const prefix = getAccountPrefix();
    const query = new URLSearchParams({
      rpcids: rpcId,
      'source-path': location.pathname.replace(/\/+$/, ''),
      hl: document.documentElement.lang || 'zh-CN',
      _reqid: String(Math.floor(1000 + Math.random() * 8999)),
      rt: 'c',
    });
    if (tokens.buildLabel) query.set('bl', tokens.buildLabel);
    if (tokens.sessionId) query.set('f.sid', tokens.sessionId);

    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(rpcArguments), null, 'generic']]]),
      at: tokens.accessToken,
    });

    const response = await fetch(`${prefix}/_/BardChatUi/data/batchexecute?${query}`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
      },
      body: `${body.toString()}&`,
    });
    if (!response.ok) throw new Error(`无法读取完整对话（HTTP ${response.status}）。`);

    const frames = parseLengthPrefixedFrames(await response.text());
    for (const frame of frames) {
      const payload = findRpcPayload(frame, rpcId);
      if (payload !== null) return payload;
    }
    throw new Error('Gemini 返回了无法识别的对话数据，内部接口可能已经更新。');
  }

  function parseConversationPage(payload) {
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
      throw new Error('Gemini 返回了无法识别的对话分页数据，内部接口可能已经更新。');
    }
    return {
      turns: payload[0],
      cursor: typeof payload[1] === 'string' && payload[1] ? payload[1] : null,
    };
  }

  function turnIdentity(turn) {
    const responseId = turn && turn[0] && turn[0][1];
    if (typeof responseId === 'string' && responseId) return responseId;
    const parentId = turn && turn[1] && turn[1][1];
    return typeof parentId === 'string' ? parentId : '';
  }

  async function fetchConversation(chatId) {
    const tokens = await getGeminiTokens();
    const conversationKey = chatId.startsWith('c_') ? chatId : `c_${chatId}`;
    const turns = [];
    const seenTurnIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
      const rpcArguments = [conversationKey, HISTORY_PAGE_SIZE, cursor, 1, [0], [4], null, 1];

      let payload;
      try {
        payload = await callGeminiRpc(READ_CHAT_RPC, rpcArguments, tokens);
      } catch (error) {
        throw new Error(`读取对话第 ${page} 页失败：${error && error.message ? error.message : String(error)}`);
      }

      const historyPage = parseConversationPage(payload);
      let added = 0;
      for (const turn of historyPage.turns) {
        if (!Array.isArray(turn)) continue;
        const turnId = turnIdentity(turn);
        if (turnId && seenTurnIds.has(turnId)) continue;
        if (turnId) seenTurnIds.add(turnId);
        turns.push(turn);
        added++;
      }

      if (!historyPage.cursor) {
        return { payload: [turns], tokens, pages: page };
      }
      if (!historyPage.turns.length || !added) {
        throw new Error(`Gemini 在第 ${page} 页返回了续页游标，但没有新的对话回合；为避免生成残缺文件，已取消导出。`);
      }
      if (seenCursors.has(historyPage.cursor)) {
        throw new Error(`Gemini 在第 ${page} 页重复返回同一个续页游标；为避免生成残缺文件，已取消导出。`);
      }

      seenCursors.add(historyPage.cursor);
      cursor = historyPage.cursor;
    }

    throw new Error(`对话超过 ${HISTORY_PAGE_SIZE * MAX_HISTORY_PAGES} 个回合，未能确认已经读取完整；已取消导出。`);
  }


  function collectStrings(value, separator) {
    const collected = [];
    const walk = (node) => {
      if (typeof node === 'string') collected.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
    };
    walk(value);
    // Do not deduplicate: repeated paragraphs may be intentional revisions.
    const cleaned = collected.map((item) => item.replace(/\r\n?/g, '\n')).filter((item) => item.trim());
    return cleaned.join(separator === undefined ? '\n' : separator).trim();
  }

  function firstString(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
    return '';
  }

  function isStringList(value) {
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
  }

  function extractThinking(candidate) {
    const fixed = firstString(candidate && candidate[37] && candidate[37][0]).trim();
    if (fixed) return fixed;

    if (!Array.isArray(candidate)) return '';
    for (let index = candidate.length - 1; index >= 2; index--) {
      const child = candidate[index];
      if (!Array.isArray(child)) continue;
      if (isStringList(child[1] && child[1][0])) {
        const text = child[1][0].join('\n\n').trim();
        if (text) return text;
      }
      if (isStringList(child[0])) {
        const text = child[0].join('\n\n').trim();
        if (text) return text;
      }
    }
    return '';
  }

  const MEDIA_MIME = /^(?:image|video|audio)\/|^application\/pdf(?:$|;)/i;
  const MEDIA_URL = /^https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|avif|mp4|pdf)(?:[?#][^\s"'<>]*)?$/i;
  const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif)(?:[?#]|$)/i;

  function mediaFromUrl(url, mimeType, label) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();
    const looksMedia = MEDIA_MIME.test(mimeType || '') || MEDIA_URL.test(url) ||
      /(?:^|\.)googleusercontent\.com$/i.test(host);
    if (!looksMedia) return null;

    const encodedName = url.split(/[?#]/)[0].split('/').pop() || 'Resource';
    let filename = encodedName;
    try { filename = decodeURIComponent(encodedName); } catch {}
    const nonImage = /^(?:video|audio|application)\//i.test(mimeType || '') ||
      /\.(?:mp4|pdf)(?:[?#]|$)/i.test(url);
    const isImage = !nonImage && (
      /^image\//i.test(mimeType || '') || IMAGE_EXTENSION.test(url) ||
      /(?:^|\.)googleusercontent\.com$/i.test(host)
    );
    return {
      name: label || filename.slice(0, 80),
      kind: isImage ? 'image' : 'file',
      mimeType: mimeType || '',
      size: null,
      ref: url,
      status: '',
    };
  }

  function extractMedia(candidate) {
    const found = new Map();

    const walk = (node) => {
      if (Array.isArray(node)) {
        const head = node[0];
        const second = node[1];
        if (typeof head === 'string' && /^https?:\/\//i.test(head)) {
          const mime = typeof second === 'string' && /^(image|video|audio|application)\//i.test(second) ? second : '';
          const media = mediaFromUrl(head, mime);
          if (media && !found.has(media.ref)) found.set(media.ref, media);
        }
        node.forEach(walk);
      } else if (typeof node === 'string') {
        const media = mediaFromUrl(node, '');
        if (media && !found.has(media.ref)) found.set(media.ref, media);
      }
    };

    walk(candidate);
    return [...found.values()];
  }

  function attachmentMeta(entry) {
    if (!Array.isArray(entry)) return null;
    const meta = Array.isArray(entry[3]) ? entry[3][0] : null;
    if (Array.isArray(meta) && typeof meta[2] === 'string' && meta[2]) return meta;
    return null;
  }

  function promptAttachments(container) {
    const list = Array.isArray(container) && Array.isArray(container[4]) ? container[4] : [];
    const found = new Map();
    for (const entry of list) {
      const meta = attachmentMeta(entry);
      if (!meta) continue;
      const name = meta[2];
      const urls = Array.isArray(meta[7]) ? meta[7] : [];
      const ref = urls[1] || urls[0] || '';
      const mimeType = typeof meta[11] === 'string' ? meta[11] : '';
      if (!name || !ref) continue;
      const key = `${name}\u0000${ref}`;
      if (found.has(key)) continue;
      found.set(key, {
        name,
        kind: /^image\//i.test(mimeType) ? 'image' : 'file',
        mimeType,
        size: null,
        ref,
        status: '',
      });
    }
    return [...found.values()];
  }

  function timestampValue(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    if (typeof value[0] !== 'number' || typeof value[1] !== 'number') return null;
    return (value[0] * 1000) + (value[1] / 1000000);
  }

  function orderBlocksChronologically(blocks) {
    const timed = blocks.filter((block) => Number.isFinite(block.timestamp));
    if (timed.length >= 2) {
      return [...blocks].sort((left, right) => {
        if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp)) {
          return left.timestamp - right.timestamp;
        }
        if (Number.isFinite(left.timestamp)) return -1;
        if (Number.isFinite(right.timestamp)) return 1;
        return left.sourceIndex - right.sourceIndex;
      });
    }
    // Responses without timestamps are usually returned newest-first.
    return [...blocks].reverse();
  }

  function activeCandidate(turn) {
    const candidates = Array.isArray(turn && turn[3] && turn[3][0]) ? turn[3][0] : [];
    const activeResponseId = turn && turn[1] && turn[1][2];
    return candidates.find((item) => Array.isArray(item) && item[0] === activeResponseId)
      || candidates.find(Array.isArray)
      || null;
  }

  function parseKnownTurns(payload) {
    const turns = Array.isArray(payload && payload[0]) ? payload[0] : [];
    const blocks = [];

    turns.forEach((turn, sourceIndex) => {
      if (!Array.isArray(turn)) return;
      const prompt = firstString(turn[2] && turn[2][0]).replace(/\r\n?/g, '\n').trim();
      const promptMedia = promptAttachments(turn[2] && turn[2][0]);
      const candidate = activeCandidate(turn);
      const response = collectStrings(candidate && candidate[1]);
      const thinking = extractThinking(candidate);
      const media = extractMedia(candidate);

      if (prompt || response || thinking || media.length || promptMedia.length) {
        blocks.push({
          prompt, promptMedia, response, thinking, media,
          timestamp: timestampValue(turn[4]), sourceIndex, turn,
        });
      }
    });

    return orderBlocksChronologically(blocks);
  }

  function parseStructuredFallback(payload) {
    const blocks = [];
    const seen = new Set();

    const scan = (node) => {
      if (!Array.isArray(node)) return;

      const userNode = node.find((child) => (
        Array.isArray(child) && isStringList(child[0]) && [1, 2, 3].includes(child[1])
      ));
      const responseContainer = node.find((child) => (
        Array.isArray(child) &&
        Array.isArray(child[0]) &&
        Array.isArray(child[0][0]) &&
        typeof child[0][0][0] === 'string' &&
        child[0][0][0].startsWith('rc_') &&
        Array.isArray(child[0][0][1])
      ));

      if (userNode && responseContainer) {
        const candidate = responseContainer[0][0];
        const prompt = userNode[0].join('\n').trim();
        const response = collectStrings(candidate[1]);
        const thinking = extractThinking(candidate);
        const signature = JSON.stringify([prompt, response, thinking]);
        if ((prompt || response || thinking) && !seen.has(signature)) {
          seen.add(signature);
          const timestamp = node.map(timestampValue).find((value) => Number.isFinite(value));
          blocks.push({
            prompt,
            promptMedia: promptAttachments(userNode),
            response,
            thinking,
            media: extractMedia(candidate),
            timestamp: timestamp === undefined ? null : timestamp,
            sourceIndex: blocks.length,
            turn: node,
          });
        }
      }

      node.forEach(scan);
    };
    scan(payload);

    return orderBlocksChronologically(blocks);
  }

  function parseConversation(payload, tier) {
    const known = parseKnownTurns(payload);
    const blocks = known.length ? known : parseStructuredFallback(payload);
    const messages = [];

    const push = (record) => {
      if (NS.hasRenderableContent(NS.createMessage(record), tier)) messages.push(record);
    };

    for (const block of blocks) {
      if (block.prompt) {
        push({
          role: 'user',
          text: block.prompt,
          attachments: block.promptMedia,
          time: block.timestamp,
        });
      }
      if (block.response || block.thinking || block.media.length) {
        push({
          role: 'assistant',
          text: block.response,
          thinking: tier === 'minimal' ? '' : block.thinking,
          attachments: block.media,
          time: block.timestamp,
          meta: { model: '', id: turnIdentity(block.turn) },
        });
      }
    }

    return messages;
  }


  function findConversationTitle(value, conversationKey) {
    if (!Array.isArray(value)) return '';
    if (value[0] === conversationKey && typeof value[1] === 'string' && value[1].trim()) {
      return value[1].trim();
    }
    for (const child of value) {
      const title = findConversationTitle(child, conversationKey);
      if (title) return title;
    }
    return '';
  }

  async function fetchConversationTitle(chatId, tokens) {
    const conversationKey = chatId.startsWith('c_') ? chatId : `c_${chatId}`;
    const payload = await callGeminiRpc(LIST_CHATS_RPC, [200], tokens);
    return findConversationTitle(payload, conversationKey);
  }

  function sidebarTitle(chatId) {
    const expected = new Set([`/app/${chatId}`, `${getAccountPrefix()}/app/${chatId}`]);
    const link = [...document.querySelectorAll('a[href]')].find((item) => {
      try {
        return expected.has(new URL(item.href, location.href).pathname);
      } catch {
        return false;
      }
    });
    return link ? link.textContent.replace(/\s+/g, ' ').trim() : '';
  }


  async function collectResources(messages, collector) {
    for (const message of messages) {
      for (const attachment of message.attachments) {
        if (attachment.resourceId) continue;
        if (!attachment.ref || !/^https?:\/\//i.test(attachment.ref)) {
          attachment.status = attachment.status || 'No accessible reference provided by the platform';
          continue;
        }
        try {
          const media = await NS.fetchMedia(attachment.ref);
          if (!media.bytes.length) {
            attachment.status = 'Could not fetch the original file (empty response)';
            continue;
          }
          await NS.storeAttachment(
            attachment,
            media.bytes,
            media.mimeType || attachment.mimeType,
            message.index,
            collector,
          );
        } catch (error) {
          attachment.status = `Could not fetch the original file: ${error && error.message ? error.message : String(error)}`;
        }
      }
    }
    return collector.entries();
  }

  async function read({ tier }) {
    const chatId = getConversationId();
    const { payload, tokens, pages } = await fetchConversation(chatId);
    const messages = parseConversation(payload, tier);
    if (!messages.length) throw new Error('Gemini 接口没有返回可导出的对话内容。');

    let title = '';
    try {
      title = await fetchConversationTitle(chatId, tokens);
    } catch {}
    if (!title) title = sidebarTitle(chatId);
    if (!title) {
      const firstPrompt = messages.find((message) => message.role === 'user');
      title = firstPrompt
        ? firstPrompt.text.replace(/\s+/g, ' ').slice(0, 80)
        : (document.title.replace(/\s*[|\-–—]\s*(?:Google\s+)?Gemini\s*$/i, '').trim() || 'Gemini conversation');
    }

    const notes = [];
    if (pages > 1) notes.push(`Merged ${pages} pages of history.`);

    return {
      platform: PLATFORM,
      method: 'API (RPC)',
      conversationId: chatId,
      title,
      url: location.href,
      messages,
      notes,
      pages,
    };
  }

  root.GeminiAdapter = {
    platform: 'gemini',
    platformLabel: PLATFORM,
    isConversationPage,
    read,
    collectResources,
    internals: {
      collectStrings,
      parseLengthPrefixedFrames,
      findRpcPayload,
      parseConversation,
      fetchConversation,
      findConversationTitle,
      extractMedia,
      getConversationId,
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
