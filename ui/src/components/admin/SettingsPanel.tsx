import { useEffect, useState, useMemo } from 'react';
import { Save, CheckCircle, AlertCircle, Monitor, Cloud, Mic, RefreshCw, Wifi, WifiOff, Download, Loader2, Square, Play } from 'lucide-react';
import { PageHeader, HelpBadge } from '@/components/shared';
import { getConfig, updateConfig, getModels, switchModel, getF5TtsStatus, getClonedVoices, uploadVoiceReference, deleteClonedVoice, previewVoice, apiFetch } from '@/api/client';
import { trackEvent } from '@/api/telemetry';
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
    <div className="h-2 w-2 rounded-full bg-success shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
  ) : (
    <div className="h-2 w-2 rounded-full bg-border-light" />
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

  // Sync internal provider state when the active model changes externally
  useEffect(() => {
    setSelectedProvider(currentProvider);
  }, [currentProvider]);

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
        <div className="flex items-center gap-1.5 mb-1.5">
          <label className="text-xs text-text-muted">Provider</label>
          <HelpBadge title="AI Provider" description="The company or service that hosts the AI model. Local providers (Ollama, LM Studio) run on your machine. Cloud providers (Anthropic, OpenAI) run remotely and require an API key." />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <select
            value={selectedProvider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 text-sm text-text outline-none transition-colors focus:border-accent min-h-[44px]"
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
            <span className="flex items-center gap-1 whitespace-nowrap rounded bg-success/15 px-2 py-1 text-xs font-medium text-success self-start mt-0.5 sm:self-auto sm:mt-0">
              <Monitor className="h-3 w-3" /> Local
            </span>
          )}
          {!isLocal && selectedProvider && (
            <span className="flex items-center gap-1 whitespace-nowrap rounded bg-accent/15 px-2 py-1 text-xs font-medium text-accent-hover self-start mt-0.5 sm:self-auto sm:mt-0">
              <Cloud className="h-3 w-3" /> Cloud
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <label className="text-xs text-text-muted">Model</label>
          <HelpBadge title="Model Selection" description="The specific AI model TITAN uses to think and respond. Larger models are smarter but slower and cost more. You can switch anytime without losing conversation history." />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-end gap-2 md:gap-3">
          <select
            value={selectedModel}
            onChange={(e) => onSelect(e.target.value)}
            className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 text-sm text-text outline-none transition-colors focus:border-accent min-h-[44px]"
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
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-50 min-h-[44px] w-full sm:w-auto active:scale-[0.98]"
          >
            Switch
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2.5">
        <div className="h-2 w-2 rounded-full bg-success animate-pulse flex-shrink-0" />
        <span className="text-xs text-text-muted">Active:</span>
        <span className="text-xs text-text-secondary font-mono overflow-x-auto scrollbar-thin">{currentModel || 'None'}</span>
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
  const [ttsVoice, setTtsVoice] = useState('andrew');
  const [ttsEngine, setTtsEngine] = useState('f5-tts');
  const [ttsUrl, setTtsUrl] = useState('http://localhost:5006');
  const [f5Voices, setF5Voices] = useState<string[]>(['andrew']);

  // Orpheus TTS management state
  const [orpheusStatus, setOrpheusStatus] = useState<{ installed: boolean; running: boolean } | null>(null);
  const [orpheusInstalling, setOrpheusInstalling] = useState(false);
  const [orpheusProgress, setOrpheusProgress] = useState<string>('');

  const TTS_ENGINES = [
    { id: 'f5-tts', name: 'F5-TTS', desc: 'Voice cloning with MLX (Apple Silicon)', defaultUrl: 'http://localhost:5006', defaultVoices: ['andrew'] },
  ];

  // Qwen3-TTS state
  const [qwen3Status, setQwen3Status] = useState<{ installed: boolean; running: boolean; voices: string[] } | null>(null);
  const [qwen3Installing, setQwen3Installing] = useState(false);
  const [qwen3Progress, setQwen3Progress] = useState<string>('');
  const [clonedVoices, setClonedVoices] = useState<Array<{ name: string; hasTranscript: boolean; sizeBytes: number }>>([]);
  const [uploadingVoice, setUploadingVoice] = useState(false);

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
        setTtsVoice(voice.ttsVoice ?? 'andrew');
        setTtsEngine(voice.ttsEngine ?? 'f5-tts');
        setTtsUrl(voice.ttsUrl ?? 'http://localhost:5006');
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
        const res = await apiFetch('/api/voice/voices');
        if (res.ok) {
          const data = await res.json();
          if (data.voices?.length) setF5Voices(data.voices);
        }
      } catch { /* voice server offline */ }
    })();
  }, []);

  // Auto-discover voice services on mount and when voice is enabled
  const checkVoiceServices = async () => {
    setCheckingVoice(true);
    try {
      const [healthRes, statusRes] = await Promise.allSettled([
        apiFetch('/api/voice/health').then((r) => r.json()),
        apiFetch('/api/voice/status').then((r) => r.json()),
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

  // Check F5-TTS status when voice is enabled
  useEffect(() => {
    if (voiceEnabled) {
      getF5TtsStatus().then(d => {
        setQwen3Status({ installed: d.installed, running: d.running, voices: d.voices });
        setClonedVoices(d.voices.map(v => ({ name: v, hasTranscript: false, sizeBytes: 0 })));
        if (d.voices?.length) {
          setF5Voices(['andrew', ...d.voices]);
        }
      }).catch(() => {});
    }
  }, [voiceEnabled]);

  // ── F5-TTS Handlers ──
  const handleF5Setup = async () => {
    setQwen3Installing(true);
    setQwen3Progress('Starting F5-TTS setup...');
    try {
      const res = await apiFetch('/api/voice/f5tts/install', { method: 'POST' });
      if (!res.ok) {
        setQwen3Progress(`Error: ${res.statusText || 'Setup failed'} (${res.status})`);
        setQwen3Installing(false);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setQwen3Installing(false); return; }
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
              if (data.detail) setQwen3Progress(data.detail);
              if (data.status === 'error') {
                setQwen3Progress(`Error: ${data.detail}`);
                setQwen3Installing(false);
                return;
              }
              if (data.step === 'complete') {
                setQwen3Progress('F5-TTS is ready!');
                setQwen3Installing(false);
                setQwen3Status({ installed: true, running: true, voices: [] });
                return;
              }
            } catch { /* parse error */ }
          }
        }
      }
      setQwen3Installing(false);
    } catch (e) {
      setQwen3Progress(`Error: ${e instanceof Error ? e.message : 'Setup failed'}`);
      setQwen3Installing(false);
    }
  };

  const handleVoiceUpload = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/wav,audio/mp3,audio/mpeg,audio/flac,.wav,.mp3,.flac';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      const voiceName = prompt('Name this voice (e.g., "robin", "jarvis"):', file.name.replace(/\.[^.]+$/, ''));
      if (!voiceName) return;

      const transcript = prompt('(Optional) Transcript of the audio — improves cloning quality:', '') || '';

      setUploadingVoice(true);
      try {
        const arrayBuf = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
        const result = await uploadVoiceReference(voiceName, base64, transcript);
        const duration = (result as any)?.duration ? ` Duration: ${(result as any).duration}s,` : '';
        showToast('success', `Voice "${voiceName}" uploaded!${duration} preprocessed and normalized.`);
        // Refresh voices
        const updated = await getClonedVoices();
        setClonedVoices(updated.voices || []);
        setF5Voices(['default', ...updated.voices.map(v => v.name)]);
        setTtsVoice(voiceName);
      } catch (e) {
        showToast('error', e instanceof Error ? e.message : 'Failed to upload voice');
      } finally {
        setUploadingVoice(false);
      }
    };
    input.click();
  };

  const handlePreviewVoice = async (name: string) => {
    try {
      showToast('success', `Generating preview for "${name}"...`);
      const testSentences = [
        'Hello, how can I help you today?',
        'I am ready to assist you with anything you need.',
        'Good morning. It is a pleasure to be of service.',
      ];
      const text = testSentences[Math.floor(Math.random() * testSentences.length)];
      const res = await previewVoice(name, text);
      const blob = new Blob([res], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.play();
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to preview voice');
    }
  };

  const handleDeleteVoice = async (name: string) => {
    if (!confirm(`Delete voice "${name}"?`)) return;
    try {
      await deleteClonedVoice(name);
      const updated = await getClonedVoices();
      setClonedVoices(updated.voices || []);
      setF5Voices(['andrew', ...updated.voices.map(v => v.name)]);
      if (ttsVoice === name) setTtsVoice('default');
      showToast('success', `Voice "${name}" deleted`);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to delete voice');
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
      trackEvent('model_switched', { model: selectedModel, provider: model?.provider });
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
          <div key={i} className="h-32 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <PageHeader title="Settings" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Settings'}, {label:'Settings'}]} />
        <div className="rounded-xl border border-error/50 bg-bg-secondary p-6">
          <div className="flex items-center gap-2 text-error">
            <AlertCircle className="h-5 w-5" />
            <p className="text-sm font-medium">Failed to load settings</p>
          </div>
          <p className="mt-2 text-sm text-text-secondary">{loadError}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-bg-tertiary px-4 py-2 text-sm text-text hover:bg-border transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const currentModel = config ? getModel(config) : '';

  return (
    <div className="space-y-4 md:space-y-6">
      <h2 className="text-base md:text-lg font-semibold text-text">Settings</h2>

      {toast && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 md:px-4 py-2.5 md:py-2 text-[11px] md:text-sm ${
            toast.type === 'success'
              ? 'border-success/50 text-success'
              : 'border-error/50 text-error'
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
      <div className="rounded-xl border border-border bg-bg-secondary p-3 md:p-6">
        <h3 className="mb-3 md:mb-4 text-[11px] md:text-sm font-medium text-text-secondary">Model</h3>
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onSelect={setSelectedModel}
          onSwitch={handleSwitchModel}
          currentModel={currentModel}
        />
      </div>

      {/* Voice Section */}
      <div className="rounded-xl border border-border bg-bg-secondary p-3 md:p-6">
        <div className="mb-3 md:mb-4 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-accent-hover" />
            <h3 className="text-sm font-medium text-text-secondary">Voice</h3>
            <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[9px] font-medium text-purple-light">
              {TTS_ENGINES.find((e) => e.id === ttsEngine)?.name || ttsEngine}
            </span>
          </div>
          <button
            onClick={checkVoiceServices}
            disabled={checkingVoice}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-text-muted hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
          >
            <RefreshCw className={`h-3 w-3 ${checkingVoice ? 'animate-spin' : ''}`} />
            {checkingVoice ? 'Scanning...' : 'Scan Services'}
          </button>
        </div>

        <div className="space-y-4">
          {/* Service Health Status */}
          {voiceHealth && (
            <div className="rounded-lg border border-bg-tertiary bg-bg p-3">
              <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">Service Discovery</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'LiveKit Server', ok: voiceHealth.livekit },
                  { label: 'Voice Agent', ok: voiceHealth.agent },
                  { label: 'STT', ok: voiceHealth.stt },
                  { label: `TTS (${TTS_ENGINES.find((e) => e.id === ttsEngine)?.name || 'TTS'})`, ok: voiceHealth.tts },
                ].map(({ label, ok }) => (
                  <div key={label} className="flex items-center gap-2">
                    <StatusDot ok={ok} />
                    <span className={`text-xs ${ok ? 'text-text-secondary' : 'text-text-muted'}`}>{label}</span>
                    {ok && <span className="text-[9px] text-success">Online</span>}
                  </div>
                ))}
              </div>
              {voiceStatus?.available !== undefined && (
                <div className="mt-2 flex items-center gap-2 border-t border-bg-tertiary pt-2">
                  {voiceStatus.available ? (
                    <><Wifi className="h-3.5 w-3.5 text-success" /><span className="text-xs text-success">Voice system ready</span></>
                  ) : (
                    <><WifiOff className="h-3.5 w-3.5 text-text-muted" /><span className="text-xs text-text-muted">{voiceStatus.reason || 'Voice not available'}</span></>
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
              className="h-4 w-4 rounded border-border accent-accent"
            />
            <span className="text-sm text-text">Enable Voice Chat</span>
          </label>
          {/* TTS Engine Selector — responsive for mobile */}
          <div>
            <label className="mb-2 block text-xs text-text-muted">TTS Engine</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {TTS_ENGINES.map((engine) => (
                <button
                  key={engine.id}
                  type="button"
                  onClick={() => {
                    setTtsEngine(engine.id);
                    setTtsUrl(engine.defaultUrl);
                    setTtsVoice(engine.defaultVoices[0] || 'default');
                    setF5Voices(engine.defaultVoices);
                  }}
                  className={`rounded-lg border p-3 text-left transition-all min-h-[64px] active:scale-[0.98] sm:min-h-[56px] ${
                    ttsEngine === engine.id
                      ? 'border-accent bg-accent/10'
                      : 'border-border hover:border-border-light'
                  }`}
                >
                  <div className="text-xs font-medium text-text">{engine.name}</div>
                  <div className="mt-0.5 text-[10px] text-text-muted">{engine.desc}</div>
                </button>
              ))}
            </div>

            {/* F5-TTS Voice Cloning */}
            <div className="mt-3 rounded-xl border border-border bg-bg-secondary p-4 space-y-4">
              {qwen3Installing ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 text-accent2 animate-spin" />
                    <span className="text-sm font-medium text-text">Installing F5-TTS...</span>
                  </div>
                  <div className="rounded-lg bg-bg border border-bg-tertiary p-3">
                    <p className="text-xs text-text-secondary font-mono break-all">{qwen3Progress}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-success shadow-[0_0_6px_rgba(34,197,94,0.4)]" />
                      <span className="text-sm text-text">F5-TTS Running</span>
                    </div>
                  </div>
                  <div className="rounded-lg border border-bg-tertiary bg-bg p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-text-secondary">Cloned Voices</p>
                      <button
                        onClick={handleVoiceUpload}
                        disabled={uploadingVoice}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-accent2 border border-border hover:border-accent2/50 hover:bg-accent2/10 transition-colors disabled:opacity-50"
                      >
                        {uploadingVoice ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3 rotate-180" />}
                        Upload Voice
                      </button>
                    </div>
                    <p className="text-[10px] text-text-muted leading-relaxed">Upload 5-10 seconds of clear speech. No background noise or music. Adding a transcript significantly improves quality.</p>
                    {clonedVoices.length > 0 ? (
                      <div className="space-y-1.5">
                        {clonedVoices.map(v => (
                          <div key={v.name} className="flex items-center justify-between rounded-lg border border-bg-tertiary px-3 py-2">
                            <div className="flex items-center gap-2">
                              <Mic className="h-3.5 w-3.5 text-accent2" />
                              <span className="text-sm text-text capitalize">{v.name}</span>
                              <span className="text-[9px] text-text-muted">{(v.sizeBytes / 1024).toFixed(0)}KB</span>
                              {v.hasTranscript && <span className="rounded bg-success/15 px-1 py-0.5 text-[8px] text-success">transcript</span>}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handlePreviewVoice(v.name)}
                                className="text-text-muted hover:text-accent2 transition-colors"
                                title="Preview voice"
                              >
                                <Play className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteVoice(v.name)}
                                className="text-text-muted hover:text-error transition-colors"
                                title="Delete voice"
                              >
                                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-text-muted">No cloned voices yet. Upload a 5-10 second WAV reference to clone any voice.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* LiveKit URL */}
          <div>
            <label className="mb-1 flex items-center gap-2 text-xs text-text-muted">
              LiveKit URL
              {voiceHealth?.livekit && (
                <span className="rounded bg-success/15 px-1.5 py-0.5 text-[9px] font-medium text-success">Connected</span>
              )}
            </label>
            <input
              value={livekitUrl}
              onChange={(e) => setLivekitUrl(e.target.value)}
              placeholder="ws://localhost:7880"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </div>

          {/* TTS Voice — Orpheus voice buttons */}
          <div>
            <label className="mb-2 block text-xs text-text-muted">Voice</label>
            <div className="grid grid-cols-4 gap-2">
              {f5Voices.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setTtsVoice(v)}
                  className={`rounded-lg border px-3 py-2 text-sm transition-all capitalize ${
                    ttsVoice === v
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border text-text-secondary hover:border-border-light hover:text-text'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-text-muted">
              F5-TTS voice cloning via MLX. Upload a 5-10 second reference audio to clone any voice.
            </p>
          </div>

          {/* Active voice preview */}
          {ttsVoice && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2">
              <Mic className="h-3.5 w-3.5 text-accent-hover" />
              <span className="text-xs text-text-muted">Selected:</span>
              <span className="text-xs font-mono text-text-secondary">{ttsVoice}</span>
              <span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-purple-light">
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
        className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
      >
        <Save className="h-4 w-4" />
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </div>
  );
}

export default SettingsPanel;
