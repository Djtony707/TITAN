import { useEffect, useState } from 'react';
import {
  Save,
  CheckCircle,
  AlertCircle,
  Radio,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { getChannels, getChannelConfigs, updateChannelConfig } from '@/api/client';
import type { ChannelInfo, ChannelConfig } from '@/api/types';

interface ChannelDef {
  id: string;
  label: string;
  description: string;
  fields: Array<{ key: 'token' | 'apiKey'; label: string; placeholder: string }>;
}

const CHANNEL_DEFS: ChannelDef[] = [
  { id: 'discord', label: 'Discord', description: 'Discord bot via discord.js', fields: [{ key: 'token', label: 'Bot Token', placeholder: 'Bot token from Discord Developer Portal' }] },
  { id: 'telegram', label: 'Telegram', description: 'Telegram bot via Grammy', fields: [{ key: 'token', label: 'Bot Token', placeholder: 'Token from @BotFather' }] },
  { id: 'slack', label: 'Slack', description: 'Slack workspace via Bolt SDK', fields: [{ key: 'token', label: 'Bot Token', placeholder: 'xoxb-...' }, { key: 'apiKey', label: 'Signing Secret', placeholder: 'Signing secret from Slack app settings' }] },
  { id: 'whatsapp', label: 'WhatsApp', description: 'WhatsApp via Twilio', fields: [{ key: 'token', label: 'Auth Token', placeholder: 'Twilio auth token' }, { key: 'apiKey', label: 'Account SID', placeholder: 'Twilio account SID' }] },
  { id: 'googlechat', label: 'Google Chat', description: 'Google Chat spaces', fields: [{ key: 'token', label: 'Service Account Key', placeholder: 'JSON key path or content' }] },
  { id: 'matrix', label: 'Matrix', description: 'Matrix protocol (Element, etc.)', fields: [{ key: 'token', label: 'Access Token', placeholder: 'Matrix access token' }] },
  { id: 'signal', label: 'Signal', description: 'Signal messenger', fields: [{ key: 'token', label: 'API Token', placeholder: 'Signal API token' }] },
  { id: 'msteams', label: 'Microsoft Teams', description: 'MS Teams via Bot Framework', fields: [{ key: 'token', label: 'App Password', placeholder: 'Bot framework app password' }, { key: 'apiKey', label: 'App ID', placeholder: 'Bot framework app ID' }] },
  { id: 'irc', label: 'IRC', description: 'Internet Relay Chat', fields: [{ key: 'token', label: 'Password', placeholder: 'NickServ password (optional)' }] },
  { id: 'mattermost', label: 'Mattermost', description: 'Self-hosted team chat', fields: [{ key: 'token', label: 'Bot Token', placeholder: 'Mattermost bot access token' }] },
  { id: 'lark', label: 'Lark', description: 'Lark/Feishu messaging', fields: [{ key: 'token', label: 'App Token', placeholder: 'Lark app token' }, { key: 'apiKey', label: 'App Secret', placeholder: 'Lark app secret' }] },
  { id: 'email_inbound', label: 'Email (Inbound)', description: 'IMAP email webhook', fields: [{ key: 'token', label: 'IMAP Password', placeholder: 'IMAP password or app password' }] },
  { id: 'line', label: 'LINE', description: 'LINE messaging platform', fields: [{ key: 'token', label: 'Channel Access Token', placeholder: 'LINE channel access token' }, { key: 'apiKey', label: 'Channel Secret', placeholder: 'LINE channel secret' }] },
  { id: 'zulip', label: 'Zulip', description: 'Zulip team chat', fields: [{ key: 'apiKey', label: 'API Key', placeholder: 'Zulip API key' }] },
];

const DM_POLICIES = [
  { value: 'pairing', label: 'Pairing', desc: 'User must pair first' },
  { value: 'open', label: 'Open', desc: 'Anyone can DM' },
  { value: 'closed', label: 'Closed', desc: 'DMs disabled' },
] as const;

function ChannelCard({
  def,
  config,
  status,
  onSave,
  saving,
}: {
  def: ChannelDef;
  config: ChannelConfig;
  status?: ChannelInfo;
  onSave: (channelId: string, update: Partial<ChannelConfig>) => Promise<void>;
  saving: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(config.enabled);
  const [localToken, setLocalToken] = useState('');
  const [localApiKey, setLocalApiKey] = useState('');
  const [localDmPolicy, setLocalDmPolicy] = useState(config.dmPolicy);
  const [showToken, setShowToken] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [dirty, setDirty] = useState(false);

  const isSaving = saving === def.id;
  const isConnected = status?.status === 'connected';
  const hasToken = Boolean(config.token);
  const hasApiKey = Boolean(config.apiKey);

  const handleToggle = () => {
    setLocalEnabled(!localEnabled);
    setDirty(true);
  };

  const handleSave = async () => {
    const update: Partial<ChannelConfig> = { enabled: localEnabled, dmPolicy: localDmPolicy };
    if (localToken) update.token = localToken;
    if (localApiKey) update.apiKey = localApiKey;
    await onSave(def.id, update);
    setLocalToken('');
    setLocalApiKey('');
    setDirty(false);
  };

  const tokenField = def.fields.find((f) => f.key === 'token');
  const apiKeyField = def.fields.find((f) => f.key === 'apiKey');

  return (
    <div className="rounded-xl border border-[#27272a] bg-[#18181b]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-[#52525b]" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[#52525b]" />
          )}
          <div>
            <span className="text-sm font-medium text-[#fafafa]">{def.label}</span>
            <span className="ml-2 text-xs text-[#52525b]">{def.description}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isConnected && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#22c55e]/10 px-2.5 py-0.5 text-xs font-medium text-[#22c55e]">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
              Connected
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              config.enabled
                ? 'bg-[#6366f1]/10 text-[#818cf8]'
                : 'bg-[#52525b]/20 text-[#71717a]'
            }`}
          >
            {config.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[#27272a] px-4 py-4 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm text-[#a1a1aa]">Enabled</label>
            <button
              onClick={handleToggle}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                localEnabled ? 'bg-[#6366f1]' : 'bg-[#3f3f46]'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  localEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Token field */}
          {tokenField && (
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs text-[#71717a]">
                {tokenField.label}
                {hasToken && (
                  <span className="rounded bg-[#22c55e]/10 px-1.5 py-0.5 text-[10px] text-[#22c55e]">set</span>
                )}
              </label>
              <div className="relative">
                <input
                  id={`channel-${def.id}-token`}
                  name={`channel-${def.id}-token`}
                  type={showToken ? 'text' : 'password'}
                  value={localToken}
                  onChange={(e) => { setLocalToken(e.target.value); setDirty(true); }}
                  placeholder={hasToken ? '(configured — enter new value to change)' : tokenField.placeholder}
                  className="w-full rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2 pr-10 text-sm text-[#fafafa] outline-none focus:border-[#6366f1]"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#52525b] hover:text-[#a1a1aa]"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          {/* API Key field */}
          {apiKeyField && (
            <div>
              <label className="mb-1 flex items-center gap-2 text-xs text-[#71717a]">
                {apiKeyField.label}
                {hasApiKey && (
                  <span className="rounded bg-[#22c55e]/10 px-1.5 py-0.5 text-[10px] text-[#22c55e]">set</span>
                )}
              </label>
              <div className="relative">
                <input
                  id={`channel-${def.id}-api-key`}
                  name={`channel-${def.id}-api-key`}
                  type={showApiKey ? 'text' : 'password'}
                  value={localApiKey}
                  onChange={(e) => { setLocalApiKey(e.target.value); setDirty(true); }}
                  placeholder={hasApiKey ? '(configured — enter new value to change)' : apiKeyField.placeholder}
                  className="w-full rounded-lg border border-[#3f3f46] bg-[#09090b] px-3 py-2 pr-10 text-sm text-[#fafafa] outline-none focus:border-[#6366f1]"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#52525b] hover:text-[#a1a1aa]"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          {/* DM Policy */}
          <div>
            <label className="mb-1 block text-xs text-[#71717a]">DM Policy</label>
            <div className="flex gap-2">
              {DM_POLICIES.map((p) => (
                <button
                  key={p.value}
                  onClick={() => { setLocalDmPolicy(p.value); setDirty(true); }}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    localDmPolicy === p.value
                      ? 'border-[#6366f1] bg-[#6366f1]/10 text-[#818cf8]'
                      : 'border-[#3f3f46] text-[#71717a] hover:border-[#52525b]'
                  }`}
                  title={p.desc}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={isSaving || !dirty}
              className="flex items-center gap-2 rounded-lg bg-[#6366f1] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#6366f1]/80 disabled:opacity-50"
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

function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [configs, setConfigs] = useState<Record<string, ChannelConfig>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const load = async () => {
    try {
      const [ch, cfg] = await Promise.all([getChannels(), getChannelConfigs()]);
      setChannels(ch);
      setConfigs(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch channels');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async (channelId: string, update: Partial<ChannelConfig>) => {
    setSaving(channelId);
    try {
      await updateChannelConfig(channelId, update);
      const [ch, cfg] = await Promise.all([getChannels(), getChannelConfigs()]);
      setChannels(ch);
      setConfigs(cfg);
      const label = CHANNEL_DEFS.find((d) => d.id === channelId)?.label ?? channelId;
      showToast('success', `${label} settings saved (restart gateway to apply)`);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl border border-[#3f3f46] bg-[#18181b]" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-[#ef4444]/50 bg-[#18181b] p-6 text-center text-[#ef4444]">
        {error}
      </div>
    );
  }

  const defaultConfig: ChannelConfig = { enabled: false, allowFrom: [], dmPolicy: 'pairing' };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#6366f1]/10">
            <Radio className="h-4 w-4 text-[#818cf8]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[#fafafa]">Channels</h1>
            <p className="text-xs text-[#52525b]">
              Configure messaging channels — {channels.filter((c) => c.status === 'connected').length} connected
            </p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="flex items-center gap-1.5 rounded-lg border border-[#3f3f46] px-3 py-1.5 text-xs text-[#a1a1aa] hover:border-[#52525b] hover:text-[#fafafa]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
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
          {toast.type === 'success' ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          {toast.message}
        </div>
      )}

      {/* Webchat (always on) */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-[#52525b] mb-3">Built-in</p>
        <div className="rounded-xl border border-[#27272a] bg-[#18181b] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-[#fafafa]">WebChat</span>
            <span className="text-xs text-[#52525b]">HTTP/WebSocket — always enabled</span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#22c55e]/10 px-2.5 py-0.5 text-xs font-medium text-[#22c55e]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
            Connected
          </span>
        </div>
      </div>

      {/* Configurable channels */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-[#52525b] mb-3">Messaging Channels</p>
        <div className="space-y-2">
          {CHANNEL_DEFS.map((def) => {
            const cfg = configs[def.id] ?? defaultConfig;
            const st = channels.find((c) => c.name === def.id || c.type === def.id);
            return (
              <ChannelCard
                key={def.id}
                def={def}
                config={cfg}
                status={st}
                onSave={handleSave}
                saving={saving}
              />
            );
          })}
        </div>
      </div>

      {/* Info note */}
      <p className="text-xs text-[#52525b] text-center">
        Channel changes are saved to config. Restart the gateway to connect/disconnect channels.
      </p>
    </div>
  );
}

export default ChannelsPanel;
