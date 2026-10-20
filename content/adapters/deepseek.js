/* DeepSeek API client and conversation parser. */
(function initDeepSeekAdapter(root) {
  'use strict';

  const NS = root.ChatExportKit;

  const PLATFORM = 'DeepSeek';

  function isConversationPage() {
    return /chat\.deepseek\.com\/a\/chat\/s\/[^/?#]+/i.test(location.href);
  }

  function getChatId() {
    const match = location.href.match(/chat\.deepseek\.com\/a\/chat\/s\/([^/?#&]+)/i);
    return match ? match[1] : '';
  }

  function getAuthorization() {
    try {
      return JSON.parse(localStorage.getItem('userToken') || 'null').value || '';
    } catch {
      return '';
    }
  }

  async function fetchChatData(chatId) {
    if (!chatId) throw new Error('请先打开一条 DeepSeek 对话。');
    const authorization = getAuthorization();
    if (!authorization) throw new Error('未找到登录信息，请刷新页面后重试。');

    const response = await fetch(
      `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatId)}`,
      {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { authorization },
      },
    );

    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? '（登录状态可能已失效，请刷新页面后重试）'
        : '';
      throw new Error(`无法读取完整对话（HTTP ${response.status}）${hint}。`);
    }

    const result = await response.json();
    const chatData = result && result.data && result.data.biz_data;
    if (!chatData || !Array.isArray(chatData.chat_messages)) {
      throw new Error('DeepSeek 返回了无法识别的对话数据，内部接口可能已经更新。');
    }
    return chatData;
  }

  function fragmentsOf(item) {
    const fragments = Array.isArray(item && item.fragments) ? item.fragments : [];
    return fragments.filter((fragment) => fragment && typeof fragment === 'object');
  }

  function textOfFragments(fragments, type) {
    return fragments
      .filter((fragment) => String(fragment.type || '').toUpperCase() === type)
      .map((fragment) => String(fragment.content || '').replace(/\r\n?/g, '\n'))
      .filter((content) => content.trim())
      .join('\n');
  }

  function messageText(item, fragments) {
    const fromFragments = textOfFragments(fragments, 'RESPONSE');
    if (fromFragments) return fromFragments;
    return String(item && item.content ? item.content : '').replace(/\r\n?/g, '\n');
  }

  function messageThinking(item, fragments) {
    const fromFragments = textOfFragments(fragments, 'THINK');
    if (fromFragments) return fromFragments;
    return String(item && item.thinking_content ? item.thinking_content : '').replace(/\r\n?/g, '\n');
  }

  function searchToolCall(item) {
    const results = item && item.search_results;
    if (!Array.isArray(results) || !results.length) return [];

    const lines = results.map((result, index) => {
      if (!result || typeof result !== 'object') return '';
      const title = result.title || result.site_name || 'Untitled result';
      const url = result.url || result.link || '';
      const snippet = String(result.snippet || result.content || '').replace(/\s+/g, ' ').trim();
      return [
        `${index + 1}. ${title}${url ? ` — ${url}` : ''}`,
        snippet ? `   ${snippet.slice(0, 500)}` : '',
      ].filter(Boolean).join('\n');
    }).filter(Boolean);

    return [{
      name: 'Web search',
      input: '',
      output: lines.join('\n'),
      outputLanguage: 'text',
      status: item.search_status ? String(item.search_status) : '',
    }];
  }

  function attachmentList(item) {
    const files = [];
    if (Array.isArray(item && item.files)) files.push(...item.files);
    if (Array.isArray(item && item.file_ids)) {
      files.push(...item.file_ids.map((id) => (typeof id === 'string' ? { id } : id)));
    }

    return files
      .filter((file) => file && typeof file === 'object')
      .map((file) => ({
        name: file.file_name || file.name || file.id || 'Untitled file',
        kind: /^image\//i.test(file.mime_type || '') ? 'image' : 'file',
        mimeType: file.mime_type || '',
        size: Number.isFinite(file.file_size) ? file.file_size : (Number.isFinite(file.size) ? file.size : null),
        ref: file.id ? `deepseek-file://${file.id}` : '',
        status: 'Platform does not expose a file download API',
      }));
  }

  function buildMessages(chatData, tier) {
    const messages = [];
    const notes = [];
    let skipped = 0;

    for (const item of chatData.chat_messages) {
      if (!item || typeof item !== 'object') continue;
      const role = NS.normalizeRole(item.role);
      if (role === 'unknown') {
        skipped++;
        continue;
      }
      if (tier === 'minimal' && role === 'system') {
        skipped++;
        continue;
      }

      const fragments = fragmentsOf(item);
      const text = messageText(item, fragments);
      const thinking = tier === 'minimal' ? '' : messageThinking(item, fragments);
      const attachments = attachmentList(item);
      const toolCalls = tier === 'minimal' ? [] : searchToolCall(item);

      if (!text && !thinking && !attachments.length && !toolCalls.length) continue;

      const insertedAt = item.inserted_at || item.created_at || null;
      const record = {
        role,
        text,
        thinking,
        attachments,
        toolCalls,
        time: insertedAt,
        meta: {
          id: item.message_id || item.id || '',
          model: item.model || '',
        },
      };
      if (NS.hasRenderableContent(NS.createMessage(record), tier)) messages.push(record);
    }

    if (skipped) notes.push(`Skipped ${skipped} messages with unknown roles or no exportable content.`);
    return { messages, notes };
  }

  async function read({ tier }) {
    const chatId = getChatId();
    const chatData = await fetchChatData(chatId);
    const { messages, notes } = buildMessages(chatData, tier);
    if (!messages.length) throw new Error('没有找到可导出的对话内容。');

    const session = chatData.chat_session || {};
    const title = session.title
      || document.title.replace(/\s*[|\-–—]\s*DeepSeek\s*$/i, '').trim()
      || 'DeepSeek conversation';

    return {
      platform: PLATFORM,
      method: 'API',
      conversationId: chatId,
      title,
      url: location.href,
      messages,
      notes,
      pages: 1,
    };
  }

  root.DeepSeekAdapter = {
    platform: 'deepseek',
    platformLabel: PLATFORM,
    isConversationPage,
    read,
    internals: { buildMessages, messageText, messageThinking, searchToolCall, attachmentList },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
