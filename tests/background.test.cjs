/* Isolated tests using browser API fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness(options = {}) {
  const core = fs.readFileSync(path.join(__dirname, '..', 'content', 'core.js'), 'utf8');
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

  const sequence = [];
  const storage = {};
  const messageListeners = [];
  const clickListeners = [];
  let nextDownloadId = 1;
  let downloadState = options.downloadState || 'complete';
  const downloads = new Map();
  const existingNames = new Set(options.existingNames || []);

  const context = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    crypto: require('node:crypto').webcrypto,
    fetch: options.fetch || (async () => { throw new Error('no network in tests'); }),
    importScripts(target) {
      if (!target.endsWith('content/core.js')) throw new Error(`意外的 importScripts: ${target}`);
      vm.runInContext(core, context);
    },
    chrome: {
      runtime: {
        lastError: undefined,
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
      },
      action: {
        onClicked: { addListener: (fn) => clickListeners.push(fn) },
        setIcon: (details, callback) => {
          sequence.push(`setIcon:${details.path[32]}`);
          if (callback) callback();
        },
      },
      tabs: { sendMessage: (tabId, message, callback) => { sequence.push(`tab:${message.type}`); if (callback) callback(); } },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of keys || Object.keys(storage)) if (key in storage) result[key] = storage[key];
            callback(result);
          },
          set(items, callback) {
            sequence.push('storageSet');
            if (options.failStorageSet) {
              context.chrome.runtime.lastError = { message: '模拟存储失败' };
              callback?.();
              context.chrome.runtime.lastError = undefined;
              return;
            }
            Object.assign(storage, items);
            callback?.();
          },
        },
      },
      downloads: {
        search(query, callback) {
          if (Array.isArray(query.query)) {
            const term = query.query.join(' ').toLowerCase();
            return callback([...downloads.values()].filter((item) =>
              item.filename.toLowerCase().includes(term)));
          }
          if (query.id) return callback(downloads.has(query.id) ? [downloads.get(query.id)] : []);
          return callback([]);
        },
        download(details, callback) {
          sequence.push(`download:${details.filename}`);
          sequence.push(`conflict:${details.conflictAction}`);
          let finalName = details.filename;
          const occupied = (filename) => existingNames.has(filename.toLowerCase()) ||
            [...downloads.values()].some((item) => item.filename.split('\\').pop().toLowerCase() === filename.toLowerCase());
          if (details.conflictAction === 'uniquify') {
            let count = 1;
            while (occupied(finalName)) {
              finalName = details.filename.replace(/\.md$/i, ` (${count++}).md`);
            }
          }
          existingNames.add(finalName.toLowerCase());
          const downloadId = nextDownloadId++;
          downloads.set(downloadId, {
            id: downloadId,
            exists: true,
            filename: `C:\\Users\\test\\Downloads\\${finalName}`,
            state: downloadState,
            error: downloadState === 'interrupted' ? 'NETWORK_FAILED' : undefined,
          });
          callback(downloadId);
        },
        removeFile(details, callback) {
          sequence.push(`removeFile:${details.id}`);
          if (callback) callback();
        },
        erase(details, callback) {
          sequence.push(`erase:${details.id}`);
          if (callback) callback();
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
      runtime_lastError: undefined,
    },
  };

  vm.createContext(context);
  vm.runInContext('this.self = this;', context);
  vm.runInContext(background, context);

  return {
    context,
    storage,
    sequence,
    clickListeners,
    setDownloadState: (value) => { downloadState = value; },
    send(message, sender) {
      return new Promise((resolve) => {
        const listener = messageListeners[0];
        if (!listener) throw new Error('background 没有注册消息监听');
        listener(message, sender || { url: 'https://chatgpt.com/c/test', tab: { id: 12, url: 'https://chatgpt.com/c/test' } }, resolve);
      });
    },
  };
}

async function main() {
  /* -------------------------------------------------- 首次下载与记录 */
  const harness = createHarness();
  const first = await harness.send({
    type: 'chat-export-download',
    conversationId: 'conv-1',
    filename: '修仙：写个日记.md',
    markdown: '# 标题\n\n正文',
    tier: 'full',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.filename, '修仙：写个日记.md');
  assert.match(harness.sequence[0], /^download:/);
  assert.ok(harness.sequence.includes('conflict:uniquify'), '首次导出必须避免覆盖无关文件');
  assert.ok(!harness.sequence.some((item) => item.startsWith('removeFile')), '首次导出不应删除任何文件');
  const record = harness.storage['download-conv-1'];
  assert.equal(record.filename, '修仙：写个日记.md');
  assert.equal(record.tier, 'full');

  /* ------------------------------------ 再次导出覆盖受控文件 */
  const second = await harness.send({
    type: 'chat-export-download',
    conversationId: 'conv-1',
    filename: '修仙：写个日记（改）.md',
    markdown: '# 标题\n\n新正文',
    tier: 'detailed',
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  const downloadIndex = harness.sequence.lastIndexOf(`download:${second.filename}`);
  assert.ok(downloadIndex >= 0, '应发起新下载');
  assert.equal(second.filename, first.filename, '同一对话更新应保持已分配的文件名');
  assert.equal(harness.sequence.filter((item) => item === 'conflict:overwrite').length, 1,
    '再次导出应通过浏览器原生覆盖能力更新文件');
  assert.ok(!harness.sequence.some((item) => item.startsWith('removeFile') || item.startsWith('erase')),
    '覆盖文件不需要主动删除旧文件或下载历史');
  assert.equal(harness.storage['download-conv-1'].downloadId, 2, '记录应更新至最新导出');

  const different = await harness.send({
    type: 'chat-export-download',
    conversationId: 'conv-other',
    filename: '修仙：写个日记.md',
    markdown: '# 另一段对话',
  });
  assert.equal(different.ok, true);
  assert.notEqual(different.filename, first.filename,
    '不同对话使用相同标题时不得覆盖彼此的文件');
  const differentAgain = await harness.send({
    type: 'chat-export-download',
    conversationId: 'conv-other',
    filename: '修仙：写个日记.md',
    markdown: '# 另一段对话的后续内容',
  });
  assert.equal(differentAgain.filename, different.filename,
    '重名对话再次导出应持续使用单独分配的文件名');

  const external = createHarness({ existingNames: ['现有文档.md'] });
  const safeFirst = await external.send({
    type: 'chat-export-download', conversationId: 'safe', filename: '现有文档.md', markdown: '# 首次导出',
  });
  assert.equal(safeFirst.filename, '现有文档 (1).md', '首次导出不能覆盖与扩展无关的同名文件');
  const safeUpdate = await external.send({
    type: 'chat-export-download', conversationId: 'safe', filename: '现有文档.md', markdown: '# 更新导出',
  });
  assert.equal(safeUpdate.filename, safeFirst.filename, '首次导出加后缀后更新应保持同一文件名');
  assert.deepEqual(external.sequence.filter((event) => /^(?:download:|conflict:)/.test(event)).slice(-2),
    [`download:${safeFirst.filename}`, 'conflict:overwrite']);

  const parallel = createHarness();
  const simultaneous = await Promise.all([
    parallel.send({ type: 'chat-export-download', conversationId: 'parallel', filename: '并发.md', markdown: '# 1' }),
    parallel.send({ type: 'chat-export-download', conversationId: 'parallel', filename: '并发.md', markdown: '# 2' }),
  ]);
  assert.ok(simultaneous.every((item) => item.ok), '同一对话的并发请求应串行完成');
  assert.equal(parallel.storage['download-parallel'].downloadId, 2);

  /* ------------------------------------- 下载失败：旧记录不变 */
  const failing = createHarness({ downloadState: 'interrupted' });
  failing.storage['download-conv-2'] = {
    downloadId: 7,
    filename: '旧文件.md',
    preferred: '旧文件.md',
    tier: 'full',
  };
  const failed = await failing.send({
    type: 'chat-export-download',
    conversationId: 'conv-2',
    filename: '旧文件.md',
    markdown: '# 新内容',
    tier: 'full',
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /下载未完成/);
  assert.equal(failing.sequence.find((item) => item.startsWith('conflict:')), 'conflict:uniquify',
    '缺失历史记录时不能直接覆盖未知文件');
  assert.ok(!failing.sequence.some((item) => item.startsWith('removeFile')), '失败时不得主动删除旧文件');
  assert.equal(failing.storage['download-conv-2'].downloadId, 7, '失败时不得覆盖下载记录');

  /* 存储失败：实际已保存的文件仍应报告成功并返回警告。 */
  const storageFailure = createHarness({ failStorageSet: true });
  storageFailure.storage['download-conv-3'] = {
    downloadId: 23,
    filename: '保留.md',
    preferred: '保留.md',
    tier: 'full',
  };
  const unsuccessfulSave = await storageFailure.send({
    type: 'chat-export-download',
    conversationId: 'conv-3',
    filename: '保留.md',
    markdown: '# 新内容',
  });
  assert.equal(unsuccessfulSave.ok, true, '实际下载成功不应因记录失败被错误报告为失败');
  assert.match(unsuccessfulSave.warning, /模拟存储失败/);
  assert.equal(storageFailure.storage['download-conv-3'].downloadId, 23);
  assert.ok(!storageFailure.sequence.some((item) => item.startsWith('removeFile')),
    '存储失败不得额外执行删除操作');

  /* -------------------------------------------------- 媒体域名白名单 */
  const media = createHarness({
    fetch: async (url) => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      url,
    }),
  });
  const allowed = await media.send({
    type: 'chat-export-fetch-media',
    url: 'https://files.oaiusercontent.com/file-1.png',
  });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(media.context.ChatExportKit.base64ToBytes(allowed.base64).length, 4);

  const unauthorized = await media.send({
    type: 'chat-export-fetch-media',
    url: 'https://files.oaiusercontent.com/file-1.png',
  }, { url: 'https://evil.example.com/', tab: { id: 12 } });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.error, /不允许的消息来源/);

  const large = createHarness({
    fetch: async () => ({
      ok: true,
      headers: { get: () => '' },
      body: {
        getReader() {
          let count = 0;
          return {
            async read() {
              if (count === 0) {
                count += 1;
                return { done: false, value: new Uint8Array(4 * 1024 * 1024) };
              }
              if (count === 1) {
                count += 1;
                return { done: false, value: new Uint8Array(3 * 1024 * 1024) };
              }
              return { done: true };
            },
            releaseLock() {},
          };
        },
        async cancel() {},
      },
    }),
  });
  const largeResource = await large.send({
    type: 'chat-export-fetch-media',
    url: 'https://files.oaiusercontent.com/large',
  });
  assert.equal(largeResource.ok, true);
  assert.ok(largeResource.base64.length > 0);

  const blocked = await media.send({
    type: 'chat-export-fetch-media',
    url: 'https://evil.example.com/file-1.png',
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /不允许读取该域名/);

  const insecure = await media.send({ type: 'chat-export-fetch-media', url: 'http://files.oaiusercontent.com/a.png' });
  assert.equal(insecure.ok, false);
  assert.match(insecure.error, /HTTPS/);

  /* ------------------------------------------- 工具栏图标跟随站点 */
  await media.send({ type: 'site-detected', site: 'gemini' }, { url: 'https://gemini.google.com/app/example', tab: { id: 7, url: 'https://gemini.google.com/app/example' } });
  assert.ok(media.sequence.includes('setIcon:icons/gemini-32.png'), '站点上报后应切换到该站点图标');

  /* ------------------------------------------------ 工具栏图标触发导出 */
  assert.equal(media.clickListeners.length, 1);
  media.clickListeners[0]({ id: 42, url: 'https://chatgpt.com/c/test' });
  assert.ok(media.sequence.includes('tab:chat-export-run'), '点击工具栏图标应通知页面导出');

  console.log('background tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
