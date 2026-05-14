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
  type MissionFile,
  type MissionRoom,
  type MissionMessage,
} from '@/api/missions';
import { RichMessageBody } from '@/pages/mission/RichMessageBody';
import { FileViewer } from '@/pages/mission/FileViewer';
import { SponsorFooter } from '@/components/SponsorFooter';

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

  // Auto-scroll to bottom on new messages, but only if user is near bottom.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) el.scrollTop = el.scrollHeight;
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

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-bg text-text-muted text-sm">
        Loading mission…
      </div>
    );
  }
  if (error || !room) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-bg flex-col gap-3">
        <div className="text-error text-sm">{error ?? 'Mission not found.'}</div>
        <button onClick={() => navigate('/mission')} className="text-accent text-sm hover:underline">
          ← Start a new mission
        </button>
      </div>
    );
  }

  const { working, blocked } = countTeam(room);

  return (
    <div className="fixed inset-0 flex flex-col bg-bg text-text overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_60%_0%,rgba(99,102,241,0.12)_0%,transparent_45%)]" />

      {/* Top bar */}
      <header className="relative z-20 flex items-center gap-4 px-5 py-3 border-b border-border bg-bg/80 backdrop-blur-md">
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
          <button
            onClick={() => setHelpOpen(v => !v)}
            className="w-8 h-8 rounded-full bg-bg-secondary/60 border border-border text-text-muted hover:text-text flex items-center justify-center font-semibold text-sm"
            title="What's this?"
          >
            ?
          </button>
        </div>
      </header>

      {/* Chat thread */}
      <main ref={threadRef} className="relative z-10 flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 flex flex-col gap-3">
          {room.messages.map((msg) => (
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
          ))}
          <ActiveTyping room={room} />
        </div>
      </main>

      {/* Bottom input */}
      <footer className="relative z-20 bg-bg/80 backdrop-blur-md border-t border-border">
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
            <button
              type="button"
              title="Voice coming next release"
              disabled
              className="relative w-9 h-9 rounded-full bg-bg-tertiary border border-border text-text-muted opacity-50 cursor-not-allowed flex items-center justify-center"
            >
              🎤
              <span className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-widest text-text-muted">soon</span>
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
          {/* Quiet sponsor line — one per visible surface. */}
          <div className="mt-1.5 flex justify-center">
            <SponsorFooter />
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
        <div className="flex items-center gap-2 mb-1 flex-row-reverse">
          <div className="w-6 h-6 rounded-md bg-white flex items-center justify-center text-bg-deep font-bold text-[11px]">Y</div>
          <span className="text-[11px] font-semibold">You</span>
          <span className="text-[10px] text-text-muted">{shortTime(msg.at)}</span>
        </div>
        {expandable(
          <div className="px-3.5 py-2.5 rounded-2xl rounded-br-md text-bg-deep bg-gradient-to-br from-accent to-accent2 shadow-[0_4px_16px_rgba(99,102,241,0.25)] text-sm leading-relaxed cursor-pointer">
            {msg.content}
          </div>,
        )}
        {expanded && <DetailsPanel msg={msg} />}
      </div>
    );
  }
  if (msg.kind === 'system') {
    return (
      <div className="self-center flex flex-col items-center max-w-[88%]">
        {expandable(
          <div className="text-[12px] text-text-muted bg-bg-secondary/60 border border-border rounded-full px-3 py-1 backdrop-blur-sm cursor-pointer">
            <span className="text-text-secondary font-medium">{msg.tag === 'team_formed' ? 'Team formed' : msg.tag === 'team_expanded' ? 'Team change' : (msg.tag ?? 'note')}</span>
            {' · '}{msg.content.replace(/^Team formed —\s*/, '').replace(/\.$/, '')}
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
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center text-bg-deep font-bold text-[11px]"
            style={{ background: `linear-gradient(135deg, ${msg.from.color}, ${shade(msg.from.color, -25)})` }}
          >
            {msg.from.name[0]}
          </div>
          <span className="text-[11px] font-semibold" style={{ color: msg.from.color }}>{msg.from.name}</span>
          <span className="text-[11px] text-text-muted">{msg.from.role}</span>
          <span className="text-[10px] text-text-muted">{shortTime(msg.at)}</span>
        </div>
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
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center text-bg-deep font-bold text-[11px]"
          style={{ background: `linear-gradient(135deg, ${msg.from.color}, ${shade(msg.from.color, -25)})` }}
        >
          {msg.from.name[0]}
        </div>
        <span className="text-[11px] font-semibold" style={{ color: msg.from.color }}>{msg.from.name}</span>
        <span className="text-[11px] text-text-muted">{msg.from.role}</span>
        <span className="text-[10px] text-text-muted">{shortTime(msg.at)}</span>
        {/* Subtle "click to see details" hint for first-time discovery */}
        <span className="text-[10px] text-text-muted/60 ml-auto">{expanded ? 'click to hide' : 'click for details'}</span>
      </div>
      {expandable(
        <div
          className="px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-bg-secondary/60 border border-border text-sm leading-relaxed backdrop-blur-sm cursor-pointer hover:bg-bg-secondary/80 transition-colors"
          style={{ borderLeft: `3px solid ${msg.from.color}` }}
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
        <div className="px-5 py-4 bg-[#f7f5ee] text-[#1a1f2e] font-serif text-sm leading-relaxed whitespace-pre-wrap">
          {artifact.content || <span className="text-[#8a8472] italic">empty for now…</span>}
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
