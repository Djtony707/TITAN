import { useState, useEffect, useCallback } from 'react';
import { Cpu, MemoryStick, RefreshCw } from 'lucide-react';
import { getVramSnapshot } from '@/api/client';
import type { VramSnapshot } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function VramPanel() {
  const [snapshot, setSnapshot] = useState<VramSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getVramSnapshot();
      setSnapshot(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-4">
      <PageHeader title="VRAM Monitor" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Infra'}, {label:'VRAM'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      {snapshot?.gpu && (
        <div className="p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-4 h-4 text-[#6366f1]" />
            <span className="text-sm font-medium text-[#e4e4e7]">{snapshot.gpu.gpuName}</span>
            <span className="text-xs text-[#52525b]">({snapshot.gpu.vendor})</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="p-2 rounded bg-[#27272a]/50">
              <div className="text-[#52525b]">Total</div>
              <div className="text-[#e4e4e7]">{(snapshot.gpu.totalMB / 1024).toFixed(1)} GB</div>
            </div>
            <div className="p-2 rounded bg-[#27272a]/50">
              <div className="text-[#52525b]">Used</div>
              <div className="text-[#e4e4e7]">{(snapshot.gpu.usedMB / 1024).toFixed(1)} GB</div>
            </div>
            <div className="p-2 rounded bg-[#27272a]/50">
              <div className="text-[#52525b]">Free</div>
              <div className="text-[#e4e4e7]">{(snapshot.gpu.freeMB / 1024).toFixed(1)} GB</div>
            </div>
          </div>
          <div className="mt-2 h-2 rounded-full bg-[#27272a] overflow-hidden">
            <div className="h-full bg-[#6366f1] rounded-full" style={{ width: `${(snapshot.gpu.usedMB / snapshot.gpu.totalMB) * 100}%` }} />
          </div>
        </div>
      )}
      {snapshot && snapshot.activeLeases.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-[#e4e4e7]">Active Leases</div>
          {snapshot.activeLeases.map(l => (
            <div key={l.id} className="flex items-center justify-between p-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
              <div className="flex items-center gap-2">
                <MemoryStick className="w-3.5 h-3.5 text-[#6366f1]" />
                <span className="text-xs text-[#e4e4e7]">{l.service}</span>
              </div>
              <span className="text-xs text-[#52525b]">{(l.reservedMB / 1024).toFixed(1)} GB</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
