import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/api/client';

interface PaperclipStatus {
  running: boolean;
  port: number | null;
  healthy: boolean;
  restarts: number;
}

export function PaperclipEmbed() {
  const [status, setStatus] = useState<PaperclipStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const fetchStatus = useCallback(() => {
    apiFetch('/api/paperclip/status')
      .then((r) => r.json())
      .then((data) => { setStatus(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const doAction = async (action: string, method = 'POST', url?: string) => {
    setActionLoading(action);
    setConfirmAction(null);
    try {
      const res = await apiFetch(url || `/api/paperclip/${action}`, { method });
      await res.json();
      // Wait for service to stabilize then refresh
      setTimeout(fetchStatus, action === 'reset' ? 8000 : 3000);
      if (action === 'reset' || action === 'stop') {
        // Force iframe reload after reset/restart
        setTimeout(() => {
          if (iframeRef.current) iframeRef.current.src = iframeRef.current.src;
        }, action === 'reset' ? 10000 : 4000);
      }
    } catch { /* status refresh will show state */ }
    finally { setActionLoading(null); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent mx-auto mb-3" />
          <p className="text-sm text-text-muted">Connecting to Paperclip...</p>
        </div>
      </div>
    );
  }

  if (!status?.running || !status?.healthy) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="text-4xl mb-3">📎</div>
          <h3 className="text-lg font-semibold text-text mb-2">Paperclip Not Available</h3>
          <p className="text-sm text-text-muted mb-4">
            The Paperclip sidecar is not running.
          </p>
          <button
            onClick={() => doAction('start')}
            disabled={!!actionLoading}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {actionLoading === 'start' ? 'Starting...' : 'Start Paperclip'}
          </button>
          {status && status.restarts > 0 && (
            <p className="text-xs text-error mt-3">
              Paperclip crashed {status.restarts} time(s).
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-1 pb-2 border-b border-border mb-0">
        <span className="text-lg">📎</span>
        <h2 className="text-sm font-semibold text-text">Paperclip</h2>
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
          Connected
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {confirmAction && (
            <div className="flex items-center gap-1.5 bg-error/10 border border-error/30 rounded-lg px-2.5 py-1">
              <span className="text-xs text-error font-medium">
                {confirmAction === 'reset' ? 'Reset all data?' : 'Stop Paperclip?'}
              </span>
              <button
                onClick={() => doAction(confirmAction)}
                disabled={!!actionLoading}
                className="text-xs font-medium text-error hover:text-white hover:bg-error px-2 py-0.5 rounded transition-colors"
              >
                {actionLoading ? 'Working...' : 'Confirm'}
              </button>
              <button
                onClick={() => setConfirmAction(null)}
                className="text-xs text-text-muted hover:text-text px-1 py-0.5 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {!confirmAction && (
            <>
              <button
                onClick={() => setConfirmAction('stop')}
                className="text-xs text-text-muted hover:text-error px-2 py-1 rounded hover:bg-error/10 transition-colors"
                title="Stop Paperclip"
              >
                Stop
              </button>
              <button
                onClick={() => setConfirmAction('reset')}
                className="text-xs text-text-muted hover:text-error px-2 py-1 rounded hover:bg-error/10 transition-colors"
                title="Reset Paperclip (delete all data)"
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>
      <iframe
        ref={iframeRef}
        src={`/paperclip/?v=${Date.now()}`}
        className="flex-1 w-full border-0 rounded-lg mt-2"
        title="Paperclip"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

export default PaperclipEmbed;
