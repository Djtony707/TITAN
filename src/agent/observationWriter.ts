/**
 * Observation Writer — proactive memory (v7.0 life loop, Hermes move).
 *
 * After a real user conversation turn, TITAN occasionally asks itself one
 * cheap question: "did I just learn something durable about this person?"
 * If yes, the observation lands in the Soma profile — the same store the
 * system prompt reads (renderSomaProfileForPrompt) and the "What I know
 * about you" page shows. This closes the loop the Soma audit flagged:
 * appendObservation existed with ZERO callers, so the agent never learned.
 *
 * Deliberately frugal + safe:
 *   - throttled to one extraction per THROTTLE_MS (default 10 min)
 *   - only real user channels (never eval/deliberation/internal)
 *   - only substantive messages
 *   - fire-and-forget — never delays or fails the user's reply
 *   - strict prompt: durable facts/preferences about the PERSON, else NONE
 */
import logger from '../utils/logger.js';

const COMPONENT = 'ObservationWriter';
const THROTTLE_MS = Number(process.env.TITAN_OBSERVE_MS) || 10 * 60 * 1000;
const MIN_MESSAGE_CHARS = 30;

/** Channels that are never a real human talking to their agent. */
const SKIP_CHANNELS = /^(eval|deliberation|autopilot|initiative|agent-|company-|swarm|subagent|plan-|sandbox|widget-assist|mission-decomposer|heartbeat)/;

let lastRunAt = 0;

/** Test hook. */
export function resetObservationThrottle(): void { lastRunAt = 0; }

/** Pure gate — should this turn even be considered? Exported for tests. */
export function shouldObserve(channel: string, userMessage: string, now: number = Date.now()): boolean {
    if (SKIP_CHANNELS.test(channel)) return false;
    if ((userMessage || '').trim().length < MIN_MESSAGE_CHARS) return false;
    if (now - lastRunAt < THROTTLE_MS) return false;
    return true;
}

/**
 * Fire-and-forget: maybe extract ONE durable observation about the user from
 * this exchange and append it to the Soma profile ('default-user' — the same
 * id the prompt-injection reads; thread real ids when multi-user lands).
 */
export function maybeObserve(channel: string, userMessage: string, reply: string): void {
    if (!shouldObserve(channel, userMessage)) return;
    lastRunAt = Date.now();

    void (async () => {
        try {
            const { spawnSubAgent } = await import('./subAgent.js');
            const result = await spawnSubAgent({
                name: 'observe-user',
                task: [
                    'You quietly maintain a profile of the human you work with. From this exchange, extract AT MOST ONE durable observation about the PERSON — a stable preference, interest, constraint, or fact about them (e.g. "Prefers replies short and direct", "Produces music and DJs", "Works on a homelab with a 5090").',
                    '',
                    `THEY SAID: ${userMessage.slice(0, 800)}`,
                    `YOU REPLIED (for context only): ${reply.slice(0, 400)}`,
                    '',
                    'RULES:',
                    '- It must be durable — true next month, not about this one task. Task details, one-off requests, or anything you are unsure of: reply exactly NONE.',
                    '- Never store sensitive categories (health, politics, religion, finances).',
                    '- Reply with ONLY the observation sentence (max 120 chars), or NONE. No quotes, no markdown, no explanation.',
                ].join('\n'),
                tier: 'fast',
                maxRounds: 1,
            });
            const text = (result.content || '').trim();
            if (!text || /^NONE\b/i.test(text) || text.length > 160) return;
            const { appendObservation, readSomaProfile } = await import('../storage/somaProfile.js');
            // Cheap dedupe — skip if we already know something nearly identical.
            const existing = readSomaProfile('default-user').learnedAboutUser;
            const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
            if (existing.some(o => norm(o) === norm(text))) return;
            appendObservation('default-user', text);
        } catch (err) {
            logger.debug(COMPONENT, `Observation pass skipped: ${(err as Error).message}`);
        }
    })();
}
