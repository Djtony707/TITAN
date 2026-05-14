/**
 * TITAN — Mission Library (v6.1.0-alpha.13)
 *
 * Sessions browser: lists every mission on disk, newest first. Click a
 * row to open the chat view of that mission. Lets users get back to a
 * past session — including ones that finished — without remembering
 * its URL.
 *
 * Data plane: `listMissions()` from the API client returns summaries
 * (no `messages`, no `artifact.content`) so the list page stays small
 * even when there are dozens of historical missions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { listMissions, deleteMission, type MissionRoom } from '@/api/missions';
// v6.1.0-alpha.22 — sponsor footer is now a global AppShell mount.

type StatusFilter = 'all' | 'live' | 'done' | 'failed';

export default function MissionLibrary() {
  const navigate = useNavigate();
  const [missions, setMissions] = useState<MissionRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    listMissions()
      .then(({ missions }) => { if (alive) setMissions(missions); })
      .catch((err) => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(() => {
    setMissions(null);
    listMissions().then(({ missions }) => setMissions(missions)).catch((err) => setError((err as Error).message));
  }, []);

  /**
   * v6.1.0-alpha.27 — delete a mission. Confirms first because the
   * backend DELETE /api/missions/:id renames the JSON to
   * `.deleted-fresh-start-<timestamp>` (recoverable) but the mission
   * disappears from the UI immediately. Optimistic update: drop the
   * row locally before the request comes back so the UI feels
   * responsive; refetch on failure to recover the truth.
   */
  const handleDelete = useCallback(async (missionId: string, goal: string) => {
    const ok = window.confirm(`Delete this mission?\n\n"${goal.slice(0, 120)}${goal.length > 120 ? '…' : ''}"\n\nThe file is renamed (not destroyed), so the disk record can be recovered manually.`);
    if (!ok) return;
    setMissions(prev => (prev ?? []).filter(m => m.id !== missionId));
    try {
      await deleteMission(missionId);
    } catch (err) {
      setError((err as Error).message);
      // Refetch on failure so the optimistic delete doesn't leave a ghost.
      listMissions().then(({ missions }) => setMissions(missions)).catch(() => { /* ignore */ });
    }
  }, []);

  const filtered = useMemo(() => {
    if (!missions) return [];
    const q = query.trim().toLowerCase();
    return missions.filter(m => {
      if (filter === 'live' && !['working', 'blocked', 'paused', 'forming'].includes(m.status)) return false;
      if (filter === 'done' && m.status !== 'done') return false;
      if (filter === 'failed' && m.status !== 'failed') return false;
      if (q && !m.goal.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [missions, filter, query]);

  const counts = useMemo(() => {
    const c = { all: 0, live: 0, done: 0, failed: 0 };
    for (const m of missions ?? []) {
      c.all++;
      if (['working', 'blocked', 'paused', 'forming'].includes(m.status)) c.live++;
      if (m.status === 'done') c.done++;
      if (m.status === 'failed') c.failed++;
    }
    return c;
  }, [missions]);

  return (
    <div className="fixed inset-0 flex flex-col bg-bg-deep text-text overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_60%_0%,rgba(99,102,241,0.12)_0%,transparent_45%)]" />

      {/* Top bar */}
      <header className="relative z-20 flex items-center gap-4 px-5 py-3 border-b border-border bg-bg/80 backdrop-blur-md">
        <button onClick={() => navigate('/mission')} className="text-text-muted hover:text-text text-sm" title="Start a new mission">←</button>
        {/* v6.1.0-alpha.23 — back to the main canvas / spaces home. */}
        <button
          onClick={() => navigate('/space/home')}
          className="text-[10px] uppercase tracking-widest text-text-muted hover:text-text border border-border rounded-full px-2 py-0.5 shrink-0 inline-flex items-center gap-1"
          title="Back to the canvas spaces"
        >
          🌌 Canvas
        </button>
        <div className="font-semibold tracking-tight shrink-0">
          <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">TITAN</span>
          <span className="text-text-muted font-normal"> &nbsp;›&nbsp; </span>
          Mission Library
        </div>
        <div className="flex-1" />
        <button onClick={refresh} className="text-xs text-text-muted hover:text-text px-3 py-1.5 bg-bg-secondary/60 border border-border rounded-full" title="Reload">⟳ refresh</button>
        <button onClick={() => navigate('/mission')} className="px-3 py-1.5 text-xs bg-gradient-to-br from-accent to-accent2 text-bg-deep rounded-full font-semibold shadow-[0_0_16px_rgba(99,102,241,0.4)]">+ New mission</button>
      </header>

      {/* Filter row */}
      <div className="relative z-10 px-5 py-3 flex items-center gap-3 border-b border-border/40">
        <FilterChip active={filter === 'all'}    label="All"     count={counts.all}    onClick={() => setFilter('all')} />
        <FilterChip active={filter === 'live'}   label="In progress" count={counts.live} onClick={() => setFilter('live')} dotClass="bg-accent" />
        <FilterChip active={filter === 'done'}   label="Done"    count={counts.done}   onClick={() => setFilter('done')} dotClass="bg-success" />
        <FilterChip active={filter === 'failed'} label="Stopped" count={counts.failed} onClick={() => setFilter('failed')} dotClass="bg-error" />
        <div className="flex-1" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search goals…"
          className="w-72 bg-bg-secondary/70 border border-border rounded-full px-4 py-1.5 text-sm text-text placeholder:text-text-muted/60 outline-none focus:border-accent/50"
        />
      </div>

      {/* Body */}
      <main className="relative z-10 flex-1 overflow-y-auto">
        {error && (
          <div className="max-w-3xl mx-auto px-5 py-6 text-error">{error}</div>
        )}
        {missions === null && !error && (
          <div className="max-w-3xl mx-auto px-5 py-6 text-text-muted text-sm">Loading missions…</div>
        )}
        {missions !== null && filtered.length === 0 && (
          <EmptyState filter={filter} query={query} onStart={() => navigate('/mission')} />
        )}
        {missions !== null && filtered.length > 0 && (
          <ul className="max-w-3xl mx-auto px-5 py-4 flex flex-col gap-2">
            {filtered.map(m => (
              <MissionRow
                key={m.id}
                mission={m}
                onClick={() => navigate(`/mission/${m.id}`)}
                onDelete={() => handleDelete(m.id, m.goal)}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function FilterChip({
  active, label, count, onClick, dotClass,
}: { active: boolean; label: string; count: number; onClick: () => void; dotClass?: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-colors ${
        active
          ? 'bg-bg-secondary border-border-light text-text'
          : 'bg-bg-secondary/40 border-border text-text-muted hover:text-text'
      }`}
    >
      {dotClass && <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />}
      <span>{label}</span>
      <span className="text-text-muted/70">{count}</span>
    </button>
  );
}

function MissionRow({
  mission, onClick, onDelete,
}: {
  mission: MissionRoom;
  onClick: () => void;
  onDelete: () => void;
}) {
  const updated = relativeTime(mission.updatedAt);
  return (
    <li className="relative group">
      <button
        onClick={onClick}
        className="w-full text-left bg-bg-secondary/40 hover:bg-bg-secondary/70 border border-border rounded-xl px-4 py-3 transition-colors"
      >
        <div className="flex items-center gap-3 mb-2">
          <StatusBadge status={mission.status} />
          <div className="text-sm font-medium text-text flex-1 truncate">
            {mission.goal || '(no goal)'}
          </div>
          <div className="text-[11px] text-text-muted shrink-0">{updated}</div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <span>{mission.team.length}</span>
            <span>helper{mission.team.length === 1 ? '' : 's'}</span>
          </span>
          {mission.team.length > 0 && (
            <span className="flex items-center gap-1 truncate max-w-[40%]">
              · {mission.team.slice(0, 4).map(t => t.name).join(', ')}{mission.team.length > 4 ? `, +${mission.team.length - 4}` : ''}
            </span>
          )}
          {mission.cost.usd > 0 && (
            <span>· ${mission.cost.usd.toFixed(2)} effort</span>
          )}
          {mission.playId && (
            <span className="ml-auto text-text-muted/60 text-[10px] uppercase tracking-widest">{mission.playId}</span>
          )}
        </div>
      </button>
      {/* v6.1.0-alpha.27 — delete affordance per row. Shows on hover.
          stopPropagation so it doesn't also fire the row's onClick. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-2 w-7 h-7 rounded-full bg-bg-tertiary/60 border border-border text-text-muted hover:text-error hover:bg-error/15 hover:border-error/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-sm"
        title="Delete this mission"
        aria-label="Delete mission"
      >
        🗑
      </button>
    </li>
  );
}

function StatusBadge({ status }: { status: MissionRoom['status'] }) {
  const config: Record<MissionRoom['status'], { label: string; cls: string }> = {
    forming:  { label: 'forming',  cls: 'bg-bg-tertiary/60 text-text-secondary border-border' },
    working:  { label: 'live',     cls: 'bg-accent/15 text-accent border-accent/30' },
    blocked:  { label: 'needs you',cls: 'bg-error/15 text-error border-error/30 animate-pulse' },
    paused:   { label: 'paused',   cls: 'bg-warning/15 text-warning border-warning/30' },
    done:     { label: 'done',     cls: 'bg-success/15 text-success border-success/30' },
    failed:   { label: 'stopped',  cls: 'bg-text-muted/15 text-text-muted border-border' },
  };
  const c = config[status] ?? { label: status, cls: 'bg-bg-tertiary/60 text-text-secondary border-border' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border uppercase tracking-widest ${c.cls}`}>
      {c.label}
    </span>
  );
}

function EmptyState({ filter, query, onStart }: { filter: StatusFilter; query: string; onStart: () => void }) {
  if (query.trim().length > 0) {
    return (
      <div className="max-w-md mx-auto px-5 py-12 text-center">
        <div className="text-text-muted text-sm mb-2">No missions match "{query}"</div>
        <div className="text-text-muted/70 text-xs">Try a shorter search term, or clear the filter.</div>
      </div>
    );
  }
  if (filter !== 'all') {
    return (
      <div className="max-w-md mx-auto px-5 py-12 text-center">
        <div className="text-text-muted text-sm">No {filter === 'live' ? 'in-progress' : filter} missions right now.</div>
      </div>
    );
  }
  return (
    <div className="max-w-md mx-auto px-5 py-16 text-center">
      <div className="text-text-secondary text-base mb-2">Nothing here yet.</div>
      <div className="text-text-muted text-sm mb-5">Past missions show up here so you can pick them back up anytime.</div>
      <button
        onClick={onStart}
        className="px-4 py-2 rounded-xl bg-gradient-to-br from-accent to-accent2 text-bg-deep font-semibold shadow-[0_0_24px_rgba(99,102,241,0.45)]"
      >Start your first mission</button>
    </div>
  );
}

function relativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
    if (ms < 7 * 86_400_000) return Math.floor(ms / 86_400_000) + 'd ago';
    return new Date(iso).toLocaleDateString();
  } catch { return ''; }
}
