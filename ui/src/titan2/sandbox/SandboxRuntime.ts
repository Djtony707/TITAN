/**
 * TITAN Sandbox Runtime v2
 * Hardened iframe sandbox for widget rendering and code execution.
 *
 * Architecture:
 * - iframe.srcdoc injects HTML directly (no blob URLs)
 * - Loads React 18 UMD + ReactDOM 18 UMD + Babel standalone from local / paths
 * - Babel transforms JSX (classic runtime) inside the iframe
 * - Evals compiled code via new Function() to return the component
 * - Renders via ReactDOM.createRoot
 *
 * Critical design decisions:
 * - No prototype freezing (Babel mutates Function.prototype.toString during JSX transform)
 * - No regex literals inside SANDBOX_TEMPLATE (Vite strips invalid escapes like \s → s)
 *   Use new RegExp('pattern') with 4-backslash escaping in TS source instead.
 * - srcdoc instead of blob: Chrome blocks blob: in sandboxed iframes without allow-same-origin
 */

import type { SandboxMessage } from '../types';

const SANDBOX_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; font-src data:;">
  <script src="/react.development.js"></script>
  <script src="/react-dom.development.js"></script>
  <script src="/babel.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; }
    body { background: transparent; color: #e5e7eb; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; overflow: hidden; }
    #root { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="root">
    <div id="sandbox-loading" style="padding:16px;font-family:monospace;font-size:12px;color:#52525b;">
      <div>Loading sandbox scripts…</div>
      <div style="margin-top:4px;font-size:10px;color:#3f3f46;">React + ReactDOM + Babel (local)</div>
    </div>
  </div>
  <script>
    (function() {
      'use strict';

      // NOTE: Prototype freezing is intentionally disabled.
      // Babel standalone mutates Function.prototype.toString during JSX transform.
      // Freezing causes "Cannot assign to read only property" errors.

      // Prevent eval and Function constructor abuse
      window.eval = function() { throw new Error('eval is disabled in sandbox'); };
      const OriginalFunction = window.Function;
      window.Function = function(...args) {
        const body = args.pop() || '';
        if (body.includes('import') && body.includes('http')) {
          throw new Error('Dynamic imports with URLs are disabled in sandbox');
        }
        return OriginalFunction.apply(this, [...args, body]);
      };

      const pending = new Map();
      let msgId = 0;
      let reactRoot = null;

      function send(type, payload) {
        const id = ++msgId;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          window.parent.postMessage({ type, id, payload }, '*');
        });
      }

      window.addEventListener('message', (e) => {
        // Resolve pending iframe promises (parent responses to titan.* calls)
        if (typeof e.data?.id === 'number' && pending.has(e.data.id)) {
          const p = pending.get(e.data.id);
          pending.delete(e.data.id);
          if (e.data.error) p.reject(new Error(e.data.error));
          else p.resolve(e.data.payload);
          return;
        }

        // Handle parent commands
        if (e.data?.type === 'render') {
          handleRender(e.data.id, e.data.payload);
        }
        if (e.data?.type === 'execute') {
          handleExecute(e.data.id, e.data.payload);
        }
      });

      const titan = {
        fetch: (url, opts) => {
          try { new URL(url, 'https://example.com'); } catch {
            throw new Error('Invalid URL: ' + url);
          }
          return send('fetch', { url, options: opts });
        },
        api: { call: (endpoint, body) => send('api', { endpoint, body }) },
        state: {
          get: (key) => send('state', { action: 'get', key }),
          set: (key, value) => send('state', { action: 'set', key, value }),
        },
        canvas: {
          createWidget: (def) => send('canvas', { action: 'createWidget', def }),
          updateWidget: (id, patch) => send('canvas', { action: 'updateWidget', id, patch }),
          removeWidget: (id) => send('canvas', { action: 'removeWidget', id }),
          listWidgets: () => send('canvas', { action: 'listWidgets' }),
        },
        log: (...args) => send('log', { args: args.map(a => String(a)) }),
      };

      window.titan = titan;

      function handleRender(msgId, payload) {
        const { format, source } = payload;
        const root = document.getElementById('root');
        root.innerHTML = '';
        const loadingEl = document.getElementById('sandbox-loading');
        if (loadingEl) loadingEl.style.display = 'none';

        // Unmount previous React root to prevent memory leaks
        if (reactRoot) {
          try { reactRoot.unmount(); } catch (e) {}
          reactRoot = null;
        }

        function showError(title, detail) {
          root.innerHTML = '';
          const wrap = document.createElement('div');
          wrap.style.cssText = 'padding:16px;font-family:monospace;font-size:12px;line-height:1.5;';
          const h = document.createElement('div');
          h.style.cssText = 'color:#ef4444;font-weight:bold;margin-bottom:8px;';
          h.textContent = title;
          const d = document.createElement('pre');
          d.style.cssText = 'color:#a1a1aa;white-space:pre-wrap;word-break:break-word;margin:0;';
          d.textContent = detail;
          wrap.appendChild(h);
          wrap.appendChild(d);
          root.appendChild(wrap);
        }

        try {
          if (format === 'react') {
            console.log('[sandbox] render react, source length:', source.length);
            if (!source || source.trim() === '') {
              throw new Error('Source is empty');
            }
            if (typeof React === 'undefined') {
              throw new Error('React not loaded. The /react.development.js script may have failed to load.');
            }
            if (typeof ReactDOM === 'undefined') {
              throw new Error('ReactDOM not loaded. The /react-dom.development.js script may have failed to load.');
            }
            if (typeof Babel === 'undefined') {
              throw new Error('Babel standalone not loaded. The /babel.min.js script may have failed to load.');
            }

            // ── 1. Strip export-default variations so Babel doesn't choke ──
            // Using simple string operations (no regex backslashes) to avoid Vite stripping
            let src = source;
            const lines = src.split('\\n');
            const outLines = [];
            for (let i = 0; i < lines.length; i++) {
              let line = lines[i];
              const trimmed = line.trim();
              if (trimmed.startsWith('export default function ')) {
                const rest = trimmed.slice('export default function '.length);
                const name = rest.split('(')[0].trim();
                line = '/* export default function ' + name + ' */ function ' + rest;
              } else if (trimmed.startsWith('export default class ')) {
                const rest = trimmed.slice('export default class '.length);
                const name = rest.split(' ')[0].trim().split('{')[0].trim();
                line = '/* export default class ' + name + ' */ class ' + rest;
              } else if (trimmed.startsWith('export default ')) {
                line = '/* export default */';
              }
              outLines.push(line);
            }
            src = outLines.join('\\n');

            // ── 2. Detect candidate component names ──
            const detected = new Set();
            const srcLines = src.split('\\n');
            const keywords = ['function ', 'const ', 'let ', 'var ', 'class '];
            for (let i = 0; i < srcLines.length; i++) {
              const trimmed = srcLines[i].trimStart();
              for (let k = 0; k < keywords.length; k++) {
                const kw = keywords[k];
                if (trimmed.startsWith(kw)) {
                  const after = trimmed.slice(kw.length);
                  const endIdx = after.search(/[\\s\\(=]/);
                  const name = endIdx > 0 ? after.slice(0, endIdx) : after;
                  if (name.length > 0 && name[0] >= 'A' && name[0] <= 'Z') {
                    detected.add(name);
                  }
                }
              }
            }

            const names = ['Widget', ...Array.from(detected)];
            console.log('[sandbox] detected names:', names.join(', '));

            // ── 3. Babel transform (JSX only, classic runtime → React.createElement) ──
            let code;
            try {
              const babelResult = Babel.transform(src, { presets: [['react', { runtime: 'classic' }]], filename: 'widget.tsx' });
              code = babelResult.code;
              console.log('[sandbox] babel ok, code length:', code.length);
            } catch (babelErr) {
              throw new Error('Babel transform failed: ' + babelErr.message);
            }

            // ── 3.5 Auto-inject React hooks so widgets work with bare hook names
            // (LLMs often write useState instead of React.useState).
            const hookDecl = 'const { useState, useEffect, useRef, useCallback, useMemo, useContext, useReducer, useLayoutEffect, useId, useTransition, useDeferredValue, useImperativeHandle, useDebugValue, useSyncExternalStore } = React;';
            code = hookDecl + '\\n' + code;

            // ── 4. Eval the code and find the component ──
            const returnChecks = names.map(n =>
              'if (typeof ' + n + ' !== "undefined" && ' + n + ' != null) return ' + n + ';'
            ).join('\\n') + '\\nreturn undefined;';

            let Widget;
            try {
              const fn = new Function('React', 'ReactDOM', 'titan', code + '\\n' + returnChecks);
              Widget = fn(React, ReactDOM, titan);
              console.log('[sandbox] eval ok, Widget type:', typeof Widget, 'name:', Widget?.name || Widget?.displayName || 'n/a');
            } catch (evalErr) {
              throw new Error('Eval failed: ' + evalErr.message + '\\nDetected names: ' + names.join(', '));
            }

            if (!Widget) {
              throw new Error('No React component found. Detected names: ' + names.join(', ') + '. The code must define a capitalized component (e.g., function Widget() {}).');
            }

            // ── 5. Render ──
            try {
              reactRoot = ReactDOM.createRoot(root);
              reactRoot.render(React.createElement(Widget, { titan }));
              console.log('[sandbox] react render dispatched');
            } catch (renderErr) {
              throw new Error('React render failed: ' + renderErr.message);
            }
          } else if (format === 'vanilla') {
            const fn = new Function('container', 'titan', 'return (' + source + ')(container, titan)');
            const cleanup = fn(root, titan);
            window.__widgetCleanup = cleanup;
          } else if (format === 'html') {
            root.innerHTML = source;
          }
          window.parent.postMessage({ type: 'rendered', id: msgId }, '*');
        } catch (err) {
          console.error('[sandbox] render error:', err.name, err.message);
          showError(err.name + ': ' + err.message, err.stack || '');
          window.parent.postMessage({ type: 'error', id: msgId, error: err.message }, '*');
        }
      }

      function handleExecute(msgId, payload) {
        const { code } = payload;
        const logs = [];
        const originals = {};
        ['log','info','warn','error','debug'].forEach(m => {
          originals[m] = console[m];
          console[m] = (...args) => {
            logs.push({ level: m, text: args.map(a => String(a)).join(' ') });
            originals[m](...args);
          };
        });

        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

        // Shadow dangerous globals so sandboxed code cannot access them directly.
        const forbiddenGlobals = [
          'window','globalThis','self','top','parent','document','location',
          'fetch','XMLHttpRequest','WebSocket','EventSource',
          'localStorage','sessionStorage','indexedDB','navigator','history',
        ];

        const runner = new AsyncFunction(
          ...forbiddenGlobals,
          '__titan',
          '"use strict";\\n' +
          forbiddenGlobals.map(g => 'const ' + g + ' = undefined;').join('\\n') + '\\n' +
          code
        );

        (async () => {
          try {
            const result = await runner(...forbiddenGlobals.map(() => undefined), titan);
            Object.keys(originals).forEach(m => console[m] = originals[m]);
            window.parent.postMessage({ type: 'result', id: msgId, payload: { status: 'success', logs, result: formatValue(result), resultText: formatValue(result) } }, '*');
          } catch (err) {
            Object.keys(originals).forEach(m => console[m] = originals[m]);
            window.parent.postMessage({ type: 'result', id: msgId, payload: { status: 'error', logs, error: { message: err.message, name: err.name, stack: err.stack } } }, '*');
          }
        })();
      }

      function formatValue(v) {
        if (v === undefined) return 'undefined';
        if (v === null) return 'null';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (typeof v === 'function') return '[Function]';
        if (v instanceof Error) return v.stack || v.message;
        if (v instanceof Node) return '<' + v.tagName?.toLowerCase() + '>';
        try { return JSON.stringify(v); } catch { return String(v); }
      }

      window.parent.postMessage({ type: 'ready' }, '*');
    })();
  </script>
</body>
</html>`;

export class SandboxRuntime {
  private iframe: HTMLIFrameElement | null = null;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private msgId = 0;
  private ready = false;
  private readyQueue: (() => void)[] = [];
  private onLog?: (logs: any[]) => void;
  private messageHandler?: (msg: { type: string; payload?: any }) => Promise<any> | any;
  private messageListener?: (e: MessageEvent) => void;
  private observer?: MutationObserver;

  constructor(iframe: HTMLIFrameElement, options?: { onLog?: (logs: any[]) => void }) {
    this.iframe = iframe;
    this.onLog = options?.onLog;
    this.init();
  }

  private init() {
    const iframe = this.iframe!;
    iframe.srcdoc = SANDBOX_TEMPLATE;

    const handler = (e: MessageEvent) => {
      // sandbox="allow-scripts" (no allow-same-origin) gives the iframe an opaque origin.
      // e.source and iframe.contentWindow are different WindowProxy objects, so === fails.
      // We validate by message shape instead.
      const raw = e.data as any;
      if (!raw || typeof raw !== 'object') return;
      if (!raw.type || typeof raw.type !== 'string') return;
      const validTypes = ['ready','rendered','error','result','fetch','api','state','canvas','log','import'];
      if (!validTypes.includes(raw.type)) return;

      if (raw?.type === 'ready') {
        this.ready = true;
        this.readyQueue.forEach(cb => cb());
        this.readyQueue = [];
        return;
      }

      // Parent's own pending promises (rendered, error, result from iframe)
      if (typeof raw?.id === 'number' && this.pending.has(raw.id)) {
        const p = this.pending.get(raw.id)!;
        this.pending.delete(raw.id);
        if (raw.type === 'error') p.reject(new Error(raw.error || 'Sandbox error'));
        else p.resolve(raw.payload);
        return;
      }

      // iframe API calls (fetch, api, state, canvas, log, import)
      if (raw?.type === 'fetch' || raw?.type === 'api' || raw?.type === 'state' || raw?.type === 'canvas' || raw?.type === 'log' || raw?.type === 'import') {
        this.handleIframeRequest(raw.type, raw.id, raw.payload);
        return;
      }
    };

    this.messageListener = handler;
    window.addEventListener('message', handler);

    const observer = new MutationObserver(() => {
      if (!document.contains(iframe)) {
        this.destroy();
      }
    });
    this.observer = observer;
    if (iframe.parentNode) observer.observe(iframe.parentNode, { childList: true, subtree: true });
  }

  private async handleIframeRequest(type: string, id: number, payload: any) {
    const iframe = this.iframe;
    if (!iframe?.contentWindow) return;

    try {
      let result: any;

      if (type === 'log') {
        this.onLog?.(payload?.args || []);
        result = { ok: true };
      } else if (type === 'fetch') {
        const { url, options } = payload || {};
        const token = localStorage.getItem('titan-token');
        const headers: Record<string, string> = { ...(options?.headers || {}) };
        // Only inject auth for same-origin/relative requests so third-party
        // URLs cannot steal the token.
        let injectAuth = false;
        try {
          if (typeof url === 'string') {
            if (url.startsWith('/')) injectAuth = true;
            else {
              const u = new URL(url, window.location.href);
              injectAuth = u.origin === window.location.origin;
            }
          }
        } catch { /* invalid URL — skip auth injection */ }
        if (token && injectAuth) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(url, { ...options, headers });
        const text = await res.text();
        let json = undefined;
        try { json = JSON.parse(text); } catch {}
        result = { ok: res.ok, status: res.status, text, json };
      } else if (type === 'api') {
        const { endpoint, body } = payload || {};
        const token = localStorage.getItem('titan-token');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        // Normalize: widgets may pass '/api/message' or '/message' —
        // ensure exactly one '/api' prefix so we don't 404 on '/api/api/...'.
        let path = typeof endpoint === 'string' ? endpoint : '';
        if (path.startsWith('/api/')) {
          /* already prefixed, keep as-is */
        } else if (path.startsWith('/')) {
          path = '/api' + path;
        } else {
          path = '/api/' + path;
        }
        const res = await fetch(path, {
          method: 'POST',
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = undefined;
        try { json = JSON.parse(text); } catch {}
        result = { ok: res.ok, status: res.status, text, json };
      } else if (type === 'state') {
        const { action, key, value } = payload || {};
        if (action === 'get') {
          const raw = localStorage.getItem('titan:sandbox:' + key);
          result = raw ? JSON.parse(raw) : undefined;
        } else if (action === 'set') {
          localStorage.setItem('titan:sandbox:' + key, JSON.stringify(value));
          result = { ok: true };
        }
      } else if (type === 'canvas') {
        if (this.messageHandler) {
          result = await this.messageHandler({ type, payload });
        } else {
          result = { ok: false, error: 'Canvas operations not configured' };
        }
      } else if (type === 'import') {
        result = { ok: false, error: 'Dynamic imports not supported in sandbox' };
      }

      iframe.contentWindow.postMessage({ type: 'result', id, payload: result }, '*');
    } catch (err: any) {
      iframe.contentWindow.postMessage({ type: 'error', id, error: err.message || String(err) }, '*');
    }
  }

  private whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Sandbox iframe failed to become ready within 30s. React, ReactDOM, or Babel scripts may have failed to load.'));
      }, 30000);
      this.readyQueue.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private post(type: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.whenReady().then(() => {
        this.iframe?.contentWindow?.postMessage({ type, id, payload }, '*');
      }).catch(reject);
    });
  }

  async render(format: 'react' | 'vanilla' | 'html', source: string): Promise<void> {
    await this.post('render', { format, source });
  }

  async execute(code: string): Promise<{ status: string; logs: any[]; result?: any; resultText?: string; error?: any }> {
    return this.post('execute', { code });
  }

  setMessageHandler(handler: (msg: { type: string; payload?: any }) => Promise<any> | any) {
    this.messageHandler = handler;
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = undefined;
    }
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = undefined;
    }
    this.iframe = null;
    this.pending.clear();
    this.readyQueue = [];
    this.ready = false;
    this.messageHandler = undefined;
  }
}
