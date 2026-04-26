/**
 * TITAN — Event Detail Panel (v4.5.3)
 *
 * Slide-over that opens when the user clicks an activity row. Shows the
 * full story behind the event in plain English, with links to the live
 * session / goal / approval / tool run that produced it.
 *
 * For session-linked events (turn:pre, turn:post, tool:*), we fetch the
 * session's recent messages so Tony can read what was actually said /
 * done. For goal events we fetch the subtask breakdown. For soma
 * proposals we fetch the approval state. Everything fetches lazily.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import type { WatchEvent, WatchVoice } from './types';
import { timeAgo } from './types';
import { apiFetch } from '@/api/client';

interface Props {
    event: WatchEvent | null;
    voice: WatchVoice;
    onClose: () => void;
}

export function EventDetailPanel({ event, voice, onClose }: Props) {
    return (
        <AnimatePresence>
            {event && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        key="backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        onClick={onClose}
                        style={{
                            position: 'fixed', inset: 0,
                            background: 'rgba(0, 0, 0, 0.55)',
                            backdropFilter: 'blur(4px)',
                            WebkitBackdropFilter: 'blur(4px)',
                            zIndex: 99,
                        }}
                    />
                    {/* Panel */}
                    <motion.aside
                        key="panel"
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                        style={{
                            position: 'fixed',
                            top: 0, right: 0, bottom: 0,
                            width: 'min(540px, 100vw)',
                            background: 'rgba(10, 12, 20, 0.96)',
                            backdropFilter: 'blur(24px)',
                            WebkitBackdropFilter: 'blur(24px)',
                            borderLeft: '1px solid rgba(167, 139, 250, 0.15)',
                            display: 'flex',
                            flexDirection: 'column',
                            zIndex: 100,
                            color: '#f8f9fc',
                            boxShadow: '-20px 0 60px rgba(0,0,0,0.5)',
                        }}
                        role="dialog"
                        aria-modal="true"
                    >
                        <DetailContent event={event} voice={voice} onClose={onClose} />
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    );
}

function DetailContent({ event, voice, onClose }: { event: WatchEvent; voice: WatchVoice; onClose: () => void }) {
    const caption = voice === 'titan' ? event.captionTitan : event.captionControl;
    const raw = event.raw || {};
    // Esc to close
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <>
            {/* Header */}
            <div style={{
                padding: '20px 24px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
            }}>
                <div style={{
                    fontSize: 22,
                    width: 36, height: 36,
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.04)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                }}>
                    {event.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.3, marginBottom: 4 }}>
                        {caption}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', display: 'flex', gap: 10 }}>
                        <span>{timeAgo(event.timestamp)}</span>
                        <span style={{ opacity: 0.5 }}>·</span>
                        <span style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>{event.kind}</span>
                        <span style={{ opacity: 0.5 }}>·</span>
                        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{event.topic}</span>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    aria-label="Close"
                    style={{
                        background: 'transparent', border: 0, color: 'rgba(255,255,255,0.55)',
                        cursor: 'pointer', padding: 6, borderRadius: 8,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    <X size={18} />
                </button>
            </div>

            {/* Body — kind-specific views */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', minHeight: 0 }}>
                {event.detail && (
                    <Section label="Detail">
                        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                            {event.detail}
                        </div>
                    </Section>
                )}

                {event.kind === 'soma' && <SomaProposalDetail raw={raw} />}
                {event.kind === 'goal' && <GoalDetail raw={raw} />}
                {event.kind === 'tool' && <ToolDetail raw={raw} topic={event.topic} />}
                {event.kind === 'channel' && <ChannelDetail raw={raw} topic={event.topic} />}
                {event.kind === 'drive' && <DriveDetail raw={raw} topic={event.topic} />}
                {(event.kind === 'system' || event.kind === 'agent' || event.kind === 'memory' || event.kind === 'health') && (
                    <SystemDetail raw={raw} topic={event.topic} />
                )}
            </div>

            {/* Raw payload drawer */}
            <Details label="Raw event data" raw={raw} />
        </>
    );
}

// ── Section wrapper
function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 20 }}>
            <div style={{
                fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em',
                color: 'rgba(255,255,255,0.35)', fontWeight: 600, marginBottom: 8,
            }}>{label}</div>
            {children}
        </div>
    );
}

// ── Kind-specific detail renderers
function SomaProposalDetail({ raw }: { raw: Record<string, unknown> }) {
    const approvalId = raw.approvalId as string | undefined;
    const dominants = (raw.dominantDrives as string[]) || [];
    const shadow = raw.shadowVerdict as Record<string, unknown> | undefined;
    return (
        <>
            <Section label="What drove this">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
                    {dominants.length ? dominants.map(d => d[0].toUpperCase() + d.slice(1)).join(', ') : 'an unspecified drive'}
                    {' '}was below its setpoint. Soma filed this proposal autonomously.
                </div>
            </Section>
            {approvalId && (
                <Section label="Command Post approval">
                    <code style={{ fontSize: 11, color: 'rgba(167, 139, 250, 0.9)' }}>{approvalId}</code>
                </Section>
            )}
            {shadow && (
                <Section label="Shadow rehearsal verdict">
                    <pre style={{
                        fontSize: 11, lineHeight: 1.4, color: 'rgba(255,255,255,0.7)',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8,
                    }}>{JSON.stringify(shadow, null, 2)}</pre>
                </Section>
            )}
        </>
    );
}

function GoalDetail({ raw }: { raw: Record<string, unknown> }) {
    const goalId = raw.goalId as string | undefined;
    const [goal, setGoal] = useState<Record<string, unknown> | null>(null);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (!goalId) return;
        setLoading(true);
        apiFetch(`/api/goals/${goalId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => setGoal(d?.goal || d || null))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [goalId]);

    if (!goalId) return null;
    if (loading) return <Section label="Goal"><div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>Loading…</div></Section>;
    if (!goal) return <Section label="Goal"><div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>Goal not found (may have been deleted).</div></Section>;

    const subtasks = (goal.subtasks as Array<Record<string, unknown>>) || [];
    const doneCount = subtasks.filter(s => s.status === 'done' || s.status === 'skipped').length;
    return (
        <Section label="Goal">
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{String(goal.title || '')}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 12 }}>
                {String(goal.status || '')} · {doneCount}/{subtasks.length} subtasks
            </div>
            {subtasks.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {subtasks.map((st, i) => (
                        <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 10px', borderRadius: 8,
                            background: 'rgba(255,255,255,0.02)',
                            fontSize: 12,
                        }}>
                            <span style={{
                                width: 8, height: 8, borderRadius: '50%',
                                background: subtaskColor(st.status as string),
                                boxShadow: `0 0 6px ${subtaskColor(st.status as string)}`,
                                flexShrink: 0,
                            }} />
                            <span style={{ flex: 1 }}>{String(st.title || '')}</span>
                            <span style={{
                                fontSize: 10, color: 'rgba(255,255,255,0.35)',
                                textTransform: 'uppercase', letterSpacing: '0.1em',
                            }}>{String(st.status || '')}</span>
                        </div>
                    ))}
                </div>
            )}
        </Section>
    );
}

function subtaskColor(status: string): string {
    switch (status) {
        case 'done': return 'var(--color-emerald)';
        case 'running': return 'var(--color-cyan)';
        case 'failed': return 'var(--color-error)';
        case 'skipped': return 'var(--color-text-secondary)';
        case 'pending': return '#fbbf24';
        default: return '#9ca3af';
    }
}

function ToolDetail({ raw, topic }: { raw: Record<string, unknown>; topic: string }) {
    const tool = raw.tool as string | undefined;
    const argsPreview = raw.argsPreview as string | Record<string, unknown> | undefined;
    const durationMs = raw.durationMs as number | undefined;
    const success = raw.success as boolean | undefined;
    return (
        <>
            {tool && (
                <Section label="Tool">
                    <code style={{ fontSize: 12, color: 'rgba(96, 165, 250, 0.9)' }}>{tool}</code>
                </Section>
            )}
            {argsPreview !== undefined && (
                <Section label="Arguments">
                    <pre style={{
                        fontSize: 11, lineHeight: 1.4, color: 'rgba(255,255,255,0.7)',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8,
                        maxHeight: 300, overflowY: 'auto',
                    }}>
                        {typeof argsPreview === 'string' ? argsPreview : JSON.stringify(argsPreview, null, 2)}
                    </pre>
                </Section>
            )}
            {topic === 'tool:result' && (
                <Section label="Result">
                    <div style={{ fontSize: 13, color: success ? 'rgba(52,211,153,0.9)' : 'rgba(239,68,68,0.9)' }}>
                        {success ? '✓ Completed' : '✗ Failed'}
                        {durationMs !== undefined && <span style={{ color: 'rgba(255,255,255,0.5)', marginLeft: 8 }}>in {durationMs}ms</span>}
                    </div>
                </Section>
            )}
        </>
    );
}

function ChannelDetail({ raw, topic }: { raw: Record<string, unknown>; topic: string }) {
    const sessionId = raw.sessionId as string | undefined;
    const channel = raw.channel as string | undefined;
    const userId = raw.userId as string | undefined;
    const message = raw.message as string | undefined;
    const toolsUsed = (raw.toolsUsed as string[]) || [];
    const model = raw.model as string | undefined;
    const durationMs = raw.durationMs as number | undefined;

    const [session, setSession] = useState<Array<Record<string, unknown>> | null>(null);
    useEffect(() => {
        if (!sessionId) return;
        apiFetch(`/api/sessions/${sessionId}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                // Response is an array of messages OR an object with .messages
                const msgs = Array.isArray(d) ? d : (d?.messages || []);
                setSession(msgs);
            })
            .catch(() => {});
    }, [sessionId]);

    return (
        <>
            {channel && (
                <Section label="Channel">
                    <div style={{ fontSize: 13 }}>
                        {channel}{userId && <span style={{ color: 'rgba(255,255,255,0.4)' }}> · {userId}</span>}
                    </div>
                </Section>
            )}
            {message && (
                <Section label={topic === 'turn:pre' ? 'What they said' : 'Message'}>
                    <div style={{
                        fontSize: 13, lineHeight: 1.5, color: 'rgba(255,255,255,0.8)',
                        padding: 12, background: 'rgba(255,255,255,0.02)', borderRadius: 8,
                    }}>{message}</div>
                </Section>
            )}
            {topic === 'turn:post' && (
                <Section label="Turn stats">
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 1.6 }}>
                        {durationMs !== undefined && <div>Took {(durationMs/1000).toFixed(1)}s</div>}
                        {model && <div>Model: {model}</div>}
                        {toolsUsed.length > 0 && <div>Used: {toolsUsed.join(', ')}</div>}
                    </div>
                </Section>
            )}
            {session && session.length > 0 && (
                <Section label="Session messages">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 400, overflowY: 'auto' }}>
                        {session.slice(-8).map((msg, i) => (
                            <div key={i} style={{
                                padding: 10, borderRadius: 8,
                                background: msg.role === 'assistant' ? 'rgba(167, 139, 250, 0.06)' : 'rgba(255,255,255,0.02)',
                                borderLeft: `2px solid ${msg.role === 'assistant' ? 'var(--color-purple-light)' : 'rgba(255,255,255,0.2)'}`,
                                fontSize: 12,
                            }}>
                                <div style={{
                                    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em',
                                    color: 'rgba(255,255,255,0.35)', marginBottom: 4,
                                }}>{String(msg.role || '?')}</div>
                                <div style={{ color: 'rgba(255,255,255,0.85)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                                    {String(msg.content || '').slice(0, 400)}
                                    {String(msg.content || '').length > 400 && '…'}
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
            )}
        </>
    );
}

function DriveDetail({ raw, topic }: { raw: Record<string, unknown>; topic: string }) {
    const drives = (raw.drives as Array<Record<string, unknown>>) || [];
    const totalPressure = raw.totalPressure as number | undefined;
    const dominantDrives = (raw.dominantDrives as string[]) || [];

    return (
        <>
            {totalPressure !== undefined && (
                <Section label="Pressure snapshot">
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
                        Total: <strong>{totalPressure.toFixed(3)}</strong>
                        {dominantDrives.length > 0 && (
                            <span> · Dominant: {dominantDrives.map(d => d[0].toUpperCase() + d.slice(1)).join(', ')}</span>
                        )}
                    </div>
                </Section>
            )}
            {drives.length > 0 && topic === 'drive:tick' && (
                <Section label="All drives this tick">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {drives.map((d, i) => (
                            <div key={i} style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '8px 10px', borderRadius: 8,
                                background: 'rgba(255,255,255,0.02)',
                                fontSize: 12,
                            }}>
                                <span style={{ flex: 1, fontWeight: 500 }}>{String(d.label || d.id)}</span>
                                <span style={{ color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>
                                    sat {(Number(d.satisfaction) * 100).toFixed(0)}% · sp {(Number(d.setpoint) * 100).toFixed(0)}%
                                </span>
                                <span style={{
                                    color: Number(d.pressure) > 0 ? '#fbbf24' : 'rgba(255,255,255,0.25)',
                                    fontVariantNumeric: 'tabular-nums', width: 50, textAlign: 'right',
                                }}>
                                    {Number(d.pressure).toFixed(2)}
                                </span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}
        </>
    );
}

/**
 * System/agent/memory/health events — render as plain-English narrative
 * based on topic, with key fields laid out as prose, not JSON.
 */
function SystemDetail({ raw, topic }: { raw: Record<string, unknown>; topic: string }) {
    // Topic-specific narratives
    if (topic === 'initiative:round') {
        const round = raw.round as number | undefined;
        const max = raw.maxRounds as number | undefined;
        const subtask = raw.subtaskTitle as string | undefined;
        return (
            <Section label="What's happening">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    TITAN is reasoning through round <strong>{round}</strong> of <strong>{max}</strong>
                    {subtask && <> on the subtask <em style={{ color: 'rgba(167, 139, 250, 0.9)' }}>"{subtask}"</em></>}.
                    <br /><br />
                    Each round is one tool-calling cycle — the agent thinks, picks a tool, runs it, then thinks again with the result. The cycle continues until the subtask is complete or the round budget runs out.
                </div>
            </Section>
        );
    }
    if (topic === 'initiative:start') {
        const subtask = raw.subtaskTitle as string | undefined;
        const goal = raw.goalTitle as string | undefined;
        return (
            <Section label="What's happening">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    TITAN picked up a task and started working.
                    {subtask && <> Subtask: <em style={{ color: 'rgba(167, 139, 250, 0.9)' }}>"{subtask}"</em>.</>}
                    {goal && <> Part of goal: <em style={{ color: 'rgba(52, 211, 153, 0.9)' }}>"{goal}"</em>.</>}
                </div>
            </Section>
        );
    }
    if (topic === 'initiative:complete') {
        const success = raw.success as boolean | undefined;
        const toolsUsed = (raw.toolsUsed as string[]) || [];
        const summary = raw.summary as string | undefined;
        return (
            <Section label="Result">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    {success === false ? 'The task ran but ended without full success.' : 'Task complete.'}
                    {toolsUsed.length > 0 && <> Tools used: {toolsUsed.join(', ')}.</>}
                </div>
                {summary && (
                    <div style={{
                        marginTop: 8, padding: 10, borderRadius: 8,
                        background: 'rgba(255,255,255,0.02)',
                        fontSize: 12, lineHeight: 1.5, color: 'rgba(255,255,255,0.7)',
                    }}>{summary}</div>
                )}
            </Section>
        );
    }
    if (topic === 'initiative:no_progress') {
        const reason = raw.reason as string | undefined;
        return (
            <Section label="Why it paused">
                <div style={{ fontSize: 13, color: 'rgba(251, 191, 36, 0.9)', lineHeight: 1.6 }}>
                    {reason || 'Ran but couldn\'t advance.'}
                </div>
            </Section>
        );
    }
    if (topic === 'dreaming:consolidated') {
        return (
            <Section label="What's happening">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    TITAN periodically consolidates recent memories — merging related facts, pruning stale ones, strengthening frequently-accessed associations. It's how it keeps the memory graph fast without losing useful context.
                </div>
            </Section>
        );
    }
    if (topic === 'daemon:started' || topic === 'daemon:resumed') {
        return (
            <Section label="What's happening">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    TITAN's background daemon came online. All watchers (goals, cron, health, memory, drive ticks, Facebook autopilot) are active.
                </div>
            </Section>
        );
    }
    if (topic === 'daemon:paused') {
        return (
            <Section label="What's happening">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    Background work is paused. Chat still works; cron, autopilot, and Soma ticks are halted until resumed.
                </div>
            </Section>
        );
    }
    if (topic.startsWith('health:')) {
        return (
            <Section label="Health alert">
                <div style={{ fontSize: 13, color: 'rgba(251, 191, 36, 0.9)', lineHeight: 1.6 }}>
                    A subsystem reported a health issue. Check the Console tab for diagnostics.
                </div>
            </Section>
        );
    }
    if (topic === 'agent:spawned' || topic === 'agent:stopped') {
        const name = raw.name as string | undefined;
        const model = raw.model as string | undefined;
        return (
            <Section label="What's happening">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    {topic === 'agent:spawned' ? 'Spawned' : 'Stopped'} sub-agent{name && <> <strong>{name}</strong></>}
                    {model && topic === 'agent:spawned' && <> running {model}</>}.
                </div>
            </Section>
        );
    }
    if (topic === 'agent:task:completed' || topic === 'agent:task:failed') {
        const agentId = raw.agentId as string | undefined;
        const reason = raw.reason as string | undefined;
        const success = raw.success as boolean | undefined;
        return (
            <Section label="Sub-agent result">
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6 }}>
                    {agentId && <>Sub-agent <strong>{agentId}</strong> </>}
                    {topic === 'agent:task:completed' && success !== false
                        ? 'finished its task successfully.'
                        : reason ? `couldn\'t complete: ${reason}.` : 'did not complete its task.'}
                </div>
            </Section>
        );
    }

    // Fallback: the old key/value renderer for unknown system topics
    return <GenericDetail raw={raw} />;
}

function GenericDetail({ raw }: { raw: Record<string, unknown> }) {
    const entries = Object.entries(raw || {}).filter(([k]) => k !== 'timestamp');
    if (entries.length === 0) return null;
    return (
        <Section label="Details">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {entries.slice(0, 8).map(([k, v]) => (
                    <div key={k} style={{
                        display: 'flex', justifyContent: 'space-between', gap: 12,
                        padding: '6px 10px', borderRadius: 6,
                        background: 'rgba(255,255,255,0.02)',
                        fontSize: 11,
                    }}>
                        <span style={{ color: 'rgba(255,255,255,0.4)' }}>{k}</span>
                        <span style={{
                            color: 'rgba(255,255,255,0.8)',
                            fontFamily: 'ui-monospace, monospace',
                            textAlign: 'right', wordBreak: 'break-all',
                        }}>{formatValue(v)}</span>
                    </div>
                ))}
            </div>
        </Section>
    );
}

function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v).slice(0, 80); } catch { return '[object]'; }
}

function Details({ label, raw }: { label: string; raw: Record<string, unknown> }) {
    const [open, setOpen] = useState(false);
    return (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <button
                onClick={() => setOpen(o => !o)}
                style={{
                    width: '100%', padding: '14px 24px',
                    background: 'transparent', border: 0,
                    color: 'rgba(255,255,255,0.5)', fontSize: 11,
                    textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600,
                    textAlign: 'left', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
            >
                <span>{label}</span>
                <span style={{ fontSize: 14 }}>{open ? '−' : '+'}</span>
            </button>
            {open && (
                <pre style={{
                    margin: 0, padding: '0 24px 20px',
                    fontSize: 10, lineHeight: 1.4,
                    color: 'rgba(255,255,255,0.5)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    maxHeight: 300, overflowY: 'auto',
                }}>
                    {JSON.stringify(raw, null, 2)}
                </pre>
            )}
        </div>
    );
}
