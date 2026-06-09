import { useState, useEffect, useCallback } from 'react';
import { Save, Trash2, RefreshCw } from 'lucide-react';
import { getCheckpoints, deleteCheckpoint } from '@/api/client';
import type { CheckpointMeta } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';
import { useToast } from '@/components/shared/Toast';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

export default function CheckpointsPanel() {
  const { toast } = useToast();
  const [checkpoints, setCheckpoints] = useState<CheckpointMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCheckpoints();
      setCheckpoints(data.checkpoints || []);
    } catch (err) {
      toast('error', `Couldn't load checkpoints — try again. (${(err as Error).message})`);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (sessionId: string) => {
    try {
      await deleteCheckpoint(sessionId);
      await refresh();
      toast('success', 'Checkpoint deleted.');
    } catch (err) {
      toast('error', `Couldn't delete checkpoint — try again. (${(err as Error).message})`);
    }
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
            <button onClick={() => setConfirmId(c.sessionId)} className="p-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46] hover:text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmId !== null}
        title="Delete this checkpoint?"
        message="This can't be undone. The saved session state will be permanently removed."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (confirmId) await handleDelete(confirmId);
          setConfirmId(null);
        }}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
