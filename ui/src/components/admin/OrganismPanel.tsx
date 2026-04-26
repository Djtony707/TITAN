import { useState, useEffect, useCallback } from 'react';
import { Shield, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { getOrganismAlerts, getOrganismSafetyMetrics, acknowledgeAlert } from '@/api/client';
import type { Alert } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function OrganismPanel() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [a, m] = await Promise.all([getOrganismAlerts(), getOrganismSafetyMetrics()]);
      setAlerts(a.alerts || []);
      setMetrics(m);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleAck = async (id: string) => {
    try {
      await acknowledgeAlert(id);
      await refresh();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Organism Monitor" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Safety'}, {label:'Organism'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      {Object.keys(metrics).length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {Object.entries(metrics).map(([k, v]) => (
            <div key={k} className="p-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
              <div className="text-xs text-[#52525b] capitalize">{k}</div>
              <div className="text-sm font-semibold text-[#e4e4e7]">{typeof v === 'number' ? v.toFixed(2) : v}</div>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {alerts.map(a => (
          <div key={(a as any).id} className={`flex items-center justify-between p-3 rounded-lg border ${a.severity === 'critical' ? 'bg-red-950/20 border-red-900/50' : a.severity === 'warning' ? 'bg-amber-950/20 border-amber-900/50' : 'bg-[#0a0a0f] border-[#27272a]'}`}>
            <div className="flex items-center gap-3">
              {a.severity === 'critical' ? <AlertTriangle className="w-4 h-4 text-red-400" /> : a.severity === 'warning' ? <AlertTriangle className="w-4 h-4 text-amber-400" /> : <Shield className="w-4 h-4 text-[#6366f1]" />}
              <div>
                <div className="text-sm text-[#e4e4e7]">{a.message}</div>
                <div className="text-xs text-[#52525b]">{a.source} • {new Date(a.timestamp).toLocaleString()}</div>
              </div>
            </div>
            {!(a as any).acknowledged && (
              <button onClick={() => handleAck((a as any).id)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] text-xs hover:bg-[#3f3f46]">
                <CheckCircle className="w-3.5 h-3.5" /> Ack
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
