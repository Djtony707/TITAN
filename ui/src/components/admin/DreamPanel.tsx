import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Moon, Calendar, Sparkles, AlertTriangle } from 'lucide-react';
import { getLatestDream, listDreamDates, getDreamByDate, generateDream, type Dream } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

/**
 * Dream Mode panel — surfaces v5.5.17+ journal entries.
 *
 * Backend writes to ~/.titan/dreams/<YYYY-MM-DD>.{md,json} and exposes
 *   GET /api/dreams/latest, GET /api/dreams, GET /api/dreams/:date,
 *   POST /api/dreams/generate
 *
 * UI shows: latest entry by default, list of dates to scrub, and a
 * "Generate now" button for force-runs (the daemon fires nightly at
 * dream.cronAt — defaults 03:30 — but operators sometimes want a
 * mid-day refresh after a big push).
 */
export default function DreamPanel() {
  const [dream, setDream] = useState<Dream | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const r = await listDreamDates(60);
      setDates(r.dates);
    } catch { /* ignore */ }
  }, []);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await getLatestDream();
      setDream(d);
      setSelectedDate(d?.date ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  const loadByDate = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const d = await getDreamByDate(date);
      setDream(d);
      setSelectedDate(date);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const d = await generateDream();
      setDream(d);
      setSelectedDate(d.date);
      await loadList();
    } catch (e) {
      setError((e as Error).message);
    }
    setGenerating(false);
  }, [loadList]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await listDreamDates(60);
        if (cancelled) return;
        setDates(r.dates);
        if (r.dates.length === 0) {
          setDream(null);
          setSelectedDate(null);
          return;
        }
        const d = await getLatestDream();
        if (cancelled) return;
        setDream(d);
        setSelectedDate(d?.date ?? null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader title="Dream Mode" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Identity'}, {label:'Dreams'}]} />

      <div className="flex items-center gap-2">
        <button
          onClick={loadLatest}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#27272a] text-[#a1a1aa] text-sm font-medium hover:bg-[#3f3f46] disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Latest
        </button>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1]/20 text-[#a5b4fc] text-sm font-medium hover:bg-[#6366f1]/30 disabled:opacity-50"
          title="Run a dream cycle right now instead of waiting for the nightly cron"
        >
          <Sparkles className={`w-4 h-4 ${generating ? 'animate-spin' : ''}`} /> {generating ? 'Generating…' : 'Generate now'}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-900/50 bg-red-950/20 text-sm text-red-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
        {/* Date list */}
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-text-secondary mb-2 flex items-center gap-1">
            <Calendar className="w-3 h-3" /> History
          </div>
          {dates.length === 0 && (
            <div className="text-xs text-text-muted p-2">No dreams yet. Run "Generate now" or wait for the nightly cron.</div>
          )}
          <div className="space-y-1 max-h-[60vh] overflow-y-auto">
            {dates.map(d => (
              <button
                key={d}
                onClick={() => loadByDate(d)}
                className={`w-full text-left text-xs px-2 py-1.5 rounded ${selectedDate === d ? 'bg-[#27272a] text-[#e4e4e7]' : 'text-[#a1a1aa] hover:bg-[#1a1a1f]'}`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Dream content */}
        <div className="min-w-0">
          {!dream && !loading && (
            <div className="p-6 text-center text-[#52525b] text-sm rounded-lg border border-[#27272a] bg-[#0a0a0f]">
              <Moon className="w-8 h-8 mx-auto mb-2 opacity-50" />
              No dream selected.
            </div>
          )}

          {dream && (
            <div className="space-y-3">
              {/* Header strip */}
              <div className="flex items-center gap-3 text-xs text-[#52525b] flex-wrap">
                <span className="inline-flex items-center gap-1"><Moon className="w-3 h-3" /> {dream.date}</span>
                <span>•</span>
                <span>model: <span className="text-[#a1a1aa]">{dream.model}</span></span>
                <span>•</span>
                <span>{dream.activity.successfulTrajectories}/{dream.activity.trajectories} trajectories</span>
                <span>•</span>
                <span>{dream.activity.toolsExercised.length} tools</span>
              </div>

              {/* Sections emitted/skipped */}
              <div className="flex flex-wrap gap-1.5">
                {dream.sectionsEmitted.map(s => (
                  <span key={s} className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-emerald-950/40 text-emerald-300">{s}</span>
                ))}
                {Object.entries(dream.sectionsSkipped).map(([s, reason]) => (
                  <span key={s} title={reason} className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-[#27272a] text-[#52525b]">{s} skipped</span>
                ))}
              </div>

              {/* Drive deltas */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {Object.entries(dream.drives.delta).map(([id, delta]) => {
                  const start = dream.drives.start[id] ?? 0;
                  const end = dream.drives.end[id] ?? 0;
                  const dir = delta > 0.005 ? '↑' : delta < -0.005 ? '↓' : '·';
                  const cls = delta > 0.005 ? 'text-emerald-300' : delta < -0.005 ? 'text-red-300' : 'text-[#52525b]';
                  return (
                    <div key={id} className="p-2 rounded bg-[#0a0a0f] border border-[#27272a]">
                      <div className="text-[10px] uppercase tracking-wide text-[#52525b]">{id}</div>
                      <div className="text-xs text-[#a1a1aa]">{start.toFixed(2)} → {end.toFixed(2)}</div>
                      <div className={`text-xs font-medium ${cls}`}>{dir} {delta >= 0 ? '+' : ''}{delta.toFixed(3)}</div>
                    </div>
                  );
                })}
              </div>

              {/* Markdown body */}
              <div className="p-4 rounded-lg border border-[#27272a] bg-[#0a0a0f] prose prose-invert prose-sm max-w-none">
                {/* Render plain markdown by splitting on H2 sections — keeps deps light. */}
                {dream.markdown.split(/^## /m).map((chunk, i) => {
                  if (i === 0) {
                    // First chunk before any "## " — H1 + italic intro
                    const lines = chunk.split('\n').filter(l => l.trim());
                    return (
                      <div key="head" className="mb-4">
                        {lines.map((l, j) => {
                          if (l.startsWith('# ')) {
                            return <h2 key={j} className="text-lg font-semibold text-[#e4e4e7] mb-1">{l.slice(2)}</h2>;
                          }
                          if (l.startsWith('*') && l.endsWith('*')) {
                            return <p key={j} className="text-xs italic text-[#52525b]">{l.slice(1, -1)}</p>;
                          }
                          return <p key={j} className="text-sm text-[#a1a1aa]">{l}</p>;
                        })}
                      </div>
                    );
                  }
                  // Subsequent chunks each begin with the section header line
                  const newlineIdx = chunk.indexOf('\n');
                  const header = newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk;
                  const body = newlineIdx >= 0 ? chunk.slice(newlineIdx + 1).trim() : '';
                  return (
                    <div key={`s${i}`} className="mb-4">
                      <h3 className="text-sm font-semibold text-[#e4e4e7] mb-2">{header}</h3>
                      {body.split('\n\n').filter(p => p.trim()).map((para, j) => (
                        <p key={j} className="text-sm text-[#d4d4d8] leading-relaxed mb-2">{para}</p>
                      ))}
                    </div>
                  );
                })}
              </div>

              {dream.audioPath && (
                <div className="text-xs text-[#52525b]">audio: <code className="px-1 py-0.5 rounded bg-[#0a0a0f]">{dream.audioPath}</code></div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
