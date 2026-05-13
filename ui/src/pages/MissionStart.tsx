/**
 * TITAN — Mission Start (v6.1.0)
 *
 * The friendly first-screen for chat-style missions. One input. Voice
 * button placeholder (lights up in v6.1.1). Examples below to seed
 * intent. No setup, no model picker, no preconditions.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createMission } from '@/api/missions';

const EXAMPLES = [
  "Plan my mom's 70th birthday party",
  'Write a thank-you note to my landlord',
  'Summarize this long email I got',
  'Draft the Q1 investor update',
  'Review a code change',
];

export default function MissionStart() {
  const [goal, setGoal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(g: string) {
    const trimmed = g.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { mission } = await createMission(trimmed);
      navigate(`/mission/${mission.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-5 px-6 bg-bg text-text overflow-hidden">
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(99,102,241,0.18)_0%,transparent_55%)]" />

      <div className="relative z-10 flex flex-col items-center gap-5 w-full max-w-3xl">
        <div className="text-[11px] uppercase tracking-[0.3em] text-text-muted flex items-center gap-3">
          <span>
            <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent font-bold">TITAN</span>
            {' · '}MISSION CHAT
          </span>
          <button
            onClick={() => navigate('/mission/library')}
            className="px-2 py-0.5 text-[10px] tracking-[0.18em] text-text-muted hover:text-text border border-border rounded-full transition-colors"
            title="See your past missions"
          >
            Past missions →
          </button>
        </div>

        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-center">
          What do you want done?
        </h1>

        <p className="text-text-secondary text-center max-w-xl">
          Tell me anything &mdash; a thank-you note, a birthday plan, a Q1 report.
          I'll put together a small <span className="text-text font-medium">team of AI helpers</span> and we'll chat as we go.
          Voice is coming soon &mdash; for now, type away.
        </p>

        <form
          onSubmit={(e) => { e.preventDefault(); submit(goal); }}
          className="w-full flex items-center gap-3 bg-bg-secondary/80 border border-border rounded-2xl px-4 py-3 backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.4)]"
        >
          <input
            autoFocus
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Try: Help me write a birthday speech for my mom"
            className="flex-1 bg-transparent outline-none text-text placeholder:text-text-muted/60 text-base px-1 py-2"
            disabled={submitting}
          />
          {/* Voice button — placeholder for v6.1.1 */}
          <button
            type="button"
            disabled
            title="Voice is coming next release"
            className="relative w-10 h-10 rounded-full bg-bg-tertiary border border-border text-text-muted opacity-50 cursor-not-allowed flex items-center justify-center"
          >
            🎤
            <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-widest text-text-muted">
              soon
            </span>
          </button>
          <button
            type="submit"
            disabled={!goal.trim() || submitting}
            className="px-4 py-2 rounded-xl font-bold text-bg-deep bg-gradient-to-br from-accent to-accent2 shadow-[0_0_24px_rgba(99,102,241,0.5)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Forming…' : 'Begin'}
          </button>
        </form>

        {error && (
          <div className="text-error text-sm bg-error/10 border border-error/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <p className="text-text-muted text-xs">Type your mission. Hit Begin and the team gathers.</p>

        <div className="flex flex-wrap gap-2 justify-center max-w-2xl">
          <div className="w-full text-center text-[10px] uppercase tracking-widest text-text-muted mb-1">
            or try one of these
          </div>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => submit(ex)}
              disabled={submitting}
              className="px-3 py-2 text-xs text-text-secondary bg-bg-secondary/60 border border-border rounded-full hover:text-text hover:border-border-light transition-colors disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
