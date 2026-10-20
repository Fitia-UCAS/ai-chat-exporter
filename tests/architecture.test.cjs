const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

test('content scripts load the export pipeline before UI and adapters', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts?.[0]?.js;
  assert.deepEqual(scripts, [
    'content/core.js',
    'content/markdown.js',
    'content/exporter.js',
    'content/ui.js',
    'content/adapters/chatgpt.js',
    'content/adapters/gemini.js',
    'content/adapters/deepseek.js',
    'content/main.js',
    'content/button.js',
  ]);
  for (const file of scripts) assert.equal(fs.existsSync(path.join(ROOT, file)), true, file);
});

test('shared export modules stay focused', () => {
  for (const file of ['core.js', 'markdown.js', 'exporter.js']) {
    const lines = fs.readFileSync(path.join(ROOT, 'content', file), 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 600, `${file} has grown to ${lines} lines; split its responsibility first`);
  }
});
