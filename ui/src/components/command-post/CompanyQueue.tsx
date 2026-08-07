/**
 * CompanyQueue — v8 Slice 2 Work Queue surface for Mission Control
 *
 * This is the real UI built from the queue.html mockup. It reads the
 * derived queue state (slots, presence, commitments) from
 * /api/company/queue, which is a fold over the append-only event log.
 *
 * The queue shows:
 *   - Work slots with states (queued, running, blocked, held, done, discarded)
 *   - Blocks and holds with their release authority (per V8_SLICE2_DESIGN §1)
 *   - Derived presence (blocked > stuck > working > waiting > idle — never self-reported)
 *   - Open/closed commitments with overdue flagging
 *   - The watchman's active flags
 *
 * Behind company.queue.enabled=false (default), the parent does not
 * render this tab — the gateway 404s and the UI never mounts.
 *
 * Author: Ivy · 2026-08-07 · per Claude's Slice 2 green-light (event 7ebc989e)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ListOrdered,
  Lock,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Link2,
  Eye,
  Loader2,
  Shield,
} from 'lucide-react';
import {
  getQueueFold,
  getQueuePresence,
  liftHold,
  clearBlock,
  closeCommitment,
} from '@/api/client';
import type {
  QueueFold,
  QueueSlot,
  QueuePresence,
  QueueCommitment,
  QueueSlotState,
  PresenceStatus,
} from '@/api/types';

// ─── Helpers ─────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function timeAgoShort(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '<1m';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function formatDeadline(ts: number): string {
  const diff = ts - Date.now();
  if (diff < 0) return `overdue by ${timeAgoShort(ts)}`;
  if (diff < 3_600_000) return `due in ${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `due in ${Math.floor(diff / 3_600_000)}h`;
  return `due in ${Math.floor(diff / 86_400_000)}d`;
}

/** Deterministic avatar color from a string (agent id or name) */
const AVATAR_COLORS = [
  'bg-purple-500/20 text-purple-300',
  'bg-amber-500/20 text-amber-300',
  'bg-blue-500/20 text-blue-300',
  'bg-emerald-500/20 text-emerald-300',
  'bg-rose-500/20 text-rose-300',
  'bg-cyan-500/20 text-cyan-300',
  'bg-indigo-500/20 text-indigo-300',
  'bg-slate-500/20 text-slate-300',
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarInitial(name: string): string {
  return name.charAt(0).toUpperCase() || '?';
}

// ─── State styling ───────────────────────────────────────────

const STATE_STYLES: Record<QueueSlotState, { label: string; className: string; borderClass: string }> = {
  queued:    { label: 'Queued',    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', borderClass: 'border-l-amber-500' },
  running:   { label: 'Running',   className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', borderClass: 'border-l-emerald-500' },
  reviewing: { label: 'Reviewing', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', borderClass: 'border-l-sky-500' },
  blocked:   { label: 'Blocked',   className: 'bg-orange-500/15 text-orange-600 dark:text-orange-400', borderClass: 'border-l-orange-500' },
  held:      { label: 'Held',      className: 'bg-red-500/15 text-red-600 dark:text-red-400', borderClass: 'border-l-red-500' },
  done:      { label: 'Done',      className: 'bg-green-500/15 text-green-600 dark:text-green-400', borderClass: 'border-l-green-500' },
  discarded: { label: 'Discarded', className: 'bg-slate-500/15 text-slate-500', borderClass: 'border-l-slate-400' },
};

const PRESENCE_STYLES: Record<PresenceStatus, { dot: string; label: string }> = {
  working:  { dot: 'bg-emerald-500', label: 'working' },
  blocked:  { dot: 'bg-orange-500', label: 'blocked' },
  stuck:    { dot: 'bg-red-500', label: 'stuck' },
  waiting:  { dot: 'bg-amber-500', label: 'waiting' },
  idle:     { dot: 'bg-slate-400', label: 'idle' },
};

// ─── Slot Card ───────────────────────────────────────────────

function SlotCard({ slot, onLiftHold, onClearBlock, acting }: {
  slot: QueueSlot;
  onLiftHold: (taskRef: string) => void;
  onClearBlock: (taskRef: string) => void;
  acting: string | null;
}) {
  const style = STATE_STYLES[slot.state];
  const ownerName = slot.ownerName || slot.owner.slice(0, 8) + '…';
  const isDone = slot.state === 'done';
  const isDiscarded = slot.state === 'discarded';
  const dimmed = isDone || isDiscarded;

  return (
    <div
      className={`rounded-lg border border-border bg-bg-secondary p-4 border-l-4 ${style.borderClass} ${dimmed ? 'opacity-70' : ''} transition-shadow hover:shadow-md`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[11px] font-bold text-text-muted bg-bg-tertiary px-2 py-0.5 rounded">
          #{slot.slot}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${style.className}`}>
          {style.label}
          {isDone && slot.verdict ? ` · ${slot.verdict}` : ''}
        </span>
        {slot.prevVerdict && (
          <span className="text-[10px] text-text-muted">
            prev: {slot.prevVerdict}
          </span>
        )}
        <span className="text-[11px] text-text-muted ml-auto">
          {timeAgo(slot.stateSince)}
        </span>
      </div>

      {/* Spec */}
      <div className="text-sm text-text-secondary leading-relaxed mb-3">
        {slot.spec}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${avatarColor(slot.owner)}`}>
            {avatarInitial(ownerName)}
          </div>
          <span className="text-xs text-text-secondary">{ownerName}</span>
          {slot.ownerRole && (
            <span className="text-[10px] text-text-muted">· {slot.ownerRole}</span>
          )}
        </div>
        <span className="font-mono text-[11px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded">
          attempt {slot.attempt}
        </span>
        {slot.lastEvidence && (
          <span className="text-[11px] text-text-muted">{slot.lastEvidence}</span>
        )}
        {slot.ownerUnavailable && (
          <span className="text-[11px] text-red-500 font-medium">
            ⚠ {slot.ownerUnavailableReason || 'owner unavailable'}
          </span>
        )}
      </div>

      {/* Block gate */}
      {slot.block && (
        <div className="mt-3 p-2.5 rounded-md bg-orange-500/5 border border-orange-500/20 text-xs text-orange-600 dark:text-orange-400 leading-relaxed">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle size={12} className="shrink-0" />
            <strong>Blocked by {slot.block.setter}:</strong>{' '}
            <span>{slot.block.reason}</span>
          </div>
          {slot.block.autoClearable && (
            <div className="text-[11px] text-text-muted ml-5">
              Auto-clears when owner progress is observed.
            </div>
          )}
          <button
            onClick={() => onClearBlock(slot.taskRef)}
            disabled={acting === slot.taskRef}
            className="mt-1.5 ml-5 text-[11px] font-semibold text-accent hover:underline disabled:opacity-50"
          >
            {acting === slot.taskRef ? 'Clearing…' : `Clear block (${slot.block.setter === 'watchman' ? 'setter or user' : 'user only'})`}
          </button>
        </div>
      )}

      {/* Hold gate */}
      {slot.hold && (
        <div className="mt-3 p-2.5 rounded-md bg-red-500/5 border border-red-500/20 text-xs text-red-600 dark:text-red-400 leading-relaxed">
          <div className="flex items-center gap-1.5 mb-1">
            <Lock size={12} className="shrink-0" />
            <strong>Hold set by {slot.hold.setter}:</strong>{' '}
            <span>{slot.hold.reason}</span>
          </div>
          <div className="text-[11px] text-text-muted ml-5">
            Human-attention gate — dispatch blocked until lifted. Holds are user-only.
          </div>
          <button
            onClick={() => onLiftHold(slot.taskRef)}
            disabled={acting === slot.taskRef}
            className="mt-1.5 ml-5 text-[11px] font-semibold text-accent hover:underline disabled:opacity-50"
          >
            {acting === slot.taskRef ? 'Lifting…' : 'Lift hold (user only)'}
          </button>
        </div>
      )}

      {/* Verdict note */}
      {isDone && slot.verdictNote && (
        <div className="mt-2 text-xs text-text-muted italic">
          {slot.verdictNote}
        </div>
      )}
    </div>
  );
}

// ─── Presence Card ───────────────────────────────────────────

function PresenceCard({ p }: { p: QueuePresence }) {
  const style = PRESENCE_STYLES[p.status];
  return (
    <div className="flex items-start gap-2.5 p-2.5 rounded-md hover:bg-bg-tertiary/50 transition-colors">
      <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold relative ${avatarColor(p.agentId)}`}>
        {avatarInitial(p.displayName)}
        <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg-secondary ${style.dot}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-text">{p.displayName}</div>
        <div className="text-[11px] text-text-muted truncate">{p.activity}</div>
        <div className="text-[10px] text-text-muted italic">
          {p.derived}
        </div>
      </div>
    </div>
  );
}

// ─── Commitment Card ─────────────────────────────────────────

function CommitmentCard({ c, onClose, acting }: {
  c: QueueCommitment;
  onClose: (id: string) => void;
  acting: string | null;
}) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-md border border-border bg-bg-secondary ${c.overdue ? 'border-l-2 border-l-red-500' : ''} ${c.closed ? 'opacity-55' : ''}`}>
      <div className="shrink-0">
        {c.closed ? (
          <CheckCircle2 size={16} className="text-green-500" />
        ) : c.overdue ? (
          <Clock size={16} className="text-red-500" />
        ) : (
          <Link2 size={16} className="text-accent" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-secondary leading-snug">
          <strong className="text-text">{c.agentName || c.agent.slice(0, 8) + '…'}</strong>{' '}
          {c.text}
        </div>
        {c.closed && c.closeNote && (
          <div className="text-[11px] text-text-muted italic mt-0.5">{c.closeNote}</div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[11px] text-text-muted">
          {c.closed ? `closed ${timeAgo(c.closedAt!)}` : `opened ${timeAgo(c.openedAt)}`}
        </div>
        {!c.closed && c.dueAt && (
          <div className={`text-[11px] font-semibold ${c.overdue ? 'text-red-500' : 'text-text-muted'}`}>
            {formatDeadline(c.dueAt)}
          </div>
        )}
        {!c.closed && (
          <button
            onClick={() => onClose(c.id)}
            disabled={acting === c.id}
            className="text-[10px] font-semibold text-accent hover:underline disabled:opacity-50 mt-0.5"
          >
            {acting === c.id ? 'closing…' : 'close'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export function CompanyQueue() {
  const [fold, setFold] = useState<QueueFold | null>(null);
  const [presence, setPresence] = useState<QueuePresence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Per Fizz's API contract (event 931415b2):
      //   GET /api/company/queue returns the fold (slots, commitments, counts)
      //   GET /api/company/presence returns the derived presence
      // Both are behind company.queue.enabled; 404 when off.
      const [foldRes, presenceRes] = await Promise.all([
        getQueueFold(),
        getQueuePresence().catch(() => ({ presence: [], now: Date.now() })),
      ]);
      setFold(foldRes);
      setPresence(presenceRes.presence || []);
      setError(null);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('404')) {
        setError('Work queue is not enabled. Set company.queue.enabled = true in titan.json to activate the v8 work queue.');
      } else {
        setError(msg);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    // Poll every 10s — the queue is live-derived state
    refreshTimerRef.current = setInterval(refresh, 10_000);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [refresh]);

  // ── Actions ──
  const handleLiftHold = useCallback(async (taskRef: string) => {
    setActing(taskRef);
    try {
      await liftHold(taskRef);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setActing(null);
  }, [refresh]);

  const handleClearBlock = useCallback(async (taskRef: string) => {
    setActing(taskRef);
    try {
      await clearBlock(taskRef);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setActing(null);
  }, [refresh]);

  const handleCloseCommitment = useCallback(async (id: string) => {
    setActing(id);
    try {
      await closeCommitment(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setActing(null);
  }, [refresh]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-3">
          <Loader2 size={20} className="animate-spin text-accent" />
          <span className="text-sm text-text-muted">Loading work queue…</span>
        </div>
      </div>
    );
  }

  // ── Error / disabled state ──
  if (error) {
    return (
      <div className="flex items-center justify-center h-full px-6">
        <div className="max-w-md text-center">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            v8 Work Queue
          </div>
          <p className="text-sm text-text-secondary leading-relaxed mb-4">{error}</p>
          <button
            onClick={refresh}
            className="px-4 py-2 text-sm bg-bg-tertiary rounded-lg hover:bg-border text-text-secondary transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!fold) return null;

  const activeSlots = fold.slots.filter(s => s.state !== 'done' && s.state !== 'discarded');
  const doneSlots = fold.slots.filter(s => s.state === 'done' || s.state === 'discarded');
  const openCommitments = fold.commitments.filter(c => !c.closed);
  const closedCommitments = fold.commitments.filter(c => c.closed);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Queue header ── */}
      <div className="shrink-0 border-b border-border bg-bg/95 backdrop-blur px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-text">The Work Queue</h2>
            <p className="text-[10px] text-text-muted">
              one lane · one heavy job at a time · presence derived from truth
            </p>
          </div>
        </div>
      </div>

      {/* ── Queue body: main + presence rail ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* ── Main column ── */}
        <div className="flex-1 overflow-y-auto p-4">

          {/* ── Summary bar ── */}
          <div className="flex items-center gap-4 mb-4 p-3 rounded-lg border border-border bg-bg-secondary shadow-sm">
            <div className="flex flex-col">
              <span className="font-serif text-xl font-bold text-text">{fold.runningCount}</span>
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Running</span>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="flex flex-col">
              <span className="font-serif text-xl font-bold text-text">{fold.queuedCount}</span>
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Queued</span>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="flex flex-col">
              <span className="font-serif text-xl font-bold text-orange-500">{fold.blockedCount}</span>
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Blocked</span>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="flex flex-col">
              <span className="font-serif text-xl font-bold text-red-500">{fold.heldCount}</span>
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Held</span>
            </div>
            <div className="ml-auto flex items-center gap-1.5 text-xs text-text-secondary">
              <div className={`w-2 h-2 rounded-full ${fold.laneBusy ? 'bg-emerald-500 shadow-[0_0_6px_rgba(74,222,128,0.6)]' : 'bg-slate-400'}`} />
              <span>
                {fold.laneBusy
                  ? `Lane busy · ${fold.laneOwner || 'agent'} working`
                  : 'Lane idle'}
              </span>
            </div>
          </div>

          {/* ── Active slots ── */}
          {activeSlots.length === 0 && doneSlots.length === 0 ? (
            <div className="text-center py-16 text-text-muted">
              <ListOrdered size={40} className="mx-auto mb-3 opacity-30" />
              <div className="text-sm">No tasks in the queue yet.</div>
              <div className="text-xs mt-1">Delegate from the Company Room to fill the queue.</div>
            </div>
          ) : (
            <>
              {activeSlots.length > 0 && (
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted px-1">
                  Active
                </div>
              )}
              <div className="space-y-2 mb-6">
                {activeSlots.map(slot => (
                  <SlotCard
                    key={slot.taskRef}
                    slot={slot}
                    onLiftHold={handleLiftHold}
                    onClearBlock={handleClearBlock}
                    acting={acting}
                  />
                ))}
              </div>

              {doneSlots.length > 0 && (
                <>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted px-1">
                    Completed
                  </div>
                  <div className="space-y-2 mb-6">
                    {doneSlots.map(slot => (
                      <SlotCard
                        key={slot.taskRef}
                        slot={slot}
                        onLiftHold={handleLiftHold}
                        onClearBlock={handleClearBlock}
                        acting={acting}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Commitments ── */}
          {fold.commitments.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Link2 size={16} className="text-accent" />
                <h3 className="text-sm font-semibold text-text">Commitments</h3>
                <span className="text-[11px] font-semibold text-text-muted bg-bg-tertiary px-2 py-0.5 rounded-full">
                  {openCommitments.length} open
                </span>
                {fold.overdueCommitments > 0 && (
                  <span className="text-[11px] font-semibold text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full">
                    {fold.overdueCommitments} overdue
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                {openCommitments.sort((a, b) => {
                  if (a.overdue && !b.overdue) return -1;
                  if (!a.overdue && b.overdue) return 1;
                  return a.openedAt - b.openedAt;
                }).map(c => (
                  <CommitmentCard key={c.id} c={c} onClose={handleCloseCommitment} acting={acting} />
                ))}
                {closedCommitments.slice(0, 5).map(c => (
                  <CommitmentCard key={c.id} c={c} onClose={handleCloseCommitment} acting={acting} />
                ))}
              </div>
            </div>
          )}

          {/* ── Watchman ── */}
          {fold.slots.some(s => s.block?.setter === 'watchman') && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Eye size={16} className="text-slate-400" />
                <h3 className="text-sm font-semibold text-text">Watchman</h3>
                <span className="text-[11px] font-semibold text-text-muted bg-bg-tertiary px-2 py-0.5 rounded-full">
                  {fold.slots.filter(s => s.block?.setter === 'watchman').length} flag{fold.slots.filter(s => s.block?.setter === 'watchman').length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="p-3 rounded-lg bg-slate-500/5 border border-slate-500/15 mb-2">
                <div className="text-xs font-semibold text-text-secondary flex items-center gap-1.5 mb-1">
                  <Shield size={12} />
                  Authority: flag and hold, never act
                </div>
                <div className="text-[11px] text-text-muted leading-relaxed">
                  The watchman monitors for stuck slots and rule violations. It can set blocks
                  and holds but cannot lift them — holds are user-only, blocks are setter-or-user.
                  The supervisor auto-clears <span className="font-mono">stalled</span> blocks when
                  owner progress is observed.
                </div>
              </div>
              <div className="space-y-1.5">
                {fold.slots.filter(s => s.block?.setter === 'watchman').map(slot => (
                  <div
                    key={slot.taskRef}
                    className="rounded-lg border border-border border-l-2 border-l-orange-500 bg-orange-500/5 p-3"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-[11px] font-bold text-text-muted bg-bg-tertiary px-2 py-0.5 rounded">
                        #{slot.slot}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-red-500/15 text-red-500">
                        Stalled
                      </span>
                      <span className="text-[11px] text-text-muted ml-auto">
                        flagged {timeAgo(slot.block!.at)}
                      </span>
                    </div>
                    <div className="text-xs text-text-secondary leading-relaxed">
                      Owner silence exceeded expected cadence. Block set by watchman.
                      {' '}
                      {slot.block!.autoClearable && (
                        <span className="text-text-muted">
                          Auto-clears when a <code className="font-mono text-[11px] bg-bg-tertiary px-1 rounded">task.result</code> from the owner for attempt {slot.attempt} lands.
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Presence rail ── */}
        <div className="w-64 shrink-0 border-l border-border bg-bg-secondary/50 overflow-y-auto p-3">
          <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold mb-1">
            Crew Presence
          </div>
          <div className="text-[10px] text-text-muted italic mb-3">
            derived from queue state + receipts
          </div>
          <div className="space-y-1 mb-4">
            {presence.map(p => (
              <PresenceCard key={p.agentId} p={p} />
            ))}
          </div>

          {/* Queue stats */}
          <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold mb-2 mt-4">
            Queue Stats
          </div>
          <div className="text-xs text-text-secondary space-y-1.5">
            <div>📋 <strong className="text-text">{fold.slots.length}</strong> total slots</div>
            <div>✅ <strong className="text-green-500">{fold.doneCount}</strong> checked</div>
            <div>🔗 <strong className="text-text">{fold.openCommitments}</strong> open commitments</div>
            {fold.overdueCommitments > 0 && (
              <div>⏰ <strong className="text-red-500">{fold.overdueCommitments}</strong> overdue</div>
            )}
            <div><strong className="text-accent">1</strong> lane · serialized</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CompanyQueue;
