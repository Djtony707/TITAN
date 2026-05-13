/**
 * TITAN — Mission Canvas (v6.1.0-alpha.8)
 *
 * The spatial-style mission view: a central document, a ring of agent
 * pods around it, glowing tether lines from each agent to the section
 * they're working on, an inline question bubble that floats toward
 * "you" when a helper needs a decision, a time scrubber + steering
 * input at the bottom.
 *
 * Bound to the SAME `MissionRoom` state + same SSE stream that powers
 * MissionChat.tsx. The two views are alternative renderers, not
 * separate features — every fix in alpha.5/6/7 (answer propagation,
 * completion signals, error scrubbing) works here automatically.
 *
 * Patterns folded in from external research:
 *   - Slash-command quick-bar at the bottom (steering shortcuts —
 *     borrowed from addyosmani/agent-skills' slash commands).
 *   - Decision-count pill in the top bar (explicit control points —
 *     borrowed from awesome-agent-harness).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  getMission,
  postMessage,
  answerQuestion,
  setMissionStatus,
  subscribeToMission,
  type MissionRoom,
  type MissionMessage,
  type MissionMember,
} from '@/api/missions';

const SLASH_COMMANDS: Array<{ cmd: string; label: string; hint: string }> = [
  { cmd: '/slow down',      label: 'Slow down',      hint: 'be more careful' },
  { cmd: '/be thorough',    label: 'Be thorough',    hint: 'dig deeper' },
  { cmd: '/wrap it up',     label: 'Wrap it up',     hint: 'finish what you have' },
  { cmd: '/skip the chart', label: 'Skip the chart', hint: 'drop the chart' },
  { cmd: '/pause',          label: 'Pause',          hint: 'pause the team' },
];

export default function MissionCanvas() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [room, setRoom] = useState<MissionRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [steerInput, setSteerInput] = useState('');
  const [sending, setSending] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Initial load + SSE.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setLoading(true);
    getMission(id)
      .then(({ mission }) => { if (alive) { setRoom(mission); setLoading(false); } })
      .catch((err) => { if (alive) { setError((err as Error).message); setLoading(false); } });
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const unsub = subscribeToMission(id, (ev) => {
      if (ev.kind === 'mission_deleted') { navigate('/mission'); return; }
      if (ev.kind === 'hello') return;
      getMission(id).then(({ mission }) => setRoom(mission)).catch(() => { /* ignore */ });
    });
    return unsub;
  }, [id, navigate]);

  const sendSteer = useCallback(async (text: string) => {
    if (!room || !text.trim() || sending) return;
    setSending(true);
    try {
      await postMessage(room.id, text.trim());
      setSteerInput('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [room, sending]);

  const onAnswer = useCallback(async (approvalId: string, answer: string) => {
    if (!room) return;
    try { await answerQuestion(room.id, approvalId, answer); }
    catch (err) { setError((err as Error).message); }
  }, [room]);

  const onTogglePause = useCallback(async () => {
    if (!room) return;
    const next = room.status === 'paused' ? 'working' : 'paused';
    try { await setMissionStatus(room.id, next); } catch (err) { setError((err as Error).message); }
  }, [room]);

  // v6.1.0-alpha.12 — Hook ordering: every hook (useMemo included) MUST
  // run on every render, even the loading/error renders. Previously
  // these `useMemo`s lived AFTER the early-return blocks below, which
  // triggered React error #310 ("Rendered more hooks than during the
  // previous render"): the first render returned early before reaching
  // the useMemo, then a later render with `room` populated tried to
  // call it. Pull them up here, gate the body on `room?.…` so they're
  // safe with no data, and the early-return blocks below stay purely
  // for output choice — never for hook count.
  const openQuestion = useMemo(() => {
    if (!room) return undefined;
    const reversed = [...room.messages].reverse();
    return reversed.find(
      m => m.kind === 'question' && !(m as Extract<MissionMessage, { kind: 'question' }>).answer,
    ) as Extract<MissionMessage, { kind: 'question' }> | undefined;
  }, [room]);

  const positions = useMemo(() => (room ? layoutTeam(room.team) : []), [room]);

  if (loading) {
    return <div className="fixed inset-0 flex items-center justify-center bg-bg-deep text-text-muted text-sm">Loading mission…</div>;
  }
  if (error || !room) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-bg-deep flex-col gap-3">
        <div className="text-error text-sm">{error ?? 'Mission not found.'}</div>
        <button onClick={() => navigate('/mission')} className="text-accent text-sm hover:underline">← Start a new mission</button>
      </div>
    );
  }

  const { working, blocked } = countTeam(room);

  return (
    <div className="fixed inset-0 bg-bg-deep text-text overflow-hidden font-sans">
      <Starfield />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(99,102,241,0.18)_0%,rgba(11,16,32,0)_55%)]" />

      {/* Top bar */}
      <header className="relative z-20 flex items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/mission')} className="text-text-muted hover:text-text text-sm" title="New mission">←</button>
          <button
            onClick={() => navigate('/mission/library')}
            className="text-[10px] uppercase tracking-widest text-text-muted hover:text-text border border-border rounded-full px-2 py-0.5"
            title="Browse past missions"
          >
            Library
          </button>
          <div className="font-semibold tracking-tight">
            <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">TITAN</span>
            <span className="text-text-muted font-normal"> &nbsp;›&nbsp; </span>
            <span className="text-text-secondary font-normal">Mission Canvas</span>
            <span className="text-text-muted font-normal"> &nbsp;›&nbsp; </span>
            <span className="truncate inline-block max-w-md align-bottom">{shorten(room.goal, 60)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-bg-secondary/60 border border-border rounded-full text-xs">
            <span className={`w-2 h-2 rounded-full ${blocked > 0 ? 'bg-error animate-pulse' : working > 0 ? 'bg-accent animate-pulse' : 'bg-success'}`} />
            <span className="text-text-muted">{statusBlurb(room.status, working, blocked)}</span>
          </div>
          {blocked > 0 && (
            <div className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-error/15 border border-error/30 rounded-full text-xs text-error" title="Decisions waiting on you">
              🔔 {blocked}
            </div>
          )}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-bg-secondary/60 border border-border rounded-full text-xs">
            <Flame />
            <span className="text-text font-medium">${room.cost.usd.toFixed(2)}</span>
            <span className="text-text-muted">· effort so far</span>
          </div>
          <Link to={`/mission/${room.id}`} label="Chat view" />
          <button onClick={onTogglePause} className="px-3 py-1.5 text-xs bg-bg-secondary/60 border border-border rounded-full text-text-secondary hover:text-text" title={room.status === 'paused' ? 'Resume the team' : 'Pause the team'}>
            {room.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => setHelpOpen(v => !v)} className="w-8 h-8 rounded-full bg-bg-secondary/60 border border-border text-text-muted hover:text-text font-semibold text-sm flex items-center justify-center" title="What's this?">?</button>
        </div>
      </header>

      {/* Mission goal chip */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 bg-bg-secondary/80 border border-border rounded-full px-4 py-2 text-sm backdrop-blur-md max-w-2xl shadow-2xl">
        <span className="text-[10px] uppercase tracking-[0.18em] text-text-muted mr-2.5">Your mission</span>
        <span className="text-text">{room.goal}</span>
      </div>

      {/* SVG tethers — drawn behind everything */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-0" preserveAspectRatio="none">
        {positions.map((p) => (
          <path
            key={p.member.agentId}
            d={tetherPath(p.x, p.y)}
            fill="none"
            stroke={tetherColor(p.member.state, p.member.color)}
            strokeWidth={1.6}
            strokeDasharray="5 6"
            style={{ animation: 'tetherflow 8s linear infinite' }}
            opacity={room.status === 'paused' ? 0.18 : 0.5}
          />
        ))}
      </svg>

      {/* Central artifact */}
      <ArtifactPaper room={room} />

      {/* Agent pods */}
      {positions.map(p => (
        <AgentPod
          key={p.member.agentId}
          member={p.member}
          style={{ left: p.css.left, top: p.css.top, right: p.css.right, bottom: p.css.bottom }}
        />
      ))}

      {/* Floating question bubble (most recent OPEN question, near its owner) */}
      {openQuestion && (
        <QuestionBubble
          msg={openQuestion}
          owner={room.team.find(t => t.agentId === openQuestion.from.agentId)}
          positions={positions}
          onAnswer={(text) => onAnswer(openQuestion.approvalId, text)}
        />
      )}

      {/* You-cursor (just visual presence near the middle-bottom). */}
      <div className="absolute left-1/2 bottom-32 -translate-x-1/2 z-10 pointer-events-none" aria-hidden>
        <div className="relative w-3.5 h-3.5 rounded-full bg-white shadow-[0_0_0_2px_rgba(255,255,255,0.4),0_0_24px_12px_rgba(99,102,241,0.35)]">
          <span className="absolute left-5 -top-1 text-[10px] uppercase tracking-[0.16em] text-text-muted">you</span>
        </div>
      </div>

      {/* Legend */}
      <div className="absolute left-5 bottom-32 z-10 flex flex-col gap-1 text-[11px] text-text-muted max-w-[240px]">
        <Swatch color="var(--color-accent)" label="working on it" />
        <Swatch color="var(--color-warning)" label="making edits" />
        <Swatch color="var(--color-error)"   label="waiting on you" />
        <div className="mt-1">Glowing line · helpers passing work</div>
        <div>Flame · effort spent this session</div>
      </div>

      {/* Bottom rail: time scrubber + steer input + slash bar */}
      <footer className="absolute left-0 right-0 bottom-0 z-20 px-5 pb-5 pt-3 bg-gradient-to-t from-bg-deep/95 to-transparent flex flex-col gap-2">
        {/* Slash command quick-bar */}
        <div className="flex flex-wrap items-center gap-2 max-w-5xl mx-auto w-full">
          <span className="text-[10px] uppercase tracking-widest text-text-muted">quick steer</span>
          {SLASH_COMMANDS.map(s => (
            <button
              key={s.cmd}
              onClick={() => sendSteer(s.cmd)}
              disabled={sending}
              title={s.hint}
              className="px-2.5 py-1 text-[11px] text-text-secondary bg-bg-secondary/60 border border-border rounded-full hover:text-text hover:border-border-light disabled:opacity-50"
            >{s.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 max-w-5xl mx-auto w-full">
          {/* Time scrubber (cosmetic for v6.1; rewind UI lands in v6.2) */}
          <div className="flex-1 h-9 flex items-center gap-2.5 px-3.5 bg-bg-secondary/60 border border-border rounded-full backdrop-blur-md min-w-[280px]">
            <button className="text-text-muted hover:text-text text-xs" title="Rewind">⏮</button>
            <div className="flex-1 h-1 bg-white/8 rounded-full relative">
              <div className="absolute inset-y-0 left-0 w-2/3 rounded-full bg-gradient-to-r from-accent to-accent2" />
              <div className="absolute top-1/2 left-2/3 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-[0_0_18px_4px_rgba(99,102,241,0.6)]" />
            </div>
            <button className="text-text-muted hover:text-text text-xs" title="Forward">⏭</button>
            <span className="text-[11px] text-text-muted tabular-nums min-w-[44px] text-right">live</span>
          </div>
          {/* Steer input */}
          <form
            onSubmit={(e) => { e.preventDefault(); sendSteer(steerInput); }}
            className="flex-[2] h-11 flex items-center gap-2.5 px-3.5 bg-bg-secondary/80 border border-border rounded-full backdrop-blur-md"
          >
            <input
              value={steerInput}
              onChange={(e) => setSteerInput(e.target.value)}
              placeholder='Tell the team — "Keep the layoffs out, but add a one-line risk note"'
              className="flex-1 bg-transparent outline-none text-sm text-text placeholder:text-text-muted/60"
            />
            <span className="px-2 py-1 text-[10px] uppercase tracking-widest text-text-muted border border-border rounded">↵</span>
            <button type="button" disabled className="relative w-8 h-8 rounded-full bg-bg-tertiary/60 border border-border text-text-muted opacity-50 cursor-not-allowed flex items-center justify-center" title="Voice coming next release">
              🎤
              <span className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-widest text-text-muted">soon</span>
            </button>
          </form>
        </div>
      </footer>

      {/* Help panel */}
      {helpOpen && (
        <div className="fixed top-16 right-5 w-80 bg-bg-secondary/95 border border-border rounded-xl p-4 backdrop-blur-xl shadow-2xl z-30">
          <button onClick={() => setHelpOpen(false)} className="absolute top-3 right-3 text-text-muted hover:text-text text-sm">✕</button>
          <h3 className="font-semibold text-sm mb-2">What you're looking at</h3>
          <p className="text-xs text-text-secondary leading-relaxed mb-3">
            A spatial view of your AI team. Each helper has a role. Glowing lines show who's contributing where. Click the <b className="text-text">Chat view</b> button up top to switch to a thread layout — same mission, same team, same data.
          </p>
          <ul className="space-y-2 text-xs text-text-secondary">
            <li className="flex gap-2"><span>👥</span><span><b className="text-text">Helper pods</b> show what each one is doing right now.</span></li>
            <li className="flex gap-2"><span>📄</span><span>The <b className="text-text">document</b> in the middle updates as the team works.</span></li>
            <li className="flex gap-2"><span>❓</span><span>When a helper needs you, a <b className="text-text">pink bubble</b> appears near them.</span></li>
            <li className="flex gap-2"><span>⚡</span><span>Bottom-left <b className="text-text">quick steers</b> are shortcuts: slow down, be thorough, wrap up, etc.</span></li>
            <li className="flex gap-2"><span>🎤</span><span><b className="text-text">Voice comes next release.</b></span></li>
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Layout ─────────────────────────────────────────────────────────

interface PodPosition {
  member: MissionMember;
  x: number; y: number; // approximate pixel coords for the SVG tether endpoints
  css: { left?: string; right?: string; top?: string; bottom?: string };
}

/**
 * Place agents around the central document. Up to 5 agents get fixed
 * canonical positions matching the mockup. More agents wrap into a wider
 * ring with computed offsets.
 */
function layoutTeam(team: MissionMember[]): PodPosition[] {
  const slots: Array<{ css: PodPosition['css']; x: number; y: number }> = [
    { css: { left: '18%',  top: '17%' },    x: 270,  y: 200 }, // top-left
    { css: { right: '14%', top: '23%' },    x: 1180, y: 250 }, // top-right
    { css: { left: '22%',  bottom: '18%' }, x: 370,  y: 700 }, // bottom-left
    { css: { right: '9%',  top: '50%' },    x: 1280, y: 460 }, // middle-right
    { css: { right: '19%', bottom: '16%' }, x: 1140, y: 700 }, // bottom-right
    { css: { left: '8%',   top: '50%' },    x: 200,  y: 460 }, // middle-left (overflow)
    { css: { left: '40%',  top: '8%' },     x: 720,  y: 120 }, // top-center (overflow)
    { css: { left: '40%',  bottom: '8%' },  x: 720,  y: 780 }, // bottom-center (overflow)
  ];
  return team.map((member, i) => {
    const slot = slots[i % slots.length];
    return { member, x: slot.x, y: slot.y, css: slot.css };
  });
}

// ── Sub-components ────────────────────────────────────────────────

function AgentPod({ member, style }: { member: MissionMember; style: React.CSSProperties }) {
  const blocked = member.state === 'blocked';
  const active = member.state === 'working' || member.state === 'editing';
  return (
    <div
      className="absolute w-44 rounded-2xl border border-border bg-bg-secondary/55 backdrop-blur-md p-3 shadow-[0_6px_30px_rgba(0,0,0,0.35)] z-10"
      style={style}
    >
      {active && (
        <div
          className="absolute -inset-1 rounded-[18px] -z-10 blur-md pointer-events-none"
          style={{
            background: `linear-gradient(120deg, ${member.color}aa, #b07cff66)`,
            opacity: 0.5,
            animation: 'podpulse 4.2s ease-in-out infinite',
          }}
        />
      )}
      {blocked && (
        <div
          className="absolute -inset-0.5 rounded-[18px] -z-10 pointer-events-none"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${member.color}80, transparent 70%)`,
            animation: 'podalarm 1.8s ease-in-out infinite',
          }}
        />
      )}
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center text-bg-deep font-bold text-[12px]"
          style={{ background: `linear-gradient(135deg, ${member.color}, ${shade(member.color, -25)})` }}
        >{member.name[0]}</div>
        <div className="leading-tight">
          <div className="font-semibold text-[13px]">{member.name}</div>
          <div className="text-[11px] text-text-muted">{member.role}</div>
        </div>
      </div>
      <div className="text-[12px] text-text-secondary leading-snug min-h-[2.5rem]">
        {member.currentActivity ? (
          <span>{member.currentActivity}</span>
        ) : (
          <span className="text-text-muted italic">standing by</span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-text-muted/80 tracking-wider">
        <span
          className={`w-1.5 h-1.5 rounded-full ${heartbeatClass(member.state)}`}
          style={{ boxShadow: `0 0 8px ${heartbeatColor(member.state)}` }}
        />
        <span>{stateLabel(member.state)}</span>
      </div>
    </div>
  );
}

function ArtifactPaper({ room }: { room: MissionRoom }) {
  const lines = useMemo(() => {
    const all = room.artifact.content.split('\n').filter(l => l.trim().length > 0);
    return all.slice(0, 7); // cap visual length; full content is on the chat view
  }, [room.artifact.content]);
  const words = room.artifact.content.trim().split(/\s+/).filter(Boolean).length;
  // Find an agent currently writing into the artifact for the "Builder is here" hint
  const writer = room.team.find(m => m.state === 'working' && /writ|draft|polish/i.test(m.currentActivity ?? ''));
  return (
    <div
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[460px] max-w-[88vw] bg-[#f7f5ee] text-[#1a1f2e] rounded-md p-8 pt-7 z-[5] shadow-[0_30px_80px_rgba(0,0,0,0.55),0_4px_0_rgba(0,0,0,0.12)]"
      style={{
        fontFamily: '"Iowan Old Style", "Charter", "Georgia", serif',
        backgroundImage: 'repeating-linear-gradient(180deg, transparent 0 27px, #d8d3c2 27px 28px)',
        backgroundPosition: '0 50px',
      }}
    >
      <h1 className="text-[22px] font-semibold tracking-tight leading-tight mb-1">
        {shorten(room.goal, 70)}
      </h1>
      <div className="text-[11px] uppercase tracking-widest text-[#8a8472] mb-5">
        Draft · {words} words · {statusToLabel(room.status)}
      </div>
      {lines.length > 0 ? (
        <div className="text-[14px] leading-[1.55] space-y-3.5">
          {lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          {writer && (
            <p className="text-[#a59c80] italic text-[13px] pt-1">
              ⌃ {writer.name} is here, {(writer.currentActivity ?? 'working').toLowerCase()}
            </p>
          )}
        </div>
      ) : (
        <div className="text-[13px] italic text-[#8a8472] py-8 text-center">
          The team is just getting started — your document will fill in as they work.
        </div>
      )}
    </div>
  );
}

function QuestionBubble({
  msg, owner, positions, onAnswer,
}: {
  msg: Extract<MissionMessage, { kind: 'question' }>;
  owner?: MissionMember;
  positions: PodPosition[];
  onAnswer: (answer: string) => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (customMode && taRef.current) taRef.current.focus(); }, [customMode]);

  // Float toward where the owner's pod sits (right side by default).
  const ownerPos = positions.find(p => p.member.agentId === msg.from.agentId);
  const isRight = !ownerPos?.css.left;

  return (
    <div
      className="absolute z-[15] w-[260px] p-3.5 rounded-2xl text-[#5c1820] shadow-[0_8px_28px_rgba(255,93,108,0.35)]"
      style={{
        background: 'linear-gradient(180deg, #ffe9eb, #ffd0d4)',
        right: isRight ? '14%' : undefined,
        left: !isRight ? '14%' : undefined,
        bottom: '30%',
        animation: 'floatup 4s ease-in-out infinite',
      }}
    >
      <div className="inline-flex items-center gap-1.5 px-2 py-0.5 mb-2 bg-[#5c1820] text-[#ffd0d4] text-[10px] uppercase tracking-widest font-bold rounded-full">
        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
        {(owner?.name ?? msg.from.name)} asks
      </div>
      <div className="text-[13px] leading-snug">{msg.content}</div>
      {!customMode ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {msg.quickReplies.map((q, i) => (
            <button
              key={q}
              onClick={() => onAnswer(q)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
                i === msg.quickReplies.length - 1
                  ? 'bg-gradient-to-br from-accent to-accent2 text-bg-deep border-transparent'
                  : 'bg-white border-[rgba(160,41,56,0.25)] text-[#5c1820]'
              }`}
            >{q}</button>
          ))}
          <button
            onClick={() => setCustomMode(true)}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium underline underline-offset-2 text-[#5c1820]/80 hover:text-[#5c1820]"
          >or type…</button>
        </div>
      ) : (
        <div className="mt-3">
          <textarea
            ref={taRef}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                const t = customText.trim();
                if (t) onAnswer(t);
              } else if (e.key === 'Escape') {
                setCustomMode(false);
              }
            }}
            rows={2}
            placeholder="Your answer…"
            className="w-full bg-white/90 border border-[rgba(160,41,56,0.25)] rounded-lg p-2 text-[12px] text-[#5c1820] outline-none"
          />
          <div className="flex items-center justify-end gap-2 mt-1">
            <button onClick={() => setCustomMode(false)} className="text-[10px] text-[#5c1820]/70 hover:text-[#5c1820]">cancel</button>
            <button
              onClick={() => { const t = customText.trim(); if (t) onAnswer(t); }}
              disabled={!customText.trim()}
              className="px-2 py-0.5 rounded text-[11px] font-semibold bg-gradient-to-br from-accent to-accent2 text-bg-deep disabled:opacity-50"
            >Send</button>
          </div>
        </div>
      )}
      {/* Tail */}
      <div
        className="absolute w-0 h-0"
        style={{
          bottom: '-10px',
          right: isRight ? '28px' : undefined,
          left: !isRight ? '28px' : undefined,
          borderLeft: '8px solid transparent',
          borderRight: '8px solid transparent',
          borderTop: '8px solid #ffd0d4',
        }}
      />
    </div>
  );
}

function Link({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(to)}
      className="px-3 py-1.5 text-xs bg-bg-secondary/60 border border-border rounded-full text-text-secondary hover:text-text"
      title="Switch to the chat thread view of the same mission"
    >{label}</button>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function Flame() {
  return (
    <span
      className="inline-block w-3 h-4"
      style={{
        background: 'radial-gradient(ellipse at 50% 70%, #ffeb6b 0%, #ff8a4a 45%, transparent 70%)',
        animation: 'flicker 1.4s ease-in-out infinite alternate',
      }}
    />
  );
}

function Starfield() {
  // 40 ambient drifting dots, like the mockup
  const stars = useMemo(() => Array.from({ length: 40 }, () => ({
    left: Math.random() * 100,
    top: Math.random() * 100,
    dur: 12 + Math.random() * 22,
    delay: -Math.random() * 30,
    opacity: 0.2 + Math.random() * 0.6,
  })), []);
  return (
    <div className="absolute inset-0 pointer-events-none opacity-60 overflow-hidden" aria-hidden>
      {stars.map((s, i) => (
        <div
          key={i}
          className="absolute w-0.5 h-0.5 rounded-full bg-white"
          style={{
            left: `${s.left}vw`,
            top: `${s.top}vh`,
            boxShadow: '0 0 6px #fff',
            opacity: s.opacity,
            animation: `drift ${s.dur}s linear infinite`,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
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
  if (s === 'failed')  return 'Stopped';
  if (blocked > 0)     return `${working} working · ${blocked} needs you`;
  if (working > 0)     return `${working} working`;
  if (s === 'forming') return 'Forming team…';
  return 'Idle';
}

function statusToLabel(s: MissionRoom['status']): string {
  if (s === 'paused') return 'paused';
  if (s === 'done') return 'done';
  if (s === 'failed') return 'stopped';
  if (s === 'blocked') return 'waiting on you';
  return 'auto-saving';
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function heartbeatClass(s: string): string {
  switch (s) {
    case 'working': return 'bg-accent animate-pulse';
    case 'editing': return 'bg-warning animate-pulse';
    case 'blocked': return 'bg-error animate-pulse';
    case 'done':    return 'bg-success';
    default:        return 'bg-text-muted';
  }
}

function heartbeatColor(s: string): string {
  switch (s) {
    case 'working': return '#6366f1';
    case 'editing': return '#f59e0b';
    case 'blocked': return '#ef4444';
    case 'done':    return '#22c55e';
    default:        return '#71717a';
  }
}

function stateLabel(s: string): string {
  if (s === 'working') return 'working';
  if (s === 'editing') return 'editing';
  if (s === 'blocked') return 'needs you';
  if (s === 'done')    return 'done';
  return 'idle';
}

function tetherPath(x: number, y: number): string {
  // Bezier curve from agent pod (x, y) toward central artifact (~50% screen).
  // Hard-coded center hint of "around 970, 480" matches the mockup at common
  // viewports; the SVG scales to the viewBox so the curve stays smooth on
  // any aspect ratio.
  const cx = 870, cy = 480;
  const mx = (x + cx) / 2;
  const my = (y + cy) / 2 + (y > cy ? -60 : 60);
  return `M ${x} ${y} Q ${mx} ${my}, ${cx} ${cy}`;
}

function tetherColor(state: string, fallback: string): string {
  switch (state) {
    case 'working': return 'rgba(99, 102, 241, 0.45)';   // accent blue
    case 'editing': return 'rgba(245, 158, 11, 0.55)';   // warm amber
    case 'blocked': return 'rgba(239, 68, 68, 0.7)';     // red
    default:        return fallback + '80';
  }
}

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
