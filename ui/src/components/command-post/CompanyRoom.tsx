/**
 * CompanyRoom — v8 Slice 1 shared room surface for Mission Control
 *
 * This is the real UI built from the company-room.html mockup. It reads
 * signed events from the append-only event log via /api/company/room,
 * renders them as a flat chat (no threads, per the architecture doc),
 * and live-updates via SSE on /api/company/stream.
 *
 * The room shows all six slice-1 event kinds:
 *   - company.created → system banner
 *   - agent.minted    → system banner ("X joined the crew as Role")
 *   - room.message    → chat message bubble
 *   - task.delegated  → delegation card
 *   - task.result     → result card
 *   - task.checked    → check/verdict card
 *
 * Behind company.enabled=false (default), the parent CommandPostHub
 * does not render this tab — the gateway 404s and the UI never mounts.
 *
 * Author: Ivy · 2026-08-07 · per Claude's course correction (event 30d54090)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Send, Users, Plus, Shield, GitBranch, CheckCircle2, XCircle, ArrowRight } from 'lucide-react';
import {
  getCompanyStatus,
  getCompanyRoom,
  postCompanyMessage,
  delegateCompanyTask,
  createV8Company,
} from '@/api/client';
import type { CompanyEvent, CompanyStatus, CompanyAgent } from '@/api/types';

// ─── Helpers ─────────────────────────────────────────────────

function timeFormat(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Resolve an actor id to a display name + role from the crew list */
function actorInfo(actor: string, agents: CompanyAgent[]): { name: string; role: string; isUser: boolean } {
  if (actor === 'user') return { name: 'You', role: 'Owner', isUser: true };
  const agent = agents.find(a => a.agentId === actor);
  if (agent) return { name: agent.displayName, role: agent.role, isUser: false };
  // Fall back to short hex if we don't have a name yet
  return { name: actor.slice(0, 8) + '…', role: 'Agent', isUser: false };
}

/** Deterministic avatar color from a string (agent id or name) */
const AVATAR_COLORS = [
  'bg-blue-500/20 text-blue-300',
  'bg-emerald-500/20 text-emerald-300',
  'bg-purple-500/20 text-purple-300',
  'bg-amber-500/20 text-amber-300',
  'bg-rose-500/20 text-rose-300',
  'bg-cyan-500/20 text-cyan-300',
  'bg-indigo-500/20 text-indigo-300',
  'bg-teal-500/20 text-teal-300',
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarInitial(name: string): string {
  return name.charAt(0).toUpperCase() || '?';
}

// ─── Event renderers ─────────────────────────────────────────

function SystemBanner({ event, agents }: { event: CompanyEvent; agents: CompanyAgent[] }) {
  if (event.kind === 'company.created') {
    const name = event.payload.name as string || 'Company';
    return (
      <div className="flex items-center justify-center py-3">
        <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-accent/10 text-accent-light text-[11px] font-medium">
          <Shield size={12} />
          <span>Company "{name}" created</span>
        </div>
      </div>
    );
  }
  if (event.kind === 'agent.minted') {
    const name = event.payload.name as string || 'Agent';
    const role = event.payload.role as string || 'Agent';
    return (
      <div className="flex items-center justify-center py-2">
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-bg-tertiary text-text-muted text-[10px]">
          <Plus size={10} />
          <span><strong className="text-text-secondary">{name}</strong> joined the crew as {role}</span>
        </div>
      </div>
    );
  }
  return null;
}

function ChatMessage({ event, agents }: { event: CompanyEvent; agents: CompanyAgent[] }) {
  const { name, role, isUser } = actorInfo(event.actor, agents);
  const text = (event.payload.text as string) || '';
  const replyTo = event.payload.replyTo as string | undefined;

  return (
    <div className="flex gap-3 py-2 px-4 hover:bg-bg-tertiary/30 transition-colors">
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${isUser ? 'bg-accent/20 text-accent-light' : avatarColor(event.actor)}`}>
        {avatarInitial(name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-sm font-semibold text-text">{name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{role}</span>
          <span className="text-[10px] text-text-muted ml-auto">{timeFormat(event.ts)}</span>
        </div>
        {replyTo && (
          <div className="text-[10px] text-text-muted mb-1 border-l-2 border-border pl-2">
            ↳ reply to {replyTo.slice(0, 8)}…
          </div>
        )}
        <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
          {text}
        </div>
      </div>
    </div>
  );
}

function TaskCard({ event, agents }: { event: CompanyEvent; agents: CompanyAgent[] }) {
  const { name, role, isUser } = actorInfo(event.actor, agents);

  if (event.kind === 'task.delegated') {
    const toAgent = agents.find(a => a.agentId === event.payload.to);
    const toName = toAgent?.displayName || (event.payload.to as string || '').slice(0, 8) + '…';
    const spec = (event.payload.spec as string) || '';
    return (
      <div className="flex gap-3 py-2 px-4">
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${isUser ? 'bg-accent/20 text-accent-light' : avatarColor(event.actor)}`}>
          {avatarInitial(name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-sm font-semibold text-text">{name}</span>
            <span className="text-[10px] text-text-muted">delegated to</span>
            <span className="text-sm font-semibold text-accent-light">{toName}</span>
            <span className="text-[10px] text-text-muted ml-auto">{timeFormat(event.ts)}</span>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-3">
            <div className="flex items-start gap-2">
              <ArrowRight size={14} className="text-accent-light mt-0.5 shrink-0" />
              <div className="text-sm text-text-secondary leading-relaxed">{spec}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (event.kind === 'task.result') {
    const taskRef = (event.payload.taskRef as string) || '';
    const summary = (event.payload.summary as string) || '';
    const artifactRef = event.payload.artifactRef as string | undefined;
    return (
      <div className="flex gap-3 py-2 px-4">
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${avatarColor(event.actor)}`}>
          {avatarInitial(name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-sm font-semibold text-text">{name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan/10 text-cyan">result</span>
            <span className="text-[10px] text-text-muted ml-auto">{timeFormat(event.ts)}</span>
          </div>
          <div className="rounded-lg border border-border bg-bg-secondary p-3">
            <div className="text-sm text-text-secondary leading-relaxed mb-1">{summary}</div>
            {artifactRef && (
              <div className="text-[10px] text-text-muted mt-1">📎 {artifactRef}</div>
            )}
            <div className="text-[10px] text-text-muted mt-1">ref: {taskRef.slice(0, 12)}…</div>
          </div>
        </div>
      </div>
    );
  }

  if (event.kind === 'task.checked') {
    const verdict = event.payload.verdict as string || 'unknown';
    const note = event.payload.note as string || '';
    const isApproved = verdict === 'approved' || verdict === 'pass';
    return (
      <div className="flex gap-3 py-2 px-4">
        <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${isUser ? 'bg-accent/20 text-accent-light' : avatarColor(event.actor)}`}>
          {avatarInitial(name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-sm font-semibold text-text">{name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${isApproved ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
              {isApproved ? <><CheckCircle2 size={10} className="inline mr-1" />checked ✓</> : <><XCircle size={10} className="inline mr-1" />rejected</>}
            </span>
            <span className="text-[10px] text-text-muted ml-auto">{timeFormat(event.ts)}</span>
          </div>
          {note && (
            <div className="text-sm text-text-secondary leading-relaxed">{note}</div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

function EventRenderer({ event, agents }: { event: CompanyEvent; agents: CompanyAgent[] }) {
  if (event.kind === 'company.created' || event.kind === 'agent.minted') {
    return <SystemBanner event={event} agents={agents} />;
  }
  if (event.kind === 'room.message') {
    return <ChatMessage event={event} agents={agents} />;
  }
  // task.delegated, task.result, task.checked
  return <TaskCard event={event} agents={agents} />;
}

// ─── Day divider ─────────────────────────────────────────────

function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="flex items-center justify-center py-2">
      <div className="flex items-center gap-2 text-[10px] text-text-muted">
        <div className="w-12 h-px bg-border" />
        <span>{dayLabel(ts)}</span>
        <div className="w-12 h-px bg-border" />
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export function CompanyRoom() {
  const [status, setStatus] = useState<CompanyStatus | null>(null);
  const [events, setEvents] = useState<CompanyEvent[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showDelegate, setShowDelegate] = useState(false);
  const [delegateAgent, setDelegateAgent] = useState('');
  const [delegateSpec, setDelegateSpec] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(0);

  // ── Load company status + initial room events ───────────────
  const refresh = useCallback(async () => {
    try {
      const [statusRes, roomRes] = await Promise.all([
        getCompanyStatus(),
        getCompanyRoom(0, 200),
      ]);
      setStatus(statusRes);
      setEvents(roomRes.events);
      if (roomRes.events.length > 0) {
        lastSeqRef.current = roomRes.events[roomRes.events.length - 1].seq;
      }
      setError(null);
    } catch (e) {
      // If 404, company is not enabled — show the disabled state
      const msg = (e as Error).message;
      if (msg.includes('404')) {
        setError('Company layer is not enabled. Set company.enabled = true in titan.json to activate the v8 company room.');
      } else {
        setError(msg);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // ── SSE: live room events with gap-free recovery ────────────
  // On open (and on reconnect), perform a paginated catch-up read
  // from lastSeq until the log is exhausted, buffering any live SSE
  // events that arrive during catch-up behind a contiguous cursor.
  // No seq is skipped on races or large backlogs. Dedupe by event id.
  useEffect(() => {
    if (error || !status?.exists) return;
    const token = localStorage.getItem('titan-token');
    const url = token ? `/api/company/stream?token=${token}` : '/api/company/stream';
    const es = new EventSource(url);
    let retries = 0;

    // ── Catch-up state ──
    // `catchingUp` gates whether live events go to state or to the buffer.
    // `liveBuffer` holds live events that arrive while catch-up is running.
    // After catch-up completes, the buffer is merged in seq order with dedup.
    let catchingUp = false;
    const liveBuffer: CompanyEvent[] = [];

    // Paginated catch-up: loop fetching pages from lastSeq until the
    // page comes back empty or partial (meaning we've caught up to the
    // log tail). Each page advances the contiguous cursor. This handles
    // backlogs larger than the 500-event page limit.
    const catchUp = async () => {
      catchingUp = true;
      liveBuffer.length = 0; // clear stale buffer from a previous run
      try {
        let after = lastSeqRef.current;
        // Loop until we get an empty or partial page (log exhausted).
        // MAX_LIMIT on the server is 500.
        while (true) {
          const page = await getCompanyRoom(after, 500);
          if (page.events.length === 0) break;
          // Merge this page's events into state with dedup by id
          setEvents(prev => {
            const seen = new Set(prev.map(e => e.id));
            const fresh = page.events.filter(e => !seen.has(e.id));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
          // Advance the contiguous cursor to the highest seq in this page
          after = page.events.reduce((m, e) => Math.max(m, e.seq), after);
          lastSeqRef.current = Math.max(lastSeqRef.current, after);
          // If the page was partial (< limit), we've reached the tail
          if (page.events.length < 500) break;
        }
      } catch { /* catch-up failure is non-fatal — live events still work */ }
      catchingUp = false;

      // ── Merge buffered live events ──
      // Events that arrived via SSE while catch-up was running. Sort by
      // seq and append any we haven't seen yet (dedup by id against both
      // the current state and the catch-up pages we just merged).
      if (liveBuffer.length > 0) {
        liveBuffer.sort((a, b) => a.seq - b.seq);
        setEvents(prev => {
          const seen = new Set(prev.map(e => e.id));
          const fresh = liveBuffer.filter(e => !seen.has(e.id));
          // Advance lastSeq past any buffered events we appended
          if (fresh.length > 0) {
            const maxBufSeq = fresh.reduce((m, e) => Math.max(m, e.seq), 0);
            lastSeqRef.current = Math.max(lastSeqRef.current, maxBufSeq);
          }
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
        liveBuffer.length = 0;
      }
    };

    es.onopen = () => {
      retries = 0;
      // Gap-free recovery: catch up on anything missed before the
      // SSE connection was established or during a reconnect.
      catchUp();
    };

    es.addEventListener('company:event', (e) => {
      retries = 0;
      try {
        const evt = JSON.parse(e.data) as CompanyEvent;
        if (catchingUp) {
          // ── Buffer mode ──
          // Catch-up is running. Don't append to state yet — buffer this
          // live event. It will be merged in seq order after catch-up
          // completes. This prevents out-of-order appends and ensures
          // the contiguous cursor is maintained.
          liveBuffer.push(evt);
        } else {
          // ── Live mode ──
          // Catch-up is done. Append directly, deduping by id.
          if (evt.seq > lastSeqRef.current) {
            lastSeqRef.current = evt.seq;
            setEvents(prev => {
              if (prev.some(e => e.id === evt.id)) return prev;
              return [...prev, evt];
            });
          }
        }
      } catch { /* malformed event */ }
    });

    es.onerror = () => {
      retries++;
      if (retries > 5) {
        es.close();
      }
      // EventSource auto-reconnects; onopen fires again on reconnect,
      // which triggers catchUp() to fill the gap.
    };

    return () => es.close();
  }, [error, status]);

  // ── Auto-scroll to bottom on new events ─────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  // ── Send message ────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await postCompanyMessage(input.trim());
      setInput('');
      // SSE will append the event; no manual refresh needed
    } catch (e) {
      setError((e as Error).message);
    }
    setSending(false);
  }, [input, sending]);

  // ── Delegate task ───────────────────────────────────────────
  const handleDelegate = useCallback(async () => {
    if (!delegateAgent || !delegateSpec.trim() || sending) return;
    setSending(true);
    try {
      await delegateCompanyTask(delegateAgent, delegateSpec.trim());
      setDelegateSpec('');
      setDelegateAgent('');
      setShowDelegate(false);
    } catch (e) {
      setError((e as Error).message);
    }
    setSending(false);
  }, [delegateAgent, delegateSpec, sending]);

  // ── Loading state ───────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-sm text-text-muted">Loading company room…</span>
        </div>
      </div>
    );
  }

  // ── Error / disabled state ──────────────────────────────────
  if (error) {
    return (
      <div className="flex items-center justify-center h-full px-6">
        <div className="max-w-md text-center">
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            v8 Company Room
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

  // ── No company yet → create prompt ──────────────────────────
  if (status && !status.exists) {
    return (
      <div className="flex items-center justify-center h-full px-6">
        <div className="max-w-md text-center">
          <div className="mb-3 flex items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
              <Users className="text-accent-light" size={24} />
            </div>
          </div>
          <h2 className="text-lg font-semibold text-text mb-2">No company yet</h2>
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            Mint your v8 company to create a shared room with a CEO and starter crew.
            Every event — messages, delegations, checks — is signed and replayable.
          </p>
          <button
            onClick={async () => {
              try {
                await createV8Company({});
                refresh();
              } catch (e) { setError((e as Error).message); }
            }}
            className="px-4 py-2 text-sm bg-accent rounded-lg hover:bg-accent-hover text-white font-medium transition-colors"
          >
            Mint company
          </button>
        </div>
      </div>
    );
  }

  // ── Room surface ────────────────────────────────────────────
  const agents = status?.agents || [];
  const crewCount = agents.length;

  // Group events by day for dividers
  let lastDay = '';

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Room header ── */}
      <div className="shrink-0 border-b border-border bg-bg/95 backdrop-blur px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-text">The Company Room</h2>
            <p className="text-[10px] text-text-muted">
              {status?.name || 'Titan Company'} · {crewCount} agent{crewCount !== 1 ? 's' : ''} · flat chat · no threads
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowDelegate(!showDelegate)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-bg-tertiary/50 border border-border rounded-lg hover:bg-bg-tertiary text-text-secondary transition-colors"
            >
              <GitBranch size={12} />
              Delegate
            </button>
          </div>
        </div>
      </div>

      {/* ── Delegate panel (collapsible) ── */}
      {showDelegate && (
        <div className="shrink-0 border-b border-border bg-bg-secondary px-4 py-3">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <select
                value={delegateAgent}
                onChange={(e) => setDelegateAgent(e.target.value)}
                className="text-xs bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-text-secondary"
              >
                <option value="">Select agent…</option>
                {agents.map(a => (
                  <option key={a.agentId} value={a.agentId}>{a.displayName} ({a.role})</option>
                ))}
              </select>
              <input
                type="text"
                value={delegateSpec}
                onChange={(e) => setDelegateSpec(e.target.value)}
                placeholder="Task spec…"
                className="flex-1 text-xs bg-bg-tertiary border border-border rounded-lg px-3 py-1.5 text-text-secondary"
                onKeyDown={(e) => { if (e.key === 'Enter') handleDelegate(); }}
              />
              <button
                onClick={handleDelegate}
                disabled={!delegateAgent || !delegateSpec.trim() || sending}
                className="px-3 py-1.5 text-xs bg-accent rounded-lg hover:bg-accent-hover text-white font-medium disabled:opacity-50 transition-colors"
              >
                Delegate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-text-muted">
            No messages yet. Say something to the company…
          </div>
        ) : (
          events.map((evt) => {
            const day = new Date(evt.ts).toDateString();
            const showDivider = day !== lastDay;
            lastDay = day;
            return (
              <div key={evt.id}>
                {showDivider && <DayDivider ts={evt.ts} />}
                <EventRenderer event={evt} agents={agents} />
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ── */}
      <div className="shrink-0 border-t border-border bg-bg-secondary px-4 py-3">
        <div className="flex items-center gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Say something to the company…"
            rows={1}
            className="flex-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-secondary resize-none focus:outline-none focus:border-accent/40"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="shrink-0 flex items-center justify-center w-9 h-9 bg-accent rounded-lg hover:bg-accent-hover text-white disabled:opacity-50 transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default CompanyRoom;
