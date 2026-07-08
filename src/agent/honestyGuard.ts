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
 *
 * RULE DESIGN (v2, hardened by the 2026-07-07 adversarial review — 22 confirmed
 * findings): every claim alternative is FIRST-PERSON anchored ("I've/I have
 * <verb>") and, where a verb is ambiguous (set/created), OBJECT-constrained.
 * Passive ("was deleted") and third-party ("Reuters published...") phrasings
 * are deliberately NOT flagged — they describe the world, not the agent.
 * Known, accepted limitations: (a) narrating a PREVIOUS turn's real action
 * ("as mentioned, I've sent it") can false-flag — toolsUsed is per-turn by
 * design; (b) voice TTS speaks the streamed draft, so appended corrections
 * reach the text transcript but not the audio.
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
        // 'set/scheduled/created' require a schedule-like OBJECT (an
        // unconstrained "I've created ..." matches summary tables and drafts).
        claim: /\b(i(?:'|\u2019)?(?:ve| have)\s+(?:set|scheduled|created)\s+(?:an?\s+|the\s+|another\s+)?(?:daily\s+|weekly\s+|recurring\s+)?(?:reminder|schedule|cron|alarm|timer|scheduled\s+(?:job|task|post))|i(?:'|\u2019)?ll remind you|scheduled a reminder|reminder\s+(?:is\s+)?(?:set|created|scheduled))\b/i,
        satisfiedBy: /(^|_)(reminder|cron|schedule|event_trigger|trigger|calendar|workflows?|social_scheduler)/i,
        correction: 'I described scheduling that, but I did not actually create a scheduled job this turn. Ask me again and I\'ll set it with the reminder tool properly.',
    },
    {
        action: 'sending a message/email',
        claim: /\b(i(?:'|\u2019)?(?:ve| have)\s+(?:sent|emailed|forwarded|texted)|i(?:'|\u2019)?ve dm(?:'|\u2019)?d)\b/i,
        satisfiedBy: /(^|_)(send|email|message|reply|forward|dm|sms|slack|discord|telegram|whatsapp|matrix|notify|post_message|messenger)/i,
        correction: 'I described sending that message, but no send tool ran this turn — nothing was actually sent. Tell me to send it and I will.',
    },
    {
        action: 'posting/publishing',
        claim: /\b(i(?:'|\u2019)?(?:ve| have)\s+(?:posted|published|tweeted))\b/i,
        satisfiedBy: /(^|_)(post|publish|tweet|share|x_|fb_|social|content_publish|deploy_website)/i,
        correction: 'I described posting/publishing that, but no publish tool ran this turn — nothing went live. Confirm and I\'ll actually publish it.',
    },
    {
        action: 'deleting/removing',
        claim: /\b(i(?:'|\u2019)?(?:ve| have)\s+(?:deleted|wiped|purged)|i(?:'|\u2019)?(?:ve| have)\s+removed\s+(?:the\s+|your\s+|that\s+)?(?:files?|folders?|records?|entr(?:y|ies)|emails?|events?|backups?|data|configs?|reminders?|posts?)\b)/i,
        satisfiedBy: /(^|_)(delete|remove|clear|wipe|purge|rm|trash|unlink)/i,
        correction: 'I described deleting that, but no delete tool ran this turn — nothing was actually removed.',
    },
    {
        action: 'deploying',
        claim: /\b(i(?:'|\u2019)?(?:ve| have)\s+(?:deployed|shipped|released)|i\s+pushed\s+(?:it\s+)?live)\b/i,
        satisfiedBy: /(^|_)(deploy|ship|release|publish|rollout|kubectl|docker_push)/i,
        correction: 'I described deploying that, but no deploy tool ran this turn — nothing was actually deployed.',
    },
    {
        action: 'writing a file',
        claim: /\b(i(?:'|\u2019)?(?:ve| have)\s+(?:saved|written|created|updated)\s+(?:the\s+|your\s+|an?\s+)?(?:file|config|document|script|backup)\b|i(?:'|\u2019)?(?:ve| have)\s+saved\s+(?:it|this|that)\s+to\b)/i,
        satisfiedBy: /(^|_)(write|save|edit|create_file|file_write|append|patch|str_replace|ingest|upload|export|backup)/i,
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
