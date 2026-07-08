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

/**
 * Resolve the effective self-critique config given the one-switch
 * `reliabilityMode`. Reliability Mode is the "best harness" preset: it turns
 * on self-critique (Organ 5) without the user editing nested config. An
 * explicit `selfCritique.enabled` still wins if set. Pure.
 */
export function resolveSelfCritique(
    selfCritique: Partial<SelfCritiqueConfig> | undefined,
    reliabilityMode: boolean,
): SelfCritiqueConfig {
    const base = { ...DEFAULT_SELF_CRITIQUE, ...(selfCritique || {}) };
    // reliabilityMode flips the default ON; an explicit false in config still wins.
    if (reliabilityMode && selfCritique?.enabled === undefined) base.enabled = true;
    return base;
}

/**
 * Channels where the critique pass makes sense: interactive surfaces where a
 * human reads the reply. The life loop (soma/initiative/autopilot/heartbeat),
 * eval harness, deliberation and mesh traffic must NOT pay +1 LLM call per
 * message (confirmed cost/eval-contamination finding, 2026-07-07 review). Pure.
 */
export function shouldCritiqueChannel(channel: string): boolean {
    const c = (channel || '').toLowerCase();
    if (!c) return true;
    if (c === 'eval' || c === 'bench') return false;
    if (c.startsWith('autopilot')) return false;
    const denied = ['deliberation', 'soma-initiative', 'initiative', 'monitor', 'mesh', 'heartbeat', 'cron', 'gepa', 'muscle', 'dreaming'];
    return !denied.includes(c);
}

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
        // Head+tail: conclusions (and bluffs) cluster at the END of a draft —
        // a head-only slice made tail claims invisible to the critique.
        draft.length <= DRAFT_CAP ? draft : `${draft.slice(0, DRAFT_CAP / 2)}\n[... middle truncated ...]\n${draft.slice(-DRAFT_CAP / 2)}`,
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
    outerSignal?: AbortSignal,
): Promise<{ content: string; critiqued: boolean; issues: string[] }> {
    if (!shouldCritique(cfg, draft, toolsUsed)) return { content: draft, critiqued: false, issues: [] };
    if (outerSignal?.aborted) return { content: draft, critiqued: false, issues: [] };
    try {
        const { chat } = await import('../providers/router.js');
        // If the turn ran on a MoA virtual model, critiquing through it would
        // fan out the WHOLE council (+N advisor calls) for a 400-token check.
        // Use the preset's aggregator instead (confirmed cost finding).
        let critiqueModel = cfg.model || turnModel;
        if (!cfg.model && critiqueModel.startsWith('moa/')) {
            const { getMoaPresets } = await import('../providers/moa.js');
            const preset = getMoaPresets()[critiqueModel.replace(/^moa\//, '')];
            if (preset?.aggregator) critiqueModel = preset.aggregator;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CRITIQUE_TIMEOUT_MS);
        let response: string;
        try {
            // Race a hard deadline: non-streaming providers do not honor the
            // abort signal, so without the race the 30s cap was illusory and a
            // slow provider could stall the whole turn.
            const call = chat({
                model: critiqueModel,
                messages: [{ role: 'user', content: buildCritiquePrompt(task, draft, toolsUsed) }],
                maxTokens: CRITIQUE_MAX_TOKENS,
                temperature: 0.2,
                signal: controller.signal,
            } as Parameters<typeof chat>[0]).then(r => r.content || '');
            const deadline = new Promise<never>((_, rej) => {
                controller.signal.addEventListener('abort', () => rej(new Error('critique deadline exceeded')), { once: true });
                outerSignal?.addEventListener('abort', () => rej(new Error('turn aborted')), { once: true });
            });
            response = await Promise.race([call, deadline]);
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
