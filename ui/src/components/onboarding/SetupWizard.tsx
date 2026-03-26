import { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronLeft, Sparkles, Key, Cpu, User, Rocket } from 'lucide-react';
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

const FEATURE_PILLS = ['Web Search', 'Code Execution', 'Smart Home', 'Email', 'Research', 'Voice'];

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
  const [error, setError] = useState('');
  const [pillsVisible, setPillsVisible] = useState(false);

  const selectedProvider = PROVIDERS.find(p => p.id === provider);
  const needsKey = selectedProvider && !('noKey' in selectedProvider && selectedProvider.noKey);
  const models = DEFAULT_MODELS[provider] || [];

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
    switch (step) {
      case 0: return true;
      case 1: return !!provider && (!needsKey || apiKey.length > 5);
      case 2: return !!model;
      case 3: return !!agentName;
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
          provider,
          apiKey: needsKey ? apiKey : undefined,
          model,
          agentName,
          persona,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Setup failed');
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setSaving(false);
    }
  };

  // Select top personas for onboarding (default + a curated mix of divisions)
  const onboardingPersonas = personas.length > 0
    ? personas.slice(0, 10)
    : [];

  const orbSize = step === 0 || step === 4 ? 200 : 0;
  const orbSpeaker = step === 4 ? 'assistant' : 'idle';

  const steps = [
    // ── Step 0: Welcome ── FluidOrb hero
    <div key="welcome" className="flex flex-col items-center text-center">
      <div className="relative mb-6" style={{ transition: 'all 0.6s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <FluidOrb audioLevel={0} speaker="idle" size={orbSize} />
      </div>
      <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">Welcome to TITAN</h1>
      <p className="text-lg text-[#a1a1aa] mb-2">The Intelligent Task Automation Network</p>
      <p className="text-sm text-[#71717a] max-w-md mb-8 leading-relaxed">
        Your autonomous AI agent with 110+ tools, 34 providers, 15 channels, and a very motivated attitude.
        Let's get you set up in under a minute.
      </p>
      <div className="flex flex-wrap justify-center gap-3 mb-6">
        {FEATURE_PILLS.map((f, i) => (
          <span
            key={f}
            className="px-3 py-1.5 text-xs rounded-full border border-[#3f3f46] text-[#a1a1aa] bg-[#18181b]"
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

    // ── Step 1: Provider ──
    <div key="provider" className="w-full max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Key className="w-6 h-6 text-[#6366f1]" />
        <div>
          <h2 className="text-xl font-semibold text-white">Choose Your AI Provider</h2>
          <p className="text-sm text-[#71717a]">Where should TITAN's brain run?</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-6">
        {PROVIDERS.map(p => (
          <button
            key={p.id}
            onClick={() => { setProvider(p.id); setModel(''); }}
            className={`text-left p-4 rounded-xl border transition-all ${
              provider === p.id
                ? 'border-[#6366f1] bg-[#6366f1]/10 ring-1 ring-[#6366f1]/50'
                : 'border-[#3f3f46] bg-[#18181b] hover:border-[#52525b]'
            }`}
          >
            <p className="font-medium text-white text-sm">{p.name}</p>
            <p className="text-xs text-[#71717a] mt-1">{p.desc}</p>
          </button>
        ))}
      </div>
      {needsKey && (
        <div className="space-y-2">
          <label className="text-sm text-[#a1a1aa]">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={`Paste your ${selectedProvider?.name} API key`}
            className="w-full px-4 py-3 rounded-xl border border-[#3f3f46] bg-[#18181b] text-white placeholder-[#52525b] focus:outline-none focus:border-[#6366f1] focus:ring-1 focus:ring-[#6366f1]/50 transition-colors"
          />
          <p className="text-xs text-[#52525b]">Stored locally in ~/.titan/titan.json. Never sent anywhere except to your provider.</p>
        </div>
      )}
      {provider === 'ollama' && (
        <div className="mt-4 p-4 rounded-xl border border-[#22c55e]/30 bg-[#22c55e]/5">
          <p className="text-sm text-[#22c55e] font-medium">No API key needed</p>
          <p className="text-xs text-[#71717a] mt-1">Make sure Ollama is running on this machine or your network. TITAN will auto-detect available models.</p>
        </div>
      )}
    </div>,

    // ── Step 2: Model ──
    <div key="model" className="w-full max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Cpu className="w-6 h-6 text-[#6366f1]" />
        <div>
          <h2 className="text-xl font-semibold text-white">Pick a Model</h2>
          <p className="text-sm text-[#71717a]">You can switch models anytime from Settings.</p>
        </div>
      </div>
      <div className="space-y-2">
        {models.map(m => (
          <button
            key={m}
            onClick={() => setModel(m)}
            className={`w-full text-left p-4 rounded-xl border transition-all ${
              model === m
                ? 'border-[#6366f1] bg-[#6366f1]/10 ring-1 ring-[#6366f1]/50'
                : 'border-[#3f3f46] bg-[#18181b] hover:border-[#52525b]'
            }`}
          >
            <p className="font-mono text-sm text-white">{m}</p>
          </button>
        ))}
      </div>
      <div className="mt-4">
        <label className="text-sm text-[#71717a]">Or enter a custom model ID:</label>
        <input
          type="text"
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder={`${provider}/model-name`}
          className="w-full mt-2 px-4 py-3 rounded-xl border border-[#3f3f46] bg-[#18181b] text-white placeholder-[#52525b] focus:outline-none focus:border-[#6366f1] font-mono text-sm"
        />
      </div>
    </div>,

    // ── Step 3: Profile ── with Persona selection from API
    <div key="profile" className="w-full max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <User className="w-6 h-6 text-[#6366f1]" />
        <div>
          <h2 className="text-xl font-semibold text-white">Personalize Your Agent</h2>
          <p className="text-sm text-[#71717a]">Give TITAN a name and persona.</p>
        </div>
      </div>
      <div className="space-y-5">
        <div>
          <label className="text-sm text-[#a1a1aa] mb-2 block">Agent Name</label>
          <input
            type="text"
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            placeholder="TITAN"
            className="w-full px-4 py-3 rounded-xl border border-[#3f3f46] bg-[#18181b] text-white placeholder-[#52525b] focus:outline-none focus:border-[#6366f1]"
          />
        </div>
        <div>
          <label className="text-sm text-[#a1a1aa] mb-3 block">Persona</label>
          <div className="grid grid-cols-2 gap-3 max-h-[260px] overflow-y-auto pr-1">
            {onboardingPersonas.map(p => (
              <button
                key={p.id}
                onClick={() => setPersona(p.id)}
                className={`text-left p-4 rounded-xl border transition-all ${
                  persona === p.id
                    ? 'border-[#6366f1] bg-[#6366f1]/10 ring-1 ring-[#6366f1]/50'
                    : 'border-[#3f3f46] bg-[#18181b] hover:border-[#52525b]'
                }`}
              >
                <p className="font-medium text-white text-sm">{p.name}</p>
                <p className="text-xs text-[#71717a] mt-1 line-clamp-2">{p.description}</p>
                <p className="text-[10px] text-[#52525b] mt-1 capitalize">{p.division}</p>
              </button>
            ))}
            {onboardingPersonas.length === 0 && (
              <p className="col-span-2 text-sm text-[#52525b] text-center py-4">Loading personas...</p>
            )}
          </div>
        </div>
      </div>
    </div>,

    // ── Step 4: Launch ── Cinematic with FluidOrb + shimmer text + animated counters
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
      <p className="text-[#a1a1aa] mb-6 max-w-md">
        {agentName} is ready with <span className="text-white font-medium">{model}</span> via{' '}
        <span className="text-white font-medium">{selectedProvider?.name || provider}</span>.
      </p>
      <div className="grid grid-cols-3 gap-4 text-center max-w-md w-full mb-8">
        <div className="p-4 rounded-xl bg-[#18181b] border border-[#3f3f46]">
          <p className="text-2xl font-bold text-white"><AnimCounter target={110} suffix="+" /></p>
          <p className="text-xs text-[#71717a] mt-1">Tools</p>
        </div>
        <div className="p-4 rounded-xl bg-[#18181b] border border-[#3f3f46]">
          <p className="text-2xl font-bold text-white"><AnimCounter target={34} /></p>
          <p className="text-xs text-[#71717a] mt-1">Providers</p>
        </div>
        <div className="p-4 rounded-xl bg-[#18181b] border border-[#3f3f46]">
          <p className="text-2xl font-bold text-white"><AnimCounter target={15} /></p>
          <p className="text-xs text-[#71717a] mt-1">Channels</p>
        </div>
      </div>
      {error && (
        <div className="mb-4 p-3 rounded-xl border border-[#ef4444]/50 bg-[#ef4444]/10 text-[#ef4444] text-sm w-full max-w-sm">
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

  const stepLabels = ['Welcome', 'Provider', 'Model', 'Profile', 'Launch'];
  const isLast = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#09090b]">
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
                    ? 'bg-[#6366f1] text-white'
                    : i === step
                      ? 'bg-[#6366f1]/20 text-[#6366f1] ring-2 ring-[#6366f1]'
                      : 'bg-[#27272a] text-[#52525b]'
                }`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)' }}
              >
                {i < step ? '\u2713' : i + 1}
              </div>
              {i < stepLabels.length - 1 && (
                <div
                  className={`w-8 h-0.5 transition-colors duration-500 ${i < step ? 'bg-[#6366f1]' : 'bg-[#27272a]'}`}
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
            className="flex items-center gap-2 px-5 py-2.5 text-sm text-[#a1a1aa] hover:text-white disabled:opacity-0 transition-all"
          >
            <ChevronLeft size={16} /> Back
          </button>

          {isLast ? (
            <button
              onClick={handleComplete}
              disabled={saving}
              className="flex items-center gap-2 px-8 py-3 text-sm font-medium text-white bg-[#6366f1] hover:bg-[#5558e6] rounded-xl transition-all disabled:opacity-50"
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
              className="flex items-center gap-2 px-8 py-3 text-sm font-medium text-white bg-[#6366f1] hover:bg-[#5558e6] rounded-xl transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Continue <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
