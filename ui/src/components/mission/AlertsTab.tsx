import { useState, useEffect } from 'react';
import { getAlerts, getGuardrailViolations } from '../../api/client';
import type { Alert, GuardrailViolation } from '../../api/types';
import { AlertTriangle, Shield, Bell, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';

export default function AlertsTab() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [violations, setViolations] = useState<GuardrailViolation[]>([]);
  const [view, setView] = useState<'alerts' | 'guardrails'>('alerts');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [a, g] = await Promise.all([getAlerts(30), getGuardrailViolations(30)]);
        if (active) {
          setAlerts(a.alerts || []);
          setViolations(g.violations || []);
        }
      } catch { /* non-critical */ }
      if (active) setLoading(false);
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (loading) {
    return <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-12 rounded-lg skeleton-shimmer" />)}</div>;
  }

  const severityIcon = (severity: string) => {
    if (severity === 'critical') return <ShieldAlert size={12} className="text-error" />;
    if (severity === 'warning') return <AlertTriangle size={12} className="text-warning" />;
    return <Bell size={12} className="text-info" />;
  };

  return (
    <div className="space-y-3">
      {/* Toggle */}
      <div className="flex items-center gap-1 text-xs">
        <button
          onClick={() => setView('alerts')}
          className={clsx('px-2.5 py-1 rounded-md transition-colors', view === 'alerts' ? 'bg-bg-tertiary text-text' : 'text-text-muted hover:text-text-secondary')}
        >
          <Bell size={12} className="inline mr-1" />
          Alerts ({alerts.length})
        </button>
        <button
          onClick={() => setView('guardrails')}
          className={clsx('px-2.5 py-1 rounded-md transition-colors', view === 'guardrails' ? 'bg-bg-tertiary text-text' : 'text-text-muted hover:text-text-secondary')}
        >
          <Shield size={12} className="inline mr-1" />
          Guardrails ({violations.length})
        </button>
      </div>

      {/* Content */}
      {view === 'alerts' ? (
        alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-24 text-text-muted text-xs">
            <Bell size={20} className="mb-2 opacity-40" />
            No alerts
          </div>
        ) : (
          <div className="space-y-1">
            {alerts.map((alert, i) => (
              <div key={i} className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-bg-secondary/30">
                {severityIcon(alert.severity)}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-secondary">{alert.title}</p>
                  <p className="text-[10px] text-text-muted truncate">{alert.message}</p>
                </div>
                <span className="text-[10px] text-text-muted shrink-0">
                  {new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        )
      ) : (
        violations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-24 text-text-muted text-xs">
            <Shield size={20} className="mb-2 opacity-40" />
            No violations
          </div>
        ) : (
          <div className="space-y-1">
            {violations.map((v, i) => (
              <div key={i} className={clsx('flex items-start gap-2 px-2.5 py-2 rounded-lg', v.blocked ? 'bg-error/5' : 'bg-bg-secondary/30')}>
                {severityIcon(v.severity)}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-text-secondary">
                    <span className="font-mono text-[10px] bg-bg-tertiary px-1 rounded mr-1">{v.layer}</span>
                    {v.rule}
                    {v.blocked && <span className="ml-1 text-error text-[10px]">BLOCKED</span>}
                  </p>
                  <p className="text-[10px] text-text-muted truncate">{v.content}</p>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
