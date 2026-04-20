import { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronLeft, Sparkles, Key, Cpu, User, Rocket, Cloud, Activity } from 'lucide-react';
import { FluidOrb } from '@/components/voice/FluidOrb';
import { apiFetch } from '@/api/client';
import type { PersonaMeta } from '@/api/types';

interface SetupWizardProps {
  onComplete: () => void;
}

const PROVIDERS = [
  { id: 'ollama', name: 'Ollama (Local)', desc: 'Free — run models on your own hardware', noKey: true },
  { id: 'anthropic', name: 'Anthropic', desc: 'Claude Opus, Sonnet, Haiku' },
  { id: 'openai', name: 'OpenAI', desc: 'GPT-4o, o1, o3-mini' },
  { id: 'google', name: 'Google', desc: 'Gemini 2.5 Pro, Flash' },
  { id: 'groq', name: 'Groq', desc: 'Ultra-fast LLaMA, Mixtral' },
  { id: 'openrouter', name: 'OpenRouter', desc: '290+ models, one key' },
  { id: 'deepseek', name: 'DeepSeek', desc: 'DeepSeek Chat, Reasoner' },
  { id: 'xai', name: 'xAI', desc: 'Grok-3, Grok-3-mini' },
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

// Cloud SaaS models — available via TITAN Cloud subscription
const CLOUD_MODELS = {
  free: [
    { id: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super', desc: 'Free — 120B MoE', badge: 'free' },
    { id: 'openrouter/nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano', desc: 'Free — fast 30B', badge: 'free' },
    { id: 'openrouter/z-ai/glm-4.5-air:free', name: 'GLM-4.5 Air', desc: 'Free — versatile', badge: 'free' },
  ],
  paid: [
    { id: 'openrouter/qwen/qwen3.5-397b-a17b', name: 'Qwen 3.5 397B', desc: 'Flagship MoE — best quality', badge: 'flagship' },
    { id: 'openrouter/openai/gpt-5.4', name: 'GPT-5.4', desc: 'OpenAI premium', badge: 'premium' },
    { id: 'openrouter/anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', desc: 'Anthropic premium', badge: 'premium' },
    { id: 'openrouter/google/gemini-3.1-pro', name: 'Gemini 3.1 Pro', desc: 'Google premium', badge: 'premium' },
    { id: 'openrouter/moonshotai/kimi-k2.5', name: 'Kimi K2.5', desc: 'Strong reasoning', badge: 'midrange' },
    { id: 'openrouter/deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', desc: 'Cost-effective', badge: 'midrange' },
    { id: 'openrouter/z-ai/glm-4.7-flash', name: 'GLM-4.7 Flash', desc: 'Fast agent model', badge: 'agent' },
  ],
};

const FEATURE_PILLS = [
  'Soma Drives',
  'Multi-Agent',
  'Deep Research',
  'Code Execution',
  'Smart Home',
  'Voice',
  'VRAM Orchestrator',
  'Mesh Networking',
];

/** Animated counter that counts from 0 to target */
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

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [agentName, setAgentName] = useState('TITAN');
  const [persona, setPersona] = useState('default');
  const [personas, setPersonas] = useState<PersonaMeta[]>([]);
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');
  const [pillsVisible, setPillsVisible] = useState(false);
  const [cloudMode, setCloudMode] = useState(false);
  const [cloudEmail, setCloudEmail] = useState('');
  const [somaEnabled, setSomaEnabled] = useState(false);

  const selectedProvider = PROVIDERS.find(p => p.id === provider);
  const needsKey = selectedProvider && !('noKey' in selectedProvider && selectedProvider.noKey);
  const models = DEFAULT_MODELS[provider] || [];
  const allCloudModels = [...CLOUD_MODELS.free, ...CLOUD_MODELS.paid];

  // Check if running in TITAN Cloud (SaaS) mode
  useEffect(() => {
    apiFetch('/api/cloud/config')
      .then(r => r.json())
      .then(d => {
        if (d.cloud) {
          setCloudMode(true);
          setCloudEmail(d.userEmail || '');
          setProvider('openrouter');  // Cloud uses OpenRouter via SaaS gateway
          // Default to first free model
          setModel(CLOUD_MODELS.free[0]?.id || '');
        }
      })
      .catch(() => {});
  }, []);

  // Fetch personas for the Profile step
  useEffect(() => {
    apiFetch('/api/personas')
      .then(r => r.json())
      .then(d => {
        if (d.personas) setPersonas(d.personas);
        if (d.active) setPersona(d.active);
      })
      .catch(() => {});
  }, []);

  // Staggered pill entrance on Welcome step
  useEffect(() => {
    if (step === 0) {
      const timer = setTimeout(() => setPillsVisible(true), 400);
      return () => clearTimeout(timer);
    }
    setPillsVisible(false);
  }, [step]);

  const canAdvance = () => {
    if (cloudMode) {
      // Cloud mode steps: 0=Welcome, 1=Model, 2=Profile, 3=Soma, 4=Launch
      switch (step) {
        case 0: return true;
        case 1: return !!model;
        case 2: return !!agentName;
        case 3: return true;
        default: return true;
      }
    }
    // Local mode steps: 0=Welcome, 1=Provider, 2=Model, 3=Profile, 4=Soma, 5=Launch
    switch (step) {
      case 0: return true;
      case 1: return !!provider && (!needsKey || apiKey.length > 5);
      case 2: return !!model;
      case 3: return !!agentName;
      case 4: return true;
      default: return true;
    }
  };

  const handleComplete = async () => {
    setSaving(true);
    setError('');
    try {
      // Switch persona if not default
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
      // Enable Soma if the user opted in. Done as a follow-up PATCH so onboarding
      // completion succeeds even if the organism config endpoint is unavailable.
      if (somaEnabled) {
        try {
          await apiFetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organism: { enabled: true } }),
          });
        } catch {
          // Non-fatal — user can flip the switch in Settings later.
        }
      }
      // Show the success screen briefly so the user has a clear handoff
      // from wizard → dashboard (instead of a blank screen while the chat
      // view lazy-loads). onComplete() mounts the main app.
      setCompleted(true);
      setTimeout(onComplete, 1400);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setSaving(false);
    }
  };

  // Select top personas for onboarding (default + a curated mix of divisions)
  const onboardingPersonas = personas.length > 0
    ? personas.slice(0, 10)
    : [];

  const lastStepIndex = cloudMode ? 4 : 5;
  const orbSize = step === 0 || step === lastStepIndex ? 200 : 0;
  const orbSpeaker = step === lastStepIndex ? 'assistant' : 'idle';

  const steps = [
    // ── Step 0: Welcome ── FluidOrb hero
    <div key="welcome" className="flex flex-col items-center text-center">
      <div className="relative mb-6" style={{ transition: 'all 0.6s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <FluidOrb audioLevel={0} speaker="idle" size={orbSize} />
      </div>
      <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">Welcome to TITAN 4.0</h1>
      <p className="text-lg text-text-secondary mb-2">The Intelligent Task Automation Network</p>
      <p className="text-sm text-text-muted max-w-md mb-8 leading-relaxed">
        143 skills, 248 tools, 36 providers, 16 channels — and a new homeostatic core
        called <span className="text-white font-medium">Soma</span> that gives TITAN its own sense of
        how it&apos;s doing. Let&apos;s get you set up in under a minute.
      </p>
      <div className="flex flex-wrap justify-center gap-3 mb-6">
        {FEATURE_PILLS.map((f, i) => (
          <span
            key={f}
            className="px-3 py-1.5 text-xs rounded-full border border-border text-text-secondary bg-bg-secondary"
            style={{
              opacity: pillsVisible ? 1 : 0,
              transform: pillsVisible ? 'translateY(0)' : 'translateY(8px)',
              transition: `all 0.4s cubic-bezier(0.22, 1, 0.36, 1) ${i * 80}ms`,
            }}
          >
            {f}
          </span>
        ))}
      </div>
    </div>,

    // ── Step 1: Provider (local) / Cloud Model Picker (SaaS) ──
    cloudMode ? (
    <div key="cloud-model" className="w-full max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Cloud className="w-6 h-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold text-white">Choose Your Model</h2>
          <p className="text-sm text-text-muted">Included with your TITAN Cloud subscription. Switch anytime.</p>
        </div>
      </div>
      {cloudEmail && (
        <div className="mb-4 p-3 rounded-xl border border-accent/30 bg-accent/5">
          <p className="text-xs text-text-secondary">Signed in as <span className="text-white font-medium">{cloudEmail}</span></p>
        </div>
      )}
      <p className="text-xs text-text-muted mb-2 font-medium uppercase tracking-wide">Free Models</p>
      <div className="space-y-2 mb-4">
        {CLOUD_MODELS.free.map(m => (
          <button
            key={m.id}
            onClick={() => setModel(m.id)}
            className={`w-full text-left p-4 rounded-xl border transition-all ${
              model === m.id
                ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                : 'border-border bg-bg-secondary hover:border-border-light'
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-white text-sm">{m.name}</p>
                <p className="text-xs text-text-muted mt-0.5">{m.desc}</p>
              </div>
              <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-success/20 text-[#4ade80] uppercase">free</span>
            </div>
          </button>
        ))}
      </div>
      <p className="text-xs text-text-muted mb-2 font-medium uppercase tracking-wide">Premium Models <span className="text-text-muted">— uses credits</span></p>
      <div className="space-y-2">
        {CLOUD_MODELS.paid.map(m => (
          <button
            key={m.id}
            onClick={() => setModel(m.id)}
            className={`w-full text-left p-4 rounded-xl border transition-all ${
              model === m.id
                ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                : 'border-border bg-bg-secondary hover:border-border-light'
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-white text-sm">{m.name}</p>
                <p className="text-xs text-text-muted mt-0.5">{m.desc}</p>
              </div>
              <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full uppercase ${
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
      <div className="flex items-center gap-3 mb-6">
        <Key className="w-6 h-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold text-white">Choose Your AI Provider</h2>
          <p className="text-sm text-text-muted">Where should TITAN's brain run?</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-6">
        {PROVIDERS.map(p => (
          <button
            key={p.id}
            onClick={() => { setProvider(p.id); setModel(''); }}
            className={`text-left p-4 rounded-xl border transition-all ${
              provider === p.id
                ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                : 'border-border bg-bg-secondary hover:border-border-light'
            }`}
          >
            <p className="font-medium text-white text-sm">{p.name}</p>
            <p className="text-xs text-text-muted mt-1">{p.desc}</p>
          </button>
        ))}
      </div>
      {needsKey && (
        <div className="space-y-2">
          <label className="text-sm text-text-secondary">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={`Paste your ${selectedProvider?.name} API key`}
            className="w-full px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white placeholder-border-light focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-colors"
          />
          <p className="text-xs text-text-muted">Stored locally in ~/.titan/titan.json. Never sent anywhere except to your provider.</p>
        </div>
      )}
      {provider === 'ollama' && (
        <div className="mt-4 p-4 rounded-xl border border-success/30 bg-success/5">
          <p className="text-sm text-success font-medium">No API key needed</p>
          <p className="text-xs text-text-muted mt-1">Make sure Ollama is running on this machine or your network. TITAN will auto-detect available models.</p>
        </div>
      )}
    </div>
    ),

    // ── Step 2: Model (local only — cloud mode skips this) ──
    ...(!cloudMode ? [
    <div key="model" className="w-full max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Cpu className="w-6 h-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold text-white">Pick a Model</h2>
          <p className="text-sm text-text-muted">You can switch models anytime from Settings.</p>
        </div>
      </div>
      <div className="space-y-2">
        {models.map(m => (
          <button
            key={m}
            onClick={() => setModel(m)}
            className={`w-full text-left p-4 rounded-xl border transition-all ${
              model === m
                ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                : 'border-border bg-bg-secondary hover:border-border-light'
            }`}
          >
            <p className="font-mono text-sm text-white">{m}</p>
          </button>
        ))}
      </div>
      <div className="mt-4">
        <label className="text-sm text-text-muted">Or enter a custom model ID:</label>
        <input
          type="text"
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder={`${provider}/model-name`}
          className="w-full mt-2 px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white placeholder-border-light focus:outline-none focus:border-accent font-mono text-sm"
        />
      </div>
    </div>
    ] : []),

    // ── Step 3: Profile ── with Persona selection from API
    <div key="profile" className="w-full max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <User className="w-6 h-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold text-white">Personalize Your Agent</h2>
          <p className="text-sm text-text-muted">Give TITAN a name and persona.</p>
        </div>
      </div>
      <div className="space-y-5">
        <div>
          <label className="text-sm text-text-secondary mb-2 block">Agent Name</label>
          <input
            type="text"
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            placeholder="TITAN"
            className="w-full px-4 py-3 rounded-xl border border-border bg-bg-secondary text-white placeholder-border-light focus:outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="text-sm text-text-secondary mb-3 block">Persona</label>
          <div className="grid grid-cols-2 gap-3 max-h-[260px] overflow-y-auto pr-1">
            {onboardingPersonas.map(p => (
              <button
                key={p.id}
                onClick={() => setPersona(p.id)}
                className={`text-left p-4 rounded-xl border transition-all ${
                  persona === p.id
                    ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
                    : 'border-border bg-bg-secondary hover:border-border-light'
                }`}
              >
                <p className="font-medium text-white text-sm">{p.name}</p>
                <p className="text-xs text-text-muted mt-1 line-clamp-2">{p.description}</p>
                <p className="text-[10px] text-text-muted mt-1 capitalize">{p.division}</p>
              </button>
            ))}
            {onboardingPersonas.length === 0 && (
              <p className="col-span-2 text-sm text-text-muted text-center py-4">Loading personas...</p>
            )}
          </div>
        </div>
      </div>
    </div>,

    // ── Step 4 (cloud) / Step 5 (local): Soma ── opt-in homeostatic drives
    <div key="soma" className="w-full max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Activity className="w-6 h-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold text-white">TITAN-Soma — Homeostatic Drives</h2>
          <p className="text-sm text-text-muted">New in 4.0. Off by default — opt in if you want it.</p>
        </div>
      </div>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary leading-relaxed">
          TITAN 4.0 has its own sense of how it&apos;s doing. Internal drives — <span className="text-white">purpose, curiosity, hunger, safety, social, rest</span> — drift
          over time. When they cross a threshold, Soma <span className="text-white">proposes</span> work
          to you (a research dig, a cleanup, a check-in). You stay in charge; TITAN just thinks for
          itself about what to ask.
        </p>
        <div className="p-4 rounded-xl border border-warning/30 bg-warning/5">
          <p className="text-xs text-[#fbbf24] font-medium mb-1">Opt-in feature</p>
          <p className="text-xs text-text-muted leading-relaxed">
            With Soma enabled, TITAN will surface unsolicited proposals in the Command Post feed
            and inject an ambient-state block into its system prompt. Every proposal still
            requires your approval before execution. You can flip this off anytime in Settings →
            Organism.
          </p>
        </div>
        <button
          onClick={() => setSomaEnabled(!somaEnabled)}
          className={`w-full flex items-center justify-between p-4 rounded-xl border transition-all ${
            somaEnabled
              ? 'border-accent bg-accent/10 ring-1 ring-accent/50'
              : 'border-border bg-bg-secondary hover:border-border-light'
          }`}
        >
          <div className="text-left">
            <p className="font-medium text-white text-sm">Enable Soma drives</p>
            <p className="text-xs text-text-muted mt-0.5">
              {somaEnabled ? 'TITAN will propose work based on its internal state.' : 'TITAN waits for your prompts only.'}
            </p>
          </div>
          <div
            className={`relative w-11 h-6 rounded-full transition-colors ${
              somaEnabled ? 'bg-accent' : 'bg-bg-tertiary'
            }`}
          >
            <div
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                somaEnabled ? 'left-5' : 'left-0.5'
              }`}
            />
          </div>
        </button>
      </div>
    </div>,

    // ── Last step: Launch ── Cinematic with FluidOrb + shimmer text + animated counters
    <div key="launch" className="flex flex-col items-center text-center">
      <div className="relative mb-6">
        <FluidOrb audioLevel={0.15} speaker={orbSpeaker} size={200} />
      </div>
      <h2
        className="text-3xl font-bold mb-3 tracking-widest"
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
      <p className="text-text-secondary mb-6 max-w-md">
        {agentName} is ready with <span className="text-white font-medium">{cloudMode ? (allCloudModels.find(m => m.id === model)?.name || model) : model}</span>{' '}
        {cloudMode ? (
          <>via <span className="text-white font-medium">TITAN Cloud</span>.</>
        ) : (
          <>via <span className="text-white font-medium">{selectedProvider?.name || provider}</span>.</>
        )}
      </p>
      <div className="grid grid-cols-4 gap-3 text-center max-w-lg w-full mb-8">
        <div className="p-4 rounded-xl bg-bg-secondary border border-border">
          <p className="text-2xl font-bold text-white"><AnimCounter target={143} /></p>
          <p className="text-xs text-text-muted mt-1">Skills</p>
        </div>
        <div className="p-4 rounded-xl bg-bg-secondary border border-border">
          <p className="text-2xl font-bold text-white"><AnimCounter target={248} /></p>
          <p className="text-xs text-text-muted mt-1">Tools</p>
        </div>
        <div className="p-4 rounded-xl bg-bg-secondary border border-border">
          <p className="text-2xl font-bold text-white"><AnimCounter target={36} /></p>
          <p className="text-xs text-text-muted mt-1">Providers</p>
        </div>
        <div className="p-4 rounded-xl bg-bg-secondary border border-border">
          <p className="text-2xl font-bold text-white"><AnimCounter target={16} /></p>
          <p className="text-xs text-text-muted mt-1">Channels</p>
        </div>
      </div>
      {somaEnabled && (
        <p className="text-xs text-accent-hover mb-4 flex items-center gap-2">
          <Activity size={12} /> Soma drives enabled — TITAN will propose work when its internal state shifts.
        </p>
      )}
      {error && (
        <div className="mb-4 p-3 rounded-xl border border-error/50 bg-error/10 text-error text-sm w-full max-w-sm">
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
    ? ['Welcome', 'Model', 'Profile', 'Soma', 'Launch']
    : ['Welcome', 'Provider', 'Model', 'Profile', 'Soma', 'Launch'];
  const isLast = step === steps.length - 1;

  if (completed) {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-bg"
        role="status"
        aria-live="polite"
      >
        <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />
        <div className="relative z-10 flex flex-col items-center gap-4 text-center">
          <div className="w-16 h-16 rounded-full bg-accent/20 ring-2 ring-accent flex items-center justify-center text-accent text-3xl">
            ✓
          </div>
          <div className="text-2xl font-semibold text-text">{agentName} is ready</div>
          <div className="text-sm text-text-muted">Opening your dashboard…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-bg">
      {/* Subtle grid background */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="relative z-10 w-full max-w-2xl mx-auto px-6">
        {/* Progress bar */}
        <div className="flex items-center justify-center gap-2 mb-10">
          {stepLabels.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium transition-all duration-500 ${
                  i < step
                    ? 'bg-accent text-white'
                    : i === step
                      ? 'bg-accent/20 text-accent ring-2 ring-accent'
                      : 'bg-bg-tertiary text-text-muted'
                }`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
              >
                {i < step ? '\u2713' : i + 1}
              </div>
              {i < stepLabels.length - 1 && (
                <div
                  className={`w-8 h-0.5 transition-colors duration-500 ${i < step ? 'bg-accent' : 'bg-bg-tertiary'}`}
                  style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content with smooth transition */}
        <div
          className="min-h-[400px] flex items-center justify-center"
          style={{ transition: 'all 0.5s cubic-bezier(0.22, 1, 0.36, 1)' }}
        >
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
              className="flex items-center gap-2 px-8 py-3 text-sm font-medium text-white bg-accent hover:bg-[#5558e6] rounded-xl transition-all disabled:opacity-50"
            >
              {saving ? (
                <>
                  <Sparkles size={16} className="animate-spin" /> Setting up...
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
              className="flex items-center gap-2 px-8 py-3 text-sm font-medium text-white bg-accent hover:bg-[#5558e6] rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Continue <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
