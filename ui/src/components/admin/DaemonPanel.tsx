import { useState, useEffect, useRef } from 'react';
import { Eye, Play, Pause, RefreshCw, Activity, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { getDaemonStatus, pauseDaemon, resumeDaemon } from '@/api/client';
import type { DaemonStatus } from '@/api/types';

function DaemonPanel() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<Array<{ event: string; data: string; time: string }>>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setStatus(await getDaemonStatus());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    refresh();

    // Connect to daemon event stream
    const es = new EventSource('/api/daemon/stream');
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setEvents(prev => [{
          event: data.event || 'message',
          data: JSON.stringify(data.data || data, null, 0),
          time: new Date().toLocaleTimeString(),
        }, ...prev].slice(0, 50));
      } catch { /* ignore non-JSON */ }
    };

    // Listen for named events
    for (const eventName of ['daemon:started', 'daemon:stopped', 'daemon:paused', 'daemon:resumed', 'daemon:heartbeat', 'goal:subtask:ready', 'health:ollama:down', 'health:ollama:degraded', 'cron:stuck']) {
      es.addEventListener(eventName, (e) => {
        setEvents(prev => [{
          event: eventName,
          data: (e as MessageEvent).data || '',
          time: new Date().toLocaleTimeString(),
        }, ...prev].slice(0, 50));
      });
    }

    const interval = setInterval(refresh, 15000);
    return () => {
      es.close();
      clearInterval(interval);
    };
  }, []);

  const handlePause = async () => {
    await pauseDaemon();
    refresh();
  };

  const handleResume = async () => {
    await resumeDaemon();
    refresh();
  };

  const formatUptime = (ms: number) => {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${Math.round(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
  };

  if (loading && !status) return <div className="text-[var(--text-muted)]">Loading daemon status...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Eye className="w-6 h-6 text-[var(--accent)]" />
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">Daemon</h1>
            <p className="text-sm text-[var(--text-muted)]">Persistent background watchers and event loop</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="p-2 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
            <RefreshCw size={14} />
          </button>
          {status?.running && !status.paused && (
            <button onClick={handlePause} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-[var(--warning)]/15 text-[var(--warning)] border border-[var(--warning)]/25 hover:bg-[var(--warning)]/25 transition-colors">
              <Pause size={14} /> Pause
            </button>
          )}
          {status?.running && status.paused && (
            <button onClick={handleResume} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/25 hover:bg-[var(--success)]/25 transition-colors">
              <Play size={14} /> Resume
            </button>
          )}
        </div>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Status</p>
          <div className="flex items-center gap-2 mt-1">
            {status?.running ? (
              status.paused ? (
                <><AlertTriangle size={18} className="text-[var(--warning)]" /><span className="text-lg font-semibold text-[var(--warning)]">Paused</span></>
              ) : (
                <><CheckCircle2 size={18} className="text-[var(--success)]" /><span className="text-lg font-semibold text-[var(--success)]">Running</span></>
              )
            ) : (
              <><span className="text-lg font-semibold text-[var(--text-muted)]">Stopped</span></>
            )}
          </div>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Uptime</p>
          <div className="flex items-center gap-2 mt-1">
            <Clock size={18} className="text-[var(--text-muted)]" />
            <p className="text-lg font-semibold text-[var(--text)]">{status ? formatUptime(status.uptimeMs) : '-'}</p>
          </div>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Actions / Hour</p>
          <p className="text-lg font-semibold text-[var(--text)] mt-1">
            {status?.actionsThisHour ?? 0} <span className="text-sm font-normal text-[var(--text-muted)]">/ {status?.maxActionsPerHour ?? 10}</span>
          </p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Error Rate</p>
          <p className={`text-lg font-semibold mt-1 ${(status?.errorRatePercent ?? 0) > 30 ? 'text-[var(--error)]' : 'text-[var(--text)]'}`}>
            {status?.errorRatePercent ?? 0}%
          </p>
        </div>
      </div>

      {/* Pause reason */}
      {status?.pauseReason && (
        <div className="bg-[var(--warning)]/10 border border-[var(--warning)]/25 rounded-lg p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-[var(--warning)] flex-shrink-0" />
          <span className="text-sm text-[var(--warning)]">{status.pauseReason}</span>
        </div>
      )}

      {/* Active watchers */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-3">Active Watchers</h2>
        {status?.activeWatchers && status.activeWatchers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {status.activeWatchers.map(w => (
              <span key={w} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20">
                <Activity size={12} /> {w}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">No active watchers</p>
        )}
      </div>

      {/* Live event feed */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-3">Event Feed</h2>
        {events.length > 0 ? (
          <div className="space-y-1 max-h-64 overflow-y-auto font-mono text-xs">
            {events.map((evt, i) => (
              <div key={i} className="flex gap-3 py-1 border-b border-[var(--border)]/50 last:border-0">
                <span className="text-[var(--text-muted)] flex-shrink-0 w-16">{evt.time}</span>
                <span className="text-[var(--accent)] flex-shrink-0">{evt.event}</span>
                <span className="text-[var(--text-secondary)] truncate">{evt.data}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">Waiting for events...</p>
        )}
      </div>
    </div>
  );
}

export default DaemonPanel;
