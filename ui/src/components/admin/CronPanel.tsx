import { useState, useEffect, useCallback } from 'react';
import { Clock, ToggleLeft, ToggleRight, Trash2, RefreshCw } from 'lucide-react';
import { getCronJobs, toggleCronJob, deleteCronJob } from '@/api/client';
import type { CronJob } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';
import { useToast } from '@/components/shared/Toast';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

export default function CronPanel() {
  const { toast } = useToast();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCronJobs();
      setJobs(data.jobs || []);
    } catch (err) {
      toast('error', `Couldn't load cron jobs — try again. (${(err as Error).message})`);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleToggle = async (id: string) => {
    try {
      await toggleCronJob(id);
      await refresh();
      toast('success', 'Cron job updated.');
    } catch (err) {
      toast('error', `Couldn't toggle cron job — try again. (${(err as Error).message})`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCronJob(id);
      await refresh();
      toast('success', 'Cron job deleted.');
    } catch (err) {
      toast('error', `Couldn't delete cron job — try again. (${(err as Error).message})`);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Cron Scheduler" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'System'}, {label:'Cron'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <div className="space-y-2">
        {jobs.map(j => (
          <div key={j.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="flex items-center gap-3">
              <Clock className="w-4 h-4 text-[#6366f1]" />
              <div>
                <div className="text-sm text-[#e4e4e7]">{j.name}</div>
                <div className="text-xs text-[#52525b]">{j.schedule} • {j.command}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => handleToggle(j.id)} className="p-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46]">
                {j.enabled ? <ToggleRight className="w-4 h-4 text-emerald-400" /> : <ToggleLeft className="w-4 h-4 text-[#52525b]" />}
              </button>
              <button onClick={() => setConfirmId(j.id)} className="p-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46] hover:text-red-400">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={confirmId !== null}
        title="Delete cron job?"
        message="This can't be undone."
        confirmLabel="Delete"
        onConfirm={async () => {
          const id = confirmId;
          setConfirmId(null);
          if (id) await handleDelete(id);
        }}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
