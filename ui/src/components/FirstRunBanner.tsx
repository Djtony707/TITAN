/**
 * FirstRunBanner — persistent top banner shown when no AI provider is configured.
 *
 * Polls /api/doctor/quick on mount + every 60 seconds. If no provider is usable,
 * renders a banner with an action button. Once a provider becomes usable, the
 * banner stays hidden for the rest of the session (no flicker on transient errors).
 *
 * The brief: "make TITAN work for any human." Without this, a new user has to
 * try chatting and hit a generic error before they realize they need to configure
 * something. This banner makes the unconfigured state visible immediately.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, X } from 'lucide-react';
import { apiFetch } from '@/api/client';

interface DoctorQuickResponse {
  ready: boolean;
  details?: string;
  providersConfigured?: number;
  suggestion?: string | null;
  action?: { type: string; target: string; label: string } | null;
}

export function FirstRunBanner() {
  const [state, setState] = useState<DoctorQuickResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [readyOnce, setReadyOnce] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await apiFetch('/api/doctor/quick');
        if (!res.ok) return;
        const data = (await res.json()) as DoctorQuickResponse;
        if (cancelled) return;
        setState(data);
        if (data.ready) setReadyOnce(true);
      } catch {
        // Network error — don't flash a banner for transient failures
      }
    };
    void check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Don't show: still loading, ever-was-ready, currently ready, or user dismissed
  if (!state || state.ready || readyOnce || dismissed) return null;

  const action = state.action;
  return (
    <div className="bg-amber-500/15 border-b border-amber-500/40 text-amber-100 px-4 py-2.5 flex items-center gap-3 text-[13px]">
      <AlertTriangle size={16} className="text-amber-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold">TITAN isn't fully set up yet.</span>
        {state.suggestion && <span className="opacity-90"> {state.suggestion}</span>}
      </div>
      {action && action.type === 'open' && (
        <Link
          to={action.target}
          className="px-3 py-1 rounded bg-amber-500/30 hover:bg-amber-500/50 text-amber-50 font-medium transition-colors flex-shrink-0"
        >
          {action.label}
        </Link>
      )}
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-200 hover:text-amber-50 flex-shrink-0"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
