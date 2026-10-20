/* Isolated tests using browser API fixtures. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { loadKit: loadKitScripts } = require('./load-kit.cjs');

function loadKit() {
  const store = { exportTier: undefined };
  const context = {
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    chrome: {
      runtime: { id: 'test-extension', lastError: undefined },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of keys) if (store[key] !== undefined) result[key] = store[key];
            callback(result);
          },
          set(items, callback) {
            Object.assign(store, items);
            if (callback) callback();
          },
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
  };
  vm.createContext(context);
  loadKitScripts(context);
  return { kit: context.ChatExportKit, store, context };
}

function baseMessages() {
  return [
    {
      role: 'user',
      text: '写一段修仙小说的开头',
      time: 1700000000,
      attachments: [{ name: '设定.md', kind: 'file', mimeType: 'text/markdown', size: 2048, text: '# 设定\n主角姓林' }],
    },
    {
      role: 'assistant',
      text: '第一章 开局\n\n林川睁开眼。',
      thinking: '先确定冲突，再铺陈场景。',
      time: 1700000060,
      toolCalls: [{ name: 'python', input: 'print("hi")', inputLanguage: 'python', output: 'hi' }],
      attachments: [{ name: '封面.png', kind: 'image', mimeType: 'image/png', size: 4096, resourceId: 'R1' }],
      meta: { id: 'msg-2', parentId: 'msg-1', model: 'test-model' },
    },
    {
      role: 'user',
      text: '把开头再改一遍，语气更冷。',
      time: 1700000120,
    },
    {
      role: 'assistant',
      text: '第一章 开局\n\n林川睁开眼。',
      time: 1700000180,
    },
  ];
}

async function main() {
  const { kit, store } = loadKit();

  /* ---------------------------------------------------------------- 档位 */
  assert.deepEqual(Array.from(kit.TIERS), ['minimal', 'full', 'detailed']);
  assert.equal(kit.TIER_LABELS.minimal, '极简');
  assert.equal(kit.TIER_LABELS.full, '完整');
  assert.equal(kit.TIER_LABELS.detailed, '详尽');
  assert.equal(kit.DEFAULT_TIER, 'full');
  assert.equal(kit.TIER_STORAGE_KEY, 'exportTier');
  assert.equal(kit.normalizeTier(undefined), 'full');
  assert.equal(kit.normalizeTier('乱七八糟'), 'full');
  assert.equal(kit.normalizeTier('detailed'), 'detailed');

  await kit.setTier('minimal');
  assert.equal(store.exportTier, 'minimal');
  assert.equal(await kit.getTier(), 'minimal');

  /* ------------------------------------------------------------ 文本工具 */
  const shortFence = kit.fence('普通文本');
  assert.match(shortFence, /^```\n普通文本\n```$/);

  assert.equal(kit.decodeText(new TextEncoder().encode('# 标题\n\n正文'), 'text/markdown'), '# 标题\n\n正文');
  assert.equal(kit.decodeText(new TextEncoder().encode('x'), 'application/pdf'), null);

  const tricky = '代码里有 ``` 和 ````';
  const longFence = kit.fence(tricky, 'text');
  assert.match(longFence, /^`````text\n/);
  assert.ok(longFence.endsWith('\n`````'));

  assert.equal(kit.safeFilename('修仙：写个日记，女主们不对劲了'), '修仙：写个日记，女主们不对劲了.md');
  assert.equal(kit.safeFilename('CON'), '_CON.md');
  assert.equal(kit.safeFilename('CON.md'), '_CON.md');
  assert.equal(kit.safeFilename('LPT1.notes.md'), '_LPT1.notes.md');
  assert.equal(kit.safeFilename('', 'bad/name:export'), 'bad_name_export.md');
  assert.equal(kit.safeFilename('', 'NUL.md'), '_NUL.md');
  assert.equal(kit.safeFilename('a/b\\c:d*.md'), 'a_b_c_d.md');
  assert.equal(kit.safeFilename(''), 'Conversation.md');

  /* -------------------------------------------------------------- Base64 */
  for (const size of [0, 1, 2, 3, 4, 5, 255, 1024, 5000]) {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) bytes[index] = (index * 37 + 11) & 0xff;
    const encoded = kit.bytesToBase64(bytes);
    const decoded = kit.base64ToBytes(encoded);
    assert.equal(decoded.length, size, `长度不一致：${size}`);
    assert.deepEqual(Array.from(decoded), Array.from(bytes), `字节不一致：${size}`);
  }

  /* ------------------------------------------------------- 资源收集与去重 */
  const collector = kit.createMediaCollector();
  const same = new Uint8Array([1, 2, 3, 4]);
  const first = await collector.add({ bytes: same, name: 'a.png', mimeType: 'image/png', messageNumber: 1 });
  const second = await collector.add({ bytes: same, name: 'a-copy.png', mimeType: 'image/png', messageNumber: 2 });
  assert.equal(first.id, 'R1');
  assert.equal(second.id, 'R1', '相同内容必须去重为同一个资源');
  assert.deepEqual(Array.from(first.messageNumbers), [1, 2]);

  /* --------------------------------------------------------- 附件去重 */
  const deduped = kit.createMessage({
    role: 'assistant',
    text: '同一个附件出现两次',
    attachments: [
      { name: 'a.pdf', kind: 'file', mimeType: 'application/pdf', size: 10, ref: 'file-service://same' },
      { name: 'a-copy.pdf', kind: 'file', mimeType: 'application/pdf', size: 10, ref: 'file-service://same' },
    ],
  });
  assert.equal(deduped.attachments.length, 1, '同一个引用只保留一次');

  /* -------------------------------------------------------- Markdown 三档 */
  const messages = baseMessages();
  const minimal = kit.buildMarkdown({
    platform: 'ChatGPT', title: '修仙测试', tier: 'minimal', messages, exportedAt: 1700000000000,
  });
  assert.match(minimal, /^\uFEFF# 修仙测试/);
  assert.match(minimal, /\*\*Generator:\*\* AI Chat Exporter \(Minimal\)/);
  assert.match(minimal, /^\*\*Source:\*\* ChatGPT$/m);
  assert.match(minimal, /^\*\*Model:\*\* test-model$/m);
  assert.match(minimal, /^\*\*Exported:\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/m);
  assert.match(minimal, /^\*\*Method:\*\* Unknown$/m);
  assert.match(minimal, /^\*\*Link:\*\* Unknown$/m);
  assert.match(minimal, /^\*\*Messages:\*\* 4 \(User 2 · ChatGPT 2\)$/m);
  assert.match(minimal, /0 reasoning blocks · 0 tool calls · 2 attachments · 0 embedded resources/);
  assert.match(minimal, /## User 1/);
  assert.match(minimal, /## ChatGPT 1/);
  assert.ok(!minimal.includes('先确定冲突'), '极简档不应包含思考');
  assert.ok(!minimal.includes('工具调用'), '极简档不应包含工具调用');
  assert.ok(!minimal.includes('Base64'));
  assert.match(minimal, /Image: 封面\.png/);
  assert.match(minimal, /File: 设定\.md/);
  assert.ok(minimal.indexOf('File: 设定.md') < minimal.indexOf('写一段修仙小说的开头'),
    '用户上传的附件应显示在提问之前');

  const full = kit.buildMarkdown({
    platform: 'ChatGPT', title: '修仙测试', tier: 'full', messages, exportedAt: 1700000000000,
  });
  assert.match(full, /\*\*Generator:\*\* AI Chat Exporter \(Full\)/);
  assert.match(full, /1 reasoning block · 1 tool call · 2 attachments · 0 embedded resources/);
  assert.match(full, /<think>\n先确定冲突，再铺陈场景。\n<\/think>/);
  assert.match(full, /### Tool call · python/);
  assert.match(full, /\*\*Output\*\*/);
  assert.match(full, /\*\*设定\.md\*\*/);
  assert.ok(full.indexOf('主角姓林') < full.indexOf('写一段修仙小说的开头'),
    '附件正文应显示在提问之前');
  assert.match(full, /主角姓林/);
  assert.match(full, /resource:R1/);
  assert.ok(!full.includes('### 原始数据'), '完整档不输出原始结构');
  assert.ok(!full.includes('## Resource appendix'), '完整档不内嵌 Base64');

  const detailed = kit.buildMarkdown({
    platform: 'ChatGPT',
    title: '修仙测试',
    tier: 'detailed',
    messages,
    exportedAt: 1700000000000,
    resources: [{
      id: 'R1',
      name: '封面.png',
      mimeType: 'image/png',
      size: 4,
      hash: { algorithm: 'sha256', hex: 'abcd' },
      messageNumbers: [2],
      source: 'file-service://x',
      bytes: new Uint8Array([9, 8, 7, 6]),
    }],
  });
  assert.match(detailed, /\*\*Generator:\*\* AI Chat Exporter \(Detailed\)/);
  assert.match(detailed, /1 embedded resource/);
  assert.ok(!detailed.includes('### 原始数据'), '详尽档不再输出接口原始 JSON');
  assert.match(detailed, /ID msg-2/);
  assert.match(detailed, /## Resource appendix/);
  assert.match(detailed, /### R1 · 封面\.png/);
  assert.match(detailed, /- Checksum: sha256 abcd/);
  assert.match(detailed, /```base64\nCQgHBg==\n```/);

  const encodedBlock = detailed.match(/```base64\n([\s\S]*?)\n```/)[1];
  assert.deepEqual(Array.from(kit.base64ToBytes(encodedBlock)), [9, 8, 7, 6]);

  /* ------------------------------------------------- 重复的修订版本不能合并 */
  const repeated = [
    { role: 'user', text: '继续' },
    { role: 'assistant', text: '她抬头看向远方。' },
    { role: 'user', text: '继续' },
    { role: 'assistant', text: '她抬头看向远方。' },
    { role: 'user', text: '继续' },
    { role: 'assistant', text: '她抬头看向远方。' },
  ];
  const repeatedMarkdown = kit.buildMarkdown({ platform: 'X', title: '重复', tier: 'full', messages: repeated });
  assert.equal((repeatedMarkdown.match(/她抬头看向远方。/g) || []).length, 3, '相同正文的多轮修订必须全部保留');
  assert.equal((repeatedMarkdown.match(/## User \d+/g) || []).length, 3);

  /* --------------------------------------------- 三档结构必须使用同一套标题 */
  for (const tier of kit.TIERS) {
    const markdown = kit.buildMarkdown({ platform: 'X', title: '结构', tier, messages });
    assert.match(markdown, /^## User 1$/m);
    assert.match(markdown, /^## Assistant 1$/m);
    assert.match(markdown, /^---$/m);
    assert.match(markdown, /^\*\*Source:\*\* X$/m);
    const names = { minimal: 'Minimal', full: 'Full', detailed: 'Detailed' };
    assert.match(markdown, new RegExp(`^\\*\\*Generator:\\*\\* .*\\(${names[tier]}\\)$`, 'm'));
  }

  const navigation = loadKit();
  navigation.context.location = { pathname: '/c/initial' };
  let downloadAttempted = false;
  navigation.context.chrome.runtime.sendMessage = () => { downloadAttempted = true; };
  const exporter = navigation.kit.createExporter({
    platform: 'chatgpt',
    async read() {
      navigation.context.location.pathname = '/c/other';
      return { conversationId: 'initial', title: '第一段对话', messages: [{ role: 'user', text: '内容' }] };
    },
  });
  await assert.rejects(() => exporter({ tier: 'full' }), /已切换对话/);
  assert.equal(downloadAttempted, false, '页面切换后不得覆盖对话文件');

  console.log('core tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
