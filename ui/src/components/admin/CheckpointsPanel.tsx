import { useState, useEffect, useCallback } from 'react';
import { Save, Trash2, RefreshCw } from 'lucide-react';
import { getCheckpoints, deleteCheckpoint } from '@/api/client';
import type { CheckpointMeta } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function CheckpointsPanel() {
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCheckpoints();
      setCheckpoints(data.checkpoints || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (sessionId: string) => {
    if (!confirm('Delete this checkpoint?')) return;
    try {
      await deleteCheckpoint(sessionId);
      await refresh();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Checkpoints" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'System'}, {label:'Checkpoints'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <div className="space-y-2">
        {checkpoints.map(c => (
          <div key={c.sessionId} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="flex items-center gap-3">
              <Save className="w-4 h-4 text-[#6366f1]" />
              <div>
                <div className="text-sm text-[#e4e4e7]">{c.sessionId.slice(0, 16)}...</div>
                <div className="text-xs text-[#52525b]">{new Date(c.createdAt).toLocaleString()}</div>
              </div>
            </div>
            <button onClick={() => handleDelete(c.sessionId)} className="p-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46] hover:text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
