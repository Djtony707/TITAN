import { useEffect, useState } from 'react';
import {
  Save,
  CheckCircle,
  AlertCircle,
  Plug,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { getConfig, updateConfig, apiFetch } from '@/api/client';

interface ProviderStatus {
  configured: boolean;
  baseUrl?: string;
}

interface OAuthStatus {
  clientIdSet: boolean;
  clientSecretSet: boolean;
  connected?: boolean;
  email?: string;
}

interface ProviderDef {
  id: string;
  label: string;
  fieldKey: string;
  fieldType: 'key' | 'url';
  placeholder: string;
}

const llmProviders: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic', fieldKey: 'anthropicKey', fieldType: 'key', placeholder: 'sk-ant-...' },
  { id: 'openai', label: 'OpenAI', fieldKey: 'openaiKey', fieldType: 'key', placeholder: 'sk-...' },
  { id: 'google', label: 'Google AI', fieldKey: 'googleKey', fieldType: 'key', placeholder: 'AIza...' },
  { id: 'groq', label: 'Groq', fieldKey: 'groqKey', fieldType: 'key', placeholder: 'gsk_...' },
  { id: 'mistral', label: 'Mistral', fieldKey: 'mistralKey', fieldType: 'key', placeholder: 'API key' },
  { id: 'openrouter', label: 'OpenRouter', fieldKey: 'openrouterKey', fieldType: 'key', placeholder: 'sk-or-...' },
  { id: 'fireworks', label: 'Fireworks AI', fieldKey: 'fireworksKey', fieldType: 'key', placeholder: 'API key' },
  { id: 'xai', label: 'xAI (Grok)', fieldKey: 'xaiKey', fieldType: 'key', placeholder: 'xai-...' },
  { id: 'together', label: 'Together AI', fieldKey: 'togetherKey', fieldType: 'key', placeholder: 'API key' },
  { id: 'deepseek', label: 'DeepSeek', fieldKey: 'deepseekKey', fieldType: 'key', placeholder: 'sk-...' },
  { id: 'perplexity', label: 'Perplexity', fieldKey: 'perplexityKey', fieldType: 'key', placeholder: 'pplx-...' },
  { id: 'ollama', label: 'Ollama', fieldKey: 'ollamaUrl', fieldType: 'url', placeholder: 'http://localhost:11434' },
];

function StatusBadge({ configured }: { configured: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        configured
          ? 'bg-success/10 text-success'
          : 'bg-border-light/20 text-text-muted'
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${configured ? 'bg-success' : 'bg-border-light'}`} />
      {configured ? 'Configured' : 'Not configured'}
    </span>
  );
}

function ProviderCard({
  provider,
  configured,
  currentUrl,
  onSave,
  saving,
}: {
  provider: ProviderDef;
  configured: boolean;
  currentUrl?: string;
  onSave: (fieldKey: string, value: string) => Promise<void>;
  saving: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState(provider.fieldType === 'url' ? (currentUrl || '') : '');
  const [showSecret, setShowSecret] = useState(false);

  const isKey = provider.fieldType === 'key';
  const isSaving = saving === provider.id;

  return (
    <div className="rounded-xl border border-bg-tertiary bg-bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-text-muted" />
          ) : (
            <ChevronRight className="h-4 w-4 text-text-muted" />
          )}
          <span className="text-sm font-medium text-text">{provider.label}</span>
        </div>
        <StatusBadge configured={configured} />
      </button>

      {expanded && (
        <div className="border-t border-bg-tertiary px-4 py-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs text-text-muted">
              {isKey ? 'API Key' : 'Base URL'}
            </label>
            <div className="relative">
              <input
                id={`integration-${provider.id}`}
                name={`integration-${provider.id}`}
                type={isKey && !showSecret ? 'password' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={provider.placeholder}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 pr-10 text-sm text-text outline-none focus:border-accent"
              />
              {isKey && (
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              )}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={() => onSave(provider.fieldKey, value)}
              disabled={isSaving || !value}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IntegrationsPanel() {
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [oauth, setOAuth] = useState<OAuthStatus>({ clientIdSet: false, clientSecretSet: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // OAuth form state
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthSecret, setOauthSecret] = useState('');
  const [showOauthSecret, setShowOauthSecret] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg = await getConfig() as any;
        if (cfg.providers) setProviders(cfg.providers);
        if (cfg.oauth?.google) {
          const status = cfg.oauth.google as OAuthStatus;
          // Also check live connection status
          try {
            const res = await apiFetch('/api/auth/google/status');
            const gs = await res.json() as { connected: boolean; email?: string };
            status.connected = gs.connected;
            status.email = gs.email;
          } catch { /* ignore */ }
          setOAuth(status);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const handleGoogleConnect = () => {
    window.location.href = '/api/auth/google/start';
  };

  const handleGoogleDisconnect = async () => {
    try {
      await apiFetch('/api/auth/google/disconnect', { method: 'POST' });
      setOAuth((prev) => ({ ...prev, connected: false, email: undefined }));
      showToast('success', 'Google account disconnected');
    } catch {
      showToast('error', 'Failed to disconnect');
    }
  };

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const handleProviderSave = async (fieldKey: string, value: string) => {
    const providerId = llmProviders.find((p) => p.fieldKey === fieldKey)?.id || fieldKey;
    setSaving(providerId);
    try {
      await updateConfig({ [fieldKey]: value } as Partial<Record<string, unknown>>);
      // Refresh config to get updated status
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = await getConfig() as any;
      if (cfg.providers) setProviders(cfg.providers);
      showToast('success', `${llmProviders.find((p) => p.fieldKey === fieldKey)?.label || 'Provider'} saved`);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  const handleOAuthSave = async () => {
    setSaving('oauth');
    try {
      const payload: Record<string, string> = {};
      if (oauthClientId) payload.googleOAuthClientId = oauthClientId;
      if (oauthSecret) payload.googleOAuthClientSecret = oauthSecret;
      await updateConfig(payload as Partial<Record<string, unknown>>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = await getConfig() as any;
      if (cfg.oauth?.google) setOAuth(cfg.oauth.google);
      showToast('success', 'Google OAuth settings saved');
      setOauthClientId('');
      setOauthSecret('');
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
          <Plug className="h-4 w-4 text-accent-hover" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text">Integrations</h1>
          <p className="text-xs text-text-muted">Configure LLM providers and external service connections</p>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${
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

      {/* LLM Providers */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">LLM Providers</p>
        <div className="space-y-2">
          {llmProviders.map((provider) => {
            const status = providers[provider.id];
            const configured = provider.id === 'ollama'
              ? Boolean(status?.baseUrl)
              : Boolean(status?.configured);
            return (
              <ProviderCard
                key={provider.id}
                provider={provider}
                configured={configured}
                currentUrl={provider.fieldType === 'url' ? (status?.baseUrl || '') : undefined}
                onSave={handleProviderSave}
                saving={saving}
              />
            );
          })}
        </div>
      </div>

      {/* Google OAuth */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Google Services (OAuth)</p>
        <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-text">Google OAuth 2.0</h3>
              <p className="text-xs text-text-muted mt-0.5">
                {oauth.connected && oauth.email ? `Connected as ${oauth.email}` : 'Gmail, Drive, Calendar, Docs, Sheets, Tasks'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge configured={!!oauth.connected} />
              {oauth.clientIdSet && !oauth.connected && (
                <button
                  onClick={handleGoogleConnect}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/80 transition-colors"
                >
                  <Plug className="h-3.5 w-3.5" />
                  Connect Google
                </button>
              )}
              {oauth.connected && (
                <button
                  onClick={handleGoogleDisconnect}
                  className="flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  Disconnect
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-text-muted">Client ID</label>
            <input
              id="integration-google-client-id"
              name="integration-google-client-id"
              type="text"
              value={oauthClientId}
              onChange={(e) => setOauthClientId(e.target.value)}
              placeholder={oauth.clientIdSet ? '(configured)' : 'your-client-id.apps.googleusercontent.com'}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-text-muted">Client Secret</label>
            <div className="relative">
              <input
                id="integration-google-client-secret"
                name="integration-google-client-secret"
                type={showOauthSecret ? 'text' : 'password'}
                value={oauthSecret}
                onChange={(e) => setOauthSecret(e.target.value)}
                placeholder={oauth.clientSecretSet ? '(configured)' : 'GOCSPX-...'}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 pr-10 text-sm text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setShowOauthSecret(!showOauthSecret)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
              >
                {showOauthSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleOAuthSave}
              disabled={saving === 'oauth' || (!oauthClientId && !oauthSecret)}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {saving === 'oauth' ? 'Saving...' : 'Save OAuth Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default IntegrationsPanel;
