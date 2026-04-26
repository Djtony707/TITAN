import { useEffect, useState, useCallback } from 'react';
import {
  Save, CheckCircle, AlertCircle, RefreshCw, Loader2, Zap,
  Bot, Network, Radio, Brain, Server, GraduationCap, Users, Globe,
  Shield, Puzzle, MessageSquare, Sparkles, Database, RotateCcw,
  Play, Square
} from 'lucide-react';
import { getConfig, updateConfig, apiFetch } from '@/api/client';
import { trackEvent } from '@/api/telemetry';

type RawConfig = Record<string, unknown>;

interface FeatureToggle {
  key: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  section: string;
  field: string;
  danger?: boolean;
}

const FEATURES: FeatureToggle[] = [
  {
    key: 'autonomy-mode',
    label: 'Autonomous Mode',
    description: 'TITAN acts without asking for approval on moderate-risk tools. Supervised = asks for dangerous ops. Locked = asks for everything.',
    icon: <Zap className="h-4 w-4" />,
    section: 'autonomy',
    field: 'mode',
    danger: true,
  },
  {
    key: 'autonomy-autoProposeGoals',
    label: 'Auto-Propose Goals',
    description: 'TITAN can create its own goals from drives, observations, and initiatives.',
    icon: <Sparkles className="h-4 w-4" />,
    section: 'autonomy',
    field: 'autoProposeGoals',
  },
  {
    key: 'autonomy-proactiveInitiative',
    label: 'Proactive Initiative',
    description: 'TITAN takes initiative on its own between user messages.',
    icon: <Radio className="h-4 w-4" />,
    section: 'autonomy',
    field: 'proactiveInitiative',
  },
  {
    key: 'selfMod-enabled',
    label: 'Self-Modification',
    description: 'Captures autonomous code changes and queues them for review.',
    icon: <Bot className="h-4 w-4" />,
    section: 'selfMod',
    field: 'enabled',
    danger: true,
  },
  {
    key: 'selfMod-autoPR',
    label: 'Auto-Open PRs',
    description: 'When specialists approve a self-mod, automatically open a GitHub PR.',
    icon: <GitHubIcon className="h-4 w-4" />,
    section: 'selfMod',
    field: 'autoPR',
  },
  {
    key: 'commandPost-enabled',
    label: 'Command Post',
    description: 'Org chart, agent registry, approvals, budgets, and goal tracking.',
    icon: <Server className="h-4 w-4" />,
    section: 'commandPost',
    field: 'enabled',
  },
  {
    key: 'mesh-enabled',
    label: 'Mesh Networking',
    description: 'Distributed TITAN nodes. Share tasks and models across machines.',
    icon: <Network className="h-4 w-4" />,
    section: 'mesh',
    field: 'enabled',
  },
  {
    key: 'autopilot-enabled',
    label: 'Autopilot',
    description: 'Nightly autonomous checks, goal reviews, and self-improvement runs.',
    icon: <Play className="h-4 w-4" />,
    section: 'autopilot',
    field: 'enabled',
  },
  {
    key: 'autopilot-selfInitiate',
    label: 'Autopilot Self-Initiate',
    description: 'Autopilot can create and start its own goals without human trigger.',
    icon: <Sparkles className="h-4 w-4" />,
    section: 'autopilot',
    field: 'selfInitiate',
  },
  {
    key: 'brain-enabled',
    label: 'Brain (Local Router)',
    description: 'Small local model routes tools instead of sending full schemas to the cloud LLM.',
    icon: <Brain className="h-4 w-4" />,
    section: 'brain',
    field: 'enabled',
  },
  {
    key: 'mcp-server-enabled',
    label: 'MCP Server',
    description: 'Expose TITAN tools as a Model Context Protocol server for other AI apps.',
    icon: <Puzzle className="h-4 w-4" />,
    section: 'mcp',
    field: 'serverEnabled',
  },
  {
    key: 'training-enabled',
    label: 'Model Training',
    description: 'Fine-tune local LoRA adapters from session history.',
    icon: <GraduationCap className="h-4 w-4" />,
    section: 'training',
    field: 'enabled',
  },
  {
    key: 'teams-enabled',
    label: 'Teams',
    description: 'Multi-user teams with roles, invites, and permissions.',
    icon: <Users className="h-4 w-4" />,
    section: 'teams',
    field: 'enabled',
  },
  {
    key: 'tunnel-enabled',
    label: 'Cloudflare Tunnel',
    description: 'Expose TITAN securely on the public internet via Cloudflare.',
    icon: <Globe className="h-4 w-4" />,
    section: 'tunnel',
    field: 'enabled',
  },
  {
    key: 'vault-enabled',
    label: 'Vault',
    description: 'Encrypted secret storage for API keys and credentials.',
    icon: <Shield className="h-4 w-4" />,
    section: 'vault',
    field: 'enabled',
  },
  {
    key: 'capsolver-enabled',
    label: 'CAPTCHA Solver',
    description: 'Automatically solve CAPTCHAs during web browsing.',
    icon: <Shield className="h-4 w-4" />,
    section: 'capsolver',
    field: 'enabled',
  },
  {
    key: 'deliberation-autoDetect',
    label: 'Auto-Deliberation',
    description: 'TITAN automatically deliberates on complex tasks before acting.',
    icon: <MessageSquare className="h-4 w-4" />,
    section: 'deliberation',
    field: 'autoDetect',
  },
  {
    key: 'selfImprove-autoApply',
    label: 'Auto-Apply Self-Improvements',
    description: 'Apply prompt and config improvements automatically without approval.',
    icon: <Sparkles className="h-4 w-4" />,
    section: 'selfImprove',
    field: 'autoApply',
  },
  {
    key: 'memory-vectorSearchEnabled',
    label: 'Vector Memory Search',
    description: 'Semantic search across episodic memories using embeddings.',
    icon: <Database className="h-4 w-4" />,
    section: 'memory',
    field: 'vectorSearchEnabled',
  },
];

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
      <div className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_4px_rgba(34,197,94,0.4)]" />
      ON
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
      <div className="h-1.5 w-1.5 rounded-full bg-border-light" />
      OFF
    </span>
  );
}

export default function AutonomyPanel() {
  const [config, setConfig] = useState<RawConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [pendingValues, setPendingValues] = useState<Record<string, boolean | string>>({});

  const showToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setConfig(cfg);
        setLoading(false);
      })
      .catch((e) => {
        showToast('error', e instanceof Error ? e.message : 'Failed to load config');
        setLoading(false);
      });
  }, [showToast]);

  const getValue = (section: string, field: string): boolean | string => {
    if (field === 'serverEnabled') {
      const mcp = (config as RawConfig)?.mcp as RawConfig | undefined;
      const server = mcp?.server as RawConfig | undefined;
      return Boolean(server?.enabled);
    }
    if (field === 'selfInitiate') {
      const ap = (config as RawConfig)?.autopilot as RawConfig | undefined;
      const goals = ap?.goals as RawConfig | undefined;
      return Boolean(goals?.selfInitiate);
    }
    const key = `${section}.${field}`;
    if (key in pendingValues) return pendingValues[key];
    const sec = (config as RawConfig)?.[section] as RawConfig | undefined;
    if (!sec) return false;
    return sec[field] as boolean | string;
  };

  const setValue = (section: string, field: string, value: boolean | string) => {
    const key = `${section}.${field}`;
    setPendingValues((prev) => ({ ...prev, [key]: value }));
    setChanged((prev) => new Set(prev).add(key));
  };

  const activeCount = FEATURES.filter((f) => {
    const v = getValue(f.section, f.field);
    return typeof v === 'boolean' ? v : v === 'autonomous';
  }).length;

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      for (const key of changed) {
        const [section, field] = key.split('.');
        const value = pendingValues[key];
        if (!body[section]) body[section] = {};
        if (field === 'serverEnabled') {
          if (!body.mcp) body.mcp = {};
          (body.mcp as RawConfig).server = { enabled: value };
        } else if (field === 'selfInitiate') {
          if (!body.autopilot) body.autopilot = {};
          (body.autopilot as RawConfig).goals = { selfInitiate: value };
        } else {
          (body[section] as RawConfig)[field] = value;
        }
      }

      const result = await updateConfig(body);
      setConfig(result);
      setPendingValues({});
      setChanged(new Set());
      trackEvent('autonomy_settings_saved', { changedCount: changed.size });
      showToast('success', `Saved ${changed.size} change${changed.size !== 1 ? 's' : ''}`);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      // Step 1: Request restart approval
      const reqRes = await apiFetch('/api/system/request-restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Settings change via Autonomy Panel', requestedBy: 'user' }),
      });
      if (!reqRes.ok) {
        const err = await reqRes.json().catch(() => ({ error: 'Request failed' }));
        showToast('error', err.error || 'Restart request failed');
        setRestarting(false);
        return;
      }
      const { approval } = await reqRes.json();

      // Step 2: Auto-approve the restart
      const apprRes = await apiFetch(`/api/command-post/approvals/${approval.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'user', note: 'Approved via Autonomy Panel' }),
      });
      if (!apprRes.ok) {
        const err = await apprRes.json().catch(() => ({ error: 'Approval failed' }));
        showToast('error', err.error || 'Restart approval failed');
        setRestarting(false);
        return;
      }

      showToast('info', 'TITAN is restarting...');
      trackEvent('titan_restart_initiated', { source: 'autonomy_panel' });

      // Step 3: Poll health until it comes back
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const healthRes = await apiFetch('/api/health');
          if (healthRes.ok) {
            clearInterval(poll);
            setRestarting(false);
            showToast('success', 'TITAN restarted successfully');
          }
        } catch {
          // still down
        }
        if (attempts > 30) {
          clearInterval(poll);
          setRestarting(false);
          showToast('error', 'Restart timed out — check Titan PC');
        }
      }, 2000);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Restart failed');
      setRestarting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-text">Autonomy & Features</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {activeCount} of {FEATURES.length} features active
          </p>
        </div>
        <div className="flex items-center gap-2">
          {changed.size > 0 && (
            <span className="rounded-full bg-accent/15 px-2.5 py-1 text-[10px] font-medium text-accent">
              {changed.size} unsaved
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || changed.size === 0}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
            toast.type === 'success'
              ? 'border-success/50 text-success'
              : toast.type === 'error'
                ? 'border-error/50 text-error'
                : 'border-accent/50 text-accent'
          }`}
        >
          {toast.type === 'success' ? <CheckCircle className="h-4 w-4" /> : toast.type === 'error' ? <AlertCircle className="h-4 w-4" /> : <RefreshCw className="h-4 w-4 animate-spin" />}
          {toast.message}
        </div>
      )}

      {/* Mode selector (special treatment) */}
      <div className="rounded-xl border border-border bg-bg-secondary p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-medium text-text">Autonomy Level</h3>
          <StatusBadge active={getValue('autonomy', 'mode') === 'autonomous'} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(['locked', 'supervised', 'autonomous'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setValue('autonomy', 'mode', mode)}
              className={`rounded-lg border p-3 text-left transition-all ${
                getValue('autonomy', 'mode') === mode
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:border-border-light'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text capitalize">{mode}</span>
                {mode === 'autonomous' && <span className="text-[9px] text-error">High</span>}
                {mode === 'supervised' && <span className="text-[9px] text-warning">Med</span>}
                {mode === 'locked' && <span className="text-[9px] text-success">Low</span>}
              </div>
              <p className="mt-1 text-[10px] text-text-muted leading-relaxed">
                {mode === 'locked' && 'Asks for approval on every tool call.'}
                {mode === 'supervised' && 'Auto-approves safe tools. Asks for dangerous ops.'}
                {mode === 'autonomous' && 'Full auto. Only asks for destructive/rare ops.'}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Feature toggles grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {FEATURES.filter((f) => f.field !== 'mode').map((feature) => {
          const value = getValue(feature.section, feature.field);
          const isActive = typeof value === 'boolean' ? value : false;
          const hasChanged = changed.has(`${feature.section}.${feature.field}`);
          return (
            <div
              key={feature.key}
              className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
                hasChanged ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-secondary'
              }`}
            >
              <div className={`mt-0.5 flex-shrink-0 rounded-lg p-2 ${isActive ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-muted'}`}>
                {feature.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text">{feature.label}</span>
                  <StatusBadge active={isActive} />
                </div>
                <p className="mt-0.5 text-[11px] text-text-muted leading-relaxed">{feature.description}</p>
              </div>
              <label className="flex-shrink-0 relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setValue(feature.section, feature.field, e.target.checked)}
                  className="sr-only peer"
                />
                <div className={`relative w-9 h-5 rounded-full transition-colors ${isActive ? 'bg-accent' : 'bg-border'}`}>
                  <div className={`absolute top-[2px] left-[2px] bg-white w-4 h-4 rounded-full transition-transform ${isActive ? 'translate-x-4' : 'translate-x-0'}`} />
                </div>
              </label>
            </div>
          );
        })}
      </div>

      {/* Restart section */}
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
        <div className="flex items-start gap-3">
          <RotateCcw className="h-4 w-4 text-warning mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-text">Restart TITAN</h3>
            <p className="mt-0.5 text-[11px] text-text-muted">
              Some feature changes require a full restart to take effect. This will briefly interrupt service.
            </p>
          </div>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="flex items-center gap-1.5 rounded-lg border border-warning/50 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
          >
            {restarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
        </div>
      </div>
    </div>
  );
}
