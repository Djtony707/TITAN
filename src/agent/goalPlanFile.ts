/**
 * TITAN — Living plan.md per goal (recitation against lost-in-the-middle).
 *
 * Why this exists
 * ---------------
 * Per Manus + Devin reporting + awesome-agent-harness pattern #2:
 *
 *   "The agent rewrites its todo list on every major step, checking off
 *    items. This isn't bookkeeping — it's attention manipulation:
 *    rewriting the plan pushes goals to the recent tail and beats
 *    lost-in-the-middle on long contexts."
 *
 * TITAN already stores JSON plan state under `~/.titan/plans/{planId}.json`,
 * but that file is structured data, not a recitable document. This module
 * adds the markdown layer — `~/.titan/goals/{goalId}/plan.md` — which is:
 *
 *   1. Written on goal creation (initial plan).
 *   2. Rewritten by the agent on every major step (recitation).
 *   3. Injected into the system prompt at the end of the dynamic section
 *      (recency-position) so the model sees the LATEST plan state every
 *      turn and stays oriented across long-horizon work.
 *
 * The file format is intentionally readable + greppable so a human can
 * jump in at any time, edit it, and the agent picks up the change on
 * its next turn.
 *
 * Reference:
 *   - Manus "Context Engineering for AI Agents" — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
 *   - Cognition "Devin annual performance review 2025"
 *   - Picrew/awesome-agent-harness pattern #2 (Recitation via living plan file)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'GoalPlanFile';

function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function planMdPath(goalId: string): string {
    return join(titanHome(), 'goals', goalId, 'plan.md');
}

/** Step status. Matches the goal subtask vocabulary. */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';

export interface PlanStep {
    /** Stable id within the goal. */
    id: string;
    /** Short verb-phrase title — "Verify migration runs cleanly." */
    title: string;
    status: PlanStepStatus;
    /** Optional one-sentence note from the agent about progress / outcome. */
    note?: string;
}

export interface GoalPlan {
    goalId: string;
    title: string;
    /** One-sentence statement of what success looks like. */
    intent: string;
    /** Ordered ladder of concrete steps. */
    steps: PlanStep[];
    /** Free-form scratchpad the agent uses for context across turns. */
    scratchpad?: string;
    /** ISO timestamps. */
    createdAt: string;
    updatedAt: string;
}

const PROMPT_RENDER_CAP = 4096; // chars — capped via promptSectionCaps too

/** Read the markdown back to a structured GoalPlan. Returns null if absent. */
export function readGoalPlan(goalId: string): GoalPlan | null {
    const path = planMdPath(goalId);
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, 'utf-8');
        return parsePlanMd(raw, goalId);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to read plan for ${goalId}: ${(err as Error).message}`);
        return null;
    }
}

/** Write a structured GoalPlan to markdown — replaces the whole file. */
export function writeGoalPlan(plan: GoalPlan): void {
    const path = planMdPath(plan.goalId);
    try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
    plan.updatedAt = new Date().toISOString();
    writeFileSync(path, renderPlanMd(plan), 'utf-8');
    logger.info(COMPONENT, `Plan rewritten for ${plan.goalId} (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}, ${plan.steps.filter(s => s.status === 'done').length} done)`);
}

/** Convenience — flip one step's status (and optional note) and rewrite. */
export function updateStep(goalId: string, stepId: string, patch: { status?: PlanStepStatus; note?: string; title?: string }): GoalPlan | null {
    const plan = readGoalPlan(goalId);
    if (!plan) return null;
    const step = plan.steps.find(s => s.id === stepId);
    if (!step) return null;
    if (patch.status) step.status = patch.status;
    if (typeof patch.note === 'string') step.note = patch.note;
    if (typeof patch.title === 'string') step.title = patch.title;
    writeGoalPlan(plan);
    return plan;
}

/** Render the plan as markdown — the canonical disk format + the prompt
 *  format are deliberately the same so what you see in the file is what
 *  the model sees in its prompt. */
export function renderPlanMd(plan: GoalPlan): string {
    const lines: string[] = [];
    lines.push(`# Plan — ${plan.title}`);
    lines.push('');
    lines.push(`**Goal id:** \`${plan.goalId}\``);
    lines.push(`**Intent:** ${plan.intent}`);
    lines.push(`**Updated:** ${plan.updatedAt}`);
    lines.push('');
    lines.push('## Steps');
    if (plan.steps.length === 0) {
        lines.push('_No steps yet — agent should draft a ladder before executing._');
    } else {
        for (const s of plan.steps) {
            const box = checkbox(s.status);
            const note = s.note ? `\n  > ${s.note}` : '';
            lines.push(`- ${box} \`${s.id}\` — ${s.title}${note}`);
        }
    }
    if (plan.scratchpad && plan.scratchpad.trim().length > 0) {
        lines.push('');
        lines.push('## Scratchpad');
        lines.push(plan.scratchpad.trim());
    }
    lines.push('');
    return lines.join('\n');
}

function checkbox(s: PlanStepStatus): string {
    switch (s) {
        case 'done':         return '[x]';
        case 'in_progress':  return '[~]';
        case 'blocked':      return '[!]';
        case 'skipped':      return '[s]';
        case 'pending':
        default:             return '[ ]';
    }
}

function statusFromBox(box: string): PlanStepStatus {
    switch (box) {
        case 'x': return 'done';
        case '~': return 'in_progress';
        case '!': return 'blocked';
        case 's': return 'skipped';
        default:  return 'pending';
    }
}

/** Parse the markdown back into a structured plan. Tolerant — keeps
 *  unrecognized text in `scratchpad`. */
export function parsePlanMd(raw: string, goalId: string): GoalPlan {
    const lines = raw.split(/\r?\n/);
    let title = goalId;
    let intent = '';
    let updatedAt = new Date().toISOString();
    let createdAt = updatedAt;
    const steps: PlanStep[] = [];
    let scratchpad: string | undefined;

    let section: 'header' | 'steps' | 'scratch' = 'header';
    const scratchLines: string[] = [];
    let prevStep: PlanStep | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('# Plan — ')) {
            title = trimmed.slice('# Plan — '.length).trim();
            continue;
        }
        if (trimmed.startsWith('**Intent:**')) {
            intent = trimmed.replace('**Intent:**', '').trim();
            continue;
        }
        if (trimmed.startsWith('**Updated:**')) {
            updatedAt = trimmed.replace('**Updated:**', '').trim();
            continue;
        }
        if (trimmed === '## Steps') { section = 'steps'; continue; }
        if (trimmed === '## Scratchpad') { section = 'scratch'; continue; }

        if (section === 'steps') {
            const m = trimmed.match(/^-\s+\[([ xX~!s])\]\s+`([^`]+)`\s+—\s+(.+)$/);
            if (m) {
                const step: PlanStep = {
                    id: m[2],
                    title: m[3],
                    status: statusFromBox(m[1].toLowerCase()),
                };
                steps.push(step);
                prevStep = step;
                continue;
            }
            // Continuation note line (starts with "  > ")
            const noteM = line.match(/^\s{2,}>\s+(.+)$/);
            if (noteM && prevStep) {
                prevStep.note = noteM[1];
                continue;
            }
        }
        if (section === 'scratch') {
            scratchLines.push(line);
        }
    }
    if (scratchLines.length > 0) scratchpad = scratchLines.join('\n').trim() || undefined;

    return { goalId, title, intent, steps, scratchpad, createdAt, updatedAt };
}

/**
 * Prompt-friendly rendering. Capped via `PROMPT_RENDER_CAP` (also enforced
 * upstream by promptSectionCaps). Returns empty string when the plan
 * doesn't exist or has zero steps.
 */
export function renderGoalPlanForPrompt(goalId: string): string {
    const plan = readGoalPlan(goalId);
    if (!plan) return '';
    if (plan.steps.length === 0 && (!plan.scratchpad || !plan.scratchpad.trim())) return '';
    const md = renderPlanMd(plan);
    if (md.length <= PROMPT_RENDER_CAP) return md;
    // Truncate scratchpad first; keep steps intact.
    const clone: GoalPlan = { ...plan, scratchpad: plan.scratchpad ? plan.scratchpad.slice(0, 500) + '\n…[plan scratchpad trimmed]' : undefined };
    return renderPlanMd(clone).slice(0, PROMPT_RENDER_CAP);
}

/** Test helper. */
export function __resetGoalPlanForTests(goalId: string): void {
    const path = planMdPath(goalId);
    if (existsSync(path)) {
        try { require('fs').unlinkSync(path); } catch { /* fine */ }
    }
}
