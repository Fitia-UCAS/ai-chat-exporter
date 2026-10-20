/* Shared data model, tier preferences, resource handling, and utility helpers. */
(function initChatExportKit(root) {
  'use strict';

  const NS = root.ChatExportKit = root.ChatExportKit || {};

  /* Constants */
  const TIERS = ['minimal', 'full', 'detailed'];
  const TIER_LABELS = { minimal: '极简', full: '完整', detailed: '详尽' };
  const TIER_NAMES = { minimal: 'Minimal', full: 'Full', detailed: 'Detailed' };
  const DEFAULT_TIER = 'full';
  const TIER_STORAGE_KEY = 'exportTier';

  const MESSAGES = {
    download: 'chat-export-download',
    fetchMedia: 'chat-export-fetch-media',
    run: 'chat-export-run',
  };

  const ROLE_LABELS = {
    user: 'User',
    assistant: 'Assistant',
    system: 'System',
    tool: 'Tool',
    artifact: 'Artifact',
    unknown: 'Unknown',
  };

  const PLATFORM_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

  function normalizeRole(value) {
    const role = String(value || '').toLowerCase();
    return role === 'function' ? 'tool' : PLATFORM_ROLES.has(role) ? role : 'unknown';
  }

  function normalizeTier(value) {
    return TIERS.includes(value) ? value : DEFAULT_TIER;
  }

  function tierIndex(tier) {
    return TIERS.indexOf(normalizeTier(tier));
  }

  function tierLabel(tier) {
    return TIER_LABELS[normalizeTier(tier)];
  }

  function storageArea() {
    try {
      return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
        ? chrome.storage.local
        : null;
    } catch {
      return null;
    }
  }

  let tierCache = null;
  let tierRead = null;
  let tierRevision = 0;
  let tierWrite = Promise.resolve();
  let pendingTierWrites = 0;

  function getTier() {
    if (tierCache !== null) return Promise.resolve(tierCache);
    if (tierRead) return tierRead;

    const area = storageArea();
    if (!area) return Promise.resolve(DEFAULT_TIER);

    const revision = tierRevision;
    tierRead = new Promise((resolve) => {
      try {
        area.get([TIER_STORAGE_KEY], (result) => {
          const value = chrome.runtime.lastError
            ? DEFAULT_TIER
            : normalizeTier(result?.[TIER_STORAGE_KEY]);
          if (revision === tierRevision) tierCache = value;
          resolve(tierCache ?? value);
        });
      } catch {
        resolve(tierCache ?? DEFAULT_TIER);
      }
    }).finally(() => { tierRead = null; });
    return tierRead;
  }

  function setTier(value) {
    const tier = normalizeTier(value);
    const revision = ++tierRevision;
    tierCache = tier;
    const area = storageArea();
    if (!area) return Promise.resolve(tier);

    pendingTierWrites++;
    const write = tierWrite.catch(() => {}).then(() => {
      if (revision !== tierRevision) return tier;
      return new Promise((resolve, reject) => {
        try {
          area.set({ [TIER_STORAGE_KEY]: tier }, () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(tier);
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    tierWrite = write.catch(() => {});
    void write.then(
      () => { pendingTierWrites--; },
      () => { pendingTierWrites--; },
    );
    return write;
  }

  function onTierChange(handler) {
    let available = false;
    try {
      available = typeof chrome !== 'undefined' &&
        Boolean(chrome.storage && chrome.storage.onChanged);
    } catch {
      available = false;
    }
    if (!available) return () => {};

    const listener = (changes, area) => {
      if (area !== 'local' || !changes || !changes[TIER_STORAGE_KEY]) return;
      const changedTier = normalizeTier(changes[TIER_STORAGE_KEY].newValue);
      if (pendingTierWrites) {
        if (changedTier !== tierCache) return;
        handler(tierCache);
        return;
      }
      tierRevision += 1;
      tierCache = changedTier;
      handler(tierCache);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }


  /* Utility helpers */
  function asText(value) {
    return typeof value === 'string' ? value : '';
  }

  function normalizeNewlines(value) {
    return asText(value).replace(/\r\n?/g, '\n');
  }

  function collapseInline(value) {
    return normalizeNewlines(value).replace(/\s+/g, ' ').trim();
  }

  function longestBacktickRun(value) {
    const runs = String(value).match(/`+/g);
    return runs ? runs.reduce((max, run) => Math.max(max, run.length), 0) : 0;
  }

  function fence(value, language) {
    const body = normalizeNewlines(value).replace(/\n+$/, '');
    const marker = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
    const lang = String(language || '').replace(/[^\w+#.-]/g, '');
    return `${marker}${lang}\n${body}\n${marker}`;
  }

  function formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size < 0) return '';
    if (size < 1024) return `${Math.round(size)} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
  }

  function toEpochMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value) && value.length === 2 &&
        typeof value[0] === 'number' && typeof value[1] === 'number') {
      return (value[0] * 1000) + (value[1] / 1000000);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1e12) return value;
      if (value > 1e9) return value * 1000;
      return null;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function toIsoTime(value) {
    const ms = toEpochMs(value);
    if (ms === null) return '';
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function formatLocalTime(value) {
    const ms = toEpochMs(value);
    if (ms === null) return '';
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (number) => String(number).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absolute = Math.abs(offset);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
      `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
  }

  function dominantMeta(messages, key) {
    const counts = new Map();
    for (const message of messages) {
      const value = asText(message.meta && message.meta[key]);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    let best = '';
    let max = 0;
    for (const [value, count] of counts) {
      if (count > max) {
        best = value;
        max = count;
      }
    }
    return best;
  }

  function assistantLabel(source) {
    const value = String(source || '').toLowerCase();
    if (value.includes('chatgpt') || value.includes('openai')) return 'ChatGPT';
    if (value.includes('gemini')) return 'Gemini';
    if (value.includes('deepseek')) return 'DeepSeek';
    return 'Assistant';
  }

  function safeFilename(title, fallback) {
    function clean(value) {
      return collapseInline(value)
        .normalize('NFC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[. ]+$/g, '')
        .replace(/\.md$/i, '')
        .replace(/[_. ]+$/g, '');
    }

    let name = clean(title) || clean(fallback) || 'Conversation';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
      name = `_${name}`;
    }
    return `${clean(name.slice(0, 120)) || 'Conversation'}.md`;
  }


  const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const BASE64_LOOKUP = (() => {
    const table = new Int16Array(128).fill(-1);
    for (let index = 0; index < BASE64_CHARS.length; index++) {
      table[BASE64_CHARS.charCodeAt(index)] = index;
    }
    table['='.charCodeAt(0)] = -2;
    return table;
  })();

  function toBytes(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (Array.isArray(value)) return Uint8Array.from(value);
    return null;
  }

  function bytesToBase64(value) {
    const bytes = toBytes(value);
    if (!bytes) return '';
    const parts = [];
    let chunk = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const b0 = bytes[index];
      const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
      chunk += BASE64_CHARS[b0 >> 2];
      chunk += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
      chunk += index + 1 < bytes.length ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      chunk += index + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '=';
      if (chunk.length >= 8192) {
        parts.push(chunk);
        chunk = '';
      }
    }
    if (chunk) parts.push(chunk);
    return parts.join('');
  }

  function base64ToBytes(value) {
    const source = String(value || '').replace(/[\s\r\n]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const clean = source.replace(/=+$/, '');
    if (!clean) return new Uint8Array(0);

    const output = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let buffer = 0;
    let bits = 0;
    let cursor = 0;

    for (let index = 0; index < clean.length; index++) {
      const code = clean.charCodeAt(index);
      const pair = code < 128 ? BASE64_LOOKUP[code] : -1;
      if (pair < 0) throw new Error('Base64 数据包含非法字符。');
      buffer = (buffer << 6) | pair;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output[cursor++] = (buffer >> bits) & 0xff;
      }
    }
    return output.slice(0, cursor);
  }

  function fnv1a64Hex(bytes) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let index = 0; index < bytes.length; index++) {
      hash ^= BigInt(bytes[index]);
      hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, '0');
  }

  async function hashBytes(value) {
    const bytes = toBytes(value) || new Uint8Array(0);
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      try {
        const digest = await subtle.digest('SHA-256', bytes);
        const view = new Uint8Array(digest);
        let hex = '';
        for (const byte of view) hex += byte.toString(16).padStart(2, '0');
        return { algorithm: 'sha256', hex };
      } catch {
        /* Fallback hash for deduplication and integrity hints. */
      }
    }
    return { algorithm: 'fnv1a64', hex: fnv1a64Hex(bytes) };
  }


  /* Media resources */
  function createMediaCollector() {
    const entries = [];
    const byHash = new Map();

    async function add(item) {
      const bytes = toBytes(item && item.bytes);
      if (!bytes || !bytes.length) return null;

      const hash = await hashBytes(bytes);
      const existing = byHash.get(hash.hex);
      if (existing) {
        if (Number.isFinite(item.messageNumber)) existing.messageNumbers.push(item.messageNumber);
        return existing;
      }

      const entry = {
        id: `R${entries.length + 1}`,
        name: collapseInline(item.name) || 'Untitled resource',
        mimeType: asText(item.mimeType) || 'application/octet-stream',
        size: bytes.length,
        hash,
        source: asText(item.source),
        messageNumbers: Number.isFinite(item.messageNumber) ? [item.messageNumber] : [],
        bytes,
      };
      entries.push(entry);
      byHash.set(hash.hex, entry);
      return entry;
    }

    return { add, entries: () => entries };
  }


  /* Message model */
  function normalizeAttachment(item) {
    if (!item || typeof item !== 'object') return null;
    const name = collapseInline(item.name || item.fileName || item.file_name || item.filename) || 'Untitled attachment';
    const mimeType = asText(item.mimeType || item.mime_type) || '';
    const size = Number.isFinite(item.size) ? item.size
      : Number.isFinite(item.file_size) ? item.file_size
        : Number.isFinite(item.size_bytes) ? item.size_bytes : null;
    return {
      name,
      kind: item.kind === 'image' || /^image\//i.test(mimeType) ? 'image' : 'file',
      mimeType,
      size,
      ref: asText(item.ref || item.url),
      libraryFileId: asText(item.libraryFileId),
      resourceId: asText(item.resourceId),
      text: normalizeNewlines(item.text),
      status: asText(item.status),
    };
  }

  function normalizeToolCall(item) {
    if (!item || typeof item !== 'object') return null;
    const name = collapseInline(item.name) || 'Tool';
    return {
      name,
      input: normalizeNewlines(item.input),
      inputLanguage: asText(item.inputLanguage) || 'text',
      output: normalizeNewlines(item.output),
      outputLanguage: asText(item.outputLanguage) || 'text',
      status: asText(item.status),
    };
  }

  function createMessage(partial) {
    const source = partial && typeof partial === 'object' ? partial : {};
    const role = asText(source.role) || 'unknown';
    const toolCalls = Array.isArray(source.toolCalls)
      ? source.toolCalls.map(normalizeToolCall).filter(Boolean)
      : [];
    const attachments = [];
    const seenAttachments = new Set();
    for (const item of (Array.isArray(source.attachments) ? source.attachments : [])) {
      const attachment = normalizeAttachment(item);
      if (!attachment) continue;
      const key = attachment.ref || attachment.resourceId || `${attachment.name}\u0000${attachment.mimeType}\u0000${attachment.size}`;
      if (seenAttachments.has(key)) continue;
      seenAttachments.add(key);
      attachments.push(attachment);
    }

    return {
      role,
      roleLabel: collapseInline(source.roleLabel) || ROLE_LABELS[role] || ROLE_LABELS.unknown,
      text: normalizeNewlines(source.text).trim(),
      thinking: normalizeNewlines(source.thinking).trim(),
      thinkingLabel: collapseInline(source.thinkingLabel) || 'Reasoning',
      toolCalls,
      attachments,
      time: toIsoTime(source.time),
      meta: source.meta && typeof source.meta === 'object' ? source.meta : {},
      hidden: Boolean(source.hidden),
      branch: asText(source.branch),
    };
  }

  function hasBody(message, tier) {
    if (message.text) return true;
    if (tier !== 'minimal' && message.thinking) return true;
    if (tier !== 'minimal' && message.toolCalls.length) return true;
    if (message.attachments.length) return true;
    return false;
  }


  function metaLine(message, tier) {
    if (tier === 'minimal') return '';
    const parts = [];
    if (message.time) parts.push(formatLocalTime(message.time));
    if (tier === 'detailed') {
      if (message.hidden) parts.push('hidden message');
      if (message.branch) parts.push(message.branch);
      for (const [key, label] of Object.entries({ id: 'ID', parentId: 'Parent', model: 'Model' })) {
        if (message.meta[key]) parts.push(`${label} ${message.meta[key]}`);
      }
    }
    return parts.length ? `*${parts.join(' · ')}*` : '';
  }

  function decodeText(bytes, mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    const textLike = /^text\//.test(mime) || /^application\/(?:json|xml|x-yaml|yaml|csv)/.test(mime);
    if (!textLike || !bytes || !bytes.length) return null;

    let text = '';
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return null;
    }
    text = text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
    return text || null;
  }

  async function storeAttachment(attachment, bytes, mimeType, messageNumber, collector) {
    const type = mimeType || attachment.mimeType || '';
    const inline = decodeText(bytes, type);
    if (inline) {
      attachment.text = inline;
      attachment.status = 'Body inlined';
      attachment.size = attachment.size || bytes.length;
      attachment.mimeType = attachment.mimeType || type;
      return;
    }

    const entry = await collector.add({
      bytes,
      name: attachment.name,
      mimeType: type,
      messageNumber,
      source: attachment.ref,
    });
    attachment.resourceId = entry.id;
    attachment.status = 'Embedded as Base64';
    attachment.size = attachment.size || entry.size;
    attachment.mimeType = attachment.mimeType || entry.mimeType;
  }

  function attachmentLabel(item) {
    const ref = asText(item.ref);
    if (!/^https?:\/\//i.test(ref)) return item.name;
    const text = item.name.replace(/([\[\]\\])/g, '\\$1');
    return `[${text}](<${ref}>)`;
  }


  Object.assign(NS, {
    TIERS, TIER_LABELS, TIER_NAMES, DEFAULT_TIER, TIER_STORAGE_KEY, MESSAGES, ROLE_LABELS,
    normalizeTier, normalizeRole, tierIndex, tierLabel, getTier, setTier, onTierChange,
    asText, normalizeNewlines, collapseInline, fence, formatBytes, toIsoTime, formatLocalTime, safeFilename,
    toBytes, bytesToBase64, base64ToBytes, hashBytes, createMediaCollector, createMessage,
    hasRenderableContent: hasBody, decodeText, storeAttachment,
    assistantLabel, dominantMeta, plural, attachmentLabel, metaLine,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
