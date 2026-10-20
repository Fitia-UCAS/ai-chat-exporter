/*
 * Gemini 适配层测试：使用保存的 batchexecute 响应结构验证分帧、RPC 解析、分页、多段正文、
 * 思考文本与媒体引用提取。
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
    location: { pathname: '/app/abc123', href: 'https://gemini.google.com/app/abc123' },
    document: {
      title: 'Google Gemini',
      scripts: [],
      documentElement: { lang: 'zh-CN' },
      querySelectorAll: () => [],
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
  vm.runInContext(fs.readFileSync(path.join(root, 'content', 'adapters', 'gemini.js'), 'utf8'), context);
  return { context, adapter: context.GeminiAdapter, kit: context.ChatExportKit };
}

function framePayload(payload) {
  const envelope = [['wrb.fr', 'hNvQHb', JSON.stringify(payload), null, null, null, 'generic']];
  const json = JSON.stringify(envelope);
  return `)]}'\n\n${Buffer.byteLength(json, 'utf8')}\n${json}`;
}

function makeFile(name, mime, url) {
  const meta = [null, 16, name, null, null, 'token', null,
    ['https://drive.google.com/thumb', url, 'https://drive.google.com/upload'],
    1, [1700000000, 0], null, mime];
  return [null, null, null, [meta], [meta]];
}

function makeContextFile(name, mime, url) {
  const meta = [null, 16, name, null, null, 'token', null,
    ['https://drive.google.com/thumb', url, 'https://drive.google.com/upload'],
    1, [1700000000, 0], null, mime];
  return [null, null, null, null, [meta]];
}

function makeTurn(prompt, answer, seconds, extra) {
  const options = extra || {};
  const candidate = [`choice-${seconds}`, options.answerParts || [answer]];
  if (options.thinking) candidate[37] = [[options.thinking]];
  if (options.media) candidate[5] = [[options.media, 'image/png']];

  const promptNode = [prompt];
  if (options.files) promptNode[4] = options.files;

  return [
    ['abc123', `response-${seconds}`],
    ['abc123', `response-${seconds}`, `choice-${seconds}`],
    [promptNode, 3, null, 0, 'model-id'],
    [[candidate]],
    [seconds, 0],
  ];
}

async function main() {
  const { context, adapter, kit } = loadAdapter();
  const { parseLengthPrefixedFrames, findRpcPayload, parseConversation, fetchConversation, findConversationTitle } = adapter.internals;

  assert.equal(adapter.isConversationPage(), true);
  assert.equal(adapter.internals.getConversationId(), 'abc123');

  /* ------------------------------------------------------------ 分帧解析 */
  const payload = [[makeTurn('用户问题', '完整回答', 1700000000, {
    thinking: '内部接口返回的思考过程',
    media: 'https://lh3.googleusercontent.com/generated.png',
  })]];
  const frames = parseLengthPrefixedFrames(framePayload(payload));
  assert.equal(frames.length, 1);
  assert.equal(JSON.stringify(findRpcPayload(frames[0], 'hNvQHb')), JSON.stringify(payload));

  const asciiFrame = JSON.stringify([['wrb.fr', 'other', 'plain']]);
  const unicodeFrame = JSON.stringify([['wrb.fr', 'hNvQHb', '中文和 🎉']]);
  const combinedFrames = `${Buffer.byteLength(asciiFrame, 'utf8')}\n${asciiFrame}\n` +
    `${Buffer.byteLength(unicodeFrame, 'utf8')}\n${unicodeFrame}`;
  const multiFrames = parseLengthPrefixedFrames(combinedFrames);
  assert.equal(multiFrames.length, 2, '多字节内容不能使后续帧丢失');
  assert.equal(multiFrames[1][0][2], '中文和 🎉');

  const escapedBadName = 'https://lh3.googleusercontent.com/photo%ZZ.png';
  const badUrlTurn = makeTurn('问题', '回答', 1700000000, { media: escapedBadName });
  assert.equal(parseConversation([[badUrlTurn]], 'full')[1].attachments[0].name, 'photo%ZZ.png',
    '不规范百分号转义不应中断对话导出');

  const pdfTurn = makeTurn('文件', '请阅读附件', 1700000000, {
    media: 'https://lh3.googleusercontent.com/document.pdf',
  });
  pdfTurn[3][0][0][5][0][1] = 'application/pdf';
  assert.equal(parseConversation([[pdfTurn]], 'full')[1].attachments[0].kind, 'file',
    'PDF 资源应识别为文件而非图片');

  /* ------------------------------------------------------------- 回合解析 */
  const messages = parseConversation(payload, 'full');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, '用户问题');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].text, '完整回答');
  assert.equal(messages[1].thinking, '内部接口返回的思考过程');
  assert.equal(messages[1].attachments[0].ref, 'https://lh3.googleusercontent.com/generated.png');

  const fileTurn = makeTurn('读附件', '已读', 1700000100, {
    files: [makeFile('a.md', 'text/markdown', 'https://contribution.usercontent.google.com/download?c=1')],
  });
  const fileMessages = parseConversation([[fileTurn]], 'full');
  assert.equal(fileMessages[0].attachments.length, 1, '用户上传的附件不能丢');
  assert.equal(fileMessages[0].attachments[0].name, 'a.md');
  assert.equal(fileMessages[0].attachments[0].mimeType, 'text/markdown');
  assert.equal(fileMessages[0].attachments[0].ref, 'https://contribution.usercontent.google.com/download?c=1');

  for (const tier of ['minimal', 'full', 'detailed']) {
    const fileMarkdown = kit.buildMarkdown({
      platform: 'Gemini',
      title: '附件',
      tier,
      messages: fileMessages,
    });
    assert.ok(
      fileMarkdown.includes('[a.md](<https://contribution.usercontent.google.com/download?c=1>)'),
      `${tier} 档的附件名应带链接`,
    );
  }

  const contextTurn = makeTurn('继续', '好', 1700000101, {
    files: [makeContextFile('a.md', 'text/markdown', 'https://contribution.usercontent.google.com/download?c=1')],
  });
  assert.equal(parseConversation([[contextTurn]], 'full')[0].attachments.length, 0,
    '重复携带的上下文文件不应重复列为附件');

  const resourceMessages = parseConversation([[fileTurn]], 'detailed');
  const originalFetchMedia = kit.fetchMedia;
  kit.fetchMedia = async () => ({
    bytes: new TextEncoder().encode('# 附件正文'),
    mimeType: 'text/markdown',
  });
  const collector = kit.createMediaCollector();
  await adapter.collectResources(resourceMessages, collector);
  kit.fetchMedia = originalFetchMedia;
  assert.equal(resourceMessages[0].attachments[0].text, '# 附件正文');
  assert.equal(resourceMessages[0].attachments[0].status, 'Body inlined');
  assert.equal(collector.entries().length, 0, '文本附件内联后不再重复写入 Base64');

  const detailed = parseConversation(payload, 'detailed');

  /* --------------------------------------------------- 多段正文不能丢段 */
  const multiPart = parseConversation([[makeTurn('问题', '', 1700000000, {
    answerParts: ['第一段', '第二段', '第三段'],
  })]], 'full');
  assert.equal(multiPart[1].text, '第一段\n第二段\n第三段');

  const repeated = parseConversation([[makeTurn('问题', '', 1700000000, {
    answerParts: ['她抬头看向远方。', '她抬头看向远方。', '风停了。'],
  })]], 'full');
  assert.equal(repeated[1].text, '她抬头看向远方。\n她抬头看向远方。\n风停了。', '相同段落不能被去重');

  /* ------------------------------------------------------------- 排序 */
  const reversed = [[
    makeTurn('第二问', '第二答', 1800000000),
    makeTurn('第一问', '第一答', 1700000000),
  ]];
  assert.deepEqual(
    plain(parseConversation(reversed, 'full').map((item) => item.text)),
    ['第一问', '第一答', '第二问', '第二答'],
  );

  assert.equal(
    findConversationTitle([null, [['c_abc123', '网页当前标题']]], 'c_abc123'),
    '网页当前标题',
  );

  /* ------------------------------------------------------------- 分页 */
  context.document.scripts = [{
    textContent: '{"SNlM0e":"token-123","cfb2h":"build-456","FdrFJe":"session-789"}',
  }];

  const newestTurn = makeTurn('第二问', '第二答', 1800000000);
  const oldestTurn = makeTurn('第一问', '第一答', 1700000000);
  const pages = [
    [[newestTurn], 'CURSOR-OLDER'],
    [[newestTurn, oldestTurn], null],
  ];
  const requests = [];

  context.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, text: async () => framePayload(pages[requests.length - 1]) };
  };

  const result = await fetchConversation('abc123');
  assert.equal(result.pages, 2);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /rpcids=hNvQHb/);
  assert.match(requests[0].url, /source-path=%2Fapp%2Fabc123/);

  const form = new URLSearchParams(requests[0].options.body);
  const firstArguments = JSON.parse(JSON.parse(form.get('f.req'))[0][0][1]);
  const secondForm = new URLSearchParams(requests[1].options.body);
  const secondArguments = JSON.parse(JSON.parse(secondForm.get('f.req'))[0][0][1]);
  assert.equal(firstArguments[0], 'c_abc123');
  assert.equal(firstArguments[1], 100);
  assert.equal(firstArguments[2], null);
  assert.equal(secondArguments[2], 'CURSOR-OLDER');

  assert.deepEqual(
    plain(parseConversation(result.payload, 'full').map((item) => item.text)),
    ['第一问', '第一答', '第二问', '第二答'],
  );

  /* --------------------------------------------------------- 长对话分页 */
  const longTurns = Array.from({ length: 372 }, (_, index) => (
    makeTurn(`长对话问题 ${index + 1}`, `长对话回答 ${index + 1}`, 1700000000 + index)
  ));
  const newestFirst = [...longTurns].reverse();
  const longPages = [];
  for (let index = 0; index < newestFirst.length; index += 100) {
    const pageTurns = newestFirst.slice(index, index + 100);
    const nextCursor = index + 100 < newestFirst.length ? `CURSOR-${index + 100}` : null;
    longPages.push([pageTurns, nextCursor]);
  }
  let longPageIndex = 0;
  context.fetch = async () => ({ ok: true, text: async () => framePayload(longPages[longPageIndex++]) });

  const longResult = await fetchConversation('abc123');
  const longMessages = parseConversation(longResult.payload, 'full');
  assert.equal(longResult.pages, 4);
  assert.equal(longMessages.length, 744);
  assert.equal(longMessages[0].text, '长对话问题 1');
  assert.equal(longMessages.at(-1).text, '长对话回答 372');

  /* ------------------------------------------------------- 分页异常保护 */
  let stalled = 0;
  context.fetch = async () => {
    stalled++;
    return { ok: true, text: async () => framePayload([[newestTurn], 'CURSOR-STALLED']) };
  };
  await assert.rejects(() => fetchConversation('abc123'), /没有新的对话回合|重复返回同一个续页游标/);
  assert.equal(stalled, 2);

  /* ------------------------------------------- 生成的三档 Markdown 结构一致 */
  for (const tier of kit.TIERS) {
    const markdown = kit.buildMarkdown({
      platform: 'Gemini',
      title: 'Gemini 测试',
      tier,
      messages: parseConversation(payload, tier),
    });
    assert.match(markdown, /^## User 1$/m, `${tier} 档结构不一致`);
  }

  console.log('gemini adapter tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
