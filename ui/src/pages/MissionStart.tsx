/**
 * TITAN — Mission Start (v6.1.0-alpha.18 / beta.4 polish)
 *
 * The friendly first-screen for chat-style missions.
 *
 *   1. **Welcome card** — the "What's the mission?" prompt. Eyebrow /
 *      large title / helper / large textarea / primary CTA.
 *   2. **Templates gallery** — six always-on starter missions rendered
 *      as small leather-bound dossier cards with brass title plates.
 *      Click a card → 3-step walkthrough modal (Customize → Schedule
 *      → Launch).
 *   3. **Examples row** — quick canned goals for one-off requests.
 *   4. **Past missions** link in the chrome (top-right gutter leaves
 *      room for the fixed TopbarThemePicker at top:48 right:12).
 *
 * beta.4 — Wave 4 polish:
 *   - Mission textarea promoted to "main event" with generous padding,
 *     clear hierarchy (eyebrow / title / helper / textarea / CTA), and
 *     `var(--theme-metal)` brass button with `var(--theme-bolt)` text.
 *   - Template cards re-skinned as leather dossiers with brass title
 *     plates that lift on hover. Wood/leather background from
 *     `--theme-leather` / `--theme-leather-edge` so each theme reskins.
 *   - Examples row demoted to a calm secondary band.
 *   - Every color now flows from `var(--theme-*)` with safe fallbacks.
 *   - Top chrome leaves a 260px right gutter for TopbarThemePicker.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createMission } from '@/api/missions';
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

// Theme tokens — fallbacks keep the page usable if no theme is loaded.
const FONT_DISPLAY = "var(--theme-font-display, 'Iowan Old Style', 'Charter', Georgia, serif)";
const FONT_MONO = "var(--theme-font-mono, 'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace)";
const PAPER = 'var(--theme-paper, #f3e9d0)';
const INK_SOFT = 'var(--theme-ink-soft, #a0a8d0)';
const METAL = 'var(--theme-metal, #c4a35a)';
const METAL_BRIGHT = 'var(--theme-metal-bright, #f3d27a)';
const METAL_DARK = 'var(--theme-metal-dark, #8a6a3a)';
const BOLT = 'var(--theme-bolt, #2a1808)';
const LEATHER = 'var(--theme-leather, #4a2818)';
const LEATHER_EDGE = 'var(--theme-leather-edge, #2a1408)';
const LEATHER_STITCH = 'var(--theme-leather-stitch, #d4a060)';
const BG_BASE = 'var(--theme-bg-base, #1a1235)';
const BG_GRAIN = 'var(--theme-bg-grain, #0e0820)';
const BG_VIGNETTE = 'var(--theme-bg-vignette, rgba(0,0,0,0.6))';
const SHADOW = 'var(--theme-shadow, rgba(0,0,0,0.55))';
const ACCENT = 'var(--theme-accent, #c45a30)';

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
    <div
      className="fixed inset-0 flex flex-col items-center overflow-y-auto"
      style={{
        color: PAPER,
        fontFamily: FONT_DISPLAY,
        background: `radial-gradient(120% 80% at 50% -10%, ${BG_GRAIN} 0%, ${BG_BASE} 60%, ${BG_BASE} 100%)`,
      }}
    >
      {/* Vignette + ambient glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(circle at 50% 12%, ${ACCENT}22 0%, transparent 55%)` }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: `inset 0 0 240px 60px ${BG_VIGNETTE}` }}
      />

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-5xl px-6 py-10 md:py-14">
        {/* Top chrome — leaves 260px right gutter for TopbarThemePicker (right:12 + width:238). */}
        <div
          className="w-full flex items-center"
          style={{ paddingRight: 260 }}
        >
          <div
            className="flex items-center gap-3 text-[11px] uppercase tracking-[0.3em]"
            style={{ color: INK_SOFT, fontFamily: FONT_MONO }}
          >
            <span style={{ color: METAL_BRIGHT, fontWeight: 700 }}>TITAN</span>
            <span style={{ opacity: 0.6 }}>·</span>
            <span>MISSION CONTROL</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ChromeLink onClick={() => navigate('/mission/library')} title="See your past missions">
              Past missions →
            </ChromeLink>
            <ChromeLink onClick={() => navigate('/space/home')} title="Back to the canvas spaces">
              🌌 Canvas
            </ChromeLink>
          </div>
        </div>

        {/* ── Welcome card — the main event ────────────────────────────── */}
        <section
          className="relative w-full max-w-3xl rounded-3xl overflow-hidden"
          style={{
            background: `linear-gradient(180deg, ${LEATHER} 0%, ${LEATHER_EDGE} 100%)`,
            border: `1px solid ${LEATHER_EDGE}`,
            boxShadow: `0 30px 80px ${SHADOW}, inset 0 1px 0 ${METAL}33`,
            padding: '36px 36px 28px',
          }}
        >
          {/* Brass corner stitches */}
          <CornerStitch position="tl" />
          <CornerStitch position="tr" />
          <CornerStitch position="bl" />
          <CornerStitch position="br" />

          {/* Eyebrow */}
          <div
            className="text-[10px] uppercase tracking-[0.4em] mb-3"
            style={{ color: METAL, fontFamily: FONT_MONO, fontWeight: 600 }}
          >
            ◆ New Mission
          </div>

          {/* Title */}
          <h1
            className="text-4xl md:text-5xl tracking-tight"
            style={{
              color: PAPER,
              fontFamily: FONT_DISPLAY,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              textShadow: `0 2px 12px ${SHADOW}`,
            }}
          >
            What's the mission?
          </h1>

          {/* Helper */}
          <p
            className="mt-3 text-[15px] leading-relaxed max-w-xl"
            style={{ color: INK_SOFT }}
          >
            Tell me anything — a thank-you note, a birthday plan, a Q1 report.
            I&rsquo;ll assemble a small team of AI specialists and we&rsquo;ll work it
            out together.
          </p>

          {/* Textarea + CTA */}
          <form
            onSubmit={(e) => { e.preventDefault(); submit(goal); }}
            className="mt-6 flex flex-col gap-3"
          >
            <textarea
              autoFocus
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Try: Help me write a birthday speech for my mom"
              rows={3}
              disabled={submitting}
              className="w-full resize-none outline-none rounded-2xl px-5 py-4 text-base leading-relaxed"
              style={{
                background: `${BG_BASE}80`,
                color: PAPER,
                border: `1px solid ${METAL}44`,
                fontFamily: FONT_DISPLAY,
                boxShadow: `inset 0 2px 8px ${SHADOW}`,
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  submit(goal);
                }
              }}
            />

            <div className="flex items-center justify-between gap-3">
              <div
                className="text-[11px] tracking-wide"
                style={{ color: INK_SOFT, fontFamily: FONT_MONO }}
              >
                ⌘↵ to dispatch · voice coming soon
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled
                  title="Voice is coming next release"
                  className="w-11 h-11 rounded-full flex items-center justify-center cursor-not-allowed"
                  style={{
                    background: `${BG_BASE}66`,
                    border: `1px solid ${METAL}33`,
                    color: INK_SOFT,
                    opacity: 0.55,
                  }}
                >
                  🎤
                </button>
                <button
                  type="submit"
                  disabled={!goal.trim() || submitting}
                  className="px-6 h-11 rounded-xl font-bold text-sm tracking-wide transition-transform"
                  style={{
                    background: goal.trim() && !submitting
                      ? `linear-gradient(180deg, ${METAL_BRIGHT} 0%, ${METAL} 60%, ${METAL_DARK} 100%)`
                      : `${METAL_DARK}66`,
                    color: BOLT,
                    border: `1px solid ${METAL_DARK}`,
                    boxShadow: goal.trim() && !submitting
                      ? `0 6px 18px ${SHADOW}, inset 0 1px 0 ${METAL_BRIGHT}`
                      : 'none',
                    cursor: goal.trim() && !submitting ? 'pointer' : 'not-allowed',
                    fontFamily: FONT_DISPLAY,
                    letterSpacing: '0.04em',
                  }}
                  onMouseDown={(e) => { if (goal.trim() && !submitting) e.currentTarget.style.transform = 'translateY(1px)'; }}
                  onMouseUp={(e) => { e.currentTarget.style.transform = ''; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = ''; }}
                >
                  {submitting ? 'Dispatching…' : 'Start mission →'}
                </button>
              </div>
            </div>
          </form>

          {error && (
            <div
              className="mt-4 text-sm rounded-lg px-3 py-2"
              style={{
                color: '#ffb4a8',
                background: '#5a1a1a55',
                border: '1px solid #8a3a3a',
              }}
            >
              {error}
            </div>
          )}
        </section>

        {/* ── Quick examples (calm secondary band) ─────────────────────── */}
        <div className="w-full max-w-3xl flex flex-col items-center gap-3">
          <div
            className="text-[10px] uppercase tracking-[0.35em]"
            style={{ color: INK_SOFT, fontFamily: FONT_MONO }}
          >
            — or try a one-shot —
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => submit(ex)}
                disabled={submitting}
                className="px-3 py-1.5 text-xs rounded-full transition-colors disabled:opacity-50"
                style={{
                  background: `${LEATHER_EDGE}99`,
                  color: PAPER,
                  border: `1px solid ${METAL}33`,
                  fontFamily: FONT_DISPLAY,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = `${METAL}88`; e.currentTarget.style.background = `${LEATHER}`; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = `${METAL}33`; e.currentTarget.style.background = `${LEATHER_EDGE}99`; }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        {/* ── Templates gallery — leather-dossier cards ────────────────── */}
        <section className="w-full mt-4 flex flex-col gap-4">
          <header
            className="flex items-baseline justify-between pb-3"
            style={{ borderBottom: `1px solid ${METAL}33` }}
          >
            <h2
              className="text-xl tracking-tight"
              style={{ color: PAPER, fontFamily: FONT_DISPLAY, fontWeight: 600 }}
            >
              Always-on templates
              <span
                className="ml-3 text-[10px] uppercase tracking-[0.3em]"
                style={{ color: INK_SOFT, fontFamily: FONT_MONO }}
              >
                recurring missions
              </span>
            </h2>
            <span
              className="text-[11px] tracking-wide"
              style={{ color: INK_SOFT, fontFamily: FONT_MONO }}
            >
              click → 3 steps → launch
            </span>
          </header>

          <p
            className="text-sm leading-relaxed max-w-2xl"
            style={{ color: INK_SOFT }}
          >
            Pick a starter recipe, customize it, choose how often the team
            should run it, and TITAN keeps the agents on schedule.
          </p>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 mt-2">
            {MISSION_TEMPLATES.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                onClick={() => setActiveTemplate(t)}
              />
            ))}
          </div>
        </section>

        <div className="h-8" />
      </div>

      {activeTemplate && (
        <TemplateWalkthrough
          template={activeTemplate}
          onClose={() => setActiveTemplate(null)}
          onLaunch={async (goalText, scheduleId, playId) => {
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

// ── Top-chrome link button ─────────────────────────────────────────

function ChromeLink({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-3 py-1 text-[10px] uppercase tracking-[0.2em] rounded-full transition-colors"
      style={{
        color: INK_SOFT,
        border: `1px solid ${METAL}33`,
        background: 'transparent',
        fontFamily: FONT_MONO,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = PAPER; e.currentTarget.style.borderColor = `${METAL}99`; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = INK_SOFT; e.currentTarget.style.borderColor = `${METAL}33`; }}
    >
      {children}
    </button>
  );
}

// ── Brass corner stitch ───────────────────────────────────────────

function CornerStitch({ position }: { position: 'tl' | 'tr' | 'bl' | 'br' }) {
  const pos: React.CSSProperties = { position: 'absolute' };
  if (position === 'tl') { pos.top = 10; pos.left = 10; }
  if (position === 'tr') { pos.top = 10; pos.right = 10; }
  if (position === 'bl') { pos.bottom = 10; pos.left = 10; }
  if (position === 'br') { pos.bottom = 10; pos.right = 10; }
  return (
    <div
      style={{
        ...pos,
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: METAL,
        boxShadow: `0 0 6px ${METAL_BRIGHT}, inset 0 1px 0 ${METAL_BRIGHT}`,
        opacity: 0.7,
        pointerEvents: 'none',
      }}
    />
  );
}

// ── Template gallery card — leather-bound dossier ─────────────────

function TemplateCard({ template, onClick }: { template: MissionTemplate; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="text-left rounded-2xl relative overflow-hidden transition-all"
      style={{
        background: `linear-gradient(180deg, ${LEATHER} 0%, ${LEATHER_EDGE} 100%)`,
        border: `1px solid ${hover ? METAL : LEATHER_EDGE}`,
        boxShadow: hover
          ? `0 14px 36px ${SHADOW}, inset 0 1px 0 ${METAL}55`
          : `0 6px 18px ${SHADOW}, inset 0 1px 0 ${METAL}22`,
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        padding: '14px 16px 14px',
      }}
    >
      {/* Brass title plate */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-md mb-3"
        style={{
          background: `linear-gradient(180deg, ${METAL_BRIGHT} 0%, ${METAL} 55%, ${METAL_DARK} 100%)`,
          border: `1px solid ${METAL_DARK}`,
          boxShadow: `inset 0 1px 0 ${METAL_BRIGHT}aa, 0 1px 3px ${SHADOW}`,
          color: BOLT,
        }}
      >
        <span className="text-base leading-none">{template.icon}</span>
        <span
          className="text-xs uppercase tracking-[0.16em] truncate"
          style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, letterSpacing: '0.12em' }}
        >
          {template.title}
        </span>
      </div>

      <p
        className="text-[13px] leading-snug mb-3"
        style={{ color: PAPER, opacity: 0.88 }}
      >
        {template.blurb}
      </p>

      <div className="flex items-center gap-1.5 flex-wrap">
        {template.schedules.slice(0, 2).map(s => (
          <span
            key={s.id}
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{
              background: `${LEATHER_EDGE}cc`,
              color: PAPER,
              border: `1px solid ${LEATHER_STITCH}55`,
              fontFamily: FONT_MONO,
              opacity: 0.85,
            }}
          >
            {s.label}
          </span>
        ))}
        <span
          className="ml-auto text-[10px] uppercase tracking-[0.2em] transition-opacity"
          style={{
            color: METAL_BRIGHT,
            fontFamily: FONT_MONO,
            opacity: hover ? 1 : 0,
          }}
        >
          Set up →
        </span>
      </div>
    </button>
  );
}

// ── Walkthrough modal — theme-aware ───────────────────────────────

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

  const inputStyle: React.CSSProperties = {
    background: `${BG_BASE}aa`,
    color: PAPER,
    border: `1px solid ${METAL}33`,
    fontFamily: FONT_DISPLAY,
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-4 md:p-8"
      style={{ background: `${BG_GRAIN}cc` }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: `linear-gradient(180deg, ${LEATHER} 0%, ${LEATHER_EDGE} 100%)`,
          border: `1px solid ${METAL}55`,
          boxShadow: `0 40px 100px ${SHADOW}, inset 0 1px 0 ${METAL}55`,
          color: PAPER,
          fontFamily: FONT_DISPLAY,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Brass strip */}
        <div
          style={{
            height: 4,
            background: `linear-gradient(90deg, ${METAL_DARK}, ${METAL_BRIGHT}, ${METAL_DARK})`,
          }}
        />

        {/* Header */}
        <div
          className="flex items-center gap-3 px-5 py-3"
          style={{ borderBottom: `1px solid ${METAL}22` }}
        >
          <span className="text-2xl leading-none">{template.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate" style={{ color: PAPER }}>{template.title}</div>
            <div className="text-[11px]" style={{ color: INK_SOFT, fontFamily: FONT_MONO }}>
              Step {step} of 3 · {step === 1 ? 'Customize' : step === 2 ? 'Schedule' : 'Launch'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm"
            style={{ background: `${BG_BASE}66`, border: `1px solid ${METAL}33`, color: INK_SOFT }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Progress dots */}
        <div
          className="px-5 py-2 flex items-center gap-2"
          style={{ borderBottom: `1px solid ${METAL}11` }}
        >
          {[1, 2, 3].map(s => (
            <div
              key={s}
              className="h-1 flex-1 rounded-full transition-colors"
              style={{
                background: s <= step
                  ? `linear-gradient(90deg, ${METAL}, ${METAL_BRIGHT})`
                  : `${BG_BASE}66`,
              }}
            />
          ))}
        </div>

        {/* Body */}
        <div className="p-5 max-h-[60vh] overflow-y-auto">
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <div className="text-sm" style={{ color: INK_SOFT }}>{template.blurb}</div>
              {template.fields.length === 0 && (
                <div className="text-sm italic" style={{ color: INK_SOFT }}>
                  This template runs as-is — no setup needed. Click <b style={{ color: PAPER }}>Next</b> to pick a schedule.
                </div>
              )}
              {template.fields.map(f => (
                <label key={f.key} className="flex flex-col gap-1.5">
                  <span
                    className="text-[10px] uppercase tracking-[0.2em]"
                    style={{ color: METAL, fontFamily: FONT_MONO, fontWeight: 600 }}
                  >
                    {f.label}
                  </span>
                  <input
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder ?? f.defaultValue}
                    className="px-3 py-2 rounded-lg text-sm outline-none"
                    style={inputStyle}
                  />
                  {f.hint && <span className="text-[11px]" style={{ color: INK_SOFT }}>{f.hint}</span>}
                </label>
              ))}
              <div
                className="mt-2 px-3 py-2.5 rounded-lg"
                style={{ background: `${BG_BASE}66`, border: `1px solid ${METAL}22` }}
              >
                <div
                  className="text-[10px] uppercase tracking-[0.2em] mb-1"
                  style={{ color: METAL, fontFamily: FONT_MONO }}
                >
                  Preview goal
                </div>
                <div className="text-sm leading-snug" style={{ color: PAPER }}>{renderedGoal}</div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-3">
              <div className="text-sm" style={{ color: INK_SOFT }}>How often should the team run this?</div>
              {template.schedules.map(s => {
                const active = s.id === schedule.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSchedule(s)}
                    className="flex items-center justify-between p-3 rounded-xl text-left transition-colors"
                    style={{
                      background: active ? `${METAL}1f` : `${BG_BASE}55`,
                      border: `1px solid ${active ? METAL : `${METAL}22`}`,
                      color: active ? PAPER : INK_SOFT,
                    }}
                  >
                    <div className="flex flex-col">
                      <span className="font-semibold text-sm" style={{ color: PAPER }}>{s.label}</span>
                      <span className="text-[11px]" style={{ color: INK_SOFT, fontFamily: FONT_MONO }}>{s.cadence}</span>
                    </div>
                    <code className="text-[10px]" style={{ color: INK_SOFT, fontFamily: FONT_MONO }}>{s.cron}</code>
                  </button>
                );
              })}
              <div
                className="text-[11px] italic px-1 pt-1"
                style={{ color: INK_SOFT }}
              >
                The auto-fire daemon that re-runs missions on this cadence
                lands in the next ship. Today the first run starts
                immediately and the chosen schedule is remembered.
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-3">
              <div className="text-sm" style={{ color: INK_SOFT }}>Quick recap before we kick off.</div>
              <div
                className="rounded-xl p-4"
                style={{ background: `${BG_BASE}55`, border: `1px solid ${METAL}22` }}
              >
                <div
                  className="text-[10px] uppercase tracking-[0.2em] mb-1"
                  style={{ color: METAL, fontFamily: FONT_MONO }}
                >
                  What I&apos;ll do
                </div>
                <div className="text-sm leading-relaxed" style={{ color: PAPER }}>{template.whatItDoes}</div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <div
                  className="rounded-lg p-3"
                  style={{ background: `${BG_BASE}55`, border: `1px solid ${METAL}22` }}
                >
                  <div
                    className="text-[10px] uppercase tracking-[0.2em] mb-1"
                    style={{ color: METAL, fontFamily: FONT_MONO }}
                  >
                    Goal
                  </div>
                  <div className="leading-snug" style={{ color: PAPER }}>{renderedGoal}</div>
                </div>
                <div
                  className="rounded-lg p-3"
                  style={{ background: `${BG_BASE}55`, border: `1px solid ${METAL}22` }}
                >
                  <div
                    className="text-[10px] uppercase tracking-[0.2em] mb-1"
                    style={{ color: METAL, fontFamily: FONT_MONO }}
                  >
                    Cadence
                  </div>
                  <div className="font-semibold" style={{ color: PAPER }}>{schedule.label}</div>
                  <div className="text-[11px] mt-0.5" style={{ color: INK_SOFT, fontFamily: FONT_MONO }}>{schedule.cadence}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 flex items-center justify-between"
          style={{ borderTop: `1px solid ${METAL}22`, background: `${LEATHER_EDGE}66` }}
        >
          <button
            onClick={() => (step > 1 ? setStep(s => s - 1) : onClose())}
            className="px-4 py-2 text-sm"
            style={{ color: INK_SOFT, background: 'transparent', fontFamily: FONT_DISPLAY }}
          >
            {step > 1 ? '← Back' : 'Cancel'}
          </button>
          {step < 3 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canAdvance}
              className="px-5 py-2 rounded-lg text-sm font-bold"
              style={{
                background: canAdvance
                  ? `linear-gradient(180deg, ${METAL_BRIGHT} 0%, ${METAL} 60%, ${METAL_DARK} 100%)`
                  : `${METAL_DARK}55`,
                color: BOLT,
                border: `1px solid ${METAL_DARK}`,
                opacity: canAdvance ? 1 : 0.5,
                cursor: canAdvance ? 'pointer' : 'not-allowed',
                fontFamily: FONT_DISPLAY,
                letterSpacing: '0.04em',
              }}
            >
              Next →
            </button>
          ) : (
            <button
              onClick={launch}
              disabled={launching}
              className="px-5 py-2 rounded-lg text-sm font-bold"
              style={{
                background: launching
                  ? `${METAL_DARK}55`
                  : `linear-gradient(180deg, ${METAL_BRIGHT} 0%, ${METAL} 60%, ${METAL_DARK} 100%)`,
                color: BOLT,
                border: `1px solid ${METAL_DARK}`,
                opacity: launching ? 0.6 : 1,
                cursor: launching ? 'wait' : 'pointer',
                fontFamily: FONT_DISPLAY,
                letterSpacing: '0.04em',
              }}
            >
              {launching ? 'Launching…' : 'Launch first run 🚀'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
