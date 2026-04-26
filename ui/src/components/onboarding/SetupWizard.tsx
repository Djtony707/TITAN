/**
 * TITAN Onboarding Wizard — v5.0 "Spacewalk"
 * Beautiful, fun, and helpful. Like joining a space mission crew.
 */
import { useState, useEffect, useRef } from 'react';
import {
  ChevronRight, ChevronLeft, Sparkles, Key, Cpu, User, Rocket, Cloud,
  Activity, Monitor, HardDrive, MemoryStick, Zap, Telescope, Orbit,
  BrainCircuit, Waves, Shield, Flame, MessageCircle, Wrench, Volume2,
  Globe, Wifi, AlertTriangle, CheckCircle2, ArrowRight,
} from 'lucide-react';
import { FluidOrb } from '@/components/voice/FluidOrb';
import { apiFetch } from '@/api/client';
import { trackEvent } from '@/api/telemetry';
import type { PersonaMeta } from '@/api/types';

interface SetupWizardProps {
  onComplete: () => void;
}

interface HardwareProfile {
  cpuCores: number;
  cpuModel: string;
  ramTotalMB: number;
  ramFreeMB: number;
  gpuVendor: 'nvidia' | 'amd' | 'apple' | 'none';
  gpuName: string;
  gpuVramMB: number;
  gpuFreeMB: number;
  diskTotalGB: number;
  diskFreeGB: number;
  os: string;
}

/* ── Providers ─────────────────────────────────────────────── */

const PROVIDERS = [
  { id: 'ollama', name: 'Ollama (Local)', desc: 'Free — your own machine is the datacenter', noKey: true, icon: Cpu },
  { id: 'anthropic', name: 'Anthropic', desc: 'Claude — polite, thorough, expensive taste', icon: BrainCircuit },
  { id: 'openai', name: 'OpenAI', desc: 'GPT-4o, o3 — the household name', icon: Zap },
  { id: 'google', name: 'Google', desc: 'Gemini — long context, occasional hallucinations', icon: Globe },
  { id: 'groq', name: 'Groq', desc: 'Ludicrous speed. Seriously, it\'s fast.', icon: Flame },
  { id: 'openrouter', name: 'OpenRouter', desc: '290+ models, one key. The buffet.', icon: Wifi },
  { id: 'deepseek', name: 'DeepSeek', desc: 'DeepSeek — reasoning specialist, great value', icon: Telescope },
  { id: 'xai', name: 'xAI', desc: 'Grok — edgy, real-time, may roast you', icon: MessageCircle },
] as const;

const DEFAULT_MODELS: Record<string, string[]> = {
  ollama: ['ollama/llama3.3:8b', 'ollama/qwen3:8b', 'ollama/devstral-small-2', 'ollama/mistral:7b'],
  anthropic: ['anthropic/claude-sonnet-4-20250514', 'anthropic/claude-haiku-4-5-20251001', 'anthropic/claude-opus-4-20250514'],
  openai: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/o3-mini'],
  google: ['google/gemini-2.5-pro', 'google/gemini-2.0-flash'],
  groq: ['groq/llama-3.3-70b-versatile', 'groq/mixtral-8x7b-32768'],
  openrouter: ['openrouter/anthropic/claude-sonnet-4-20250514', 'openrouter/openai/gpt-4o'],
  deepseek: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'],
  xai: ['xai/grok-3', 'xai/grok-3-mini'],
};

const LIGHTWEIGHT_MODELS = ['ollama/qwen3:8b', 'ollama/llama3.3:8b', 'ollama/mistral:7b'];

const CLOUD_MODELS = {
  free: [
    { id: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super', desc: 'Free 120B MoE — surprisingly capable', badge: 'free' },
    { id: 'openrouter/nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano', desc: 'Free 30B — quick and cheerful', badge: 'free' },
    { id: 'openrouter/z-ai/glm-4.5-air:free', name: 'GLM-4.5 Air', desc: 'Free versatile all-rounder', badge: 'free' },
  ],
  paid: [
    { id: 'openrouter/qwen/qwen3.5-397b-a17b', name: 'Qwen 3.5 397B', desc: 'Flagship MoE — best quality, best value', badge: 'flagship' },
    { id: 'openrouter/openai/gpt-5.4', name: 'GPT-5.4', desc: 'OpenAI premium — costs a pretty penny', badge: 'premium' },
    { id: 'openrouter/anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', desc: 'Anthropic premium — worth every cent', badge: 'premium' },
    { id: 'openrouter/google/gemini-3.1-pro', name: 'Gemini 3.1 Pro', desc: 'Google premium — reads War and Peace in one go', badge: 'premium' },
    { id: 'openrouter/moonshotai/kimi-k2.5', name: 'Kimi K2.5', desc: 'Strong reasoning — the quiet achiever', badge: 'midrange' },
    { id: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'Cost-effective — smart on a budget', badge: 'midrange' },
    { id: 'openrouter/z-ai/glm-4.7-flash', name: 'GLM-4.7 Flash', desc: 'Fast agent model — gets things done', badge: 'agent' },
  ],
};

/* ── Fun facts that rotate on the Welcome screen ───────────── */

const FUN_FACTS = [
  'TITAN can control your lights, write your code, and remember your coffee order.',
  'The "Soma" system gives TITAN feelings. Don\'t worry, it\'s therapy.',
  'TITAN has 248 tools. You probably only need 3. But it\'s nice to have options.',
  'TITAN once summarized a 500-page PDF in 12 seconds. The PDF was mostly blank.',
  'TITAN\'s voice mode uses F5-TTS. It sounds like an android from a sci-fi film.',
  'TITAN can run 5 agents at once. It\'s like having a tiny dev team in your laptop.',
];

/* ── Animated counter ──────────────────────────────────────── */

function AnimCounter({ target, suffix = '' }: { target: number; suffix?: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef<number>(0);

  useEffect(() => {
    const duration = 1200;
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(target * eased));
      if (progress < 1) ref.current = requestAnimationFrame(animate);
    };
    ref.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(ref.current);
  }, [target]);

  return <>{count.toLocaleString()}{suffix}</>;
}

/* ── Step label component ──────────────────────────────────── */

function StepBadge({ children, icon: Icon }: { children: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      {Icon && <Icon className="w-5 h-5 text-accent" />}
      <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-accent">{children}</span>
    </div>
  );
}

/* ── Wizard ────────────────────────────────────────────────── */

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [agentName, setAgentName] = useState('TITAN');
  const [persona, setPersona] = useState('default');
  const [personas, setPersonas] = useState<PersonaMeta[]>([]);
  const [personaSearch, setPersonaSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');
  const [funFactIndex, setFunFactIndex] = useState(0);
  const [cloudMode, setCloudMode] = useState(false);
  const [cloudEmail, setCloudEmail] = useState('');
  const [somaEnabled, setSomaEnabled] = useState(true);
  const [telemetryOptIn, setTelemetryOptIn] = useState(false);

  // Hardware scan
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [hwRecommendations, setHwRecommendations] = useState<string[]>([]);
  const [hwLoading, setHwLoading] = useState(false);
  const [hwApplied, setHwApplied] = useState(false);
  const [applyHwConfig, setApplyHwConfig] = useState(true);

  const selectedProvider = PROVIDERS.find(p => p.id === provider);
  const needsKey = selectedProvider && !('noKey' in selectedProvider && selectedProvider.noKey);

  // Model filtering
  const models = (() => {
    const base = DEFAULT_MODELS[provider] || [];
    if (!hardware || cloudMode) return base;
    const hasGpu = hardware.gpuVendor !== 'none' && hardware.gpuVramMB >= 4096;
    const hasRam = hardware.ramTotalMB >= 16384;
    if (!hasGpu && !hasRam && provider === 'ollama') {
      return base.filter(m => LIGHTWEIGHT_MODELS.includes(m));
    }
    return base;
  })();

  const allCloudModels = [...CLOUD_MODELS.free, ...CLOUD_MODELS.paid];

  // Detect cloud mode
  useEffect(() => {
    apiFetch('/api/cloud/config')
      .then(r => r.json())
      .then(d => {
        if (d.cloud) {
          setCloudMode(true);
          setCloudEmail(d.userEmail || '');
          setProvider('openrouter');
          setModel(CLOUD_MODELS.free[0]?.id || '');
        }
      })
      .catch(() => {});
  }, []);

  // Fetch personas
  useEffect(() => {
    apiFetch('/api/personas')
      .then(r => r.json())
      .then(d => {
        if (d.personas) setPersonas(d.personas);
        if (d.active) setPersona(d.active);
      })
      .catch(() => {});
  }, []);

  // Hardware scan
  useEffect(() => {
    setHwLoading(true);
    apiFetch('/api/hardware/detect')
      .then(r => r.json())
      .then(d => {
        if (d.profile) setHardware(d.profile);
        if (d.recommendations) setHwRecommendations(d.recommendations);
      })
      .catch(() => {})
      .finally(() => setHwLoading(false));
  }, []);

  // Rotate fun facts
  useEffect(() => {
    const interval = setInterval(() => {
      setFunFactIndex(i => (i + 1) % FUN_FACTS.length);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-select provider based on hardware
  useEffect(() => {
    if (hardware && !provider && !cloudMode) {
      const hasGpu = hardware.gpuVendor !== 'none' && hardware.gpuVramMB >= 4096;
      const hasRam = hardware.ramTotalMB >= 8192;
      if (hasGpu || hasRam) setProvider('ollama');
    }
  }, [hardware, provider, cloudMode]);

  const canAdvance = () => {
    if (cloudMode) {
      switch (step) {
        case 0: return true;
        case 1: return true;
        case 2: return !!model;
        case 3: return !!agentName;
        case 4: return true;
        default: return true;
      }
    }
    switch (step) {
      case 0: return true;
      case 1: return true;
      case 2: return !!provider && (!needsKey || apiKey.length > 5);
      case 3: return !!model;
      case 4: return !!agentName;
      case 5: return true;
      default: return true;
    }
  };

  const handleComplete = async () => {
    setSaving(true);
    setError('');
    try {
      if (applyHwConfig && hardware && !hwApplied) {
        try { await apiFetch('/api/hardware/apply', { method: 'POST' }); setHwApplied(true); } catch {}
      }
      if (persona !== 'default') {
        await apiFetch('/api/persona/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona }),
        });
      }
      const res = await apiFetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: cloudMode ? 'openrouter' : provider,
          apiKey: cloudMode ? undefined : (needsKey ? apiKey : undefined),
          model,
          agentName,
          persona,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Setup failed');
      }
      try {
        await apiFetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organism: { enabled: somaEnabled } }),
        });
      } catch {}
      try {
        await apiFetch('/api/telemetry/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: telemetryOptIn, crashReports: telemetryOptIn }),
        });
      } catch {}
      trackEvent('onboarding_completed', { provider: cloudMode ? 'openrouter' : provider, model, cloudMode });
      setCompleted(true);
      setTimeout(onComplete, 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setSaving(false);
    }
  };

  const filteredPersonas = personas.filter(p =>
    !personaSearch ||
    p.name.toLowerCase().includes(personaSearch.toLowerCase()) ||
    p.description.toLowerCase().includes(personaSearch.toLowerCase()) ||
    p.division.toLowerCase().includes(personaSearch.toLowerCase())
  );
  const lastStepIndex = cloudMode ? 5 : 6;
  const orbSize = step === 0 || step === lastStepIndex ? 200 : 0;
  const orbSpeaker = step === lastStepIndex ? 'assistant' : 'idle';

  const formatBytes = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

  /* ── Steps ───────────────────────────────────────────────── */

  const steps = [
    // ── Step 0: Welcome ──
    <div key="welcome" className="flex flex-col items-center text-center">
      <div className="relative mb-8" style={{ transition: 'all 0.6s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <FluidOrb audioLevel={0} speaker="idle" size={orbSize} />
      </div>
      <h1 className="text-5xl font-bold text-white mb-3 tracking-tight">
        Welcome Aboard
      </h1>
      <p className="text-xl text-text-secondary mb-2 font-light">
        TITAN v5.0 <span className="text-accent font-medium">&ldquo;Spacewalk&rdquo;</span>
      </p>
      <p className="text-sm text-text-muted max-w-md mb-8 leading-relaxed">
        You&apos;re about to give your computer a brain, a personality, and a slight
        tendency to ask if you&apos;d like it to organize your desktop. Let&apos;s launch.
      </p>

      <div className="px-5 py-3 rounded-2xl border border-accent/20 bg-accent/5 mb-8 max-w-md">
        <p className="text-xs text-accent-hover font-medium mb-1 flex items-center gap-1.5">
          <Sparkles size={12} /> Did you know?
        </p>
        <p
          className="text-xs text-text-secondary leading-relaxed transition-opacity duration-500"
          key={funFactIndex}
        >
          {FUN_FACTS[funFactIndex]}
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        {['Multi-Agent Swarm', 'Deep Research', 'Soma Drives', 'Voice Mode', 'Smart Home', 'Code Execution'].map(f => (
          <span key={f} className="px-3 py-1.5 text-[11px] rounded-full border border-border text-text-secondary bg-bg-secondary">
            {f}
          </span>
        ))}
      </div>
    </div>,

    // ── Step 1: Hardware Scan ──
    <div key="hardware" className="w-full max-w-lg mx-auto">
      <StepBadge icon={Monitor}>Systems Check</StepBadge>
      <h2 className="text-2xl font-semibold text-white mb-1">Ship Diagnostic</h2>
      <p className="text-sm text-text-muted mb-6">
        TITAN is poking around your machine to see what it&apos;s working with. No judgment.
      </p>

      {hwLoading && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-text-muted animate-pulse">Scanning subsystems…</p>
        </div>
      )}

      {!hwLoading && !hardware && (
        <div className="p-5 rounded-2xl border border-warning/30 bg-warning/5 text-sm text-text-secondary">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <span className="font-medium text-warning">Sensors offline</span>
          </div>
          Couldn&apos;t read hardware details. TITAN will use safe defaults and you can tweak later in Settings.
        </div>
      )}

      {!hwLoading && hardware && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-5">
            {[
              { icon: Cpu, label: 'CPU', value: `${hardware.cpuCores} cores`, sub: hardware.cpuModel },
              { icon: MemoryStick, label: 'RAM', value: formatBytes(hardware.ramTotalMB), sub: `${formatBytes(hardware.ramFreeMB)} free` },
              { icon: Zap, label: 'GPU', value: hardware.gpuVendor === 'none' ? 'None' : hardware.gpuVendor.toUpperCase(), sub: hardware.gpuVendor === 'none' ? 'Cloud models recommended' : `${hardware.gpuName} · ${formatBytes(hardware.gpuVramMB)}` },
              { icon: HardDrive, label: 'Storage', value: `${hardware.diskFreeGB} GB free`, sub: `of ${hardware.diskTotalGB} GB total` },
            ].map(({ icon: Icon, label, value, sub }) => (
              <div key={label} className="p-4 rounded-2xl border border-border bg-bg-secondary hover:border-border-light transition-colors">
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-4 h-4 text-accent" />
                  <span className="text-[10px] text-text-muted uppercase tracking-widest">{label}</span>
                </div>
                <p className="text-sm font-semibold text-white">{value}</p>
                <p className="text-[11px] text-text-muted mt-0.5 truncate" title={sub}>{sub}</p>
              </div>
            ))}
          </div>

          {hwRecommendations.length > 0 && (
            <div className="mb-5">
              <p className="text-[10px] text-text-muted mb-2 font-bold uppercase tracking-widest">Recommendations</p>
              <div className="space-y-1.5">
                {hwRecommendations.slice(0, 6).map((rec, i) => {
                  const [key, val] = rec.split(': ');
                  if (!val) return null;
                  return (
                    <div key={i} className="flex items-center justify-between px-3 py-2 rounded-xl bg-bg-secondary border border-border text-xs">
                      <span className="text-text-secondary">{key.replace(/\./g, ' › ')}</span>
                      <span className="text-white font-mono">{val}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {hardware.gpuVendor === 'none' && hardware.ramTotalMB < 16384 && (
            <div className="p-4 rounded-2xl border border-warning/30 bg-warning/5 mb-5">
              <p className="text-xs text-[#fbbf24] font-semibold flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5" /> No dedicated GPU detected
              </p>
              <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
                Local models will run on CPU — slower, but perfectly fine for small 7–8B models.
                For speed, grab an API key from Anthropic, OpenAI, or Groq.
              </p>
            </div>
          )}

          <button
            onClick={() => setApplyHwConfig(!applyHwConfig)}
            className={`w-full flex items-center justify-between p-4 rounded-2xl border transition-all ${
              applyHwConfig
                ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                : 'border-border bg-bg-secondary hover:border-border-light'
            }`}
          >
            <div className="text-left">
              <p className="font-semibold text-white text-sm">Apply recommended settings</p>
              <p className="text-xs text-text-muted mt-0.5">
                {applyHwConfig ? 'TITAN will auto-tune for your hardware.' : 'You can change these in Settings later.'}
              </p>
            </div>
            <div className={`relative w-11 h-6 rounded-full transition-colors ${applyHwConfig ? 'bg-accent' : 'bg-bg-tertiary'}`}>
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${applyHwConfig ? 'left-5' : 'left-0.5'}`} />
            </div>
          </button>
        </>
      )}
    </div>,

    // ── Step 2: Provider (local) / Cloud Model (SaaS) ──
    cloudMode ? (
      <div key="cloud-model" className="w-full max-w-lg mx-auto">
        <StepBadge icon={Cloud}>TITAN Cloud</StepBadge>
        <h2 className="text-2xl font-semibold text-white mb-1">Pick Your Brain</h2>
        <p className="text-sm text-text-muted mb-6">
          Included with your subscription. Upgrade or downgrade anytime.
        </p>
        {cloudEmail && (
          <div className="mb-4 p-3 rounded-xl border border-accent/30 bg-accent/5">
            <p className="text-xs text-text-secondary">Signed in as <span className="text-white font-semibold">{cloudEmail}</span></p>
          </div>
        )}
        <p className="text-[10px] text-text-muted mb-2 font-bold uppercase tracking-widest">Free Tier</p>
        <div className="space-y-2 mb-5">
          {CLOUD_MODELS.free.map(m => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              className={`w-full text-left p-4 rounded-2xl border transition-all ${
                model === m.id ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-border bg-bg-secondary hover:border-border-light'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-white text-sm">{m.name}</p>
                  <p className="text-xs text-text-muted mt-0.5">{m.desc}</p>
                </div>
                <span className="px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-success/20 text-[#4ade80] uppercase">free</span>
              </div>
            </button>
          ))}
        </div>
        <p className="text-[10px] text-text-muted mb-2 font-bold uppercase tracking-widest">Premium <span className="normal-case font-normal opacity-60">— uses credits</span></p>
        <div className="space-y-2">
          {CLOUD_MODELS.paid.map(m => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              className={`w-full text-left p-4 rounded-2xl border transition-all ${
                model === m.id ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-border bg-bg-secondary hover:border-border-light'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-white text-sm">{m.name}</p>
                  <p className="text-xs text-text-muted mt-0.5">{m.desc}</p>
                </div>
                <span className={`px-2.5 py-0.5 text-[10px] font-bold rounded-full uppercase ${
                  m.badge === 'premium' ? 'bg-warning/20 text-[#fbbf24]' :
                  m.badge === 'flagship' ? 'bg-accent/20 text-accent-hover' :
                  'bg-border/50 text-text-secondary'
                }`}>{m.badge}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    ) : (
      <div key="provider" className="w-full max-w-lg mx-auto">
        <StepBadge icon={Key}>AI Provider</StepBadge>
        <h2 className="text-2xl font-semibold text-white mb-1">Choose Your Engine</h2>
        <p className="text-sm text-text-muted mb-6">
          Where should TITAN&apos;s brain live? Your machine, or someone else&apos;s?
        </p>
        <div className="grid grid-cols-2 gap-3 mb-6">
          {PROVIDERS.map(p => {
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                onClick={() => { setProvider(p.id); setModel(''); }}
                className={`text-left p-4 rounded-2xl border transition-all ${
                  provider === p.id
                    ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                    : 'border-border bg-bg-secondary hover:border-border-light'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="w-4 h-4 text-accent" />
                  <p className="font-semibold text-white text-sm">{p.name}</p>
                </div>
                <p className="text-xs text-text-muted leading-relaxed">{p.desc}</p>
              </button>
            );
          })}
        </div>
        {needsKey && (
          <div className="space-y-2">
            <label className="text-sm text-text-secondary">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={`Paste your ${selectedProvider?.name} API key`}
              className="w-full px-4 py-3 rounded-2xl border border-border bg-bg-secondary text-white placeholder-border-light focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-colors"
            />
            <p className="text-xs text-text-muted">
              Stored locally in ~/.titan/titan.json. Never leaves this machine except to talk to your provider.
            </p>
          </div>
        )}
        {provider === 'ollama' && (
          <div className="mt-4 p-4 rounded-2xl border border-success/30 bg-success/5">
            <p className="text-sm text-success font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> No API key needed
            </p>
            <p className="text-xs text-text-muted mt-1 leading-relaxed">
              Make sure Ollama is running. TITAN will auto-detect your models. If not, grab it from ollama.com.
            </p>
          </div>
        )}
        {hardware && hardware.gpuVendor === 'none' && hardware.ramTotalMB < 16384 && provider === 'ollama' && (
          <div className="mt-3 p-3 rounded-2xl border border-warning/30 bg-warning/5">
            <p className="text-xs text-[#fbbf24] font-semibold">CPU-only detected</p>
            <p className="text-xs text-text-muted mt-1">
              Large local models will be sluggish. Consider a cloud provider for daily driver work, or keep Ollama for offline tasks.
            </p>
          </div>
        )}
      </div>
    ),

    // ── Step 3: Model (local only) ──
    ...(!cloudMode ? [
      <div key="model" className="w-full max-w-lg mx-auto">
        <StepBadge icon={Cpu}>Model</StepBadge>
        <h2 className="text-2xl font-semibold text-white mb-1">Pick a Model</h2>
        <p className="text-sm text-text-muted mb-6">
          The bigger the model, the smarter — but also the hungrier. Choose wisely.
        </p>
        {models.length === 0 && provider === 'ollama' && (
          <div className="p-5 rounded-2xl border border-warning/30 bg-warning/5 mb-5">
            <p className="text-xs text-[#fbbf24] font-semibold mb-1">Your machine is… modest</p>
            <p className="text-xs text-text-muted leading-relaxed">
              None of our default models fit. Try typing a tiny one manually — e.g., <code className="text-white">ollama/tinyllama:1b</code>.
            </p>
          </div>
        )}
        <div className="space-y-2 mb-5">
          {models.map(m => (
            <button
              key={m}
              onClick={() => setModel(m)}
              className={`w-full text-left p-4 rounded-2xl border transition-all ${
                model === m ? 'border-accent bg-accent/10 ring-1 ring-accent/50' : 'border-border bg-bg-secondary hover:border-border-light'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${model === m ? 'bg-accent' : 'bg-text-muted'}`} />
                <p className="font-mono text-sm text-white">{m}</p>
              </div>
            </button>
          ))}
        </div>
        <div>
          <label className="text-sm text-text-muted">Or enter any model ID:</label>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={`${provider}/any-model-you-want`}
            className="w-full mt-2 px-4 py-3 rounded-2xl border border-border bg-bg-secondary text-white placeholder-border-light focus:outline-none focus:border-accent font-mono text-sm"
          />
          <p className="text-[11px] text-text-muted mt-1.5">
            TITAN works with <span className="text-white">any</span> LLM — local, cloud, weird, wonderful. If it speaks OpenAI-style or Ollama, it&apos;ll work.
          </p>
        </div>
      </div>
    ] : []),

    // ── Step 4: Profile ──
    <div key="profile" className="w-full max-w-lg mx-auto">
      <StepBadge icon={User}>Identity</StepBadge>
      <h2 className="text-2xl font-semibold text-white mb-1">Who Is TITAN?</h2>
      <p className="text-sm text-text-muted mb-6">
        Give your agent a name and a vibe. This is how TITAN introduces itself to the world.
      </p>
      <div className="space-y-6">
        <div>
          <label className="text-sm text-text-secondary mb-2 block">Agent Name</label>
          <input
            type="text"
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            placeholder="TITAN"
            className="w-full px-4 py-3 rounded-2xl border border-border bg-bg-secondary text-white placeholder-border-light focus:outline-none focus:border-accent text-lg font-semibold"
          />
          <p className="text-[11px] text-text-muted mt-1.5">
            This appears in chat, the Command Post, and anywhere TITAN signs its work.
          </p>
        </div>
        <div>
          <label className="text-sm text-text-secondary mb-3 block">Persona <span className="text-text-muted font-normal">— optional</span></label>
          <input
            type="text"
            placeholder="Search personas..."
            value={personaSearch}
            onChange={e => setPersonaSearch(e.target.value)}
            className="w-full mb-3 px-3 py-2 rounded-xl border border-border bg-bg-secondary text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
          <div className="grid grid-cols-2 gap-3 max-h-[280px] overflow-y-auto pr-1">
            {filteredPersonas.map(p => (
              <button
                key={p.id}
                onClick={() => setPersona(p.id)}
                className={`text-left p-4 rounded-2xl border transition-all ${
                  persona === p.id
                    ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                    : 'border-border bg-bg-secondary hover:border-border-light'
                }`}
              >
                <p className="font-semibold text-white text-sm">{p.name}</p>
                <p className="text-xs text-text-muted mt-1 line-clamp-2">{p.description}</p>
                <p className="text-[10px] text-text-muted mt-1 capitalize">{p.division}</p>
              </button>
            ))}
            {filteredPersonas.length === 0 && (
              <p className="col-span-2 text-sm text-text-muted text-center py-4">
                {personaSearch ? 'No personas match your search.' : 'Loading personas…'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>,

    // ── Step 5/6: Soma ──
    <div key="soma" className="w-full max-w-lg mx-auto">
      <StepBadge icon={Waves}>Soma Drives</StepBadge>
      <h2 className="text-2xl font-semibold text-white mb-1">Give TITAN Feelings</h2>
      <p className="text-sm text-text-muted mb-6">
        Soma is TITAN&apos;s homeostatic core. It gets curious, bored, hungry for data, and occasionally lonely.
        When a drive crosses a threshold, TITAN <em>proposes</em> work — you always approve before it acts.
      </p>

      <div className="grid grid-cols-3 gap-2 mb-5">
        {[
          { name: 'Purpose', desc: 'Wants to be useful', icon: Rocket },
          { name: 'Curiosity', desc: 'Wants to learn', icon: Telescope },
          { name: 'Hunger', desc: 'Wants data', icon: Flame },
          { name: 'Safety', desc: 'Wants stability', icon: Shield },
          { name: 'Social', desc: 'Wants to talk', icon: MessageCircle },
          { name: 'Rest', desc: 'Wants downtime', icon: Waves },
        ].map(d => (
          <div key={d.name} className="p-3 rounded-xl border border-border bg-bg-secondary text-center">
            <d.icon className="w-4 h-4 text-accent mx-auto mb-1.5" />
            <p className="text-[11px] font-semibold text-white">{d.name}</p>
            <p className="text-[10px] text-text-muted">{d.desc}</p>
          </div>
        ))}
      </div>

      <button
        onClick={() => setSomaEnabled(!somaEnabled)}
        className={`w-full flex items-center justify-between p-4 rounded-2xl border transition-all ${
          somaEnabled
            ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
            : 'border-border bg-bg-secondary hover:border-border-light'
        }`}
      >
        <div className="text-left">
          <p className="font-semibold text-white text-sm">Enable Soma drives</p>
          <p className="text-xs text-text-muted mt-0.5">
            {somaEnabled
              ? 'TITAN will propose work when its internal state shifts. Like a cat bringing you mice, but code.'
              : 'TITAN waits for your prompts only. Purely reactive.'}
          </p>
        </div>
        <div className={`relative w-11 h-6 rounded-full transition-colors ${somaEnabled ? 'bg-accent' : 'bg-bg-tertiary'}`}>
          <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${somaEnabled ? 'left-5' : 'left-0.5'}`} />
        </div>
      </button>
    </div>,

    // ── Last step: Launch ──
    <div key="launch" className="flex flex-col items-center text-center">
      <div className="relative mb-8">
        <FluidOrb audioLevel={0.15} speaker={orbSpeaker} size={200} />
      </div>
      <h2
        className="text-3xl font-bold mb-2 tracking-widest"
        style={{
          background: 'linear-gradient(90deg, #818cf8, #c084fc, #818cf8)',
          backgroundSize: '200% 100%',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          animation: 'shimmer 3s ease-in-out infinite',
        }}
      >
        MISSION CONTROL READY
      </h2>
      <p className="text-text-secondary mb-2 max-w-md">
        {agentName} is locked and loaded with{' '}
        <span className="text-white font-semibold">
          {cloudMode ? (allCloudModels.find(m => m.id === model)?.name || model) : model}
        </span>
        {cloudMode ? (
          <> via <span className="text-white font-semibold">TITAN Cloud</span>.</>
        ) : (
          <> via <span className="text-white font-semibold">{selectedProvider?.name || provider}</span>.</>
        )}
      </p>
      <p className="text-xs text-text-muted mb-6 max-w-sm">
        TITAN works with <span className="text-white">any</span> LLM you throw at it. If something breaks, it&apos;s probably the LLM&apos;s fault. (Just kidding. Mostly.)
      </p>

      <div className="grid grid-cols-4 gap-3 text-center max-w-lg w-full mb-8">
        {[
          { label: 'Skills', value: 143 },
          { label: 'Tools', value: 248 },
          { label: 'Providers', value: 36 },
          { label: 'Channels', value: 16 },
        ].map(({ label, value }) => (
          <div key={label} className="p-4 rounded-2xl bg-bg-secondary border border-border">
            <p className="text-2xl font-bold text-white"><AnimCounter target={value} /></p>
            <p className="text-[10px] text-text-muted mt-1 uppercase tracking-wider">{label}</p>
          </div>
        ))}
      </div>

      {somaEnabled && (
        <p className="text-xs text-accent-hover mb-4 flex items-center gap-2">
          <Activity size={12} /> Soma is online — {agentName} will propose work when it gets antsy.
        </p>
      )}

      <label
        className={`w-full max-w-lg p-4 mb-5 rounded-2xl border cursor-pointer transition-colors text-left ${
          telemetryOptIn ? 'border-accent/50 bg-accent/5' : 'border-border hover:border-accent/40 bg-bg-secondary/50'
        }`}
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={telemetryOptIn}
            onChange={(e) => setTelemetryOptIn(e.target.checked)}
            className="mt-1 w-4 h-4 accent-accent"
          />
          <div className="flex-1">
            <div className="text-sm font-semibold text-white mb-1">Help improve TITAN with anonymous stats</div>
            <div className="text-xs text-text-secondary leading-relaxed">
              OS, Node version, CPU/GPU model, RAM size, TITAN version.{' '}
              <span className="text-text-muted">Never: prompts, files, credentials, IP, or conversations.</span>{' '}
              <a href="https://github.com/Djtony707/TITAN/blob/main/PRIVACY.md" target="_blank" rel="noreferrer" className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                Privacy policy →
              </a>
            </div>
          </div>
        </div>
      </label>

      {error && (
        <div className="mb-4 p-3 rounded-2xl border border-error/50 bg-error/10 text-error text-sm w-full max-w-sm">
          {error}
        </div>
      )}
      <style>{`
        @keyframes shimmer {
          0%, 100% { background-position: -200% center; }
          50% { background-position: 200% center; }
        }
      `}</style>
    </div>,
  ];

  const stepLabels = cloudMode
    ? ['Welcome', 'Hardware', 'Model', 'Profile', 'Soma', 'Launch']
    : ['Welcome', 'Hardware', 'Provider', 'Model', 'Profile', 'Soma', 'Launch'];
  const isLast = step === steps.length - 1;

  if (completed) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-bg" role="status" aria-live="polite">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />
        <div className="relative z-10 flex flex-col items-center gap-5 text-center">
          <div className="w-20 h-20 rounded-full bg-accent/20 ring-2 ring-accent flex items-center justify-center text-accent text-4xl animate-bounce">
            <Rocket className="w-10 h-10" />
          </div>
          <div>
            <div className="text-2xl font-bold text-white">{agentName} is online</div>
            <div className="text-sm text-text-muted mt-1">Strapping in… opening Mission Control…</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-bg">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="relative z-10 w-full max-w-2xl mx-auto px-6">
        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {stepLabels.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-all duration-500 ${
                  i < step ? 'bg-accent text-white' : i === step ? 'bg-accent/20 text-accent ring-2 ring-accent' : 'bg-bg-tertiary text-text-muted'
                }`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
              >
                {i < step ? <CheckCircle2 size={14} /> : i + 1}
              </div>
              {i < stepLabels.length - 1 && (
                <div className={`w-8 h-0.5 transition-colors duration-500 ${i < step ? 'bg-accent' : 'bg-bg-tertiary'}`} style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }} />
              )}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="min-h-[400px] flex items-center justify-center" style={{ transition: 'all 0.5s cubic-bezier(0.22, 1, 0.36, 1)' }}>
          {steps[step]}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-10">
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={step === 0}
            className="flex items-center gap-2 px-5 py-2.5 text-sm text-text-secondary hover:text-white disabled:opacity-0 transition-all"
          >
            <ChevronLeft size={16} /> Back
          </button>

          {isLast ? (
            <button
              onClick={handleComplete}
              disabled={saving}
              className="flex items-center gap-2 px-8 py-3 text-sm font-bold text-white bg-accent hover:bg-[#5558e6] rounded-xl transition-all disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Sparkles size={16} className="animate-spin" /> Calibrating…
                </>
              ) : (
                <>
                  Launch Mission Control <Rocket size={16} />
                </>
              )}
            </button>
          ) : (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canAdvance()}
              className="flex items-center gap-2 px-8 py-3 text-sm font-bold text-white bg-accent hover:bg-[#5558e6] rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {step === 0 ? 'Begin Systems Check' : 'Continue'} <ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
