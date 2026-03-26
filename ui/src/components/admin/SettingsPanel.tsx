import { useEffect, useState, useMemo } from 'react';
import { Save, CheckCircle, AlertCircle, Monitor, Cloud, Mic, RefreshCw, Wifi, WifiOff, Download, Loader2, Square, Play } from 'lucide-react';
import { getConfig, updateConfig, getModels, switchModel, getOrpheusStatus, startOrpheus, stopOrpheus } from '@/api/client';
import type { ModelInfo } from '@/api/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawConfig = Record<string, any>;

const LOCAL_PROVIDERS = ['ollama', 'lmstudio', 'localai'];

interface VoiceHealth {
  livekit: boolean;
  stt: boolean;
  tts: boolean;
  agent: boolean;
  overall: boolean;
  ttsEngine?: string;
}

interface VoiceStatus {
  available: boolean;
  livekitUrl?: string;
  ttsVoice?: string;
  reason?: string;
}

function StatusDot({ ok }: { ok: boolean }) {
  return ok ? (
    <div className="h-2 w-2 rounded-full bg-[#22c55e] shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
  ) : (
    <div className="h-2 w-2 rounded-full bg-[#52525b]" />
  );
}

function ModelSelector({
  models,
  selectedModel,
  onSelect,
  onSwitch,
  currentModel,
}: {
  models: ModelInfo[];
  selectedModel: string;
  onSelect: (id: string) => void;
  onSwitch: () => void;
  currentModel: string;
}) {
  const currentProvider = currentModel.includes('/') ? currentModel.split('/')[0] : '';
  const [selectedProvider, setSelectedProvider] = useState(currentProvider);

  const providers = useMemo(() => {
    const set = new Set(models.map((m) => m.provider));
    return [...set].sort((a, b) => {
      const aLocal = LOCAL_PROVIDERS.includes(a.toLowerCase());
      const bLocal = LOCAL_PROVIDERS.includes(b.toLowerCase());
      if (aLocal && !bLocal) return -1;
      if (!aLocal && bLocal) return 1;
      return a.localeCompare(b);
    });
  }, [models]);

  const providerModels = useMemo(
    () => models.filter((m) => m.provider === selectedProvider),
    [models, selectedProvider],
  );

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    const modelsInProvider = models.filter((m) => m.provider === provider);
    const currentInProvider = modelsInProvider.find((m) => m.id === currentModel);
    if (currentInProvider) {
      onSelect(currentInProvider.id);
    } else if (modelsInProvider.length > 0) {
      onSelect(modelsInProvider[0].id);
    }
  };

  const isChanged = selectedModel !== currentModel;
  const isLocal = LOCAL_PROVIDERS.includes(selectedProvider.toLowerCase());

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-xs text-[#71717a]">Provider</label>
        <div className="flex items-center gap-2">
          <select
            value={selectedProvider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-full rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2.5 text-sm text-[#fafafa] outline-none transition-colors focus:border-[#6366f1]"
          >
            {providers.map((p) => {
              const pLocal = LOCAL_PROVIDERS.includes(p.toLowerCase());
              const count = models.filter((m) => m.provider === p).length;
              return (
                <option key={p} value={p}>
                  {pLocal ? `\u{1F4BB} ${p} (local)` : p} — {count} model{count !== 1 ? 's' : ''}
                </option>
              );
            })}
          </select>
          {isLocal && (
            <span className="flex items-center gap-1 whitespace-nowrap rounded bg-[#22c55e]/15 px-2 py-1 text-xs font-medium text-[#22c55e]">
              <Monitor className="h-3 w-3" /> Local
            </span>
          )}
          {!isLocal && selectedProvider && (
            <span className="flex items-center gap-1 whitespace-nowrap rounded bg-[#6366f1]/15 px-2 py-1 text-xs font-medium text-[#818cf8]">
              <Cloud className="h-3 w-3" /> Cloud
            </span>
          )}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs text-[#71717a]">Model</label>
        <div className="flex items-end gap-3">
          <select
            value={selectedModel}
            onChange={(e) => onSelect(e.target.value)}
            className="w-full rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2.5 text-sm text-[#fafafa] outline-none transition-colors focus:border-[#6366f1]"
          >
            {providerModels.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.available}>
                {m.name}{m.id === currentModel ? ' (active)' : ''}{!m.available ? ' — unavailable' : ''}
              </option>
            ))}
            {providerModels.length === 0 && (
              <option disabled>No models for this provider</option>
            )}
          </select>
          <button
            onClick={onSwitch}
            disabled={!isChanged}
            className="rounded-lg bg-[#6366f1] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#6366f1]/80 disabled:opacity-50"
          >
            Switch
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2">
        <div className="h-2 w-2 rounded-full bg-[#22c55e] animate-pulse" />
        <span className="text-xs text-[#71717a]">Active:</span>
        <span className="text-xs text-[#a1a1aa] font-mono">{currentModel || 'None'}</span>
      </div>
    </div>
  );
}

function SettingsPanel() {
  const [config, setConfig] = useState<RawConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Voice form state
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [livekitUrl, setLivekitUrl] = useState('');
  const [ttsVoice, setTtsVoice] = useState('tara');
  const [ttsEngine, setTtsEngine] = useState('orpheus');
  const [ttsUrl, setTtsUrl] = useState('http://localhost:5005');
  const [orpheusVoices, setOrpheusVoices] = useState<string[]>(['tara', 'leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac']);

  // Orpheus TTS management state
  const [orpheusStatus, setOrpheusStatus] = useState<{ installed: boolean; running: boolean } | null>(null);
  const [orpheusInstalling, setOrpheusInstalling] = useState(false);
  const [orpheusProgress, setOrpheusProgress] = useState<string>('');

  const TTS_ENGINES = [
    { id: 'orpheus', name: 'Orpheus TTS', desc: 'GPU-accelerated emotional speech', defaultUrl: 'http://localhost:5005', defaultVoices: ['tara', 'leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac'] },
    { id: 'browser', name: 'Browser TTS', desc: 'Built-in, no server needed', defaultUrl: '', defaultVoices: [] },
  ];

  // Voice auto-discovery state
  const [voiceHealth, setVoiceHealth] = useState<VoiceHealth | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [checkingVoice, setCheckingVoice] = useState(false);

  const getModel = (cfg: RawConfig) => cfg?.agent?.model ?? cfg?.model ?? '';

  useEffect(() => {
    const load = async () => {
      try {
        const [cfg, mdls] = await Promise.all([getConfig(), getModels()]);
        setConfig(cfg);
        setModels(mdls);
        setSelectedModel(getModel(cfg));
        const voice = cfg?.voice ?? {};
        setVoiceEnabled(voice.enabled ?? false);
        setLivekitUrl(voice.livekitUrl ?? '');
        setTtsVoice(voice.ttsVoice ?? 'tara');
        setTtsEngine(voice.ttsEngine ?? 'orpheus');
        setTtsUrl(voice.ttsUrl ?? 'http://localhost:5005');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to load config';
        setLoadError(msg);
        showToast('error', msg);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Fetch available voices from voice server
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/voice/voices');
        if (res.ok) {
          const data = await res.json();
          if (data.voices?.length) setOrpheusVoices(data.voices);
        }
      } catch { /* voice server offline */ }
    })();
  }, []);

  // Auto-discover voice services on mount and when voice is enabled
  const checkVoiceServices = async () => {
    setCheckingVoice(true);
    try {
      const [healthRes, statusRes] = await Promise.allSettled([
        fetch('/api/voice/health').then((r) => r.json()),
        fetch('/api/voice/status').then((r) => r.json()),
      ]);
      if (healthRes.status === 'fulfilled') setVoiceHealth(healthRes.value);
      if (statusRes.status === 'fulfilled') {
        setVoiceStatus(statusRes.value);
        // Auto-populate LiveKit URL if discovered and field is empty
        if (statusRes.value.livekitUrl && !livekitUrl) {
          setLivekitUrl(statusRes.value.livekitUrl);
        }
      }
    } catch { /* Voice endpoints may not exist */ }
    setCheckingVoice(false);
  };

  useEffect(() => {
    if (!loading) checkVoiceServices();
  }, [loading]);

  // Check Orpheus status when selected
  useEffect(() => {
    if (voiceEnabled && ttsEngine === 'orpheus') {
      getOrpheusStatus().then(setOrpheusStatus).catch(() => {});
    }
  }, [voiceEnabled, ttsEngine]);

  const handleOrpheusSetup = async () => {
    setOrpheusInstalling(true);
    setOrpheusProgress('Starting setup...');

    const token = localStorage.getItem('titan-token');
    const res = await fetch('/api/voice/orpheus/install', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.detail) setOrpheusProgress(data.detail);
            if (data.status === 'error') {
              setOrpheusProgress(`Error: ${data.detail}`);
              setOrpheusInstalling(false);
              return;
            }
            if (data.step === 'complete') {
              setOrpheusProgress('Orpheus TTS is ready!');
              setOrpheusInstalling(false);
              setOrpheusStatus({ installed: true, running: true });
              return;
            }
          } catch { /* parse error */ }
        }
      }
    }
    setOrpheusInstalling(false);
  };

  const handleOrpheusStart = async () => {
    try {
      await startOrpheus();
      setOrpheusStatus({ installed: true, running: true });
      showToast('success', 'Orpheus TTS started');
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to start Orpheus');
    }
  };

  const handleOrpheusStop = async () => {
    try {
      await stopOrpheus();
      setOrpheusStatus({ installed: true, running: false });
      showToast('success', 'Orpheus TTS stopped');
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to stop Orpheus');
    }
  };

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSwitchModel = async () => {
    if (!selectedModel || selectedModel === getModel(config ?? {})) return;
    try {
      const model = models.find((m) => m.id === selectedModel);
      await switchModel(selectedModel, model?.provider);
      const cfg = await getConfig();
      setConfig(cfg);
      setSelectedModel(getModel(cfg));
      showToast('success', `Switched to ${selectedModel}`);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to switch model');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateConfig({
        voice: {
          enabled: voiceEnabled,
          livekitUrl,
          ttsVoice,
          ttsEngine,
          ttsUrl: ttsUrl || 'http://localhost:5005',
          sttUrl: config?.voice?.sttUrl ?? 'http://localhost:48421',
          livekitApiKey: config?.voice?.livekitApiKey ?? '',
          livekitApiSecret: config?.voice?.livekitApiSecret ?? '',
          agentUrl: config?.voice?.agentUrl ?? '',
        },
      });
      setConfig(updated);
      showToast('success', 'Settings saved');
      // Re-check voice services after save
      if (voiceEnabled) checkVoiceServices();
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl border border-[#3f3f46] bg-[#18181b]" />
        ))}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-[#fafafa]">Settings</h2>
        <div className="rounded-xl border border-[#ef4444]/50 bg-[#18181b] p-6">
          <div className="flex items-center gap-2 text-[#ef4444]">
            <AlertCircle className="h-5 w-5" />
            <p className="text-sm font-medium">Failed to load settings</p>
          </div>
          <p className="mt-2 text-sm text-[#a1a1aa]">{loadError}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-[#27272a] px-4 py-2 text-sm text-[#fafafa] hover:bg-[#3f3f46] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const currentModel = config ? getModel(config) : '';

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-[#fafafa]">Settings</h2>

      {toast && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${
            toast.type === 'success'
              ? 'border-[#22c55e]/50 text-[#22c55e]'
              : 'border-[#ef4444]/50 text-[#ef4444]'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          {toast.message}
        </div>
      )}

      {/* Model Section */}
      <div className="rounded-xl border border-[#3f3f46] bg-[#18181b] p-6">
        <h3 className="mb-4 text-sm font-medium text-[#a1a1aa]">Model</h3>
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onSelect={setSelectedModel}
          onSwitch={handleSwitchModel}
          currentModel={currentModel}
        />
      </div>

      {/* Voice Section */}
      <div className="rounded-xl border border-[#3f3f46] bg-[#18181b] p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-[#818cf8]" />
            <h3 className="text-sm font-medium text-[#a1a1aa]">Voice</h3>
            <span className="rounded-full bg-[#6366f1]/20 px-2 py-0.5 text-[9px] font-medium text-[#a78bfa]">
              {TTS_ENGINES.find((e) => e.id === ttsEngine)?.name || ttsEngine}
            </span>
          </div>
          <button
            onClick={checkVoiceServices}
            disabled={checkingVoice}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-[#71717a] hover:bg-[#27272a] hover:text-[#a1a1aa] transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${checkingVoice ? 'animate-spin' : ''}`} />
            {checkingVoice ? 'Scanning...' : 'Scan Services'}
          </button>
        </div>

        <div className="space-y-4">
          {/* Service Health Status */}
          {voiceHealth && (
            <div className="rounded-lg border border-[#27272a] bg-[#09090b] p-3">
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Service Discovery</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'LiveKit Server', ok: voiceHealth.livekit },
                  { label: 'Voice Agent', ok: voiceHealth.agent },
                  { label: 'STT', ok: voiceHealth.stt },
                  { label: `TTS (${TTS_ENGINES.find((e) => e.id === ttsEngine)?.name || 'TTS'})`, ok: voiceHealth.tts },
                ].map(({ label, ok }) => (
                  <div key={label} className="flex items-center gap-2">
                    <StatusDot ok={ok} />
                    <span className={`text-xs ${ok ? 'text-[#a1a1aa]' : 'text-[#52525b]'}`}>{label}</span>
                    {ok && <span className="text-[9px] text-[#22c55e]">Online</span>}
                  </div>
                ))}
              </div>
              {voiceStatus?.available !== undefined && (
                <div className="mt-2 flex items-center gap-2 border-t border-[#27272a] pt-2">
                  {voiceStatus.available ? (
                    <><Wifi className="h-3.5 w-3.5 text-[#22c55e]" /><span className="text-xs text-[#22c55e]">Voice system ready</span></>
                  ) : (
                    <><WifiOff className="h-3.5 w-3.5 text-[#71717a]" /><span className="text-xs text-[#71717a]">{voiceStatus.reason || 'Voice not available'}</span></>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Enable toggle */}
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={voiceEnabled}
              onChange={(e) => setVoiceEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-[#3f3f46] accent-[#6366f1]"
            />
            <span className="text-sm text-[#fafafa]">Enable Voice Chat</span>
          </label>
          {/* TTS Engine Selector */}
          <div>
            <label className="mb-2 block text-xs text-[#71717a]">TTS Engine</label>
            <div className="grid grid-cols-3 gap-2">
              {TTS_ENGINES.map((engine) => (
                <button
                  key={engine.id}
                  type="button"
                  onClick={() => {
                    setTtsEngine(engine.id);
                    setTtsUrl(engine.defaultUrl);
                    setTtsVoice(engine.defaultVoices[0] || 'default');
                    setOrpheusVoices(engine.defaultVoices);
                  }}
                  className={`rounded-lg border p-2 text-left transition-all ${
                    ttsEngine === engine.id
                      ? 'border-[#6366f1] bg-[#6366f1]/10'
                      : 'border-[#3f3f46] hover:border-[#52525b]'
                  }`}
                >
                  <div className="text-xs font-medium text-[#fafafa]">{engine.name}</div>
                  <div className="mt-0.5 text-[10px] text-[#52525b]">{engine.desc}</div>
                </button>
              ))}
            </div>

            {/* Orpheus TTS Setup/Status */}
            {ttsEngine === 'orpheus' && (
              <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
                {orpheusInstalling ? (
                  /* Installing state */
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 text-[#818cf8] animate-spin" />
                      <span className="text-sm font-medium text-[#fafafa]">Installing Orpheus TTS...</span>
                    </div>
                    <div className="rounded-lg bg-[#09090b] border border-[#27272a] p-3">
                      <p className="text-xs text-[#a1a1aa] font-mono break-all">{orpheusProgress}</p>
                    </div>
                  </div>
                ) : orpheusStatus?.installed && orpheusStatus?.running ? (
                  /* Running state */
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-[#22c55e] shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
                      <span className="text-sm text-[#fafafa]">Orpheus TTS Running</span>
                    </div>
                    <button
                      onClick={handleOrpheusStop}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[#a1a1aa] border border-[#3f3f46] hover:border-[#ef4444]/50 hover:text-[#ef4444] transition-colors"
                    >
                      <Square className="h-3.5 w-3.5" />
                      Stop
                    </button>
                  </div>
                ) : orpheusStatus?.installed && !orpheusStatus?.running ? (
                  /* Stopped state */
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-[#f59e0b] shadow-[0_0_6px_rgba(245,158,11,0.3)]" />
                      <span className="text-sm text-[#fafafa]">Orpheus TTS Stopped</span>
                    </div>
                    <button
                      onClick={handleOrpheusStart}
                      className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[#22c55e] border border-[#3f3f46] hover:border-[#22c55e]/50 hover:bg-[#22c55e]/10 transition-colors"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Start
                    </button>
                  </div>
                ) : (
                  /* Not installed state */
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-[#fafafa]">Orpheus TTS Not Installed</p>
                        <p className="text-xs text-[#52525b] mt-0.5">~2GB download, Apple Silicon optimized</p>
                      </div>
                      <button
                        onClick={handleOrpheusSetup}
                        className="flex items-center gap-2 rounded-lg bg-[#6366f1] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#6366f1]/80"
                      >
                        <Download className="h-4 w-4" />
                        Setup Orpheus TTS
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* LiveKit URL */}
          <div>
            <label className="mb-1 flex items-center gap-2 text-xs text-[#71717a]">
              LiveKit URL
              {voiceHealth?.livekit && (
                <span className="rounded bg-[#22c55e]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#22c55e]">Connected</span>
              )}
            </label>
            <input
              value={livekitUrl}
              onChange={(e) => setLivekitUrl(e.target.value)}
              placeholder="ws://localhost:7880"
              className="w-full rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2 text-sm text-[#fafafa] outline-none focus:border-[#6366f1]"
            />
          </div>

          {/* TTS Voice — Orpheus voice buttons */}
          <div>
            <label className="mb-2 block text-xs text-[#71717a]">Voice</label>
            <div className="grid grid-cols-4 gap-2">
              {orpheusVoices.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setTtsVoice(v)}
                  className={`rounded-lg border px-3 py-2 text-sm transition-all capitalize ${
                    ttsVoice === v
                      ? 'border-[#6366f1] bg-[#6366f1]/10 text-[#fafafa]'
                      : 'border-[#3f3f46] text-[#a1a1aa] hover:border-[#52525b] hover:text-[#fafafa]'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-[#52525b]">
              {ttsEngine === 'orpheus' && 'Orpheus voices support emotion tags: <laugh>, <sigh>, <chuckle> and more'}
              {ttsEngine === 'fish-speech' && 'Upload reference audio to clone any voice via Fish Speech WebUI'}
              {ttsEngine === 'browser' && "Uses your browser's built-in speech synthesis"}
            </p>
          </div>

          {/* Active voice preview */}
          {ttsVoice && (
            <div className="flex items-center gap-2 rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2">
              <Mic className="h-3.5 w-3.5 text-[#818cf8]" />
              <span className="text-xs text-[#71717a]">Selected:</span>
              <span className="text-xs font-mono text-[#a1a1aa]">{ttsVoice}</span>
              <span className="ml-auto rounded bg-[#6366f1]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#a78bfa]">
                {TTS_ENGINES.find((e) => e.id === ttsEngine)?.name || ttsEngine}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 rounded-lg bg-[#6366f1] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#6366f1]/80 disabled:opacity-50"
      >
        <Save className="h-4 w-4" />
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

export default SettingsPanel;
