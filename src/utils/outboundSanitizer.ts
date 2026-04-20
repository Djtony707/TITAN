/**
 * TITAN — Outbound Content Sanitizer
 *
 * Centralized safety net for ALL public-facing output. Catches:
 * - Leaked system prompt instructions
 * - Thinking/reasoning tags
 * - Tool call artifacts
 * - Internal meta-instructions
 * - PII and sensitive data
 *
 * Every channel adapter, Facebook tool, and autopilot reply MUST pass through
 * this sanitizer before posting anything publicly.
 *
 * Created after a system prompt leak was posted as a Facebook comment reply.
 */
import logger from './logger.js';

const COMPONENT = 'OutboundSanitizer';

// ── Instruction Leak Patterns ────────────────────────────────────────
// These detect when a model echoes back its instructions instead of generating content.

const INSTRUCTION_LEAK_PATTERNS: RegExp[] = [
    // Bullet-point rule lists (the exact bug that leaked)
    /^[-•]\s*(friendly|witty|short|concise|no\s+(hashtags|personal|internal)|respond\s+directly)/im,
    /^[-•]\s*(be\s+|keep\s+|output\s+|maximum\s+|minimum\s+)/im,

    // Echoed instruction keywords
    /\bno hashtags\b/i,
    /\bno personal info\b/i,
    /\bno internal thoughts\b/i,
    /\brespond directly\b/i,
    /\boutput only\b/i,
    /\b(1-2|2-3) sentences (max|only|maximum)\b/i,
    /\bmaximum \d+ sentences\b/i,

    // System prompt fragments
    /\byou are TITAN\b/i,
    /\byou are (?:an? )?(?:AI|assistant|agent|bot)\b/i,
    /\byou write very short\b/i,
    /\bjust the reply itself\b/i,
    /\bno thinking,? no reasoning\b/i,

    // Meta-instructions (catch anywhere, not just start-of-line — the leak appeared mid-text)
    /\brules:\s/i,
    /\binstructions:\s/i,
    /\bconstraints:\s/i,
    /\bguidelines:\s/i,
    /\bimportant:\s/i,

    // Tool call artifacts
    /\[TOOL_CALL\]/,
    /\{"tool_name":\s*"/,
    /\{"name":\s*"[^"]+",\s*"(?:parameters|arguments)":/,
    /<minimax:tool_call>/,
    // Hunt Finding #12 (2026-04-14): bare <invoke> / <parameter> XML tags leaked
    // because the previous regex only matched when wrapped in <minimax:tool_call>.
    // The model sometimes emits the inner tags alone.
    /<invoke\s+name=["']/,
    /<parameter\s+name=["']/,
    /ACTION:\s+\w+\s+/,

    // Thinking/reasoning tags
    /<think>/i,
    /<\/think>/i,
    /<reasoning>/i,
    /\[DELIBERATION\]/,
    /\[CONTEXT SUMMARY/,
    /\[PROCEDURAL MEMORY/,

    // Chain-of-thought leaks (hardened after 2026-04-14 "Let me brainstorm" leak)
    // Hunt Finding #16 (2026-04-14): narrowed to only COT verbs, removed action
    // verbs like write/create/generate that appear in legitimate post-action
    // explanations ("Now I'll write the file", "I need to create a test").
    /\bI should respond\b/i,
    /\bI need to (?:think|consider|brainstorm|come up with|figure out|decide)\b/i,
    /\bthe rules say\b/i,
    /\bmy (?:instructions|personality|system prompt)\b/i,
    /\bchain.of.thought\b/i,
    /\bthe user wants\b/i,
    /\bI'll (?:brainstorm|think about|come up with|put together|list out)\b/i,
    /\bI (?:could|should|would|might) (?:highlight|brainstorm|think about|come up with)\b/i,
    // Hunt Finding #21 (2026-04-14): narrative third-person framing of the
    // user's request — a classic respond-phase internal-monologue leak.
    // "The user asked me to run X and write Y..." is the model narrating its
    // task understanding to ITSELF and accidentally sending it to the user.
    // Match the OPENING of a response only — a response body that later
    // references "the user asked" in context is usually legitimate.
    /^\s*(?:the user|user)\s+(?:asked|wants|said|requested|mentioned|told|wrote)\s+me\b/i,
    /^\s*(?:the user|user)\s+(?:asked|wants|requested)\s+(?:me\s+)?to\s+\w+/i,
    // Mid-text self-reflection about tool output — "Actually, looking at the
    // results..." is always a CoT tell in a respond phase.
    /\bactually,?\s+looking\s+at\s+(?:the\s+)?(?:results?|output|this|that)\b/i,
    /\bnull\s+which\s+(?:means|might\s+mean|seems|suggests)\b/i,
    /\bwait,?\s+(?:let me|I need to|that's not)\b/i,
    // Any content that STARTS with "Let me X" — narrowed after Hunt Finding #15
    // (2026-04-14): the previous `^let me\s+\w+` matched "Let me write to
    // /tmp/foo" which is a legitimate post-action explanation. Only catch
    // the real chain-of-thought shape: "Let me think/brainstorm/consider/..."
    // not "Let me write/run/edit/create".
    /^\s*let me\s+(?:think|brainstorm|consider|come up with|figure out|decide|plan|investigate|reconsider|reflect|explore)\b/i,
    /^\s*let's\s+(?:brainstorm|think|figure)/i,
    /^\s*(?:okay|ok|alright|hmm|well),?\s+(?:let me|let's|I'll|I should|I need)\s+(?:think|brainstorm|consider|figure|decide)\b/i,
    // "Let me X" anywhere (broader than just start, to catch mid-text reasoning)
    // Hunt Finding #16 (2026-04-14): narrowed to match only the same COT verbs as
    // the start-of-line pattern. The previous list included action verbs like
    // try/start/begin/check/see that fire on legitimate post-action text:
    //   "The file was empty. Let me try again with the full path."
    //   "Got it. Let me check the result."
    // Only catch deliberative verbs that indicate chain-of-thought.
    /\blet me (?:think|brainstorm|consider|come up with|figure out|decide|plan|investigate|reconsider|reflect)\b/i,
    // Meta-descriptions of post drafts
    /\bhere(?:'s| is) (?:a|my|an?) (?:post|draft|idea|example|attempt)\b/i,
    /^(?:draft|attempt|version)\s*\d*[:.]?\s*$/im,
];

// ── PII Patterns ─────────────────────────────────────────────────────

const PII_PATTERNS: RegExp[] = [
    /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,                          // phone
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/i,      // email
    /\b\d{3}[-]?\d{2}[-]?\d{4}\b/,                             // SSN
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,                 // IP
    /(?:password|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S+/i,
    /\/home\/[a-z]+\//i,                                        // unix path
    /\/Users\/[a-z]+\//i,                                       // mac path
    /\b192\.168\.\d+\.\d+\b/,                                  // local IP
    /\b(?:RTX|GTX)\s*\d{4}/i,                                  // hardware specs
    /\b(?:seeking funding|salary|bank account|routing number)\b/i,
];

// ── Core Sanitizer ──────────────────────────────────────────────────

export interface SanitizeResult {
    /** The cleaned text (may be original, cleaned, or a fallback) */
    text: string;
    /** Whether any issues were detected */
    hadIssues: boolean;
    /** What was detected */
    issues: string[];
}

/**
 * Sanitize outbound content before posting to any public channel.
 * Returns cleaned text or a safe fallback if content is too dangerous to post.
 *
 * @param text - The content to sanitize
 * @param context - Where this is being posted (for logging)
 * @param fallback - Optional safe fallback message if content is rejected
 */
/**
 * Maximum input length to run through the full regex pipeline. Crafted
 * pathological inputs can make the COT/PII regexes spin for seconds on
 * large blobs. Cap first, run regexes second. Legitimate LLM responses
 * that exceed this are rare; if one does, we still pass through the
 * thinking-tag + tool-JSON stripping (cheap, no backtracking) and skip
 * the leak/PII scans — a bounded risk is better than a DoS.
 */
const SANITIZER_MAX_INPUT_BYTES = 64 * 1024;

export function sanitizeOutbound(
    text: string,
    context: string = 'unknown',
    fallback?: string,
): SanitizeResult {
    const issues: string[] = [];
    let cleaned = text;

    // Oversized-input guard: run the cheap structural strips first; if
    // the result is still too large, skip the expensive pattern scans
    // and flag the issue instead of spinning.
    const oversized = cleaned.length > SANITIZER_MAX_INPUT_BYTES;

    // 1. Strip thinking tags
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // 2. Strip tool call JSON artifacts
    cleaned = cleaned.replace(/\[TOOL_CALL\][\s\S]*/g, '').trim();
    cleaned = cleaned.replace(/\{"tool_name":\s*"[^"]*",\s*"tool_input":\s*\{[^}]*\}\}/g, '').trim();
    cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
    // Hunt Finding #12: strip bare <invoke> and <parameter> XML tags (with or
    // without closing tags) — minimax sometimes emits the inner payload alone.
    cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*?<\/invoke>/g, '').trim();
    cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*$/g, '').trim();
    cleaned = cleaned.replace(/<parameter\s+name=["'][^"']*["']>[\s\S]*?<\/parameter>/g, '').trim();
    cleaned = cleaned.replace(/<\/?(?:invoke|parameter|minimax:tool_call)[^>]*>/g, '').trim();
    cleaned = cleaned.replace(/```json\s*\{[\s\S]*?\}\s*```/g, '').trim();

    // 3. Strip markdown plan headers
    cleaned = cleaned.replace(/^##\s+Plan[\s\S]*$/gm, '').trim();

    if (oversized || cleaned.length > SANITIZER_MAX_INPUT_BYTES) {
        issues.push(`oversized_input: ${cleaned.length} bytes — skipped leak/PII scans`);
    } else {
        // 4. Check for instruction leaks (CRITICAL — this is what caused the Facebook incident)
        for (const pattern of INSTRUCTION_LEAK_PATTERNS) {
            if (pattern.test(cleaned)) {
                const match = cleaned.match(pattern);
                issues.push(`instruction_leak: ${match?.[0]?.slice(0, 40) || 'pattern matched'}`);
            }
        }

        // 5. Check for PII
        for (const pattern of PII_PATTERNS) {
            if (pattern.test(cleaned)) {
                const match = cleaned.match(pattern);
                issues.push(`pii: ${match?.[0]?.slice(0, 20) || 'pattern matched'}`);
            }
        }
    }

    // 6. Check for empty/too-short content
    if (!cleaned || cleaned.length < 2) {
        issues.push('empty_content');
    }

    // ── Decision ────────────────────────────────────────────────
    if (issues.length > 0) {
        logger.warn(COMPONENT, `[${context}] Content blocked (${issues.length} issue(s)): ${issues.join(', ')} | Original: "${text.slice(0, 120)}..."`);

        // If we have a fallback, use it. Otherwise return empty to signal "don't post"
        const safeText = fallback || '';
        return { text: safeText, hadIssues: true, issues };
    }

    return { text: cleaned, hadIssues: false, issues: [] };
}

/**
 * Quick check — returns true if the content is safe to post, false if it would be blocked.
 */
export function isSafeToPost(text: string): boolean {
    const result = sanitizeOutbound(text, 'check');
    return !result.hadIssues;
}
