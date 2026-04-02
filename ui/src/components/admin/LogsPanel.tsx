import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getLogs } from '@/api/client';
import type { LogEntry } from '@/api/types';

const levelColors: Record<string, string> = {
  debug: 'bg-text-muted/20 text-text-secondary',
  info: 'bg-info/20 text-info',
  warn: 'bg-warning/20 text-warning',
  warning: 'bg-warning/20 text-warning',
  error: 'bg-error/20 text-error',
};

function LogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState('');
  const [limit, setLimit] = useState(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const data = await getLogs(level || undefined, limit);
      setLogs(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  }, [level, limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchLogs, 5000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchLogs]);

  if (loading) {
    return (
      <div className="h-96 animate-pulse rounded-xl border border-border bg-bg-secondary" />
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-text">Logs</h2>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="">All levels</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>

        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value={50}>50 entries</option>
          <option value={100}>100 entries</option>
          <option value={200}>200 entries</option>
        </select>

        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Auto-refresh (5s)
        </label>

        <button
          onClick={fetchLogs}
          className="ml-auto rounded-lg p-2 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-error/50 bg-bg-secondary px-4 py-2 text-sm text-error">
          {error}
        </div>
      )}

      {/* Log entries */}
      <div className="max-h-[600px] overflow-y-auto rounded-xl border border-border bg-bg-secondary">
        {logs.length === 0 ? (
          <p className="px-4 py-12 text-center text-text-muted">No logs found</p>
        ) : (
          <div className="divide-y divide-border">
            {logs.map((entry, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                <span className="shrink-0 font-mono text-xs text-text-muted">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium uppercase ${
                    levelColors[entry.level] ?? levelColors.debug
                  }`}
                >
                  {entry.level}
                </span>
                <span className="min-w-0 break-all text-sm text-text">
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default LogsPanel;
