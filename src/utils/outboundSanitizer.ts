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
    /\byou are (?:an? )?(?:AI|assistant|agent|bot)\b.*\byou (?:should|must|will|are)\b/i,
    /\byou write very short\b/i,
    /\bjust the reply itself\b/i,
    /\bno thinking,? no reasoning\b/i,

    // Meta-instructions
    /^rules:\s/im,
    /^instructions:\s/im,
    /^constraints:\s/im,
    /^guidelines:\s/im,
    /^important:\s/im,

    // Tool call artifacts
    /\[TOOL_CALL\]/,
    /\{"tool_name":\s*"/,
    /\{"name":\s*"[^"]+",\s*"(?:parameters|arguments)":/,
    /<minimax:tool_call>/,
    /ACTION:\s+\w+\s+/,

    // Thinking/reasoning tags
    /<think>/i,
    /<\/think>/i,
    /<reasoning>/i,
    /\[DELIBERATION\]/,
    /\[CONTEXT SUMMARY/,
    /\[PROCEDURAL MEMORY/,

    // Chain-of-thought leaks
    /\bI should respond\b/i,
    /\bI need to (?:be|think|consider|respond|reply)\b/i,
    /\bthe rules say\b/i,
    /\bmy (?:instructions|personality|system prompt)\b/i,
    /\blet me (?:think|check|consider) (?:about |how )/i,
    /\bchain.of.thought\b/i,
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
export function sanitizeOutbound(
    text: string,
    context: string = 'unknown',
    fallback?: string,
): SanitizeResult {
    const issues: string[] = [];
    let cleaned = text;

    // 1. Strip thinking tags
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // 2. Strip tool call JSON artifacts
    cleaned = cleaned.replace(/\[TOOL_CALL\][\s\S]*/g, '').trim();
    cleaned = cleaned.replace(/\{"tool_name":\s*"[^"]*",\s*"tool_input":\s*\{[^}]*\}\}/g, '').trim();
    cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
    cleaned = cleaned.replace(/```json\s*\{[\s\S]*?\}\s*```/g, '').trim();

    // 3. Strip markdown plan headers
    cleaned = cleaned.replace(/^##\s+Plan[\s\S]*$/gm, '').trim();

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
