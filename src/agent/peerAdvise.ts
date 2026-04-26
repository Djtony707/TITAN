/**
 * TITAN — Peer Advisor (v4.13+)
 *
 * Before an autonomous producer (canary-eval, self-repair daemon, auto-heal)
 * escalates a concern to Tony via an approval, it consults a peer specialist
 * and asks: should I really bother the human with this, or can the org figure
 * it out without escalating?
 *
 * The advisor is a single structured sub-agent call with a small schema. It
 * returns one of:
 *   - escalate    → file the approval as planned (human decision needed)
 *   - dismiss     → the concern is known/expected/already-fixed; drop it
 *   - investigate → the concern is real but the org can act on it first;
 *                   caller should try its remediation path instead of
 *                   immediately bothering the human
 *
 * Fail-open: if the advisor call errors, returns null → caller escalates as
 * usual. Better to bother Tony than silently swallow a real problem.
 */
import logger from '../utils/logger.js';
import { structuredSpawn } from './structuredSpawn.js';

const COMPONENT = 'PeerAdvise';

export type PeerVerdict = 'escalate' | 'dismiss' | 'investigate';

export interface PeerAdvice {
    verdict: PeerVerdict;
    reason: string;
    confidence: number;
    advisorSpecialist: string;
}

export interface PeerAdviseOpts {
    /** One-line description of what's triggering the potential escalation. */
    concern: string;
    /** Classification — canary_regression | self_repair | auto_heal | etc. */
    kind: string;
    /** Additional facts the advisor should consider. */
    context?: string;
    /**
     * Which specialist to ask. Default: 'sage' (critic/reviewer role).
     * Route by concern kind when it's obvious (code-failure → sage,
     * research-gap → scout, etc.). Unknown kinds get sage.
     */
    advisor?: 'sage' | 'analyst' | 'scout' | 'builder' | 'writer' | 'default';
    /** Max wait. Default 20000 (20s) — advisor should be quick or fail open. */
    timeoutMs?: number;
}

const DEFAULT_ADVISOR = 'sage';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Consult a peer specialist about whether a concern warrants escalation.
 * Returns null on failure so the caller can fall back to filing the
 * approval unchanged.
 */
export async function peerAdvise(opts: PeerAdviseOpts): Promise<PeerAdvice | null> {
    const advisor = opts.advisor ?? DEFAULT_ADVISOR;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const task = [
        `Another component of TITAN wants to bother Tony with an approval request. Before they do, they want your read as the peer advisor.`,
        '',
        `Concern kind: ${opts.kind}`,
        `Concern: ${opts.concern}`,
        opts.context ? `Context:\n${opts.context}` : '',
        '',
        'Decide ONE of three verdicts:',
        '  - escalate    → human attention is genuinely needed right now',
        '  - dismiss     → this is expected behaviour / already resolved / noise',
        '  - investigate → the org should try something automatic first (log and keep an eye on it; do not file approval)',
        '',
        'Return a JSON object with fields: status ("done"), artifacts ([]), questions ([]), confidence (0-1), reasoning (1-2 sentences explaining your verdict), plus an extra field "verdict" containing exactly one of: escalate | dismiss | investigate.',
        'Be a tough gatekeeper: escalate only when a human must look. When in doubt, lean dismiss or investigate.',
    ].filter(Boolean).join('\n');

    const startedAt = Date.now();
    try {
        // Use Promise.race to enforce the timeout independent of subagent internals.
        const result = await Promise.race([
            structuredSpawn({
                specialistId: advisor,
                task,
                maxRounds: 2,
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (!result) {
            logger.warn(COMPONENT, `${advisor} advisor timed out after ${timeoutMs}ms — failing open (escalate)`);
            return null;
        }
        const raw = result.rawResponse || '';
        // Pull 'verdict' out of the raw JSON if present
        let verdict: PeerVerdict = 'escalate';
        const m = raw.match(/"verdict"\s*:\s*"(escalate|dismiss|investigate)"/i);
        if (m) verdict = m[1].toLowerCase() as PeerVerdict;
        const advice: PeerAdvice = {
            verdict,
            reason: result.reasoning || 'no reason provided',
            confidence: result.confidence,
            advisorSpecialist: advisor,
        };
        logger.info(COMPONENT, `${advisor} verdict=${advice.verdict} confidence=${advice.confidence.toFixed(2)} reason="${advice.reason.slice(0, 100)}" durationMs=${Date.now() - startedAt}`);
        return advice;
    } catch (err) {
        logger.warn(COMPONENT, `peer advise threw: ${(err as Error).message} — failing open (escalate)`);
        return null;
    }
}
