/**
 * TITAN — Living spec.md per goal (spec-driven / context-engineering workflow).
 *
 * Why this exists
 * ---------------
 * The 2026 meta-shift (Anthropic Agentic Coding Trends; Addy Osmani) is from
 * prompting to *spec engineering*: the agent works against a written spec —
 * problem statement, requirements, and **checkable acceptance criteria** — and
 * that spec becomes persistent memory it references EVERY turn. The agent
 * doesn't declare a task done because it feels done; it declares done because
 * each acceptance criterion is marked `met` with evidence.
 *
 * This is the sibling of `goalPlanFile.ts`:
 *   - `plan.md`  = the *ladder of steps* (Manus recitation — "what's next").
 *   - `spec.md`  = the *definition of done* (acceptance criteria — "are we there").
 *
 * Stored at `~/.titan/goals/{goalId}/spec.md` next to `plan.md`, in the same
 * human-readable, greppable, hand-editable markdown so a person can drop in,
 * tighten an acceptance criterion, and the agent picks it up next turn. The
 * disk format and the prompt-injection format are deliberately identical.
 *
 * Reference:
 *   - Anthropic "2026 Agentic Coding Trends" (spec/context engineering)
 *   - Addy Osmani — specs + acceptance criteria as persistent agent memory
 *   - Pairs with `goalPlanFile.ts` (recitation) at the prompt recency position.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'GoalSpec';

function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function specMdPath(goalId: string): string {
    return join(titanHome(), 'goals', goalId, 'spec.md');
}

/** Whether an acceptance criterion has been satisfied. */
export type AcceptanceStatus = 'met' | 'unmet' | 'unknown';

export interface AcceptanceCriterion {
    /** Stable id within the spec — e.g. `ac1`. */
    id: string;
    /** Testable statement — "POST /v1 returns 401 without a token." */
    text: string;
    status: AcceptanceStatus;
    /** How we know it's met/unmet — a test name, an observation, a log line. */
    evidence?: string;
}

export interface GoalSpec {
    goalId: string;
    title: string;
    /** One-paragraph statement of the problem / desired outcome. */
    problem: string;
    /** What the solution must do. */
    requirements: string[];
    /** The definition of done — each independently checkable. */
    acceptance: AcceptanceCriterion[];
    /** Hard limits the solution must respect (perf, security, scope). */
    constraints: string[];
    /** Explicitly out of scope — guards against scope creep. */
    nonGoals: string[];
    createdAt: string;
    updatedAt: string;
}

const PROMPT_RENDER_CAP = 4096; // chars — mirrors promptSectionCaps.goalSpec

/** Readiness rollup — the bar for "is this goal actually done?". */
export interface SpecReadiness {
    total: number;
    met: number;
    unmet: number;
    unknown: number;
    /** Percent of criteria marked `met` (0–100, integer). */
    pct: number;
    /** True only when there is ≥1 criterion and ALL are `met`. */
    ready: boolean;
}

export function specReadiness(spec: GoalSpec): SpecReadiness {
    const total = spec.acceptance.length;
    const met = spec.acceptance.filter((a) => a.status === 'met').length;
    const unmet = spec.acceptance.filter((a) => a.status === 'unmet').length;
    const unknown = spec.acceptance.filter((a) => a.status === 'unknown').length;
    const pct = total === 0 ? 0 : Math.round((met / total) * 100);
    return { total, met, unmet, unknown, pct, ready: total > 0 && met === total };
}

/** Read the markdown back to a structured GoalSpec. Returns null if absent. */
export function readGoalSpec(goalId: string): GoalSpec | null {
    const path = specMdPath(goalId);
    if (!existsSync(path)) return null;
    try {
        return parseSpecMd(readFileSync(path, 'utf-8'), goalId);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to read spec for ${goalId}: ${(err as Error).message}`);
        return null;
    }
}

/** Write a structured GoalSpec to markdown — replaces the whole file. */
export function writeGoalSpec(spec: GoalSpec): void {
    const path = specMdPath(spec.goalId);
    try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
    spec.updatedAt = new Date().toISOString();
    writeFileSync(path, renderSpecMd(spec), 'utf-8');
    const r = specReadiness(spec);
    logger.info(COMPONENT, `Spec written for ${spec.goalId} (${r.met}/${r.total} acceptance met)`);
}

/** Convenience — flip one acceptance criterion's status (+ optional evidence). */
export function setAcceptance(
    goalId: string,
    critId: string,
    status: AcceptanceStatus,
    evidence?: string,
): GoalSpec | null {
    const spec = readGoalSpec(goalId);
    if (!spec) return null;
    const crit = spec.acceptance.find((a) => a.id === critId);
    if (!crit) return null;
    crit.status = status;
    if (typeof evidence === 'string') crit.evidence = evidence;
    writeGoalSpec(spec);
    return spec;
}

function box(s: AcceptanceStatus): string {
    switch (s) {
        case 'met':     return '[x]';
        case 'unknown': return '[?]';
        case 'unmet':
        default:        return '[ ]';
    }
}
function statusFromBox(b: string): AcceptanceStatus {
    switch (b) {
        case 'x': return 'met';
        case '?': return 'unknown';
        default:  return 'unmet';
    }
}

function renderList(items: string[]): string[] {
    return items.length === 0 ? ['_none_'] : items.map((i) => `- ${i}`);
}

/** Render the spec as markdown — disk format == prompt format. */
export function renderSpecMd(spec: GoalSpec): string {
    const lines: string[] = [];
    const r = specReadiness(spec);
    lines.push(`# Spec — ${spec.title}`);
    lines.push('');
    lines.push(`**Goal id:** \`${spec.goalId}\``);
    lines.push(`**Acceptance:** ${r.met}/${r.total} met (${r.pct}%)${r.ready ? ' ✅ ready' : ''}`);
    lines.push(`**Updated:** ${spec.updatedAt}`);
    lines.push('');
    lines.push('## Problem');
    lines.push(spec.problem.trim() || '_not stated_');
    lines.push('');
    lines.push('## Requirements');
    lines.push(...renderList(spec.requirements));
    lines.push('');
    lines.push('## Acceptance Criteria');
    if (spec.acceptance.length === 0) {
        lines.push('_No acceptance criteria yet — agent should define "done" before executing._');
    } else {
        for (const a of spec.acceptance) {
            lines.push(`- ${box(a.status)} \`${a.id}\` — ${a.text}`);
            if (a.evidence) lines.push(`  > evidence: ${a.evidence}`);
        }
    }
    lines.push('');
    lines.push('## Constraints');
    lines.push(...renderList(spec.constraints));
    lines.push('');
    lines.push('## Non-Goals');
    lines.push(...renderList(spec.nonGoals));
    lines.push('');
    return lines.join('\n');
}

/** Parse the markdown back into a structured spec. Tolerant of hand edits. */
export function parseSpecMd(raw: string, goalId: string): GoalSpec {
    const lines = raw.split(/\r?\n/);
    let title = goalId;
    let updatedAt = new Date().toISOString();
    const createdAt = updatedAt;
    const problem: string[] = [];
    const requirements: string[] = [];
    const acceptance: AcceptanceCriterion[] = [];
    const constraints: string[] = [];
    const nonGoals: string[] = [];

    let section: 'header' | 'problem' | 'requirements' | 'acceptance' | 'constraints' | 'nongoals' = 'header';
    let prevCrit: AcceptanceCriterion | null = null;

    const pushBullet = (line: string, into: string[]): boolean => {
        const m = line.trim().match(/^-\s+(.+)$/);
        if (m && m[1] !== '_none_') { into.push(m[1]); return true; }
        return false;
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('# Spec — ')) { title = trimmed.slice('# Spec — '.length).trim(); continue; }
        if (trimmed.startsWith('**Updated:**')) { updatedAt = trimmed.replace('**Updated:**', '').trim(); continue; }
        if (trimmed.startsWith('**Goal id:**') || trimmed.startsWith('**Acceptance:**')) continue;
        if (trimmed === '## Problem') { section = 'problem'; continue; }
        if (trimmed === '## Requirements') { section = 'requirements'; continue; }
        if (trimmed === '## Acceptance Criteria') { section = 'acceptance'; continue; }
        if (trimmed === '## Constraints') { section = 'constraints'; continue; }
        if (trimmed === '## Non-Goals') { section = 'nongoals'; continue; }

        switch (section) {
            case 'problem':
                if (trimmed && trimmed !== '_not stated_') problem.push(line);
                break;
            case 'requirements':
                pushBullet(line, requirements);
                break;
            case 'acceptance': {
                const m = trimmed.match(/^-\s+\[([ xX?])\]\s+`([^`]+)`\s+—\s+(.+)$/);
                if (m) {
                    const crit: AcceptanceCriterion = { id: m[2], text: m[3], status: statusFromBox(m[1].toLowerCase()) };
                    acceptance.push(crit);
                    prevCrit = crit;
                    break;
                }
                const ev = line.match(/^\s{2,}>\s+evidence:\s+(.+)$/);
                if (ev && prevCrit) prevCrit.evidence = ev[1];
                break;
            }
            case 'constraints':
                pushBullet(line, constraints);
                break;
            case 'nongoals':
                pushBullet(line, nonGoals);
                break;
        }
    }

    return {
        goalId, title,
        problem: problem.join('\n').trim(),
        requirements, acceptance, constraints, nonGoals,
        createdAt, updatedAt,
    };
}

/**
 * Prompt-friendly rendering for injection at the recency position. Returns
 * empty string when the spec doesn't exist or is effectively empty.
 */
export function renderGoalSpecForPrompt(goalId: string): string {
    const spec = readGoalSpec(goalId);
    if (!spec) return '';
    const empty = !spec.problem.trim() && spec.requirements.length === 0 && spec.acceptance.length === 0;
    if (empty) return '';
    const md = renderSpecMd(spec);
    return md.length <= PROMPT_RENDER_CAP ? md : md.slice(0, PROMPT_RENDER_CAP);
}

/** Test helper. */
export function __resetGoalSpecForTests(goalId: string): void {
    const path = specMdPath(goalId);
    if (existsSync(path)) { try { unlinkSync(path); } catch { /* fine */ } }
}
