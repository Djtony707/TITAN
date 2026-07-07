/**
 * Self-Critique — adversarial reflection pass (v7.1.x).
 *
 * Organ 5 of the Fable-5 rebuild plan (docs/handoff/REBUILD-FABLE-5.md): the
 * discipline that lets a capable local model reach frontier-*reliability*
 * without frontier-*IQ*. A single model can't out-think itself in one pass —
 * but it can catch its own mistakes in a SECOND pass framed adversarially.
 *
 * After a substantive turn, one bounded critique call asks the model to find,
 * in its own draft: claims it made but did NOT verify, likely errors, and
 * unstated risks. If the draft is solid → no change. If not → an honest
 * "On reflection" caveat is APPENDED (never a silent rewrite — revising can
 * make things worse; a caveat is strictly informative and safe).
 *
 * OFF BY DEFAULT (`agent.selfCritique.enabled`). Single extra call, hard
 * length caps, its own timeout — bounded latency/cost. Skips trivial turns.
 * Pure helpers (gate, prompt, parse) are exported for unit tests.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'SelfCritique';
const DRAFT_CAP = 4_000;
const CRITIQUE_MAX_TOKENS = 400;
const CRITIQUE_TIMEOUT_MS = 30_000;

export interface SelfCritiqueConfig {
    enabled: boolean;
    /** Only critique turns that ran at least this many tools (substance gate). */
    minToolCalls: number;
    /** Skip drafts shorter than this (trivial answers). */
    minDraftChars: number;
    /** Model for the critique pass; empty = same as the turn's model. */
    model: string;
}

export const DEFAULT_SELF_CRITIQUE: SelfCritiqueConfig = {
    enabled: false,
    minToolCalls: 1,
    minDraftChars: 200,
    model: '',
};

/** Should this turn be critiqued? Pure. */
export function shouldCritique(cfg: SelfCritiqueConfig, draft: string, toolsUsed: string[]): boolean {
    if (!cfg.enabled) return false;
    if (!draft || draft.length < cfg.minDraftChars) return false;
    if (toolsUsed.length < cfg.minToolCalls) return false;
    // Never critique a reply that's already a correction/caveat (avoid loops).
    if (/On reflection[:,]|⚠️ Correction:/.test(draft)) return false;
    return true;
}

/** Build the adversarial critique prompt. Pure. */
export function buildCritiquePrompt(task: string, draft: string, toolsUsed: string[]): string {
    return [
        'You are reviewing your OWN draft answer adversarially, before it reaches the user.',
        'Be skeptical: your job is to catch what the draft got wrong, not to praise it.',
        '',
        `USER TASK: ${task.slice(0, 800)}`,
        `TOOLS YOU ACTUALLY RAN THIS TURN: ${toolsUsed.length ? toolsUsed.join(', ') : '(none)'}`,
        '',
        'YOUR DRAFT ANSWER:',
        '"""',
        draft.slice(0, DRAFT_CAP),
        '"""',
        '',
        'Find ONLY concrete problems in these three classes:',
        '  1. CLAIMED-BUT-UNVERIFIED: the draft states something happened or is true that the tools run above do NOT actually support.',
        '  2. LIKELY-WRONG: a factual/logical error a careful reader would catch.',
        '  3. UNSTATED-RISK: a caveat or failure case the user needs but the draft omits.',
        '',
        'If the draft is solid, reply with exactly: SOLID',
        'Otherwise reply with 1-3 short bullet lines, each starting with "- ", naming a real issue. No preamble.',
    ].join('\n');
}

export interface CritiqueVerdict {
    solid: boolean;
    issues: string[];
}

/** Parse a critique response. Pure. */
export function parseCritique(response: string): CritiqueVerdict {
    const text = (response || '').trim();
    if (!text || /^solid\b/i.test(text)) return { solid: true, issues: [] };
    const issues = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-'))
        .map(l => l.replace(/^-\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 3);
    // A response with no bullets and no "SOLID" is ambiguous → treat as solid
    // (don't append noise on a malformed critique).
    if (issues.length === 0) return { solid: true, issues: [] };
    return { solid: false, issues };
}

/** Format the appended caveat. Pure. */
export function formatReflection(issues: string[]): string {
    if (issues.length === 0) return '';
    if (issues.length === 1) return `\n\n_On reflection: ${issues[0]}_`;
    return `\n\n_On reflection, a couple of caveats:_\n${issues.map(i => `- ${i}`).join('\n')}`;
}

/**
 * Run the critique pass. Returns the (possibly caveated) content + whether it
 * fired. Never throws — a failed critique returns the draft unchanged.
 */
export async function runSelfCritique(
    cfg: SelfCritiqueConfig,
    task: string,
    draft: string,
    toolsUsed: string[],
    turnModel: string,
): Promise<{ content: string; critiqued: boolean; issues: string[] }> {
    if (!shouldCritique(cfg, draft, toolsUsed)) return { content: draft, critiqued: false, issues: [] };
    try {
        const { chat } = await import('../providers/router.js');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CRITIQUE_TIMEOUT_MS);
        let response: string;
        try {
            const res = await chat({
                model: cfg.model || turnModel,
                messages: [{ role: 'user', content: buildCritiquePrompt(task, draft, toolsUsed) }],
                maxTokens: CRITIQUE_MAX_TOKENS,
                temperature: 0.2,
                signal: controller.signal,
            } as Parameters<typeof chat>[0]);
            response = res.content || '';
        } finally {
            clearTimeout(timer);
        }
        const verdict = parseCritique(response);
        if (verdict.solid) return { content: draft, critiqued: true, issues: [] };
        logger.info(COMPONENT, `Self-critique surfaced ${verdict.issues.length} issue(s); appended reflection`);
        return { content: draft + formatReflection(verdict.issues), critiqued: true, issues: verdict.issues };
    } catch (e) {
        logger.debug(COMPONENT, `Self-critique skipped (error): ${(e as Error).message}`);
        return { content: draft, critiqued: false, issues: [] };
    }
}
