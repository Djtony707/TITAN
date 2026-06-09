/**
 * HomeHeroWidget — the "ask for anything" surface, as a canvas widget.
 *
 * v7.0 redo: home is no longer a fixed page — it's the canvas, and the ask
 * input is itself a widget you can move, resize, or remove like everything
 * else. The mascot (FreeMascot, loose on the desk) narrates the work via the
 * titan:mascot:* window events; replies land as paper sheets inside the
 * widget; widget builds appear directly on the surrounding canvas.
 */
import { useState, useRef, useCallback } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { streamMessage } from '@/api/client';
import type { StreamEvent } from '@/api/types';

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

function say(quip: string | null, state: 'idle' | 'thinking' | 'executing') {
    window.dispatchEvent(new CustomEvent('titan:mascot:say', { detail: { quip, state } }));
}

interface Exchange { ask: string; reply: string; pending?: boolean }

function heroSessionId(): string {
    try {
        let id = localStorage.getItem('titan-home-session');
        if (!id) { id = `home-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem('titan-home-session', id); }
        return id;
    } catch { return 'home-default'; }
}

export function HomeHeroWidget() {
    const [input, setInput] = useState('');
    const [exchanges, setExchanges] = useState<Exchange[]>([]);
    const [busy, setBusy] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const sessionId = useRef(heroSessionId());

    const send = useCallback(() => {
        const ask = input.trim();
        if (!ask || busy) return;
        setInput('');
        setBusy(true);
        say('thinking…', 'thinking');
        setExchanges(prev => [...prev.slice(-3), { ask, reply: '', pending: true }]);

        const ac = new AbortController();
        abortRef.current = ac;
        let acc = '';

        streamMessage(ask, sessionId.current, (e: StreamEvent) => {
            if (e.type === 'token') {
                acc += e.data;
                setExchanges(prev => prev.map((x, i) => i === prev.length - 1 ? { ...x, reply: acc } : x));
            } else if (e.type === 'tool_start') {
                say(humanizeTool(e.toolName), 'executing');
            } else if (e.type === 'tool_end') {
                say(e.toolSuccess === false ? 'hmm, trying another way…' : 'done with that — continuing…', 'executing');
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
            setExchanges(prev => prev.map((x, i) => i === prev.length - 1 ? { ...x, pending: false } : x));
            window.dispatchEvent(new CustomEvent('titan:mascot:celebrate'));
            inputRef.current?.focus();
        });
    }, [input, busy]);

    return (
        <div className="flex flex-col h-full p-3 gap-3 overflow-hidden">
            <div
                className="flex items-center gap-2 rounded-xl border px-3 py-2.5 shadow-sm shrink-0"
                style={{
                    background: 'var(--theme-paper, var(--color-bg-secondary))',
                    borderColor: 'var(--theme-metal, var(--color-border))',
                }}
            >
                <input
                    ref={inputRef}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') send(); }}
                    placeholder="Ask for anything — “make me a weather widget”, “research X and brief me”…"
                    className="flex-1 bg-transparent outline-none text-[14px]"
                    style={{ color: 'var(--theme-ink, var(--color-text))', fontFamily: 'var(--theme-font-display, inherit)' }}
                    aria-label="Ask TITAN"
                />
                {busy ? (
                    <button onClick={() => abortRef.current?.abort()} aria-label="Stop" className="p-1.5 rounded-lg" style={{ color: 'var(--theme-accent)' }}>
                        <Square size={16} />
                    </button>
                ) : (
                    <button
                        onClick={send}
                        disabled={!input.trim()}
                        aria-label="Send"
                        className="p-1.5 rounded-lg disabled:opacity-35"
                        style={{ background: 'var(--theme-metal)', color: 'var(--theme-bolt, #201406)' }}
                    >
                        <ArrowUp size={16} />
                    </button>
                )}
            </div>

            <div className="flex-1 overflow-auto space-y-2.5 min-h-0">
                {exchanges.length === 0 && (
                    <p className="text-xs opacity-60 px-1" style={{ color: 'var(--theme-ink-soft, var(--color-text-muted))' }}>
                        Whatever I build lands on this desk — and stays.
                    </p>
                )}
                {[...exchanges].reverse().map((x, i) => (
                    <div
                        key={exchanges.length - 1 - i}
                        className="rounded-lg border px-3.5 py-2.5 shadow-sm"
                        style={{
                            background: 'var(--theme-paper, var(--color-bg-secondary))',
                            borderColor: 'var(--theme-paper-line, var(--color-border))',
                            color: 'var(--theme-ink, var(--color-text))',
                        }}
                    >
                        <div className="text-[10px] mb-1 opacity-60" style={{ fontFamily: 'var(--theme-font-mono, monospace)' }}>you · {x.ask}</div>
                        <div className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ fontFamily: 'var(--theme-font-display, inherit)' }}>
                            {x.reply || (x.pending ? '…' : '')}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
