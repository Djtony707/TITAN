/**
 * TITAN — Question-quality classifier (v6.1.0-alpha.54)
 *
 * Tony, after seeing the Writer ask "What should they focus on?"
 * for a perfectly clear goal ("Write up a 1 page essay with
 * photos of DR Martin Luther King"):
 *
 *   "I don't want it to ask what should I focus on. The AI agents
 *    should deliberate amongst themselves and help themselves out,
 *    unless it is a serious question, in which case it should ask
 *    me the question instead of writing me a generic one line
 *    question that explains nothing."
 *
 * The fix has three layers:
 *
 *   1. `isGenericQuestion()` — code-level classifier that catches
 *      low-information questions BEFORE they reach Tony. Examples
 *      of generic patterns:
 *        - "What should I/we/they focus on?"
 *        - "Please clarify"
 *        - "Needs more direction"
 *        - "How should I proceed?"
 *        - "Can you give more detail?"
 *        - "What do you want?"
 *        - Very short (< 25 chars after trimming context)
 *        - No specific noun / option / decision point
 *
 *   2. `assessQuestionQuality()` — full-fledged quality bar that
 *      classifies a question as either:
 *        - 'generic' — auto-commit, don't ask Tony
 *        - 'consultable' — could be answered by a teammate
 *        - 'specific' — genuine human-only judgment call, ask Tony
 *
 *   3. `forceCommitDirective()` — the lastError text we inject
 *      when forcing a generic-question specialist to retry with
 *      a commit-to-your-best-guess mandate.
 *
 * Patterns are intentionally permissive about phrasing variants
 * because LLMs paraphrase. Anchored on the semantic intent ("I
 * don't know what to do") rather than exact strings.
 */

// ── Generic-question patterns ──────────────────────────────────

/**
 * Phrases that signal "the agent didn't try hard enough to commit
 * on its own." Each one is a low-information question — the answer
 * would be different every time depending on Tony's mood, and the
 * agent could have made a reasonable default choice instead.
 */
const GENERIC_PATTERNS: RegExp[] = [
    // "What should I/we/they focus on?"
    /what\s+(?:should|do|do you want)\s+(?:i|we|they|the|us|the agent|the specialist)?\s*(?:focus|work|prioritize|start|begin|do)/i,
    // "How should I proceed?"
    /how\s+(?:should|do|can)\s+(?:i|we|they)?\s*(?:proceed|continue|move forward|approach this|start|begin)/i,
    // "Please clarify" / "Can you clarify"
    /\b(?:please|can you|could you)\s+(?:clarify|elaborate|specify|explain|tell me more)/i,
    // "Needs more direction" / "needs guidance"
    /\bneed[s]?\s+(?:more\s+)?(?:direction|guidance|input|instruction|context|info|information|details?)\b/i,
    // "What do you want (me) to do/say/write?"
    /\bwhat\s+(?:do|would)\s+you\s+(?:want|like)\s+(?:me|us|the agent)?\s*to\s+(?:do|write|say|focus|work)/i,
    // "Can you give (me) more detail/context?"
    /\b(?:can|could|would)\s+you\s+(?:give|provide|share|tell)\s+(?:me\s+)?(?:more\s+)?(?:detail|context|info|information|specifics)/i,
    // "What's the next step?" / "What's next?"
    /\bwhat['']?s?\s+(?:the\s+)?next(?:\s+step|s)?[?]?$/i,
    // "I need more information" (statement masquerading as a question)
    /\b(?:i|we)\s+need\s+(?:more|additional|further)\s+(?:info|information|context|direction|input|guidance)/i,
    // "Could you be more specific?"
    /\b(?:could|can|would)\s+you\s+be\s+more\s+specific/i,
    // "What angle / approach / style / tone should I take?"
    /\bwhat\s+(?:angle|approach|style|tone|format|direction|perspective)\s+(?:should|do|would)/i,
    // "Should I proceed?" / "Should I continue?" — yes/no with no real choice
    /^\s*should\s+(?:i|we)\s+(?:proceed|continue|go ahead|move forward)[?]?\s*$/i,
    // "How long / detailed should it be?" without offering options
    /\bhow\s+(?:long|detailed|in-depth|thorough|short|brief)\s+(?:should|do you want)/i,
    // Driver's own "specialist requires input" fallback that pre-alpha.54 was wrapped and shown verbatim
    /specialist\s+requires?\s+input/i,
    // Pure existential — agent has no idea what to do
    /\b(?:i|we)\s+don['']?t\s+know\s+(?:what|how|where)\s+to\s+(?:do|start|begin|proceed)/i,
];

/**
 * Decision-keyword patterns. A question that contains one of these
 * is signaling a real choice that a human (or teammate) needs to
 * make — even if it's short. Used as a NEGATIVE check against
 * generic patterns: if the question contains a decision keyword,
 * we don't treat it as generic even if it pattern-matches.
 */
const DECISION_MARKERS: RegExp[] = [
    /\b(?:vs|or|either|between)\b/i,                  // "X vs Y" / "X or Y"
    /\boption\s+[a-z0-9]/i,                           // "option A"
    /\bsource\s+\d/i,                                 // "source 1 vs source 2"
    /\b\d{4}\b/,                                      // years — usually a concrete date
    /\$\d/,                                           // dollar amounts
    /\d+%/,                                           // percentages
    /https?:\/\//i,                                   // a specific URL in the question
    /["'].{4,}["']/,                                  // a quoted phrase / specific name
];

// ── Classifier ─────────────────────────────────────────────────

export type QuestionQuality = 'generic' | 'specific';

/**
 * Returns true if the question is too generic to ship to Tony.
 *
 * A question is generic when:
 *   - it matches a generic pattern AND has no decision marker, OR
 *   - it's very short (< 25 chars after trim) AND has no decision marker
 *
 * Designed to be aggressive — false positives just force the
 * specialist to retry with a commit-to-best-interpretation
 * directive, which is cheap. False negatives (generic question
 * shipped to Tony) cost his attention, which is expensive.
 */
export function isGenericQuestion(rawQuestion: string | undefined | null): boolean {
    const q = (rawQuestion ?? '').trim();
    if (q.length === 0) return true;
    const hasDecisionMarker = DECISION_MARKERS.some((re) => re.test(q));
    // Decision-marked questions are presumed specific.
    if (hasDecisionMarker) return false;
    // Pattern-match against generic templates.
    if (GENERIC_PATTERNS.some((re) => re.test(q))) return true;
    // Very short with no decision marker → generic.
    if (q.length < 25) return true;
    return false;
}

/**
 * Classify quality. Exported separately so future expansions
 * (adding a 'consultable' mid-tier, for example) don't require
 * changing call sites.
 */
export function assessQuestionQuality(rawQuestion: string | undefined | null): QuestionQuality {
    return isGenericQuestion(rawQuestion) ? 'generic' : 'specific';
}

/**
 * Compose the lastError directive used when forcing a specialist
 * to retry after asking a generic question. Tony asked: "agents
 * should deliberate amongst themselves and help themselves out."
 * The directive is calibrated to push the specialist toward
 * committing on its own first, and to use send_agent_message if
 * it genuinely needs a teammate.
 */
export function forceCommitDirective(originalQuestion: string, goalTitle: string): string {
    return [
        `GENERIC_QUESTION_REJECTED: Your previous question — "${originalQuestion.slice(0, 200)}" — was too generic to ship to the user.`,
        '',
        'Tony has explicitly asked NOT to be pinged with low-information questions.',
        '',
        `Goal: "${goalTitle}". You have enough context. Commit to your best interpretation and DO THE WORK.`,
        '',
        'BEFORE returning needs_info again you MUST:',
        '  1. Try to commit to a reasonable interpretation. For an essay/report goal, pick the most-obvious framing and write it — Tony can edit afterward.',
        '  2. If you genuinely need help, send_agent_message to a teammate (scout for facts, analyst for data, sage for judgment) and incorporate their reply. Do NOT escalate to the human on the first try.',
        '  3. Only return needs_info if (a) #1 is impossible and (b) #2 was tried and didn\'t resolve it. Your question must then name (i) the specific missing fact, (ii) what you\'d do given option X vs option Y, (iii) be specific enough that a stranger could answer in one line.',
        '',
        'Acceptable example: "I found conflicting dates for the March on Washington — most sources say August 28, 1963 but one cites August 30. Should I cite August 28 (consensus) or note both?"',
        'Unacceptable example: "What should I focus on?" / "Please clarify" / "Needs more direction" — these are all auto-rejected.',
    ].join('\n');
}
