/**
 * TitanHome — the new front door (v7.0 "redo").
 *
 * The product re-founded on its core loop: ASK → DO → WATCH → KEEP → LEARN.
 * One screen: the warm desk, the mascot (the interface, not decoration), one
 * input, and live plain-English narration while the agent works. Replies land
 * as paper sheets on the desk; widget builds are announced and persist on the
 * canvas Desk. Everything else TITAN can do still exists — behind the
 * Workshop door, never in your face.
 *
 * Deliberately NOT a second chat app: no sidebars, no toolbars, no settings.
 * The session persists in localStorage so the relationship continues.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUp, Square, Wrench, LayoutGrid, Radio } from 'lucide-react';
import { streamMessage, apiFetch } from '@/api/client';
import type { StreamEvent } from '@/api/types';
import { TitanMascot, type MascotState } from '@/titan2/system/TitanMascot';

/** Plain-English narration for tool activity — no tool-name jargon. */
function humanizeTool(name?: string): string {
    switch (name) {
        case 'write_file': case 'edit_file': case 'apply_patch': return 'writing it down…';
        case 'read_file': case 'list_files': return 'reading through files…';
        case 'shell': case 'run_command': return 'running a command…';
        case 'web_search': case 'web_fetch': case 'web_browser': return 'looking it up on the web…';
        case 'gallery_search': case 'widget_gallery': return 'flipping through widget designs…';
        case 'create_widget': case 'update_widget': return 'building it onto your desk…';
        case 'weather': return 'checking the weather…';
        case 'memory_search': case 'memory_map': return 'remembering…';
        default: return name ? `working (${name.replace(/_/g, ' ')})…` : 'working…';
    }
}

interface Exchange { ask: string; reply: string; pending?: boolean }

function homeSessionId(): string {
    try {
        let id = localStorage.getItem('titan-home-session');
        if (!id) { id = `home-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem('titan-home-session', id); }
        return id;
    } catch { return 'home-default'; }
}

export default function TitanHome() {
    const navigate = useNavigate();
    const [input, setInput] = useState('');
    const [exchanges, setExchanges] = useState<Exchange[]>([]);
    const [busy, setBusy] = useState(false);
    const [narration, setNarration] = useState<string | null>(null);
    const [mascotState, setMascotState] = useState<MascotState>('idle');
    const [greeting, setGreeting] = useState<string | null>(null);
    const [deskNote, setDeskNote] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const sessionId = useRef(homeSessionId());

    // Welcome-back beat: greet by time of day, and reference work that finished
    // while you were away (recent completed missions) — memory as relationship.
    useEffect(() => {
        const hour = new Date().getHours();
        const hello = hour < 5 ? 'Burning the midnight oil?' : hour < 12 ? 'Morning.' : hour < 18 ? 'Afternoon.' : 'Evening.';
        setGreeting(`${hello} What are we building?`);
        apiFetch('/api/missions/recent?hours=48', { headers: { 'Content-Type': 'application/json' } })
            .then(r => r.json())
            .then(d => {
                const done = (d?.missions || []).filter((m: { phase: string }) => m.phase === 'done');
                if (done.length > 0) {
                    const t = String(done[0].title || '').slice(0, 60);
                    setGreeting(`${hello} While you were gone I finished “${t}”. Want to see, or are we building something new?`);
                }
            })
            .catch(() => { /* greeting stays generic */ });
        inputRef.current?.focus();
    }, []);

    const send = useCallback(() => {
        const ask = input.trim();
        if (!ask || busy) return;
        setInput('');
        setBusy(true);
        setMascotState('thinking');
        setNarration('thinking…');
        setExchanges(prev => [...prev.slice(-4), { ask, reply: '', pending: true }]);

        const ac = new AbortController();
        abortRef.current = ac;
        let acc = '';

        streamMessage(ask, sessionId.current, (e: StreamEvent) => {
            if (e.type === 'token') {
                acc += e.data;
                setMascotState('executing');
                setExchanges(prev => prev.map((x, i) => i === prev.length - 1 ? { ...x, reply: acc } : x));
            } else if (e.type === 'tool_start') {
                setMascotState('executing');
                setNarration(humanizeTool(e.toolName));
            } else if (e.type === 'tool_end') {
                setNarration(e.toolSuccess === false ? 'hmm, trying another way…' : 'done with that — continuing…');
            } else if (e.type === 'widget') {
                setDeskNote('✨ Added to your Desk');
            } else if (e.type === 'thinking') {
                setMascotState('thinking');
            } else if (e.type === 'done') {
                if (!acc && e.data) {
                    acc = e.data;
                    setExchanges(prev => prev.map((x, i) => i === prev.length - 1 ? { ...x, reply: acc } : x));
                }
            } else if (e.type === 'error') {
                setExchanges(prev => prev.map((x, i) => i === prev.length - 1 ? { ...x, reply: x.reply || `Something went wrong: ${e.errorMessage || e.data}. Try again?` } : x));
            }
        }, ac.signal).catch((err: Error) => {
            if (err?.name !== 'AbortError') {
                setExchanges(prev => prev.map((x, i) => i === prev.length - 1 ? { ...x, reply: x.reply || `I hit a snag: ${err.message}` } : x));
            }
        }).finally(() => {
            setBusy(false);
            setNarration(null);
            setMascotState('idle');
            setExchanges(prev => prev.map((x, i) => i === prev.length - 1 ? { ...x, pending: false } : x));
            inputRef.current?.focus();
        });
    }, [input, busy]);

    const stop = useCallback(() => { abortRef.current?.abort(); }, []);

    return (
        <div className="relative flex flex-col items-center min-h-full px-4 pt-10 pb-8" data-testid="titan-home">
            {/* The companion — center stage, alive, state-driven. */}
            <div className="flex flex-col items-center">
                {/* TitanMascot's internals are absolutely positioned — it must
                    sit inside a relative box of its own size or the bubble and
                    body escape to the page edges. */}
                <TitanMascot
                    className="relative"
                    state={mascotState}
                    size={132}
                    quip={busy ? narration : greeting}
                    bubblePhase="visible"
                    onClick={() => inputRef.current?.focus()}
                />
            </div>

            {/* The one input. */}
            <div className="w-full max-w-2xl mt-8">
                <div
                    className="flex items-center gap-2 rounded-2xl border px-4 py-3 shadow-lg"
                    style={{
                        background: 'var(--theme-paper, var(--color-bg-secondary))',
                        borderColor: 'var(--theme-metal, var(--color-border))',
                        boxShadow: '0 8px 28px var(--theme-shadow, rgba(0,0,0,0.35))',
                    }}
                >
                    <input
                        ref={inputRef}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') send(); }}
                        placeholder="Ask for anything — “make me a weather widget”, “research X and brief me”…"
                        className="flex-1 bg-transparent outline-none text-[15px]"
                        style={{ color: 'var(--theme-ink, var(--color-text))', fontFamily: 'var(--theme-font-display, inherit)' }}
                        aria-label="Ask TITAN"
                    />
                    {busy ? (
                        <button onClick={stop} aria-label="Stop" className="p-2 rounded-xl transition-colors" style={{ color: 'var(--theme-accent)' }}>
                            <Square size={18} />
                        </button>
                    ) : (
                        <button
                            onClick={send}
                            disabled={!input.trim()}
                            aria-label="Send"
                            className="p-2 rounded-xl disabled:opacity-35 transition-colors"
                            style={{ background: 'var(--theme-metal)', color: 'var(--theme-bolt, #201406)' }}
                        >
                            <ArrowUp size={18} />
                        </button>
                    )}
                </div>
                {deskNote && (
                    <button
                        onClick={() => navigate('/space/home')}
                        className="mt-2 text-xs underline underline-offset-2"
                        style={{ color: 'var(--theme-accent)' }}
                    >
                        {deskNote} — take a look
                    </button>
                )}
            </div>

            {/* Replies as paper sheets on the desk. */}
            <div className="w-full max-w-2xl mt-6 space-y-4">
                {[...exchanges].reverse().map((x, i) => (
                    <div
                        key={exchanges.length - 1 - i}
                        className="rounded-xl border px-5 py-4 shadow-md"
                        style={{
                            background: 'var(--theme-paper, var(--color-bg-secondary))',
                            borderColor: 'var(--theme-paper-line, var(--color-border))',
                            color: 'var(--theme-ink, var(--color-text))',
                        }}
                    >
                        <div className="text-[11px] mb-2 opacity-60" style={{ fontFamily: 'var(--theme-font-mono, monospace)' }}>you · {x.ask}</div>
                        <div className="text-[14px] leading-relaxed whitespace-pre-wrap" style={{ fontFamily: 'var(--theme-font-display, inherit)' }}>
                            {x.reply || (x.pending ? '…' : '')}
                        </div>
                    </div>
                ))}
            </div>

            {/* Quiet doors — small, bottom, out of the way. */}
            <div className="mt-auto pt-10 flex items-center gap-5 text-xs" style={{ color: 'var(--theme-ink-soft, var(--color-text-muted))' }}>
                <button onClick={() => navigate('/space/home')} className="flex items-center gap-1.5 hover:underline underline-offset-2"><LayoutGrid size={13} /> Desk</button>
                <button onClick={() => navigate('/studio')} className="flex items-center gap-1.5 hover:underline underline-offset-2"><Radio size={13} /> Studio</button>
                <button onClick={() => navigate('/system/settings')} className="flex items-center gap-1.5 hover:underline underline-offset-2"><Wrench size={13} /> Workshop</button>
            </div>
        </div>
    );
}
