import { useState, useEffect, useCallback } from 'react';
import { Users, Trash2, RefreshCw } from 'lucide-react';
import { getTeams, deleteTeam } from '@/api/client';
import type { Team } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function TeamsPanel() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getTeams();
      setTeams(data.teams || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this team?')) return;
    try {
      await deleteTeam(id);
      await refresh();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Team Hub" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Security'}, {label:'Teams'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <div className="space-y-2">
        {teams.map(t => (
          <div key={t.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="flex items-center gap-3">
              <Users className="w-4 h-4 text-[#6366f1]" />
              <div>
                <div className="text-sm text-[#e4e4e7]">{t.name}</div>
                <div className="text-xs text-[#52525b]">{t.members.length} members • {t.description}</div>
              </div>
            </div>
            <button onClick={() => handleDelete(t.id)} className="p-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46] hover:text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
