import { AlertTriangle, RefreshCw, Settings, MessageSquarePlus, KeyRound, Clock } from 'lucide-react';
import { useNavigate } from 'react-router';

interface ChatErrorBannerProps {
  errorCode?: string;
  errorMessage?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const ERROR_META: Record<string, { icon: React.ReactNode; title: string; actions: string[] }> = {
  no_provider_configured: {
    icon: <Settings className="w-4 h-4" />,
    title: 'No AI provider configured',
    actions: ['open_settings'],
  },
  rate_limited: {
    icon: <Clock className="w-4 h-4" />,
    title: 'Rate limit hit',
    actions: ['retry', 'open_settings'],
  },
  context_too_long: {
    icon: <MessageSquarePlus className="w-4 h-4" />,
    title: 'Conversation too long',
    actions: ['new_chat'],
  },
  model_not_found: {
    icon: <Settings className="w-4 h-4" />,
    title: 'Model not found',
    actions: ['open_settings'],
  },
  auth_failed: {
    icon: <KeyRound className="w-4 h-4" />,
    title: 'API key rejected',
    actions: ['open_settings'],
  },
  timeout: {
    icon: <Clock className="w-4 h-4" />,
    title: 'Request timed out',
    actions: ['retry'],
  },
  upstream_error: {
    icon: <AlertTriangle className="w-4 h-4" />,
    title: 'Provider error',
    actions: ['retry', 'open_settings'],
  },
};

export function ChatErrorBanner({ errorCode, errorMessage, onRetry, onDismiss }: ChatErrorBannerProps) {
  const navigate = useNavigate();
  const meta = ERROR_META[errorCode || ''] || {
    icon: <AlertTriangle className="w-4 h-4" />,
    title: 'Something went wrong',
    actions: ['retry'],
  };

  return (
    <div className="mx-3 md:mx-4 mb-3 rounded-xl border border-error/30 bg-error/5 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-error shrink-0">{meta.icon}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-error">{meta.title}</p>
          {errorMessage && (
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">{errorMessage}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            {meta.actions.includes('retry') && onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                Try again
              </button>
            )}
            {meta.actions.includes('new_chat') && (
              <button
                onClick={() => {
                  onDismiss?.();
                  // Trigger new chat via a custom event that ChatView listens for
                  window.dispatchEvent(new CustomEvent('titan:new-chat'));
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text bg-bg-tertiary hover:bg-border rounded-lg transition-colors"
              >
                <MessageSquarePlus className="w-3 h-3" />
                New chat
              </button>
            )}
            {meta.actions.includes('open_settings') && (
              <button
                onClick={() => {
                  onDismiss?.();
                  navigate('/settings');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text bg-bg-tertiary hover:bg-border rounded-lg transition-colors"
              >
                <Settings className="w-3 h-3" />
                Open Settings
              </button>
            )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors ml-auto"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
