/**
 * TITAN — Agent menu popover (v6.1.0-alpha.19)
 *
 * Click any sticky-note agent on the Mission Canvas → this popover.
 * Six controls, each routed to a backend endpoint or existing
 * mission-message channel:
 *
 *   1. **Model** — dropdown of available provider/model ids. Sets the
 *      agent's modelOverride via /api/missions/:id/agent/:agentId/model.
 *      Consumer wiring (goal driver picking the override) lands in
 *      alpha.20+; today the choice is persisted and surfaces in the UI.
 *   2. **Pause / Resume agent** — same pattern, /agent/:agentId/pause.
 *      The goal driver will skip paused agents once the marathon-mode
 *      daemon ships.
 *   3. **Nudge** — sends an "@AgentName quick check-in — how's it
 *      going?" message via the existing /message endpoint. The
 *      lifecycle's `handleUserMessage` already routes @prefixed
 *      messages to the matching specialist.
 *   4. **Talk to them** — opens a textarea inline so the user can
 *      compose a message that posts `@AgentName <text>` via /message.
 *   5. **Steer** — same as Talk, but suggests a steering-style prompt
 *      ("Focus on / Skip / Wrap up").
 *   6. **Marathon mode** (mission-wide, not per-agent) — toggle that
 *      flips room.longRunningMode via /mode. Surfaced here too so the
 *      user can flip it from the same popover they're configuring the
 *      team from.
 *
 * Visual: paper-themed popover with the agent's color as the accent
 * bar, dock-style anchored to the click position. Click outside or
 * Esc to close.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  postMessage,
  setAgentModelOverride,
  setAgentPaused,
  setMissionMode,
  nudgeMission,
  type MissionMember,
  type MissionRoom,
} from '@/api/missions';
import { executeNudge, nudgeHint } from './nudgeLogic';

interface ModelOption { id: string; label: string; provider: string }

export interface AgentMenuAnchor { x: number; y: number; }

export function AgentMenu({
  member,
  room,
  anchor,
  availableModels,
  onClose,
  onTalkInChat,
}: {
  member: MissionMember;
  room: MissionRoom;
  anchor: AgentMenuAnchor;
  availableModels: ModelOption[];
  onClose: () => void;
  /** Optional — when present, "Talk to them" can also focus the chat
   *  input with `@Name ` prepended instead of opening the inline
   *  textarea. The Canvas page doesn't have a chat input visible so
   *  it uses the inline textarea; the Chat page wires this through. */
  onTalkInChat?: (agentId: string, prefill: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<'main' | 'talk' | 'steer' | 'model'>('main');
  const [composeText, setComposeText] = useState('');
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc-to-close. Outside-click handled by the backdrop in the parent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Position the popover so it doesn't run off the right or bottom edge.
  const POPOVER_W = 320;
  const POPOVER_H = 360;
  const padded = clampAnchor(anchor, POPOVER_W, POPOVER_H);

  // ── Action helpers ─────────────────────────────────────────────

  async function nudge() {
    setBusy(true);
    setError(null);
    try {
      await executeNudge(room, member, { nudgeMission, postMessage });
      onClose();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function sendCompose(prefix: string) {
    const text = composeText.trim();
    if (!text || composing) return;
    setComposing(true);
    setError(null);
    try {
      await postMessage(room.id, `@${member.name} ${prefix}${text}`);
      setComposeText('');
      onClose();
    } catch (err) { setError((err as Error).message); }
    finally { setComposing(false); }
  }

  async function pickModel(modelId: string | null) {
    setBusy(true);
    setError(null);
    try {
      await setAgentModelOverride(room.id, member.agentId, modelId);
      setMode('main');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function togglePause() {
    setBusy(true);
    setError(null);
    try { await setAgentPaused(room.id, member.agentId, !member.paused); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function toggleMarathon() {
    setBusy(true);
    setError(null);
    try { await setMissionMode(room.id, !room.longRunningMode); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      {/* Backdrop catches outside-click */}
      <div className="fixed inset-0 z-[60]" onClick={onClose} aria-hidden />

      <div
        ref={ref}
        className="absolute z-[61] flex flex-col titan-modal-surface overflow-hidden"
        style={{
          left: padded.x,
          top: padded.y,
          width: POPOVER_W,
          maxHeight: POPOVER_H,
          borderRadius: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: name + role + color accent bar */}
        <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${member.color}, ${shade(member.color, -25)})` }} />
        <div className="px-4 pt-3 pb-2 flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center text-white font-bold text-[14px]"
            style={{ background: `linear-gradient(135deg, ${member.color}, ${shade(member.color, -25)})` }}
          >{member.name[0]}</div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm">{member.name}</div>
            <div className="text-[11px] text-text-muted">
              {member.role} · {stateLabel(member)}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="titan-close-btn w-7 h-7 rounded-full flex items-center justify-center text-sm"
            style={{ border: '1px solid var(--theme-menu-border)' }}
          >
            ✕
          </button>
        </div>

        {/* Current activity preview */}
        {member.currentActivity && (
          <div className="px-4 pb-2 text-[11px] text-text-secondary italic leading-snug border-b border-border/60">
            "{member.currentActivity}"
          </div>
        )}

        {error && (
          <div className="px-4 py-2 text-[11px] text-error bg-error/10 border-b border-error/30">{error}</div>
        )}

        {/* Body switches between modes */}
        <div className="flex-1 overflow-y-auto">
          {mode === 'main' && (
            <div className="p-2 grid grid-cols-2 gap-2">
              <ActionTile
                icon="👋"
                label="Nudge"
                hint={nudgeHint(room, member)}
                onClick={nudge}
                disabled={busy}
              />
              <ActionTile
                icon="💬"
                label="Talk to them"
                hint="Send a message just to them"
                onClick={() => {
                  if (onTalkInChat) { onTalkInChat(member.agentId, `@${member.name} `); onClose(); }
                  else setMode('talk');
                }}
                disabled={busy}
              />
              <ActionTile
                icon="🧭"
                label="Steer"
                hint="Redirect them mid-task"
                onClick={() => setMode('steer')}
                disabled={busy}
              />
              <ActionTile
                icon="🧠"
                label="Model"
                hint={member.modelOverride ? short(member.modelOverride) : 'default'}
                onClick={() => setMode('model')}
                disabled={busy}
              />
              <ActionTile
                icon={member.paused ? '▶' : '⏸'}
                label={member.paused ? 'Resume agent' : 'Pause agent'}
                hint={member.paused ? 'Bring them back' : 'Skip them for now'}
                onClick={togglePause}
                disabled={busy}
                wide={false}
              />
              <ActionTile
                icon="🏃"
                label={room.longRunningMode ? 'Marathon ON' : 'Marathon mode'}
                hint={room.longRunningMode ? 'running 72h goal' : '72h auto-run'}
                onClick={toggleMarathon}
                disabled={busy}
                active={!!room.longRunningMode}
              />
            </div>
          )}

          {(mode === 'talk' || mode === 'steer') && (
            <div className="p-3 flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-widest text-text-muted">
                {mode === 'talk' ? `Message ${member.name}` : `Steer ${member.name}`}
              </div>
              <textarea
                autoFocus
                value={composeText}
                onChange={(e) => setComposeText(e.target.value)}
                rows={4}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    sendCompose(mode === 'steer' ? 'steer: ' : '');
                  }
                }}
                placeholder={mode === 'steer' ? 'e.g. "skip the chart, focus on cost comparison"' : 'Type a private note to them…'}
                className="bg-bg-tertiary border border-border rounded-lg p-2 text-sm text-text outline-none focus:border-accent resize-none"
              />
              {mode === 'steer' && (
                <div className="flex flex-wrap gap-1.5">
                  {['Slow down', 'Be thorough', 'Wrap it up', 'Skip the chart'].map(q => (
                    <button
                      key={q}
                      onClick={() => setComposeText(q.toLowerCase())}
                      className="px-2 py-0.5 text-[11px] bg-bg-tertiary border border-border rounded-full text-text-muted hover:text-text"
                    >{q}</button>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => setMode('main')} className="text-xs text-text-muted hover:text-text">← Back</button>
                <button
                  onClick={() => sendCompose(mode === 'steer' ? 'steer: ' : '')}
                  disabled={!composeText.trim() || composing}
                  className="px-3 py-1.5 rounded-lg font-bold text-bg-deep bg-gradient-to-br from-accent to-accent2 disabled:opacity-50 text-xs"
                >
                  {composing ? 'Sending…' : `Send ⌘↵`}
                </button>
              </div>
            </div>
          )}

          {mode === 'model' && (
            <div className="p-3 flex flex-col gap-2">
              <div className="text-[10px] uppercase tracking-widest text-text-muted">
                {member.name}'s brain
              </div>
              <div className="text-[11px] text-text-secondary leading-snug">
                Pick a specific model for this agent on this mission.
                Empty = the role's default.
              </div>
              {member.modelOverride && (
                <div className="px-2.5 py-1.5 rounded-lg bg-accent/10 border border-accent/40 text-[12px] text-text flex items-center justify-between">
                  <span className="truncate">Now: <b>{member.modelOverride}</b></span>
                  <button onClick={() => pickModel(null)} className="text-[11px] text-text-muted hover:text-text shrink-0">clear</button>
                </div>
              )}
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                {availableModels.length === 0 ? (
                  <div className="text-[11px] text-text-muted italic">No models discovered. /api/models returned empty.</div>
                ) : availableModels.map(m => {
                  const active = member.modelOverride === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => pickModel(m.id)}
                      disabled={busy}
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12px] border text-left ${
                        active
                          ? 'bg-accent/10 border-accent/60 text-text'
                          : 'bg-bg-tertiary/40 border-border text-text-secondary hover:text-text hover:border-border-light'
                      }`}
                    >
                      <span className="truncate">{m.id}</span>
                      <span className="text-[10px] text-text-muted ml-2 shrink-0">{m.provider}</span>
                    </button>
                  );
                })}
              </div>
              <button onClick={() => setMode('main')} className="text-xs text-text-muted hover:text-text self-start mt-1">← Back</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ActionTile({
  icon, label, hint, onClick, disabled, wide, active,
}: {
  icon: string; label: string; hint?: string;
  onClick: () => void;
  disabled?: boolean;
  wide?: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left p-2.5 rounded-xl border transition-colors ${
        active
          ? 'bg-accent/15 border-accent/50 text-text'
          : 'bg-bg-tertiary/40 border-border text-text-secondary hover:text-text hover:border-border-light'
      } ${wide ? 'col-span-2' : ''} disabled:opacity-50`}
    >
      <div className="text-lg leading-none mb-1">{icon}</div>
      <div className="text-[12px] font-semibold leading-tight">{label}</div>
      {hint && <div className="text-[10px] text-text-muted leading-snug mt-0.5 truncate">{hint}</div>}
    </button>
  );
}

function clampAnchor({ x, y }: AgentMenuAnchor, w: number, h: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(8, Math.min(x, vw - w - 8)),
    y: Math.max(8, Math.min(y, vh - h - 8)),
  };
}

function stateLabel(m: MissionMember): string {
  if (m.paused) return 'paused (by you)';
  if (m.state === 'working') return 'working';
  if (m.state === 'editing') return 'editing';
  if (m.state === 'blocked') return 'needs you';
  if (m.state === 'done') return 'done';
  return 'idle';
}

function short(modelId: string): string {
  if (modelId.length <= 24) return modelId;
  return modelId.slice(0, 22) + '…';
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
