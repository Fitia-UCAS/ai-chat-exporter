const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_ROOT = path.join(__dirname, '..', 'content');

function loadKit(context, files = ['core.js', 'markdown.js', 'exporter.js']) {
  for (const file of files) {
    const source = fs.readFileSync(path.join(CONTENT_ROOT, file), 'utf8');
    vm.runInContext(source, context, { filename: `content/${file}` });
  }
  return context.ChatExportKit;
}

module.exports = { loadKit };
