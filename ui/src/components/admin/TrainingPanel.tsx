import { useState, useEffect, useCallback } from 'react';
import { Brain, Activity, Download, RefreshCw } from 'lucide-react';
import { getTrainingStats, getTrainingRuns } from '@/api/client';
import type { TrainingStats, TrainingRun } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function TrainingPanel() {
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([getTrainingStats(), getTrainingRuns()]);
      setStats(s);
      setRuns(r.runs || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-4">
      <PageHeader title="Training Dashboard" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Intelligence'}, {label:'Training'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        <a href="/api/training/export" download className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46]">
          <Download className="w-4 h-4" /> Export
        </a>
      </div>
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-xs text-[#52525b]">Entries</div>
            <div className="text-lg font-semibold text-[#e4e4e7]">{stats.entries}</div>
          </div>
          <div className="p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-xs text-[#52525b]">Size (bytes)</div>
            <div className="text-lg font-semibold text-[#e4e4e7]">{stats.sizeBytes}</div>
          </div>
          <div className="p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-xs text-[#52525b]">Last Capture</div>
            <div className="text-lg font-semibold text-[#e4e4e7]">{stats.lastCapture ? new Date(stats.lastCapture).toLocaleString() : '—'}</div>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {runs.map(run => (
          <div key={run.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="flex items-center gap-3">
              <Brain className={`w-4 h-4 ${run.status === 'running' ? 'text-amber-400' : run.status === 'completed' ? 'text-emerald-400' : 'text-red-400'}`} />
              <div>
                <div className="text-sm text-[#e4e4e7]">{run.type} — {run.id.slice(0, 8)}</div>
                <div className="text-xs text-[#52525b]">{run.examplesProcessed} examples • {run.status}</div>
              </div>
            </div>
            <div className="text-xs text-[#52525b]">{new Date(run.startedAt).toLocaleDateString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
