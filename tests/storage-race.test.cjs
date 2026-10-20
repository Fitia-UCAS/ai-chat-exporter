const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadKit(chrome) {
  const context = { chrome };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content/core.js'), 'utf8'), context);
  return context.ChatExportKit;
}

async function main() {
  let resolveRead;
  const store = {};
  const chrome = {
    runtime: { id: 'test', lastError: undefined },
    storage: {
      local: {
        get(_keys, callback) { resolveRead = callback; },
        set(value, callback) { Object.assign(store, value); callback?.(); },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  const kit = loadKit(chrome);

  const delayed = kit.getTier();
  const sameRequest = kit.getTier();
  await kit.setTier('detailed');
  resolveRead({ exportTier: 'minimal' });
  assert.equal(await delayed, 'detailed');
  assert.equal(await sameRequest, 'detailed');
  assert.equal(await kit.getTier(), 'detailed');
  assert.equal(store.exportTier, 'detailed');

  // Simulate real asynchronous storage callbacks. The first write is in flight
  // while two subsequent selections occur; stale writes must never win.
  const writes = [];
  const listeners = [];
  const disk = { exportTier: 'full' };
  const queuedChrome = {
    runtime: { id: 'test', lastError: undefined },
    storage: {
      local: {
        get(_keys, callback) { callback({ ...disk }); },
        set(value, callback) { writes.push({ value, callback }); },
      },
      onChanged: {
        addListener(listener) { listeners.push(listener); },
        removeListener() {},
      },
    },
  };
  const queuedKit = loadKit(queuedChrome);
  const updates = [];
  queuedKit.onTierChange((tier) => updates.push(tier));
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const first = queuedKit.setTier('minimal');
  await flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].value.exportTier, 'minimal');

  const second = queuedKit.setTier('full');
  const third = queuedKit.setTier('detailed');
  await flush();
  assert.equal(writes.length, 1, '较早写入未完成前，不应并发启动后续写入');

  // An old storage event must not undo the current in-memory selection.
  listeners[0]({ exportTier: { oldValue: 'full', newValue: 'minimal' } }, 'local');
  assert.equal(await queuedKit.getTier(), 'detailed');

  Object.assign(disk, writes[0].value);
  writes[0].callback();
  await flush();
  assert.equal(writes.length, 2, '应跳过中途已被取代的档位');
  assert.equal(writes[1].value.exportTier, 'detailed');

  Object.assign(disk, writes[1].value);
  writes[1].callback();
  await Promise.all([first, second, third]);
  assert.equal(disk.exportTier, 'detailed', '最后选择的档位必须持久化');
  assert.equal(await queuedKit.getTier(), 'detailed');
  console.log('Storage concurrency tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
