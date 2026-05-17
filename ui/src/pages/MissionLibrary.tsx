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
 *
 * Beta.4 Wave 5 polish: full theme-token migration, scannable rows
 * with brass hover affordance, status pills, grouped by Active /
 * Recent / Archived, mono timestamps, brand-voice empty state,
 * brass-nameplate section headers, action buttons aligned to the
 * leather/metal palette, right gutter for the TopbarThemePicker.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { listMissions, deleteMission, type MissionRoom } from '@/api/missions';

type StatusFilter = 'all' | 'live' | 'done' | 'failed';

/** Reserves the right side of the leather strip so content doesn't
 * underflow the global TopbarThemePicker at top:48 right:12 w:238 h:33. */
const TOPBAR_GUTTER = 258;

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

  /**
   * Group rows by Active / Recent / Archived for long lists. "Active"
   * means the mission is doing something or wants attention; "Recent"
   * is finished within the last 7 days; "Archived" is everything else.
   * Only used when the list is long enough to benefit from sectioning.
   */
  const groups = useMemo(() => {
    const active: MissionRoom[] = [];
    const recent: MissionRoom[] = [];
    const archived: MissionRoom[] = [];
    const sevenDays = 7 * 86_400_000;
    const now = Date.now();
    for (const m of filtered) {
      if (['working', 'blocked', 'paused', 'forming'].includes(m.status)) {
        active.push(m);
        continue;
      }
      const age = (() => {
        try { return now - new Date(m.updatedAt).getTime(); } catch { return Infinity; }
      })();
      if (age < sevenDays) recent.push(m);
      else archived.push(m);
    }
    return { active, recent, archived };
  }, [filtered]);

  const showGroups = filtered.length > 8;

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden"
      style={{
        color: 'var(--theme-paper-fg)',
        fontFamily: 'var(--theme-font-display)',
        background: 'var(--theme-bg-base)',
      }}
    >
      {/* Top bar — leather strip. Right padding reserves room for the
          global TopbarThemePicker so our buttons don't underflow it. */}
      <header
        className="relative z-20 flex items-center gap-4 px-5 py-3"
        style={{
          paddingRight: TOPBAR_GUTTER,
          background: 'linear-gradient(180deg, var(--theme-leather-edge), var(--theme-leather))',
          borderBottom: '1px solid var(--theme-metal-dark)',
          boxShadow: '0 2px 12px var(--theme-shadow)',
        }}
      >
        <button
          onClick={() => navigate('/mission')}
          className="text-sm"
          style={{ color: 'var(--theme-metal)' }}
          title="Start a new mission"
        >←</button>
        <button
          onClick={() => navigate('/space/home')}
          className="text-[10px] uppercase tracking-widest rounded-full px-2 py-0.5 shrink-0 inline-flex items-center gap-1 border"
          style={{
            color: 'var(--theme-metal)',
            borderColor: 'var(--theme-metal-dark)',
            fontFamily: 'var(--theme-font-display)',
          }}
          title="Back to the canvas spaces"
        >
          🌌 Canvas
        </button>
        <div className="font-semibold tracking-tight shrink-0" style={{ color: 'var(--theme-paper-fg)' }}>
          <span style={{ color: 'var(--theme-metal)' }}>TITAN</span>
          <span className="font-normal" style={{ color: 'var(--theme-ink-soft)' }}> &nbsp;›&nbsp; </span>
          Mission Library
        </div>
        <div className="flex-1" />
        <button
          onClick={refresh}
          className="text-xs px-3 py-1.5 rounded-full border transition-colors"
          style={{
            color: 'var(--theme-ink-soft)',
            background: 'var(--theme-leather)',
            borderColor: 'var(--theme-metal-dark)',
            fontFamily: 'var(--theme-font-display)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--theme-metal-bright)';
            e.currentTarget.style.borderColor = 'var(--theme-metal)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--theme-ink-soft)';
            e.currentTarget.style.borderColor = 'var(--theme-metal-dark)';
          }}
          title="Reload"
        >⟳ refresh</button>
        <button
          onClick={() => navigate('/mission')}
          className="px-3 py-1.5 text-xs rounded-full font-semibold"
          style={{
            background: 'linear-gradient(135deg, var(--theme-metal-bright), var(--theme-metal-dark))',
            color: 'var(--theme-bolt)',
            boxShadow: '0 2px 8px var(--theme-shadow)',
            fontFamily: 'var(--theme-font-display)',
          }}
        >+ New mission</button>
      </header>

      {/* Filter / search row */}
      <div
        className="relative z-10 px-5 py-3 flex items-center gap-3 border-b"
        style={{
          borderBottomColor: 'var(--theme-metal-dark)',
          background: 'var(--theme-leather-edge)',
        }}
      >
        <FilterChip active={filter === 'all'}    label="All"         count={counts.all}    onClick={() => setFilter('all')} />
        <FilterChip active={filter === 'live'}   label="In progress" count={counts.live}   onClick={() => setFilter('live')}   dotColor="var(--theme-accent)" />
        <FilterChip active={filter === 'done'}   label="Done"        count={counts.done}   onClick={() => setFilter('done')}   dotColor="var(--theme-metal)" />
        <FilterChip active={filter === 'failed'} label="Stopped"     count={counts.failed} onClick={() => setFilter('failed')} dotColor="var(--theme-ink-soft)" />
        <div className="flex-1" />
        <ThemedSearchInput value={query} onChange={setQuery} />
      </div>

      {/* Body */}
      <main className="relative z-10 flex-1 overflow-y-auto">
        {error && (
          <div
            className="max-w-3xl mx-auto px-5 py-6 text-sm"
            style={{ color: 'var(--theme-accent)', fontFamily: 'var(--theme-font-mono)' }}
          >
            {error}
          </div>
        )}
        {missions === null && !error && (
          <div
            className="max-w-3xl mx-auto px-5 py-6 text-sm"
            style={{ color: 'var(--theme-ink-soft)', fontFamily: 'var(--theme-font-mono)' }}
          >
            Loading missions…
          </div>
        )}
        {missions !== null && filtered.length === 0 && (
          <EmptyState filter={filter} query={query} onStart={() => navigate('/mission')} />
        )}
        {missions !== null && filtered.length > 0 && !showGroups && (
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
        {missions !== null && filtered.length > 0 && showGroups && (
          <div className="max-w-3xl mx-auto px-5 py-4 flex flex-col gap-6">
            {groups.active.length > 0 && (
              <Section title="Active" subtitle="working, blocked, paused, or forming">
                {groups.active.map(m => (
                  <MissionRow
                    key={m.id}
                    mission={m}
                    onClick={() => navigate(`/mission/${m.id}`)}
                    onDelete={() => handleDelete(m.id, m.goal)}
                  />
                ))}
              </Section>
            )}
            {groups.recent.length > 0 && (
              <Section title="Recent" subtitle="completed within the last 7 days">
                {groups.recent.map(m => (
                  <MissionRow
                    key={m.id}
                    mission={m}
                    onClick={() => navigate(`/mission/${m.id}`)}
                    onDelete={() => handleDelete(m.id, m.goal)}
                  />
                ))}
              </Section>
            )}
            {groups.archived.length > 0 && (
              <Section title="Archived" subtitle="older finished missions">
                {groups.archived.map(m => (
                  <MissionRow
                    key={m.id}
                    mission={m}
                    onClick={() => navigate(`/mission/${m.id}`)}
                    onDelete={() => handleDelete(m.id, m.goal)}
                  />
                ))}
              </Section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

/* ─────────────────────────── Section header ─────────────────────────── */

/** Brass nameplate style: a leather plate with metal border and
 *  display-font caption. Used to fence off long lists into Active /
 *  Recent / Archived. */
function Section({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div
        className="inline-flex items-baseline gap-3 self-start px-3 py-1 rounded-md border"
        style={{
          background: 'linear-gradient(180deg, var(--theme-leather), var(--theme-leather-edge))',
          borderColor: 'var(--theme-metal-dark)',
          boxShadow: 'inset 0 0 0 1px var(--theme-metal-dark), 0 1px 4px var(--theme-shadow)',
        }}
      >
        <span
          className="text-[11px] uppercase tracking-[0.18em] font-semibold"
          style={{ color: 'var(--theme-metal-bright)', fontFamily: 'var(--theme-font-display)' }}
        >
          {title}
        </span>
        {subtitle && (
          <span
            className="text-[10px]"
            style={{ color: 'var(--theme-ink-soft)', fontFamily: 'var(--theme-font-mono)' }}
          >
            {subtitle}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

/* ─────────────────────────── Search input ─────────────────────────── */

function ThemedSearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder="Search goals…"
      className="w-72 rounded-full px-4 py-1.5 text-sm outline-none transition-colors"
      style={{
        background: 'var(--theme-paper)',
        color: 'var(--theme-ink)',
        border: `1px solid ${focused ? 'var(--theme-metal)' : 'var(--theme-metal-dark)'}`,
        boxShadow: focused ? '0 0 0 2px var(--theme-menu-hover)' : 'none',
        fontFamily: 'var(--theme-font-display)',
      }}
    />
  );
}

/* ─────────────────────────── Filter chip ─────────────────────────── */

function FilterChip({
  active, label, count, onClick, dotColor,
}: { active: boolean; label: string; count: number; onClick: () => void; dotColor?: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-colors"
      style={{
        background: active
          ? 'var(--theme-menu-active-bg)'
          : hover
            ? 'var(--theme-menu-hover)'
            : 'transparent',
        color: active
          ? 'var(--theme-menu-active-fg)'
          : 'var(--theme-ink-soft)',
        borderColor: active ? 'var(--theme-metal)' : 'var(--theme-metal-dark)',
        fontFamily: 'var(--theme-font-display)',
      }}
    >
      {dotColor && (
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: dotColor }}
        />
      )}
      <span>{label}</span>
      <span
        style={{
          color: active ? 'var(--theme-menu-active-fg)' : 'var(--theme-ink-soft)',
          opacity: 0.7,
          fontFamily: 'var(--theme-font-mono)',
        }}
      >
        {count}
      </span>
    </button>
  );
}

/* ─────────────────────────── Mission row ─────────────────────────── */

function MissionRow({
  mission, onClick, onDelete,
}: {
  mission: MissionRoom;
  onClick: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const updated = relativeTime(mission.updatedAt);
  const isLive = ['working', 'blocked', 'paused', 'forming'].includes(mission.status);

  return (
    <li
      className="relative group"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        onClick={onClick}
        className="w-full text-left rounded-xl px-4 py-3 transition-all"
        style={{
          background: hover ? 'var(--theme-menu-hover)' : 'var(--theme-paper)',
          color: 'var(--theme-ink)',
          border: `1px solid ${hover ? 'var(--theme-metal)' : 'var(--theme-metal-dark)'}`,
          boxShadow: hover
            ? '0 3px 10px var(--theme-shadow)'
            : '0 1px 3px var(--theme-shadow)',
          transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        }}
      >
        <div className="flex items-center gap-3 mb-2">
          <div
            className="text-sm font-semibold flex-1 truncate"
            style={{
              color: 'var(--theme-ink)',
              fontFamily: 'var(--theme-font-display)',
            }}
          >
            {mission.goal || '(no goal)'}
          </div>
          {/* Status + updated fade out on hover so the action rail
              (also pinned top-right) doesn't visually collide. */}
          <div
            className="flex items-center gap-3 transition-opacity"
            style={{ opacity: hover ? 0 : 1 }}
          >
            <StatusBadge status={mission.status} />
            <div
              className="text-[11px] shrink-0"
              style={{
                color: 'var(--theme-ink-soft)',
                fontFamily: 'var(--theme-font-mono)',
              }}
            >
              {updated}
            </div>
          </div>
        </div>
        <div
          className="flex items-center gap-3 text-[11px]"
          style={{
            color: 'var(--theme-ink-soft)',
            fontFamily: 'var(--theme-font-mono)',
          }}
        >
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
            <span
              className="ml-auto text-[10px] uppercase tracking-widest"
              style={{ color: 'var(--theme-metal-dark)' }}
            >
              {mission.playId}
            </span>
          )}
        </div>
      </button>

      {/* Action rail — appears on hover. stopPropagation so clicks
          don't also fire the row's onClick. */}
      <div
        className="absolute top-2 right-2 flex items-center gap-1.5 transition-opacity"
        style={{ opacity: hover ? 1 : 0 }}
      >
        <RowActionButton
          label={isLive ? 'Resume' : 'Open'}
          icon={isLive ? '▶' : '↗'}
          variant="primary"
          onClick={(e) => { e.stopPropagation(); onClick(); }}
        />
        <RowActionButton
          label="Delete"
          icon="🗑"
          variant="muted"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        />
      </div>
    </li>
  );
}

/* ─────────────────────────── Row action button ─────────────────────────── */

function RowActionButton({
  label, icon, variant, onClick,
}: {
  label: string;
  icon: string;
  variant: 'primary' | 'muted';
  onClick: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  if (variant === 'primary') {
    return (
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-widest border transition-colors"
        style={{
          background: hover ? 'var(--theme-metal-bright)' : 'var(--theme-metal)',
          color: 'var(--theme-bolt)',
          borderColor: 'var(--theme-metal-dark)',
          fontFamily: 'var(--theme-font-display)',
        }}
        title={label}
        aria-label={label}
      >
        <span aria-hidden>{icon}</span>
        <span>{label}</span>
      </button>
    );
  }
  // muted — delete. Turns rose/accent on hover.
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center justify-center w-7 h-7 rounded-md text-sm border transition-colors"
      style={{
        background: hover ? 'var(--theme-accent)' : 'var(--theme-paper)',
        color: hover ? 'var(--theme-paper)' : 'var(--theme-ink-soft)',
        borderColor: hover ? 'var(--theme-accent)' : 'var(--theme-metal-dark)',
      }}
      title={label}
      aria-label={label}
    >
      <span aria-hidden>{icon}</span>
    </button>
  );
}

/* ─────────────────────────── Status badge ─────────────────────────── */

function StatusBadge({ status }: { status: MissionRoom['status'] }) {
  // Map each status to a (background, foreground, border) tuple drawn
  // from theme tokens, so the pill always feels native to the active
  // theme rather than carrying hardcoded reds/greens.
  const config: Record<MissionRoom['status'], { label: string; bg: string; fg: string; border: string; pulse?: boolean }> = {
    forming:  { label: 'forming',    bg: 'var(--theme-leather)',       fg: 'var(--theme-metal-bright)', border: 'var(--theme-metal-dark)' },
    working:  { label: 'live',       bg: 'var(--theme-accent)',        fg: 'var(--theme-paper)',        border: 'var(--theme-accent)' },
    blocked:  { label: 'needs you',  bg: 'var(--theme-accent)',        fg: 'var(--theme-paper)',        border: 'var(--theme-accent)', pulse: true },
    paused:   { label: 'paused',     bg: 'var(--theme-metal)',         fg: 'var(--theme-bolt)',         border: 'var(--theme-metal-dark)' },
    done:     { label: 'done',       bg: 'var(--theme-menu-active-bg)',fg: 'var(--theme-menu-active-fg)', border: 'var(--theme-metal-dark)' },
    failed:   { label: 'stopped',    bg: 'var(--theme-leather-edge)',  fg: 'var(--theme-ink-soft)',     border: 'var(--theme-metal-dark)' },
  };
  const c = config[status] ?? config.forming;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border uppercase tracking-widest ${c.pulse ? 'animate-pulse' : ''}`}
      style={{
        background: c.bg,
        color: c.fg,
        borderColor: c.border,
        fontFamily: 'var(--theme-font-display)',
      }}
    >
      {c.label}
    </span>
  );
}

/* ─────────────────────────── Empty state ─────────────────────────── */

function EmptyState({ filter, query, onStart }: { filter: StatusFilter; query: string; onStart: () => void }) {
  if (query.trim().length > 0) {
    return (
      <div className="max-w-md mx-auto px-5 py-12 text-center">
        <div
          className="text-sm mb-2"
          style={{ color: 'var(--theme-paper-fg)', fontFamily: 'var(--theme-font-display)' }}
        >
          No missions match "{query}"
        </div>
        <div
          className="text-xs"
          style={{ color: 'var(--theme-ink-soft)', fontFamily: 'var(--theme-font-mono)' }}
        >
          Try a shorter search term, or clear the filter.
        </div>
      </div>
    );
  }
  if (filter !== 'all') {
    return (
      <div className="max-w-md mx-auto px-5 py-12 text-center">
        <div
          className="text-sm"
          style={{ color: 'var(--theme-ink-soft)', fontFamily: 'var(--theme-font-display)' }}
        >
          No {filter === 'live' ? 'in-progress' : filter} missions right now.
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-md mx-auto px-5 py-16 text-center flex flex-col items-center gap-5">
      {/* A calm brass medallion — pure CSS so it adopts the active
          theme's metal automatically. Reads as a stamped library tag. */}
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center"
        style={{
          background: 'radial-gradient(circle at 30% 25%, var(--theme-metal-bright), var(--theme-metal-dark) 70%)',
          boxShadow: 'inset 0 -3px 6px var(--theme-shadow), 0 4px 14px var(--theme-shadow)',
          border: '1px solid var(--theme-metal-dark)',
          color: 'var(--theme-bolt)',
          fontFamily: 'var(--theme-font-display)',
          fontSize: 28,
        }}
        aria-hidden
      >
        ⚙
      </div>
      <div
        className="text-base"
        style={{ color: 'var(--theme-paper-fg)', fontFamily: 'var(--theme-font-display)' }}
      >
        No missions yet.
      </div>
      <div
        className="text-sm"
        style={{ color: 'var(--theme-ink-soft)', fontFamily: 'var(--theme-font-display)' }}
      >
        Start one from the Mission Start page.
      </div>
      <button
        onClick={onStart}
        className="px-4 py-2 rounded-xl font-semibold transition-transform"
        style={{
          background: 'linear-gradient(135deg, var(--theme-metal-bright), var(--theme-metal-dark))',
          color: 'var(--theme-bolt)',
          boxShadow: '0 4px 14px var(--theme-shadow)',
          border: '1px solid var(--theme-metal-dark)',
          fontFamily: 'var(--theme-font-display)',
        }}
        onMouseDown={(e) => { e.currentTarget.style.transform = 'translateY(1px)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
      >
        Start your first mission
      </button>
    </div>
  );
}

/* ─────────────────────────── Helpers ─────────────────────────── */

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
