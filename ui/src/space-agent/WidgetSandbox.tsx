import React, { useRef, useEffect, useState } from 'react';
import type { Widget, WidgetMessage, WidgetResponse } from './types';

interface Props {
  widget: Widget;
  onRemove: (id: string) => void;
}

export const WidgetSandbox: React.FC<Props> = ({ widget, onRemove }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const html = buildWidgetHTML(widget.code, widget.title);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    iframe.src = url;

    const handleMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      const msg = e.data as WidgetMessage;
      handleWidgetMessage(msg, iframe);
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      URL.revokeObjectURL(url);
    };
  }, [widget.code, widget.title]);

  const handleWidgetMessage = async (msg: WidgetMessage, iframe: HTMLIFrameElement) => {
    const response: WidgetResponse = { type: 'log', id: msg.id };

    try {
      switch (msg.type) {
        case 'fetch': {
          const res = await fetch(msg.payload.url, msg.payload.options);
          const data = await res.json().catch(() => res.text());
          response.type = 'fetchResponse';
          response.payload = { status: res.status, data };
          break;
        }
        case 'setState':
          response.type = 'stateChange';
          response.payload = { success: true };
          break;
        case 'getState':
          response.type = 'stateChange';
          response.payload = {};
          break;
        case 'log':
          console.log(`[Widget ${widget.id}]`, msg.payload);
          break;
        case 'error':
          console.error(`[Widget ${widget.id}]`, msg.payload);
          setError(String(msg.payload));
          break;
      }
    } catch (err) {
      response.type = 'error';
      response.error = String(err);
    }

    iframe.contentWindow?.postMessage(response, '*');
  };

  return (
    <div className="relative w-full h-full rounded-lg overflow-hidden border border-gray-700 bg-[#0f1117]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800/50 border-b border-gray-700">
        <span className="text-xs font-medium text-gray-300 truncate">{widget.title}</span>
        <button
          onClick={() => onRemove(widget.id)}
          className="text-gray-500 hover:text-red-400 transition-colors text-xs px-1"
        >
          ×
        </button>
      </div>

      {/* Sandbox */}
      {error ? (
        <div className="p-3 text-xs text-red-400">{error}</div>
      ) : (
        <iframe
          ref={iframeRef}
          className="w-full h-full"
          style={{ border: 'none', minHeight: '120px' }}
          sandbox="allow-scripts"
          title={widget.title}
        />
      )}
    </div>
  );
};

function buildWidgetHTML(code: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <script crossorigin src="https://unpkg.com/react@19/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@19/umd/react-dom.development.js"></script>
  <style>
    body { margin: 0; padding: 0; background: #0f1117; color: #e5e7eb; font-family: system-ui, sans-serif; }
    * { box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    const space = {
      fetch: (url, options) => {
        return new Promise((resolve, reject) => {
          const id = Math.random().toString(36).slice(2);
          const handler = (e) => {
            if (e.data.type === 'fetchResponse' && e.data.id === id) {
              window.removeEventListener('message', handler);
              if (e.data.error) reject(new Error(e.data.error));
              else resolve({ status: e.data.payload.status, json: () => Promise.resolve(e.data.payload.data) });
            }
          };
          window.addEventListener('message', handler);
          window.parent.postMessage({ type: 'fetch', id, payload: { url, options } }, '*');
        });
      },
      setState: (key, value) => {
        window.parent.postMessage({ type: 'setState', id: key, payload: value }, '*');
      },
      getState: (key) => {
        return new Promise((resolve) => {
          const id = Math.random().toString(36).slice(2);
          const handler = (e) => {
            if (e.data.type === 'stateChange' && e.data.id === id) {
              window.removeEventListener('message', handler);
              resolve(e.data.payload);
            }
          };
          window.addEventListener('message', handler);
          window.parent.postMessage({ type: 'getState', id, payload: { key } }, '*');
        });
      },
      log: (...args) => {
        window.parent.postMessage({ type: 'log', id: 'log', payload: args }, '*');
      }
    };

    try {
      ${code}
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(Widget, { space }));
    } catch (err) {
      document.getElementById('root').innerHTML = '<div style="padding:12px;color:#ef4444;font-size:12px">Widget error: ' + err.message + '</div>';
      window.parent.postMessage({ type: 'error', id: 'init', payload: err.message }, '*');
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
