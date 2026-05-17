/**
 * TITAN — Mission Templates (v6.1.0-alpha.18)
 *
 * Starter recipes the user can pick from MissionStart to bootstrap a
 * mission run and remember a preferred cadence. Each template defines:
 *
 *   - identity (icon, title, short blurb)
 *   - the goal text (with {{placeholders}} the user fills in via the
 *     walkthrough Customize step)
 *   - which Play it maps to (the team composition reused here)
 *   - suggested schedule presets the user picks from in step 2
 *   - one-paragraph "What I'll do" explanation shown in step 3
 *
 * Used by MissionStart's `<TemplateGallery>` plus the
 * `<TemplateWalkthrough>` 3-step modal (Customize → Schedule → Launch).
 *
 * Note on scheduling: alpha.18 ships the template UI + the first-run
 * mission creation. The recurring auto-fire daemon lands in the next
 * ship — see HANDOFF-2026-05-13.md "Next session: recurring missions".
 */

export interface TemplateField {
  /** Internal key referenced in the goal as `{{key}}`. */
  key: string;
  /** Label shown in the form. */
  label: string;
  /** Helpful hint shown beneath the input. */
  hint?: string;
  /** Default value the form pre-fills. */
  defaultValue: string;
  /** Optional placeholder used when the value is empty. */
  placeholder?: string;
}

export interface ScheduleOption {
  /** Internal identifier used by the scheduler. */
  id: string;
  /** Human-readable label ("Every 4 hours"). */
  label: string;
  /** Cron expression (5-field, minute hour dom mon dow). Used by the
   *  next-ship recurring-mission daemon. */
  cron: string;
  /** Approximate next-fire copy ("about 6 runs/day"). */
  cadence: string;
}

export interface MissionTemplate {
  id: string;
  icon: string;
  title: string;
  blurb: string;
  /** Goal text with {{key}} placeholders for fields. */
  goalTemplate: string;
  /** Optional play id hint — passed when creating the mission so the
   *  right team forms. */
  suggestedPlayId?: string;
  fields: TemplateField[];
  /** Schedule presets the user picks from. The first entry is the
   *  default. */
  schedules: ScheduleOption[];
  /** "What I'll do" — friendly summary shown before launch. */
  whatItDoes: string;
  /** Tag colors used on the gallery card. */
  accent: { from: string; to: string };
}

const HOURLY: ScheduleOption  = { id: 'hourly',  label: 'Every hour',     cron: '0 * * * *',     cadence: '24 runs/day' };
const FOUR_H: ScheduleOption  = { id: 'every4h', label: 'Every 4 hours',  cron: '0 */4 * * *',   cadence: '6 runs/day'  };
const SIX_H: ScheduleOption   = { id: 'every6h', label: 'Every 6 hours',  cron: '0 */6 * * *',   cadence: '4 runs/day'  };
const DAILY_AM: ScheduleOption = { id: 'daily7', label: 'Daily at 7am',   cron: '0 7 * * *',     cadence: 'once/day'    };
const WEEKLY: ScheduleOption  = { id: 'weekly',  label: 'Weekly (Mon 9am)', cron: '0 9 * * 1',   cadence: 'once/week'   };
const NIGHTLY: ScheduleOption = { id: 'nightly', label: 'Nightly at 11pm', cron: '0 23 * * *',   cadence: 'once/day'    };
const TWICE_DAILY: ScheduleOption = { id: 'twice', label: 'Twice daily (7am + 7pm)', cron: '0 7,19 * * *', cadence: '2 runs/day' };

export const MISSION_TEMPLATES: MissionTemplate[] = [
  {
    id: 'research-digest',
    icon: '📰',
    title: 'Daily research digest',
    blurb: 'Scout researches your topic and writes a fresh briefing for the first run.',
    goalTemplate: 'Research the latest developments on "{{topic}}" and produce a clear HTML briefing (write_file with a .html extension) with 5 highlights, an inline SVG chart of the most important trend, and clickable source links throughout.',
    suggestedPlayId: 'research',
    fields: [
      { key: 'topic', label: 'Your topic', hint: 'What you want a fresh briefing on each morning', defaultValue: 'AI agents in business', placeholder: 'AI agents in business' },
    ],
    schedules: [DAILY_AM, TWICE_DAILY, WEEKLY],
    whatItDoes: "Scout searches the web for fresh developments on your topic, reads the top 5 sources end-to-end, and writes a one-page briefing. The briefing lands on your desk as a paper sheet, and the chat thread captures every URL Scout looked at so you can dig in further if anything catches your eye.",
    accent: { from: '#6366f1', to: '#8b5cf6' },
  },
  {
    id: 'inbox-triage',
    icon: '📬',
    title: 'Inbox triage',
    blurb: 'Sage sorts and summarizes incoming email so important threads stay visible.',
    goalTemplate: 'Read my inbox and produce a triaged summary: "needs reply within 24h", "informational", "newsletters", and "junk". Cap at 30 messages per run.',
    suggestedPlayId: 'inbox',
    fields: [],
    schedules: [FOUR_H, SIX_H, DAILY_AM],
    whatItDoes: "Sage opens your inbox, classifies up to 30 recent threads into four buckets (urgent / informational / newsletters / junk), and pins the urgent ones to the desk as sticky notes. The full triage lands as a paper sheet you can scan in under a minute.",
    accent: { from: '#06b6d4', to: '#0ea5e9' },
  },
  {
    id: 'code-review',
    icon: '🔍',
    title: 'Code review',
    blurb: 'Builder reviews your repo changes and reports only meaningful findings.',
    goalTemplate: 'Review the diff in {{repoPath}} since the last review. Flag bugs, regressions, and obvious improvements. Don\'t nitpick formatting.',
    suggestedPlayId: 'code-review',
    fields: [
      { key: 'repoPath', label: 'Repo path or URL', hint: 'Local path on the host, or a GitHub repo URL', defaultValue: '~/Desktop/MyProject', placeholder: '~/projects/repo' },
    ],
    schedules: [NIGHTLY, TWICE_DAILY],
    whatItDoes: "Builder pulls the latest changes from your repo and writes a concise review focused on real defects (logic bugs, regressions, security smells). Formatting nits are skipped. Findings land as a paper sheet; if there's nothing to report, Builder closes silently.",
    accent: { from: '#22c55e', to: '#10b981' },
  },
  {
    id: 'lead-scout',
    icon: '🎯',
    title: 'Lead scout',
    blurb: 'Scout scans freelance + opportunity boards and surfaces matches for your skills.',
    goalTemplate: 'Scan Upwork, Indeed, and HackerNews "who is hiring" for new postings matching: {{skills}}. Filter to budget >= ${{minBudget}} and remote OK.',
    suggestedPlayId: 'lead-scout',
    fields: [
      { key: 'skills', label: 'Skills to match', hint: 'Comma-separated keywords. Scout fuzzy-matches.', defaultValue: 'TypeScript, Node.js, AI agents', placeholder: 'React, Python, design' },
      { key: 'minBudget', label: 'Minimum budget (USD)', hint: 'Skip postings paying less.', defaultValue: '500' },
    ],
    schedules: [FOUR_H, SIX_H, DAILY_AM],
    whatItDoes: "Scout sweeps the boards you care about for postings that match your skill keywords and budget floor. New matches land as sticky notes; the running log of every posting seen sits as a paper sheet you can browse anytime.",
    accent: { from: '#f59e0b', to: '#eab308' },
  },
  {
    id: 'market-watch',
    icon: '📈',
    title: 'Market watch',
    blurb: 'Analyst tracks tickers + crypto and writes a brief if anything moves >3%.',
    goalTemplate: 'Check the latest price + 24h move for: {{tickers}}. If any moved more than 3% (up or down) since the last run, produce an HTML brief (write_file with a .html extension) with a sparkline SVG per ticker and a one-paragraph explanation with 2 source links.',
    suggestedPlayId: 'analyst',
    fields: [
      { key: 'tickers', label: 'Tickers / coins', hint: 'Comma-separated. Stocks or crypto.', defaultValue: 'BTC, ETH, NVDA, AAPL', placeholder: 'TSLA, SPY, BTC' },
    ],
    schedules: [HOURLY, FOUR_H, SIX_H],
    whatItDoes: "Each cycle, Analyst pulls the latest price and 24-hour move for every ticker you listed. If anything jumped or dropped more than 3%, it writes a one-paragraph explanation with 2 source links. Quiet runs close silently — your desk only fills up when something actually moved.",
    accent: { from: '#ef4444', to: '#f97316' },
  },
  {
    id: 'creative-prompts',
    icon: '🎨',
    title: 'Daily creative prompt',
    blurb: 'Writer creates a fresh writing, sketching, or music prompt for the first run.',
    goalTemplate: 'Generate a fresh {{discipline}} prompt for me today. Make it specific enough to start in 5 minutes but open enough to take in any direction. Include a 1-line warm-up exercise.',
    fields: [
      { key: 'discipline', label: 'Discipline', hint: 'What kind of prompt you want.', defaultValue: 'songwriting', placeholder: 'short fiction · songwriting · sketching' },
    ],
    schedules: [DAILY_AM, WEEKLY],
    whatItDoes: "Writer creates one fresh creative prompt tailored to the discipline you chose, with a quick warm-up exercise to get started. The prompt lands as a sticky note on the desk so you can grab it when you need it.",
    accent: { from: '#ec4899', to: '#8b5cf6' },
  },
];

export function findTemplate(id: string): MissionTemplate | undefined {
  return MISSION_TEMPLATES.find(t => t.id === id);
}

/**
 * Render a template's goal text by substituting {{placeholders}} with
 * values from the user's form. Missing fields keep the placeholder
 * (with the braces stripped) so the LLM at least sees the slot name.
 */
export function renderGoal(template: MissionTemplate, values: Record<string, string>): string {
  return template.goalTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = values[key];
    if (v && v.trim().length > 0) return v.trim();
    return key;
  });
}
