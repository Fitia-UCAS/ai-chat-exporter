(function initializeExporter(root) {
  'use strict';

  const kit = root.ChatExportKit;
  if (!kit) throw new Error('缺少导出内核。');

  const sites = {
    'chatgpt.com': ['chatgpt', 'ChatGPTAdapter'],
    'chat.openai.com': ['chatgpt', 'ChatGPTAdapter'],
    'gemini.google.com': ['gemini', 'GeminiAdapter'],
    'chat.deepseek.com': ['deepseek', 'DeepSeekAdapter'],
  };

  const site = sites[location.hostname];
  if (!site) return;

  const [platformId, adapterName] = site;
  const adapter = root[adapterName];
  if (!adapter) throw new Error(`缺少 ${platformId} 适配器。`);

  Object.assign(kit, {
    platformId,
    adapter,
    runExport: kit.createExporter(adapter),
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
