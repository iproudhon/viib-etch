;(function (globalThis) {
  const IS_NODE =
    typeof process !== 'undefined' &&
    process.versions &&
    process.versions.node &&
    typeof module !== 'undefined' &&
    !!module.exports;

  // ----------------------------
  // Browser UI (embeddable)
  // ----------------------------
  function createBrowserUI() {
      const DEFAULTS = {
      apiBase: '/api',
      uiBase: '/',
      tokenStorageKey: 'viib-etch.ui.token',
      modelStorageKey: 'viib-etch.ui.model',
      reasoningEffortStorageKey: 'viib-etch.ui.reasoningEffort',
      chatStorageKey: 'viib-etch.ui.chatId',
      autoScrollThresholdPx: 140,
      imageThumbPx: 64,
      // Optional: Monaco Editor base URL (loads on demand in File Explorer).
      // You can override with opts.monacoBaseUrl to use a local/cached copy.
      monacoBaseUrl: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs',
    };

    const escapeHtml = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const firstLine = (text) => {
      const s = String(text || '');
      const i = s.indexOf('\n');
      return i === -1 ? s : s.slice(0, i);
    };

    const clampLines = (text, maxLines) => {
      const lines = String(text || '').split('\n');
      if (lines.length <= maxLines) return String(text || '');
      return lines.slice(lines.length - maxLines).join('\n');
    };

    const nowIso = () => new Date().toISOString();

    function mount(container, opts) {
      const options = Object.assign({}, DEFAULTS, opts || {});
      const root = typeof container === 'string' ? document.querySelector(container) : container;
      if (!root) throw new Error('viib-etch-ui: container not found');

      const state = {
        chats: [],
        // Currently active chat (tab)
        chat: null,
        chatId: null,
        models: [],
        selectedModel: null,
        selectedReasoningEffort: null,
        token: null,
        // Per-chat panes: each owns body/footer DOM + running/live state + SSE
        panes: new Map(), // chatId -> PaneCtx
        collapsedByUser: new Set(),
        toolUi: new Map(),
        chatStatus: new Map(),
        chatMeta: new Map(),
        // Global file explorer/editor window state
        fileExplorer: {
          backdropEl: null,
          windowEl: null,
          headerEl: null,
          titleEl: null,
          topRowEl: null,
          bodyEl: null,
          sidebarEl: null,
          editorEl: null, // fallback textarea
          editorHostEl: null,
          diffHostEl: null,
          toolbarEl: null,
          btnEditEl: null,
          btnDiffEl: null,
          // Monaco objects (optional; loaded lazily)
          monaco: null,
          monacoEditor: null,
          monacoDiffEditor: null,
          originalModel: null,
          modifiedModel: null,
          originalText: '',
          currentPath: '',
          viewOnly: true,
          // Edit mode is fullscreen: hides list + dir bar.
          editMode: false,
          showDiff: false,
          // Window mode: 'explorer' (default) or 'changes'
          mode: 'explorer',
          // Changes tab: 'current' | 'original' | 'diff'
          changesTab: 'current',
          changesTabsEl: null,
          btnTabCurrentEl: null,
          btnTabOriginalEl: null,
          btnTabDiffEl: null,
          pathInputEl: null,
          statusEl: null,
          isMinimized: false,
        },
      };

      const getToken = () => state.token || localStorage.getItem(options.tokenStorageKey) || '';
      const setToken = (t) => {
        state.token = String(t || '');
        localStorage.setItem(options.tokenStorageKey, state.token);
      };

      const getSelectedModel = () =>
        state.selectedModel ||
        localStorage.getItem(options.modelStorageKey) ||
        (state.models[0] ? state.models[0].name : '');

      const setSelectedModel = (m) => {
        state.selectedModel = String(m || '');
        localStorage.setItem(options.modelStorageKey, state.selectedModel);
        // Update send button icon/behavior for active pane.
        try {
          const p = getActivePane();
          updateActionButton(p);
          updateImageAttachControls(p);
        } catch {}
      };

      const getSelectedReasoningEffort = () =>
        state.selectedReasoningEffort !== null && state.selectedReasoningEffort !== undefined
          ? state.selectedReasoningEffort
          : localStorage.getItem(options.reasoningEffortStorageKey) || 'default';

      const setSelectedReasoningEffort = (e) => {
        const val = String(e || 'default');
        state.selectedReasoningEffort = val === 'default' ? null : val;
        localStorage.setItem(options.reasoningEffortStorageKey, val === 'default' ? '' : val);
      };

      const authHeaders = () => {
        const t = getToken();
        return t ? { Authorization: `Bearer ${t}` } : {};
      };

      const apiFetch = async (path, init) => {
        const url = (options.apiBase || '').replace(/\/+$/, '') + path;
        const headers = Object.assign({}, (init && init.headers) || {}, authHeaders());
        const res = await fetch(url, Object.assign({}, init || {}, { headers }));
        if (!res.ok) {
          // If auth is missing/invalid, prompt user to set token.
          if (res.status === 401) {
            try {
              if (!getToken()) {
                openConfigModal();
              }
            } catch {}
          }
          const text = await res.text().catch(() => '');
          const msg = text || `${res.status} ${res.statusText}`;
          throw new Error(msg);
        }
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await res.json();
        return await res.text();
      };

      const renderMarkdownViaServer = async (md) => {
        // Best-effort: server-side markdown-it for completeness.
        try {
          const html = await apiFetch('/markdown', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ markdown: String(md || '') }),
          });
          return String(html || '');
        } catch {
          return null;
        }
      };

      const renderMarkdownFallback = (md) => {
        // Minimal fallback: escaped <pre>. Server renderer provides full markdown.
        return `<pre class="ve-pre">${escapeHtml(md || '')}</pre>`;
      };

      const apiBaseUrl = () => (options.apiBase || '').replace(/\/+$/, '');
      const imageDataUrl = (chatId, imageId) => {
        const tok = encodeURIComponent(getToken() || '');
        return `${apiBaseUrl()}/chat/${encodeURIComponent(String(chatId))}/images/${encodeURIComponent(String(imageId))}/data?token=${tok}`;
      };

      // Parse current todos array from todo_write tool result.
      // Supports either a top-level `todos` array or the legacy `message` that includes
      // "Current todos:\n<json>".
      const parseTodoWriteTodosFromResult = (resultObj) => {
        try {
          if (!resultObj || typeof resultObj !== 'object') return [];
          if (Array.isArray(resultObj.todos)) return resultObj.todos;
          const msg = resultObj.message;
          if (typeof msg !== 'string') return [];
          const marker = 'Current todos:\n';
          const idx = msg.indexOf(marker);
          if (idx === -1) return [];
          const jsonText = msg.slice(idx + marker.length).trim();
          const arr = JSON.parse(jsonText);
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      };

      const shouldAutoScroll = (scroller) => {
        const remaining = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
        return remaining <= options.autoScrollThresholdPx;
      };

      const scrollToBottom = (scroller) => {
        scroller.scrollTop = scroller.scrollHeight;
      };

      const createLiveState = () => ({
        running: false,
        currentCycleId: null,
        cycles: new Map(),
        mdTimers: new Map(),
        pendingUserEcho: null,
      });

      // Clipboard helper: always write PNG for compatibility.
      const copyImageUrlToClipboardAsPng = async (src) => {
        if (!src) throw new Error('missing image url');
        if (!window.isSecureContext) throw new Error('secure context required');
        if (!(navigator.clipboard && window.ClipboardItem && typeof navigator.clipboard.write === 'function')) {
          throw new Error('clipboard image write not supported');
        }

        const res = await fetch(src, { credentials: 'same-origin' });
        const blob = await res.blob();

        const toPngBlob = async (inputBlob) => {
          if (typeof createImageBitmap === 'function') {
            const bmp = await createImageBitmap(inputBlob);
            const canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            return await new Promise((resolve, reject) => {
              canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png');
            });
          }
          const url = URL.createObjectURL(inputBlob);
          try {
            const img = await new Promise((resolve, reject) => {
              const el = new Image();
              el.onload = () => resolve(el);
              el.onerror = () => reject(new Error('image decode failed'));
              el.src = url;
            });
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            return await new Promise((resolve, reject) => {
              canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png');
            });
          } finally {
            try { URL.revokeObjectURL(url); } catch {}
          }
        };

        const outBlob = (String(blob.type || '').toLowerCase() === 'image/png') ? blob : await toPngBlob(blob);
        const item = new ClipboardItem({ 'image/png': outBlob });
        await navigator.clipboard.write([item]);
      };

      // Floating image preview modal (reused).
      const ensureImageModal = () => {
        const existing = root.querySelector('[data-ve-image-modal="1"]');
        if (existing) {
          const img = existing.querySelector('img');
          const download = existing.querySelector('a[data-ve-download="1"]');
          const copyBtn = existing.querySelector('button[data-ve-copy="1"]');
          const titleEl = existing.querySelector('[data-ve-title="1"]');

          const setTitleFlash = (text) => {
            if (!titleEl) return;
            const prev = titleEl.getAttribute('data-prev') || titleEl.textContent || '';
            titleEl.setAttribute('data-prev', prev);
            titleEl.textContent = text;
            setTimeout(() => {
              try { titleEl.textContent = titleEl.getAttribute('data-prev') || 'Image preview'; } catch {}
            }, 900);
          };

          const copyImageFromUrl = copyImageUrlToClipboardAsPng;

          if (copyBtn) {
            copyBtn.onclick = async () => {
              try {
                const src = img ? img.src : '';
                await copyImageFromUrl(src);
                setTitleFlash('Copied image');
              } catch (e) {
                const msg = String(e && e.message ? e.message : e).toLowerCase();
                if (msg.includes('secure context')) setTitleFlash('Copy image needs HTTPS');
                else if (msg.includes('not supported')) setTitleFlash('Copy image not supported');
                else setTitleFlash('Copy failed');
              }
            };
          }

          return {
            open: (src, filename) => {
              if (img) img.src = src;
              if (download) {
                download.href = src;
                download.setAttribute('download', filename || 'image');
              }
              if (titleEl) titleEl.textContent = filename ? `Image: ${filename}` : 'Image preview';
              existing.style.display = 'flex';
              existing.setAttribute('aria-hidden', 'false');
            },
            close: () => {
              existing.style.display = 'none';
              existing.setAttribute('aria-hidden', 'true');
              if (img) img.src = '';
            },
          };
        }

        const overlay = document.createElement('div');
        overlay.setAttribute('data-ve-image-modal', '1');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.style.cssText = [
          'position:fixed',
          'inset:0',
          'z-index:9999',
          'background:rgba(0,0,0,0.55)',
          'display:none',
          'align-items:center',
          'justify-content:center',
          'padding:24px',
        ].join(';');

        const panel = document.createElement('div');
        panel.style.cssText = [
          'background:#fff',
          'border-radius:14px',
          'box-shadow:0 18px 60px rgba(0,0,0,0.35)',
          'max-width:min(92vw, 980px)',
          'max-height:92vh',
          'width:auto',
          'overflow:hidden',
          'display:flex',
          'flex-direction:column',
        ].join(';');

        const bar = document.createElement('div');
        bar.style.cssText = [
          'display:flex',
          'align-items:center',
          'justify-content:space-between',
          'gap:12px',
          'padding:10px 12px',
          'border-bottom:1px solid rgba(17,24,39,0.10)',
          'background:#ffffff',
        ].join(';');

        const title = document.createElement('div');
        title.setAttribute('data-ve-title', '1');
        title.className = 've-muted';
        title.style.cssText = 'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        title.textContent = 'Image preview';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;align-items:center;';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.setAttribute('data-ve-copy', '1');
        copyBtn.textContent = 'Copy';
        copyBtn.style.cssText = [
          'display:inline-block',
          'padding:6px 10px',
          'border-radius:10px',
          'border:1px solid rgba(17,24,39,0.14)',
          'background:#fff',
          'cursor:pointer',
          'color:#111827',
          'font-size:12px',
        ].join(';');

        const download = document.createElement('a');
        download.setAttribute('data-ve-download', '1');
        download.href = '#';
        download.textContent = 'Download';
        download.style.cssText = [
          'display:inline-block',
          'padding:6px 10px',
          'border-radius:10px',
          'border:1px solid rgba(17,24,39,0.14)',
          'text-decoration:none',
          'color:#111827',
          'font-size:12px',
          'background:#fff',
        ].join(';');

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.style.cssText = [
          'width:32px',
          'height:32px',
          'border-radius:10px',
          'border:1px solid rgba(17,24,39,0.14)',
          'background:#fff',
          'cursor:pointer',
          'font-size:14px',
          'line-height:1',
        ].join(';');

        actions.appendChild(copyBtn);
        actions.appendChild(download);
        actions.appendChild(closeBtn);
        bar.appendChild(title);
        bar.appendChild(actions);

        const body = document.createElement('div');
        body.style.cssText = [
          'padding:12px',
          'background:#f9fafb',
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'max-height:calc(92vh - 54px)',
          'overflow:auto',
        ].join(';');

        const img = document.createElement('img');
        img.alt = 'Preview';
        img.style.cssText = [
          'max-width:100%',
          'max-height:calc(92vh - 86px)',
          'border-radius:12px',
          'border:1px solid rgba(17,24,39,0.12)',
          'background:#fff',
          'object-fit:contain',
        ].join(';');
        body.appendChild(img);

        panel.appendChild(bar);
        panel.appendChild(body);
        overlay.appendChild(panel);
        root.appendChild(overlay);

        const close = () => {
          overlay.style.display = 'none';
          overlay.setAttribute('aria-hidden', 'true');
          img.src = '';
        };

        const flashTitle = (text) => {
          const prev = title.getAttribute('data-prev') || title.textContent || '';
          title.setAttribute('data-prev', prev);
          title.textContent = text;
          setTimeout(() => {
            try { title.textContent = title.getAttribute('data-prev') || 'Image preview'; } catch {}
          }, 900);
        };

        const copyImageFromUrl = copyImageUrlToClipboardAsPng;

        copyBtn.addEventListener('click', async () => {
          try {
            await copyImageFromUrl(img.src);
            flashTitle('Copied image');
          } catch (e) {
            const msg = String(e && e.message ? e.message : e).toLowerCase();
            if (msg.includes('secure context')) flashTitle('Copy image needs HTTPS');
            else if (msg.includes('not supported')) flashTitle('Copy image not supported');
            else flashTitle('Copy failed');
          }
        });

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        closeBtn.addEventListener('click', close);
        window.addEventListener('keydown', (e) => {
          if (overlay.style.display !== 'none' && e.key === 'Escape') close();
        });

        return {
          open: (src, filename) => {
            img.src = src;
            download.href = src;
            download.setAttribute('download', filename || 'image');
            title.textContent = filename ? `Image: ${filename}` : 'Image preview';
            overlay.style.display = 'flex';
            overlay.setAttribute('aria-hidden', 'false');
          },
          close,
        };
      };

      const ensureThinkingNode = (pane) => {
        if (!pane) return null;
        if (pane.thinkingNode && pane.thinkingNode.parentNode) return pane.thinkingNode;
        const wrap = document.createElement('div');
        wrap.style.margin = '10px 0';
        const span = document.createElement('span');
        span.className = 've-muted';
        wrap.appendChild(span);
        pane.bodyEl.appendChild(wrap);
        pane.thinkingNode = wrap;
        // Always ensure thinking node is last in the body
        if (wrap.parentNode === pane.bodyEl && pane.bodyEl.lastChild !== wrap) {
          pane.bodyEl.appendChild(wrap);
        }
        return wrap;
      };

      const removeThinkingNode = (pane) => {
        if (!pane) return;
        if (pane.thinkingNode && pane.thinkingNode.parentNode) {
          pane.thinkingNode.parentNode.removeChild(pane.thinkingNode);
        }
        pane.thinkingNode = null;
      };

      const clearThinkingTimer = (pane) => {
        if (!pane) return;
        if (pane.thinkingTimerId !== null && pane.thinkingTimerId !== undefined) {
          clearInterval(pane.thinkingTimerId);
          pane.thinkingTimerId = null;
        }
      };

      const stopThinking = (pane) => {
        if (!pane) return;
        clearThinkingTimer(pane);
        removeThinkingNode(pane);
        pane.thinkingStartedAt = null;
      };

      const formatElapsed = (ms) => {
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        if (m <= 0) return `${totalSec} second${totalSec === 1 ? '' : 's'}`;
        return `${m} minute${m === 1 ? '' : 's'}${s ? ' ' + s + ` second${s === 1 ? '' : 's'}` : ''}`;
      };

      const startThinking = (pane) => {
        if (!pane) return;
        stopThinking(pane);
        pane.thinkingStartedAt = Date.now();
        const wrap = ensureThinkingNode(pane);
        const span = wrap.querySelector('span');
        const tick = () => {
          if (!pane.thinkingStartedAt) return;
          const elapsed = Date.now() - pane.thinkingStartedAt;
          if (span) span.textContent = `Thinking… ${formatElapsed(elapsed)}`;
        };
        tick();
        pane.thinkingTimerId = setInterval(tick, 1000);
        // Ensure the latest user message and Thinking… line are visible
        scrollToBottom(pane.bodyEl);
      };

      const styleId = 'viib-etch-ui-style';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
          .ve-root{height:100%;width:100%;display:flex;flex-direction:column;background:#ffffff;color:#111827;font:13px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"; }
          .ve-top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:10px 12px;background:#ffffff;border-bottom:1px solid rgba(17,24,39,0.10);}
          .ve-iconbtn{border:1px solid rgba(17,24,39,0.14);background:#f3f4f6;color:#111827;border-radius:3px;padding:6px 10px;cursor:pointer;font:inherit;}
          .ve-iconbtn:hover{background:#e5e7eb;}
          .ve-iconbtn.ve-config{border:none;background:transparent;padding:6px 8px;}
          .ve-iconbtn.ve-config:hover{background:rgba(17,24,39,0.05);}
          .ve-iconbtn.ve-folder{border:none;background:transparent;padding:6px 8px;}
          .ve-iconbtn.ve-folder:hover{background:rgba(17,24,39,0.05);}
          .ve-tabs{flex:1;display:flex;gap:6px;overflow:auto;scrollbar-width:none;}
          .ve-tabs::-webkit-scrollbar{display:none;}
          .ve-tab{flex:0 0 auto;max-width:220px;display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:3px;border:1px solid rgba(209,213,219,1);background:#f9fafb;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative;font-size:12px;line-height:1.3;}
          .ve-tab.ve-active{border-color:rgba(37,99,235,1);box-shadow:0 0 0 1px rgba(37,99,235,0.35);background:#e0ebff;}
          .ve-tab.ve-running{border-color:rgba(37,99,235,1);box-shadow:0 0 0 1px rgba(37,99,235,0.6);}
          .ve-tab.ve-unread{border-color:rgba(220,38,38,0.9);box-shadow:0 0 0 1px rgba(220,38,38,0.3);}
          .ve-tab .ve-tab-x{display:none;}
          .ve-tab small{opacity:0.7}
          .ve-body{flex:1;overflow:auto;padding:14px 12px 10px;scrollbar-gutter:stable;position:relative;}
          .ve-footer{position:sticky;bottom:0;z-index:5;border-top:1px solid rgba(17,24,39,0.10);background:#ffffff;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
          .ve-footer-row{display:flex;gap:10px;align-items:flex-end;}
          .ve-footer-row:first-child{flex:1;}
          .ve-footer-row.ve-footer-actions{flex:0 0 auto;justify-content:space-between;}
          .ve-footer-controls{display:flex;gap:10px;align-items:center;flex:1 1 0;min-width:0;}
          .ve-footer-controls label{white-space:nowrap;font-size:12px;opacity:0.75;flex-shrink:0;}
          .ve-footer-controls .ve-select{flex:0 1 auto;min-width:0;font-size:13px;max-width:200px;}
          .ve-attach-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:-2px;}
          .ve-attach-thumb{position:relative;display:inline-flex;}
          .ve-attach-thumb img{display:block;border-radius:10px;border:1px solid rgba(17,24,39,0.12);background:#fff;object-fit:contain;cursor:pointer;}
          .ve-attach-thumb button{position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:999px;border:1px solid rgba(17,24,39,0.14);background:#ffffff;color:#111827;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;padding:0;box-shadow:0 1px 2px rgba(0,0,0,0.10);}
          .ve-attach-thumb button:hover{background:#f3f4f6;}
          /* Use 16px font to avoid iOS Safari zooming input on focus */
          .ve-textarea{flex:1;min-height:42px;max-height:50vh;resize:none;background:#ffffff;border:1px solid rgba(17,24,39,0.14);color:#111827;border-radius:3px;padding:10px 10px;outline:none;font:16px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";overflow-y:auto;}
          .ve-select{background:#ffffff;border:1px solid rgba(17,24,39,0.14);color:#111827;border-radius:3px;padding:9px 10px;outline:none;font:16px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";}
          .ve-actions{display:flex;gap:8px;align-items:center;}
          .ve-btn{border:1px solid rgba(17,24,39,0.14);background:#f3f4f6;color:#111827;border-radius:3px;padding:9px 12px;cursor:pointer;min-width:92px;font:inherit;}
          .ve-btn.ve-primary{border-color:rgba(37,99,235,0.55);background:#eef2ff;}
          .ve-btn:disabled{opacity:0.55;cursor:not-allowed;}
          .ve-msg{margin:10px 0;display:flex;flex-direction:column;gap:6px;}
          .ve-bubble{border-radius:3px;padding:10px 12px;border:1px solid rgba(17,24,39,0.12);background:#ffffff;}
          .ve-user .ve-bubble{background:#f9fafb;border-color:rgba(17,24,39,0.14);}
          .ve-user .ve-bubble pre{margin:0;white-space:pre-wrap;word-break:break-word;font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";}
          .ve-assistant .ve-bubble{background:#ffffff;border-color:rgba(17,24,39,0.12);}
          /* Assistant message: single block, no extra background layer; collapses to a one-line preview */
          .ve-assistant-block{background:transparent;padding:0;line-height:1.4;position:relative;}
          .ve-assistant-block:hover{background:transparent;}
          .ve-toggle{
            position:absolute;
            top:4px;
            right:4px;
            min-width:20px;
            min-height:20px;
            display:flex;
            align-items:center;
            justify-content:center;
            border:none;
            background:rgba(243,244,246,0.8);
            color:#111827;
            cursor:pointer;
            font-size:11px;
            line-height:1;
            padding:0;
            border-radius:5px;
            z-index:2;
          }
          .ve-toggle:hover{background:rgba(229,231,235,0.8);}
          @media (hover:hover) and (pointer:fine){
            .ve-toggle{opacity:0;transition:opacity 120ms ease-in-out;}
            .ve-assistant-block:hover .ve-toggle,
            .ve-tool .ve-details:hover .ve-toggle{opacity:1;}
          }
          .ve-assistant-block-main{min-width:0;}
          /* Collapsed preview: single line */
          .ve-assistant-preview{display:none;position:relative;overflow:hidden;white-space:nowrap;padding-right:14px;}
          .ve-assistant-full{display:block;}
          .ve-assistant-block.collapsed .ve-assistant-full{display:none;}
          .ve-assistant-block.collapsed .ve-assistant-preview{display:block;}
          .ve-details{border:1px solid rgba(17,24,39,0.12);border-radius:3px;background:#ffffff;overflow:hidden;}
          .ve-details summary{list-style:none;cursor:default;padding:10px 12px;display:flex;align-items:center;gap:8px;color:#111827;background:#f9fafb;border-bottom:1px solid rgba(17,24,39,0.08);position:relative;}
          .ve-details summary::-webkit-details-marker{display:none;}
          .ve-details .ve-details-body{padding:10px 12px;}
          .ve-pre{margin:0;white-space:pre-wrap;word-break:break-word;}
          .ve-kv{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;opacity:0.8}
          .ve-muted{opacity:0.7}
          .ve-tool{margin-top:8px}
          .ve-tool .ve-details{border-color:rgba(17,24,39,0.14);background:#ffffff;}
          .ve-tool .ve-details summary{background:#f3f4f6;}
          /* Tool tabs: classic connected tabs + divider line to content */
          .ve-tool-tabs{display:flex;gap:0;margin:6px 0 0;border-bottom:1px solid rgba(17,24,39,0.14);}
          .ve-tool-tab{cursor:pointer;user-select:none;padding:6px 10px;border:1px solid rgba(17,24,39,0.14);border-bottom:none;background:#f9fafb;opacity:0.95;}
          .ve-tool-tab + .ve-tool-tab{margin-left:-1px;}
          .ve-tool-tab.ve-active{opacity:1;background:#ffffff;border-color:rgba(17,24,39,0.14);margin-bottom:-1px;}
          .ve-tool-tab.ve-active{border-bottom:1px solid #ffffff;}
          .ve-tool-tabs + [data-tabs-body]{border:1px solid rgba(17,24,39,0.14);border-top:none;padding:10px 12px;background:#ffffff;}
          .ve-jump{padding:6px 10px;border-radius:3px;border:1px solid rgba(17,24,39,0.14);background:#f3f4f6;cursor:pointer;opacity:0.95;font-size:16px;}
          .ve-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:50;font:13px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";}
          .ve-modal-backdrop *{font:inherit;}
          .ve-modal{width:min(720px,92vw);background:#ffffff;border:1px solid rgba(17,24,39,0.14);border-radius:3px;overflow:hidden;}
          .ve-modal header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(17,24,39,0.10);background:#f9fafb;}
          .ve-modal main{padding:12px;}
          .ve-field{display:flex;flex-direction:column;gap:6px;margin:10px 0;}
          .ve-field label{font-size:12px;opacity:0.75}
          .ve-input{background:#ffffff;border:1px solid rgba(17,24,39,0.14);color:#111827;border-radius:3px;padding:9px 10px;outline:none;font:16px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji";}
          /* Monaco: prevent iOS zoom on focus by ensuring input area is >=16px */
          .monaco-editor, .monaco-diff-editor{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;}
          .monaco-editor textarea.inputarea{font-size:16px !important; line-height:1.4 !important;}
        `;
        document.head.appendChild(style);
      }

      root.innerHTML = '';
      root.classList.add('ve-root');

      const top = document.createElement('div');
      top.className = 've-top';
      const btnConfig = document.createElement('button');
      btnConfig.className = 've-iconbtn ve-config';
      btnConfig.textContent = '⚙';
      const tabs = document.createElement('div');
      tabs.className = 've-tabs';
      const btnNew = document.createElement('button');
      btnNew.className = 've-iconbtn';
      btnNew.textContent = '+';
      top.appendChild(btnConfig);
      top.appendChild(tabs);
      top.appendChild(btnNew);
      root.appendChild(top);

      const isMobile = () =>
        typeof navigator !== 'undefined' &&
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');

      // Placeholder area before any chat pane is activated
      const placeholderBody = document.createElement('div');
      placeholderBody.className = 've-body';
      const placeholderFooter = document.createElement('div');
      placeholderFooter.className = 've-footer';
      placeholderFooter.style.display = 'none';
      root.appendChild(placeholderBody);
      root.appendChild(placeholderFooter);

      const detachBodyFooterIfPresent = (bodyEl, footerEl) => {
        try { if (bodyEl && bodyEl.parentNode === root) root.removeChild(bodyEl); } catch {}
        try { if (footerEl && footerEl.parentNode === root) root.removeChild(footerEl); } catch {}
      };

      const attachBodyFooter = (bodyEl, footerEl) => {
        // Always keep: top, then body, then footer
        // Remove any existing body/footer currently attached (but keep top)
        for (let i = root.childNodes.length - 1; i >= 0; i--) {
          const n = root.childNodes[i];
          if (n === top) continue;
          try { root.removeChild(n); } catch {}
        }
        root.appendChild(bodyEl);
        root.appendChild(footerEl);
      };

      const setActivePane = (pane) => {
        if (pane && pane.bodyEl && pane.footerEl) {
          attachBodyFooter(pane.bodyEl, pane.footerEl);
          return;
        }
        attachBodyFooter(placeholderBody, placeholderFooter);
      };

      // PaneCtx creator (lazy): each chat has its own body/footer, running state, live state, SSE handle
      const createPane = (chatId) => {
        const id = String(chatId);
        const bodyEl = document.createElement('div');
        bodyEl.className = 've-body';

        const footerEl = document.createElement('div');
        footerEl.className = 've-footer';

        const pane = {
          chatId: id,
          chat: null,
          loaded: false,
          bodyEl,
          footerEl,
          // footer controls:
          ta: null,
          modelSel: null,
          reasoningSel: null,
          btnFolder: null,
          btnAction: null,
          // image attachment controls (image-gen only):
          imageAttachIds: [],
          btnImgClip: null,
          btnImgUrl: null,
          btnImgClear: null,
          imgAttachBadge: null,
          imgAttachThumbs: null,
          // per-pane scroll/jump state:
          autoScrollArmed: true,
          jumpBtn: null,
          jumpBtnWrapper: null,
          // per-pane running + SSE:
          running: false,
          sse: null,
          // per-pane thinking:
          thinkingNode: null,
          thinkingTimerId: null,
          thinkingStartedAt: null,
          // per-pane live streaming state:
          live: createLiveState(),
        };

        const ensureJumpBtn = () => {
          if (pane.jumpBtn) return pane.jumpBtn;
          pane.jumpBtnWrapper = document.createElement('div');
          pane.jumpBtnWrapper.style.cssText = 'position:sticky;bottom:10px;display:flex;justify-content:flex-end;margin-top:10px;z-index:1;';
          pane.jumpBtn = document.createElement('button');
          pane.jumpBtn.className = 've-jump';
          pane.jumpBtn.textContent = '▼';
          pane.jumpBtn.style.cssText = 'position:static;margin:0;';
          pane.jumpBtn.addEventListener('click', () => scrollToBottom(pane.bodyEl));
          pane.jumpBtnWrapper.appendChild(pane.jumpBtn);
          pane.bodyEl.appendChild(pane.jumpBtnWrapper);
          return pane.jumpBtn;
        };

        const hideJumpBtn = () => {
          if (pane.jumpBtnWrapper && pane.jumpBtnWrapper.parentNode) {
            pane.jumpBtnWrapper.parentNode.removeChild(pane.jumpBtnWrapper);
          }
          pane.jumpBtn = null;
          pane.jumpBtnWrapper = null;
        };

        pane.ensureJumpBtn = ensureJumpBtn;
        pane.hideJumpBtn = hideJumpBtn;

        pane.bodyEl.addEventListener('scroll', () => {
          pane.autoScrollArmed = shouldAutoScroll(pane.bodyEl);
          if (pane.autoScrollArmed) hideJumpBtn();
          else ensureJumpBtn();
        });

        // Build footer controls (per pane)
        const row1 = document.createElement('div');
        row1.className = 've-footer-row';
        const ta = document.createElement('textarea');
        ta.className = 've-textarea';
        ta.placeholder = 'Message viib-etch…';
        row1.appendChild(ta);

        const row2 = document.createElement('div');
        row2.className = 've-footer-row ve-footer-actions';

        const controls = document.createElement('div');
        controls.className = 've-footer-controls';

        const modelLabel = document.createElement('label');
        modelLabel.textContent = 'Model';
        const modelSel = document.createElement('select');
        modelSel.className = 've-select';

        const reasoningLabel = document.createElement('label');
        reasoningLabel.textContent = 'Reasoning';
        const reasoningSel = document.createElement('select');
        reasoningSel.className = 've-select';

        const btnFolder = document.createElement('button');
        btnFolder.className = 've-iconbtn ve-folder';
        btnFolder.textContent = '📁';
        btnFolder.title = 'Set base directory for this chat';
        btnFolder.setAttribute('aria-label', 'Set base directory for this chat');

        const btnImgClip = document.createElement('button');
        btnImgClip.className = 've-iconbtn';
        btnImgClip.textContent = '📋';
        btnImgClip.title = 'Attach image from clipboard';
        btnImgClip.setAttribute('aria-label', 'Attach image from clipboard');

        const btnImgUrl = document.createElement('button');
        btnImgUrl.className = 've-iconbtn';
        btnImgUrl.textContent = '🔗';
        btnImgUrl.title = 'Attach image from URL';
        btnImgUrl.setAttribute('aria-label', 'Attach image from URL');

        const imgAttachBadge = document.createElement('span');
        imgAttachBadge.className = 've-muted';
        imgAttachBadge.style.cssText = 'font-size:12px;white-space:nowrap;';
        imgAttachBadge.textContent = '';

        const btnImgClear = document.createElement('button');
        btnImgClear.className = 've-iconbtn';
        btnImgClear.textContent = '✕';
        btnImgClear.title = 'Clear attached images';
        btnImgClear.setAttribute('aria-label', 'Clear attached images');

        controls.appendChild(modelLabel);
        controls.appendChild(modelSel);
        controls.appendChild(reasoningLabel);
        controls.appendChild(reasoningSel);
        controls.appendChild(btnFolder);
        controls.appendChild(btnImgClip);
        controls.appendChild(btnImgUrl);
        controls.appendChild(imgAttachBadge);
        controls.appendChild(btnImgClear);

        const actions = document.createElement('div');
        actions.className = 've-actions';
        const btnAction = document.createElement('button');
        btnAction.className = 've-btn ve-primary';
        btnAction.textContent = '▲';
        btnAction.title = 'Send';
        btnAction.setAttribute('aria-label', 'Send');
        btnAction.style.minWidth = '44px';
        actions.appendChild(btnAction);

        row2.appendChild(controls);
        row2.appendChild(actions);

        const imgAttachThumbs = document.createElement('div');
        imgAttachThumbs.className = 've-attach-thumbs';
        imgAttachThumbs.style.display = 'none';

        footerEl.appendChild(row1);
        footerEl.appendChild(imgAttachThumbs);
        footerEl.appendChild(row2);

        pane.ta = ta;
        pane.modelSel = modelSel;
        pane.reasoningSel = reasoningSel;
        pane.btnFolder = btnFolder;
        pane.btnAction = btnAction;
        pane.btnImgClip = btnImgClip;
        pane.btnImgUrl = btnImgUrl;
        pane.btnImgClear = btnImgClear;
        pane.imgAttachBadge = imgAttachBadge;
        pane.imgAttachThumbs = imgAttachThumbs;

        // Wire per-pane controls (handlers reference functions defined later; safe because they're invoked on user interaction).
        modelSel.addEventListener('change', () => setSelectedModel(modelSel.value));
        reasoningSel.addEventListener('change', () => setSelectedReasoningEffort(reasoningSel.value));
        btnFolder.addEventListener('click', () => openBaseDirModal(pane));
        btnImgClip.addEventListener('click', () => attachImageFromClipboard(pane));
        btnImgUrl.addEventListener('click', () => attachImageFromUrlPrompt(pane));
        btnImgClear.addEventListener('click', () => clearAttachedImages(pane));
        btnAction.addEventListener('click', () => {
          if (pane.running) cancelRun(pane);
          else sendMessage(pane);
        });

        ta.addEventListener('input', () => autoResizeTextarea(pane));
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            // On mobile (iOS/Android/etc.), never treat Enter as send; always insert newline.
            if (isMobile()) return;
            if (e.shiftKey || e.ctrlKey || e.metaKey) return; // allow newline
            // Desktop: Enter alone sends the message.
            e.preventDefault();
            if (!pane.running) sendMessage(pane);
          }
        });

        // Initial visibility
        try { updateImageAttachControls(pane); } catch {}
        return pane;
      };

      const getOrCreatePane = (chatId) => {
        const id = String(chatId);
        let p = state.panes.get(id);
        if (!p) {
          p = createPane(id);
          state.panes.set(id, p);
        }
        return p;
      };

      const toolUiKey = (toolCallId) => `tool:${String(toolCallId)}`;
      const reasoningKey = (idx) => `reasoning:${String(idx)}`;
      const responseKey = (idx) => `response:${String(idx)}`;

      const isCollapsedByUser = (key) => state.collapsedByUser.has(key);
      const setCollapsedByUser = (key, collapsed) => {
        if (collapsed) state.collapsedByUser.add(key);
        else state.collapsedByUser.delete(key);
      };

      const getOrInitChatStatus = (chatId) => {
        const id = String(chatId);
        let v = state.chatStatus.get(id);
        if (!v) {
          v = { running: false, unread: false };
          state.chatStatus.set(id, v);
        }
        return v;
      };

      const getOrInitChatMeta = (chat) => {
        if (!chat || !chat.id) return null;
        const id = String(chat.id);
        const modifiedMs = chat.modified ? new Date(chat.modified).getTime() : Date.now();
        let meta = state.chatMeta.get(id);
        if (!meta) {
          meta = { lastKnownModified: modifiedMs, lastSeenModified: modifiedMs };
          state.chatMeta.set(id, meta);
        } else if (!meta.lastKnownModified || modifiedMs > meta.lastKnownModified) {
          meta.lastKnownModified = modifiedMs;
        }
        return meta;
      };

      const renderTabs = () => {
        tabs.innerHTML = '';
        const runningEls = [];
        for (const c of state.chats) {
          getOrInitChatStatus(c.id);
          const st = state.chatStatus.get(String(c.id)) || { running: false, unread: false };
          const el = document.createElement('div');
          let cls = 've-tab';
          if (state.chatId === c.id) cls += ' ve-active';
          if (st.running) cls += ' ve-running';
          if (st.unread) cls += ' ve-unread';
          el.className = cls;
          const title = c.title || 'New Chat';
          el.innerHTML = `<span>${escapeHtml(title)}</span>`;
          el.addEventListener('click', (e) => {
            const id = String(c.id);
            if (!state.chat || state.chatId !== id) {
              openChatId(id).catch((err) => alert(String(err && err.message ? err.message : err)));
              return;
            }
            openChatTabMenu(e, c);
          });
          tabs.appendChild(el);
          if (st.running) runningEls.push(el);
        }
        if (runningEls.length && tabs.clientWidth && tabs.scrollWidth > tabs.clientWidth) {
          const first = runningEls[0];
          const last = runningEls[runningEls.length - 1];
          const leftEdge = first.offsetLeft;
          const rightEdge = last.offsetLeft + last.offsetWidth;
          const viewLeft = tabs.scrollLeft;
          const viewRight = viewLeft + tabs.clientWidth;
          if (leftEdge < viewLeft) tabs.scrollLeft = leftEdge;
          else if (rightEdge > viewRight) tabs.scrollLeft = rightEdge - tabs.clientWidth;
        }
      };

      const getActivePane = () => {
        const id = state.chatId ? String(state.chatId) : '';
        return id ? (state.panes.get(id) || null) : null;
      };

      const renderModels = (pane) => {
        const selEl = pane && pane.modelSel ? pane.modelSel : null;
        if (!selEl) return;
        selEl.innerHTML = '';
        for (const m of state.models) {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = m.name;
          selEl.appendChild(opt);
        }
        const sel = getSelectedModel();
        if (sel) selEl.value = sel;
        updateActionButton(pane);
      };

      const renderReasoningEffort = (pane) => {
        const selEl = pane && pane.reasoningSel ? pane.reasoningSel : null;
        if (!selEl) return;
        selEl.innerHTML = '';
        const options = [
          { value: 'default', label: 'Default' },
          { value: 'off', label: 'Off' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'minimal', label: 'Minimal' },
        ];
        for (const opt of options) {
          const el = document.createElement('option');
          el.value = opt.value;
          el.textContent = opt.label;
          selEl.appendChild(el);
        }
        const sel = getSelectedReasoningEffort();
        selEl.value = sel;
      };

      const setRunning = (pane, running) => {
        if (!pane) return;
        pane.running = !!running;
        updateActionButton(pane);
      };

      const resolveModelRec = (name) => {
        const n = String(name || '');
        return (state.models || []).find((m) => m && m.name === n) || { name: n, model: n };
      };

      const isImageGenModel = (model_name) => {
        const rec = resolveModelRec(model_name);
        const s = `${rec && rec.name ? rec.name : ''} ${rec && rec.model ? rec.model : ''}`.toLowerCase();
        return s.includes('image') || s.includes('gpt-image') || s.includes('dall-e') || s.includes('imagen');
      };

      const updateImageAttachControls = (pane) => {
        if (!pane) return;
        const isImg = isImageGenModel(getSelectedModel());
        const ids = Array.isArray(pane.imageAttachIds) ? pane.imageAttachIds : [];
        const show = !!isImg;
        const setDisp = (el, v) => { try { if (el) el.style.display = v ? '' : 'none'; } catch {} };
        setDisp(pane.btnImgClip, show);
        setDisp(pane.btnImgUrl, show);
        setDisp(pane.btnImgClear, show && ids.length > 0);
        if (pane.imgAttachBadge) {
          pane.imgAttachBadge.textContent = ids.length ? `${ids.length} img` : '';
          setDisp(pane.imgAttachBadge, show && ids.length > 0);
        }

        if (pane.imgAttachThumbs) {
          pane.imgAttachThumbs.innerHTML = '';
          if (show && ids.length > 0) {
            const thumbPx =
              typeof options.imageThumbPx === 'number' && options.imageThumbPx > 0
                ? Math.floor(options.imageThumbPx)
                : 64;
            const modal = ensureImageModal();
            for (const id of ids.map(String).filter(Boolean)) {
              const wrap = document.createElement('div');
              wrap.className = 've-attach-thumb';

              const img = document.createElement('img');
              img.src = imageDataUrl(pane.chatId, id);
              img.alt = id;
              img.loading = 'lazy';
              img.width = thumbPx;
              img.height = thumbPx;
              img.style.width = `${thumbPx}px`;
              img.style.height = `${thumbPx}px`;
              img.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                modal.open(img.src, id);
              });

              const btnRm = document.createElement('button');
              btnRm.type = 'button';
              btnRm.title = 'Remove image';
              btnRm.setAttribute('aria-label', 'Remove image');
              btnRm.textContent = '×';
              btnRm.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const cur = Array.isArray(pane.imageAttachIds) ? pane.imageAttachIds.map(String) : [];
                const next = [];
                let removed = false;
                for (const x of cur) {
                  if (!removed && x === id) {
                    removed = true;
                    continue;
                  }
                  next.push(x);
                }
                pane.imageAttachIds = next;
                updateImageAttachControls(pane);
              });

              wrap.appendChild(img);
              wrap.appendChild(btnRm);
              pane.imgAttachThumbs.appendChild(wrap);
            }
            setDisp(pane.imgAttachThumbs, true);
          } else {
            setDisp(pane.imgAttachThumbs, false);
          }
        }
      };

      const updateActionButton = (pane) => {
        if (!pane) return;
        const btn = pane.btnAction;
        if (!btn) return;
        if (pane.running) {
          btn.textContent = '■';
          btn.title = 'Stop';
          btn.setAttribute('aria-label', 'Stop');
          return;
        }
        const isImg = isImageGenModel(getSelectedModel());
        btn.textContent = isImg ? '🐵' : '▲';
        btn.title = isImg ? 'Generate image' : 'Send';
        btn.setAttribute('aria-label', isImg ? 'Generate image' : 'Send');
        updateImageAttachControls(pane);
      };

      const groupToolOutputsForReplay = (chat) => {
        const toolById = new Map(); // tool_call_id -> tool message
        for (const msg of chat.messages || []) {
          if (msg && msg.role === 'tool' && msg.tool_call_id) {
            toolById.set(String(msg.tool_call_id), msg);
          }
        }
        const assistantIdxToTools = new Map(); // idx -> [{ toolCall, toolMsg }]
        for (let i = 0; i < (chat.messages || []).length; i++) {
          const msg = chat.messages[i];
          if (!msg || msg.role !== 'assistant') continue;
          const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
          if (!tcs || tcs.length === 0) continue;
          const arr = [];
          for (const tc of tcs) {
            const id = tc && tc.id ? String(tc.id) : null;
            if (!id) continue;
            const tm = toolById.get(id) || null;
            arr.push({ toolCall: tc, toolMsg: tm });
          }
          assistantIdxToTools.set(i, arr);
        }
        return assistantIdxToTools;
      };

      const renderTool = async (chat, tc, toolMsg) => {
        const name = tc?.function?.name || toolMsg?.name || '(tool)';
        let argsText = tc?.function?.arguments || '';
        // toolMsg.content is JSON stringified result (without _diff/_patchCommand for apply_patch)
        const raw = toolMsg ? toolMsg.content : '';
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        // Helper: pretty JSON body
        const prettyJson = (obj) => `<pre class="ve-pre">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>`;

        const safeGet = (obj, path, fallback) => {
          try {
            return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj) ?? fallback;
          } catch {
            return fallback;
          }
        };
        // (parseTodoWriteTodosFromResult is defined at mount() scope)

        if (name === 'run_terminal_cmd') {
          const cmd = (parsed && parsed.command) || (typeof argsText === 'string' ? (() => {
            try { return JSON.parse(argsText).command; } catch { return null; }
          })() : null) || '';
          const out = parsed && (parsed.stdout || parsed.stderr) ? `${parsed.stdout || ''}${parsed.stderr ? (parsed.stdout ? '\n' : '') + parsed.stderr : ''}` : '';
          const title = `Ran`;
          const bodyHtml = `
            <div class="ve-kv"><span class="ve-muted">Command</span></div>
            <pre class="ve-pre">${escapeHtml(cmd)}</pre>
            <div class="ve-kv" style="margin-top:8px"><span class="ve-muted">Output</span></div>
            <pre class="ve-pre" style="max-height:24em;overflow:auto;">${escapeHtml(out || '')}</pre>
          `;
          return { title, bodyHtml };
        }

        if (name === 'rg') {
          let argsObj = null;
          try { argsObj = JSON.parse(argsText || '{}'); } catch { argsObj = null; }
          const pattern = argsObj && argsObj.pattern ? String(argsObj.pattern) : '';
          const path = argsObj && argsObj.path ? String(argsObj.path) : '';
          const headLimit = argsObj && typeof argsObj.head_limit === 'number' ? argsObj.head_limit : null;
          let matchCount = '';
          if (parsed && typeof parsed === 'object') {
            const c = safeGet(parsed, 'count', null);
            if (typeof c === 'number') matchCount = `${c} matches`;
          }
          const title = `Grep ${pattern || '(no pattern)'}${path ? ' ' + path : ''}${matchCount ? ' {' + matchCount + '}' : ''}`;
          const bodyHtml = `<pre class="ve-pre">${escapeHtml(raw || '')}</pre>`;
          return { title, bodyHtml };
        }

        if (name === 'list_dir') {
          let argsObj = null;
          try { argsObj = JSON.parse(argsText || '{}'); } catch { argsObj = null; }
          const dir = argsObj && (argsObj.target_directory || argsObj.directory) ? String(argsObj.target_directory || argsObj.directory) : '.';
          let count = '';
          if (Array.isArray(parsed)) count = parsed.length.toString();
          const title = `List directory ${dir}${count ? ' {' + count + ' entries}' : ''}`;
          const bodyHtml = parsed !== null && parsed !== undefined ? prettyJson(parsed) : `<pre class="ve-pre">${escapeHtml(raw || '')}</pre>`;
          return { title, bodyHtml };
        }

        if (name === 'glob_file_search') {
          let argsObj = null;
          try { argsObj = JSON.parse(argsText || '{}'); } catch { argsObj = null; }
          const pattern = argsObj && argsObj.glob_pattern ? String(argsObj.glob_pattern) : '';
          const dir = argsObj && argsObj.target_directory ? String(argsObj.target_directory) : '';
          let count = '';
          if (Array.isArray(parsed)) count = parsed.length.toString();
          const title = `File searching ${pattern || '(no pattern)'}${dir ? ' ' + dir : ''}${count ? ' {' + count + ' matches}' : ''}`;
          const bodyHtml = parsed !== null && parsed !== undefined ? prettyJson(parsed) : `<pre class="ve-pre">${escapeHtml(raw || '')}</pre>`;
          return { title, bodyHtml };
        }

        if (name === 'read_file') {
          let argsObj = null;
          try { argsObj = JSON.parse(argsText || '{}'); } catch { argsObj = null; }
          const target = argsObj && argsObj.target_file ? String(argsObj.target_file) : '';
          const base = target.split(/[\\/]/).filter(Boolean).pop() || target || '(file)';
          let content = '';
          if (typeof parsed === 'string') content = parsed; else content = raw || '';
          const lines = content ? content.split('\n').length : 0;
          const startLine = (typeof argsObj?.offset === 'number' && argsObj.offset > 0) ? argsObj.offset : 1;
          const endLine = lines ? startLine + lines - 1 : startLine;
          const title = `Read ${base} L${startLine}:${endLine}`;
          const bodyHtml = `<pre class="ve-pre">${escapeHtml(content)}</pre>`;
          return { title, bodyHtml };
        }

        if (name === 'delete_file') {
          let argsObj = null;
          try { argsObj = JSON.parse(argsText || '{}'); } catch { argsObj = null; }
          const target = argsObj && argsObj.target_file ? String(argsObj.target_file) : '';
          const ok = parsed && typeof parsed === 'object' && parsed.success === true;
          const title = `Delete ${target || '(file)'} ${ok ? 'success' : 'failed'}`;
          const bodyHtml = parsed !== null && parsed !== undefined ? prettyJson(parsed) : `<pre class="ve-pre">${escapeHtml(raw || '')}</pre>`;
          return { title, bodyHtml };
        }

        if (name === 'read_lints') {
          let argsObj = null;
          try { argsObj = JSON.parse(argsText || '{}'); } catch { argsObj = null; }
          const paths = Array.isArray(argsObj?.paths) ? argsObj.paths.join(', ') : (argsObj?.paths || '');
          const title = `Lint ${paths || '(all)'}`;
          const bodyHtml = parsed !== null && parsed !== undefined ? prettyJson(parsed) : `<pre class="ve-pre">${escapeHtml(raw || '')}</pre>`;
          return { title, bodyHtml };
        }

        if (name === 'apply_patch' || name === 'edit_file') {
          // Prefer stored diffs in chat.data.diffs[toolCallId]
          const tid = tc?.id ? String(tc.id) : (toolMsg?.tool_call_id ? String(toolMsg.tool_call_id) : null);
          const diffRec = (chat && chat.data && chat.data.diffs && tid) ? chat.data.diffs[tid] : null;
          const patchCommand = diffRec && diffRec.patchCommand ? diffRec.patchCommand : (parsed && parsed.patchCommand ? parsed.patchCommand : null);
          const diff = diffRec && diffRec.diff ? diffRec.diff : (parsed && parsed.diff ? parsed.diff : null);
          const tabId = `tab_${Math.random().toString(16).slice(2)}`;
          const cmdHtml = `<pre class="ve-pre">${escapeHtml(patchCommand || '')}</pre>`;
          const diffHtml = `<pre class="ve-pre">${escapeHtml(diff || raw || '')}</pre>`;
          // "Output" is the tool's returned content sent back to the LLM (toolMsg.content / raw).
          const outputHtml = `<pre class="ve-pre">${escapeHtml(raw || '')}</pre>`;
          // Tabs are wired after insertion (simple, minimal JS).
          const bodyHtml = `
            <div class="ve-tool-tabs" data-tabs="${tabId}">
              <div class="ve-tool-tab ve-active" data-tab="cmd">Command</div>
              <div class="ve-tool-tab" data-tab="diff">Diff</div>
              <div class="ve-tool-tab" data-tab="out">Output</div>
            </div>
            <div data-tabs-body="${tabId}">
              <div data-pane="cmd">${cmdHtml}</div>
              <div data-pane="diff" style="display:none">${diffHtml}</div>
              <div data-pane="out" style="display:none">${outputHtml}</div>
            </div>
          `;

          // Try to extract file names from diff text for the title.
          let files = [];
          const diffText = diff || '';
          diffText.split('\n').forEach((line) => {
            // Unified diff lines like "*** Update File: path" or "*** Add File: path"
            const m = line.match(/\*\*\* (?:Update|Add) File: (.+)$/);
            if (m && m[1]) files.push(m[1].trim());
          });
          if (!files.length && patchCommand) {
            // Fallback: look for "File: path" patterns in patchCommand
            patchCommand.split('\n').forEach((line) => {
              const m = line.match(/File:\s+(.+)$/);
              if (m && m[1]) files.push(m[1].trim());
            });
          }
          // Keep title simple per requirements.
          const title = name === 'apply_patch' ? 'Apply patch' : 'Edit file';
          return { title, bodyHtml };
        }

        if (name === 'todo_write') {
          let argsObj = null;
          try { argsObj = JSON.parse(argsText || '{}'); } catch { argsObj = null; }
          const resultObj = parsed;
          const todosFromResult = parseTodoWriteTodosFromResult(resultObj);
          const count = todosFromResult.length;
          const tabId = `tab_${Math.random().toString(16).slice(2)}`;

          const todosRows = todosFromResult
            .map((t) => {
              const status = escapeHtml((t && t.status) || '');
              const id = escapeHtml((t && t.id) || '');
              const content = escapeHtml((t && t.content) || '');
              return `<tr>
                <td style="padding:6px 8px;border-top:1px solid rgba(17,24,39,0.08);white-space:nowrap;">${status}</td>
                <td style="padding:6px 8px;border-top:1px solid rgba(17,24,39,0.08);white-space:nowrap;">${id}</td>
                <td style="padding:6px 8px;border-top:1px solid rgba(17,24,39,0.08);">${content}</td>
              </tr>`;
            })
            .join('');

          const todosTable = `
            <div style="overflow:auto;">
              <table style="width:auto;border-collapse:collapse;display:inline-table;">
                <thead>
                  <tr>
                    <th style="text-align:left;padding:6px 8px;border-bottom:1px solid rgba(17,24,39,0.12);font-weight:600;">status</th>
                    <th style="text-align:left;padding:6px 8px;border-bottom:1px solid rgba(17,24,39,0.12);font-weight:600;">id</th>
                    <th style="text-align:left;padding:6px 8px;border-bottom:1px solid rgba(17,24,39,0.12);font-weight:600;">content</th>
                  </tr>
                </thead>
                <tbody>
                  ${todosRows || `<tr><td colspan="3" style="padding:8px 8px;border-top:1px solid rgba(17,24,39,0.08);opacity:0.7;">(no todos)</td></tr>`}
                </tbody>
              </table>
            </div>
          `;

          const argsHtml = argsObj ? prettyJson(argsObj) : `<pre class="ve-pre">${escapeHtml(argsText || '')}</pre>`;
          const resultHtml =
            resultObj !== null && resultObj !== undefined
              ? (typeof resultObj === 'object' ? prettyJson(resultObj) : `<pre class="ve-pre">${escapeHtml(String(resultObj))}</pre>`)
              : `<pre class="ve-pre">${escapeHtml(raw || '')}</pre>`;

          const bodyHtml = `
            <div class="ve-tool-tabs" data-tabs="${tabId}">
              <div class="ve-tool-tab ve-active" data-tab="todos">Todos</div>
              <div class="ve-tool-tab" data-tab="args">Args</div>
              <div class="ve-tool-tab" data-tab="result">Result</div>
            </div>
            <div data-tabs-body="${tabId}">
              <div data-pane="todos">${todosTable}</div>
              <div data-pane="args" style="display:none">${argsHtml}</div>
              <div data-pane="result" style="display:none">${resultHtml}</div>
            </div>
          `;
          const title = `Todo write {${count} todos}`;
          return { title, bodyHtml };
        }

        // Default: show args + raw content
        let argsPretty = null;
        try { argsPretty = JSON.parse(argsText || '{}'); } catch { argsPretty = null; }
        const title = name || '(tool)';
        const bodyHtml = `
          <div class="ve-kv"><span class="ve-muted">Args</span></div>
          ${argsPretty ? prettyJson(argsPretty) : `<pre class="ve-pre">${escapeHtml(argsText || '')}</pre>`}
          <div class="ve-kv" style="margin-top:8px"><span class="ve-muted">Result</span></div>
          <pre class="ve-pre">${escapeHtml(raw || '')}</pre>
        `;
        return { title, bodyHtml };
      };

      const wireToolTabs = (scope) => {
        const tabsEls = scope.querySelectorAll('[data-tabs]');
        for (const el of tabsEls) {
          const tabId = el.getAttribute('data-tabs');
          const bodyEl = scope.querySelector(`[data-tabs-body="${tabId}"]`);
          if (!bodyEl) continue;
          const tabButtons = el.querySelectorAll('.ve-tool-tab');
          const setActive = (name) => {
            for (const b of tabButtons) {
              b.classList.toggle('ve-active', b.getAttribute('data-tab') === name);
            }
            for (const pane of bodyEl.querySelectorAll('[data-pane]')) {
              pane.style.display = pane.getAttribute('data-pane') === name ? '' : 'none';
            }
          };
          for (const b of tabButtons) {
            b.addEventListener('click', () => setActive(b.getAttribute('data-tab')));
          }
        }
      };

      const paneScopedKey = (pane, key) => {
        const id = pane && pane.chatId ? String(pane.chatId) : '';
        const k = String(key || '');
        return id ? `${id}:${k}` : k;
      };

      const renderChat = async (pane, chat, replayMode) => {
        const bodyEl = pane && pane.bodyEl ? pane.bodyEl : null;
        if (!bodyEl) return;
        bodyEl.innerHTML = '';
        if (pane && typeof pane.hideJumpBtn === 'function') pane.hideJumpBtn();

        if (!chat) {
          const empty = document.createElement('div');
          empty.className = 've-muted';
          empty.textContent = 'No chat selected.';
          bodyEl.appendChild(empty);
          return;
        }

        const assistantTools = groupToolOutputsForReplay(chat);

        const apiBaseUrl = (options.apiBase || '').replace(/\/+$/, '');
        const imageDataUrl = (chatId, imageId) => {
          const tok = encodeURIComponent(getToken() || '');
          return `${apiBaseUrl}/chat/${encodeURIComponent(String(chatId))}/images/${encodeURIComponent(String(imageId))}/data?token=${tok}`;
        };
        const renderImageThumbs = (parentEl, chatId, imageIds) => {
          const ids = Array.isArray(imageIds) ? imageIds.map(String).filter(Boolean) : [];
          if (ids.length === 0) return;
          const thumbPx = (typeof options.imageThumbPx === 'number' && options.imageThumbPx > 0)
            ? Math.floor(options.imageThumbPx)
            : 64;
          const modal = ensureImageModal();
          const grid = document.createElement('div');
          grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;';
          for (const id of ids) {
            const img = document.createElement('img');
            img.src = imageDataUrl(chatId, id);
            img.alt = id;
            img.loading = 'lazy';
            img.style.cssText = [
              `width:${thumbPx}px`,
              `height:${thumbPx}px`,
              'border-radius:10px',
              'border:1px solid rgba(17,24,39,0.12)',
              'background:#fff',
              'object-fit:contain',
              'cursor:pointer',
            ].join(';');
            img.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              modal.open(img.src, id);
            });
            grid.appendChild(img);
          }
          parentEl.appendChild(grid);
        };

        const messages = chat.messages || [];
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg || !msg.role) continue;

          if (msg.role === 'user') {
            const wrap = document.createElement('div');
            wrap.className = 've-msg ve-user';
            if (msg.content && typeof msg.content === 'object' && msg.content.type === 'image_prompt') {
              const p = msg.content.prompt ? String(msg.content.prompt) : '';
              const bubble = document.createElement('div');
              bubble.className = 've-bubble';
              bubble.innerHTML = `<pre>${escapeHtml(p || '(image prompt)')}</pre>`;
              renderImageThumbs(bubble, chat.id, msg.content.reference_images);
              wrap.appendChild(bubble);
            } else {
              wrap.innerHTML = `<div class="ve-bubble"><pre>${escapeHtml(msg.content || '')}</pre></div>`;
            }
            bodyEl.appendChild(wrap);
            continue;
          }

          if (msg.role === 'assistant') {
            // Skip assistant blocks that only have tool calls (no content, no reasoning)
            const hasContent =
              (typeof msg.content === 'string' && String(msg.content).trim()) ||
              (msg.content && typeof msg.content === 'object');
            const hasReasoning = msg.reasoning && String(msg.reasoning).trim();
            const toolArr = assistantTools.get(i) || [];
            const hasOnlyTools = !hasContent && !hasReasoning && toolArr.length > 0;
            
            if (hasOnlyTools) {
              continue; // Skip this assistant block for now
            }

            const wrap = document.createElement('div');
            wrap.className = 've-msg ve-assistant';

            const isImageBlock = msg.content && typeof msg.content === 'object' && msg.content.type === 'image';

            // Combined assistant block (response + reasoning in one) 
            const rk = paneScopedKey(pane, responseKey(i));
            const isCollapsed = isCollapsedByUser(rk);
            const block = document.createElement('div');
            block.className = 've-assistant-block' + (isCollapsed ? ' collapsed' : '');

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 've-toggle';
            toggle.setAttribute('aria-label', 'Toggle assistant message');
            toggle.textContent = isCollapsed ? '▶' : '▼';
            toggle.addEventListener('click', (e) => {
              e.stopPropagation();
              const collapsed = block.classList.toggle('collapsed');
              setCollapsedByUser(rk, collapsed);
              toggle.textContent = collapsed ? '▶' : '▼';
            });
            block.appendChild(toggle);
            const main = document.createElement('div');
            main.className = 've-assistant-block-main';

            const preview = document.createElement('div');
            preview.className = 've-assistant-preview';
            preview.textContent = isImageBlock
              ? firstLine((msg.content && msg.content.prompt) || '(image)') || '(image)'
              : (firstLine(msg.content || msg.reasoning || '(no content)') || '(no content)');
            main.appendChild(preview);

            const full = document.createElement('div');
            full.className = 've-assistant-full';

            
            const content = document.createElement('div');
            content.className = 've-assistant-block-content';
            
            // Response content
            if (msg.content) {
              const respDiv = document.createElement('div');
              if (isImageBlock) {
                respDiv.className = 've-image';
                const p = msg.content.prompt ? String(msg.content.prompt) : '';
                respDiv.innerHTML = `<pre style="margin:0 0 8px 0;">${escapeHtml(p || '(image)')}</pre>`;
                renderImageThumbs(respDiv, chat.id, msg.content.reference_images);
                renderImageThumbs(respDiv, chat.id, msg.content.images);
              } else {
                respDiv.className = 've-md';
                respDiv.setAttribute('data-md', 'response');
              }
              content.appendChild(respDiv);
            }
            
            // Reasoning content
            if (msg.reasoning) {
              if (msg.content) {
                const sep = document.createElement('div');
                sep.style.cssText = 'margin:8px 0;border-top:1px solid rgba(17,24,39,0.08);padding-top:8px;';
                content.appendChild(sep);
              }
              const reasonDiv = document.createElement('div');
              reasonDiv.className = 've-md';
              reasonDiv.setAttribute('data-md', 'reasoning');
              content.appendChild(reasonDiv);
            }

            full.appendChild(content);
            main.appendChild(full);
            block.appendChild(main);
            wrap.appendChild(block);

            // Tool calls + results (replay collapsed)
            if (toolArr.length > 0) {
              for (const t of toolArr) {
                const toolCall = t.toolCall;
                const toolMsg = t.toolMsg;
                const name = toolCall?.function?.name || toolMsg?.name || '(tool)';
                const tid = toolCall?.id ? String(toolCall.id) : '';
                const toolWrap = document.createElement('div');
                toolWrap.className = 've-tool';
                const det = document.createElement('details');
                det.className = 've-details';
                det.open = false;
                // Summary title should be correct immediately in replay (body stays lazy/collapsed).
                det.innerHTML = `
                  <summary>${escapeHtml(name)} <span class="ve-muted">${escapeHtml(tid)}</span></summary>
                  <div class="ve-details-body"><div class="ve-tool-body">Loading…</div></div>
                `;
                const summary = det.querySelector('summary');
                if (summary) {
                  const tri = document.createElement('button');
                  tri.type = 'button';
                  tri.className = 've-toggle';
                  tri.setAttribute('aria-label', 'Toggle tool details');
                  tri.textContent = det.open ? '▼' : '▶';
                  tri.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    det.open = !det.open;
                    tri.textContent = det.open ? '▼' : '▶';
                  });
                  summary.appendChild(tri);
                }
                toolWrap.appendChild(det);
                wrap.appendChild(toolWrap);

                // Lazy render body only when opened (replay)
                const fill = async () => {
                  const bodyEl = det.querySelector('.ve-tool-body');
                  const summaryEl = det.querySelector('summary');
                  if (!bodyEl || bodyEl.getAttribute('data-filled') === '1') return;
                  bodyEl.textContent = 'Rendering…';
                  try {
                    const { title, bodyHtml } = await renderTool(chat, toolCall, toolMsg);
                    if (summaryEl && title) summaryEl.textContent = title;
                    bodyEl.innerHTML = bodyHtml;
                    bodyEl.setAttribute('data-filled', '1');
                    wireToolTabs(bodyEl);
                  } catch (err) {
                    bodyEl.innerHTML = `<pre class="ve-pre">${escapeHtml(String(err && err.message ? err.message : err))}</pre>`;
                  }
                };

                // Eagerly compute and set the summary title for replay (no body render).
                (async () => {
                  try {
                    const summaryEl = det.querySelector('summary');
                    const { title } = await renderTool(chat, toolCall, toolMsg);
                    if (summaryEl && title) summaryEl.textContent = title;
                  } catch {}
                })();
                det.addEventListener('toggle', () => { if (det.open) fill(); });
              }
            }

            bodyEl.appendChild(wrap);

            // Render markdown (lazy-ish but minimal)
            const respMd = wrap.querySelector('[data-md="response"]');
            if (respMd && msg.content && typeof msg.content === 'string') {
              const html = (await renderMarkdownViaServer(msg.content)) || renderMarkdownFallback(msg.content);
              respMd.innerHTML = html;
            }
            const reasonMd = wrap.querySelector('[data-md="reasoning"]');
            if (reasonMd && msg.reasoning) {
              const html = (await renderMarkdownViaServer(msg.reasoning)) || renderMarkdownFallback(msg.reasoning);
              reasonMd.innerHTML = html;
            }
            continue;
          }
        }

        // replay: scroll to bottom
        scrollToBottom(bodyEl);
        if (pane) pane.autoScrollArmed = true;
      };

      // ----------------------------
      // Live incremental rendering
      // ----------------------------
      const liveEnsureAssistantCycle = (pane, cycleId) => {
        if (!pane || !pane.live) return null;
        const cid = String(cycleId || '');
        if (!cid) return null;
        let c = pane.live.cycles.get(cid);
        if (c) return c;

        // Create a new assistant block in the stream
        const wrap = document.createElement('div');
        wrap.className = 've-msg ve-assistant';

        const block = document.createElement('div');
        block.className = 've-assistant-block';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 've-toggle';
        toggle.setAttribute('aria-label', 'Toggle assistant message');
        toggle.textContent = '▼';
        block.appendChild(toggle);

        const main = document.createElement('div');
        main.className = 've-assistant-block-main';

        const preview = document.createElement('div');
        preview.className = 've-assistant-preview';
        preview.textContent = '(streaming…)';
        main.appendChild(preview);

        const full = document.createElement('div');
        full.className = 've-assistant-full';

        const content = document.createElement('div');
        content.className = 've-assistant-block-content';
        const respDiv = document.createElement('div');
        respDiv.className = 've-md';
        respDiv.setAttribute('data-md', 'response');
        content.appendChild(respDiv);

        full.appendChild(content);
        main.appendChild(full);
        block.appendChild(main);
        wrap.appendChild(block);

        const toolsWrapEl = document.createElement('div');
        wrap.appendChild(toolsWrapEl);

        pane.bodyEl.appendChild(wrap);

        const respMdEl = respDiv;

        c = {
          rootEl: wrap,
          respDetails: block,
          respHeader: null,
          respPreviewEl: preview,
          respMdEl,
          respText: '',
          reasonDetails: null,
          reasonMdEl: null,
          reasonText: '',
          toolsWrapEl,
          toolBlocks: new Map(),
          reasoningPinnedOpen: false,
        };

        // Track user collapse/expand for live blocks via triangle only
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasCollapsed = block.classList.contains('collapsed');
          const nowCollapsed = !wasCollapsed;
          if (nowCollapsed) block.classList.add('collapsed');
          else block.classList.remove('collapsed');
          toggle.textContent = nowCollapsed ? '▶' : '▼';
          if (pane.live.running && wasCollapsed) c.reasoningPinnedOpen = true;
        });
        pane.live.cycles.set(cid, c);
        return c;
      };

      const liveEnsureReasoningPanel = (pane, cycleId) => {
        const c = liveEnsureAssistantCycle(pane, cycleId);
        if (!c) return null;
        if (c.reasonDetails && c.reasonMdEl) return c;

        // Add reasoning to the same block content
        const content = c.respDetails.querySelector('.ve-assistant-block-content');
        if (content && !c.reasonMdEl) {
          const sep = document.createElement('div');
          sep.style.cssText = 'margin:8px 0;border-top:1px solid rgba(17,24,39,0.08);padding-top:8px;';
          const reasonDiv = document.createElement('div');
          reasonDiv.className = 've-md';
          reasonDiv.setAttribute('data-md', 'reasoning');
          content.appendChild(sep);
          content.appendChild(reasonDiv);
          c.reasonMdEl = reasonDiv;
          c.reasonDetails = c.respDetails; // Use same block
        }

        return c;
      };

      const liveAutoScrollIfArmed = (pane) => {
        if (!pane) return;
        if (pane.autoScrollArmed) {
          scrollToBottom(pane.bodyEl);
        } else {
          if (typeof pane.ensureJumpBtn === 'function') pane.ensureJumpBtn();
        }
      };

      const scheduleMarkdownRender = (pane, key, mdText, targetEl) => {
        if (!pane || !pane.live || !targetEl) return;
        // Throttle to avoid hammering server during streaming
        const k = String(key);
        const existing = pane.live.mdTimers.get(k);
        if (existing) return;
        const timer = setTimeout(async () => {
          pane.live.mdTimers.delete(k);
          const html = (await renderMarkdownViaServer(mdText)) || renderMarkdownFallback(mdText);
          targetEl.innerHTML = html;
          liveAutoScrollIfArmed(pane);
        }, 250);
        pane.live.mdTimers.set(k, timer);
      };

      const liveAppendUserMessage = (pane, content) => {
        if (!pane) return;
        const wrap = document.createElement('div');
        wrap.className = 've-msg ve-user';
        wrap.innerHTML = `<div class="ve-bubble"><pre>${escapeHtml(content || '')}</pre></div>`;
        pane.bodyEl.appendChild(wrap);
        liveAutoScrollIfArmed(pane);
        if (pane.running) {
          startThinking(pane);
        }
      };

      const liveEnsureToolBlock = (pane, cycleId, toolCallId, name, args) => {
        const c = liveEnsureAssistantCycle(pane, cycleId);
        if (!c) return null;
        const tid = String(toolCallId || '');
        if (!tid) return null;
        let tb = c.toolBlocks.get(tid);
        if (tb) return tb;

        const toolWrap = document.createElement('div');
        toolWrap.className = 've-tool';
        const det = document.createElement('details');
        det.className = 've-details';
        det.open = false; // collapsed by default in live view as well
        det.innerHTML = `
          <summary>${escapeHtml(name || '(tool)')} <span class="ve-muted">${escapeHtml(tid)}</span></summary>
          <div class="ve-details-body"><div class="ve-tool-body">Running…</div></div>
        `;
        const summary = det.querySelector('summary');
        let tri = null;
        if (summary) {
          tri = document.createElement('button');
          tri.type = 'button';
          tri.className = 've-toggle';
          tri.setAttribute('aria-label', 'Toggle tool details');
          tri.textContent = det.open ? '▼' : '▶';
          tri.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            det.open = !det.open;
            tri.textContent = det.open ? '▼' : '▶';
          });
          summary.appendChild(tri);
        }
        toolWrap.appendChild(det);
        c.toolsWrapEl.appendChild(toolWrap);

        const bodyEl = det.querySelector('.ve-tool-body');
        tb = {
          detailsEl: det,
          bodyEl,
          outText: '',
          running: true,
          openedByUser: true,
          name: name || '(tool)',
          args: args || null,
          result: null,
          cycleId: String(cycleId || ''),
          toolCallId: tid,
        };
        det.addEventListener('toggle', () => {
          tb.openedByUser = det.open;
          if (tri) tri.textContent = det.open ? '▼' : '▶';
        });
        c.toolBlocks.set(tid, tb);
        return tb;
      };

      const liveUpdateToolBlock = async (pane, tb) => {
        if (!tb || !tb.bodyEl) return;
        const name = tb.name;
        // Streaming terminal output
        if (name === 'run_terminal_cmd' && tb.outText) {
          const cmd = (() => {
            try { return tb.args && tb.args.command ? String(tb.args.command) : ''; } catch { return ''; }
          })();
          // While running: expand and show streaming output.
          if (tb.detailsEl) {
            tb.detailsEl.open = true;
            const sum = tb.detailsEl.querySelector('summary');
            if (sum) sum.textContent = 'Running';
            const tri = sum ? sum.querySelector('.ve-toggle') : null;
            if (tri) tri.textContent = tb.detailsEl.open ? '▼' : '▶';
          }
          tb.bodyEl.innerHTML = `
            <div class="ve-kv"><span class="ve-muted">Command</span></div>
            <pre class="ve-pre">${escapeHtml(cmd)}</pre>
            <div class="ve-kv" style="margin-top:8px"><span class="ve-muted">Output</span></div>
            <pre class="ve-pre" data-autoscroll="1" style="max-height:24em;overflow:auto;">${escapeHtml(tb.outText || '')}</pre>
          `;
          // Auto-scroll output to bottom while streaming
          try {
            const outEl = tb.bodyEl.querySelector('[data-autoscroll="1"]');
            if (outEl) outEl.scrollTop = outEl.scrollHeight;
          } catch {}
          liveAutoScrollIfArmed(pane);
          return;
        }

        // Final result -> reuse existing renderer by synthesizing toolMsg
        if (tb.result !== null && tb.result !== undefined) {
          const fakeTc = {
            id: tb.toolCallId,
            function: {
              name: tb.name,
              arguments: JSON.stringify(tb.args || {}),
            },
          };
          const fakeToolMsg = {
            role: 'tool',
            tool_call_id: tb.toolCallId,
            name: tb.name,
            content: typeof tb.result === 'string' ? tb.result : JSON.stringify(tb.result),
          };
          const { title, bodyHtml } = await renderTool((pane && pane.chat) ? pane.chat : (state.chat || { data: {} }), fakeTc, fakeToolMsg);
          if (tb.detailsEl && title) {
            const summaryEl = tb.detailsEl.querySelector('summary');
            if (summaryEl) {
              summaryEl.textContent = title;
              const tri = summaryEl.querySelector('.ve-toggle');
              if (tri) tri.textContent = tb.detailsEl.open ? '▼' : '▶';
            }
          }
          tb.bodyEl.innerHTML = bodyHtml;
          wireToolTabs(tb.bodyEl);
          // For run_terminal_cmd: collapse after done (it auto-expanded while streaming).
          if (tb.detailsEl && tb.name === 'run_terminal_cmd') {
            tb.detailsEl.open = false;
            const sum = tb.detailsEl.querySelector('summary');
            const tri = sum ? sum.querySelector('.ve-toggle') : null;
            if (tri) tri.textContent = tb.detailsEl.open ? '▼' : '▶';
          }
          liveAutoScrollIfArmed(pane);
          return;
        }
      };

      const refreshChats = async () => {
        const sessions = await apiFetch('/chats');
        state.chats = sessions;
        for (const c of sessions) {
          const meta = getOrInitChatMeta(c);
          if (!meta) continue;
          const st = getOrInitChatStatus(c.id);
          const known = meta.lastKnownModified || 0;
          const seen = meta.lastSeenModified || 0;
          st.unread = known > seen && String(state.chatId) !== String(c.id);
        }
        renderTabs();
      };

      const deleteChatId = async (chatId) => {
        const id = String(chatId);
        await apiFetch(`/chat/${encodeURIComponent(id)}`, { method: 'DELETE' });
        // Clean up any cached pane/SSE for this chat
        try {
          const p = state.panes.get(id);
          if (p) closeSSE(p);
          state.panes.delete(id);
        } catch {}
        // If we deleted current chat, switch to next available
        const wasCurrent = state.chatId === id;
        await refreshChats();
        if (wasCurrent) {
          state.chatId = null;
          state.chat = null;
          if (state.chats.length > 0) await openChatId(state.chats[0].id);
          else {
            setActivePane(null);
            placeholderBody.innerHTML = `<div class="ve-muted">No chats.</div>`;
          }
        }
      };

      const FILE_EXPLORER_STORAGE_KEY = 'viib-etch.ui.fileExplorer';

      // Monaco (VS Code-like editor) is loaded lazily for the File Explorer editor.
      // If it can't be loaded (offline/no CDN), we fall back to a textarea.
      let _monacoPromise = null;
      const loadMonaco = async () => {
        if (typeof window !== 'undefined' && window.monaco && window.monaco.editor) {
          return window.monaco;
        }
        if (_monacoPromise) return await _monacoPromise;
        const base = String(options.monacoBaseUrl || '').replace(/\/+$/, '') || '';
        if (!base) throw new Error('Monaco base URL not configured');

        const loadScriptOnce = (src) => new Promise((resolve, reject) => {
          try {
            const existing = Array.from(document.querySelectorAll('script')).find((s) => s && s.src === src);
            if (existing) {
              existing.addEventListener('load', () => resolve());
              existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
              // If it's already loaded, resolve immediately.
              if ((existing.readyState && existing.readyState === 'complete') || existing.getAttribute('data-loaded') === '1') {
                resolve();
              }
              return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.addEventListener('load', () => { try { s.setAttribute('data-loaded', '1'); } catch {} resolve(); });
            s.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
            document.head.appendChild(s);
          } catch (e) {
            reject(e);
          }
        });

        _monacoPromise = (async () => {
          await loadScriptOnce(`${base}/loader.js`);
          if (!window.require || !window.require.config) throw new Error('Monaco loader did not initialize');
          window.require.config({ paths: { vs: base } });
          await new Promise((resolve, reject) => {
            try {
              window.require(['vs/editor/editor.main'], () => resolve(), (err) => reject(err || new Error('failed to load monaco')));
            } catch (e) {
              reject(e);
            }
          });
          if (!window.monaco || !window.monaco.editor) throw new Error('Monaco failed to load');
          return window.monaco;
        })();

        return await _monacoPromise;
      };

      const inferMonacoLanguage = (p) => {
        const s = String(p || '');
        const dot = s.lastIndexOf('.');
        const ext = dot !== -1 ? s.slice(dot + 1).toLowerCase() : '';
        if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
        if (ext === 'ts' || ext === 'tsx') return 'typescript';
        if (ext === 'json') return 'json';
        if (ext === 'md' || ext === 'markdown') return 'markdown';
        if (ext === 'py') return 'python';
        if (ext === 'css') return 'css';
        if (ext === 'html' || ext === 'htm') return 'html';
        if (ext === 'sh' || ext === 'bash') return 'shell';
        if (ext === 'yml' || ext === 'yaml') return 'yaml';
        if (ext === 'go') return 'go';
        if (ext === 'rs') return 'rust';
        if (ext === 'java') return 'java';
        if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'c' || ext === 'h' || ext === 'hpp') return 'cpp';
        return 'plaintext';
      };

      const layoutFileExplorerEditors = () => {
        const fe = state.fileExplorer;
        try { if (fe.monacoEditor) fe.monacoEditor.layout(); } catch {}
        try { if (fe.monacoDiffEditor) fe.monacoDiffEditor.layout(); } catch {}
      };

      const fileBaseName = (p) => {
        const s = String(p || '');
        const parts = s.split(/[\\/]/).filter(Boolean);
        return parts.length ? parts[parts.length - 1] : s;
      };

      const loadFileExplorerPrefs = () => {
        try {
          const raw = localStorage.getItem(FILE_EXPLORER_STORAGE_KEY);
          if (!raw) return {};
          const obj = JSON.parse(raw);
          return obj && typeof obj === 'object' ? obj : {};
        } catch {
          return {};
        }
      };

      const saveFileExplorerPrefs = (next) => {
        try {
          const cur = loadFileExplorerPrefs();
          const merged = Object.assign({}, cur, next || {});
          localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, JSON.stringify(merged));
        } catch {}
      };

      const ensureFileExplorerWindow = () => {
        const fe = state.fileExplorer;
        if (fe.windowEl && fe.windowEl.parentNode) return fe;

        const prefs = loadFileExplorerPrefs();

        const backdrop = document.createElement('div');
        backdrop.style.position = 'fixed';
        backdrop.style.inset = '0';
        backdrop.style.zIndex = '40';
        backdrop.style.pointerEvents = 'none';
        // Keep typography consistent with .ve-root (the window is attached to <body>, not inside root).
        backdrop.style.font = '13px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"';

        const win = document.createElement('div');
        win.setAttribute('data-ve-file-window', '1');
        win.style.position = 'absolute';
        win.style.background = '#ffffff';
        win.style.border = '1px solid rgba(17,24,39,0.14)';
        win.style.borderRadius = '3px';
        win.style.boxShadow = '0 16px 40px rgba(0,0,0,0.20)';
        win.style.display = 'flex';
        win.style.flexDirection = 'column';
        win.style.overflow = 'hidden';
        win.style.touchAction = 'none';
        win.style.font = 'inherit';

        const defaultWidth = Math.min(window.innerWidth * 0.8, 880);
        const defaultHeight = Math.min(window.innerHeight * 0.7, 520);
        const minWidth = Math.max(260, Math.min(window.innerWidth * 0.6, 420));
        const maxWidth = Math.min(window.innerWidth * 0.95, 960);
        const minHeight = Math.max(220, Math.min(window.innerHeight * 0.4, 320));
        const maxHeight = Math.min(window.innerHeight * 0.95, 720);

        const w = prefs.width && prefs.width > 0 ? Math.min(Math.max(prefs.width, minWidth), maxWidth) : defaultWidth;
        const h = prefs.height && prefs.height > 0 ? Math.min(Math.max(prefs.height, minHeight), maxHeight) : defaultHeight;
        const l = prefs.left && prefs.left >= 0 ? Math.min(prefs.left, window.innerWidth - w - 8) : Math.max(8, window.innerWidth - w - 24);
        const t = prefs.top && prefs.top >= 0 ? Math.min(prefs.top, window.innerHeight - h - 8) : Math.max(48, window.innerHeight - h - 24);

        win.style.width = `${w}px`;
        win.style.height = `${h}px`;
        win.style.left = `${l}px`;
        win.style.top = `${t}px`;

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.justifyContent = 'space-between';
        header.style.gap = '8px';
        header.style.padding = '8px 10px';
        header.style.borderBottom = '1px solid rgba(17,24,39,0.10)';
        header.style.background = '#f9fafb';
        header.style.cursor = 'move';

        const title = document.createElement('div');
        title.textContent = 'File Explorer';
        title.className = 've-muted';
        title.style.fontSize = '12px';
        title.style.flex = '1 1 auto';
        title.style.whiteSpace = 'nowrap';
        title.style.overflow = 'hidden';
        title.style.textOverflow = 'ellipsis';

        const headerActions = document.createElement('div');
        headerActions.style.display = 'flex';
        headerActions.style.gap = '6px';

        const btnMin = document.createElement('button');
        btnMin.type = 'button';
        btnMin.className = 've-iconbtn';
        btnMin.textContent = '▁';
        btnMin.title = 'Minimize';
        btnMin.style.minWidth = '22px';
        btnMin.style.padding = '4px 8px';
        btnMin.style.lineHeight = '1';

        const btnClose = document.createElement('button');
        btnClose.type = 'button';
        btnClose.className = 've-iconbtn';
        btnClose.textContent = '✕';
        btnClose.title = 'Close';
        btnClose.style.minWidth = '22px';
        btnClose.style.padding = '4px 8px';
        btnClose.style.lineHeight = '1';

        headerActions.appendChild(btnMin);
        headerActions.appendChild(btnClose);
        header.appendChild(title);
        header.appendChild(headerActions);

        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.alignItems = 'center';
        topRow.style.gap = '8px';
        topRow.style.padding = '6px 10px 6px 10px';
        topRow.style.borderBottom = '1px solid rgba(17,24,39,0.06)';
        topRow.style.background = '#ffffff';

        const pathLabel = document.createElement('span');
        pathLabel.textContent = 'Dir';
        pathLabel.className = 've-muted';
        pathLabel.style.fontSize = '12px';
        pathLabel.style.flexShrink = '0';

        const pathInput = document.createElement('input');
        pathInput.type = 'text';
        pathInput.className = 've-input';
        pathInput.style.flex = '1 1 auto';
        pathInput.style.minWidth = '0';
        pathInput.placeholder = 'Working directory';

        const status = document.createElement('div');
        status.className = 've-muted';
        status.style.fontSize = '11px';
        status.style.flexShrink = '0';
        status.style.whiteSpace = 'nowrap';
        status.textContent = '';

        topRow.appendChild(pathLabel);
        topRow.appendChild(pathInput);
        topRow.appendChild(status);

        const body = document.createElement('div');
        body.style.display = 'flex';
        body.style.flex = '1 1 auto';
        body.style.minHeight = '0';
        body.style.background = '#f9fafb';

        const sidebar = document.createElement('div');
        sidebar.style.flex = '0 0 auto';
        sidebar.style.width = isMobile() ? '40%' : '32%';
        sidebar.style.minWidth = '140px';
        sidebar.style.maxWidth = '420px';
        sidebar.style.borderRight = '1px solid rgba(17,24,39,0.06)';
        sidebar.style.background = '#ffffff';
        sidebar.style.display = 'flex';
        sidebar.style.flexDirection = 'column';

        const list = document.createElement('div');
        list.setAttribute('data-ve-file-list', '1');
        list.style.flex = '1 1 auto';
        list.style.minHeight = '0';
        list.style.overflow = 'auto';
        list.style.padding = '4px 0';
        // iOS: slightly smaller file list text.
        if (isMobile()) list.style.fontSize = '12px';

        sidebar.appendChild(list);

        const editorWrap = document.createElement('div');
        editorWrap.style.flex = '1 1 auto';
        editorWrap.style.minWidth = '0';
        editorWrap.style.display = 'flex';
        editorWrap.style.flexDirection = 'column';

        const editorToolbar = document.createElement('div');
        editorToolbar.style.display = 'flex';
        editorToolbar.style.alignItems = 'center';
        editorToolbar.style.gap = '8px';
        editorToolbar.style.padding = '6px 8px';
        editorToolbar.style.borderBottom = '1px solid rgba(17,24,39,0.06)';
        editorToolbar.style.background = '#ffffff';

        const btnEdit = document.createElement('button');
        btnEdit.type = 'button';
        btnEdit.className = 've-iconbtn';
        btnEdit.textContent = fe.viewOnly ? 'Edit' : 'View';
        btnEdit.title = 'Toggle view-only';
        btnEdit.style.minWidth = '52px';

        const btnSave = document.createElement('button');
        btnSave.type = 'button';
        btnSave.className = 've-iconbtn';
        btnSave.textContent = 'Save';
        btnSave.title = 'Save file';
        btnSave.style.minWidth = '52px';
        btnSave.style.display = 'none';

        const editorToolbarSpacer = document.createElement('div');
        editorToolbarSpacer.style.flex = '1 1 auto';

        const changesTabs = document.createElement('div');
        changesTabs.style.display = 'none';
        changesTabs.style.gap = '6px';
        changesTabs.style.alignItems = 'center';

        const mkTabBtn = (label) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 've-iconbtn';
          b.textContent = label;
          b.style.minWidth = '72px';
          b.style.padding = '6px 10px';
          return b;
        };
        const btnTabCurrent = mkTabBtn('Current');
        const btnTabOriginal = mkTabBtn('Original');
        const btnTabDiff = mkTabBtn('Diff');
        changesTabs.appendChild(btnTabCurrent);
        changesTabs.appendChild(btnTabOriginal);
        changesTabs.appendChild(btnTabDiff);

        editorToolbar.appendChild(btnEdit);
        editorToolbar.appendChild(btnSave);
        editorToolbar.appendChild(changesTabs);
        editorToolbar.appendChild(editorToolbarSpacer);

        const editorHost = document.createElement('div');
        editorHost.setAttribute('data-ve-editor-host', '1');
        editorHost.style.flex = '1 1 auto';
        editorHost.style.minHeight = '0';
        editorHost.style.margin = '8px 8px 10px 8px';
        editorHost.style.border = '1px solid rgba(17,24,39,0.14)';
        editorHost.style.borderRadius = '3px';
        editorHost.style.background = '#ffffff';
        editorHost.style.display = 'none'; // shown when Monaco is available

        const diffHost = document.createElement('div');
        diffHost.setAttribute('data-ve-diff-host', '1');
        diffHost.style.flex = '1 1 auto';
        diffHost.style.minHeight = '0';
        diffHost.style.margin = '8px 8px 10px 8px';
        diffHost.style.border = '1px solid rgba(17,24,39,0.14)';
        diffHost.style.borderRadius = '3px';
        diffHost.style.background = '#ffffff';
        diffHost.style.display = 'none';

        const editor = document.createElement('textarea');
        editor.className = 've-textarea';
        editor.style.flex = '1 1 auto';
        editor.style.margin = '8px 8px 10px 8px';
        editor.style.resize = 'none';
        editor.placeholder = 'Select a file to view/edit…';
        editor.readOnly = !!fe.viewOnly;
        // Make fallback textarea look like a code editor (also helps iOS if Monaco can't load).
        editor.style.fontFamily =
          'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace';
        // Use >=16px to avoid iOS Safari zooming on focus.
        editor.style.fontSize = '16px';

        const applyEditorLayoutState = () => {
          // View-only mode: show file list + dir bar (right-side panel editor).
          // Edit mode: editor occupies whole window (keep header).
          const isChanges = fe.mode === 'changes';
          const isEdit = !!fe.editMode;
          try { sidebar.style.display = (isEdit && !isChanges) ? 'none' : 'flex'; } catch {}
          try { topRow.style.display = (isChanges || isEdit) ? 'none' : 'flex'; } catch {}
          try {
            editorHost.style.margin = isEdit ? '0' : '8px 8px 10px 8px';
            diffHost.style.margin = isEdit ? '0' : '8px 8px 10px 8px';
            editor.style.margin = isEdit ? '0' : '8px 8px 10px 8px';
          } catch {}
          layoutFileExplorerEditors();
        };

        const applyEditorMode = () => {
          const isChanges = fe.mode === 'changes';
          // Update buttons
          btnEdit.textContent = fe.viewOnly ? 'Edit' : 'View';
          btnEdit.style.display = isChanges ? 'none' : 'inline-flex';
          btnSave.style.display = (!isChanges && fe.editMode) ? 'inline-flex' : 'none';
          btnSave.disabled = !fe.editMode || !fe.currentPath;
          changesTabs.style.display = isChanges ? 'flex' : 'none';

          // Textarea fallback
          try { editor.readOnly = !!fe.viewOnly; } catch {}

          const hasMonaco = !!(fe.monacoEditor && fe.monacoDiffEditor);
          if (!hasMonaco) {
            editor.style.display = 'block';
            editorHost.style.display = 'none';
            diffHost.style.display = 'none';
            applyEditorLayoutState();
            return;
          }

          editor.style.display = 'none';
          if (isChanges && fe.changesTab === 'diff') {
            editorHost.style.display = 'none';
            diffHost.style.display = 'block';
          } else {
            editorHost.style.display = 'block';
            diffHost.style.display = 'none';
          }
          applyEditorLayoutState();
          try {
            fe.monacoEditor.updateOptions({
              readOnly: !!fe.viewOnly,
              // Changes mode: always show line numbers (read-only viewer).
              lineNumbers: isChanges ? 'on' : (fe.viewOnly ? 'off' : 'on'),
            });
          } catch {}
          try {
            if (fe.monacoDiffEditor) {
              fe.monacoDiffEditor.updateOptions({ renderSideBySide: false });
            }
          } catch {}
          layoutFileExplorerEditors();
        };
        // Expose for file-load path (Monaco may become available after window creation).
        fe._applyEditorMode = applyEditorMode;

        btnEdit.addEventListener('click', () => {
          // Clicking Edit enters fullscreen edit mode. Clicking again returns to view-only right panel.
          fe.editMode = !fe.editMode;
          fe.viewOnly = !fe.editMode;
          try {
            if (fe.monacoEditor) fe.monacoEditor.updateOptions({ readOnly: !!fe.viewOnly, lineNumbers: fe.viewOnly ? 'off' : 'on' });
          } catch {}
          try {
            if (fe.monacoDiffEditor && typeof fe.monacoDiffEditor.getModifiedEditor === 'function') {
              fe.monacoDiffEditor.getModifiedEditor().updateOptions({ readOnly: !!fe.viewOnly });
            }
          } catch {}
          applyEditorMode();
        });

        btnSave.addEventListener('click', () => {
          const pane = getActivePane();
          if (!pane || !pane.chatId) return;
          if (!fe.currentPath) return;
          if (!fe.editMode) return;
          const getCurrentText = () => {
            try {
              if (fe.modifiedModel && typeof fe.modifiedModel.getValue === 'function') return fe.modifiedModel.getValue();
            } catch {}
            try { return fe.editorEl ? String(fe.editorEl.value || '') : ''; } catch {}
            return '';
          };
          const nextText = getCurrentText();
          apiFetch(`/chat/${encodeURIComponent(pane.chatId)}/file`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: fe.currentPath, content: nextText }),
          })
            .then(() => {
              // Reset baseline to saved content.
              fe.originalText = String(nextText || '');
              try {
                if (fe.originalModel) fe.originalModel.setValue(fe.originalText);
                if (fe.modifiedModel) fe.modifiedModel.setValue(fe.originalText);
              } catch {}
              updateFileExplorerStatus(`Saved ${fileBaseName(fe.currentPath)}`);
            })
            .catch((e) => updateFileExplorerStatus(String(e && e.message ? e.message : e)));
        });

        editorWrap.appendChild(editorToolbar);
        editorWrap.appendChild(editorHost);
        editorWrap.appendChild(diffHost);
        editorWrap.appendChild(editor);

        body.appendChild(sidebar);
        body.appendChild(editorWrap);

        win.appendChild(header);
        win.appendChild(topRow);
        win.appendChild(body);
        backdrop.appendChild(win);
        document.body.appendChild(backdrop);

        backdrop.style.pointerEvents = 'none';
        win.style.pointerEvents = 'auto';

        let isDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartLeft = 0;
        let dragStartTop = 0;

        const onPointerMove = (ev) => {
          if (!isDragging) return;
          ev.preventDefault();
          ev.stopPropagation();
          const dx = ev.clientX - dragStartX;
          const dy = ev.clientY - dragStartY;
          let nl = dragStartLeft + dx;
          let nt = dragStartTop + dy;
          nl = Math.min(Math.max(nl, 4), window.innerWidth - win.offsetWidth - 4);
          nt = Math.min(Math.max(nt, 4), window.innerHeight - win.offsetHeight - 4);
          win.style.left = `${nl}px`;
          win.style.top = `${nt}px`;
        };

        const onPointerUp = (ev) => {
          if (!isDragging) return;
          isDragging = false;
          document.removeEventListener('pointermove', onPointerMove);
          document.removeEventListener('pointerup', onPointerUp);
          try { header.releasePointerCapture(ev.pointerId); } catch {}
          saveFileExplorerPrefs({
            left: parseFloat(win.style.left || '0') || 0,
            top: parseFloat(win.style.top || '0') || 0,
          });
        };

        const onPointerDown = (ev) => {
          if (ev.button !== 0 && ev.pointerType !== 'touch') return;
          // Don't start dragging when clicking window controls (minimize/close).
          try {
            const tgt = ev.target;
            if (tgt && headerActions && headerActions.contains(tgt)) return;
          } catch {}
          ev.preventDefault();
          ev.stopPropagation();
          isDragging = true;
          dragStartX = ev.clientX;
          dragStartY = ev.clientY;
          dragStartLeft = win.offsetLeft;
          dragStartTop = win.offsetTop;
          try { header.setPointerCapture(ev.pointerId); } catch {}
          document.addEventListener('pointermove', onPointerMove);
          document.addEventListener('pointerup', onPointerUp);
        };

        header.addEventListener('pointerdown', onPointerDown);

        const resizeHandle = document.createElement('div');
        resizeHandle.style.position = 'absolute';
        resizeHandle.style.right = '0';
        resizeHandle.style.bottom = '0';
        resizeHandle.style.width = '16px';
        resizeHandle.style.height = '16px';
        resizeHandle.style.cursor = 'nwse-resize';
        resizeHandle.style.background = 'transparent';
        win.appendChild(resizeHandle);

        let isResizing = false;
        let resizeStartX = 0;
        let resizeStartY = 0;
        let resizeStartW = 0;
        let resizeStartH = 0;

        const onResizeMove = (ev) => {
          if (!isResizing) return;
          ev.preventDefault();
          ev.stopPropagation();
          const dx = ev.clientX - resizeStartX;
          const dy = ev.clientY - resizeStartY;
          let nw = resizeStartW + dx;
          let nh = resizeStartH + dy;
          const cw = window.innerWidth;
          const ch = window.innerHeight;
          const minW = Math.max(260, Math.min(cw * 0.6, 420));
          const maxW = Math.min(cw * 0.95, 960);
          const minH = Math.max(220, Math.min(ch * 0.4, 320));
          const maxH = Math.min(ch * 0.95, 720);
          nw = Math.min(Math.max(nw, minW), maxW);
          nh = Math.min(Math.max(nh, minH), maxH);
          win.style.width = `${nw}px`;
          win.style.height = `${nh}px`;
          layoutFileExplorerEditors();
        };

        const onResizeUp = (ev) => {
          if (!isResizing) return;
          isResizing = false;
          document.removeEventListener('pointermove', onResizeMove);
          document.removeEventListener('pointerup', onResizeUp);
          try { resizeHandle.releasePointerCapture(ev.pointerId); } catch {}
          saveFileExplorerPrefs({
            width: win.offsetWidth,
            height: win.offsetHeight,
          });
          layoutFileExplorerEditors();
        };

        const onResizeDown = (ev) => {
          if (ev.button !== 0 && ev.pointerType !== 'touch') return;
          ev.preventDefault();
          ev.stopPropagation();
          isResizing = true;
          resizeStartX = ev.clientX;
          resizeStartY = ev.clientY;
          resizeStartW = win.offsetWidth;
          resizeStartH = win.offsetHeight;
          try { resizeHandle.setPointerCapture(ev.pointerId); } catch {}
          document.addEventListener('pointermove', onResizeMove);
          document.addEventListener('pointerup', onResizeUp);
        };

        resizeHandle.addEventListener('pointerdown', onResizeDown);

        const applyMinimizedState = (min) => {
          fe.isMinimized = !!min;
          if (min) {
            body.style.display = 'none';
            topRow.style.display = 'none';
            win.style.height = '44px';
            btnMin.title = 'Restore';
          } else {
            body.style.display = 'flex';
            topRow.style.display = 'flex';
            win.style.height = `${h}px`;
            btnMin.title = 'Minimize';
          }
          saveFileExplorerPrefs({ minimized: !!min });
          if (!min) layoutFileExplorerEditors();
        };

        btnMin.addEventListener('click', () => {
          applyMinimizedState(!fe.isMinimized);
        });

        const closeWindow = () => {
          try {
            if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          } catch {}
          // Dispose Monaco objects/models (best-effort).
          try { if (fe.monacoEditor) fe.monacoEditor.dispose(); } catch {}
          try { if (fe.monacoDiffEditor) fe.monacoDiffEditor.dispose(); } catch {}
          try { if (fe.originalModel) fe.originalModel.dispose(); } catch {}
          try { if (fe.modifiedModel) fe.modifiedModel.dispose(); } catch {}
          fe.backdropEl = null;
          fe.windowEl = null;
          fe.headerEl = null;
          fe.titleEl = null;
          fe.topRowEl = null;
          fe.bodyEl = null;
          fe.sidebarEl = null;
          fe.editorEl = null;
          fe.editorHostEl = null;
          fe.diffHostEl = null;
          fe.toolbarEl = null;
          fe.btnEditEl = null;
          fe.btnDiffEl = null;
          fe.btnSaveEl = null;
          fe.mode = 'explorer';
          fe.changesTab = 'current';
          fe.changesTabsEl = null;
          fe.btnTabCurrentEl = null;
          fe.btnTabOriginalEl = null;
          fe.btnTabDiffEl = null;
          fe.monacoEditor = null;
          fe.monacoDiffEditor = null;
          fe.originalModel = null;
          fe.modifiedModel = null;
          fe.originalText = '';
          fe.currentPath = '';
          fe.editMode = false;
          fe._applyEditorMode = null;
          fe.pathInputEl = null;
          fe.statusEl = null;
        };

        btnClose.addEventListener('click', closeWindow);

        fe.backdropEl = backdrop;
        fe.windowEl = win;
        fe.headerEl = header;
        fe.titleEl = title;
        fe.topRowEl = topRow;
        fe.bodyEl = list;
        fe.sidebarEl = sidebar;
        fe.editorEl = editor;
        fe.editorHostEl = editorHost;
        fe.diffHostEl = diffHost;
        fe.toolbarEl = editorToolbar;
        fe.btnEditEl = btnEdit;
        fe.btnDiffEl = null;
        fe.btnSaveEl = btnSave;
        fe.changesTabsEl = changesTabs;
        fe.btnTabCurrentEl = btnTabCurrent;
        fe.btnTabOriginalEl = btnTabOriginal;
        fe.btnTabDiffEl = btnTabDiff;
        fe.pathInputEl = pathInput;
        fe.statusEl = status;

        if (prefs.directory) {
          pathInput.value = String(prefs.directory);
        }
        if (prefs.minimized) {
          applyMinimizedState(true);
        }

        return fe;
      };

      const updateFileExplorerStatus = (text) => {
        const fe = ensureFileExplorerWindow();
        if (fe.statusEl) fe.statusEl.textContent = text || '';
      };

      const setFileWindowMode = (mode) => {
        const fe = ensureFileExplorerWindow();
        fe.mode = mode === 'changes' ? 'changes' : 'explorer';
        fe.editMode = false;
        fe.viewOnly = true;
        fe.changesTab = 'current';
        try {
          if (fe.titleEl) fe.titleEl.textContent = fe.mode === 'changes' ? 'Changes' : 'File Explorer';
        } catch {}
        try {
          if (fe.topRowEl) fe.topRowEl.style.display = fe.mode === 'changes' ? 'none' : 'flex';
        } catch {}
        try {
          if (typeof fe._applyEditorMode === 'function') fe._applyEditorMode();
        } catch {}
      };

      const renderChangesList = (files, baseDir) => {
        const fe = ensureFileExplorerWindow();
        const list = fe.bodyEl;
        if (!list) return;
        list.innerHTML = '';

        const ul = document.createElement('div');
        ul.style.display = 'flex';
        ul.style.flexDirection = 'column';
        ul.style.padding = '0';
        ul.style.margin = '0';

        const makeRow = (label, onClick) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';
          row.style.padding = '4px 10px';
          row.style.border = 'none';
          row.style.background = 'transparent';
          row.style.textAlign = 'left';
          row.style.cursor = 'pointer';
          row.style.font = 'inherit';
          row.style.borderRadius = '0';
          row.addEventListener('mouseover', () => { row.style.background = '#f3f4f6'; });
          row.addEventListener('mouseout', () => { row.style.background = 'transparent'; });
          row.addEventListener('click', () => { if (onClick) onClick(); });

          const text = document.createElement('span');
          text.textContent = label;
          text.style.whiteSpace = 'nowrap';
          text.style.overflow = 'hidden';
          text.style.textOverflow = 'ellipsis';
          row.appendChild(text);
          ul.appendChild(row);
        };

        const arr = Array.isArray(files) ? files : [];
        for (const p of arr) {
          const rel = String(p || '').trim();
          if (!rel) continue;
          makeRow(rel, () => openChangeFile(rel, baseDir));
        }

        list.appendChild(ul);
      };

      const openChangesWindowForChat = async (chatId) => {
        const id = String(chatId || '');
        if (!id) return;
        setFileWindowMode('changes');
        const fe = ensureFileExplorerWindow();
        try {
          const res = await apiFetch(`/chat/${encodeURIComponent(id)}/changes`, { method: 'GET' });
          const base_dir = res && typeof res.base_dir === 'string' ? res.base_dir : '';
          const files = res && Array.isArray(res.files) ? res.files : [];
          renderChangesList(files, base_dir || '');
        } catch (e) {
          updateFileExplorerStatus(String(e && e.message ? e.message : e));
        }
      };

      const setChangesTabActive = (tab) => {
        const fe = ensureFileExplorerWindow();
        fe.changesTab = tab === 'original' ? 'original' : (tab === 'diff' ? 'diff' : 'current');
        const setBtn = (btn, active) => {
          if (!btn) return;
          btn.style.background = active ? '#e5e7eb' : '';
          btn.style.borderColor = active ? 'rgba(17,24,39,0.24)' : '';
        };
        setBtn(fe.btnTabCurrentEl, fe.changesTab === 'current');
        setBtn(fe.btnTabOriginalEl, fe.changesTab === 'original');
        setBtn(fe.btnTabDiffEl, fe.changesTab === 'diff');
        // Switch Monaco editor model based on active tab (changes mode only).
        if (fe.mode === 'changes' && fe.monacoEditor && fe.originalModel && fe.modifiedModel) {
          try {
            if (fe.changesTab === 'original') {
              fe.monacoEditor.setModel(fe.originalModel);
            } else {
              fe.monacoEditor.setModel(fe.modifiedModel);
            }
          } catch {}
        }
        try { if (typeof fe._applyEditorMode === 'function') fe._applyEditorMode(); } catch {}
      };

      const openChangeFile = async (relPath, baseDir) => {
        const pane = getActivePane();
        if (!pane || !pane.chatId) return;
        const fe = ensureFileExplorerWindow();
        fe.mode = 'changes';
        fe.viewOnly = true;
        fe.editMode = false;
        fe.currentPath = String(relPath || '');

        // Ensure tab buttons are wired once.
        if (fe.btnTabCurrentEl && !fe.btnTabCurrentEl.getAttribute('data-wired')) {
          fe.btnTabCurrentEl.setAttribute('data-wired', '1');
          fe.btnTabOriginalEl.setAttribute('data-wired', '1');
          fe.btnTabDiffEl.setAttribute('data-wired', '1');
          fe.btnTabCurrentEl.addEventListener('click', () => setChangesTabActive('current'));
          fe.btnTabOriginalEl.addEventListener('click', () => setChangesTabActive('original'));
          fe.btnTabDiffEl.addEventListener('click', () => setChangesTabActive('diff'));
        }
        setChangesTabActive(fe.changesTab || 'current');

        // Load both current and original.
        try {
          const [cur, orig] = await Promise.all([
            apiFetch(`/chat/${encodeURIComponent(pane.chatId)}/file?path=${encodeURIComponent(String(relPath || ''))}`, { method: 'GET' }),
            apiFetch(`/chat/${encodeURIComponent(pane.chatId)}/original?path=${encodeURIComponent(String(relPath || ''))}`, { method: 'GET' }),
          ]);
          const currentText = typeof cur === 'string' ? cur : (cur && cur.content) || '';
          const originalText = typeof orig === 'string' ? orig : (orig && orig.content) || '';

          fe.originalText = String(originalText || '');

          // Ensure Monaco loaded (fallback textarea if not).
          try {
            const monaco = fe.monaco || (await loadMonaco());
            fe.monaco = monaco;

            if (!fe.monacoEditor) {
              fe.monacoEditor = monaco.editor.create(fe.editorHostEl, {
                value: '',
                language: 'plaintext',
                theme: 'vs',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: false,
                readOnly: true,
                lineNumbers: 'on',
                wordWrap: 'on',
                fontSize: isMobile() ? 12 : 13,
                fontFamily:
                  'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
              });
            }
            if (!fe.monacoDiffEditor) {
              fe.monacoDiffEditor = monaco.editor.createDiffEditor(fe.diffHostEl, {
                theme: 'vs',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: false,
                readOnly: true,
                renderSideBySide: false,
              });
            }

            // Dispose prior models.
            try { if (fe.originalModel) fe.originalModel.dispose(); } catch {}
            try { if (fe.modifiedModel) fe.modifiedModel.dispose(); } catch {}
            fe.originalModel = null;
            fe.modifiedModel = null;

            const lang = inferMonacoLanguage(relPath);
            const uriBase = `inmemory://changes/${Date.now()}_${Math.random().toString(16).slice(2)}/${encodeURIComponent(relPath)}`;
            fe.originalModel = monaco.editor.createModel(String(originalText || ''), lang, monaco.Uri.parse(uriBase + '?o=1'));
            fe.modifiedModel = monaco.editor.createModel(String(currentText || ''), lang, monaco.Uri.parse(uriBase + '?c=1'));

            // Wire models depending on active tab.
            try {
              if (fe.changesTab === 'original') fe.monacoEditor.setModel(fe.originalModel);
              else fe.monacoEditor.setModel(fe.modifiedModel);
            } catch {}
            try { fe.monacoDiffEditor.setModel({ original: fe.originalModel, modified: fe.modifiedModel }); } catch {}
            try { fe.monacoDiffEditor.updateOptions({ renderSideBySide: false }); } catch {}

            if (typeof fe._applyEditorMode === 'function') fe._applyEditorMode();
            layoutFileExplorerEditors();
            updateFileExplorerStatus(fileBaseName(relPath));
          } catch {
            // Monaco unavailable -> fallback textarea (current only).
            if (fe.editorEl) fe.editorEl.value = String(currentText || '');
            updateFileExplorerStatus(fileBaseName(relPath));
          }
        } catch (e) {
          updateFileExplorerStatus(String(e && e.message ? e.message : e));
        }
      };

      const renderFileList = (entries, currentDir) => {
        const fe = ensureFileExplorerWindow();
        const list = fe.bodyEl;
        if (!list) return;
        list.innerHTML = '';
        const ul = document.createElement('div');
        ul.style.display = 'flex';
        ul.style.flexDirection = 'column';
        ul.style.padding = '0';
        ul.style.margin = '0';

        const makeRow = (label, meta, onClick) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.justifyContent = 'space-between';
          row.style.padding = '4px 10px';
          row.style.border = 'none';
          row.style.background = 'transparent';
          row.style.textAlign = 'left';
          row.style.cursor = 'pointer';
          row.style.font = 'inherit';
          row.style.borderRadius = '0';
          row.addEventListener('mouseover', () => { row.style.background = '#f3f4f6'; });
          row.addEventListener('mouseout', () => { row.style.background = 'transparent'; });
          row.addEventListener('click', () => { if (onClick) onClick(); });

          const left = document.createElement('div');
          left.style.display = 'flex';
          left.style.alignItems = 'center';
          left.style.gap = '6px';

          const icon = document.createElement('span');
          icon.textContent = meta && meta.icon ? meta.icon : '';
          icon.style.flexShrink = '0';

          const text = document.createElement('span');
          text.textContent = label;
          text.style.whiteSpace = 'nowrap';
          text.style.overflow = 'hidden';
          text.style.textOverflow = 'ellipsis';

          left.appendChild(icon);
          left.appendChild(text);

          const right = document.createElement('div');
          right.className = 've-muted';
          right.style.fontSize = '11px';
          right.textContent = meta && meta.suffix ? meta.suffix : '';

          row.appendChild(left);
          row.appendChild(right);
          ul.appendChild(row);
        };

        // Add a ".." row to go to the parent directory.
        const parentDirOf = (p) => {
          const raw = String(p || '').trim();
          if (!raw || raw === '.' || raw === '/' || raw === '\\') return null;
          const s = raw.replace(/[\\/]+$/, '');
          if (!s) return null;
          const lastSlash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
          if (lastSlash <= 0) return s.startsWith('/') ? '/' : '.';
          return s.slice(0, lastSlash);
        };
        const curDir = String(currentDir || (fe.pathInputEl && fe.pathInputEl.value) || '').trim();
        const parent = parentDirOf(curDir);
        if (parent && parent !== curDir) {
          makeRow('..', { icon: '⬆️', suffix: '' }, () => {
            const fe2 = ensureFileExplorerWindow();
            if (fe2.pathInputEl) fe2.pathInputEl.value = parent;
            saveFileExplorerPrefs({ directory: parent });
            openFileExplorerAtDir(parent);
          });
        }

        for (const ent of entries || []) {
          if (!ent || !ent.name) continue;
          const isDir = !!ent.isDirectory;
          const label = ent.name;
          const meta = { icon: isDir ? '📂' : '📄', suffix: ent.size != null ? String(ent.size) : '' };
          const fullPath = ent.path || label;
          makeRow(label, meta, () => {
            if (isDir) {
              const fe2 = ensureFileExplorerWindow();
              if (fe2.pathInputEl) {
                fe2.pathInputEl.value = fullPath;
              }
              saveFileExplorerPrefs({ directory: fullPath });
              openFileExplorerAtDir(fullPath);
            } else {
              openFileInEditor(fullPath);
            }
          });
        }

        list.appendChild(ul);
        updateFileExplorerStatus(entries && entries.length ? `${entries.length} entries` : 'Empty');
      };

      const openFileExplorerAtDir = async (dir) => {
        const pane = getActivePane();
        if (!pane || !pane.chatId) {
          alert('Open a chat first to use the file explorer.');
          return;
        }
        ensureFileExplorerWindow();
        const targetDir = String(dir || '').trim() || (pane.chat && pane.chat.base_dir) || '.';
        const args = { target_directory: targetDir, ignore_globs: [] };
        try {
          const res = await apiFetch(`/chat/${encodeURIComponent(pane.chatId)}/tool`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              tool_name: 'list_dir',
              arguments: args,
            }),
          });
          const raw = typeof res === 'string' ? res : (res && res.content) ? String(res.content) : '';
          const lines = String(raw || '').split('\n');
          const dirLine = (lines[0] || '').trim();
          const baseDir = dirLine.endsWith('/') ? dirLine.slice(0, -1) : (dirLine || targetDir);
          const joinPath = (base, name) => {
            const b = String(base || '');
            if (!b) return String(name || '');
            if (b.endsWith('/') || b.endsWith('\\')) return b + String(name || '');
            return b + '/' + String(name || '');
          };
          const entries = [];
          for (const line of lines.slice(1)) {
            const t = String(line || '').trim();
            if (!t.startsWith('- ')) continue;
            let name = t.slice(2).trim();
            if (!name) continue;
            const isDir = name.endsWith('/');
            if (isDir) name = name.slice(0, -1);
            const fullPath = joinPath(baseDir, name);
            entries.push({ name, isDirectory: isDir, path: fullPath });
          }
          renderFileList(entries, baseDir);
          // Normalize the input box to the resolved directory.
          try {
            const fe = ensureFileExplorerWindow();
            if (fe.pathInputEl) fe.pathInputEl.value = baseDir;
          } catch {}
          saveFileExplorerPrefs({ directory: baseDir });
        } catch (e) {
          updateFileExplorerStatus(String(e && e.message ? e.message : e));
        }
      };

      const openFileInEditor = async (pathStr) => {
        const pane = getActivePane();
        if (!pane || !pane.chatId) {
          alert('Open a chat first to edit files.');
          return;
        }
        const fe = ensureFileExplorerWindow();
        // Default on open: view-only editor on the right-side panel.
        fe.viewOnly = true;
        fe.editMode = false;
        if (fe.editorEl) {
          fe.editorEl.value = 'Loading…';
        }
        try {
          const res = await apiFetch(
            `/chat/${encodeURIComponent(pane.chatId)}/file?path=${encodeURIComponent(String(pathStr || ''))}`,
            { method: 'GET' },
          );
          const content = typeof res === 'string' ? res : (res && res.content) || '';
          fe.currentPath = String(pathStr || '');
          fe.originalText = String(content || '');

          // Always populate the textarea immediately (fallback + fast render).
          if (fe.editorEl) {
            fe.editorEl.value = fe.originalText;
          }

          // Try to upgrade to Monaco (syntax highlighting + diff) lazily.
          (async () => {
            try {
              const host = fe.editorHostEl;
              const diffHost = fe.diffHostEl;
              if (!host || !diffHost) return;

              const monaco = fe.monaco || (await loadMonaco());
              fe.monaco = monaco;

              if (!fe.monacoEditor) {
                fe.monacoEditor = monaco.editor.create(host, {
                  value: '',
                  language: 'plaintext',
                  theme: 'vs',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: false,
                  readOnly: !!fe.viewOnly,
                  lineNumbers: fe.viewOnly ? 'off' : 'on',
                  wordWrap: 'on',
                  // iOS: render smaller, keep inputarea at 16px via CSS to avoid zoom.
                  fontSize: isMobile() ? 12 : 13,
                  fontFamily:
                    'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
                });
              }
              if (!fe.monacoDiffEditor) {
                fe.monacoDiffEditor = monaco.editor.createDiffEditor(diffHost, {
                  theme: 'vs',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: false,
                  readOnly: !!fe.viewOnly,
                  renderSideBySide: true,
                });
                try {
                  const me = fe.monacoDiffEditor.getModifiedEditor();
                  me.updateOptions({ readOnly: !!fe.viewOnly });
                } catch {}
              }

              // Dispose prior models (avoid leaks).
              try { if (fe.originalModel) fe.originalModel.dispose(); } catch {}
              try { if (fe.modifiedModel) fe.modifiedModel.dispose(); } catch {}
              fe.originalModel = null;
              fe.modifiedModel = null;

              const lang = inferMonacoLanguage(fe.currentPath);
              const uriBase = `inmemory://model/${Date.now()}_${Math.random().toString(16).slice(2)}/${encodeURIComponent(fe.currentPath || 'file')}`;
              fe.originalModel = monaco.editor.createModel(fe.originalText, lang, monaco.Uri.parse(uriBase + '?o=1'));
              fe.modifiedModel = monaco.editor.createModel(fe.originalText, lang, monaco.Uri.parse(uriBase + '?m=1'));

              try { fe.monacoEditor.updateOptions({ readOnly: !!fe.viewOnly }); } catch {}
              try {
                if (fe.monacoDiffEditor && typeof fe.monacoDiffEditor.getModifiedEditor === 'function') {
                  fe.monacoDiffEditor.getModifiedEditor().updateOptions({ readOnly: !!fe.viewOnly });
                }
              } catch {}

              try { fe.monacoEditor.setModel(fe.modifiedModel); } catch {}
              try { fe.monacoDiffEditor.setModel({ original: fe.originalModel, modified: fe.modifiedModel }); } catch {}

              if (typeof fe._applyEditorMode === 'function') fe._applyEditorMode();
              layoutFileExplorerEditors();
            } catch {
              // If Monaco fails to load, keep textarea fallback.
            }
          })();

          updateFileExplorerStatus(fileBaseName(pathStr || ''));
        } catch (e) {
          if (fe.editorEl) fe.editorEl.value = '';
          updateFileExplorerStatus(String(e && e.message ? e.message : e));
        }
      };

      const openChatTabMenu = (evt, chatSummary) => {
        evt.preventDefault();
        const id = String(chatSummary.id);
        const existing = document.querySelector('[data-chat-menu="1"]');
        if (existing) existing.parentNode.removeChild(existing);
        const menu = document.createElement('div');
        menu.setAttribute('data-chat-menu', '1');
        menu.style.position = 'fixed';
        menu.style.zIndex = '10';
        menu.style.background = '#ffffff';
        menu.style.border = '1px solid rgba(17,24,39,0.14)';
        menu.style.borderRadius = '3px';
        menu.style.minWidth = '180px';
        menu.style.boxShadow = '0 4px 10px rgba(0,0,0,0.08)';
        menu.style.font = '13px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,"Apple Color Emoji","Segoe UI Emoji"';
        menu.style.padding = '4px 0';
        const rect = evt.currentTarget.getBoundingClientRect();
        const topPos = rect.bottom + 4;
        const leftPos = Math.min(rect.left, window.innerWidth - 190);
        menu.style.top = `${topPos}px`;
        menu.style.left = `${leftPos}px`;
        const makeItem = (label, onClick) => {
          const item = document.createElement('button');
          item.textContent = label;
          item.style.display = 'block';
          item.style.width = '100%';
          item.style.padding = '6px 12px';
          item.style.border = 'none';
          item.style.background = 'transparent';
          item.style.textAlign = 'left';
          item.style.font = 'inherit';
          item.style.cursor = 'pointer';
          item.style.color = '#111827';
          item.addEventListener('click', () => {
            if (onClick) onClick();
            if (menu.parentNode) menu.parentNode.removeChild(menu);
          });
          item.addEventListener('mouseover', () => { item.style.background = '#f3f4f6'; });
          item.addEventListener('mouseout', () => { item.style.background = 'transparent'; });
          return item;
        };
        menu.appendChild(makeItem('Explore…', () => {
          const pane = getActivePane();
          const fe = ensureFileExplorerWindow();
          const base = pane && pane.chat && pane.chat.base_dir ? String(pane.chat.base_dir) : '';
          if (fe.pathInputEl && base) fe.pathInputEl.value = base;
          openFileExplorerAtDir(base || '.');
        }));
        menu.appendChild(makeItem('Changes…', () => {
          openChangesWindowForChat(id);
        }));
        menu.appendChild(makeItem('Rename', () => {
          const currentTitle = chatSummary.title || 'New Chat';
          const next = prompt('New title', currentTitle);
          if (next === null) return;
          const body = { title: String(next || '').trim() || null };
          apiFetch(`/chat/${encodeURIComponent(id)}/title`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }).then(() => refreshChats()).catch((e) => alert(String(e && e.message ? e.message : e)));
        }));
        menu.appendChild(makeItem('Refresh', () => {
          // Always refresh chat sessions list; if this chat is active, also force reload it.
          refreshChats()
            .then(() => {
              if (state.chatId === id) return openChatId(id, { forceReload: true });
              return null;
            })
            .catch((e) => alert(String(e && e.message ? e.message : e)));
        }));
        menu.appendChild(makeItem('Set directory', () => {
          openChatId(id)
            .then(() => {
              const p = getActivePane();
              if (p) openBaseDirModal(p);
            })
            .catch((e) => alert(String(e && e.message ? e.message : e)));
        }));
        menu.appendChild(makeItem('Delete…', () => {
          if (!confirm('Delete this chat?')) return;
          deleteChatId(id).catch((e) => alert(String(e && e.message ? e.message : e)));
        }));
        document.body.appendChild(menu);
        const closeOnOutside = (e) => {
          if (!menu.contains(e.target)) {
            if (menu.parentNode) menu.parentNode.removeChild(menu);
            document.removeEventListener('mousedown', closeOnOutside);
            document.removeEventListener('touchstart', closeOnOutside);
          }
        };
        document.addEventListener('mousedown', closeOnOutside);
        document.addEventListener('touchstart', closeOnOutside);
      };

      const refreshModels = async () => {
        state.models = await apiFetch('/models');
        // Update selectors in any created panes (lazy panes will be updated when created/activated).
        for (const p of state.panes.values()) {
          renderModels(p);
        }
        const ap = getActivePane();
        if (ap) renderModels(ap);
      };

      const openChatId = async (chatId, opts) => {
        const id = String(chatId);
        const forceReload = !!(opts && opts.forceReload);
        if (!forceReload && state.chatId === id && getActivePane()) {
          // Already active; nothing to do.
          return;
        }

        const prev = getActivePane();
        if (prev && String(prev.chatId) !== id) {
          // Policy: keep SSE only for active or running panes.
          if (!(prev.running || (prev.live && prev.live.running))) closeSSE(prev);
          stopThinking(prev);
        }
        state.chatId = id;
        localStorage.setItem(options.chatStorageKey, state.chatId);
        renderTabs();

        const pane = getOrCreatePane(id);
        setActivePane(pane);
        renderModels(pane);
        renderReasoningEffort(pane);
        autoResizeTextarea(pane);

        if (!pane.loaded || forceReload) {
          pane.chat = await apiFetch(`/chat/${encodeURIComponent(id)}`);
          pane.loaded = true;
          pane.live = createLiveState();
          state.chat = pane.chat;
          await renderChat(pane, pane.chat, true);
        } else {
          state.chat = pane.chat || null;
          // Pane already has DOM content; just ensure we're scrolled to bottom.
          try { scrollToBottom(pane.bodyEl); } catch {}
        }

        ensureSSE(pane);
        const meta = state.chatMeta.get(id);
        if (meta && meta.lastKnownModified) meta.lastSeenModified = meta.lastKnownModified;
        const st = state.chatStatus.get(id);
        if (st) st.unread = false;
        renderTabs();
      };

      const createNewChat = async () => {
        // New chat should inherit model + base_dir from the currently selected chat, if any.
        const model_name = (state.chat && state.chat.model_name) ? String(state.chat.model_name) : getSelectedModel();
        const base_dir = (state.chat && state.chat.base_dir) ? String(state.chat.base_dir) : null;
        const res = await apiFetch('/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ model_name }, base_dir ? { base_dir } : {})),
        });
        await refreshChats();
        if (res && res.id) await openChatId(res.id);
      };
      const openBaseDirModal = (pane) => {
        if (!pane || !pane.chatId) {
          alert('No chat selected.');
          return;
        }
        const backdrop = document.createElement('div');
        backdrop.className = 've-modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 've-modal';
        modal.innerHTML = `
          <header>
            <div>Base Directory</div>
            <button class="ve-iconbtn" data-close="1">Close</button>
          </header>
          <main>
            <div class="ve-field">
              <label>Directory (optional)</label>
              <input class="ve-input" data-basedir="1" placeholder="e.g. /data/sjung/src/project" />
              <div class="ve-muted" style="font-size:12px">Used as the working directory for tool execution in this chat. Leave empty to unset.</div>
            </div>
          </main>
        `;
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        const baseDirInput = modal.querySelector('[data-basedir="1"]');
        if (baseDirInput) baseDirInput.value = (pane.chat && pane.chat.base_dir) ? String(pane.chat.base_dir) : '';

        const close = () => {
          try { document.body.removeChild(backdrop); } catch {}
        };

        const save = async () => {
          const val = baseDirInput ? String(baseDirInput.value || '').trim() : '';
          const payload = { base_dir: val ? val : null };
          await apiFetch(`/chat/${encodeURIComponent(pane.chatId)}/base_dir`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          // Refresh loaded chat (so base_dir is updated for New Chat inheritance)
          if (pane.loaded) {
            pane.chat = await apiFetch(`/chat/${encodeURIComponent(pane.chatId)}`);
            if (String(state.chatId || '') === String(pane.chatId || '')) {
              state.chat = pane.chat;
            }
          }
          close();
        };

        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) close();
        });
        modal.querySelector('[data-close="1"]').addEventListener('click', close);

        // Save on Enter, allow multiline not needed
        baseDirInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save().catch((err) => alert(String(err && err.message ? err.message : err)));
          }
        });
        // Add a save button-like behavior on blur? keep explicit: click outside just closes.
        const btnSave = document.createElement('button');
        btnSave.className = 've-btn ve-primary';
        btnSave.textContent = 'Save';
        btnSave.style.marginTop = '10px';
        btnSave.addEventListener('click', () => save().catch((err) => alert(String(err && err.message ? err.message : err))));
        modal.querySelector('main').appendChild(btnSave);
      };

      const closeSSE = (pane) => {
        if (!pane) return;
        if (pane.sse) {
          try { pane.sse.close(); } catch {}
          pane.sse = null;
        }
      };

      const ensureSSE = (pane) => {
        if (!pane || !pane.chatId) return;
        closeSSE(pane);
        const t = getToken();
        const url =
          (options.apiBase || '').replace(/\/+$/, '') +
          `/chat/${encodeURIComponent(pane.chatId)}/events` +
          (t ? `?token=${encodeURIComponent(t)}` : '');
        const ev = new EventSource(url);
        pane.sse = ev;
        ev.addEventListener('run.start', () => {
          pane.live.running = true;
          setRunning(pane, true);
          const id = String(pane.chatId || '');
          if (id) {
            const st = getOrInitChatStatus(id);
            st.running = true;
            renderTabs();
          }
        });
        ev.addEventListener('cycle.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            pane.live.currentCycleId = data.cycle_id || null;
            liveEnsureAssistantCycle(pane, pane.live.currentCycleId);
            liveAutoScrollIfArmed(pane);
          } catch {}
        });
        ev.addEventListener('chat.user', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const content = String(data.content || '');
            if (pane.live.pendingUserEcho && pane.live.pendingUserEcho === content) {
              pane.live.pendingUserEcho = null;
              return;
            }
            stopThinking(pane);
            liveAppendUserMessage(pane, content);
          } catch {}
        });
        ev.addEventListener('assistant.reasoning.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = liveEnsureReasoningPanel(pane, data.cycle_id || pane.live.currentCycleId);
            if (!c) return;
            if (c.respDetails) c.respDetails.classList.remove('collapsed');
            liveAutoScrollIfArmed(pane);
          } catch {}
        });
        ev.addEventListener('assistant.reasoning.delta', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking(pane);
            const c = liveEnsureReasoningPanel(pane, data.cycle_id || pane.live.currentCycleId);
            if (!c) return;
            c.reasonText += String(data.delta || '');
            if (c.respDetails) {
              c.respDetails.classList.remove('collapsed');
            }
            if (c.respPreviewEl) {
              c.respPreviewEl.textContent = firstLine(c.respText || c.reasonText || '…') || '…';
            }
            scheduleMarkdownRender(pane, `reason:${data.cycle_id}`, c.reasonText, c.reasonMdEl);
          } catch {}
        });
        ev.addEventListener('assistant.reasoning.done', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = pane.live.cycles.get(String(data.cycle_id || ''));
            if (!c) return;
            // render final markdown
            scheduleMarkdownRender(pane, `reason:${data.cycle_id}`, c.reasonText, c.reasonMdEl);
          } catch {}
        });
        ev.addEventListener('assistant.response.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = liveEnsureAssistantCycle(pane, data.cycle_id || pane.live.currentCycleId);
            if (!c) return;
            c.respDetails.classList.remove('collapsed');
            liveAutoScrollIfArmed(pane);
          } catch {}
        });
        ev.addEventListener('assistant.response.delta', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking(pane);
            const c = liveEnsureAssistantCycle(pane, data.cycle_id || pane.live.currentCycleId);
            if (!c) return;
            c.respText += String(data.delta || '');
            if (c.respPreviewEl) {
              c.respPreviewEl.textContent = firstLine(c.respText || c.reasonText || '(streaming…)') || '(streaming…)';
            }
            scheduleMarkdownRender(pane, `resp:${data.cycle_id}`, c.respText, c.respMdEl);
          } catch {}
        });
        ev.addEventListener('assistant.response.done', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = pane.live.cycles.get(String(data.cycle_id || ''));
            if (!c) return;
            scheduleMarkdownRender(pane, `resp:${data.cycle_id}`, c.respText, c.respMdEl);
          } catch {}
        });
        ev.addEventListener('tool.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking(pane);
            const tb = liveEnsureToolBlock(pane, data.cycle_id || pane.live.currentCycleId, data.id, data.name, data.args);
            if (!tb) return;
            tb.running = true;
            // Title will be set once result is available via renderTool; avoid temporary "Running" suffix.
            liveAutoScrollIfArmed(pane);
          } catch {}
        });
        ev.addEventListener('tool.data', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking(pane);
            const tb = liveEnsureToolBlock(pane, data.cycle_id || pane.live.currentCycleId, data.id, data.name, null);
            if (!tb) return;
            const d = data.data || {};
            if (d.phase === 'stream' && typeof d.data === 'string') {
              tb.outText += d.data;
              liveUpdateToolBlock(pane, tb).catch(() => {});
              return;
            }
            if (d.phase === 'result') {
              tb.result = d.result;
              liveUpdateToolBlock(pane, tb).catch(() => {});
              return;
            }
          } catch {}
        });
        ev.addEventListener('tool.end', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking(pane);
            const c = pane.live.cycles.get(String(data.cycle_id || '')) || null;
            const tb = c ? c.toolBlocks.get(String(data.id || '')) : null;
            if (!tb) return;
            tb.running = false;
            // If backend provided an enriched final result on tool.end, update and re-render.
            if (data && data.result !== undefined && data.result !== null) {
              tb.result = data.result;
              liveUpdateToolBlock(pane, tb).catch(() => {});
            }
            // For run_terminal_cmd, explicitly mark as Ran and collapse once done.
            if (tb.name === 'run_terminal_cmd' && tb.detailsEl) {
              const sum = tb.detailsEl.querySelector('summary');
              if (sum) sum.textContent = 'Ran';
              tb.detailsEl.open = false;
              const tri = sum ? sum.querySelector('.ve-toggle') : null;
              if (tri) tri.textContent = tb.detailsEl.open ? '▼' : '▶';
            } else {
              // Other tools: collapse once done unless user left it open intentionally
              if (!tb.openedByUser && tb.detailsEl) {
                tb.detailsEl.open = false;
                const sum = tb.detailsEl.querySelector('summary');
                const tri = sum ? sum.querySelector('.ve-toggle') : null;
                if (tri) tri.textContent = tb.detailsEl.open ? '▼' : '▶';
              }
            }
            liveAutoScrollIfArmed(pane);
          } catch {}
        });
        ev.addEventListener('run.done', async () => {
          pane.live.running = false;
          setRunning(pane, false);
          stopThinking(pane);
          const id = String(pane.chatId || '');
          if (id) {
            const st = getOrInitChatStatus(id);
            st.running = false;
          }
          refreshChats().catch(() => {});
          // If this pane is not active anymore, disconnect after run finishes (policy: active or running only)
          if (String(state.chatId || '') !== String(pane.chatId || '')) {
            closeSSE(pane);
          }
        });
        ev.addEventListener('run.error', (e) => {
          setRunning(pane, false);
          stopThinking(pane);
          console.error('run.error', e && e.data);
          const id = String(pane.chatId || '');
          if (id) {
            const st = getOrInitChatStatus(id);
            st.running = false;
            renderTabs();
          }
          if (String(state.chatId || '') !== String(pane.chatId || '')) {
            closeSSE(pane);
          }
        });

        // Non-streaming operations (image generation) request a full refresh.
        ev.addEventListener('chat.refresh', async () => {
          try {
            const chat = await apiFetch(`/chat/${encodeURIComponent(pane.chatId)}`);
            pane.chat = chat;
            state.chat = chat;
            pane.loaded = true;
            pane.live = createLiveState();
            await renderChat(pane, chat, true);
          } catch {}
        });
      };

      const sendMessage = async (pane) => {
        if (!pane || !pane.chatId || !pane.ta) return;
        const text = pane.ta.value;
        if (!String(text || '').trim()) return;
        const model_name = getSelectedModel();
        const reasoning_effort = getSelectedReasoningEffort();
        const imgMode = isImageGenModel(model_name);
        const params = imgMode ? { prompt: text, model_name } : { message: text, model_name };
        if (imgMode) {
          const ids = Array.isArray(pane.imageAttachIds) ? pane.imageAttachIds.map(String).filter(Boolean) : [];
          if (ids.length > 0) params.reference_image_ids = ids;
        }
        if (!imgMode && reasoning_effort && reasoning_effort !== 'default') params.reasoning_effort = reasoning_effort;
        setRunning(pane, true);
        ensureSSE(pane);
        pane.ta.value = '';
        autoResizeTextarea(pane);
        // Optimistically show the user message immediately during live.
        pane.live.pendingUserEcho = String(text);
        liveAppendUserMessage(pane, String(text));
        try {
          const endpoint = imgMode ? 'generate_image' : 'send';
          await apiFetch(`/chat/${encodeURIComponent(pane.chatId)}/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          });
          if (imgMode) {
            // Clear only after a successful request.
            pane.imageAttachIds = [];
            updateImageAttachControls(pane);
          }
        } catch (e) {
          setRunning(pane, false);
          alert(String(e && e.message ? e.message : e));
        }
      };

      const clearAttachedImages = (pane) => {
        if (!pane) return;
        pane.imageAttachIds = [];
        updateImageAttachControls(pane);
      };

      const fileReaderToDataUrl = (blob) => new Promise((resolve, reject) => {
        try {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error('failed to read image'));
          r.readAsDataURL(blob);
        } catch (e) {
          reject(e);
        }
      });

      const parseDataUrlToB64 = (dataUrl) => {
        const s = String(dataUrl || '');
        const m = s.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return null;
        return { mime_type: m[1], data_b64: m[2] };
      };

      const uploadImageDataToChat = async (chatId, mime_type, data_b64) => {
        const id = String(chatId || '');
        if (!id) throw new Error('no chat selected');
        const mt = typeof mime_type === 'string' && mime_type ? mime_type : 'application/octet-stream';
        const b64 = typeof data_b64 === 'string' && data_b64 ? data_b64 : '';
        if (!b64) throw new Error('missing image data');
        const resp = await apiFetch(`/chat/${encodeURIComponent(id)}/images`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mime_type: mt, data_b64: b64 }),
        });
        const image_id = resp && (resp.id || resp.image_id) ? String(resp.id || resp.image_id) : '';
        if (!image_id) throw new Error('image upload failed');
        return image_id;
      };

      const attachImageFromClipboard = async (pane) => {
        if (!pane || !pane.chatId) return;
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
            throw new Error('Clipboard image read not supported (needs HTTPS + permissions)');
          }
          const items = await navigator.clipboard.read();
          let blob = null;
          let mt = '';
          for (const it of items) {
            const types = Array.isArray(it.types) ? it.types : [];
            const best = types.find((t) => String(t || '').startsWith('image/')) || '';
            if (!best) continue;
            blob = await it.getType(best);
            mt = best;
            break;
          }
          if (!blob) throw new Error('No image found on clipboard');
          const dataUrl = await fileReaderToDataUrl(blob);
          const parsed = parseDataUrlToB64(dataUrl);
          if (!parsed || !parsed.data_b64) throw new Error('Failed to parse clipboard image');
          const imageId = await uploadImageDataToChat(pane.chatId, parsed.mime_type || mt || blob.type, parsed.data_b64);
          pane.imageAttachIds = Array.isArray(pane.imageAttachIds) ? pane.imageAttachIds : [];
          pane.imageAttachIds.push(imageId);
          updateImageAttachControls(pane);
        } catch (e) {
          alert(String(e && e.message ? e.message : e));
        }
      };

      const attachImageFromUrlPrompt = async (pane) => {
        if (!pane || !pane.chatId) return;
        try {
          const u = window.prompt('Image URL to attach');
          const urlStr = String(u || '').trim();
          if (!urlStr) return;
          const resp = await apiFetch(`/chat/${encodeURIComponent(String(pane.chatId))}/images/from_url`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: urlStr }),
          });
          const imageId = resp && (resp.id || resp.image_id) ? String(resp.id || resp.image_id) : '';
          if (!imageId) throw new Error('image fetch failed');
          pane.imageAttachIds = Array.isArray(pane.imageAttachIds) ? pane.imageAttachIds : [];
          pane.imageAttachIds.push(imageId);
          updateImageAttachControls(pane);
        } catch (e) {
          alert(String(e && e.message ? e.message : e));
        }
      };

      const cancelRun = async (pane) => {
        if (!pane || !pane.chatId) return;
        try {
          await apiFetch(`/chat/${encodeURIComponent(pane.chatId)}/cancel`, {
            method: 'POST',
          });
        } catch (e) {
          alert(String(e && e.message ? e.message : e));
        }
      };

      const openConfigModal = () => {
        const backdrop = document.createElement('div');
        backdrop.className = 've-modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 've-modal';
        modal.innerHTML = `
          <header>
            <div>Settings</div>
            <button class="ve-iconbtn" data-close="1">Close</button>
          </header>
          <main>
            <div class="ve-field">
              <label>Token (Authorization: Bearer …)</label>
              <input class="ve-input" data-token="1" placeholder="token" />
            </div>
            <div class="ve-field">
              <label>API Base</label>
              <input class="ve-input" data-apibase="1" placeholder="/api" />
              <div class="ve-muted" style="font-size:12px">If you mount under a prefix, set this accordingly (e.g. /my/api).</div>
            </div>
          </main>
        `;
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        const tokenInput = modal.querySelector('[data-token="1"]');
        const apiBaseInput = modal.querySelector('[data-apibase="1"]');
        if (tokenInput) tokenInput.value = getToken();
        if (apiBaseInput) apiBaseInput.value = options.apiBase;

        const saveAndClose = () => {
          // Save values before closing, in case change events didn't fire
          if (tokenInput) {
            const newToken = tokenInput.value;
            if (newToken !== getToken()) {
              setToken(newToken);
              reconnectSSEForActiveOrRunningPanes();
            }
          }
          if (apiBaseInput) {
            const newApiBase = String(apiBaseInput.value || '/api');
            if (newApiBase !== options.apiBase) {
              options.apiBase = newApiBase;
              refreshModels().catch(() => {});
              refreshChats().catch(() => {});
              // Reconnect SSE for active/running panes with the new apiBase
              reconnectSSEForActiveOrRunningPanes();
            }
          }
          try { document.body.removeChild(backdrop); } catch {}
        };
        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) saveAndClose();
        });
        modal.querySelector('[data-close="1"]').addEventListener('click', saveAndClose);

        tokenInput.addEventListener('change', () => {
          setToken(tokenInput.value);
          // Reconnect SSE with new token for active/running panes
          reconnectSSEForActiveOrRunningPanes();
        });
        apiBaseInput.addEventListener('change', () => {
          options.apiBase = String(apiBaseInput.value || '/api');
          // Refresh data using new base
          refreshModels().catch(() => {});
          refreshChats().catch(() => {});
          reconnectSSEForActiveOrRunningPanes();
        });
      };

      btnConfig.addEventListener('click', openConfigModal);
      btnNew.addEventListener('click', () => createNewChat().catch((e) => alert(String(e.message || e))));

      const autoResizeTextarea = (pane) => {
        if (!pane || !pane.ta) return;
        const ta = pane.ta;
        // Reset height to measure scrollHeight from the intrinsic content size
        ta.style.height = 'auto';
        const maxPx = Math.floor(window.innerHeight * 0.5);
        const next = Math.min(ta.scrollHeight, maxPx);
        ta.style.height = next + 'px';
      };

      const reconnectSSEForActiveOrRunningPanes = () => {
        for (const p of state.panes.values()) closeSSE(p);
        const activeId = String(state.chatId || '');
        for (const p of state.panes.values()) {
          if (!p || !p.chatId) continue;
          if (String(p.chatId) === activeId || p.running || (p.live && p.live.running)) {
            ensureSSE(p);
          }
        }
      };

      // Initial load
      (async () => {
        try {
          // If token isn't set, prompt immediately (CLI/server enforces auth).
          if (!getToken()) {
            setActivePane(null);
            placeholderBody.innerHTML = `<div class="ve-muted">Token required. Click ⚙ and paste a token from <code>.viib-etch-tokens</code>.</div>`;
            openConfigModal();
            return;
          }
          await refreshModels();
          await refreshChats();
          const remembered = localStorage.getItem(options.chatStorageKey);
          if (remembered) {
            await openChatId(remembered);
          } else if (state.chats.length > 0) {
            await openChatId(state.chats[0].id);
          }
          const ap = getActivePane();
          if (ap) ensureSSE(ap);
        } catch (e) {
          setActivePane(null);
          placeholderBody.innerHTML = `<div class="ve-muted">Failed to load: ${escapeHtml(e && e.message ? e.message : String(e))}</div>`;
        }
      })();

      // Ensure placeholder (no active chat) shows an idle state
      return {
        destroy: () => {
          for (const p of state.panes.values()) closeSSE(p);
          root.innerHTML = '';
        },
      };
    }

    return { mount };
  }

  // Expose UI in browser
  if (!IS_NODE && typeof window !== 'undefined') {
    window.ViibEtchUI = createBrowserUI();
  }

  // ----------------------------
  // Node server/mountable handler
  // ----------------------------
  if (IS_NODE) {
    const fs = require('fs');
    const path = require('path');
    const url = require('url');
    const http = require('http');
    const https = require('https');
    const { EventEmitter } = require('events');
    const nowIso = () => new Date().toISOString();

    function resolveFile(p) {
      if (!p) return null;
      if (path.isAbsolute(p)) return p;
      const c1 = path.resolve(process.cwd(), p);
      if (fs.existsSync(c1)) return c1;
      const c2 = path.resolve(__dirname, p);
      if (fs.existsSync(c2)) return c2;
      return c1;
    }

    function json(res, code, obj) {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(obj));
    }

    function text(res, code, body, ct) {
      res.statusCode = code;
      res.setHeader('content-type', (ct || 'text/plain') + '; charset=utf-8');
      res.end(body || '');
    }

    function readBody(req, limitBytes) {
      const limit = typeof limitBytes === 'number' ? limitBytes : 1024 * 1024;
      return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
          size += c.length;
          if (size > limit) {
            reject(new Error('request body too large'));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    }

    async function readJson(req) {
      const body = await readBody(req);
      if (!body) return {};
      try {
        return JSON.parse(body);
      } catch {
        throw new Error('invalid json');
      }
    }

    function parsePath(reqUrl) {
      const u = url.parse(reqUrl, true);
      return { pathname: u.pathname || '/', query: u.query || {} };
    }

    function getBearerToken(req, query) {
      const h = req.headers && (req.headers.authorization || req.headers.Authorization);
      if (h && typeof h === 'string') {
        const m = h.match(/^Bearer\s+(.+)$/i);
        if (m) return m[1].trim();
      }
      if (query && typeof query.token === 'string') return query.token;
      return '';
    }

    function createUiHtmlShell({ title, apiBase, uiJsPath }) {
      const t = title || 'viib-etch';
      const api = apiBase || '/api';
      const jsPath = uiJsPath || '/viib-etch-ui.js';
      return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${t.replace(/"/g, '&quot;')}" />
    <title>${t.replace(/</g, '&lt;')}</title>
    <style>html,body{height:100%;margin:0} body{background:#ffffff}</style>
  </head>
  <body>
    <div id="app" style="height:100%"></div>
    <script src="${jsPath}"></script>
    <script>
      (function(){
        if (!window.ViibEtchUI) return;
        window.ViibEtchUI.mount(document.getElementById('app'), { apiBase: ${JSON.stringify(api)} });
      })();
    </script>
  </body>
</html>`;
    }

    // Module-level default tokens file name; can be overridden via
    // createViibEtchUI.setTokensFile(...) before creating any UI instances.
    let DEFAULT_TOKENS_FILE = '.viib-etch-tokens';

    function createViibEtchUI(options) {
      const opts = options || {};
      const basePath = (opts.basePath || '').replace(/\/+$/, '');
      const uiPath = basePath + (opts.uiPath || '/');
      const apiBase = basePath + (opts.apiPath || '/api');
      const uiJsPath = basePath + (opts.uiJsPath || '/viib-etch-ui.js');
      const token = opts.token || process.env.VIIB_ETCH_UI_TOKEN || '';
      // tokensFile resolution order:
      //   1. explicit opts.tokensFile
      //   2. VIIB_ETCH_TOKENS_FILE env var
      //   3. module-level DEFAULT_TOKENS_FILE (overridable via setTokensFile)
      const tokensFile =
        opts.tokensFile ||
        process.env.VIIB_ETCH_TOKENS_FILE ||
        DEFAULT_TOKENS_FILE;
      const chatsDir = opts.chatsDir || null;
      const modelsFile = opts.modelsFile || null;

      const parseTokensText = (text) => {
        const out = new Set();
        for (const line of String(text || '').split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          if (t.startsWith('#')) continue;
          out.add(t);
        }
        return out;
      };

      const resolveTokensFilePath = () => resolveFile(tokensFile);

      const loadTokensFromFile = () => {
        try {
          const p = resolveTokensFilePath();
          if (!p || !fs.existsSync(p)) return new Set();
          const txt = fs.readFileSync(p, 'utf8');
          return parseTokensText(txt);
        } catch {
          return new Set();
        }
      };

      // Keep it simple: cache + reload if mtime changes.
      let _tokensCache = null; // Set<string>
      let _tokensMtimeMs = null;
      const getAllowedTokens = () => {
        const allowed = new Set();
        if (token) allowed.add(String(token));
        const p = resolveTokensFilePath();
        try {
          if (p && fs.existsSync(p)) {
            const st = fs.statSync(p);
            const mt = st.mtimeMs;
            if (_tokensCache === null || _tokensMtimeMs === null || mt !== _tokensMtimeMs) {
              _tokensCache = loadTokensFromFile();
              _tokensMtimeMs = mt;
            }
            for (const t of _tokensCache) allowed.add(t);
          }
        } catch {
          // ignore
        }
        return allowed;
      };

      const allowNoAuth = getAllowedTokens().size === 0;

      // Lazy require to keep mountable usage lightweight
      const viib = require(path.join(__dirname, 'viib-etch.js'));
      const { ChatModel, ChatSession, ChatLLM } = viib;
      const { executeTool } = require(path.join(__dirname, 'viib-etch-tools.js'));

      if (modelsFile) {
        try { viib.setModelsFileName(modelsFile); } catch {}
      }
      if (chatsDir) {
        try { viib.setChatsDir(chatsDir); } catch {}
      }

      // markdown-it (server-side, for completeness)
      let md = null;
      try {
        const MarkdownIt = require('markdown-it');
        md = new MarkdownIt({
          html: false,
          linkify: true,
          typographer: true,
        });
      } catch {
        md = null;
      }

      const busByChatId = new Map(); // chatId -> EventEmitter
      const runByChatId = new Map(); // chatId -> { llm, running:boolean, startedAt }

      function getBus(chatId) {
        const id = String(chatId);
        let b = busByChatId.get(id);
        if (!b) {
          b = new EventEmitter();
          b.setMaxListeners(1000);
          busByChatId.set(id, b);
        }
        return b;
      }

      function emit(chatId, event, data) {
        const b = getBus(chatId);
        b.emit('event', { event, data, ts: Date.now() });
      }

      function checkAuth(req, query) {
        if (allowNoAuth) return true;
        const t = getBearerToken(req, query);
        if (!t) return false;
        return getAllowedTokens().has(t);
      }

      async function handleApi(req, res) {
        const { pathname, query } = parsePath(req.url || '/');
        if (!pathname.startsWith(apiBase + '/')) return false;

        if (!checkAuth(req, query)) {
          json(res, 401, { error: 'unauthorized' });
          return true;
        }

        // GET /api/models
        if (req.method === 'GET' && pathname === apiBase + '/models') {
          try {
            const models = ChatModel.loadModels();
            json(res, 200, models.map((m) => ({ name: m.name, model: m.model })));
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // GET /api/chats
        if (req.method === 'GET' && pathname === apiBase + '/chats') {
          try {
            const sessions = ChatSession.listChatSessions();
            json(res, 200, sessions);
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat { model_name }
        if (req.method === 'POST' && pathname === apiBase + '/chat') {
          try {
            const body = await readJson(req);
            const model_name = body.model_name;
            if (typeof model_name !== 'string' || !model_name.trim()) {
              json(res, 400, { error: 'model_name is required' });
              return true;
            }
            const llm = ChatLLM.newChatSession(model_name, true, null, {});
            // Optional: set persistent base_dir on the new chat
            const base_dir = (typeof body.base_dir === 'string' && body.base_dir.trim()) ? body.base_dir.trim() : null;
            if (base_dir) {
              try { llm.setBaseDir(base_dir); } catch {}
            }
            json(res, 200, { id: llm.chat.id });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // GET /api/chat/:id
        const chatMatch = pathname.match(new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)$'));
        if (req.method === 'GET' && chatMatch) {
          const chatId = decodeURIComponent(chatMatch[1]);
          try {
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            json(res, 200, chat);
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat/:id/tool { tool_name, arguments } -> result (json or text)
        const toolMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/tool$')
        );
        if (req.method === 'POST' && toolMatch) {
          const chatId = decodeURIComponent(toolMatch[1]);
          try {
            const body = await readJson(req);
            const tool_name = body && body.tool_name ? String(body.tool_name) : '';
            const argsIn = body && body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
            if (!tool_name) {
              json(res, 400, { error: 'tool_name is required' });
              return true;
            }
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }

            const base_dir =
              chat && typeof chat.base_dir === 'string' && chat.base_dir.trim()
                ? chat.base_dir.trim()
                : null;

            // Minimal safety: scope relative paths to chat.base_dir when present.
            const args = Object.assign({}, argsIn || {});
            const resolveRel = (p) => {
              const s = String(p || '');
              if (!s) return s;
              if (!base_dir) return s;
              if (path.isAbsolute(s)) return s;
              return path.resolve(base_dir, s);
            };
            if (tool_name === 'read_file' || tool_name === 'delete_file') {
              if (typeof args.target_file === 'string') args.target_file = resolveRel(args.target_file);
            }
            if (tool_name === 'list_dir') {
              if (typeof args.target_directory === 'string') args.target_directory = resolveRel(args.target_directory);
            }
            if (tool_name === 'glob_file_search') {
              if (typeof args.target_directory === 'string') args.target_directory = resolveRel(args.target_directory);
            }
            if (tool_name === 'rg') {
              if (typeof args.path === 'string') args.path = resolveRel(args.path);
            }

            const result = await executeTool(tool_name, args, { session: chat });
            if (typeof result === 'string') {
              text(res, 200, result, 'text/plain');
              return true;
            }
            json(res, 200, result);
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // GET /api/chat/:id/changes -> list of changed files (relative to base_dir when set)
        const changesMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '/chat/([^/]+)/changes$')
        );
        if (req.method === 'GET' && changesMatch) {
          const chatId = decodeURIComponent(changesMatch[1]);
          try {
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            const base_dir =
              chat && typeof chat.base_dir === 'string' && chat.base_dir.trim()
                ? chat.base_dir.trim()
                : null;
            const baseAbs = base_dir ? path.resolve(base_dir) : null;
            const cwdAbs = path.resolve(process.cwd());
            const fo = chat && chat.data && chat.data.fileOriginals && typeof chat.data.fileOriginals === 'object'
              ? chat.data.fileOriginals
              : {};
            const keys = Object.keys(fo || {});
            const files = [];
            for (const k of keys) {
              const relCwd = String(k || '').trim();
              if (!relCwd) continue;
              // fileOriginals keys are relative to process.cwd() at tool execution time.
              // If base_dir is set, try resolving relative to base_dir first (tools run there).
              let abs;
              if (path.isAbsolute(relCwd)) {
                abs = path.resolve(relCwd);
              } else if (baseAbs) {
                // Try base_dir first (most common case when tools run in base_dir).
                const tryBase = path.resolve(baseAbs, relCwd);
                const prefix = baseAbs.endsWith(path.sep) ? baseAbs : (baseAbs + path.sep);
                if (tryBase === baseAbs || tryBase.startsWith(prefix)) {
                  abs = tryBase;
                } else {
                  // Fall back to cwd resolution.
                  abs = path.resolve(cwdAbs, relCwd);
                }
              } else {
                abs = path.resolve(cwdAbs, relCwd);
              }
              // If base_dir is set, only include files within it; otherwise include all.
              if (baseAbs) {
                const prefix = baseAbs.endsWith(path.sep) ? baseAbs : (baseAbs + path.sep);
                if (!(abs === baseAbs || abs.startsWith(prefix))) continue;
                // Compute relative path from base_dir for display.
                const relToBase = path.relative(baseAbs, abs);
                const disp = relToBase.replace(/\\/g, '/');
                if (disp && !disp.startsWith('..') && disp !== '.') files.push(disp);
              } else {
                // No base_dir: use the key as-is (relative to cwd), normalize separators.
                const disp = relCwd.replace(/\\/g, '/');
                if (disp) files.push(disp);
              }
            }
            files.sort((a, b) => a.localeCompare(b));
            json(res, 200, { base_dir: base_dir || '', files });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // GET /api/chat/:id/original?path=... -> original content from chat.data.fileOriginals
        const originalMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '/chat/([^/]+)/original$')
        );
        if (req.method === 'GET' && originalMatch) {
          const chatId = decodeURIComponent(originalMatch[1]);
          const reqPath = query && typeof query.path === 'string' ? String(query.path) : '';
          if (!reqPath.trim()) {
            json(res, 400, { error: 'path is required' });
            return true;
          }
          try {
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            const base_dir =
              chat && typeof chat.base_dir === 'string' && chat.base_dir.trim()
                ? chat.base_dir.trim()
                : null;
            const baseAbs = base_dir ? path.resolve(base_dir) : null;
            const cwdAbs = path.resolve(process.cwd());
            const targetAbs = path.isAbsolute(reqPath)
              ? path.resolve(reqPath)
              : path.resolve(baseAbs || cwdAbs, reqPath);
            if (baseAbs) {
              const prefix = baseAbs.endsWith(path.sep) ? baseAbs : (baseAbs + path.sep);
              if (!(targetAbs === baseAbs || targetAbs.startsWith(prefix))) {
                json(res, 403, { error: 'path outside base_dir' });
                return true;
              }
            }
            const fo = chat && chat.data && chat.data.fileOriginals && typeof chat.data.fileOriginals === 'object'
              ? chat.data.fileOriginals
              : {};
            // fileOriginals keys are relative to process.cwd() at tool execution time.
            // If base_dir is set, tools likely ran there, so try that first.
            let lookupKey = null;
            if (baseAbs) {
              const relToBase = path.relative(baseAbs, targetAbs);
              if (relToBase && !relToBase.startsWith('..') && relToBase !== '.') {
                // Try key relative to base_dir (normalized separators).
                const keyBase = relToBase.replace(/\\/g, '/');
                if (keyBase in fo) {
                  lookupKey = keyBase;
                }
              }
            }
            if (!lookupKey) {
              // Fall back to key relative to process.cwd().
              const relCwd = path.relative(cwdAbs, targetAbs);
              const keyCwd = relCwd.replace(/\\/g, '/');
              if (keyCwd in fo) {
                lookupKey = keyCwd;
              }
            }
            if (!lookupKey || !(lookupKey in fo)) {
              json(res, 404, { error: 'original not found' });
              return true;
            }
            text(res, 200, String(fo[lookupKey] ?? ''), 'text/plain');
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // GET /api/chat/:id/file?path=... -> raw file text (scoped to chat.base_dir when set)
        const fileMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '/chat/([^/]+)/file$')
        );
        if (req.method === 'GET' && fileMatch) {
          const chatId = decodeURIComponent(fileMatch[1]);
          const reqPath = query && typeof query.path === 'string' ? String(query.path) : '';
          if (!reqPath.trim()) {
            json(res, 400, { error: 'path is required' });
            return true;
          }
          try {
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }

            const base_dir =
              chat && typeof chat.base_dir === 'string' && chat.base_dir.trim()
                ? chat.base_dir.trim()
                : null;
            const baseAbs = base_dir ? path.resolve(base_dir) : null;
            const targetAbs = path.isAbsolute(reqPath)
              ? path.resolve(reqPath)
              : path.resolve(baseAbs || process.cwd(), reqPath);

            if (baseAbs) {
              const prefix = baseAbs.endsWith(path.sep) ? baseAbs : (baseAbs + path.sep);
              if (!(targetAbs === baseAbs || targetAbs.startsWith(prefix))) {
                json(res, 403, { error: 'path outside base_dir' });
                return true;
              }
            }

            let st;
            try { st = fs.statSync(targetAbs); } catch { st = null; }
            if (!st) {
              json(res, 404, { error: 'file not found' });
              return true;
            }
            if (!st.isFile()) {
              json(res, 400, { error: 'not a file' });
              return true;
            }

            const content = fs.readFileSync(targetAbs, 'utf8');
            text(res, 200, content || '', 'text/plain');
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat/:id/file { path, content } -> save file (scoped to chat.base_dir when set)
        if (req.method === 'POST' && fileMatch) {
          const chatId = decodeURIComponent(fileMatch[1]);
          try {
            const body = await readJson(req);
            const reqPath = body && typeof body.path === 'string' ? body.path : '';
            const content = body && body.content !== undefined ? String(body.content) : '';
            if (!String(reqPath || '').trim()) {
              json(res, 400, { error: 'path is required' });
              return true;
            }

            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }

            const base_dir =
              chat && typeof chat.base_dir === 'string' && chat.base_dir.trim()
                ? chat.base_dir.trim()
                : null;
            const baseAbs = base_dir ? path.resolve(base_dir) : null;
            const targetAbs = path.isAbsolute(reqPath)
              ? path.resolve(reqPath)
              : path.resolve(baseAbs || process.cwd(), reqPath);

            if (baseAbs) {
              const prefix = baseAbs.endsWith(path.sep) ? baseAbs : (baseAbs + path.sep);
              if (!(targetAbs === baseAbs || targetAbs.startsWith(prefix))) {
                json(res, 403, { error: 'path outside base_dir' });
                return true;
              }
            }

            // Ensure parent directory exists.
            try { fs.mkdirSync(path.dirname(targetAbs), { recursive: true }); } catch {}
            fs.writeFileSync(targetAbs, content, 'utf8');
            json(res, 200, { success: true });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // GET /api/chat/:id/images/:imageId/data -> raw image bytes (in-memory base64)
        const imageDataMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/images/([^/]+)/data$')
        );
        if (req.method === 'GET' && imageDataMatch) {
          const chatId = decodeURIComponent(imageDataMatch[1]);
          const imageId = decodeURIComponent(imageDataMatch[2]);
          try {
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            const rec = (typeof chat.getImage === 'function') ? chat.getImage(imageId) : null;
            const b64 = rec ? (rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null) : null;
            if (!rec || !b64) {
              json(res, 404, { error: 'image not found' });
              return true;
            }
            const ct = rec.mime_type && typeof rec.mime_type === 'string' ? rec.mime_type : 'application/octet-stream';
            res.statusCode = 200;
            res.setHeader('content-type', ct);
            res.setHeader('cache-control', 'no-store');
            res.end(Buffer.from(String(b64), 'base64'));
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat/:id/images { data_b64, mime_type? } -> { id }
        const imageAddMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/images$')
        );
        if (req.method === 'POST' && imageAddMatch) {
          const chatId = decodeURIComponent(imageAddMatch[1]);
          try {
            const raw = await readBody(req, 15 * 1024 * 1024);
            const body = raw ? JSON.parse(raw) : {};
            const b64 = body ? (body.data_b64 ?? body.data_base64 ?? body.b64_json ?? body.data ?? null) : null;
            const mime_type = body && typeof body.mime_type === 'string' && body.mime_type.trim()
              ? body.mime_type.trim()
              : 'application/octet-stream';
            if (typeof b64 !== 'string' || !b64.trim()) {
              json(res, 400, { error: 'data_b64 is required' });
              return true;
            }
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            if (typeof chat.addImage !== 'function') {
              json(res, 500, { error: 'chat does not support images' });
              return true;
            }
            const rec = {
              kind: 'reference',
              mime_type,
              data_b64: String(b64),
              created_at: nowIso(),
              source: 'upload',
            };
            const id = chat.addImage(rec);
            try { chat.save(); } catch {}
            json(res, 200, { id });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat/:id/images/from_url { url } -> { id }
        const imageFromUrlMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/images/from_url$')
        );
        if (req.method === 'POST' && imageFromUrlMatch) {
          const chatId = decodeURIComponent(imageFromUrlMatch[1]);
          try {
            const body = await readJson(req);
            const urlStr = body && typeof body.url === 'string' ? body.url.trim() : '';
            if (!urlStr) {
              json(res, 400, { error: 'url is required' });
              return true;
            }
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            if (typeof chat.addImage !== 'function') {
              json(res, 500, { error: 'chat does not support images' });
              return true;
            }

            const parseDataUrl = (s) => {
              const m = String(s || '').match(/^data:([^;]+);base64,(.+)$/);
              if (!m) return null;
              return { mime_type: m[1], data_b64: m[2] };
            };

            const fetchUrlAsBuffer = (u, maxBytes, redirectsLeft) => new Promise((resolve, reject) => {
              let parsed;
              try { parsed = new URL(u); } catch { parsed = null; }
              if (!parsed || !parsed.protocol) return reject(new Error('invalid url'));
              const proto = parsed.protocol === 'https:' ? https : (parsed.protocol === 'http:' ? http : null);
              if (!proto) return reject(new Error('unsupported url protocol'));
              const req2 = proto.request(parsed, (r) => {
                const code = r.statusCode || 0;
                const loc = r.headers && r.headers.location ? String(r.headers.location) : '';
                if ([301, 302, 303, 307, 308].includes(code) && loc && redirectsLeft > 0) {
                  const next = new URL(loc, parsed).toString();
                  r.resume();
                  fetchUrlAsBuffer(next, maxBytes, redirectsLeft - 1).then(resolve, reject);
                  return;
                }
                if (code < 200 || code >= 300) {
                  r.resume();
                  reject(new Error(`fetch failed: ${code}`));
                  return;
                }
                const chunks = [];
                let size = 0;
                r.on('data', (c) => {
                  size += c.length;
                  if (size > maxBytes) {
                    try { req2.destroy(); } catch {}
                    return;
                  }
                  chunks.push(c);
                });
                r.on('end', () => {
                  if (size > maxBytes) return reject(new Error('image too large'));
                  resolve({
                    buf: Buffer.concat(chunks),
                    contentType: r.headers && r.headers['content-type'] ? String(r.headers['content-type']) : '',
                    finalUrl: parsed.toString(),
                  });
                });
              });
              req2.on('error', reject);
              req2.setTimeout(12000, () => {
                try { req2.destroy(new Error('timeout')); } catch {}
              });
              req2.end();
            });

            const dataUrlParsed = parseDataUrl(urlStr);
            let mime_type = 'application/octet-stream';
            let data_b64 = null;
            let finalUrl = urlStr;
            if (dataUrlParsed) {
              mime_type = dataUrlParsed.mime_type || mime_type;
              data_b64 = dataUrlParsed.data_b64;
            } else {
              const fetched = await fetchUrlAsBuffer(urlStr, 10 * 1024 * 1024, 3);
              const ct = String(fetched.contentType || '').split(';')[0].trim();
              if (ct) mime_type = ct;
              data_b64 = fetched.buf.toString('base64');
              finalUrl = fetched.finalUrl || urlStr;
            }

            if (!data_b64) {
              json(res, 500, { error: 'failed to fetch image' });
              return true;
            }
            const rec = {
              kind: 'reference',
              mime_type,
              data_b64: String(data_b64),
              created_at: nowIso(),
              source_url: finalUrl,
              source: 'url',
            };
            const id = chat.addImage(rec);
            try { chat.save(); } catch {}
            json(res, 200, { id });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // DELETE /api/chat/:id (delete persisted session file)
        if (req.method === 'DELETE' && chatMatch) {
          const chatId = decodeURIComponent(chatMatch[1]);
          try {
            const existing = runByChatId.get(String(chatId));
            if (existing && existing.running) {
              json(res, 409, { error: 'chat is running' });
              return true;
            }
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            const filePath = path.resolve(ChatSession.getFileName(chatId));
            try {
              fs.unlinkSync(filePath);
            } catch (e) {
              if (e && e.code !== 'ENOENT') throw e;
            }
            runByChatId.delete(String(chatId));
            busByChatId.delete(String(chatId));
            json(res, 200, { success: true });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // GET /api/chat/:id/events (SSE)
        const evMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/events$')
        );
        if (req.method === 'GET' && evMatch) {
          const chatId = decodeURIComponent(evMatch[1]);
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream; charset=utf-8');
          res.setHeader('cache-control', 'no-cache, no-transform');
          res.setHeader('connection', 'keep-alive');
          res.setHeader('x-accel-buffering', 'no');
          res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);

          const b = getBus(chatId);
          const onEv = (payload) => {
            try {
              res.write(`event: ${payload.event}\n`);
              res.write(`data: ${JSON.stringify(payload.data || {})}\n\n`);
            } catch {
              // ignore
            }
          };
          b.on('event', onEv);

          const keepAlive = setInterval(() => {
            try {
              res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
            } catch {}
          }, 15000);

          req.on('close', () => {
            clearInterval(keepAlive);
            b.off('event', onEv);
          });
          return true;
        }

        // POST /api/chat/:id/cancel
        const cancelMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/cancel$')
        );
        if (req.method === 'POST' && cancelMatch) {
          const chatId = decodeURIComponent(cancelMatch[1]);
          const run = runByChatId.get(String(chatId));
          if (run && run.llm) {
            try { run.llm.cancel(); } catch {}
          }
          emit(chatId, 'run.cancel', { ts: nowIso() });
          json(res, 200, { success: true });
          return true;
        }

        // POST /api/chat/:id/base_dir { base_dir?: string|null }
        const baseDirMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/base_dir$')
        );
        if (req.method === 'POST' && baseDirMatch) {
          const chatId = decodeURIComponent(baseDirMatch[1]);
          try {
            const body = await readJson(req);
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            const base_dir =
              (typeof body.base_dir === 'string' && body.base_dir.trim())
                ? body.base_dir.trim()
                : null;
            if (typeof chat.setBaseDir === 'function') {
              chat.setBaseDir(base_dir);
            } else {
              chat.base_dir = base_dir;
              chat.save();
            }
            json(res, 200, { success: true, base_dir: chat.base_dir });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat/:id/title { title?: string|null }
        const titleMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/title$')
        );
        if (req.method === 'POST' && titleMatch) {
          const chatId = decodeURIComponent(titleMatch[1]);
          try {
            const body = await readJson(req);
            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }
            const raw = body.title;
            const title = raw === null || raw === undefined ? null : String(raw).trim();
            chat.title = title && title.length ? title : null;
            chat.save();
            json(res, 200, { success: true, title: chat.title });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat/:id/send { message, model_name? }
        const sendMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/send$')
        );
        if (req.method === 'POST' && sendMatch) {
          const chatId = decodeURIComponent(sendMatch[1]);
          try {
            const body = await readJson(req);
            const message = body.message;
            if (typeof message !== 'string' || !message.trim()) {
              json(res, 400, { error: 'message is required' });
              return true;
            }

            const existing = runByChatId.get(String(chatId));
            if (existing && existing.running) {
              json(res, 409, { error: 'chat is already running' });
              return true;
            }

            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }

            // Optionally allow model override on send (useful for "+ new model" in footer).
            const model_name = (typeof body.model_name === 'string' && body.model_name.trim())
              ? body.model_name.trim()
              : chat.model_name;
            
            if (!chat.model_name && model_name) {
              chat.model_name = model_name;
              chat.save();
            } else if (model_name && model_name !== chat.model_name) {
              // Update model if it changed
              chat.model_name = model_name;
              chat.save();
            }

            // Get reasoning_effort from request body if provided
            const reasoning_effort = (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim())
              ? body.reasoning_effort.trim()
              : undefined;

            // IMPORTANT: use openChat() so default tool definitions are loaded from model config
            // (ChatLLM.newChatSession does this, but new ChatLLM(...) does not).
            const llm = (typeof viib.openChat === 'function')
              ? viib.openChat(chatId, null, {})
              : new ChatLLM(model_name || chat.model_name, chat, null, {});
            
            // Set reasoning effort if provided
            if (reasoning_effort !== undefined && reasoning_effort !== null && reasoning_effort !== 'default') {
              llm.setReasoningEffort(reasoning_effort);
            }
            
            runByChatId.set(String(chatId), { llm, running: true, startedAt: Date.now() });

            // Compose hooks: consoleLogHooks-style server logs + SSE for UI
            const consoleHooks = (typeof viib.consoleLogHooks === 'function')
              ? viib.consoleLogHooks({
                  // Keep server logs easy to scan when multiple chats are active.
                  prefix: `[${String(chatId).slice(0, 8)}] `,
                  brief: false,
                  response: true,
                  reasoning: true,
                  tools: true,
                })
              : null;
            const callConsole = async (hookName, ...args) => {
              try {
                const fn = consoleHooks && consoleHooks[hookName];
                if (typeof fn === 'function') await fn(...args);
              } catch (e) {
                // Never break the request because logging failed
              }
            };

            // Stream hooks -> SSE
            let cycleSeq = 0;
            let currentCycleId = null;
            llm.hooks.onRequestStart = async () => {
              await callConsole('onRequestStart');
              if (!cycleSeq) {
                emit(chatId, 'run.start', { ts: nowIso() });
              }
              cycleSeq += 1;
              currentCycleId = `cycle_${Date.now()}_${cycleSeq}`;
              emit(chatId, 'cycle.start', { ts: nowIso(), cycle_id: currentCycleId, seq: cycleSeq });
            };
            llm.hooks.onRequestDone = async (elapsed) => {
              await callConsole('onRequestDone', elapsed);
            };

            llm.hooks.onReasoningStart = async (sinceRequestDone) => {
              await callConsole('onReasoningStart', sinceRequestDone);
              emit(chatId, 'assistant.reasoning.start', { ts: nowIso(), cycle_id: currentCycleId });
            };
            llm.hooks.onReasoningData = async (chunk) => {
              await callConsole('onReasoningData', chunk);
              emit(chatId, 'assistant.reasoning.delta', { delta: String(chunk || ''), cycle_id: currentCycleId });
            };
            llm.hooks.onReasoningDone = async (fullReasoning, elapsed) => {
              await callConsole('onReasoningDone', fullReasoning, elapsed);
              emit(chatId, 'assistant.reasoning.done', { ts: nowIso(), cycle_id: currentCycleId });
            };

            llm.hooks.onResponseStart = async (sinceRequestDone) => {
              await callConsole('onResponseStart', sinceRequestDone);
              emit(chatId, 'assistant.response.start', { ts: nowIso(), cycle_id: currentCycleId });
            };
            llm.hooks.onResponseData = async (chunk) => {
              await callConsole('onResponseData', chunk);
              emit(chatId, 'assistant.response.delta', { delta: String(chunk || ''), cycle_id: currentCycleId });
            };
            llm.hooks.onResponseDone = async (content, elapsed) => {
              await callConsole('onResponseDone', content, elapsed);
              emit(chatId, 'assistant.response.done', { ts: nowIso(), cycle_id: currentCycleId });
            };

            llm.hooks.onToolCallStart = async (toolCall, args, sinceRequestDone) => {
              await callConsole('onToolCallStart', toolCall, args, sinceRequestDone);
              emit(chatId, 'tool.start', {
                id: toolCall && toolCall.id ? String(toolCall.id) : null,
                name: toolCall?.function?.name || null,
                args: args || null,
                cycle_id: currentCycleId,
                ts: nowIso(),
              });
            };
            llm.hooks.onToolCallData = async (toolCall, data) => {
              await callConsole('onToolCallData', toolCall, data);
              const toolId = toolCall && toolCall.id ? String(toolCall.id) : null;
              const toolName = toolCall?.function?.name || null;

              // For apply_patch/edit_file: when emitting the final result phase,
              // include patchCommand/diff from chat.data.diffs so live UI can render tabs.
              let payloadData = data || null;
              try {
                if (
                  toolId &&
                  (toolName === 'apply_patch' || toolName === 'edit_file') &&
                  payloadData &&
                  typeof payloadData === 'object' &&
                  payloadData.phase === 'result'
                ) {
                  const chatObj = llm && llm.chat ? llm.chat : null;
                  const rec = chatObj && chatObj.data && chatObj.data.diffs ? chatObj.data.diffs[toolId] : null;
                  if (rec && (rec.patchCommand || rec.diff)) {
                    payloadData = {
                      ...payloadData,
                      result: (payloadData.result && typeof payloadData.result === 'object')
                        ? { ...payloadData.result, patchCommand: rec.patchCommand || null, diff: rec.diff || null }
                        : { result: payloadData.result, patchCommand: rec.patchCommand || null, diff: rec.diff || null },
                    };
                  }
                }
              } catch {}

              emit(chatId, 'tool.data', {
                id: toolId,
                name: toolName,
                data: payloadData,
                cycle_id: currentCycleId,
                ts: nowIso(),
              });
            };
            llm.hooks.onToolCallEnd = async (toolCall, data, elapsed) => {
              await callConsole('onToolCallEnd', toolCall, data, elapsed);
              const toolId = toolCall && toolCall.id ? String(toolCall.id) : null;
              const toolName = toolCall?.function?.name || null;

              // For apply_patch/edit_file: include stored patchCommand/diff in the live SSE payload
              // so the UI can render Command/Diff/Output consistently without waiting for replay.
              let enriched = data || null;
              try {
                if (toolId && (toolName === 'apply_patch' || toolName === 'edit_file')) {
                  const chatObj = llm && llm.chat ? llm.chat : null;
                  const rec = chatObj && chatObj.data && chatObj.data.diffs ? chatObj.data.diffs[toolId] : null;
                  if (rec && (rec.patchCommand || rec.diff)) {
                    const base = (enriched && typeof enriched === 'object') ? enriched : { result: enriched };
                    enriched = {
                      ...base,
                      patchCommand: rec.patchCommand || null,
                      diff: rec.diff || null,
                    };
                  }
                }
              } catch {}

              emit(chatId, 'tool.end', {
                id: toolId,
                name: toolName,
                elapsed_ms: elapsed || null,
                cycle_id: currentCycleId,
                ts: nowIso(),
                result: enriched,
              });
            };
            llm.hooks.onTitle = async (title) => {
              await callConsole('onTitle', title);
            };

            // Add user message explicitly (so server can be "complete()" only)
            await llm.addUserMessage(message);
            emit(chatId, 'chat.user', { content: message, ts: nowIso() });

            // Fire and forget (mountable handler must not block SSE consumers)
            (async () => {
              try {
                await llm.complete({ stream: true });
                try {
                  // Best-effort cleanup of orphaned images (e.g., attached-but-never-used).
                  if (llm && llm.chat && typeof llm.chat.cleanupImages === 'function') {
                    llm.chat.cleanupImages();
                    llm.chat.save();
                  }
                } catch {}
                emit(chatId, 'run.done', { ts: nowIso() });
              } catch (e) {
                emit(chatId, 'run.error', { ts: nowIso(), error: e.message || String(e) });
              } finally {
                const r = runByChatId.get(String(chatId));
                if (r) r.running = false;
              }
            })();

            json(res, 200, { success: true });
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/chat/:id/generate_image { prompt, model_name?, reference_image_ids?, options? }
        const genMatch = pathname.match(
          new RegExp('^' + apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/chat/([^/]+)/generate_image$')
        );
        if (req.method === 'POST' && genMatch) {
          const chatId = decodeURIComponent(genMatch[1]);
          try {
            const body = await readJson(req);
            const prompt = body.prompt;
            if (typeof prompt !== 'string' || !prompt.trim()) {
              json(res, 400, { error: 'prompt is required' });
              return true;
            }

            const existing = runByChatId.get(String(chatId));
            if (existing && existing.running) {
              json(res, 409, { error: 'chat is already running' });
              return true;
            }

            const chat = ChatSession.load(chatId);
            if (!chat) {
              json(res, 404, { error: 'not found' });
              return true;
            }

            const model_name = (typeof body.model_name === 'string' && body.model_name.trim())
              ? body.model_name.trim()
              : chat.model_name;
            if (model_name && model_name !== chat.model_name) {
              chat.model_name = model_name;
              chat.save();
            }

            const llm = (typeof viib.openChat === 'function')
              ? viib.openChat(chatId, null, {})
              : new ChatLLM(model_name || chat.model_name, chat, null, {});
            runByChatId.set(String(chatId), { llm, running: true, startedAt: Date.now() });

            emit(chatId, 'run.start', { ts: nowIso() });
            emit(chatId, 'cycle.start', { ts: nowIso(), cycle_id: `cycle_${Date.now()}_1`, seq: 1 });
            emit(chatId, 'chat.user', { content: String(prompt), ts: nowIso() });

            const optionsObj = (body.options && typeof body.options === 'object') ? body.options : {};

            // Optional explicit references by id
            let referenceImages = null;
            const refIds = Array.isArray(body.reference_image_ids) ? body.reference_image_ids : null;
            if (refIds && refIds.length > 0 && typeof chat.getImage === 'function') {
              const refs = [];
              for (const rid of refIds) {
                const rec = chat.getImage(rid);
                const b64 = rec ? (rec.data_b64 ?? rec.data_base64 ?? rec.b64_json ?? rec.data ?? null) : null;
                if (!rec || !b64) continue;
                refs.push({ id: String(rid), mime_type: rec.mime_type || null, data_b64: String(b64) });
              }
              referenceImages = refs.length ? refs : null;
            }

            try {
              const result = await llm.generateImage(String(prompt), referenceImages, optionsObj);
              try {
                // Best-effort cleanup of orphaned images (e.g., attached-but-never-used).
                if (llm && llm.chat && typeof llm.chat.cleanupImages === 'function') {
                  llm.chat.cleanupImages();
                  llm.chat.save();
                }
              } catch {}
              emit(chatId, 'chat.refresh', { ts: nowIso() });
              emit(chatId, 'run.done', { ts: nowIso() });
              json(res, 200, { success: true, result });
            } catch (e) {
              emit(chatId, 'run.error', { ts: nowIso(), error: e.message || String(e) });
              json(res, 500, { error: e.message || String(e) });
            } finally {
              const r = runByChatId.get(String(chatId));
              if (r) r.running = false;
            }
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        // POST /api/markdown { markdown } -> html
        if (req.method === 'POST' && pathname === apiBase + '/markdown') {
          try {
            const body = await readJson(req);
            const markdown = String(body.markdown || '');
            if (!md) {
              // Fallback: plain pre
              return text(res, 200, `<pre>${markdown.replace(/</g, '&lt;')}</pre>`, 'text/html');
            }
            const html = md.render(markdown);
            return text(res, 200, html, 'text/html');
          } catch (e) {
            json(res, 500, { error: e.message || String(e) });
          }
          return true;
        }

        json(res, 404, { error: 'not found' });
        return true;
      }

      function handler(req, res) {
        const { pathname, query } = parsePath(req.url || '/');

        // Serve UI JS (this file) to the browser
        if (req.method === 'GET' && pathname === uiJsPath) {
          const src = fs.readFileSync(__filename, 'utf8');
          res.statusCode = 200;
          res.setHeader('content-type', 'application/javascript; charset=utf-8');
          res.end(src);
          return true;
        }

        // Serve HTML shell at /
        if (req.method === 'GET' && pathname === uiPath) {
          const html = createUiHtmlShell({
            title: opts.title || 'viib-etch',
            apiBase,
            uiJsPath,
          });
          return text(res, 200, html, 'text/html');
        }

        // API routes
        return handleApi(req, res);
      }

      function createHttpsServer(serverOpts) {
        const so = serverOpts || {};
        const host = so.host || '0.0.0.0';
        const port = so.port || 9004;
        const certPath = resolveFile(so.certPath || 'zdte_cert.crt');
        const keyPath = resolveFile(so.keyPath || 'zdte_key.key');
        const tls = {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        };
        const server = https.createServer(tls, (req, res) => {
          const safeWrite = (fn) => {
            if (res.writableEnded || res.destroyed || res.headersSent) return;
            fn();
          };
          const safeNotFound = () => safeWrite(() => text(res, 404, 'not found'));
          const safeError = (err) => {
            console.error('[viib-etch-ui] request error:', err && (err.stack || err.message || err));
            safeWrite(() => json(res, 500, { error: 'internal_error' }));
          };

          try {
            const handled = handler(req, res);
            if (handled && typeof handled.then === 'function') {
              handled
                .then((ok) => {
                  if (!ok) safeNotFound();
                })
                .catch((e) => safeError(e));
              return;
            }
            if (!handled) safeNotFound();
          } catch (e) {
            safeError(e);
          }
        });
        return { server, host, port, listen: () => server.listen(port, host) };
      }

      function createHttpServer(serverOpts) {
        const so = serverOpts || {};
        const host = so.host || '0.0.0.0';
        const port = so.port || 8080;
        const server = http.createServer((req, res) => {
          const safeWrite = (fn) => {
            if (res.writableEnded || res.destroyed || res.headersSent) return;
            fn();
          };
          const safeNotFound = () => safeWrite(() => text(res, 404, 'not found'));
          const safeError = (err) => {
            console.error('[viib-etch-ui] request error:', err && (err.stack || err.message || err));
            safeWrite(() => json(res, 500, { error: 'internal_error' }));
          };

          try {
            const handled = handler(req, res);
            if (handled && typeof handled.then === 'function') {
              handled
                .then((ok) => {
                  if (!ok) safeNotFound();
                })
                .catch((e) => safeError(e));
              return;
            }
            if (!handled) safeNotFound();
          } catch (e) {
            safeError(e);
          }
        });
        return { server, host, port, listen: () => server.listen(port, host) };
      }

      return { handler, createHttpsServer, createHttpServer, uiPath, apiBase, uiJsPath };
    }

    // Allow embedding programs to set the default tokens file name used by
    // viib-etch. Call this *before* creating any UI instances.
    createViibEtchUI.setTokensFile = function (filePath) {
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('setTokensFile: filePath must be a non-empty string');
      }
      DEFAULT_TOKENS_FILE = filePath;
    };

    module.exports = { createViibEtchUI };

    // ----------------------------
    // CLI entrypoint
    // Usage:
    //   VIIB_ETCH_UI_TOKEN=... node viib-etch-ui.js web
    // Env:
    //   VIIB_ETCH_UI_HOST=0.0.0.0
    //   VIIB_ETCH_UI_PORT=9004
    //   VIIB_ETCH_UI_HTTP=1   (force http)
    //   VIIB_ETCH_UI_CERT=zdte_cert.crt
    //   VIIB_ETCH_UI_KEY=zdte_key.key
    if (require.main === module) {
      const cmd = process.argv[2];
      if (cmd === 'web') {
        const token = process.env.VIIB_ETCH_UI_TOKEN || '';
        const tokensFile = process.env.VIIB_ETCH_TOKENS_FILE || '.viib-etch-tokens';
        const host = process.env.VIIB_ETCH_UI_HOST || '0.0.0.0';
        const portRaw = process.env.VIIB_ETCH_UI_PORT || '';
        const cliPortArg = process.argv[3] || '';
        const portFromArg = cliPortArg ? Number(cliPortArg) : undefined;
        const portFromEnv = portRaw ? Number(portRaw) : undefined;
        const port = portFromArg || portFromEnv || undefined;
        const forceHttp = String(process.env.VIIB_ETCH_UI_HTTP || '').toLowerCase() === '1';
        const certPath = process.env.VIIB_ETCH_UI_CERT || 'zdte_cert.crt';
        const keyPath = process.env.VIIB_ETCH_UI_KEY || 'zdte_key.key';

        const ui = createViibEtchUI({ token, tokensFile });
        // Enforce auth for CLI: require at least one token from env or file.
        const hasAnyToken = (() => {
          try {
            const allowed = new Set();
            if (token) allowed.add(token);
            const p = resolveFile(tokensFile);
            if (p && fs.existsSync(p)) {
              const txt = fs.readFileSync(p, 'utf8');
              for (const line of String(txt || '').split(/\r?\n/)) {
                const t = line.trim();
                if (!t || t.startsWith('#')) continue;
                allowed.add(t);
              }
            }
            return allowed.size > 0;
          } catch {
            return !!token;
          }
        })();
        if (!hasAnyToken) {
          console.error('Missing tokens: set VIIB_ETCH_UI_TOKEN or create .viib-etch-tokens (one token per line).');
          process.exit(2);
        }

        if (forceHttp) {
          const srv = ui.createHttpServer({ host, port: port || 9004 });
          srv.listen();
          console.log(`viib-etch-ui listening (http) on http://${host}:${port || 9004}/`);
        } else {
          const srv = ui.createHttpsServer({
            host,
            port: port || 9004,
            certPath,
            keyPath,
          });
          srv.listen();
          console.log(`viib-etch-ui listening (https) on https://${host}:${port || 9004}/`);
        }
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);

