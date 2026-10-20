/* Markdown rendering for the normalized conversation model. */
(function initChatExportMarkdown(root) {
  'use strict';

  const NS = root.ChatExportKit;
  if (!NS) throw new Error('ChatExportKit core must load before markdown.js.');
  const {
    TIER_NAMES, asText, normalizeTier, collapseInline, fence, formatBytes, formatLocalTime,
    bytesToBase64, createMessage, hasRenderableContent: hasBody,
    assistantLabel, attachmentLabel, dominantMeta, metaLine, plural,
  } = NS;

  /* Markdown rendering */
  function renderAttachments(message, tier) {
    const blocks = [];
    const attachments = message.attachments;
    if (!attachments.length) return blocks;

    if (tier === 'minimal') {
      const names = attachments.map((item) => `- ${item.kind === 'image' ? 'Image' : 'File'}: ${attachmentLabel(item)}`);
      blocks.push(names.join('\n'));
      return blocks;
    }

    const lines = attachments.map((item) => {
      const facts = [
        item.kind === 'image' ? 'Image' : 'File',
        attachmentLabel(item),
        item.mimeType || null,
        item.resourceId ? `See resource:${item.resourceId}` : null,
        item.ref && tier === 'detailed' && !/^https?:\/\//i.test(item.ref)
          ? `Source \`${item.ref}\``
          : null,
        item.status || null,
      ].filter(Boolean);
      return `- ${facts.join(' · ')}`;
    });
    blocks.push(['### Attachments', '', ...lines].join('\n'));

    for (const item of attachments) {
      if (!item.text) continue;
      const language = /json/i.test(item.mimeType) ? 'json'
        : /markdown/i.test(item.mimeType) ? 'markdown' : 'text';
      blocks.push(`**${attachmentLabel(item)}**\n\n${fence(item.text, language)}`);
    }
    return blocks;
  }

  function renderTools(message, tier) {
    const blocks = [];
    if (tier === 'minimal') return blocks;

    for (const call of message.toolCalls) {
      const parts = [`### Tool call · ${call.name}`];
      if (call.status) parts.push(`Status: ${call.status}`);
      if (call.input) {
        parts.push(`**Input**\n\n${fence(call.input, call.inputLanguage)}`);
      }
      if (call.output) {
        parts.push(`**Output**\n\n${fence(call.output, call.outputLanguage)}`);
      }
      blocks.push(parts.join('\n\n'));
    }
    return blocks;
  }

  function renderMessage(message, heading, tier) {
    const title = typeof heading === 'number'
      ? `## ${heading} · ${message.roleLabel}`
      : heading || `## ${message.roleLabel}`;
    const blocks = [title];
    const summary = metaLine(message, tier);
    if (summary) blocks.push(summary);

    if (message.role === 'user') {
      blocks.push(...renderAttachments(message, tier));
    }

    if (tier !== 'minimal' && message.thinking) {
      blocks.push(`<think>\n${message.thinking}\n</think>`);
    }

    blocks.push(...renderTools(message, tier));

    const hasExtras = tier !== 'minimal' &&
      (Boolean(message.thinking) || message.toolCalls.length > 0);
    if (message.text) {
      blocks.push(hasExtras ? `### Answer\n\n${message.text}` : message.text);
    }

    if (message.role !== 'user') {
      blocks.push(...renderAttachments(message, tier));
    }

    return blocks.filter(Boolean).join('\n\n');
  }

  function safeJson(value) {
    const ancestors = [];
    try {
      return JSON.stringify(value, function replace(key, item) {
        if (typeof item === 'object' && item !== null) {
          while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
          if (ancestors.includes(item)) return '[Circular reference]';
          ancestors.push(item);
        }
        return item;
      }, 2) || 'null';
    } catch (error) {
      return `[Cannot serialize: ${error && error.message ? error.message : String(error)}]`;
    }
  }

  function summarize(messages, tier) {
    const stats = { messages: 0, users: 0, assistants: 0, thinking: 0, tools: 0, attachments: 0, resources: 0, hidden: 0 };
    for (const message of messages) {
      stats.messages++;
      if (message.role === 'user') stats.users++;
      else if (message.role === 'assistant') stats.assistants++;
      if (message.hidden) stats.hidden++;
      if (tier !== 'minimal' && message.thinking) stats.thinking++;
      stats.tools += tier === 'minimal' ? 0 : message.toolCalls.length;
      if (message.attachments.length) stats.attachments += message.attachments.length;
      stats.resources += message.attachments.filter((item) => item.resourceId).length;
    }
    return stats;
  }

  function renderResources(resources) {
    if (!resources || !resources.length) return '';
    const blocks = ['---', '', '## Resource appendix', '', 'The Base64 blocks below decode to the original files. `resource:R*` in the body refers to them.'];
    for (const item of resources) {
      const lines = [
        `### ${item.id} · ${item.name}`,
        '',
        `- Type: ${item.mimeType}`,
        `- Size: ${item.size} bytes (${formatBytes(item.size)})`,
        `- Checksum: ${item.hash.algorithm} ${item.hash.hex}`,
      ];
      if (item.messageNumbers && item.messageNumbers.length) {
        lines.push(`- Messages: ${[...new Set(item.messageNumbers)].join(', ')}`);
      }
      if (item.source) lines.push(`- Source: ${item.source}`);
      lines.push('', fence(bytesToBase64(item.bytes), 'base64'));
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
  }

  function splitTurns(messages) {
    const turns = [];
    let current = null;
    for (const message of messages) {
      if (message.role === 'user' || !current) {
        current = { user: [], assistant: [] };
        turns.push(current);
      }
      if (message.role === 'assistant') current.assistant.push(message);
      else current.user.push(message);
    }
    return turns;
  }

  function renderAssistantGroup(messages, heading, tier) {
    const primary = [...messages].reverse().find((message) => message.text) || messages[messages.length - 1];
    const thinking = [];
    const recaps = [];
    for (const message of messages) {
      if (!message.thinking) continue;
      if (message.thinkingLabel === 'Reasoning recap') recaps.push(message.thinking);
      else thinking.unshift(message.thinking);
    }
    const combinedThinking = [...thinking, ...recaps].join('\n\n');
    const toolCalls = messages.flatMap((message) => message.toolCalls);
    const attachments = messages.flatMap((message) => message.attachments);
    const text = messages.map((message) => message.text).filter(Boolean).join('\n\n');

    const blocks = [heading];
    const summary = metaLine(primary, tier);
    if (summary) blocks.push(summary);

    if (tier !== 'minimal' && combinedThinking) {
      blocks.push(`<think>\n${combinedThinking}\n</think>`);
    }

    blocks.push(...renderTools({ toolCalls }, tier));

    const hasExtras = tier !== 'minimal' && (Boolean(combinedThinking) || toolCalls.length > 0);
    if (text) blocks.push(hasExtras ? `### Answer\n\n${text}` : text);

    blocks.push(...renderAttachments({ attachments }, tier));

    return blocks.filter(Boolean).join('\n\n');
  }

  function renderTurns(messages, tier, assistantName) {
    const blocks = [];
    let turn = 0;
    const label = assistantName || 'Assistant';
    for (const group of splitTurns(messages)) {
      for (const message of group.user) {
        if (message.role === 'user') {
          turn += 1;
          const rendered = renderMessage(message, `## User ${turn}`, tier);
          if (rendered) blocks.push(rendered);
        } else {
          const rendered = renderMessage(message, `## ${message.roleLabel}`, tier);
          if (rendered) blocks.push(rendered);
        }
      }
      if (group.assistant.length) {
        const rendered = renderAssistantGroup(group.assistant, `## ${label} ${turn}`, tier);
        if (rendered) blocks.push(rendered);
      }
    }
    return blocks.join('\n\n---\n\n');
  }

  function buildMarkdown(options) {
    const config = options || {};
    const tier = normalizeTier(config.tier);
    const resources = tier === 'detailed' && Array.isArray(config.resources) ? config.resources : [];
    const messages = (Array.isArray(config.messages) ? config.messages : [])
      .map(createMessage)
      .filter((message) => hasBody(message, tier));
    const stats = summarize(messages, tier);
    stats.resources = resources.length;

    const source = asText(config.platform) || 'Unknown';
    const model = asText(config.model) || dominantMeta(messages, 'model') || 'Unknown (not exposed)';
    const reasoning = asText(config.reasoning) || dominantMeta(messages, 'reasoning');
    const method = asText(config.method) || 'Unknown';
    const exported = formatLocalTime(config.exportedAt) || formatLocalTime(Date.now());
    const appName = asText(config.appName) || 'AI Chat Exporter';
    const appVersion = asText(config.appVersion);
    const generator = [appName, appVersion].filter(Boolean).join(' ');
    const assistant = assistantLabel(source);

    const header = [
      `\uFEFF# ${collapseInline(config.title) || 'Conversation'}`,
      '',
      `**Source:** ${source}`,
      `**Model:** ${model}`,
    ];
    if (reasoning) header.push(`**Reasoning:** ${reasoning}`);
    header.push(`**Exported:** ${exported}`);
    header.push(`**Method:** ${method}`);
    header.push(`**Link:** ${config.url ? `<${config.url}>` : 'Unknown'}`);
    if (Number(config.pages) > 1) header.push(`**Pages:** ${config.pages} merged`);
    header.push(`**Messages:** ${stats.messages} (User ${stats.users} · ${assistant} ${stats.assistants})`);
    header.push(
      `**Contents:** ${plural(stats.thinking, 'reasoning block', 'reasoning blocks')} · ` +
      `${plural(stats.tools, 'tool call', 'tool calls')} · ` +
      `${plural(stats.attachments, 'attachment', 'attachments')} · ` +
      `${plural(stats.resources, 'embedded resource', 'embedded resources')}`,
    );
    if (stats.hidden) header.push(`**Hidden:** ${plural(stats.hidden, 'message', 'messages')}`);
    const notes = (config.notes || []).filter(Boolean);
    if (notes.length) header.push(`**Notes:** ${notes.join(' · ')}`);
    header.push(`**Generator:** ${generator} (${TIER_NAMES[tier]})`);

    const body = renderTurns(messages, tier, assistant);

    const appendix = renderResources(resources);
    return [header.join('\n'), '', '---', '', body, appendix ? `\n\n${appendix}` : '', '\n']
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n');
  }

  Object.assign(NS, { summarize, renderMessage, buildMarkdown, safeJson });
})(typeof globalThis !== 'undefined' ? globalThis : this);
