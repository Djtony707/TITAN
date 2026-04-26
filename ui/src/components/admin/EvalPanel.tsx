import { useState, useEffect, useCallback } from 'react';
import { TestTube, Play, AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { getTestHealthSummary, getFailingTests, getFlakyTests, runTests } from '@/api/client';
import type { FailingTest, FlakyTest } from '@/api/types';
import { PageHeader } from '@/components/shared/PageHeader';

export default function EvalPanel() {
  const [summary, setSummary] = useState<{ total: number; passing: number; failing: number; flaky: number; coverage?: number } | null>(null);
  const [failing, setFailing] = useState<FailingTest[]>([]);
  const [flaky, setFlaky] = useState<FlakyTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, f, fl] = await Promise.all([getTestHealthSummary(), getFailingTests(), getFlakyTests()]);
      setSummary(s);
      setFailing(f.tests || []);
      setFlaky(fl.tests || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleRun = async () => {
    setRunning(true);
    try { await runTests(); await refresh(); } catch { /* ignore */ }
    setRunning(false);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Test Lab" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Quality'}, {label:'Tests'}]} />
      <div className="flex gap-2">
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        <button onClick={handleRun} disabled={running} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1] text-white text-sm font-medium hover:bg-[#4f46e5] disabled:opacity-50">
          <Play className="w-4 h-4" /> {running ? 'Running...' : 'Run Tests'}
        </button>
      </div>
      {summary && (
        <div className="grid grid-cols-4 gap-2">
          <div className="p-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-xs text-[#52525b]">Total</div>
            <div className="text-sm font-semibold text-[#e4e4e7]">{summary.total}</div>
          </div>
          <div className="p-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-xs text-[#52525b]">Passing</div>
            <div className="text-sm font-semibold text-emerald-400">{summary.passing}</div>
          </div>
          <div className="p-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-xs text-[#52525b]">Failing</div>
            <div className="text-sm font-semibold text-red-400">{summary.failing}</div>
          </div>
          <div className="p-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-xs text-[#52525b]">Flaky</div>
            <div className="text-sm font-semibold text-amber-400">{summary.flaky}</div>
          </div>
        </div>
      )}
      {failing.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-[#e4e4e7] flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400" /> Failing Tests
          </div>
          {failing.map(t => (
            <div key={t.name} className="p-2 rounded-lg bg-red-950/20 border border-red-900/50">
              <div className="text-xs text-[#e4e4e7]">{t.name}</div>
              <div className="text-xs text-[#52525b]">{t.suite} • {t.error.slice(0, 60)}</div>
            </div>
          ))}
        </div>
      )}
      {flaky.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-[#e4e4e7] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" /> Flaky Tests
          </div>
          {flaky.map(t => (
            <div key={t.name} className="p-2 rounded-lg bg-amber-950/20 border border-amber-900/50">
              <div className="text-xs text-[#e4e4e7]">{t.name}</div>
              <div className="text-xs text-[#52525b]">{t.suite} • {t.passRate.toFixed(1)}% pass rate</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
