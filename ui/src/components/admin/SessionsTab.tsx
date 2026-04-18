/**
 * TITAN — Internal Sessions Tab (v4.6.0)
 *
 * Shows the sessions Tony isn't supposed to see mixed into his chat
 * view — autopilot runs, initiative-verify, deliberation, agent-to-agent,
 * API callers. Each is a snapshot of an autonomous TITAN thought-train.
 *
 * Grouped by channel. Click a session to see its message transcript.
 *
 * Filter chips at top let Tony narrow by channel kind.
 */
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { apiFetch } from '@/api/client';

/**
 * Channels that are INTERNAL — TITAN talking to itself / via tooling.
 * Matches anything beginning with these prefixes so new channel variants
 * (initiative-fix, initiative-verify, etc.) don't slip past the filter.
 */
const INTERNAL_CHANNEL_PREFIXES = [
    'initiative',
    'deliberation',
    'autopilot',
    'agent-',
    'company-',
    'swarm',
    'subagent',
    'plan-',
];

/** Channels that are Tony-facing user chats */
const USER_CHANNEL_PREFIXES = [
    'webchat',
    'messenger-admin',
    'messenger',
    'twilio-admin',
    'twilio',
    'livekit',
    'api', // API callers — borderline, keep for now
];

function isInternalChannel(channel: string): boolean {
    return INTERNAL_CHANNEL_PREFIXES.some(p => channel === p || channel.startsWith(p));
}

function isUserChannel(channel: string): boolean {
    return USER_CHANNEL_PREFIXES.some(p => channel === p || channel.startsWith(p));
}

interface SessionSummary {
    id: string;
    channel: string;
    userId: string;
    agentId: string;
    status: string;
    messageCount: number;
    createdAt: string;
    lastActive: string;
    name?: string;
    lastMessage?: string;
}

export default function SessionsTab() {
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [channelFilter, setChannelFilter] = useState<string>('internal');
    const [selected, setSelected] = useState<SessionSummary | null>(null);

    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const res = await apiFetch('/api/sessions');
                if (!res.ok) return;
                const data = await res.json();
                if (!active) return;
                setSessions(Array.isArray(data) ? data : []);
                setLoading(false);
            } catch { /* transient */ }
        };
        load();
        const id = setInterval(load, 15_000);
        return () => { active = false; clearInterval(id); };
    }, []);

    const filtered = useMemo(() => {
        let list = sessions;
        if (channelFilter === 'internal') list = list.filter(s => isInternalChannel(s.channel));
        else if (channelFilter === 'user') list = list.filter(s => isUserChannel(s.channel));
        else if (channelFilter !== 'all') list = list.filter(s => s.channel === channelFilter);
        return list.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''));
    }, [sessions, channelFilter]);

    const grouped = useMemo(() => {
        const groups = new Map<string, SessionSummary[]>();
        for (const s of filtered) {
            const list = groups.get(s.channel) || [];
            list.push(s);
            groups.set(s.channel, list);
        }
        return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }, [filtered]);

    const totalInternal = sessions.filter(s => isInternalChannel(s.channel)).length;
    const totalUser = sessions.filter(s => isUserChannel(s.channel)).length;

    return (
        <div className="space-y-4">
            <div>
                <div className="text-[11px] text-white/40 mb-2">
                    Internal sessions are TITAN's background thought-trains: autopilot runs, deliberation plans, sub-agent delegations. You wouldn't normally see these in chat.
                </div>
                <div className="flex flex-wrap gap-1.5">
                    <FilterChip active={channelFilter === 'internal'} onClick={() => setChannelFilter('internal')}>
                        Internal <span className="text-white/30 ml-1">({totalInternal})</span>
                    </FilterChip>
                    <FilterChip active={channelFilter === 'user'} onClick={() => setChannelFilter('user')}>
                        User chats <span className="text-white/30 ml-1">({totalUser})</span>
                    </FilterChip>
                    <FilterChip active={channelFilter === 'all'} onClick={() => setChannelFilter('all')}>
                        All <span className="text-white/30 ml-1">({sessions.length})</span>
                    </FilterChip>
                </div>
            </div>

            {loading ? (
                <div className="p-6 text-center text-[12px] text-white/40">Loading sessions…</div>
            ) : filtered.length === 0 ? (
                <div className="p-8 text-center text-[12px] text-white/40 bg-white/[0.015] border border-white/[0.06] rounded-xl">
                    No sessions in this filter.
                </div>
            ) : (
                <div className="space-y-4">
                    {grouped.map(([channel, group]) => (
                        <div key={channel} className="bg-white/[0.015] border border-white/[0.06] rounded-xl overflow-hidden">
                            <div className="px-4 py-2.5 flex items-center justify-between border-b border-white/[0.04]">
                                <div className="flex items-center gap-2">
                                    <span className="text-[12px] text-white/70 font-medium">{channel}</span>
                                    <span className="text-[10px] text-white/30">{group.length}</span>
                                </div>
                                <span className="text-[10px] text-white/25 uppercase tracking-wider">
                                    {isInternalChannel(channel) ? 'internal' : isUserChannel(channel) ? 'user' : 'other'}
                                </span>
                            </div>
                            <div className="divide-y divide-white/[0.03]">
                                {group.slice(0, 8).map(s => (
                                    <div
                                        key={s.id}
                                        onClick={() => setSelected(s)}
                                        className="px-4 py-2.5 flex items-start gap-3 hover:bg-white/[0.03] cursor-pointer"
                                    >
                                        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${s.status === 'active' ? 'bg-emerald-400' : 'bg-white/20'}`} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[12px] text-white/80 truncate">
                                                {s.name || s.lastMessage?.slice(0, 80) || '(untitled)'}
                                            </div>
                                            <div className="text-[10px] text-white/35 mt-0.5">
                                                {s.messageCount} msg · {timeAgoShort(s.lastActive)} · {s.userId}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                {group.length > 8 && (
                                    <div className="px-4 py-2 text-[10px] text-white/25 italic">
                                        + {group.length - 8} more {channel} session{group.length - 8 === 1 ? '' : 's'}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <SessionDetailPanel
                open={selected !== null}
                session={selected}
                onClose={() => setSelected(null)}
            />
        </div>
    );
}

// ── Chips

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={`px-3 py-1 text-[11px] rounded-lg transition-colors ${
                active
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white/[0.04] text-white/50 hover:text-white/80'
            }`}
        >{children}</button>
    );
}

// ── Detail panel — session message transcript

function SessionDetailPanel({ open, session, onClose }: { open: boolean; session: SessionSummary | null; onClose: () => void }) {
    const [messages, setMessages] = useState<Array<{ role: string; content: string; timestamp?: string }>>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open || !session) { setMessages([]); return; }
        setLoading(true);
        apiFetch(`/api/sessions/${session.id}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                const msgs = Array.isArray(data) ? data : (data?.messages || []);
                setMessages(msgs);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [open, session]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    return (
        <AnimatePresence>
            {open && session && (
                <>
                    <motion.div
                        key="backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        onClick={onClose}
                        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', zIndex: 99 }}
                    />
                    <motion.aside
                        key="panel"
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
                        style={{
                            position: 'fixed', top: 0, right: 0, bottom: 0,
                            width: 'min(600px, 100vw)',
                            background: 'rgba(10, 12, 20, 0.96)',
                            backdropFilter: 'blur(24px)',
                            borderLeft: '1px solid rgba(167, 139, 250, 0.15)',
                            zIndex: 100,
                            display: 'flex', flexDirection: 'column',
                            boxShadow: '-20px 0 60px rgba(0,0,0,0.5)',
                        }}
                    >
                        <div className="px-6 py-4 border-b border-white/[0.06] flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                                <div className="text-[11px] uppercase tracking-wider text-white/40 font-semibold mb-1">
                                    {session.channel}
                                </div>
                                <div className="text-[16px] font-semibold text-white/95 truncate">
                                    {session.name || '(untitled session)'}
                                </div>
                                <div className="text-[11px] text-white/35 mt-1">
                                    {session.messageCount} messages · {timeAgoShort(session.lastActive)}
                                </div>
                            </div>
                            <button onClick={onClose} className="text-white/55 hover:text-white/90 p-1.5 rounded" aria-label="Close">
                                <X size={18} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
                            {loading && <div className="text-[12px] text-white/35">Loading transcript…</div>}
                            {!loading && messages.length === 0 && (
                                <div className="text-[12px] text-white/35 italic">No messages.</div>
                            )}
                            {messages.map((m, i) => (
                                <div key={i} className={`p-3 rounded-lg border-l-2 ${
                                    m.role === 'assistant'
                                        ? 'bg-purple-500/[0.03] border-purple-400/50'
                                        : m.role === 'user'
                                            ? 'bg-white/[0.03] border-white/20'
                                            : 'bg-white/[0.015] border-white/10'
                                }`}>
                                    <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mb-1">
                                        {m.role}
                                    </div>
                                    <div className="text-[12px] text-white/85 whitespace-pre-wrap leading-relaxed" style={{ wordBreak: 'break-word' }}>
                                        {(m.content || '').slice(0, 2000)}
                                        {(m.content || '').length > 2000 && <span className="text-white/30">… (truncated)</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    );
}

function timeAgoShort(ts?: string): string {
    if (!ts) return '';
    const t = Date.parse(ts);
    if (isNaN(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

// ── Exported helpers (used by MissionView to filter its own drawer)

export { isInternalChannel, isUserChannel, INTERNAL_CHANNEL_PREFIXES, USER_CHANNEL_PREFIXES };
