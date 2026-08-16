/**
 * CompanyPulse — v8 Slice 8: the team's social surface.
 *
 * Growth moments (the celebration feed) + the huddle digest, rendered like
 * a team space rather than a control panel. Data comes from the flag-gated
 * gateway endpoints; both are deterministic folds over the signed company
 * log, so refresh is cheap and honest.
 */
import { useCallback, useEffect, useState } from 'react';
import { PartyPopper, Sunrise, Loader2, RefreshCw, Sparkles, TrendingUp, UserPlus, UserMinus, Medal } from 'lucide-react';
import { getGrowthMoments, getHuddle, type GrowthMoment, type HuddleDigest } from '@/api/client';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const MOMENT_ICON: Record<GrowthMoment['kind'], typeof Sparkles> = {
  hired: UserPlus,
  'first-accept': Medal,
  lesson: Sparkles,
  streak: TrendingUp,
  retired: UserMinus,
};

export default function CompanyPulse() {
  const [moments, setMoments] = useState<GrowthMoment[] | null>(null);
  const [huddle, setHuddle] = useState<HuddleDigest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [g, h] = await Promise.all([getGrowthMoments(20), getHuddle(24)]);
      setMoments(g.moments);
      setHuddle(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the company');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="space-y-4" data-testid="company-pulse">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <PartyPopper className="w-5 h-5" aria-hidden />
          Team pulse
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          className="p-1.5 rounded hover:bg-white/10 transition-colors"
          aria-label="Refresh team pulse"
          disabled={loading}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <RefreshCw className="w-4 h-4" aria-hidden />}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-400" role="alert">{error}</div>
      )}

      {/* Huddle digest */}
      <section aria-label="Huddle digest" className="rounded-lg border border-white/10 p-3 space-y-2">
        <h3 className="text-sm font-medium flex items-center gap-2 opacity-80">
          <Sunrise className="w-4 h-4" aria-hidden /> Today&apos;s huddle
        </h3>
        {!huddle ? (
          <div className="text-sm opacity-60">Loading…</div>
        ) : huddle.agents.length === 0 && huddle.rosterChanges.length === 0 ? (
          <div className="text-sm opacity-60">Quiet day — no accepted work, open tasks, or new lessons yet.</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {huddle.agents.map(a => (
              <li key={a.agentId} className="flex items-baseline gap-2">
                <span className="font-medium">{a.displayName}</span>
                <span className="opacity-70">
                  {[
                    a.accepted > 0 ? `${a.accepted} accepted` : null,
                    a.open > 0 ? `${a.open} open` : null,
                    a.lessons > 0 ? `${a.lessons} lesson${a.lessons > 1 ? 's' : ''}` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
            {huddle.rosterChanges.length > 0 && (
              <li className="opacity-70 pt-1">Roster: {huddle.rosterChanges.join(' · ')}</li>
            )}
          </ul>
        )}
      </section>

      {/* Growth moments */}
      <section aria-label="Growth moments" className="rounded-lg border border-white/10 p-3 space-y-2">
        <h3 className="text-sm font-medium opacity-80">Growth moments</h3>
        {!moments ? (
          <div className="text-sm opacity-60">Loading…</div>
        ) : moments.length === 0 ? (
          <div className="text-sm opacity-60">
            The feed fills as your team works — first hires, first wins, lessons learned.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {moments.map(m => {
              const Icon = MOMENT_ICON[m.kind] ?? Sparkles;
              return (
                <li key={`${m.ts}-${m.agentId}-${m.kind}`} className="flex items-start gap-2 text-sm">
                  <Icon className="w-4 h-4 mt-0.5 shrink-0 opacity-70" aria-hidden />
                  <span className="flex-1">{m.text}</span>
                  <span className="opacity-50 text-xs whitespace-nowrap">{timeAgo(m.ts)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
