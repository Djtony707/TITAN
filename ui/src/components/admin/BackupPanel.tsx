import { useState, useEffect, useCallback } from 'react';
import { Archive, CheckCircle, AlertCircle, RefreshCw, Plus } from 'lucide-react';
import { listBackups, createBackup, verifyBackup } from '@/api/client';
import type { BackupInfo } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function BackupPanel() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listBackups();
      setBackups(data.backups || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await createBackup();
      await refresh();
    } catch { /* ignore */ }
    setCreating(false);
  };

  const handleVerify = async (path: string) => {
    setVerifying(path);
    try {
      await verifyBackup(path);
      alert('Backup verified successfully');
    } catch {
      alert('Backup verification failed');
    }
    setVerifying(null);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Backup Manager" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'System'}, {label:'Backups'}]} />
      <div className="flex gap-2">
        <button onClick={handleCreate} disabled={creating} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1] text-white text-sm font-medium hover:bg-[#4f46e5] disabled:opacity-50">
          <Plus className="w-4 h-4" /> {creating ? 'Creating...' : 'Create Backup'}
        </button>
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      {backups.length === 0 && !loading && (
        <div className="text-sm text-[#52525b]">No backups found.</div>
      )}
      <div className="space-y-2">
        {backups.map(b => (
          <div key={b.path} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="flex items-center gap-3">
              <Archive className="w-4 h-4 text-[#6366f1]" />
              <div>
                <div className="text-sm text-[#e4e4e7]">{new Date(b.createdAt).toLocaleString()}</div>
                <div className="text-xs text-[#52525b]">{(b.sizeBytes / 1024 / 1024).toFixed(1)} MB</div>
              </div>
            </div>
            <button onClick={() => handleVerify(b.path)} disabled={verifying === b.path} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] text-xs hover:bg-[#3f3f46] disabled:opacity-50">
              <CheckCircle className="w-3.5 h-3.5" /> {verifying === b.path ? 'Verifying...' : 'Verify'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
