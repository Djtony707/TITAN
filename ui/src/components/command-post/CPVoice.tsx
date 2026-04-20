/**
 * TITAN — Voice Ask panel (v4.10.0-local)
 *
 * Simple voice-first interaction surface. Types a question → POST to
 * /api/voice/ask → renders the response + (optional) TTS URL for
 * playback. Browser voice-to-text can use the Web Speech API; we add
 * a "listen" button that fills the input.
 *
 * LiveKit voice client integration is still separate; this panel is
 * the text-level wrapper around the voice endpoint so you can test the
 * driver-aware chat without a mic.
 */
import { useState, useEffect, useRef } from 'react';
import { Mic, Send, Volume2, StopCircle } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared';

async function postJSON(url: string, body: unknown): Promise<unknown> {
    const r = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

interface VoiceAnswer {
    answer: string;
    ttsUrl?: string;
    activeDrivers: number;
    sessionId?: string;
}

interface Exchange {
    id: string;
    question: string;
    answer?: string;
    activeDrivers?: number;
    ttsUrl?: string;
    loading: boolean;
    error?: string;
    at: string;
}

// Web Speech API types (loose, browser-dependent)
interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: (ev: { results: { [index: number]: { [inner: number]: { transcript: string } } } }) => void;
    onerror: (ev: unknown) => void;
    onend: () => void;
    start: () => void;
    stop: () => void;
}
declare global {
    interface Window {
        SpeechRecognition?: new () => SpeechRecognitionLike;
        webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }
}

export default function CPVoice() {
    const [input, setInput] = useState('');
    const [exchanges, setExchanges] = useState<Exchange[]>([]);
    const [listening, setListening] = useState(false);
    const [speakEnabled, setSpeakEnabled] = useState(true);
    const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (Ctor) {
            const rec = new Ctor();
            rec.lang = 'en-US';
            rec.continuous = false;
            rec.interimResults = false;
            rec.onresult = (ev) => {
                const transcript = ev.results[0]?.[0]?.transcript || '';
                setInput(transcript);
                setListening(false);
            };
            rec.onerror = () => setListening(false);
            rec.onend = () => setListening(false);
            recognitionRef.current = rec;
        }
    }, []);

    const ask = async () => {
        const q = input.trim();
        if (!q) return;
        const exchange: Exchange = {
            id: `e-${Date.now()}`,
            question: q,
            loading: true,
            at: new Date().toISOString(),
        };
        setExchanges(prev => [exchange, ...prev].slice(0, 20));
        setInput('');
        try {
            const res = await postJSON('/api/voice/ask', {
                question: q,
                voice: 'default',
                speak: speakEnabled,
            }) as VoiceAnswer;
            setExchanges(prev => prev.map(e => e.id === exchange.id
                ? { ...e, loading: false, answer: res.answer, activeDrivers: res.activeDrivers, ttsUrl: res.ttsUrl }
                : e));
            if (res.ttsUrl && speakEnabled && audioRef.current) {
                audioRef.current.src = res.ttsUrl;
                audioRef.current.play().catch(() => { /* autoplay blocked */ });
            }
        } catch (err) {
            setExchanges(prev => prev.map(e => e.id === exchange.id
                ? { ...e, loading: false, error: (err as Error).message }
                : e));
        }
    };

    const startListening = () => {
        const rec = recognitionRef.current;
        if (!rec) { alert('Speech recognition not supported in this browser. Use Chrome.'); return; }
        try { rec.start(); setListening(true); } catch { /* already running */ }
    };
    const stopListening = () => {
        const rec = recognitionRef.current;
        if (rec) rec.stop();
        setListening(false);
    };

    const hasSpeech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

    return (
        <div className="space-y-4 flex flex-col h-[calc(100vh-180px)]">
            <PageHeader
                title="Voice Ask"
                breadcrumbs={[{ label: 'Command Post' }, { label: 'Voice' }]}
            />

            <audio ref={audioRef} />

            {/* Input bar at top */}
            <div className="flex items-center gap-2 bg-bg-secondary border border-border rounded-xl px-3 py-2">
                {hasSpeech && (
                    listening ? (
                        <button
                            onClick={stopListening}
                            className="p-2 rounded bg-error/20 text-error hover:bg-error/30"
                            title="Stop listening"
                        >
                            <StopCircle size={18} />
                        </button>
                    ) : (
                        <button
                            onClick={startListening}
                            className="p-2 rounded hover:bg-bg-tertiary text-text-muted"
                            title="Voice input (Chrome only)"
                        >
                            <Mic size={18} />
                        </button>
                    )
                )}
                <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
                    placeholder={listening ? 'Listening…' : 'Ask TITAN — "What are you working on?" or give it instructions'}
                    className="flex-1 bg-transparent text-sm outline-none"
                />
                <button
                    onClick={() => setSpeakEnabled(v => !v)}
                    className={`p-2 rounded hover:bg-bg-tertiary ${speakEnabled ? 'text-accent' : 'text-text-muted'}`}
                    title={`TTS ${speakEnabled ? 'ON' : 'OFF'}`}
                >
                    <Volume2 size={16} />
                </button>
                <button
                    onClick={ask}
                    disabled={!input.trim()}
                    className="px-3 py-1.5 rounded bg-accent/20 border border-accent/40 text-accent text-sm hover:bg-accent/30 disabled:opacity-50 flex items-center gap-1"
                >
                    <Send size={14} /> Ask
                </button>
            </div>

            {/* Exchange history */}
            <div className="flex-1 overflow-auto space-y-3">
                {exchanges.length === 0 && (
                    <div className="text-center py-12 text-text-muted text-sm">
                        Ask a question to start. TITAN has driver-aware chat, so "what are you doing?" gets a real answer.
                    </div>
                )}
                {exchanges.map(ex => (
                    <div key={ex.id} className="space-y-1.5">
                        <div className="flex items-start gap-2">
                            <span className="text-xs text-text-muted mt-1 flex-shrink-0 w-10">You</span>
                            <div className="text-sm text-text">{ex.question}</div>
                        </div>
                        <div className="flex items-start gap-2">
                            <span className="text-xs text-accent mt-1 flex-shrink-0 w-10">TITAN</span>
                            <div className="text-sm text-text-secondary flex-1">
                                {ex.loading && <span className="text-text-muted">thinking…</span>}
                                {ex.error && <span className="text-error">error: {ex.error}</span>}
                                {ex.answer && (
                                    <div className="space-y-1">
                                        <div className="whitespace-pre-wrap">{ex.answer}</div>
                                        <div className="text-[11px] text-text-muted flex items-center gap-2">
                                            <span>drivers: {ex.activeDrivers ?? '?'}</span>
                                            {ex.ttsUrl && (
                                                <button
                                                    onClick={() => {
                                                        if (audioRef.current) {
                                                            audioRef.current.src = ex.ttsUrl!;
                                                            audioRef.current.play().catch(() => {});
                                                        }
                                                    }}
                                                    className="text-accent hover:underline flex items-center gap-0.5"
                                                >
                                                    <Volume2 size={10} /> play
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
