const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content', 'button.js'), 'utf8');

test('the clickable control stays in the document body instead of a native interactive toolbar', () => {
  assert.doesNotMatch(source, /insertBefore\(host/);
  assert.match(source, /document\.body\.append\(host\)/);
});

function node(name, parentElement = null) {
  const value = {
    name,
    parentElement,
    isConnected: true,
    contains(candidate) {
      for (let current = candidate; current; current = current.parentElement) {
        if (current === value) return true;
      }
      return false;
    },
  };
  return value;
}

function element(rect, label = '', parentElement = null) {
  return {
    ...node(label, parentElement),
    textContent: label,
    getBoundingClientRect: () => rect,
    getAttribute(name) { return name === 'aria-label' ? label : ''; },
  };
}

function captureChatGptPlacement(elements, body) {
  let config = null;
  const kit = {
    adapter: { isConversationPage: () => true },
    platformId: 'chatgpt',
    pageTheme: () => 'light',
    createControl(next) { config = next; return {}; },
    runExport: async () => ({}),
  };
  const context = {
    ChatExportKit: kit,
    innerWidth: 1920,
    document: { querySelectorAll: () => elements, body },
    chrome: {
      runtime: {
        lastError: null,
        getURL: (file) => `chrome-extension://test/${file}`,
        sendMessage(_message, callback) { callback?.(); },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.ok(config, 'ChatGPT control was created');

  const size = config.size();
  const host = { style: {}, isConnected: false };
  config.place({ host, size, totalWidth: size * 2 + 4 });
  return {
    style: host.style,
    host,
    placeAgain: () => config.place({ host, size, totalWidth: size * 2 + 4 }),
  };
}

test('ChatGPT exporter is positioned left of the complete native toolbar group', () => {
  const body = node('body');
  body.append = (host) => {
    host.isConnected = true;
    host.parentElement = body;
  };
  const { style, host } = captureChatGptPlacement([
    element({ left: 1650, right: 1686, top: 14, bottom: 50, width: 36, height: 36 }, '模型菜单'),
    element({ left: 1694, right: 1730, top: 14, bottom: 50, width: 36, height: 36 }, '更多'),
    element({ left: 1790, right: 1870, top: 14, bottom: 50, width: 80, height: 36 }, '分享'),
  ], body);

  assert.equal(host.parentElement, body);
  assert.equal(style.position, 'fixed');
  assert.equal(style.left, '1566px');
});

test('a control on another header row does not push the exporter away', () => {
  const body = node('body');
  body.append = (host) => { host.isConnected = true; host.parentElement = body; };
  const upper = node('upper', body);
  const lower = node('lower', body);
  const { style } = captureChatGptPlacement([
    element({ left: 1610, right: 1660, top: 58, bottom: 94, width: 50, height: 36 }, '另一行', lower),
    element({ left: 1790, right: 1870, top: 14, bottom: 50, width: 80, height: 36 }, '分享', upper),
  ], body);

  assert.equal(style.left, '1706px');
  assert.equal(style.position, 'fixed');
});
