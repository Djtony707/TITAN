/**
 * TITAN — Mission Chat (v6.1.0)
 *
 * The chat-style mission view. Loads a mission, subscribes to its SSE
 * event stream, renders the thread + team strip + artifact card + input.
 * Question messages get inline quick-reply buttons that POST to /answer.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  getMission,
  getMissionFile,
  postMessage,
  answerQuestion,
  setMissionStatus,
  subscribeToMission,
  deleteMission,
  type MissionFile,
  type MissionRoom,
  type MissionMessage,
} from '@/api/missions';
import { RichMessageBody } from '@/pages/mission/RichMessageBody';
import { FileViewer } from '@/pages/mission/FileViewer';
// DeskSurface now provided by App.tsx
// v6.1.0-alpha.22 — sponsor footer is now a global AppShell mount.

export default function MissionChat() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [room, setRoom] = useState<MissionRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [artifactExpanded, setArtifactExpanded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * v6.1.0-alpha.4 — set of message IDs the user has clicked to expand.
   * Each expanded bubble reveals a metadata panel with timestamp, the
   * subtask the agent was working on, duration, tokens, cost, model, and
   * the full action chip list. Default collapsed so the thread stays
   * readable; one-click reveal so power users get full context.
   */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  /**
   * v6.1.0-beta.4 Wave 6 — scroll-anchor smoothness.
   * `isAtBottomRef` tracks whether the user is currently parked near the
   * bottom of the thread (within 100px). When a new message arrives, we
   * only auto-scroll if they were already there — if they scrolled up to
   * read history, we leave them alone. Smooth-scroll on new messages so
   * the thread feels calm rather than jamming the viewport.
   */
  const isAtBottomRef = useRef(true);

  /**
   * v6.1.0-alpha.16 — file viewer modal state. When the user clicks a
   * file or report chip in a chat bubble, we fetch the content via
   * /api/missions/:id/file and open an in-app viewer. The backend
   * enforces that only files already referenced as sources in this
   * mission's messages can be served, so there's no path-injection
   * surface from the UI side.
   */
  const [openFile, setOpenFile] = useState<{
    ref: string;
    loading: boolean;
    error?: string;
    file?: MissionFile;
  } | null>(null);

  const handleOpenFile = useCallback(async (ref: string) => {
    if (!id) return;
    setOpenFile({ ref, loading: true });
    try {
      const file = await getMissionFile(id, ref);
      setOpenFile({ ref, loading: false, file });
    } catch (err) {
      setOpenFile({ ref, loading: false, error: (err as Error).message });
    }
  }, [id]);

  const closeFile = useCallback(() => setOpenFile(null), []);

  // Initial load
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    getMission(id)
      .then(({ mission }) => { if (alive) { setRoom(mission); setLoading(false); } })
      .catch((err) => { if (alive) { setError((err as Error).message); setLoading(false); } });
    return () => { alive = false; };
  }, [id]);

  // SSE subscription — refresh on any mutation event by re-reading the room.
  // The room is small enough that a full refetch is simpler and more
  // correct than reconstructing state from individual event payloads.
  useEffect(() => {
    if (!id) return;
    const unsub = subscribeToMission(id, (ev) => {
      if (ev.kind === 'mission_deleted') {
        navigate('/mission');
        return;
      }
      if (ev.kind === 'hello') return;
      // Debounced refetch — the event fires, we pull the new full state.
      getMission(id).then(({ mission }) => setRoom(mission)).catch(() => { /* ignore */ });
    });
    return unsub;
  }, [id, navigate]);

  // v6.1.0-beta.4 Wave 6 — track whether the user is parked near the bottom.
  // Updates on every scroll event so the auto-scroll-on-new-message logic
  // below can honour the user's reading position.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); };
  }, [room?.id]);

  // Auto-scroll to bottom on new messages — but only if the user is already
  // near the bottom. Smooth-scrolls to the anchor so the thread feels calm.
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const anchor = bottomAnchorRef.current;
    if (!anchor) return;
    anchor.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [room?.messages.length]);

  const onSend = useCallback(async () => {
    if (!room || !input.trim() || sending) return;
    setSending(true);
    try {
      await postMessage(room.id, input.trim());
      setInput('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [room, input, sending]);

  const onAnswer = useCallback(async (approvalId: string, answer: string) => {
    if (!room) return;
    try { await answerQuestion(room.id, approvalId, answer); }
    catch (err) { setError((err as Error).message); }
  }, [room]);

  const onTogglePause = useCallback(async () => {
    if (!room) return;
    const next = room.status === 'paused' ? 'working' : 'paused';
    try { await setMissionStatus(room.id, next); }
    catch (err) { setError((err as Error).message); }
  }, [room]);

  // v6.1.0-alpha.27 — delete this mission and return to the start page.
  const onDelete = useCallback(async () => {
    if (!room) return;
    const ok = window.confirm(`Delete this mission?\n\n"${room.goal.slice(0, 120)}${room.goal.length > 120 ? '…' : ''}"\n\nThe file is renamed on disk (recoverable manually), but the mission disappears from the UI immediately.`);
    if (!ok) return;
    try {
      await deleteMission(room.id);
      navigate('/mission');
    } catch (err) { setError((err as Error).message); }
  }, [room, navigate]);

  if (loading) {
    return (
      <div
        className="flex items-center justify-center h-full text-sm"
        style={{
          fontFamily: "var(--theme-font-display, 'Georgia', serif)",
          color: 'var(--theme-ink-soft, #a89070)',
        }}
      >
        Loading mission…
      </div>
    );
  }
  if (error || !room) {
    return (
      <div
        className="flex items-center justify-center h-full flex-col gap-3"
        style={{
          fontFamily: "var(--theme-font-display, 'Georgia', serif)",
          color: 'var(--theme-paper-fg, #f3e9d0)',
        }}
      >
        <div className="text-sm" style={{ color: 'var(--theme-accent, #c45050)' }}>{error ?? 'Mission not found.'}</div>
        <button
          onClick={() => navigate('/mission')}
          className="text-sm hover:underline"
          style={{ color: 'var(--theme-metal, #c4a35a)' }}
        >
          ← Start a new mission
        </button>
      </div>
    );
  }

  const { working, blocked } = countTeam(room);

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden"
      style={{
        fontFamily: "var(--theme-font-display, 'Georgia', serif)",
        color: 'var(--theme-paper-fg, #f3e9d0)',
        minHeight: 0,
      }}
    >

        {/* Top bar — leather strip */}
        <header
          className="relative z-20 flex items-center gap-4 px-5 py-3 shrink-0"
          style={{
            background: 'linear-gradient(180deg, var(--theme-leather, rgba(42,26,10,0.92)), var(--theme-leather-edge, rgba(56,36,16,0.88)))',
            borderBottom: '1px solid var(--theme-metal-dark, rgba(138,106,58,0.5))',
            boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          }}
        >
        <button
          onClick={() => navigate('/mission')}
          className="text-text-muted hover:text-text text-sm shrink-0"
          title="Start a new mission"
        >
          ←
        </button>
        <button
          onClick={() => navigate('/mission/library')}
          className="text-[10px] uppercase tracking-widest text-text-muted hover:text-text border border-border rounded-full px-2 py-0.5 shrink-0"
          title="Browse past missions"
        >
          Library
        </button>
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
          Mission
        </div>
        <TeamStrip room={room} />
        <div className="flex items-center gap-2 shrink-0">
          <div
            title="Team health"
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-bg-secondary/60 border border-border rounded-full text-xs text-text-muted"
          >
            <span className={`w-2 h-2 rounded-full ${blocked > 0 ? 'bg-error animate-pulse' : working > 0 ? 'bg-accent animate-pulse' : 'bg-success'}`} />
            {statusBlurb(room.status, working, blocked)}
          </div>
          {/* v6.1.0-alpha.8 — decision-count pill (borrowed from
              awesome-agent-harness's "explicit control points" pattern) */}
          {blocked > 0 && (
            <div
              className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-error/15 border border-error/30 rounded-full text-xs text-error"
              title="Decisions waiting on you"
            >
              🔔 {blocked}
            </div>
          )}
          <div
            title="Effort so far"
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-bg-secondary/60 border border-border rounded-full text-xs"
          >
            <span className="inline-block w-3 h-4 bg-gradient-radial-flame" />
            <span className="text-text font-medium">${room.cost.usd.toFixed(2)}</span>
          </div>
          {/* v6.1.0-alpha.8 — switch to spatial view of the same mission */}
          <button
            onClick={() => navigate(`/mission/${room.id}/canvas`)}
            className="px-3 py-1.5 text-xs bg-bg-secondary/60 border border-border rounded-full text-text-secondary hover:text-text"
            title="Switch to the canvas (spatial) view of the same mission"
          >
            Canvas view
          </button>
          <button
            onClick={onTogglePause}
            className="px-3 py-1.5 text-xs bg-bg-secondary/60 border border-border rounded-full text-text-secondary hover:text-text"
          >
            {room.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          {/* v6.1.0-alpha.27 — delete mission. Hover reveals the red. */}
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-xs bg-bg-secondary/60 border border-border rounded-full text-text-muted hover:text-error hover:bg-error/15 hover:border-error/40 transition-colors"
            title="Delete this mission"
          >
            🗑 Delete
          </button>
          <button
            onClick={() => setHelpOpen(v => !v)}
            className="w-8 h-8 rounded-full bg-bg-secondary/60 border border-border text-text-muted hover:text-text flex items-center justify-center font-semibold text-sm"
            title="What's this?"
          >
            ?
          </button>
        </div>
      </header>

      {/* Chat thread — `min-h-0` is critical here: without it, a `flex-1`
          child with `overflow-y-auto` won't actually clip overflow inside
          a `flex-col` parent — the scrollarea grows past its container and
          messages bleed under the footer + sponsor mount. */}
      <main
        ref={threadRef}
        className="relative z-10 flex-1 overflow-y-auto"
        style={{ minHeight: 0 }}
      >
        <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 flex flex-col gap-3">
          {room.messages.length === 0 ? (
            <EmptyThread />
          ) : (
            room.messages.map((msg) => (
              <MessageRow
                key={msg.id}
                msg={msg}
                artifact={room.artifact}
                artifactExpanded={artifactExpanded}
                onToggleArtifact={() => setArtifactExpanded(v => !v)}
                onAnswer={onAnswer}
                onOpenFile={handleOpenFile}
                expanded={expandedIds.has(msg.id)}
                onToggleExpand={() => toggleExpanded(msg.id)}
              />
            ))
          )}
          <ActiveTyping room={room} />
          {/* Smooth-scroll anchor — see scroll-anchor effect above. */}
          <div ref={bottomAnchorRef} aria-hidden="true" />
        </div>
      </main>

      {/* Bottom input — `shrink-0` so it never collapses; `paddingBottom`
          leaves room for the global sponsor footer chip (mounted in App.tsx
          at `fixed bottom-1.5`, ~30px tall + 6px gap ≈ 40px). */}
      <footer
        className="relative z-20 bg-bg/80 backdrop-blur-md border-t border-border shrink-0"
        style={{ paddingBottom: 40 }}
      >
        <div className="max-w-3xl mx-auto px-4 md:px-6 py-3">
          <form
            onSubmit={(e) => { e.preventDefault(); onSend(); }}
            className="flex items-center gap-2 bg-bg-secondary/70 border border-border rounded-2xl px-3 py-2"
          >
            <button
              type="button"
              title="Add a teammate (coming soon)"
              className="w-9 h-9 rounded-xl bg-bg-tertiary border border-border text-text-muted hover:text-text flex items-center justify-center text-lg font-semibold"
              disabled
            >
              +
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Type to the team — or @Sage to talk to one helper'
              className="flex-1 bg-transparent outline-none text-text placeholder:text-text-muted/60 text-sm py-2 px-1"
            />
            {/* v6.1.0-beta.4 Wave 6 — brass-rim disabled mic. Polished rather
                than hidden so users discover that voice is coming, but the
                "soon" badge + cursor-not-allowed make it clear it is not
                wired up yet. */}
            <button
              type="button"
              title="Voice coming next release"
              disabled
              aria-disabled="true"
              className="relative w-9 h-9 rounded-full flex items-center justify-center cursor-not-allowed transition-colors"
              style={{
                background: 'color-mix(in srgb, var(--theme-leather-edge) 60%, transparent)',
                border: '1px solid var(--theme-metal-dark)',
                color: 'var(--theme-metal)',
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--theme-metal) 25%, transparent)',
                opacity: 0.7,
              }}
            >
              <span aria-hidden="true">🎤</span>
              <span
                className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-widest"
                style={{
                  color: 'var(--theme-ink-soft)',
                  fontFamily: 'var(--theme-font-mono)',
                  letterSpacing: '0.15em',
                }}
              >
                soon
              </span>
            </button>
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent to-accent2 text-bg-deep font-bold shadow-[0_0_16px_rgba(99,102,241,0.5)] disabled:opacity-50 disabled:cursor-not-allowed"
              title="Send"
            >
              ↑
            </button>
          </form>
          <div className="mt-2 flex justify-between items-center text-[11px] text-text-muted">
            <span>
              {room.team.map(t => (
                <span key={t.agentId} className="mr-2"><b className="text-text-secondary">@{t.name}</b></span>
              ))}
              to address one helper
            </span>
            <span>Press <b className="text-text-secondary">↵</b> to send</span>
          </div>
        </div>
      </footer>

      {/* v6.1.0-alpha.16 — file viewer modal. Mounted at top-level so the
          backdrop covers the whole chat surface. */}
      {openFile && (
        <FileViewer
          state={openFile}
          onClose={closeFile}
        />
      )}

      {/* Help panel */}
      {helpOpen && (
        <div className="fixed top-16 right-5 w-80 bg-bg-secondary/95 border border-border rounded-xl p-4 backdrop-blur-xl shadow-2xl z-30">
          <button onClick={() => setHelpOpen(false)} className="absolute top-3 right-3 text-text-muted hover:text-text text-sm">✕</button>
          <h3 className="font-semibold text-sm mb-2">What you're looking at</h3>
          <p className="text-xs text-text-secondary leading-relaxed mb-3">
            It's a group chat with your <b className="text-text">AI helpers</b>. Each one has a job. You stay in charge.
          </p>
          <ul className="space-y-2 text-xs text-text-secondary">
            <li className="flex gap-2"><span>💬</span><span>Helpers <b className="text-text">talk in the thread</b> as they work.</span></li>
            <li className="flex gap-2"><span>📄</span><span>The <b className="text-text">document card</b> shows what they're building.</span></li>
            <li className="flex gap-2"><span>❓</span><span>Decisions appear as <b className="text-text">pink messages with buttons</b>.</span></li>
            <li className="flex gap-2"><span>@</span><span>Type <b className="text-text">@Scout</b> (or any name) to message one helper.</span></li>
            <li className="flex gap-2"><span>🎤</span><span><b className="text-text">Voice comes next release.</b></span></li>
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

/**
 * v6.1.0-beta.4 Wave 6 — unified sender chip header for every message
 * group. Avatar uses the agent's dynamic colour (per-agent identity, not a
 * theme token — leave it). Name uses the display font in paper, role + time
 * use the mono font in ink-soft so the visual hierarchy reads at a glance:
 * "who" loud, "what role / when" quiet.
 */
function SenderChip({
  name, role, at, align, color, colorOverride, hint,
}: {
  name: string;
  role: string;
  at: string;
  align: 'left' | 'right';
  color?: string;
  colorOverride?: string;
  hint?: string;
}) {
  const initial = name[0] ?? '?';
  const avatarBg = color
    ? `linear-gradient(135deg, ${color}, ${shade(color, -25)})`
    : colorOverride ?? 'var(--theme-metal-bright)';
  return (
    <div
      className={`flex items-center gap-2 mb-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}
      style={{ fontFamily: 'var(--theme-font-display)' }}
    >
      <div
        className="w-6 h-6 rounded-md flex items-center justify-center font-bold text-[11px]"
        style={{
          background: avatarBg,
          color: 'var(--theme-leather-edge)',
        }}
      >
        {initial}
      </div>
      <span
        className="text-[12px] font-semibold tracking-tight"
        style={{ color: 'var(--theme-paper-fg)' }}
      >
        {name}
      </span>
      {role && (
        <span
          className="text-[10px] uppercase tracking-widest"
          style={{
            color: 'var(--theme-ink-soft)',
            fontFamily: 'var(--theme-font-mono)',
          }}
        >
          {role}
        </span>
      )}
      <span
        className={align === 'right' ? 'text-[10px] mr-auto' : 'text-[10px] ml-auto'}
        style={{
          color: 'var(--theme-ink-soft)',
          fontFamily: 'var(--theme-font-mono)',
        }}
      >
        {shortTime(at)}
      </span>
      {hint && (
        <span
          className="text-[10px]"
          style={{
            color: 'var(--theme-ink-soft)',
            opacity: 0.6,
            fontFamily: 'var(--theme-font-mono)',
          }}
        >
          {hint}
        </span>
      )}
    </div>
  );
}

/**
 * v6.1.0-beta.4 Wave 6 — calm placeholder for the brief moment before the
 * first message lands. The chat is otherwise an empty rectangle of leather;
 * a quiet line of paper-toned italic copy lets the user know the team is
 * spinning up without the page looking broken.
 */
function EmptyThread() {
  return (
    <div className="self-center my-12 max-w-md text-center flex flex-col items-center gap-3">
      <span
        className="inline-flex gap-1"
        aria-hidden="true"
      >
        <span
          className="w-1.5 h-1.5 rounded-full animate-bounce"
          style={{ background: 'var(--theme-metal)', animationDelay: '0ms' }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full animate-bounce"
          style={{ background: 'var(--theme-metal)', animationDelay: '150ms' }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full animate-bounce"
          style={{ background: 'var(--theme-metal)', animationDelay: '300ms' }}
        />
      </span>
      <p
        className="italic text-sm leading-relaxed"
        style={{
          color: 'var(--theme-ink-soft)',
          fontFamily: 'var(--theme-font-display)',
        }}
      >
        Your team will start replying any moment now…
      </p>
    </div>
  );
}

function TeamStrip({ room }: { room: MissionRoom }) {
  return (
    <div className="flex-1 flex items-center gap-2 overflow-x-auto min-w-0">
      <span className="text-[10px] uppercase tracking-widest text-text-muted shrink-0">your team</span>
      {room.team.map((m) => (
        <div
          key={m.agentId}
          title={`${m.name} · ${m.role}${m.currentActivity ? ' · ' + m.currentActivity : ''}`}
          className="inline-flex items-center gap-2 px-2.5 py-1 bg-bg-secondary/60 border border-border rounded-full text-xs shrink-0"
        >
          <span
            className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold text-bg-deep"
            style={{ background: `linear-gradient(135deg, ${m.color}, ${shade(m.color, -25)})` }}
          >
            {m.name[0]}
          </span>
          <span className="text-text-secondary">{m.name}</span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${stateClass(m.state)}`}
            style={{ boxShadow: `0 0 6px ${stateColor(m.state)}` }}
          />
        </div>
      ))}
    </div>
  );
}

function MessageRow({
  msg, artifact, artifactExpanded, onToggleArtifact, onAnswer, onOpenFile, expanded, onToggleExpand,
}: {
  msg: MissionMessage;
  artifact: MissionRoom['artifact'];
  artifactExpanded: boolean;
  onToggleArtifact: () => void;
  onAnswer: (approvalId: string, answer: string) => void;
  onOpenFile: (ref: string, sourceType: 'file' | 'report') => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  // Click-to-expand wrapper used by user, agent, question bubbles. Stops
  // event propagation on interactive elements (quick-reply buttons, etc.)
  // so clicking them doesn't ALSO toggle the expand state.
  const expandable = (children: React.ReactNode, key?: string) => (
    <button
      type="button"
      onClick={onToggleExpand}
      className="text-left w-full"
      title={expanded ? 'Click to hide details' : 'Click to see details'}
      key={key}
    >
      {children}
    </button>
  );

  if (msg.kind === 'user') {
    return (
      <div className="self-end max-w-[88%] flex flex-col items-end">
        <SenderChip name="You" role="" at={msg.at} align="right" colorOverride="var(--theme-metal-bright)" />
        {expandable(
          <div
            className="px-3.5 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed cursor-pointer"
            style={{
              // Brass-tinted background ~30% so it still feels like leather underneath.
              background: 'color-mix(in srgb, var(--theme-metal-dark) 30%, transparent)',
              color: 'var(--theme-paper-fg)',
              border: '1px solid color-mix(in srgb, var(--theme-metal) 40%, transparent)',
              boxShadow: '0 2px 6px var(--theme-shadow)',
              fontFamily: 'var(--theme-font-display)',
            }}
          >
            {msg.content}
          </div>,
        )}
        {expanded && <DetailsPanel msg={msg} />}
      </div>
    );
  }
  if (msg.kind === 'system') {
    const tag = msg.tag === 'team_formed' ? 'Team formed' : msg.tag === 'team_expanded' ? 'Team change' : (msg.tag ?? 'note');
    return (
      <div className="self-center flex flex-col items-center max-w-[88%] my-1">
        {expandable(
          <div
            className="italic text-center text-[12px] leading-relaxed cursor-pointer px-3 py-1"
            style={{
              color: 'var(--theme-ink-soft)',
              fontFamily: 'var(--theme-font-display)',
            }}
          >
            <span className="not-italic" style={{ fontFamily: 'var(--theme-font-mono)', letterSpacing: '0.08em', fontSize: '10px', textTransform: 'uppercase' }}>
              {tag}
            </span>
            <span className="mx-2 opacity-50">·</span>
            {msg.content.replace(/^Team formed —\s*/, '').replace(/\.$/, '')}
          </div>,
        )}
        {expanded && <DetailsPanel msg={msg} />}
      </div>
    );
  }
  if (msg.kind === 'artifact_update') {
    // Artifact card has its own open/collapse — we re-use that for the
    // "see details" affordance. No separate expand panel for these.
    return (
      <ArtifactCard
        artifact={artifact}
        expanded={artifactExpanded}
        onToggle={onToggleArtifact}
        latestSummary={msg.summary}
        latestBy={msg.by.name}
        wordCount={msg.wordCount}
      />
    );
  }
  if (msg.kind === 'question') {
    return (
      <div className="max-w-[88%] flex flex-col">
        <SenderChip
          name={msg.from.name}
          role={msg.from.role}
          at={msg.at}
          align="left"
          color={msg.from.color}
        />
        <span className="self-start inline-flex items-center gap-1 px-2 py-0.5 mb-1.5 bg-error text-white text-[10px] uppercase tracking-widest font-bold rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
          Needs you
        </span>
        {/* Outer bubble: clickable for expand. Quick-reply buttons inside use
            event.stopPropagation so a click on them doesn't toggle the expand. */}
        <div
          className="px-3.5 py-2.5 rounded-2xl rounded-bl-md border-l-[3px] text-sm leading-relaxed cursor-pointer"
          onClick={onToggleExpand}
          title={expanded ? 'Click to hide details' : 'Click to see details'}
          style={{
            background: 'linear-gradient(180deg, rgba(239,68,68,0.18), rgba(239,68,68,0.06))',
            borderLeftColor: msg.from.color,
            border: '1px solid rgba(239,68,68,0.35)',
            borderLeft: `3px solid ${msg.from.color}`,
            color: 'var(--theme-paper-fg)',
            fontFamily: 'var(--theme-font-display)',
            boxShadow: '0 2px 6px var(--theme-shadow)',
          }}
        >
          {msg.content}
          {!msg.answer && (
            <>
              {msg.quickReplies.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {msg.quickReplies.map((q, i) => (
                    <button
                      key={q}
                      onClick={(e) => { e.stopPropagation(); onAnswer(msg.approvalId, q); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                        i === msg.quickReplies.length - 1
                          ? 'bg-gradient-to-br from-accent to-accent2 text-bg-deep border-transparent'
                          : 'bg-bg-secondary/60 border-error/40 text-text hover:bg-error/15'
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {/* v6.1.0-alpha.5 — custom typed answer. If none of the
                  quick replies fit, the user can write their own. */}
              <CustomAnswerInput
                approvalId={msg.approvalId}
                onSubmit={(text) => onAnswer(msg.approvalId, text)}
              />
            </>
          )}
          {msg.answer && (
            <div className="mt-3 text-[12px] text-text-muted border-t border-border pt-2">
              You answered: <span className="text-text">{msg.answer.content}</span>
            </div>
          )}
        </div>
        {expanded && <DetailsPanel msg={msg} />}
      </div>
    );
  }
  // agent
  return (
    <div className="max-w-[88%] flex flex-col">
      <SenderChip
        name={msg.from.name}
        role={msg.from.role}
        at={msg.at}
        align="left"
        color={msg.from.color}
        hint={expanded ? 'click to hide' : 'click for details'}
      />
      {expandable(
        <div
          className="px-3.5 py-2.5 rounded-2xl rounded-bl-md text-sm leading-relaxed backdrop-blur-sm cursor-pointer transition-colors"
          style={{
            // Paper-tinted background ~6% over the leather DeskSurface — gives the agent
            // a faint "page laid on the desk" feel without losing the leather warmth.
            background: 'color-mix(in srgb, var(--theme-paper) 6%, transparent)',
            color: 'var(--theme-paper-fg)',
            border: '1px solid color-mix(in srgb, var(--theme-metal-dark) 35%, transparent)',
            borderLeft: `3px solid ${msg.from.color}`,
            boxShadow: '0 2px 6px var(--theme-shadow)',
            fontFamily: 'var(--theme-font-display)',
          }}
        >
          <RichMessageBody text={msg.content} sources={msg.sources} onOpenFile={onOpenFile} />
          {msg.actions && msg.actions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {msg.actions.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-bg-tertiary/60 border border-border rounded-full text-[11px] text-text-muted">
                  <span>{a.name}</span>
                  {a.detail && <><span className="text-text-muted">·</span><b className="text-text font-medium">{a.detail}</b></>}
                </span>
              ))}
            </div>
          )}
        </div>,
      )}
      {expanded && <DetailsPanel msg={msg} />}
    </div>
  );
}

/**
 * Details panel revealed when the user clicks a message bubble. Surfaces
 * the message's metadata in plain English: full timestamp, the subtask
 * the agent was working on, duration, tokens, cost, model used. For
 * non-agent messages it shows just the minimum useful detail (timestamp,
 * id, tag/kind) so every bubble has consistent click behavior.
 */
function DetailsPanel({ msg }: { msg: MissionMessage }) {
  const fullTime = formatFullTime(msg.at);
  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  rows.push({ label: 'When', value: fullTime });
  rows.push({ label: 'Message id', value: <code className="text-text-secondary text-[11px]">{msg.id}</code> });

  if (msg.kind === 'agent') {
    rows.push({ label: 'From', value: <span><b>{msg.from.name}</b> · {msg.from.role} <span className="text-text-muted">({msg.from.agentId})</span></span> });
    const meta = msg.meta;
    if (meta?.subtaskTitle) rows.push({ label: 'Working on', value: <i>"{meta.subtaskTitle}"</i> });
    if (meta?.status) rows.push({ label: 'Outcome', value: <StatusBadge status={meta.status} /> });
    if (meta?.model) rows.push({ label: 'Brain', value: <code className="text-text-secondary text-[11px]">{meta.model}</code> });
    if (typeof meta?.durationMs === 'number') {
      rows.push({ label: 'Took', value: formatDurationHuman(meta.durationMs) });
    }
    if (typeof meta?.tokensUsed === 'number' && meta.tokensUsed > 0) {
      rows.push({ label: 'Tokens', value: meta.tokensUsed.toLocaleString() });
    }
    if (typeof meta?.costUsd === 'number' && meta.costUsd > 0) {
      rows.push({ label: 'Cost', value: '$' + meta.costUsd.toFixed(4) });
    }
    if (msg.actions && msg.actions.length > 0) {
      rows.push({
        label: 'Used',
        value: (
          <div className="flex flex-wrap gap-1.5">
            {msg.actions.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-bg-tertiary/60 border border-border rounded-full text-[11px] text-text-muted">
                {a.name}{a.detail && <span><span className="text-text-muted/60"> · </span><b className="text-text">{a.detail}</b></span>}
              </span>
            ))}
          </div>
        ),
      });
    }
    // v6.1.0-alpha.7 — when an internal error trace was scrubbed from the
    // chat-visible content, surface the raw text here for power users.
    if (meta?.failureDetail) {
      rows.push({
        label: 'Error detail',
        value: (
          <code className="block whitespace-pre-wrap bg-bg-tertiary/80 border border-border rounded p-2 text-[11px] text-text-secondary font-mono leading-relaxed max-h-40 overflow-y-auto">
            {meta.failureDetail.slice(0, 800)}
            {meta.failureDetail.length > 800 ? '\n…' : ''}
          </code>
        ),
      });
    }
  } else if (msg.kind === 'question') {
    rows.push({ label: 'From', value: <span><b>{msg.from.name}</b> · {msg.from.role}</span> });
    rows.push({ label: 'Approval id', value: <code className="text-text-secondary text-[11px]">{msg.approvalId}</code> });
    if (msg.answer) {
      rows.push({ label: 'Answered', value: <span>{formatFullTime(msg.answer.at)} — "{msg.answer.content}"</span> });
    } else {
      rows.push({ label: 'Status', value: <span className="text-warning">Waiting for your reply</span> });
    }
    if (msg.quickReplies.length > 0) {
      rows.push({ label: 'Options', value: msg.quickReplies.join(' · ') });
    }
  } else if (msg.kind === 'user') {
    rows.push({ label: 'Length', value: msg.content.length + ' chars' });
  } else if (msg.kind === 'system') {
    if (msg.tag) rows.push({ label: 'Kind', value: <code className="text-text-secondary text-[11px]">{msg.tag}</code> });
  }

  return (
    <div className="mt-2 self-stretch bg-bg-secondary/40 border border-border rounded-lg px-3 py-2.5 backdrop-blur-sm">
      <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1.5">Details</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {rows.map((r, i) => (
          <React.Fragment key={i}>
            <dt className="text-text-muted">{r.label}</dt>
            <dd className="text-text-secondary">{r.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

/**
 * Custom typed-answer field for question bubbles. Quick-replies cover the
 * obvious choices; this textarea catches everything else — "use AWS S3
 * for storage and Stripe for payments", "pause this until I check with
 * legal", etc.
 *
 * The wrapper is collapsed by default behind a small "or type a custom
 * answer" link so it doesn't crowd the bubble unless needed. stopPropagation
 * on all interactions so clicks here never toggle the message expand state.
 */
function CustomAnswerInput({ approvalId, onSubmit }: { approvalId: string; onSubmit: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (open && taRef.current) taRef.current.focus();
  }, [open]);
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText('');
    setOpen(false);
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="mt-2 text-[11px] text-text-muted hover:text-text-secondary underline underline-offset-2"
      >
        or type a custom answer…
      </button>
    );
  }
  return (
    <div className="mt-3" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
          }
        }}
        placeholder={`Tell ${approvalId.slice(0, 6)}… anything you want.`}
        rows={3}
        className="w-full bg-bg-secondary/80 border border-border rounded-lg p-2 text-sm text-text placeholder:text-text-muted/60 outline-none focus:border-accent/60 resize-y"
      />
      <div className="flex items-center justify-end gap-2 mt-1.5">
        <span className="mr-auto text-[10px] text-text-muted">⌘+↵ to send · esc to cancel</span>
        <button
          type="button"
          onClick={() => { setOpen(false); setText(''); }}
          className="px-3 py-1 text-[11px] text-text-muted hover:text-text"
        >Cancel</button>
        <button
          type="button"
          onClick={send}
          disabled={!text.trim()}
          className="px-3 py-1 text-[11px] font-semibold rounded-md bg-gradient-to-br from-accent to-accent2 text-bg-deep disabled:opacity-50 disabled:cursor-not-allowed"
        >Send answer</button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    done: 'bg-success/15 text-success border-success/30',
    failed: 'bg-error/15 text-error border-error/30',
    needs_info: 'bg-warning/15 text-warning border-warning/30',
    blocked: 'bg-warning/15 text-warning border-warning/30',
    cancelled: 'bg-text-muted/15 text-text-muted border-border',
  };
  const cls = colors[status] ?? 'bg-bg-tertiary/60 text-text-secondary border-border';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${cls}`}>
      {status}
    </span>
  );
}

function formatFullTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso; }
}

function formatDurationHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function ArtifactCard({
  artifact, expanded, onToggle, latestSummary, latestBy, wordCount,
}: {
  artifact: MissionRoom['artifact'];
  expanded: boolean;
  onToggle: () => void;
  latestSummary: string;
  latestBy: string;
  wordCount: number;
}) {
  const preview = artifact.content
    .split('\n')
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .slice(0, 240);
  return (
    <div className="self-stretch my-1 rounded-xl border border-border bg-bg-secondary/40 overflow-hidden relative">
      {/* live scan bar */}
      <div className="absolute left-0 right-0 top-0 h-[2px] overflow-hidden">
        <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-accent to-transparent animate-pulse" />
      </div>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <div className="w-7 h-7 rounded-lg bg-bg-tertiary flex items-center justify-center text-sm">📄</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">Live document</div>
          <div className="text-[11px] text-text-muted truncate">
            {latestBy} {latestSummary} · {wordCount} words · updating live
          </div>
        </div>
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
        <button onClick={onToggle} className="px-2.5 py-1 text-[11px] font-semibold bg-bg-tertiary border border-border rounded-md text-text-secondary hover:text-text">
          {expanded ? '▴ Collapse' : '▾ Open'}
        </button>
      </div>
      {!expanded ? (
        <div className="px-4 py-3 text-sm text-text-secondary font-serif italic">
          {preview || <span className="text-text-muted not-italic">empty for now…</span>}
        </div>
      ) : (
        <div
          className="px-5 py-4 font-serif text-sm leading-relaxed whitespace-pre-wrap"
          style={{
            background: 'var(--theme-paper, #f7f5ee)',
            color: 'var(--theme-ink, #1a1f2e)',
          }}
        >
          {artifact.content || (
            <span className="italic" style={{ color: 'var(--theme-ink-soft, #8a8472)' }}>empty for now…</span>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveTyping({ room }: { room: MissionRoom }) {
  const typing = room.team.filter(t => t.state === 'working' && t.currentActivity);
  if (typing.length === 0) return null;
  // Show at most one typing indicator so the thread doesn't get noisy.
  const m = typing[typing.length - 1];
  // v6.1.0-alpha.14 — typing pill used to clip mid-word at ~80 chars with no
  // way to read the full text. Now: wraps inside a generous max-width, with
  // the full activity available as a hover tooltip too.
  return (
    <div
      className="self-start flex items-start gap-2 px-3 py-2 bg-bg-secondary/60 border border-border rounded-2xl backdrop-blur-sm max-w-[640px]"
      title={m.currentActivity ?? undefined}
    >
      <div
        className="w-5 h-5 rounded-md flex items-center justify-center text-bg-deep font-bold text-[10px] shrink-0 mt-0.5"
        style={{ background: `linear-gradient(135deg, ${m.color}, ${shade(m.color, -25)})` }}
      >
        {m.name[0]}
      </div>
      <span className="text-xs text-text-muted leading-relaxed break-words flex-1 min-w-0">
        <span className="text-text font-semibold">{m.name}</span> {m.currentActivity ?? 'is working'}
      </span>
      <span className="inline-flex gap-0.5 ml-1 shrink-0 mt-1.5">
        <span className="w-1 h-1 rounded-full bg-text-muted animate-bounce [animation-delay:0ms]" />
        <span className="w-1 h-1 rounded-full bg-text-muted animate-bounce [animation-delay:150ms]" />
        <span className="w-1 h-1 rounded-full bg-text-muted animate-bounce [animation-delay:300ms]" />
      </span>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function countTeam(room: MissionRoom) {
  let working = 0, blocked = 0;
  for (const m of room.team) {
    if (m.state === 'working' || m.state === 'editing') working++;
    if (m.state === 'blocked') blocked++;
  }
  return { working, blocked };
}

function statusBlurb(s: MissionRoom['status'], working: number, blocked: number): string {
  if (s === 'paused')  return 'Paused';
  if (s === 'done')    return 'Done';
  if (s === 'failed')  return 'Failed';
  if (blocked > 0)     return `${working} working · ${blocked} needs you`;
  if (working > 0)     return `${working} working`;
  if (s === 'forming') return 'Forming team…';
  return 'Idle';
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function stateClass(s: string): string {
  switch (s) {
    case 'working': return 'bg-accent animate-pulse';
    case 'editing': return 'bg-warning animate-pulse';
    case 'blocked': return 'bg-error animate-pulse';
    case 'done':    return 'bg-success';
    default:        return 'bg-text-muted';
  }
}
function stateColor(s: string): string {
  switch (s) {
    case 'working': return '#6366f1';
    case 'editing': return '#f59e0b';
    case 'blocked': return '#ef4444';
    case 'done':    return '#22c55e';
    default:        return '#71717a';
  }
}

/** Darken a hex color by `amount` percentage points. */
function shade(hex: string, amount: number): string {
  const m = hex.replace('#', '');
  if (m.length !== 6) return hex;
  const num = parseInt(m, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const adjust = Math.round(255 * (amount / 100));
  r = Math.max(0, Math.min(255, r + adjust));
  g = Math.max(0, Math.min(255, g + adjust));
  b = Math.max(0, Math.min(255, b + adjust));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
