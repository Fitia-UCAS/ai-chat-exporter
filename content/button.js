(function initializeExportButton(root) {
  'use strict';

  const kit = root.ChatExportKit;
  if (!kit?.adapter || !kit.platformId) return;

  const icon = (filename) => `<img src="${chrome.runtime.getURL(`icons/${filename}`)}" alt="">`;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function toolbarControls(maxDistance) {
    const controls = [];
    for (const element of document.querySelectorAll('button,[role="button"],a,.ds-icon-button')) {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top >= 96 || rect.right <= innerWidth - maxDistance ||
          rect.width <= 20 || rect.height <= 20) continue;
      const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      controls.push({ element, rect, label });
    }
    return controls;
  }

  function findControl(controls, preferred, compare) {
    if (!controls.length) return null;
    const matching = controls.filter(({ label }) => preferred.test(label));
    return (matching.length ? matching : controls).sort(compare)[0] || null;
  }

  const configBySite = {
    chatgpt: {
      hostId: '__chatgpt_export_button__',
      icon: 'chatgpt-32.png',
      css: ':host([data-theme="dark"]) .glyph img { filter: invert(1); }',
      fallback: { top: 8, right: 158 },
      geometry() {
        const controls = toolbarControls(320);
        const selected = findControl(controls, /分享|share/i,
          (a, b) => a.rect.top - b.rect.top || b.rect.right - a.rect.right);
        if (!selected) return null;
        return { rect: selected.rect, size: clamp(Math.round(selected.rect.height) || 34, 32, 40) };
      },
    },
    gemini: {
      hostId: '__gemini_export_button__',
      icon: 'gemini-32.png',
      css: ':host([data-theme="light"]) { --panel: #f0f1f3; } :host([data-theme="dark"]) { --panel: #303134; }',
      fallback: { top: 16, right: 120 },
      loadingLabel: '正在读取完整对话…',
      geometry() {
        const controls = toolbarControls(240).filter(({ rect }) =>
          rect.width >= 28 && rect.height >= 28 && rect.width <= 260 &&
          rect.top < 90 && rect.left > innerWidth * 0.45);
        const selected = findControl(controls, /更多|选项|菜单|more|options|menu/i,
          (a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top);
        if (!selected) return null;
        return {
          rect: selected.rect,
          align: Math.min(...controls.map(({ rect }) => rect.left)),
          size: clamp(Math.round(selected.rect.height) || 34, 34, 40),
        };
      },
    },
    deepseek: {
      hostId: 'deepseek-markdown-export',
      icon: 'deepseek-32.png',
      fallback: { top: 8, right: 56 },
      geometry() {
        const controls = toolbarControls(160).filter(({ element }) => element.querySelector('svg'));
        const selected = findControl(controls, /分享|share/i,
          (a, b) => b.rect.right - a.rect.right || a.rect.top - b.rect.top);
        if (!selected) return null;
        return { rect: selected.rect, size: clamp(Math.round(selected.rect.height) || 32, 32, 40) };
      },
    },
  };

  const config = configBySite[kit.platformId];
  if (!config) return;

  let geometry = null;
  const control = kit.createControl({
    hostId: config.hostId,
    iconHtml: icon(config.icon),
    css: config.css,
    exportLabel: '导出 Markdown',
    loadingLabel: config.loadingLabel || '正在导出…',
    arrowLabel: '导出档位',
    theme: kit.pageTheme,
    visible: () => kit.adapter.isConversationPage(),
    size: () => {
      geometry = config.geometry();
      return geometry?.size || 34;
    },
    place: ({ host, size, totalWidth }) => {
      if (!geometry) {
        Object.assign(host.style, {
          top: `${config.fallback.top}px`,
          left: 'auto',
          right: `${config.fallback.right}px`,
        });
        return;
      }
      Object.assign(host.style, {
        top: `${Math.round(geometry.rect.top + (geometry.rect.height - size) / 2)}px`,
        left: `${Math.max(8, Math.round((geometry.align ?? geometry.rect.left) - totalWidth - 8))}px`,
        right: 'auto',
      });
    },
    onExport: ({ tier }) => kit.runExport({ tier }),
  });

  if (control) {
    chrome.runtime.sendMessage({ type: 'site-detected', site: kit.platformId }, () => {
      void chrome.runtime.lastError;
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
