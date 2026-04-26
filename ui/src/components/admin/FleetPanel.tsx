import { useState, useEffect, useCallback } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import { getFleet } from '@/api/client';
import type { FleetNode } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function FleetPanel() {
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getFleet();
      setNodes(data.nodes || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-4">
      <PageHeader title="Fleet Router" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Mesh'}, {label:'Fleet'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <div className="space-y-2">
        {nodes.map(n => (
          <div key={n.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="flex items-center gap-3">
              <Radio className={`w-4 h-4 ${n.status === 'online' ? 'text-emerald-400' : n.status === 'busy' ? 'text-amber-400' : 'text-red-400'}`} />
              <div>
                <div className="text-sm text-[#e4e4e7]">{n.name}</div>
                <div className="text-xs text-[#52525b]">{n.address} • {n.capabilities.join(', ')}</div>
              </div>
            </div>
            <div className="text-xs text-[#52525b]">{n.status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
