import { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { apiFetch } from '@/api/client';

function AutopilotPanel() {
  const [config, setConfig] = useState<{ mode: string; interval?: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/config', { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.json())
      .then(d => setConfig({ mode: d.autonomy?.mode || 'supervised', interval: d.autonomy?.autopilotIntervalMs }))
      .catch(() => setConfig({ mode: 'supervised' }))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-[var(--text-muted)]">Loading autopilot config...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Zap className="w-6 h-6 text-[var(--accent)]" />
        <h1 className="text-xl font-bold text-[var(--text)]">Autopilot</h1>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Mode</p>
          <p className="text-lg font-semibold text-[var(--text)] capitalize">{config?.mode}</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Interval</p>
          <p className="text-lg font-semibold text-[var(--text)]">
            {config?.interval ? `${Math.round(config.interval / 60000)} min` : 'Not set'}
          </p>
        </div>
      </div>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <p className="text-sm text-[var(--text-muted)]">
          Autopilot mode enables TITAN to run scheduled tasks automatically. Configure via titan.json.
        </p>
      </div>
    </div>
  );
}

export default AutopilotPanel;
