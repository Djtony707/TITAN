import { useEffect, useState, useCallback } from 'react';
import {
  Save,
  CheckCircle,
  AlertCircle,
  Eye,
  EyeOff,
  Cpu,
  Activity,
  Zap,
  Search,
  Shield,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { getConfig, updateConfig } from '@/api/client';

interface NvidiaConfig {
  enabled: boolean;
  apiKey: string;
  cuopt: { enabled: boolean; url: string };
  asr: { enabled: boolean; grpcUrl: string; healthUrl: string };
  openshell: { enabled: boolean; binaryPath: string; policyPath: string };
}

interface ServiceHealth {
  cuopt: 'unknown' | 'checking' | 'healthy' | 'unhealthy';
  asr: 'unknown' | 'checking' | 'healthy' | 'unhealthy';
  nim: 'unknown' | 'checking' | 'healthy' | 'unhealthy';
}

const DEFAULT_CONFIG: NvidiaConfig = {
  enabled: false,
  apiKey: '',
  cuopt: { enabled: false, url: 'http://localhost:5000' },
  asr: { enabled: false, grpcUrl: 'localhost:50051', healthUrl: 'http://localhost:9000' },
  openshell: { enabled: false, binaryPath: 'openshell', policyPath: '' },
};

function StatusDot({ status }: { status: 'unknown' | 'checking' | 'healthy' | 'unhealthy' }) {
  const colors = {
    unknown: 'bg-[#52525b]',
    checking: 'bg-[#eab308] animate-pulse',
    healthy: 'bg-[#22c55e]',
    unhealthy: 'bg-[#ef4444]',
  };
  const labels = {
    unknown: 'Not checked',
    checking: 'Checking...',
    healthy: 'Healthy',
    unhealthy: 'Unreachable',
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[#71717a]">
      <span className={`inline-block h-2 w-2 rounded-full ${colors[status]}`} />
      {labels[status]}
    </span>
  );
}

function SectionCard({
  title,
  description,
  icon: Icon,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  enabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border bg-[#18181b] transition-colors ${enabled ? 'border-[#76b900]/30' : 'border-[#27272a]'}`}>
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${enabled ? 'bg-[#76b900]/15' : 'bg-[#27272a]'}`}>
            <Icon className={`h-4.5 w-4.5 ${enabled ? 'text-[#76b900]' : 'text-[#52525b]'}`} />
          </div>
          <div>
            <h3 className="text-sm font-medium text-[#fafafa]">{title}</h3>
            <p className="text-xs text-[#52525b] mt-0.5">{description}</p>
          </div>
        </div>
        <button
          onClick={onToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-[#76b900]' : 'bg-[#3f3f46]'}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
      {enabled && (
        <div className="border-t border-[#27272a] px-5 py-4 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

function InputField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
  secret?: boolean;
}) {
  const [show, setShow] = useState(false);

  return (
    <div>
      <label className="mb-1 block text-xs text-[#71717a]">{label}</label>
      <div className="relative">
        <input
          type={secret && !show ? 'password' : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2 pr-10 text-sm text-[#fafafa] outline-none focus:border-[#76b900] transition-colors"
        />
        {secret && (
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#52525b] hover:text-[#a1a1aa]"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

function NvidiaPanel() {
  const [config, setConfig] = useState<NvidiaConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [health, setHealth] = useState<ServiceHealth>({ cuopt: 'unknown', asr: 'unknown', nim: 'unknown' });
  const [hasApiKey, setHasApiKey] = useState(false);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg = await getConfig() as any;
        if (cfg.nvidia) {
          setConfig({
            enabled: cfg.nvidia.enabled ?? false,
            apiKey: '', // Never send API key to client — use placeholder
            cuopt: {
              enabled: cfg.nvidia.cuopt?.enabled ?? false,
              url: cfg.nvidia.cuopt?.url ?? 'http://localhost:5000',
            },
            asr: {
              enabled: cfg.nvidia.asr?.enabled ?? false,
              grpcUrl: cfg.nvidia.asr?.grpcUrl ?? 'localhost:50051',
              healthUrl: cfg.nvidia.asr?.healthUrl ?? 'http://localhost:9000',
            },
            openshell: {
              enabled: cfg.nvidia.openshell?.enabled ?? false,
              binaryPath: cfg.nvidia.openshell?.binaryPath ?? 'openshell',
              policyPath: cfg.nvidia.openshell?.policyPath ?? '',
            },
          });
          setHasApiKey(cfg.nvidia.apiKeySet ?? false);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const checkHealth = useCallback(async () => {
    // Check cuOpt
    if (config.cuopt.enabled) {
      setHealth(h => ({ ...h, cuopt: 'checking' }));
      try {
        const res = await fetch(`/api/nvidia/health/cuopt`);
        const data = await res.json();
        setHealth(h => ({ ...h, cuopt: data.healthy ? 'healthy' : 'unhealthy' }));
      } catch {
        setHealth(h => ({ ...h, cuopt: 'unhealthy' }));
      }
    }

    // Check ASR
    if (config.asr.enabled) {
      setHealth(h => ({ ...h, asr: 'checking' }));
      try {
        const res = await fetch(`/api/nvidia/health/asr`);
        const data = await res.json();
        setHealth(h => ({ ...h, asr: data.healthy ? 'healthy' : 'unhealthy' }));
      } catch {
        setHealth(h => ({ ...h, asr: 'unhealthy' }));
      }
    }

    // Check NIM API
    if (hasApiKey || config.apiKey) {
      setHealth(h => ({ ...h, nim: 'checking' }));
      try {
        const res = await fetch(`/api/nvidia/health/nim`);
        const data = await res.json();
        setHealth(h => ({ ...h, nim: data.healthy ? 'healthy' : 'unhealthy' }));
      } catch {
        setHealth(h => ({ ...h, nim: 'unhealthy' }));
      }
    }
  }, [config.cuopt.enabled, config.asr.enabled, hasApiKey, config.apiKey]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload: any = {
        nvidia: {
          enabled: config.enabled,
          cuopt: config.cuopt,
          asr: config.asr,
          openshell: config.openshell,
        },
      };
      // Only send API key if user entered a new one
      if (config.apiKey) {
        payload.nvidia.apiKey = config.apiKey;
      }
      await updateConfig(payload);
      showToast('success', 'NVIDIA configuration saved');
      if (config.apiKey) {
        setHasApiKey(true);
        setConfig(c => ({ ...c, apiKey: '' }));
      }
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl border border-[#3f3f46] bg-[#18181b]" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#76b900]/15">
            <Cpu className="h-5 w-5 text-[#76b900]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[#fafafa]">NVIDIA</h1>
            <p className="text-xs text-[#52525b]">GPU-accelerated AI services — NIM, cuOpt, Nemotron-ASR, OpenShell</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={checkHealth}
            className="flex items-center gap-1.5 rounded-lg border border-[#3f3f46] px-3 py-1.5 text-xs text-[#a1a1aa] hover:bg-[#27272a] transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Check Health
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-[#76b900] px-4 py-1.5 text-xs font-medium text-black transition-colors hover:bg-[#76b900]/80 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${
            toast.type === 'success'
              ? 'border-[#22c55e]/50 text-[#22c55e]'
              : 'border-[#ef4444]/50 text-[#ef4444]'
          }`}
        >
          {toast.type === 'success' ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          {toast.message}
        </div>
      )}

      {/* Master toggle */}
      <div className={`rounded-xl border p-5 transition-colors ${config.enabled ? 'border-[#76b900]/30 bg-[#76b900]/5' : 'border-[#27272a] bg-[#18181b]'}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium text-[#fafafa]">Enable NVIDIA Skills</h2>
            <p className="text-xs text-[#52525b] mt-0.5">
              Load NVIDIA GPU-accelerated skills (cuOpt, AI-Q Research, etc.) when TITAN starts.
              Equivalent to setting <code className="text-[#76b900]/70 bg-[#76b900]/10 px-1 rounded">TITAN_NVIDIA=1</code>
            </p>
          </div>
          <button
            onClick={() => setConfig(c => ({ ...c, enabled: !c.enabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.enabled ? 'bg-[#76b900]' : 'bg-[#3f3f46]'}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${config.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </div>

      {/* NIM API Key */}
      <div className="rounded-xl border border-[#27272a] bg-[#18181b] p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Zap className="h-4 w-4 text-[#76b900]" />
            <div>
              <h3 className="text-sm font-medium text-[#fafafa]">NVIDIA NIM API</h3>
              <p className="text-xs text-[#52525b] mt-0.5">
                Cloud inference for Nemotron 3 Super and other NIM models
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusDot status={health.nim} />
            {hasApiKey && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#22c55e]/10 px-2.5 py-0.5 text-xs font-medium text-[#22c55e]">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
                Key configured
              </span>
            )}
          </div>
        </div>
        <InputField
          label="API Key"
          value={config.apiKey}
          onChange={(v) => setConfig(c => ({ ...c, apiKey: v }))}
          placeholder={hasApiKey ? '(configured — enter new key to replace)' : 'nvapi-...'}
          secret
        />
        <p className="text-[10px] text-[#52525b]">
          Get your key at{' '}
          <a href="https://build.nvidia.com" target="_blank" rel="noopener noreferrer" className="text-[#76b900] hover:underline inline-flex items-center gap-0.5">
            build.nvidia.com <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </p>
      </div>

      {/* cuOpt */}
      <SectionCard
        title="cuOpt Optimization"
        description="GPU-accelerated routing, scheduling, and mathematical programming (MILP/LP/QP)"
        icon={Activity}
        enabled={config.cuopt.enabled}
        onToggle={() => setConfig(c => ({ ...c, cuopt: { ...c.cuopt, enabled: !c.cuopt.enabled } }))}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[#71717a]">Service Status</span>
          <StatusDot status={health.cuopt} />
        </div>
        <InputField
          label="cuOpt Server URL"
          value={config.cuopt.url}
          onChange={(v) => setConfig(c => ({ ...c, cuopt: { ...c.cuopt, url: v } }))}
          placeholder="http://localhost:5000"
        />
        <p className="text-[10px] text-[#52525b]">
          Start cuOpt: <code className="bg-[#27272a] px-1.5 py-0.5 rounded text-[#a1a1aa]">docker compose -f docker-compose.nvidia.yml --profile cuopt up -d</code>
        </p>
      </SectionCard>

      {/* Nemotron-ASR */}
      <SectionCard
        title="Nemotron-ASR Streaming"
        description="NVIDIA speech recognition with 24ms median finalization — replaces faster-whisper for voice chat"
        icon={Search}
        enabled={config.asr.enabled}
        onToggle={() => setConfig(c => ({ ...c, asr: { ...c.asr, enabled: !c.asr.enabled } }))}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[#71717a]">Service Status</span>
          <StatusDot status={health.asr} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <InputField
            label="gRPC Address"
            value={config.asr.grpcUrl}
            onChange={(v) => setConfig(c => ({ ...c, asr: { ...c.asr, grpcUrl: v } }))}
            placeholder="localhost:50051"
          />
          <InputField
            label="Health Check URL"
            value={config.asr.healthUrl}
            onChange={(v) => setConfig(c => ({ ...c, asr: { ...c.asr, healthUrl: v } }))}
            placeholder="http://localhost:9000"
          />
        </div>
        <p className="text-[10px] text-[#52525b]">
          Start ASR: <code className="bg-[#27272a] px-1.5 py-0.5 rounded text-[#a1a1aa]">docker compose -f docker-compose.nvidia.yml --profile asr up -d</code>
        </p>
        <p className="text-[10px] text-[#52525b]">
          VRAM: ~3-4 GB. Set <code className="bg-[#27272a] px-1 rounded text-[#a1a1aa]">STT_ENGINE=nemotron-asr</code> in voice agent env.
        </p>
      </SectionCard>

      {/* OpenShell */}
      <SectionCard
        title="OpenShell Sandbox"
        description="NVIDIA secure sandbox runtime for code execution with declarative policy enforcement"
        icon={Shield}
        enabled={config.openshell.enabled}
        onToggle={() => setConfig(c => ({ ...c, openshell: { ...c.openshell, enabled: !c.openshell.enabled } }))}
      >
        <div className="grid grid-cols-2 gap-3">
          <InputField
            label="Binary Path"
            value={config.openshell.binaryPath}
            onChange={(v) => setConfig(c => ({ ...c, openshell: { ...c.openshell, binaryPath: v } }))}
            placeholder="openshell"
          />
          <InputField
            label="Policy File Path (optional)"
            value={config.openshell.policyPath}
            onChange={(v) => setConfig(c => ({ ...c, openshell: { ...c.openshell, policyPath: v } }))}
            placeholder="Auto-detected"
          />
        </div>
        <p className="text-[10px] text-[#52525b]">
          When enabled, code execution uses OpenShell instead of Docker. Set <code className="bg-[#27272a] px-1 rounded text-[#a1a1aa]">sandbox.engine: &quot;openshell&quot;</code> in config.
        </p>
      </SectionCard>

      {/* VRAM Budget */}
      <div className="rounded-xl border border-[#27272a] bg-[#18181b] p-5">
        <h3 className="text-sm font-medium text-[#fafafa] mb-3">VRAM Budget (RTX 5090, 32 GB)</h3>
        <div className="space-y-2">
          {[
            { label: 'Nemotron 3 Nano 30B', vram: '~24 GB', note: 'Full local inference' },
            { label: 'Nemotron 3 Nano 4B', vram: '~3 GB', note: 'Lightweight variant' },
            { label: 'Nemotron-ASR', vram: '~3-4 GB', note: 'Speech recognition' },
            { label: 'cuOpt', vram: '~2-4 GB', note: 'Optimization solver' },
          ].map(({ label, vram, note }) => (
            <div key={label} className="flex items-center justify-between py-1.5">
              <div>
                <span className="text-xs text-[#fafafa]">{label}</span>
                <span className="text-[10px] text-[#52525b] ml-2">{note}</span>
              </div>
              <span className="text-xs font-mono text-[#76b900]">{vram}</span>
            </div>
          ))}
          <div className="border-t border-[#27272a] pt-2 mt-2">
            <p className="text-[10px] text-[#52525b]">
              Recommended: Nano 4B + ASR + cuOpt = ~10 GB, leaving room for other models.
              Or use NIM cloud API for LLM inference (0 GB local).
            </p>
          </div>
        </div>
      </div>

      {/* Docker Compose hint */}
      <div className="rounded-xl border border-[#27272a] bg-[#18181b] p-5">
        <h3 className="text-sm font-medium text-[#fafafa] mb-2">Quick Start</h3>
        <div className="space-y-2 text-xs text-[#71717a]">
          <p>Start all NVIDIA services:</p>
          <code className="block bg-[#09090b] border border-[#27272a] rounded-lg px-3 py-2 text-[#a1a1aa] font-mono text-xs">
            docker compose -f docker-compose.nvidia.yml --profile all up -d
          </code>
          <p className="mt-2">Or start individual services:</p>
          <div className="space-y-1 font-mono text-[10px] text-[#52525b]">
            <p><span className="text-[#76b900]">cuopt:</span> --profile cuopt</p>
            <p><span className="text-[#76b900]">asr:</span> --profile asr (includes Riva bridge)</p>
            <p><span className="text-[#76b900]">voice:</span> --profile voice (ASR + bridge)</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default NvidiaPanel;
