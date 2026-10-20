/* Export orchestration and extension messaging. */
(function initChatExporter(root) {
  'use strict';

  const NS = root.ChatExportKit;
  if (!NS?.buildMarkdown) throw new Error('ChatExportKit markdown must load before exporter.js.');
  const {
    MESSAGES, base64ToBytes, buildMarkdown, createMediaCollector, createMessage,
    getTier, hasRenderableContent: hasBody, normalizeTier,
    safeFilename, summarize, tierLabel,
  } = NS;

  /* Extension messaging and export */
  function describeRuntimeError(message) {
    if (/Extension context invalidated/i.test(String(message))) {
      return '扩展刚刚被重新加载，当前页面还连接着旧实例。请刷新页面后再导出。';
    }
    return message;
  }

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function extensionInfo() {
    try {
      const manifest = chrome.runtime.getManifest();
      return {
        name: manifest.name || 'AI Chat Exporter',
        version: manifest.version || '',
      };
    } catch {
      return { name: 'AI Chat Exporter', version: '' };
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(describeRuntimeError(error.message)));
          else resolve(response);
        });
      } catch (error) {
        reject(new Error(describeRuntimeError(error && error.message ? error.message : String(error))));
      }
    });
  }

  async function requestDownload(payload) {
    const response = await sendMessage(Object.assign({ type: MESSAGES.download }, payload));
    if (!response || !response.ok) {
      throw new Error((response && response.error) || '下载失败。');
    }
    return response;
  }

  async function fetchMedia(url) {
    const response = await sendMessage({ type: MESSAGES.fetchMedia, url });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || '无法读取该资源。');
    }
    return {
      bytes: base64ToBytes(response.base64),
      mimeType: response.mimeType || '',
    };
  }


  function createExporter(adapter) {
    let running = false;

    return async function runExport(options) {
      const config = options || {};
      if (running) return null;

      if (!hasExtensionContext()) {
        throw new Error('扩展刚刚被重新加载，当前页面还连接着旧实例。请刷新页面后再导出。');
      }
      if (!adapter || typeof adapter.read !== 'function') {
        throw new Error('导出适配器没有正确加载，请重新加载扩展。');
      }

      running = true;
      try {
        const startingPath = root.location?.pathname || '';
        const ensureSamePage = () => {
          if (startingPath && root.location?.pathname !== startingPath) {
            throw new Error('导出期间已切换对话，已取消保存。请在当前对话重新导出。');
          }
        };
        const tier = normalizeTier(config.tier || await getTier());
        const conversation = await adapter.read({ tier, onProgress: config.onProgress });
        ensureSamePage();
        if (!conversation || !Array.isArray(conversation.messages)) {
          throw new Error('导出适配器没有返回对话数据。');
        }

        const notes = Array.isArray(conversation.notes) ? conversation.notes.slice() : [];
        const visibleMessages = conversation.messages
          .map(createMessage)
          .filter((message) => hasBody(message, tier));
        // Reassign message numbers after filtering so resource references point to real export positions.
        visibleMessages.forEach((message, index) => { message.index = index + 1; });
        if (!visibleMessages.length) {
          throw new Error('没有找到可导出的对话内容。');
        }

        let resources = [];
        if (tier === 'detailed' && typeof adapter.collectResources === 'function') {
          const collector = createMediaCollector();
          resources = await adapter.collectResources(visibleMessages, collector, { tier });
        }

        const app = extensionInfo();
        const markdown = buildMarkdown({
          platform: conversation.platform || adapter.platformLabel,
          title: conversation.title,
          url: conversation.url,
          exportedAt: Date.now(),
          tier,
          messages: visibleMessages,
          resources,
          notes,
          model: conversation.model,
          method: conversation.method,
          pages: conversation.pages,
          appName: app.name,
          appVersion: app.version,
        });

        ensureSamePage();
        const filename = safeFilename(conversation.title, conversation.fallbackTitle || 'Conversation');
        const download = await requestDownload({
          conversationId: `${adapter.platform || adapter.platformLabel}:${conversation.conversationId}`,
          filename,
          markdown,
          tier,
        });

        return {
          tier,
          tierLabel: tierLabel(tier),
          messages: visibleMessages.length,
          resources: resources.length,
          filename: download.filename || filename,
          warnings: download.warning ? [...notes, download.warning] : notes,
          pages: conversation.pages || 1,
          stats: summarize(visibleMessages, tier),
        };
      } finally {
        running = false;
      }
    };
  }

  Object.assign(NS, {
    describeRuntimeError, hasExtensionContext, requestDownload, fetchMedia, createExporter,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
