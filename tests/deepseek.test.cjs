/*
 * DeepSeek 适配层测试：使用保存的 history_messages 响应结构验证正文、片段式思考、
 * 联网搜索、文件引用与三档过滤。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadKit } = require('./load-kit.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));


function loadAdapter() {
  const root = path.join(__dirname, '..');
  const storage = new Map();
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
      href: 'https://chat.deepseek.com/a/chat/s/session-123',
      pathname: '/a/chat/s/session-123',
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    document: {
      title: 'DeepSeek',
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
  vm.runInContext(fs.readFileSync(path.join(root, 'content', 'adapters', 'deepseek.js'), 'utf8'), context);
  return { context, adapter: context.DeepSeekAdapter, kit: context.ChatExportKit, storage };
}

function buildChatData() {
  return {
    chat_session: { title: 'DeepSeek 测试会话' },
    chat_messages: [
      {
        message_id: 'm1',
        role: 'USER',
        content: '问题一',
        inserted_at: 1700000000,
        files: [{ id: 'f1', file_name: '设定.txt', file_size: 100, mime_type: 'text/plain' }],
      },
      {
        message_id: 'm2',
        role: 'ASSISTANT',
        content: '',
        inserted_at: 1700000010,
        fragments: [
          { type: 'THINK', content: '思考内容' },
          { type: 'RESPONSE', content: '回答一' },
        ],
        search_status: 'SUCCESS',
        search_results: [
          { title: '结果A', url: 'https://example.com/a', snippet: '摘要A' },
        ],
      },
      {
        message_id: 'm3',
        role: 'ASSISTANT',
        content: '回答二',
        thinking_content: '旧格式思考',
        thinking_elapsed_secs: 12,
        inserted_at: 1700000020,
      },
      {
        message_id: 'm4',
        role: 'SYSTEM',
        content: '系统提示',
      },
    ],
  };
}

async function main() {
  const { context, adapter, kit, storage } = loadAdapter();
  const chatData = buildChatData();

  assert.equal(adapter.isConversationPage(), true);

  /* ------------------------------------------------------------- 三档过滤 */
  const minimal = adapter.internals.buildMessages(chatData, 'minimal');
  assert.deepEqual(plain(minimal.messages.map((item) => item.role)), ['user', 'assistant', 'assistant']);
  assert.ok(minimal.messages.every((item) => !item.thinking && !item.toolCalls.length));

  const full = adapter.internals.buildMessages(chatData, 'full');
  assert.equal(full.messages.length, 4, '完整档保留系统消息');
  assert.equal(full.messages[0].attachments[0].name, '设定.txt');
  assert.equal(full.messages[1].text, '回答一', '片段式正文应被识别');
  assert.equal(full.messages[1].thinking, '思考内容');
  assert.equal(full.messages[1].toolCalls[0].name, 'Web search');
  assert.match(full.messages[1].toolCalls[0].output, /结果A — https:\/\/example\.com\/a/);
  assert.equal(full.messages[2].thinking, '旧格式思考', '旧字段 thinking_content 仍要兼容');

  const detailed = adapter.internals.buildMessages(chatData, 'detailed');
  assert.equal(detailed.messages[0].meta.id, 'm1');

  /* --------------------------------------------------------------- 读取 */
  storage.set('userToken', JSON.stringify({ value: 'test-token' }));
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ data: { biz_data: chatData } }) };
  };

  const conversation = await adapter.read({ tier: 'full' });
  assert.equal(conversation.platform, 'DeepSeek');
  assert.equal(conversation.title, 'DeepSeek 测试会话');
  assert.equal(conversation.conversationId, 'session-123');
  assert.equal(conversation.messages.length, 4);
  assert.match(requests[0].url, /history_messages\?chat_session_id=session-123/);
  assert.equal(requests[0].options.headers.authorization, 'test-token', '应使用页面登录态，不额外请求凭据');

  /* ------------------------------------------------------ 失败时明确报错 */
  storage.delete('userToken');
  await assert.rejects(() => adapter.read({ tier: 'full' }), /未找到登录信息/);

  storage.set('userToken', JSON.stringify({ value: 'expired' }));
  context.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => adapter.read({ tier: 'full' }), /HTTP 401.*登录状态/);

  context.fetch = async () => ({ ok: true, json: async () => ({ data: { biz_data: {} } }) });
  await assert.rejects(() => adapter.read({ tier: 'full' }), /无法识别的对话数据/);

  /* ------------------------------------------- 生成的三档 Markdown 结构一致 */
  for (const tier of kit.TIERS) {
    const markdown = kit.buildMarkdown({
      platform: 'DeepSeek',
      title: 'DeepSeek 测试会话',
      tier,
      messages: adapter.internals.buildMessages(chatData, tier).messages,
    });
    assert.match(markdown, /^## User 1$/m, `${tier} 档结构不一致`);
  }

  console.log('deepseek adapter tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
