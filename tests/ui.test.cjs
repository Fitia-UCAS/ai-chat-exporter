/* Headless interaction tests for the shadow-root control without dependencies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Emitter {
  constructor() { this.handlers = new Map(); }
  addEventListener(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.handlers.get(name)?.delete(handler); }
  emit(name, props = {}) {
    const event = { type: name, preventDefault() {}, stopPropagation() {},
      composedPath: () => [], ...props };
    for (const handler of this.handlers.get(name) || []) handler(event);
    return event;
  }
}

class Element extends Emitter {
  constructor(name) {
    super();
    this.name = name;
    this.style = {
      properties: {},
      setProperty(key, value) { this.properties[key] = value; },
      getPropertyValue(key) { return this.properties[key] || ''; },
    };
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this.isConnected = false;
    this.capture = null;
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() {}
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture(id) { if (this.capture === id) this.capture = null; }
  click() { this.emit('click'); }
  remove() { this.isConnected = false; }
  getBoundingClientRect() {
    const width = this.name === 'slider' || this.name === 'pop' ? 276 : 34;
    return { left: 100, right: 100 + width, top: 50, bottom: 140, width, height: 34 };
  }
  attachShadow() {
    this.shadowRoot = new Shadow();
    return this.shadowRoot;
  }
}

class Shadow {
  constructor() { this.nodes = new Map(); }
  set innerHTML(value) { this.markup = value; }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element(selector.slice(1)));
    return this.nodes.get(selector);
  }
  append() {}
}

async function main() {
  const root = path.join(__dirname, '..');
  const content = fs.readFileSync(path.join(root, 'content', 'core.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'content', 'ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'content', 'ui.css'), 'utf8');
  const documentEvents = new Emitter();
  const windowEvents = new Emitter();
  const elements = new Map();
  const storage = {};
  let exports = 0;
  let lastExportTier = '';
  const document = Object.assign(documentEvents, {
    body: {
      append(host) { host.isConnected = true; elements.set(host.id, host); },
    },
    documentElement: {},
    createElement() { return new Element('host'); },
    getElementById(id) { return elements.get(id); },
  });

  const context = {
    document,
    console,
    innerWidth: 1440,
    innerHeight: 900,
    chrome: {
      runtime: {
        id: 'test', lastError: undefined,
        getURL: (file) => `chrome-extension://test/${file}`,
        onMessage: { addListener() {}, removeListener() {} },
      },
      storage: {
        local: {
          get(keys, cb) { cb(Object.fromEntries(keys.map((key) => [key, storage[key]]))); },
          set(record, cb) { Object.assign(storage, record); cb?.(); },
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
    getComputedStyle() { return { backgroundColor: 'rgb(255,255,255)' }; },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame(callback) { callback(); },
    setTimeout, clearTimeout,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    alert(message) { throw new Error(message); },
  };
  vm.createContext(context);
  vm.runInContext(content, context);
  vm.runInContext(ui, context);
  const kit = context.ChatExportKit;
  const control = kit.createControl({
    hostId: 'control-test',
    onExport: async ({ tier }) => { exports++; lastExportTier = tier; return {}; },
    size: () => 34,
    visible: () => true,
    place() {},
  });
  const slider = control.host.shadowRoot.querySelector('.slider');
  const panel = control.host.shadowRoot.querySelector('.pop');

  control.open();
  assert.equal(panel.hidden, false);
  assert.equal(control.tier, 'full');
  assert.equal(slider.style.getPropertyValue('--fill'), '50%');

  function drag(from, to, id) {
    const x = (p) => 100 + 16 + (276 - 32) * p;
    slider.emit('pointerdown', { pointerId: id, pointerType: 'mouse', button: 0, clientX: x(from) });
    slider.emit('pointermove', { pointerId: id, clientX: x(to) });
    assert.equal(control.tier, expectedAtStart);
    assert.equal(slider.style.getPropertyValue('--fill'), `${to * 100}%`);
    slider.emit('pointerup', { pointerId: id, clientX: x(to) });
  }

  let expectedAtStart = 'full';
  drag(.5, .38, 1);
  assert.equal(control.tier, 'full');
  assert.equal(slider.style.getPropertyValue('--fill'), '50%');

  expectedAtStart = 'full';
  drag(.5, .76, 2);
  assert.equal(control.tier, 'detailed');
  assert.equal(slider.style.getPropertyValue('--fill'), '100%');

  expectedAtStart = 'detailed';
  drag(1, 0, 3);
  assert.equal(control.tier, 'minimal');
  assert.equal(slider.style.getPropertyValue('--fill'), '0%');
  assert.equal(slider.dataset.empty, 'true');

  slider.emit('keydown', { key: 'End' });
  assert.equal(control.tier, 'detailed');
  slider.emit('keydown', { key: 'Home' });
  assert.equal(control.tier, 'minimal');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.exportTier, 'minimal');

  control.exportButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exports, 1);
  assert.equal(lastExportTier, 'minimal');
  control.close();
  assert.equal(panel.hidden, true);
  control.destroy();
  assert.equal(control.host.isConnected, false);

  assert.match(css, /border-radius:\s*999px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.pop\[hidden\]\s*\{\s*display:\s*none/);
  console.log('UI interaction tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
