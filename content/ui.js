(function initializeExportUI(root) {
  'use strict';

  const kit = root.ChatExportKit;
  if (!kit) throw new Error('缺少导出内核。');

  const GAP = 4;
  const EDGE = 8;
  const HANDLE_RADIUS = 16;
  const DRAG_THRESHOLD = 3;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const MARKUP = `
    <link rel="stylesheet" href="${chrome.runtime.getURL('content/ui.css')}">
    <button class="export" type="button" data-state="idle" aria-label="导出 Markdown">
      <span class="glyph" aria-hidden="true"></span>
    </button>
    <button class="arrow" type="button" aria-label="导出档位" aria-haspopup="true" aria-expanded="false">
      <svg class="chev" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="pop" hidden data-flip="below">
      <div class="head">
        <span class="name">完整</span>
        <svg class="chev" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.2"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="slider" role="slider" tabindex="0" aria-label="导出档位"
           aria-valuemin="0" aria-valuemax="2" aria-valuenow="1" aria-valuetext="完整">
        <div class="rail">
          <div class="fill"></div>
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <div class="thumb"></div>
        </div>
      </div>
    </div>
  `;

  function backgroundLuminance(element) {
    if (!element) return null;
    const value = getComputedStyle(element).backgroundColor;
    const numbers = value && value.match(/[\d.]+/g);
    if (!numbers || numbers.length < 3) return null;
    const [r, g, b, alpha = 1] = numbers.map(Number);
    if (alpha === 0) return null;
    return (0.299 * r) + (0.587 * g) + (0.114 * b);
  }

  function pageTheme() {
    const luminance = backgroundLuminance(document.body)
      ?? backgroundLuminance(document.documentElement);
    return luminance === null ? '' : luminance < 128 ? 'dark' : 'light';
  }

  function createControl(config) {
    if (document.getElementById(config.hostId)) return null;

    const host = document.createElement('div');
    host.id = config.hostId;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = MARKUP;
    if (config.css) {
      const extra = document.createElement('style');
      extra.textContent = config.css;
      shadow.append(extra);
    }

    const elements = {
      export: shadow.querySelector('.export'),
      arrow: shadow.querySelector('.arrow'),
      panel: shadow.querySelector('.pop'),
      slider: shadow.querySelector('.slider'),
      name: shadow.querySelector('.name'),
      glyph: shadow.querySelector('.glyph'),
    };
    elements.glyph.innerHTML = config.iconHtml || '';
    elements.export.setAttribute('aria-label', config.exportLabel || '导出 Markdown');

    let tier = kit.normalizeTier(config.tier);
    let open = false;
    let pointer = null;
    let dragging = false;
    let busy = false;
    let feedbackTimeout = null;
    let scheduled = false;
    let destroyed = false;

    function renderPosition(position) {
      const ratio = clamp(position, 0, 1);
      const width = elements.slider.getBoundingClientRect().width;
      if (width === 0) return;

      const center = HANDLE_RADIUS + Math.max(0, width - 2 * HANDLE_RADIUS) * ratio;
      elements.slider.style.setProperty('--thumb-x', `${center}px`);
      elements.slider.style.setProperty('--fill', `${ratio * 100}%`);
      elements.slider.dataset.empty = String(ratio === 0);
    }

    function positionAt(clientX) {
      const rect = elements.slider.getBoundingClientRect();
      return clamp((clientX - rect.left - HANDLE_RADIUS) /
        Math.max(1, rect.width - HANDLE_RADIUS * 2), 0, 1);
    }

    function renderTier(next) {
      tier = kit.normalizeTier(next);
      const index = kit.tierIndex(tier);
      const label = kit.tierLabel(tier);
      elements.name.textContent = label;
      elements.slider.setAttribute('aria-valuenow', String(index));
      elements.slider.setAttribute('aria-valuetext', label);
      elements.arrow.setAttribute('aria-label', `${config.arrowLabel || '导出档位'}：${label}`);
      if (!dragging) renderPosition(index / (kit.TIERS.length - 1));
    }

    async function selectTier(next) {
      const normalized = kit.normalizeTier(next);
      const changed = normalized !== tier;
      renderTier(normalized);
      if (changed) {
        try { await kit.setTier(normalized); }
        catch (error) { console.warn('无法保存导出档位：', error); }
      }
    }

    function snapTo(position) {
      const index = Math.round(clamp(position, 0, 1) * (kit.TIERS.length - 1));
      void selectTier(kit.TIERS[index]);
    }

    function beginPointer(event) {
      if (pointer || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      pointer = { id: event.pointerId, startX: event.clientX, lastX: event.clientX };
      elements.slider.setPointerCapture(event.pointerId);
      elements.slider.focus({ preventScroll: true });
    }

    function movePointer(event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      pointer.lastX = event.clientX;
      if (!dragging && Math.abs(event.clientX - pointer.startX) < DRAG_THRESHOLD) return;
      dragging = true;
      elements.panel.dataset.dragging = 'true';
      const position = positionAt(event.clientX);
      renderPosition(position);
      elements.name.textContent = kit.tierLabel(kit.TIERS[Math.round(position * 2)]);
    }

    function finishPointer(event, cancelled) {
      if (!pointer || pointer.id !== event.pointerId) return;
      const releasedAt = pointer.lastX;
      pointer = null;
      dragging = false;
      delete elements.panel.dataset.dragging;
      if (cancelled) renderTier(tier);
      else snapTo(positionAt(event.clientX ?? releasedAt));
      if (elements.slider.hasPointerCapture?.(event.pointerId)) {
        elements.slider.releasePointerCapture(event.pointerId);
      }
    }

    function handleKeydown(event) {
      const index = kit.tierIndex(tier);
      const changes = {
        ArrowLeft: index - 1, ArrowDown: index - 1,
        ArrowRight: index + 1, ArrowUp: index + 1,
        Home: 0, End: kit.TIERS.length - 1,
      };
      if (!Object.hasOwn(changes, event.key)) return;
      event.preventDefault();
      void selectTier(kit.TIERS[clamp(changes[event.key], 0, kit.TIERS.length - 1)]);
    }

    function positionPanel() {
      elements.panel.dataset.flip = 'below';
      elements.panel.style.right = '0px';
      if (!open) return;

      const rect = elements.panel.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      if (rect.bottom > innerHeight - EDGE && hostRect.top > rect.height + EDGE) {
        elements.panel.dataset.flip = 'above';
      }
      const settled = elements.panel.getBoundingClientRect();
      if (settled.left < EDGE) elements.panel.style.right = `${settled.left - EDGE}px`;
      else if (settled.right > innerWidth - EDGE) {
        elements.panel.style.right = `${settled.right - innerWidth + EDGE}px`;
      }
    }

    function setOpen(value, focus = false) {
      if (!value && pointer) {
        const pointerId = pointer.id;
        pointer = null;
        dragging = false;
        delete elements.panel.dataset.dragging;
        if (elements.slider.hasPointerCapture?.(pointerId)) {
          elements.slider.releasePointerCapture(pointerId);
        }
      }
      open = Boolean(value);
      elements.panel.hidden = !open;
      elements.arrow.setAttribute('aria-expanded', String(open));
      if (open) {
        positionPanel();
        renderPosition(kit.tierIndex(tier) / (kit.TIERS.length - 1));
        if (focus) elements.slider.focus({ preventScroll: true });
      }
    }

    function onDocumentPointerDown(event) {
      if (!open || event.composedPath().includes(host)) return;
      setOpen(false);
    }

    function onDocumentKeydown(event) {
      if (!open || event.key !== 'Escape') return;
      setOpen(false);
      elements.arrow.focus({ preventScroll: true });
    }

    function setState(state, label) {
      elements.export.dataset.state = state;
      busy = state === 'loading';
      elements.export.disabled = busy;
      elements.export.setAttribute('aria-label', label || config.exportLabel || '导出 Markdown');
    }

    async function run() {
      if (busy) return null;
      if (feedbackTimeout !== null) clearTimeout(feedbackTimeout);
      setState('loading', config.loadingLabel || '正在导出…');
      try {
        const result = await config.onExport({ tier });
        setState('success', `已导出（${kit.tierLabel(tier)}）`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState('error', message);
        alert(`导出失败：${message}`);
        return null;
      } finally {
        feedbackTimeout = setTimeout(() => setState('idle'), 2200);
      }
    }

    function layout() {
      if (destroyed) return;
      const size = clamp(Number(config.size?.() ?? 34) || 34, 28, 44);
      host.style.setProperty('--btn', `${size}px`);
      const theme = config.theme?.();
      if (theme) host.dataset.theme = theme;
      else delete host.dataset.theme;

      host.hidden = config.visible?.() === false;
      if (host.hidden) {
        setOpen(false);
        return;
      }
      config.place?.({ host, size, totalWidth: size * 2 + GAP });
      positionPanel();
      if (open && !dragging) renderPosition(kit.tierIndex(tier) / (kit.TIERS.length - 1));
    }

    // A busy chat page can mutate hundreds of times per second. Coalesce DOM events.
    let layoutTimer = null;
    function schedule() {
      if (scheduled || destroyed) return;
      scheduled = true;
      layoutTimer = setTimeout(() => {
        scheduled = false;
        requestAnimationFrame(layout);
      }, 120);
    }

    function onRuntimeMessage(message) {
      if (message?.type === kit.MESSAGES.run) void run();
    }

    elements.slider.addEventListener('pointerdown', beginPointer);
    elements.slider.addEventListener('pointermove', movePointer);
    elements.slider.addEventListener('pointerup', (event) => finishPointer(event, false));
    elements.slider.addEventListener('pointercancel', (event) => finishPointer(event, true));
    elements.slider.addEventListener('lostpointercapture', (event) => finishPointer(event, true));
    elements.slider.addEventListener('keydown', handleKeydown);
    elements.arrow.addEventListener('click', () => setOpen(!open));
    elements.export.addEventListener('click', () => void run());
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    addEventListener('resize', schedule);
    addEventListener('scroll', schedule, true);
    addEventListener('popstate', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    const stopTierSync = kit.onTierChange((value) => renderTier(value));

    // A storage read started on mount must not override an interaction in flight.
    let userSelected = false;
    elements.slider.addEventListener('pointerdown', () => { userSelected = true; });
    elements.slider.addEventListener('keydown', () => { userSelected = true; });
    void kit.getTier().then((value) => {
      if (!destroyed && !userSelected) renderTier(value);
      config.onTierReady?.(tier);
    });

    function destroy() {
      destroyed = true;
      observer.disconnect();
      stopTierSync();
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeydown, true);
      removeEventListener('resize', schedule);
      removeEventListener('scroll', schedule, true);
      removeEventListener('popstate', schedule);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      if (layoutTimer !== null) clearTimeout(layoutTimer);
      if (feedbackTimeout !== null) clearTimeout(feedbackTimeout);
      host.remove();
    }

    document.body.append(host);
    renderTier(tier);
    layout();
    return {
      host,
      exportButton: elements.export,
      arrowButton: elements.arrow,
      popover: elements.panel,
      get tier() { return tier; },
      setState,
      run,
      layout,
      schedule,
      open: () => setOpen(true, true),
      close: () => setOpen(false),
      isOpen: () => open,
      destroy,
    };
  }

  Object.assign(kit, { pageTheme, createControl });
})(typeof globalThis !== 'undefined' ? globalThis : this);
