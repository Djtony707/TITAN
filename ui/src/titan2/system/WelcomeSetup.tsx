/**
 * WelcomeSetup — first-run overlay (v7.0 Welcome Mode).
 *
 * Shown only when the gateway reports providerReady=false (no usable AI
 * model). One-click connect when Ollama is detected; otherwise paste a key
 * or an OpenAI-compatible endpoint. Dismissible — the desk is explorable
 * without a model, and chat answers with setup guidance until connected.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface OnboardingState {
    providerReady: boolean;
    configuredModel: string;
    ollama: { detected: boolean; baseUrl: string; models: string[] };
}

type Tab = 'ollama' | 'cloud' | 'compat';

const card: React.CSSProperties = {
    background: 'var(--theme-paper, var(--color-bg-secondary))',
    borderColor: 'var(--theme-metal, var(--color-border))',
    color: 'var(--theme-ink, var(--color-text))',
};

const inputStyle: React.CSSProperties = {
    background: 'transparent',
    borderColor: 'var(--theme-metal, var(--color-border))',
    color: 'var(--theme-ink, var(--color-text))',
};

export default function WelcomeSetup() {
    const [state, setState] = useState<OnboardingState | null>(null);
    const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('titan-welcome-dismissed') === '1');
    const [tab, setTab] = useState<Tab>('ollama');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [connected, setConnected] = useState(false);
    const [ollamaModel, setOllamaModel] = useState('');
    const [cloudProvider, setCloudProvider] = useState<'anthropic' | 'openai'>('anthropic');
    const [cloudKey, setCloudKey] = useState('');
    const [compatUrl, setCompatUrl] = useState('');
    const [compatKey, setCompatKey] = useState('');
    const [compatModel, setCompatModel] = useState('');
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const refresh = useCallback(async () => {
        try {
            const res = await fetch('/api/onboarding/state');
            if (!res.ok) return;
            const s = await res.json() as OnboardingState;
            setState(s);
            if (s.ollama.detected && s.ollama.models.length > 0) {
                setOllamaModel(prev => prev || s.ollama.models[0]);
            } else if (!s.ollama.detected) {
                setTab(prev => (prev === 'ollama' ? 'cloud' : prev));
            }
        } catch { /* gateway briefly unavailable — poll again */ }
    }, []);

    useEffect(() => {
        refresh();
        pollRef.current = setInterval(refresh, 6000);
        return () => { if (pollRef.current) clearInterval(pollRef.current); };
    }, [refresh]);

    const configure = async (body: Record<string, string>) => {
        setBusy(true);
        setError('');
        try {
            const res = await fetch('/api/onboarding/configure', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json() as { ok: boolean; details: string };
            if (data.ok) {
                setConnected(true);
                window.dispatchEvent(new CustomEvent('titan:fireworks'));
                setTimeout(() => setState(s => (s ? { ...s, providerReady: true } : s)), 1600);
            } else {
                setError(data.details || 'That didn’t work — double-check and try again.');
            }
        } catch {
            setError('Could not reach the gateway. Is it still running?');
        } finally {
            setBusy(false);
        }
    };

    if (!state || state.providerReady || dismissed) return null;

    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4" style={{ background: 'rgba(10, 10, 14, 0.55)', backdropFilter: 'blur(3px)' }}>
            <div className="w-full max-w-md rounded-2xl border shadow-2xl p-6" style={card} data-testid="welcome-setup">
                {connected ? (
                    <div className="text-center py-8">
                        <div className="text-4xl mb-3">🎉</div>
                        <div className="text-lg font-semibold mb-1">Connected!</div>
                        <div className="text-sm opacity-70">Say hi — TITAN is listening.</div>
                    </div>
                ) : (
                    <>
                        <div className="flex items-center gap-3 mb-1">
                            <span className="text-3xl">👋</span>
                            <h2 className="text-xl font-semibold" style={{ fontFamily: 'var(--theme-font-display, inherit)' }}>Welcome to TITAN</h2>
                        </div>
                        <p className="text-sm opacity-70 mb-4">Connect an AI model and your desk comes alive. This takes about a minute.</p>

                        <div className="flex gap-1.5 mb-4">
                            {state.ollama.detected && (
                                <button onClick={() => setTab('ollama')} className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${tab === 'ollama' ? '' : 'opacity-50'}`} style={{ borderColor: 'var(--theme-metal)', color: tab === 'ollama' ? 'var(--theme-accent)' : undefined }}>
                                    Ollama (free, local)
                                </button>
                            )}
                            <button onClick={() => setTab('cloud')} className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${tab === 'cloud' ? '' : 'opacity-50'}`} style={{ borderColor: 'var(--theme-metal)', color: tab === 'cloud' ? 'var(--theme-accent)' : undefined }}>
                                API key
                            </button>
                            <button onClick={() => setTab('compat')} className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${tab === 'compat' ? '' : 'opacity-50'}`} style={{ borderColor: 'var(--theme-metal)', color: tab === 'compat' ? 'var(--theme-accent)' : undefined }}>
                                Custom endpoint
                            </button>
                        </div>

                        {tab === 'ollama' && state.ollama.detected && (
                            <div className="space-y-3">
                                <div className="text-sm">✅ Ollama is running{state.ollama.models.length > 0 ? ' — pick a model:' : ', but no models are installed yet.'}</div>
                                {state.ollama.models.length > 0 ? (
                                    <>
                                        <select value={ollamaModel} onChange={e => setOllamaModel(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm" style={inputStyle}>
                                            {state.ollama.models.map(m => <option key={m} value={m}>{m}</option>)}
                                        </select>
                                        <button disabled={busy} onClick={() => configure({ kind: 'ollama', model: ollamaModel })} className="w-full rounded-lg px-3 py-2.5 text-sm font-semibold border disabled:opacity-50" style={{ background: 'var(--theme-accent)', color: 'var(--theme-paper, #fff)', borderColor: 'var(--theme-accent)' }}>
                                            {busy ? 'Connecting…' : `Use ${ollamaModel}`}
                                        </button>
                                    </>
                                ) : (
                                    <div className="text-xs opacity-70 rounded-lg border p-3" style={inputStyle}>
                                        Run <code className="font-mono">ollama pull qwen3.5</code> in a terminal, then come back — I check every few seconds.
                                    </div>
                                )}
                            </div>
                        )}

                        {tab === 'cloud' && (
                            <div className="space-y-3">
                                <select value={cloudProvider} onChange={e => setCloudProvider(e.target.value as 'anthropic' | 'openai')} className="w-full rounded-lg border px-3 py-2 text-sm" style={inputStyle}>
                                    <option value="anthropic">Anthropic (Claude)</option>
                                    <option value="openai">OpenAI (GPT)</option>
                                </select>
                                <input type="password" value={cloudKey} onChange={e => setCloudKey(e.target.value)} placeholder={cloudProvider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} className="w-full rounded-lg border px-3 py-2 text-sm font-mono" style={inputStyle} />
                                <button disabled={busy || !cloudKey.trim()} onClick={() => configure({ kind: cloudProvider, apiKey: cloudKey })} className="w-full rounded-lg px-3 py-2.5 text-sm font-semibold border disabled:opacity-50" style={{ background: 'var(--theme-accent)', color: 'var(--theme-paper, #fff)', borderColor: 'var(--theme-accent)' }}>
                                    {busy ? 'Connecting…' : 'Connect'}
                                </button>
                                <div className="text-[11px] opacity-60">Your key is stored locally in TITAN’s config on this machine — nowhere else.</div>
                            </div>
                        )}

                        {tab === 'compat' && (
                            <div className="space-y-3">
                                <input value={compatUrl} onChange={e => setCompatUrl(e.target.value)} placeholder="Base URL, e.g. http://192.168.1.11:4000/v1" className="w-full rounded-lg border px-3 py-2 text-sm font-mono" style={inputStyle} />
                                <input type="password" value={compatKey} onChange={e => setCompatKey(e.target.value)} placeholder="API key (optional)" className="w-full rounded-lg border px-3 py-2 text-sm font-mono" style={inputStyle} />
                                <input value={compatModel} onChange={e => setCompatModel(e.target.value)} placeholder="Model id, e.g. qwen3-30b-a3b" className="w-full rounded-lg border px-3 py-2 text-sm font-mono" style={inputStyle} />
                                <button disabled={busy || !compatUrl.trim() || !compatModel.trim()} onClick={() => configure({ kind: 'openai_compat', baseUrl: compatUrl, apiKey: compatKey, model: compatModel })} className="w-full rounded-lg px-3 py-2.5 text-sm font-semibold border disabled:opacity-50" style={{ background: 'var(--theme-accent)', color: 'var(--theme-paper, #fff)', borderColor: 'var(--theme-accent)' }}>
                                    {busy ? 'Connecting…' : 'Connect'}
                                </button>
                                <div className="text-[11px] opacity-60">Works with LiteLLM, vLLM, LM Studio, llama.cpp — anything OpenAI-compatible.</div>
                            </div>
                        )}

                        {!state.ollama.detected && tab !== 'ollama' && (
                            <div className="text-[11px] opacity-60 mt-3">
                                Prefer free + local? <a href="https://ollama.com" target="_blank" rel="noreferrer" className="underline">Install Ollama</a> and I’ll detect it automatically.
                            </div>
                        )}

                        {error && <div className="text-xs mt-3 rounded-lg border px-3 py-2" style={{ borderColor: '#b4453a', color: '#d4766c' }}>{error}</div>}

                        <button onClick={() => { sessionStorage.setItem('titan-welcome-dismissed', '1'); setDismissed(true); }} className="w-full text-center text-xs opacity-50 hover:opacity-80 mt-4">
                            Explore the desk first →
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
