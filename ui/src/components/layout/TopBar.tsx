import { useState } from 'react';
import { Link } from 'react-router';
import { Settings, HelpCircle } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import { HelpPanel } from '@/components/help/HelpPanel';

// Friendly display names — kept in sync with MessageBubble.tsx
const MODEL_DISPLAY: Record<string, string> = {
  'deepseek-v3.1:671b-cloud': 'DeepSeek V3.1 671B ☁',
  'deepseek-v3.2:671b-cloud': 'DeepSeek V3.2 671B ☁',
  'glm-5:cloud': 'GLM-5 744B ☁',
  'kimi-k2.5:cloud': 'Kimi K2.5 ☁',
  'qwen3-coder-next:cloud': 'Qwen3 Coder 480B ☁',
  'qwen3.5:397b-cloud': 'Qwen 3.5 397B ☁',
  'devstral-2:cloud': 'Devstral 2 123B ☁',
  'nemotron-3-super:cloud': 'Nemotron 3 Super ☁',
  'gemini-3-flash-preview:latest': 'Gemini 3 Flash ☁',
  'gpt-oss:120b-cloud': 'GPT OSS 120B ☁',
  'qwen3.5:35b': 'Qwen 3.5 35B',
  'devstral-small-2': 'Devstral Small 2',
  'devstral-small-2:latest': 'Devstral Small 2',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-opus-4-20250514': 'Claude Opus 4',
  'gpt-4o': 'GPT-4o',
};

function friendlyModelName(model: string): string {
  const bare = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  return MODEL_DISPLAY[bare] ?? bare;
}

interface TopBarProps {
  children?: React.ReactNode;
}

export function TopBar({ children }: TopBarProps) {
  const { config, loading } = useConfig();
  const [helpOpen, setHelpOpen] = useState(false);

  const isHealthy = Boolean(config);

  return (
    <div className="flex items-center justify-between h-12 px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] flex-shrink-0">
      <div className="flex items-center gap-3">
        {children}
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              isHealthy ? 'bg-[var(--success)] animate-pulse' : 'bg-[var(--error)]'
            }`}
          />
          {loading ? (
            <span className="text-sm text-[var(--text-muted)]">Connecting...</span>
          ) : config ? (
            (() => {
              const model = config.model || config.agent?.model || '';
              const provider = model.includes('/') ? model.split('/')[0] : (config.provider || config.agent?.provider || 'ollama');
              const displayName = friendlyModelName(model);
              return (
                <span className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-[var(--text)]">{displayName || 'Unknown model'}</span>
                  <span className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">{provider}</span>
                </span>
              );
            })()
          ) : (
            <span className="text-sm text-[var(--error)]">Disconnected</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => setHelpOpen(true)}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title="Help"
        >
          <HelpCircle size={18} />
        </button>
        <Link
          to="/settings"
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          <Settings size={18} />
        </Link>
      </div>

      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
