import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Play, Trash2, RefreshCw } from 'lucide-react';
import { getRecipes, deleteRecipe, runRecipe } from '@/api/client';
import type { Recipe } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function RecipesPanel() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getRecipes();
      setRecipes(data.recipes || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleRun = async (id: string) => {
    setRunning(id);
    try {
      await runRecipe(id);
    } catch { /* ignore */ }
    setRunning(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this recipe?')) return;
    try {
      await deleteRecipe(id);
      await refresh();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Recipe Kitchen" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Tools'}, {label:'Recipes'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      <div className="space-y-2">
        {recipes.map(r => (
          <div key={r.id} className="flex items-center justify-between p-3 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="flex items-center gap-3 min-w-0">
              <BookOpen className="w-4 h-4 text-[#6366f1] shrink-0" />
              <div className="min-w-0">
                <div className="text-sm text-[#e4e4e7] truncate">{r.name}</div>
                <div className="text-xs text-[#52525b] truncate">{r.description}</div>
                <div className="text-xs text-[#52525b]">{r.steps.length} steps • {r.tags?.join(', ')}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => handleRun(r.id)} disabled={running === r.id} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#6366f1] text-white text-xs hover:bg-[#4f46e5] disabled:opacity-50">
                <Play className="w-3.5 h-3.5" /> {running === r.id ? 'Running...' : 'Run'}
              </button>
              <button onClick={() => handleDelete(r.id)} className="p-1.5 rounded-md bg-[#27272a] text-[#a1a1aa] hover:bg-[#3f3f46] hover:text-red-400">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
