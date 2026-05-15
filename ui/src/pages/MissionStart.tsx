/**
 * TITAN — Mission Start (v6.1.0-alpha.18)
 *
 * The friendly first-screen for chat-style missions.
 *
 *   1. **One-shot input** at the top — type a goal, hit Begin.
 *   2. **Templates gallery** — six always-on starter missions (research
 *      digest, inbox triage, code review, lead scout, market watch,
 *      creative prompts). Click a card → 3-step walkthrough modal
 *      (Customize → Schedule → Launch).
 *   3. **Examples row** — quick canned goals for one-off requests.
 *   4. **Past missions** link in the chrome.
 *
 * The Schedule step in the walkthrough lets the user pick a cadence
 * (Every 4 hours, Daily at 7am, etc.). alpha.18 ships the UI + the
 * first mission creation; the recurring auto-fire daemon lands in
 * the next session — see HANDOFF-2026-05-13.md.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createMission } from '@/api/missions';
import { DeskSurface } from '@/components/desk/DeskSurface';
import {
  MISSION_TEMPLATES,
  renderGoal,
  type MissionTemplate,
  type ScheduleOption,
} from '@/data/missionTemplates';
// v6.1.0-alpha.22 — sponsor footer is now a global AppShell mount.

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
  const [activeTemplate, setActiveTemplate] = useState<MissionTemplate | null>(null);
  const navigate = useNavigate();

  async function submit(g: string, playId?: string) {
    const trimmed = g.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { mission } = await createMission(trimmed, playId);
      navigate(`/mission/${mission.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center text-[#f3e9d0] overflow-y-auto" style={{ fontFamily: "'Georgia', serif" }}>
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(99,102,241,0.18)_0%,transparent_55%)]" />

      <div className="relative z-10 flex flex-col items-center gap-5 w-full max-w-5xl px-6 py-10 md:py-16">
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
          {/* v6.1.0-alpha.23 — back to the main canvas / spaces home. */}
          <button
            onClick={() => navigate('/space/home')}
            className="px-2 py-0.5 text-[10px] tracking-[0.18em] text-text-muted hover:text-text border border-border rounded-full transition-colors inline-flex items-center gap-1"
            title="Back to the canvas spaces"
          >
            🌌 Canvas
          </button>
        </div>

        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-center">
          What do you want done?
        </h1>

        <p className="text-text-secondary text-center max-w-xl">
          Tell me anything &mdash; a thank-you note, a birthday plan, a Q1 report.
          I'll put together a small <span className="text-text font-medium">team of AI helpers</span> and we'll chat as we go.
        </p>

        <form
          onSubmit={(e) => { e.preventDefault(); submit(goal); }}
          className="w-full max-w-3xl flex items-center gap-3 bg-bg-secondary/80 border border-border rounded-2xl px-4 py-3 backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,0.4)]"
        >
          <input
            autoFocus
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Try: Help me write a birthday speech for my mom"
            className="flex-1 bg-transparent outline-none text-text placeholder:text-text-muted/60 text-base px-1 py-2"
            disabled={submitting}
          />
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

        <div className="flex flex-wrap gap-2 justify-center max-w-2xl">
          <div className="w-full text-center text-[10px] uppercase tracking-widest text-text-muted mb-1">
            or one-shot examples
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

        {/* Templates gallery — always-on missions the user can schedule. */}
        <div className="w-full mt-10 flex flex-col gap-3">
          <div className="flex items-baseline justify-between border-b border-border pb-2">
            <h2 className="text-lg font-semibold tracking-tight">
              Always-on templates
              <span className="ml-2 text-[10px] uppercase tracking-widest text-text-muted">recurring missions</span>
            </h2>
            <span className="text-[11px] text-text-muted">click → 3 steps → launch</span>
          </div>
          <p className="text-text-secondary text-sm max-w-2xl">
            Pick a starter recipe, customize it, choose how often the team
            should run it, and TITAN keeps the agents on schedule. Each
            template walks you through three quick steps.
          </p>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 mt-2">
            {MISSION_TEMPLATES.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                onClick={() => setActiveTemplate(t)}
              />
            ))}
          </div>
        </div>
      </div>

      {activeTemplate && (
        <TemplateWalkthrough
          template={activeTemplate}
          onClose={() => setActiveTemplate(null)}
          onLaunch={async (goalText, scheduleId, playId) => {
            // Stash the chosen schedule under a localStorage key the
            // recurring-mission daemon (next ship) will pick up.
            try {
              const pending = JSON.parse(localStorage.getItem('titan-pending-schedules') ?? '[]') as Array<{ at: string; templateId: string; goal: string; scheduleId: string }>;
              pending.push({ at: new Date().toISOString(), templateId: activeTemplate.id, goal: goalText, scheduleId });
              localStorage.setItem('titan-pending-schedules', JSON.stringify(pending));
            } catch { /* ignore */ }
            setActiveTemplate(null);
            await submit(goalText, playId);
          }}
        />
      )}
    </div>
  );
}

// ── Template gallery card ──────────────────────────────────────────

function TemplateCard({ template, onClick }: { template: MissionTemplate; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left p-4 bg-bg-secondary/70 border border-border rounded-2xl hover:border-border-light hover:bg-bg-secondary transition-all relative overflow-hidden group"
    >
      <div
        className="absolute inset-x-0 top-0 h-1 opacity-80 group-hover:h-1.5 transition-all"
        style={{ background: `linear-gradient(90deg, ${template.accent.from}, ${template.accent.to})` }}
      />
      <div className="flex items-center gap-2 mb-2">
        <span className="text-2xl leading-none">{template.icon}</span>
        <span className="font-semibold text-sm text-text">{template.title}</span>
      </div>
      <p className="text-xs text-text-secondary leading-snug mb-3">{template.blurb}</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {template.schedules.slice(0, 2).map(s => (
          <span key={s.id} className="text-[10px] px-2 py-0.5 rounded-full bg-bg-tertiary/60 border border-border text-text-muted">
            {s.label}
          </span>
        ))}
        <span className="ml-auto text-[10px] uppercase tracking-widest text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
          Set up →
        </span>
      </div>
    </button>
  );
}

// ── Walkthrough modal ──────────────────────────────────────────────

function TemplateWalkthrough({
  template,
  onClose,
  onLaunch,
}: {
  template: MissionTemplate;
  onClose: () => void;
  onLaunch: (goalText: string, scheduleId: string, playId?: string) => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(template.fields.map(f => [f.key, f.defaultValue])),
  );
  const [schedule, setSchedule] = useState<ScheduleOption>(template.schedules[0]);
  const [launching, setLaunching] = useState(false);

  const renderedGoal = renderGoal(template, values);
  const canAdvance = step !== 1 || template.fields.every(f => (values[f.key] ?? '').trim().length > 0);

  async function launch() {
    if (launching) return;
    setLaunching(true);
    try {
      await onLaunch(renderedGoal, schedule.id, template.suggestedPlayId);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-deep/80 backdrop-blur-sm p-4 md:p-8"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl bg-bg-secondary border border-border rounded-2xl overflow-hidden flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent bar */}
        <div
          className="h-1"
          style={{ background: `linear-gradient(90deg, ${template.accent.from}, ${template.accent.to})` }}
        />
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <span className="text-2xl leading-none">{template.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{template.title}</div>
            <div className="text-[11px] text-text-muted">Step {step} of 3 · {step === 1 ? 'Customize' : step === 2 ? 'Schedule' : 'Launch'}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-bg-tertiary border border-border text-text-muted hover:text-text flex items-center justify-center text-sm" title="Close">✕</button>
        </div>

        {/* Progress dots */}
        <div className="px-5 py-2 flex items-center gap-2 border-b border-border/60">
          {[1, 2, 3].map(s => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${s <= step ? 'bg-gradient-to-r from-accent to-accent2' : 'bg-bg-tertiary'}`}
            />
          ))}
        </div>

        {/* Body */}
        <div className="p-5 max-h-[60vh] overflow-y-auto">
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div className="text-sm text-text-secondary">
                {template.blurb}
              </div>
              {template.fields.length === 0 && (
                <div className="text-sm text-text-muted italic">
                  This template runs as-is — no setup needed. Click <b className="text-text">Next</b> to pick a schedule.
                </div>
              )}
              {template.fields.map(f => (
                <label key={f.key} className="flex flex-col gap-1.5">
                  <span className="text-xs uppercase tracking-widest text-text-muted">{f.label}</span>
                  <input
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder ?? f.defaultValue}
                    className="px-3 py-2 bg-bg-tertiary border border-border rounded-lg text-sm text-text outline-none focus:border-accent"
                  />
                  {f.hint && <span className="text-[11px] text-text-muted">{f.hint}</span>}
                </label>
              ))}
              <div className="mt-2 px-3 py-2.5 bg-bg-tertiary/50 border border-border/60 rounded-lg">
                <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Preview goal</div>
                <div className="text-sm text-text leading-snug">{renderedGoal}</div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-text-secondary">
                How often should the team run this?
              </div>
              {template.schedules.map(s => {
                const active = s.id === schedule.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSchedule(s)}
                    className={`flex items-center justify-between p-3 rounded-xl border text-left transition-colors ${
                      active
                        ? 'bg-accent/10 border-accent/60 text-text'
                        : 'bg-bg-tertiary/40 border-border text-text-secondary hover:text-text hover:border-border-light'
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className="font-semibold text-sm">{s.label}</span>
                      <span className="text-[11px] text-text-muted">{s.cadence}</span>
                    </div>
                    <code className="text-[10px] font-mono text-text-muted">{s.cron}</code>
                  </button>
                );
              })}
              <div className="text-[11px] text-text-muted italic px-1 pt-1">
                The auto-fire daemon that re-runs missions on this cadence
                lands in the next ship. Today the first run starts
                immediately and the chosen schedule is remembered.
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-text-secondary">
                Quick recap before we kick off.
              </div>
              <div className="rounded-xl border border-border bg-bg-tertiary/40 p-4">
                <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">What I'll do</div>
                <div className="text-sm text-text leading-relaxed">{template.whatItDoes}</div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <div className="bg-bg-tertiary/40 border border-border rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Goal</div>
                  <div className="text-text leading-snug">{renderedGoal}</div>
                </div>
                <div className="bg-bg-tertiary/40 border border-border rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">Cadence</div>
                  <div className="text-text font-semibold">{schedule.label}</div>
                  <div className="text-text-muted text-[11px] mt-0.5">{schedule.cadence}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between bg-bg/40">
          <button
            onClick={() => (step > 1 ? setStep(s => s - 1) : onClose())}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text"
          >
            {step > 1 ? '← Back' : 'Cancel'}
          </button>
          {step < 3 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canAdvance}
              className="px-5 py-2 rounded-lg font-bold text-bg-deep bg-gradient-to-br from-accent to-accent2 disabled:opacity-50 text-sm"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={launch}
              disabled={launching}
              className="px-5 py-2 rounded-lg font-bold text-bg-deep bg-gradient-to-br from-accent to-accent2 disabled:opacity-50 text-sm"
            >
              {launching ? 'Launching…' : 'Launch first run 🚀'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
