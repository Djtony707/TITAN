/**
 * TITAN — Reply Quality Validation
 *
 * Pure, fully testable validation for outbound replies (FB comments, Messenger, etc.)
 * Catches problems that the sanitizer misses because they're about the REPLY SHAPE
 * rather than content patterns:
 *
 *   - Mid-sentence truncation (e.g. "I must've imagined the whole" — cut off)
 *   - Overly apologetic / self-deprecating tone (bad PR for the brand)
 *   - Empty or too-short replies
 *   - Replies that are just the commenter's name back at them
 *
 * Created after the 2026-04-14 truncation incident where minimax-m2.7 returned
 * "You're right Tony, I must've imagined the whole" — 47 chars, no punctuation,
 * cut off mid-word.
 */

export interface ReplyValidation {
    valid: boolean;
    reason?: string;
    /** Suggested action: 'reject' | 'retry' | 'fallback' */
    action?: 'reject' | 'retry' | 'fallback';
}

/**
 * Validate the quality and completeness of a reply.
 * Returns { valid: true } if the reply can be posted as-is.
 * Returns { valid: false, reason, action } with a human-readable reason and
 * a suggested corrective action.
 */
export function validateReply(reply: string, commenterFirstName?: string): ReplyValidation {
    const trimmed = reply.trim();

    // ── Empty / too short ──────────────────────────────────────
    if (!trimmed) {
        return { valid: false, reason: 'empty', action: 'fallback' };
    }
    if (trimmed.length < 8) {
        return { valid: false, reason: 'too_short', action: 'fallback' };
    }

    // ── Truncation detection ──────────────────────────────────
    // A complete reply should end in terminal punctuation, an emoji,
    // a quote mark, or a closing bracket. Anything else means the model
    // was mid-sentence when it stopped.
    const lastChar = trimmed.slice(-1);
    const lastTwo = trimmed.slice(-2);
    const endsInPunctuation = /[.!?…]/.test(lastChar);
    const endsInQuote = /["')\]}]/.test(lastChar);
    // Emoji detection — any non-ASCII char at the end is likely an emoji
    const endsInEmoji = /[^\x00-\x7F]/.test(lastChar) || /[^\x00-\x7F][\uFE0F\u200D]?/.test(lastTwo);

    if (!endsInPunctuation && !endsInQuote && !endsInEmoji) {
        return {
            valid: false,
            reason: `truncated_no_terminal_punct (ends with "${trimmed.slice(-15)}")`,
            action: 'retry',
        };
    }

    // ── Mid-word truncation detection ─────────────────────────
    // Words like "the whole" at the end (no noun following) are suspicious
    // when combined with no proper closing.
    // A reply ending in these "dangling" phrases usually means the model cut off.
    const danglingEndings = [
        /\bthe\s+whole\s*$/i,
        /\bthe\s+entire\s*$/i,
        /\ba\s+(?:little|bit|lot|few)\s*$/i,
        /\bmust['']?(?:ve|\s+have)\s*$/i,
        /\bgoing\s+to\s*$/i,
        /\bsupposed\s+to\s*$/i,
        /\btrying\s+to\s*$/i,
        /\bI\s*$/i,
        /\bmy\s*$/i,
        /\band\s*$/i,
        /\bor\s*$/i,
        /\bbut\s*$/i,
        /\bso\s*$/i,
        /\bfor\s*$/i,
        /\bof\s*$/i,
        /\bwith\s*$/i,
    ];
    for (const pattern of danglingEndings) {
        if (pattern.test(trimmed)) {
            return {
                valid: false,
                reason: `truncated_dangling_phrase`,
                action: 'retry',
            };
        }
    }

    // ── Overly apologetic / self-deprecating tone ──────────────
    // TITAN's brand voice is confident. Admitting to being broken or wrong
    // publicly (except playfully) damages credibility. Detect the "You're
    // right, I'm wrong" shapes.
    const selfDeprecatingPatterns = [
        /^you['']?re right,?\s+(?:I|tony|sorry|my)/i,
        /^(?:sorry|apologies|my bad|you['']?re correct),?\s+I/i,
        /^I (?:apologize|was wrong|messed up|screwed up|got it wrong)/i,
        /\bI (?:must['']?(?:ve| have)|apparently|clearly) (?:hallucinat|imagined|made up|fabricated)/i,
        /\byou['']?re right[,.\s]+I was wrong/i,
    ];
    for (const pattern of selfDeprecatingPatterns) {
        if (pattern.test(trimmed)) {
            return {
                valid: false,
                reason: 'too_self_deprecating (breaks brand voice)',
                action: 'fallback',
            };
        }
    }

    // ── Just echoing the commenter's name ──────────────────────
    if (commenterFirstName) {
        // Reply is ONLY the name + minimal decoration
        const justNamePattern = new RegExp(
            `^(?:hi|hey|hello|thanks|thank you),?\\s*${commenterFirstName}[.!?\\s]*$`,
            'i',
        );
        if (justNamePattern.test(trimmed)) {
            return {
                valid: false,
                reason: 'just_name_echo',
                action: 'fallback',
            };
        }
    }

    // ── Too many exclamation marks (cheesy) ────────────────────
    const exclamationCount = (trimmed.match(/!/g) || []).length;
    if (exclamationCount >= 4) {
        return {
            valid: false,
            reason: 'too_many_exclamations',
            action: 'retry',
        };
    }

    // ── Passes all checks ──────────────────────────────────────
    return { valid: true };
}

/**
 * Generate a safe fallback reply when validation fails.
 * Returns a neutral, on-brand reply that works for any comment.
 */
export function getSafeFallbackReply(commenterFirstName: string): string {
    const fallbacks = [
        `Thanks for the comment, ${commenterFirstName}! 🤖`,
        `Appreciate you stopping by, ${commenterFirstName}! 🙌`,
        `Always good to hear from the community. 🚀`,
        `Noted, ${commenterFirstName}. Back to work for me! ⚡`,
        `Cheers for that, ${commenterFirstName}! 💪`,
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}
