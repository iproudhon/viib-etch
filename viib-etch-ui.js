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
        chat: null,
        chatId: null,
        models: [],
        selectedModel: null,
        selectedReasoningEffort: null,
        token: null,
        running: false,
        sse: null,
        thinkingNode: null,
        thinkingTimerId: null,
        thinkingStartedAt: null,
        live: {
          running: false,
          currentCycleId: null,
          // cycleId -> { rootEl, respDetails, respMdEl, reasonDetails, reasonMdEl, toolsWrapEl, toolBlocks: Map(toolCallId -> { detailsEl, bodyEl, outText, running, openedByUser, name, args }) }
          cycles: new Map(),
          // throttle: key -> timer
          mdTimers: new Map(),
          // for optimistic user message append (avoid duplicate when SSE echoes it back)
          pendingUserEcho: null,
        },
        // UI-state
        collapsedByUser: new Set(), // keys like "reasoning:<msgIndex>"
        toolUi: new Map(), // toolCallId -> { running:boolean, openedByUser?:boolean }
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

      const ensureThinkingNode = () => {
        if (state.thinkingNode && state.thinkingNode.parentNode) return state.thinkingNode;
        const wrap = document.createElement('div');
        wrap.style.margin = '10px 0';
        const span = document.createElement('span');
        span.className = 've-muted';
        wrap.appendChild(span);
        body.appendChild(wrap);
        state.thinkingNode = wrap;
        // Always ensure thinking node is last in the body
        if (wrap.parentNode === body && body.lastChild !== wrap) {
          body.appendChild(wrap);
        }
        return wrap;
      };

      const removeThinkingNode = () => {
        if (state.thinkingNode && state.thinkingNode.parentNode) {
          state.thinkingNode.parentNode.removeChild(state.thinkingNode);
        }
        state.thinkingNode = null;
      };

      const clearThinkingTimer = () => {
        if (state.thinkingTimerId !== null) {
          clearInterval(state.thinkingTimerId);
          state.thinkingTimerId = null;
        }
      };

      const stopThinking = () => {
        clearThinkingTimer();
        removeThinkingNode();
        state.thinkingStartedAt = null;
      };

      const formatElapsed = (ms) => {
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        if (m <= 0) return `${totalSec} second${totalSec === 1 ? '' : 's'}`;
        return `${m} minute${m === 1 ? '' : 's'}${s ? ' ' + s + ` second${s === 1 ? '' : 's'}` : ''}`;
      };

      const startThinking = () => {
        stopThinking();
        state.thinkingStartedAt = Date.now();
        const wrap = ensureThinkingNode();
        const span = wrap.querySelector('span');
        const tick = () => {
          if (!state.thinkingStartedAt) return;
          const elapsed = Date.now() - state.thinkingStartedAt;
          if (span) span.textContent = `Thinking… ${formatElapsed(elapsed)}`;
        };
        tick();
        state.thinkingTimerId = setInterval(tick, 1000);
        // Ensure the latest user message and Thinking… line are visible
        scrollToBottom(body);
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
          .ve-tabs{flex:1;display:flex;gap:8px;overflow:auto;scrollbar-width:none;}
          .ve-tabs::-webkit-scrollbar{display:none;}
          .ve-tab{flex:0 0 auto;max-width:280px;display:flex;align-items:center;gap:8px;padding:6px 26px 6px 10px;border-radius:3px;border:1px solid rgba(17,24,39,0.12);background:#f9fafb;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative;}
          .ve-tab.ve-active{border-color:rgba(37,99,235,0.55);background:#eef2ff;}
          .ve-tab .ve-tab-x{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(17,24,39,0.14);background:#ffffff;color:#111827;border-radius:3px;opacity:0;pointer-events:none;}
          .ve-tab:hover .ve-tab-x{opacity:1;pointer-events:auto;}
          @media (hover: none), (pointer: coarse) { .ve-tab .ve-tab-x{opacity:1;pointer-events:auto;} }
          .ve-tab small{opacity:0.7}
          .ve-body{flex:1;overflow:auto;padding:14px 12px 10px;scrollbar-gutter:stable;position:relative;}
          .ve-footer{position:sticky;bottom:0;z-index:5;border-top:1px solid rgba(17,24,39,0.10);background:#ffffff;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
          .ve-footer-row{display:flex;gap:10px;align-items:flex-end;}
          .ve-footer-row:first-child{flex:1;}
          .ve-footer-row:last-child{flex:0 0 auto;justify-content:space-between;}
          .ve-footer-controls{display:flex;gap:10px;align-items:center;flex:1 1 0;min-width:0;}
          .ve-footer-controls label{white-space:nowrap;font-size:12px;opacity:0.75;flex-shrink:0;}
          .ve-footer-controls .ve-select{flex:0 1 auto;min-width:0;font-size:13px;max-width:200px;}
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
          .ve-assistant-block{cursor:pointer;background:transparent;padding:0;line-height:1.4;}
          .ve-assistant-block:hover{background:transparent;}
          .ve-assistant-block-main{min-width:0;}
          /* Collapsed preview: single line + right-aligned ellipsis */
          .ve-assistant-preview{display:none;position:relative;overflow:hidden;white-space:nowrap;padding-right:14px;}
          .ve-assistant-block.collapsed .ve-assistant-preview::after{content:'…';position:absolute;right:0;top:0;}
          .ve-assistant-full{display:block;}
          .ve-assistant-block.collapsed .ve-assistant-full{display:none;}
          .ve-assistant-block.collapsed .ve-assistant-preview{display:block;}
          .ve-details{border:1px solid rgba(17,24,39,0.12);border-radius:3px;background:#ffffff;overflow:hidden;}
          .ve-details summary{list-style:none;cursor:pointer;padding:10px 12px;display:flex;align-items:center;gap:8px;color:#111827;background:#f9fafb;border-bottom:1px solid rgba(17,24,39,0.08);}
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

      const body = document.createElement('div');
      body.className = 've-body';

      const footer = document.createElement('div');
      footer.className = 've-footer';
      
      const isMobile = () =>
        typeof navigator !== 'undefined' &&
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');

      // Row 1: Textarea
      const row1 = document.createElement('div');
      row1.className = 've-footer-row';
      const ta = document.createElement('textarea');
      ta.className = 've-textarea';
      ta.placeholder = 'Message viib-etch…';
      row1.appendChild(ta);
      
      // Row 2: Model label+selector, Reasoning label+selector, Send button (right-aligned)
      const row2 = document.createElement('div');
      row2.className = 've-footer-row';
      
      // Left side: controls that flex to fit
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
      
      controls.appendChild(modelLabel);
      controls.appendChild(modelSel);
      controls.appendChild(reasoningLabel);
      controls.appendChild(reasoningSel);
      controls.appendChild(btnFolder);
      
      // Right side: send button (fixed, right-aligned)
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
      
      footer.appendChild(row1);
      footer.appendChild(row2);

      root.appendChild(top);
      root.appendChild(body);
      root.appendChild(footer);

      let jumpBtn = null;
      let jumpBtnWrapper = null;
      const ensureJumpBtn = () => {
        if (jumpBtn) return jumpBtn;
        jumpBtnWrapper = document.createElement('div');
        jumpBtnWrapper.style.cssText = 'position:sticky;bottom:10px;display:flex;justify-content:flex-end;margin-top:10px;z-index:1;';
        jumpBtn = document.createElement('button');
        jumpBtn.className = 've-jump';
        jumpBtn.textContent = '▼';
        jumpBtn.style.cssText = 'position:static;margin:0;';
        jumpBtn.addEventListener('click', () => scrollToBottom(body));
        jumpBtnWrapper.appendChild(jumpBtn);
        body.appendChild(jumpBtnWrapper);
        return jumpBtn;
      };
      const hideJumpBtn = () => {
        if (jumpBtnWrapper && jumpBtnWrapper.parentNode) {
          jumpBtnWrapper.parentNode.removeChild(jumpBtnWrapper);
        }
        jumpBtn = null;
        jumpBtnWrapper = null;
      };

      let autoScrollArmed = true;
      body.addEventListener('scroll', () => {
        autoScrollArmed = shouldAutoScroll(body);
        if (autoScrollArmed) hideJumpBtn();
        else ensureJumpBtn();
      });

      const toolUiKey = (toolCallId) => `tool:${String(toolCallId)}`;
      const reasoningKey = (idx) => `reasoning:${String(idx)}`;
      const responseKey = (idx) => `response:${String(idx)}`;

      const isCollapsedByUser = (key) => state.collapsedByUser.has(key);
      const setCollapsedByUser = (key, collapsed) => {
        if (collapsed) state.collapsedByUser.add(key);
        else state.collapsedByUser.delete(key);
      };

      const renderTabs = () => {
        tabs.innerHTML = '';
        for (const c of state.chats) {
          const el = document.createElement('div');
          el.className = 've-tab' + (state.chatId === c.id ? ' ve-active' : '');
          const title = c.title || 'New Chat';
          el.innerHTML = `<span>${escapeHtml(title)}</span><button class="ve-tab-x" title="Delete" aria-label="Delete">x</button>`;
          el.addEventListener('click', () => openChatId(c.id));
          const xbtn = el.querySelector('.ve-tab-x');
          if (xbtn) {
            xbtn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              deleteChatId(c.id).catch((err) => alert(String(err && err.message ? err.message : err)));
            });
          }
          tabs.appendChild(el);
        }
      };

      const renderModels = () => {
        modelSel.innerHTML = '';
        for (const m of state.models) {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = m.name;
          modelSel.appendChild(opt);
        }
        const sel = getSelectedModel();
        if (sel) modelSel.value = sel;
      };

      const renderReasoningEffort = () => {
        reasoningSel.innerHTML = '';
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
          reasoningSel.appendChild(el);
        }
        const sel = getSelectedReasoningEffort();
        reasoningSel.value = sel;
      };

      const setRunning = (running) => {
        state.running = !!running;
        // Single action button:
        // - idle: ▲ send
        // - running: ■ stop/cancel
        btnAction.textContent = state.running ? '■' : '▲';
        btnAction.title = state.running ? 'Stop' : 'Send';
        btnAction.setAttribute('aria-label', state.running ? 'Stop' : 'Send');
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

      const renderChat = async (chat, replayMode) => {
        body.innerHTML = '';
        hideJumpBtn();

        if (!chat) {
          const empty = document.createElement('div');
          empty.className = 've-muted';
          empty.textContent = 'No chat selected.';
          body.appendChild(empty);
          return;
        }

        const assistantTools = groupToolOutputsForReplay(chat);

        const messages = chat.messages || [];
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg || !msg.role) continue;

          if (msg.role === 'user') {
            const wrap = document.createElement('div');
            wrap.className = 've-msg ve-user';
            wrap.innerHTML = `<div class="ve-bubble"><pre>${escapeHtml(msg.content || '')}</pre></div>`;
            body.appendChild(wrap);
            continue;
          }

          if (msg.role === 'assistant') {
            // Skip assistant blocks that only have tool calls (no content, no reasoning)
            const hasContent = msg.content && String(msg.content).trim();
            const hasReasoning = msg.reasoning && String(msg.reasoning).trim();
            const toolArr = assistantTools.get(i) || [];
            const hasOnlyTools = !hasContent && !hasReasoning && toolArr.length > 0;
            
            if (hasOnlyTools) {
              continue; // Skip this assistant block for now
            }

            const wrap = document.createElement('div');
            wrap.className = 've-msg ve-assistant';

            // Combined assistant block (response + reasoning in one) 
            const rk = responseKey(i);
            const isCollapsed = isCollapsedByUser(rk);
            const block = document.createElement('div');
            block.className = 've-assistant-block' + (isCollapsed ? ' collapsed' : '');

            const main = document.createElement('div');
            main.className = 've-assistant-block-main';

            const preview = document.createElement('div');
            preview.className = 've-assistant-preview';
            preview.textContent = firstLine(msg.content || msg.reasoning || '(no content)') || '(no content)';
            main.appendChild(preview);

            const full = document.createElement('div');
            full.className = 've-assistant-full';

            block.addEventListener('click', () => {
              const collapsed = block.classList.toggle('collapsed');
              setCollapsedByUser(rk, collapsed);
            });
            
            const content = document.createElement('div');
            content.className = 've-assistant-block-content';
            
            // Response content
            if (msg.content) {
              const respDiv = document.createElement('div');
              respDiv.className = 've-md';
              respDiv.setAttribute('data-md', 'response');
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

            body.appendChild(wrap);

            // Render markdown (lazy-ish but minimal)
            const respMd = wrap.querySelector('[data-md="response"]');
            if (respMd && msg.content) {
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
        scrollToBottom(body);
        autoScrollArmed = true;
      };

      // ----------------------------
      // Live incremental rendering
      // ----------------------------
      const liveEnsureAssistantCycle = (cycleId) => {
        const cid = String(cycleId || '');
        if (!cid) return null;
        let c = state.live.cycles.get(cid);
        if (c) return c;

        // Create a new assistant block in the stream
        const wrap = document.createElement('div');
        wrap.className = 've-msg ve-assistant';

        const block = document.createElement('div');
        block.className = 've-assistant-block';

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

        body.appendChild(wrap);

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

        // Track user collapse/expand for live blocks
        block.addEventListener('click', () => {
          const wasCollapsed = block.classList.contains('collapsed');
          block.classList.toggle('collapsed');
          // If user explicitly opened while running, treat as pinned (don't auto-collapse).
          if (state.live.running && wasCollapsed) c.reasoningPinnedOpen = true;
        });
        state.live.cycles.set(cid, c);
        return c;
      };

      const liveEnsureReasoningPanel = (cycleId) => {
        const c = liveEnsureAssistantCycle(cycleId);
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

      const liveAutoScrollIfArmed = () => {
        if (autoScrollArmed) {
          scrollToBottom(body);
        } else {
          ensureJumpBtn();
        }
      };

      const scheduleMarkdownRender = (key, mdText, targetEl) => {
        if (!targetEl) return;
        // Throttle to avoid hammering server during streaming
        const k = String(key);
        const existing = state.live.mdTimers.get(k);
        if (existing) return;
        const timer = setTimeout(async () => {
          state.live.mdTimers.delete(k);
          const html = (await renderMarkdownViaServer(mdText)) || renderMarkdownFallback(mdText);
          targetEl.innerHTML = html;
          liveAutoScrollIfArmed();
        }, 250);
        state.live.mdTimers.set(k, timer);
      };

      const liveAppendUserMessage = (content) => {
        const wrap = document.createElement('div');
        wrap.className = 've-msg ve-user';
        wrap.innerHTML = `<div class="ve-bubble"><pre>${escapeHtml(content || '')}</pre></div>`;
        body.appendChild(wrap);
        liveAutoScrollIfArmed();
        if (state.running) {
          startThinking();
        }
      };

      const liveEnsureToolBlock = (cycleId, toolCallId, name, args) => {
        const c = liveEnsureAssistantCycle(cycleId);
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
        });
        c.toolBlocks.set(tid, tb);
        return tb;
      };

      const liveUpdateToolBlock = async (tb) => {
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
          liveAutoScrollIfArmed();
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
          const { title, bodyHtml } = await renderTool(state.chat || { data: {} }, fakeTc, fakeToolMsg);
          if (tb.detailsEl && title) {
            const summaryEl = tb.detailsEl.querySelector('summary');
            if (summaryEl) summaryEl.textContent = title;
          }
          tb.bodyEl.innerHTML = bodyHtml;
          wireToolTabs(tb.bodyEl);
          // For run_terminal_cmd: collapse after done (it auto-expanded while streaming).
          if (tb.detailsEl && tb.name === 'run_terminal_cmd') {
            tb.detailsEl.open = false;
          }
          liveAutoScrollIfArmed();
          return;
        }
      };

      const refreshChats = async () => {
        state.chats = await apiFetch('/chats');
        renderTabs();
      };

      const deleteChatId = async (chatId) => {
        const id = String(chatId);
        // Basic confirmation (single click can be dangerous)
        if (!confirm('Delete this chat?')) return;
        await apiFetch(`/chat/${encodeURIComponent(id)}`, { method: 'DELETE' });
        // If we deleted current chat, switch to next available
        const wasCurrent = state.chatId === id;
        await refreshChats();
        if (wasCurrent) {
          state.chatId = null;
          state.chat = null;
          if (state.chats.length > 0) await openChatId(state.chats[0].id);
          else {
            body.innerHTML = `<div class="ve-muted">No chats.</div>`;
          }
        }
      };

      const refreshModels = async () => {
        state.models = await apiFetch('/models');
        renderModels();
      };

      const openChatId = async (chatId) => {
        state.chatId = String(chatId);
        localStorage.setItem(options.chatStorageKey, state.chatId);
        renderTabs();
        state.chat = await apiFetch(`/chat/${encodeURIComponent(state.chatId)}`);
        await renderChat(state.chat, true);
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
      const openBaseDirModal = () => {
        if (!state.chatId) {
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
        if (baseDirInput) baseDirInput.value = (state.chat && state.chat.base_dir) ? String(state.chat.base_dir) : '';

        const close = () => {
          try { document.body.removeChild(backdrop); } catch {}
        };

        const save = async () => {
          const val = baseDirInput ? String(baseDirInput.value || '').trim() : '';
          const payload = { base_dir: val ? val : null };
          await apiFetch(`/chat/${encodeURIComponent(state.chatId)}/base_dir`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          // Refresh current chat (so state.chat.base_dir is updated for New Chat inheritance)
          state.chat = await apiFetch(`/chat/${encodeURIComponent(state.chatId)}`);
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

      const closeSSE = () => {
        if (state.sse) {
          try { state.sse.close(); } catch {}
          state.sse = null;
        }
      };

      const ensureSSE = () => {
        closeSSE();
        if (!state.chatId) return;
        const t = getToken();
        const url =
          (options.apiBase || '').replace(/\/+$/, '') +
          `/chat/${encodeURIComponent(state.chatId)}/events` +
          (t ? `?token=${encodeURIComponent(t)}` : '');
        const ev = new EventSource(url);
        state.sse = ev;
        ev.addEventListener('run.start', () => {
          state.live.running = true;
          setRunning(true);
        });
        ev.addEventListener('cycle.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            state.live.currentCycleId = data.cycle_id || null;
            liveEnsureAssistantCycle(state.live.currentCycleId);
            liveAutoScrollIfArmed();
          } catch {}
        });
        ev.addEventListener('chat.user', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const content = String(data.content || '');
            if (state.live.pendingUserEcho && state.live.pendingUserEcho === content) {
              state.live.pendingUserEcho = null;
              return;
            }
            stopThinking();
            liveAppendUserMessage(content);
          } catch {}
        });
        ev.addEventListener('assistant.reasoning.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = liveEnsureReasoningPanel(data.cycle_id || state.live.currentCycleId);
            if (!c) return;
            if (c.respDetails) c.respDetails.classList.remove('collapsed');
            liveAutoScrollIfArmed();
          } catch {}
        });
        ev.addEventListener('assistant.reasoning.delta', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking();
            const c = liveEnsureReasoningPanel(data.cycle_id || state.live.currentCycleId);
            if (!c) return;
            c.reasonText += String(data.delta || '');
            if (c.respDetails) {
              c.respDetails.classList.remove('collapsed');
            }
            if (c.respPreviewEl) {
              c.respPreviewEl.textContent = firstLine(c.respText || c.reasonText || '…') || '…';
            }
            scheduleMarkdownRender(`reason:${data.cycle_id}`, c.reasonText, c.reasonMdEl);
          } catch {}
        });
        ev.addEventListener('assistant.reasoning.done', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = state.live.cycles.get(String(data.cycle_id || ''));
            if (!c) return;
            // render final markdown
            scheduleMarkdownRender(`reason:${data.cycle_id}`, c.reasonText, c.reasonMdEl);
          } catch {}
        });
        ev.addEventListener('assistant.response.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = liveEnsureAssistantCycle(data.cycle_id || state.live.currentCycleId);
            if (!c) return;
            c.respDetails.classList.remove('collapsed');
            liveAutoScrollIfArmed();
          } catch {}
        });
        ev.addEventListener('assistant.response.delta', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking();
            const c = liveEnsureAssistantCycle(data.cycle_id || state.live.currentCycleId);
            if (!c) return;
            c.respText += String(data.delta || '');
            if (c.respPreviewEl) {
              c.respPreviewEl.textContent = firstLine(c.respText || c.reasonText || '(streaming…)') || '(streaming…)';
            }
            scheduleMarkdownRender(`resp:${data.cycle_id}`, c.respText, c.respMdEl);
          } catch {}
        });
        ev.addEventListener('assistant.response.done', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            const c = state.live.cycles.get(String(data.cycle_id || ''));
            if (!c) return;
            scheduleMarkdownRender(`resp:${data.cycle_id}`, c.respText, c.respMdEl);
          } catch {}
        });
        ev.addEventListener('tool.start', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking();
            const tb = liveEnsureToolBlock(data.cycle_id || state.live.currentCycleId, data.id, data.name, data.args);
            if (!tb) return;
            tb.running = true;
            // Title will be set once result is available via renderTool; avoid temporary "Running" suffix.
            liveAutoScrollIfArmed();
          } catch {}
        });
        ev.addEventListener('tool.data', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking();
            const tb = liveEnsureToolBlock(data.cycle_id || state.live.currentCycleId, data.id, data.name, null);
            if (!tb) return;
            const d = data.data || {};
            if (d.phase === 'stream' && typeof d.data === 'string') {
              tb.outText += d.data;
              liveUpdateToolBlock(tb).catch(() => {});
              return;
            }
            if (d.phase === 'result') {
              tb.result = d.result;
              liveUpdateToolBlock(tb).catch(() => {});
              return;
            }
          } catch {}
        });
        ev.addEventListener('tool.end', (e) => {
          try {
            const data = JSON.parse(e.data || '{}');
            stopThinking();
            const c = state.live.cycles.get(String(data.cycle_id || '')) || null;
            const tb = c ? c.toolBlocks.get(String(data.id || '')) : null;
            if (!tb) return;
            tb.running = false;
            // If backend provided an enriched final result on tool.end, update and re-render.
            if (data && data.result !== undefined && data.result !== null) {
              tb.result = data.result;
              liveUpdateToolBlock(tb).catch(() => {});
            }
            // For run_terminal_cmd, explicitly mark as Ran and collapse once done.
            if (tb.name === 'run_terminal_cmd' && tb.detailsEl) {
              const sum = tb.detailsEl.querySelector('summary');
              if (sum) sum.textContent = 'Ran';
              tb.detailsEl.open = false;
            } else {
              // Other tools: collapse once done unless user left it open intentionally
              if (!tb.openedByUser && tb.detailsEl) tb.detailsEl.open = false;
            }
            liveAutoScrollIfArmed();
          } catch {}
        });
        ev.addEventListener('run.done', async () => {
          state.live.running = false;
          setRunning(false);
          stopThinking();
          // Refresh tabs so title changes show up
          refreshChats().catch(() => {});
        });
        ev.addEventListener('run.error', (e) => {
          setRunning(false);
          stopThinking();
          console.error('run.error', e && e.data);
        });
      };

      const sendMessage = async () => {
        const text = ta.value;
        if (!String(text || '').trim() || !state.chatId) return;
        const model_name = getSelectedModel();
        const reasoning_effort = getSelectedReasoningEffort();
        const params = { message: text, model_name };
        if (reasoning_effort && reasoning_effort !== 'default') {
          params.reasoning_effort = reasoning_effort;
        }
        setRunning(true);
        ensureSSE();
        ta.value = '';
        autoResizeTextarea();
        // Optimistically show the user message immediately during live.
        state.live.pendingUserEcho = String(text);
        liveAppendUserMessage(String(text));
        try {
          await apiFetch(`/chat/${encodeURIComponent(state.chatId)}/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
          });
        } catch (e) {
          setRunning(false);
          alert(String(e && e.message ? e.message : e));
        }
      };

      const cancelRun = async () => {
        if (!state.chatId) return;
        try {
          await apiFetch(`/chat/${encodeURIComponent(state.chatId)}/cancel`, {
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
              ensureSSE();
            }
          }
          if (apiBaseInput) {
            const newApiBase = String(apiBaseInput.value || '/api');
            if (newApiBase !== options.apiBase) {
              options.apiBase = newApiBase;
              refreshModels().catch(() => {});
              refreshChats().catch(() => {});
              ensureSSE();
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
          // Reconnect SSE with new token
          ensureSSE();
        });
        apiBaseInput.addEventListener('change', () => {
          options.apiBase = String(apiBaseInput.value || '/api');
          // Refresh data using new base
          refreshModels().catch(() => {});
          refreshChats().catch(() => {});
          ensureSSE();
        });
      };

      btnConfig.addEventListener('click', openConfigModal);
      btnNew.addEventListener('click', () => createNewChat().catch((e) => alert(String(e.message || e))));
      modelSel.addEventListener('change', () => setSelectedModel(modelSel.value));
      reasoningSel.addEventListener('change', () => setSelectedReasoningEffort(reasoningSel.value));
      btnFolder.addEventListener('click', openBaseDirModal);
      btnAction.addEventListener('click', () => {
        if (state.running) cancelRun();
        else sendMessage();
      });

      const autoResizeTextarea = () => {
        // Reset height to measure scrollHeight from the intrinsic content size
        ta.style.height = 'auto';
        const maxPx = Math.floor(window.innerHeight * 0.5);
        const next = Math.min(ta.scrollHeight, maxPx);
        ta.style.height = next + 'px';
      };

      ta.addEventListener('input', autoResizeTextarea);
      // Initialize height
      autoResizeTextarea();

      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          // On mobile (iOS/Android/etc.), never treat Enter as send; always insert newline.
          if (isMobile()) return;

          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            // Shift+Enter, Ctrl+Enter, or Cmd+Enter: allow newline (default behavior)
            return;
          }

          // Desktop: Enter alone sends the message.
          e.preventDefault();
          if (!state.running) sendMessage();
        }
      });

      // Initial load
      (async () => {
        try {
          // If token isn't set, prompt immediately (CLI/server enforces auth).
          if (!getToken()) {
            body.innerHTML = `<div class="ve-muted">Token required. Click ⚙ and paste a token from <code>.viib-etch-tokens</code>.</div>`;
            openConfigModal();
            return;
          }
          await refreshModels();
          renderReasoningEffort();
          await refreshChats();
          const remembered = localStorage.getItem(options.chatStorageKey);
          if (remembered) {
            await openChatId(remembered);
          } else if (state.chats.length > 0) {
            await openChatId(state.chats[0].id);
          }
          ensureSSE();
        } catch (e) {
          body.innerHTML = `<div class="ve-muted">Failed to load: ${escapeHtml(e && e.message ? e.message : String(e))}</div>`;
        }
      })();

      setRunning(false);
      return {
        destroy: () => {
          closeSSE();
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

    function createViibEtchUI(options) {
      const opts = options || {};
      const basePath = (opts.basePath || '').replace(/\/+$/, '');
      const uiPath = basePath + (opts.uiPath || '/');
      const apiBase = basePath + (opts.apiPath || '/api');
      const uiJsPath = basePath + (opts.uiJsPath || '/viib-etch-ui.js');
      const token = opts.token || process.env.VIIB_ETCH_UI_TOKEN || '';
      const tokensFile = opts.tokensFile || process.env.VIIB_ETCH_TOKENS_FILE || '.viib-etch-tokens';
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

