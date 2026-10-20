/*
 * ChatGPT 适配层测试：使用保存的接口响应结构（fixture）验证分支选择、思考、工具调用、
 * 附件与三档过滤，不依赖真实账号。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadKit } = require('./load-kit.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));


function loadAdapter() {
  const root = path.join(__dirname, '..');
  const context = {
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    crypto: require('node:crypto').webcrypto,
    location: {
      pathname: '/c/conv-123',
      href: 'https://chatgpt.com/c/conv-123',
    },
    document: {
      title: 'ChatGPT',
      querySelectorAll: () => [],
      documentElement: { classList: { contains: () => false } },
      body: { appendChild() {} },
    },
    chrome: {
      runtime: { id: 'test', lastError: undefined, getURL: (value) => `chrome-extension://test/${value}` },
      storage: {
        local: { get: (keys, callback) => callback({}), set: (items, callback) => callback && callback() },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
    fetch: async () => { throw new Error('fixture 测试不应发起真实请求'); },
  };
  vm.createContext(context);
  loadKit(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content', 'adapters', 'chatgpt.js'), 'utf8'), context);
  return { context, adapter: context.ChatGPTAdapter, kit: context.ChatExportKit };
}

function buildConversation() {
  const message = (id, role, content, extra = {}) => ({
    id,
    author: { role },
    content,
    create_time: extra.create_time || 0,
    recipient: extra.recipient || 'all',
    metadata: extra.metadata || {},
  });

  return {
    title: '修仙：写个日记',
    current_node: 'm-final',
    mapping: {
      root: {
        id: 'root',
        parent: null,
        children: ['m-user'],
        message: message('root', 'system', { content_type: 'text', parts: [''] }),
      },
      'm-user': {
        id: 'm-user',
        parent: 'root',
        children: ['m-old', 'm-code'],
        message: message('m-user', 'user', { content_type: 'text', parts: ['写一段修仙小说的开头'] }, {
          create_time: 1700000000,
          metadata: {
            attachments: [{
              id: 'file-1',
              name: '设定.md',
              mime_type: 'text/markdown',
              size: 2048,
            }],
          },
        }),
      },
      'm-old': {
        id: 'm-old',
        parent: 'm-user',
        children: [],
        message: message('m-old', 'assistant', { content_type: 'text', parts: ['另一个分支的旧回答'] }, {
          create_time: 1700000005,
        }),
      },
      'm-code': {
        id: 'm-code',
        parent: 'm-user',
        children: ['m-tool'],
        message: message('m-code', 'assistant', {
          content_type: 'code',
          language: 'python',
          text: 'print("hi")',
        }, {
          create_time: 1700000010,
          recipient: 'python',
          metadata: { model_slug: 'gpt-test', aggregate_result: { status: 'success' } },
        }),
      },
      'm-tool': {
        id: 'm-tool',
        parent: 'm-code',
        children: ['m-thought'],
        message: message('m-tool', 'tool', { content_type: 'execution_output', text: 'hi' }, {
          create_time: 1700000011,
          metadata: { is_visually_hidden_from_conversation: true },
        }),
      },
      'm-thought': {
        id: 'm-thought',
        parent: 'm-tool',
        children: ['m-final'],
        message: message('m-thought', 'assistant', {
          content_type: 'thoughts',
          thoughts: [{ content: '先确定冲突，再铺陈场景。' }],
        }, {
          create_time: 1700000012,
        }),
      },
      'm-final': {
        id: 'm-final',
        parent: 'm-thought',
        children: [],
        message: message('m-final', 'assistant', {
          content_type: 'multimodal_text',
          parts: [
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-img', size_bytes: 4096, mime_type: 'image/png' },
            '第一章 开局\n\n林川睁开眼。',
          ],
        }, {
          create_time: 1700000020,
        }),
      },
    },
  };
}

function buildRecapConversation() {
  const message = (id, role, content, extra = {}) => ({
    id,
    author: { role },
    content,
    create_time: extra.create_time || 0,
    recipient: extra.recipient || 'all',
    metadata: extra.metadata || {},
  });

  return {
    title: '思考摘要验证',
    current_node: 'm-final',
    mapping: {
      'm-user': {
        id: 'm-user',
        parent: null,
        children: ['m-recap'],
        message: message('m-user', 'user', { content_type: 'text', parts: ['介绍一下 Embedding'] }, {
          create_time: 1700000000,
        }),
      },
      'm-recap': {
        id: 'm-recap',
        parent: 'm-user',
        children: ['m-final'],
        message: message('m-recap', 'assistant', {
          content_type: 'reasoning_recap',
          content: '思考了 17s',
        }, {
          create_time: 1700000001,
          metadata: { reasoning_status: 'reasoning_ended' },
        }),
      },
      'm-final': {
        id: 'm-final',
        parent: 'm-recap',
        children: [],
        message: message('m-final', 'assistant', { content_type: 'text', parts: ['Embedding 是向量表示。'] }, {
          create_time: 1700000002,
          metadata: { model_slug: 'gpt-test' },
        }),
      },
    },
  };
}

function buildMergedTurnConversation() {
  const message = (id, role, content, extra = {}) => ({
    id,
    author: { role },
    content,
    create_time: extra.create_time || 0,
    recipient: extra.recipient || 'all',
    metadata: extra.metadata || {},
  });

  return {
    title: '思考合并验证',
    current_node: 'm-answer',
    mapping: {
      'm-user': {
        id: 'm-user',
        parent: null,
        children: ['m-thought'],
        message: message('m-user', 'user', { content_type: 'text', parts: ['介绍一下'] }, {
          create_time: 1700000000,
        }),
      },
      'm-thought': {
        id: 'm-thought',
        parent: 'm-user',
        children: ['m-tool-summary'],
        message: message('m-thought', 'assistant', {
          content_type: 'thoughts',
          thoughts: [
            { summary: '梳理算法细节', content: '先看材料。' },
            { summary: '提炼论文贡献', content: '再总结贡献。' },
            { summary: '梳理算法细节并提炼论文贡献', content: '' },
          ],
        }, {
          create_time: 1700000001,
          metadata: { reasoning_status: 'is_reasoning' },
        }),
      },
      'm-tool-summary': {
        id: 'm-tool-summary',
        parent: 'm-thought',
        children: ['m-recap'],
        message: message('m-tool-summary', 'assistant', {
          content_type: 'thoughts',
          thoughts: [{ summary: '读取了PDF技能指南', content: '' }],
        }, {
          create_time: 1700000002,
          metadata: { reasoning_status: 'is_reasoning' },
        }),
      },
      'm-recap': {
        id: 'm-recap',
        parent: 'm-tool-summary',
        children: ['m-answer'],
        message: message('m-recap', 'assistant', {
          content_type: 'reasoning_recap',
          content: '思考了 29s',
        }, {
          create_time: 1700000003,
          metadata: { reasoning_status: 'reasoning_ended' },
        }),
      },
      'm-answer': {
        id: 'm-answer',
        parent: 'm-recap',
        children: [],
        message: message('m-answer', 'assistant', {
          content_type: 'text',
          parts: ['答案正文。'],
        }, {
          create_time: 1700000004,
          metadata: { model_slug: 'gpt-test' },
        }),
      },
    },
  };
}

function main() {
  const { adapter, kit } = loadAdapter();
  const conversation = buildConversation();

  /* --------------------------------------------------- 三档消息构成 */
  const minimal = adapter.internals.buildMessages(conversation, 'minimal');
  const minimalRoles = minimal.messages.map((item) => item.role);
  assert.deepEqual(plain(minimalRoles), ['user', 'assistant']);
  assert.equal(minimal.messages[0].attachments[0].name, '设定.md');
  assert.ok(minimal.messages.every((item) => !item.thinking), '极简档不保留思考');
  assert.ok(minimal.messages.every((item) => !item.toolCalls.length), '极简档不保留工具调用');

  const full = adapter.internals.buildMessages(conversation, 'full');
  const assistant = full.messages.filter((item) => item.role === 'assistant');
  assert.equal(assistant.length, 3, '代码消息、思考消息与最终回答都应保留');
  assert.equal(assistant[0].toolCalls[0].name, 'python');
  assert.equal(assistant[0].toolCalls[0].input, 'print("hi")');
  assert.equal(assistant[0].toolCalls[0].output, 'hi', 'tool 消息的输出应折叠进对应工具调用');
  assert.equal(assistant[1].thinking, '先确定冲突，再铺陈场景。');
  assert.equal(assistant[2].attachments[0].ref, 'file-service://file-img');
  assert.ok(assistant[2].text.includes('林川睁开眼'));

  const detailed = adapter.internals.buildMessages(conversation, 'detailed');
  assert.equal(detailed.messages.at(-1).meta.id, 'm-final');
  const branchMessage = detailed.messages.find((item) => item.meta.id === 'm-code');
  assert.match(branchMessage.branch, /^Branch 2\/2$/, '应标注消息在兄弟分支中的位置');
  assert.ok(detailed.notes.some((note) => /other branches/.test(note)));

  const allText = detailed.messages.map((item) => item.text).join('\n');
  assert.ok(!allText.includes('另一个分支的旧回答'), '只导出当前分支，不混入其它分支正文');

  /* ------------------------------------------------------ 多段内容合并 */
  const content = adapter.internals.readContent({
    content: { content_type: 'multimodal_text', parts: ['第一段', '第二段'] },
  });
  assert.equal(content.text, '第一段\n\n第二段');

  const recapContent = adapter.internals.readContent({
    content: { content_type: 'reasoning_recap', content: '思考了 17s' },
  });
  assert.equal(recapContent.thinking, '思考了 17s');
  assert.equal(recapContent.thinkingLabel, 'Reasoning recap');

  const thoughtPart = adapter.internals.readContent({
    content: {
      content_type: 'multimodal_text',
      parts: [{ content_type: 'thought', text: '先拆问题' }, '正文'],
    },
  });
  assert.equal(thoughtPart.thinking, '先拆问题');
  assert.equal(thoughtPart.text, '正文');

  const reasoningStatus = adapter.internals.readContent({
    content: { content_type: 'text', parts: ['先想一想'] },
    metadata: { reasoning_status: 'is_reasoning' },
  });
  assert.equal(reasoningStatus.thinking, '先想一想');
  assert.equal(reasoningStatus.text, '');

  const summarizedThoughts = adapter.internals.readContent({
    content: {
      content_type: 'thoughts',
      thoughts: [{ summary: '梳理架构', content: '先看输入输出' }],
    },
  });
  assert.equal(summarizedThoughts.thinking, '**梳理架构**\n先看输入输出');

  const summaryOnly = adapter.internals.readContent({
    content: {
      content_type: 'thoughts',
      thoughts: [{ summary: '读取了PDF技能指南', content: '' }],
    },
  });
  assert.equal(summaryOnly.thinking, '**读取了PDF技能指南**');

  const thoughtImage = adapter.internals.readContent({
    content: {
      content_type: 'thoughts',
      thoughts: [{ summary: '看图', content: '先看这张图。' }],
      parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-1', size_bytes: 12 }],
    },
  });
  assert.equal(thoughtImage.images.length, 1);
  assert.equal(thoughtImage.images[0].ref, 'file-service://img-1');

  const recapConversation = buildRecapConversation();
  const recapMessages = adapter.internals.buildMessages(recapConversation, 'full').messages;
  assert.equal(recapMessages.length, 3, '思考摘要节点应保留');
  const recapMessage = recapMessages.find((item) => item.meta.id === 'm-recap');
  assert.equal(recapMessage.thinking, '思考了 17s');
  assert.equal(recapMessage.thinkingLabel, 'Reasoning recap');

  const recapMarkdown = kit.buildMarkdown({
    platform: 'ChatGPT',
    title: recapConversation.title,
    tier: 'full',
    messages: recapMessages,
  });
  assert.match(recapMarkdown, /<think>\n思考了 17s\n<\/think>/);
  assert.match(recapMarkdown, /1 reasoning block/);

  const mergedConversation = buildMergedTurnConversation();
  const mergedMessages = adapter.internals.buildMessages(mergedConversation, 'full').messages;
  const mergedMarkdown = kit.buildMarkdown({
    platform: 'ChatGPT',
    title: mergedConversation.title,
    tier: 'full',
    messages: mergedMessages,
  });
  assert.equal((mergedMarkdown.match(/## ChatGPT \d+/g) || []).length, 1, '同一轮只渲染一个助手标题');
  assert.match(
    mergedMarkdown,
    /<think>\n\*\*读取了PDF技能指南\*\*\n\n\*\*梳理算法细节\*\*\n先看材料。\n\n\*\*提炼论文贡献\*\*\n再总结贡献。\n\n\*\*梳理算法细节并提炼论文贡献\*\*\n\n思考了 29s\n<\/think>/,
  );

  const mergedDetailed = kit.buildMarkdown({
    platform: 'ChatGPT',
    title: mergedConversation.title,
    tier: 'detailed',
    messages: adapter.internals.buildMessages(mergedConversation, 'detailed').messages,
  });
  assert.ok(!mergedDetailed.includes('### 原始数据'), '详尽档不再输出接口原始 JSON');
  assert.match(mergedDetailed, /ID m-answer/);

  /* -------------------------------------------- Markdown 三档结构一致 */
  for (const tier of kit.TIERS) {
    const markdown = kit.buildMarkdown({
      platform: 'ChatGPT',
      title: conversation.title,
      tier,
      messages: adapter.internals.buildMessages(conversation, tier).messages,
    });
    assert.match(markdown, /^## User 1$/m, `${tier} 档结构不一致`);
    assert.match(markdown, /^\*\*Generator:\*\*/m);
  }

  console.log('chatgpt adapter tests passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
