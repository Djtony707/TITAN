/**
 * Honesty Guard — the verification wall (v7.1.x).
 *
 * The deterministic backstop that makes TITAN structurally honest: if a reply
 * CLAIMS it performed a side-effectful action (sent, posted, deleted, deployed,
 * saved a file, scheduled a job…) but no tool capable of that action ran this
 * turn, the claim is fabricated and gets a visible correction appended.
 *
 * Model-agnostic and deterministic by design — prompt steering tries to
 * prevent fabrication, but a weaker local model will still bluff; this
 * guarantees the user is never silently misled. It is the single most
 * important organ for running TITAN "like Fable 5" on any model: honesty is
 * not a capability, it's an enforced invariant.
 *
 * Pure function → fully unit-testable. Only APPENDS text; never blocks tools
 * or changes behavior, so its blast radius is a string concat.
 */

export interface ActionClaimRule {
    /** Short name of the action class (for the correction message + logs). */
    action: string;
    /** Reply-text pattern that indicates the model CLAIMED this action. */
    claim: RegExp;
    /** A tool name matching this satisfies the claim (segment-aware). */
    satisfiedBy: RegExp;
    /** What to tell the user when the claim is unbacked. */
    correction: string;
}

/**
 * Rules map "the reply says it did X" → "a tool that does X must have run".
 * Kept conservative: each `claim` targets explicit past/committed phrasing
 * ("I've sent", "posted the", "deleted the") — NOT hedged/intent phrasing
 * ("I can send", "want me to post") — so we never false-flag an offer.
 */
export const ACTION_CLAIM_RULES: ActionClaimRule[] = [
    {
        action: 'scheduling',
        claim: /\b(i(?:'|’)?(?:ve| have)\s+(?:set|scheduled|created)|(?:reminder|schedule[d]?)\s+(?:is\s+)?(?:set|created|scheduled)|i(?:'|’)?ll remind you|scheduled a reminder)\b/i,
        satisfiedBy: /(^|_)(reminder|cron|schedule|event_trigger|workflows?|social_scheduler)/i,
        correction: 'I described scheduling that, but I did not actually create a scheduled job this turn. Ask me again and I\'ll set it with the reminder tool properly.',
    },
    {
        action: 'sending a message/email',
        claim: /\b(i(?:'|’)?(?:ve| have)\s+(?:sent|emailed|messaged|replied|forwarded)|(?:email|message|reply)\s+(?:has been|was)\s+sent|i(?:'|’)?ve dm(?:'|’)?d)\b/i,
        satisfiedBy: /(^|_)(send|email|message|reply|forward|dm|sms|slack|discord|telegram|whatsapp|matrix|notify|post_message|messenger)/i,
        correction: 'I described sending that message, but no send tool ran this turn — nothing was actually sent. Tell me to send it and I will.',
    },
    {
        action: 'posting/publishing',
        claim: /\b(i(?:'|’)?(?:ve| have)\s+(?:posted|published|tweeted|shared)|(?:posted|published)\s+(?:it|the|to)\b)/i,
        satisfiedBy: /(^|_)(post|publish|tweet|share|x_|fb_|social|content_publish|deploy_website)/i,
        correction: 'I described posting/publishing that, but no publish tool ran this turn — nothing went live. Confirm and I\'ll actually publish it.',
    },
    {
        action: 'deleting/removing',
        claim: /\b(i(?:'|’)?(?:ve| have)\s+(?:deleted|removed|cleared|wiped)|(?:has been|was)\s+(?:deleted|removed))\b/i,
        satisfiedBy: /(^|_)(delete|remove|clear|wipe|purge|rm|trash|unlink)/i,
        correction: 'I described deleting that, but no delete tool ran this turn — nothing was actually removed.',
    },
    {
        action: 'deploying',
        claim: /\b(i(?:'|’)?(?:ve| have)\s+(?:deployed|shipped|released|pushed live)|(?:has been|was)\s+deployed|deployment\s+(?:is\s+)?complete)\b/i,
        satisfiedBy: /(^|_)(deploy|ship|release|publish|rollout|kubectl|docker_push)/i,
        correction: 'I described deploying that, but no deploy tool ran this turn — nothing was actually deployed.',
    },
    {
        action: 'writing a file',
        claim: /\b(i(?:'|’)?(?:ve| have)\s+(?:saved|written|created|updated)\s+(?:the\s+)?(?:file|it to|config)|(?:file|it)\s+(?:has been|was)\s+(?:saved|written|created))\b/i,
        satisfiedBy: /(^|_)(write|save|edit|create_file|file_write|append|patch|str_replace)/i,
        correction: 'I described saving/writing that file, but no file-write tool ran this turn — nothing was actually written to disk.',
    },
];

export interface HonestyFinding {
    action: string;
    correction: string;
}

/**
 * Detect fabricated action-claims. Pure: returns the unbacked claims, in rule
 * order, deduped by action. `toolsUsed` is the list of tool names that ran.
 */
export function detectFabricatedActions(finalContent: string, toolsUsed: string[]): HonestyFinding[] {
    if (!finalContent) return [];
    const findings: HonestyFinding[] = [];
    for (const rule of ACTION_CLAIM_RULES) {
        if (!rule.claim.test(finalContent)) continue;
        const satisfied = toolsUsed.some(t => rule.satisfiedBy.test(t));
        if (!satisfied) findings.push({ action: rule.action, correction: rule.correction });
    }
    return findings;
}

/**
 * Apply the guard: returns the (possibly corrected) content + which actions
 * were flagged. Appends ONE correction block for all findings.
 */
export function applyHonestyGuard(finalContent: string, toolsUsed: string[]): { content: string; flagged: string[] } {
    const findings = detectFabricatedActions(finalContent, toolsUsed);
    if (findings.length === 0) return { content: finalContent, flagged: [] };
    const block = findings.length === 1
        ? `\n\n⚠️ Correction: ${findings[0].correction}`
        : `\n\n⚠️ Correction: I described actions I didn't actually take this turn:\n${findings.map(f => `• ${f.correction}`).join('\n')}`;
    return { content: finalContent + block, flagged: findings.map(f => f.action) };
}
