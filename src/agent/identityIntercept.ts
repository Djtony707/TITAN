/**
 * TITAN — Identity Intercept
 *
 * Why this exists
 * ---------------
 * Cloud-routed open models often answer "what model are you?" with their
 * training-time identity ("I'm Claude 3.5 Sonnet"), even when the system
 * prompt explicitly tells them they are TITAN powered by some other model.
 * The prompt loses the fight against the model's strongly-trained self-
 * identity. v5.6.5 added a `current_model` tool + system-prompt rules
 * telling the model to call it — but smaller cloud models simply ignore
 * the instruction and answer from training data anyway.
 *
 * This module is the hard guardrail. When the user message looks like an
 * identity question, we inject a high-priority FACT block at the END of
 * the system prompt (end position = U-shaped attention recency win). The
 * block contains the actual model ID, provider, and version, and tells
 * the model: this is ground truth, do not contradict it.
 *
 * The intercept fires BEFORE the LLM is invoked, so even if the model
 * ignores the system-prompt instruction to call `current_model`, it sees
 * the answer right there in context and has nowhere to hallucinate from.
 *
 * Design notes
 * ------------
 * - This is a context augmentation, not a router-side replacement. The
 *   model still does the talking — it just has the facts to hand. That
 *   keeps every other downstream behavior (persona, hormones, tools,
 *   memory) intact. A pure "intercept and short-circuit the LLM" would
 *   be brittle: the user often combines an identity question with a real
 *   task ("what model are you, and can you also look up the weather?"),
 *   and we don't want to swallow the second half.
 * - We deliberately bias toward false positives in the regex. If the
 *   user mentions "what model" in a non-identity context, the worst case
 *   is the model sees an extra paragraph of identity facts — no behavior
 *   damage. Missing an identity question (false negative) means the bug
 *   recurs. The trade-off is asymmetric, so we trigger generously.
 */

import { buildCurrentModelReport } from '../skills/builtin/current_model.js';
import logger from '../utils/logger.js';

const COMPONENT = 'IdentityIntercept';

/**
 * Patterns that indicate the user is asking about TITAN's identity.
 * Each entry is a regex tested against the lowercased, whitespace-collapsed
 * user message. We err toward triggering — see file header for the trade-off.
 */
const IDENTITY_PATTERNS: RegExp[] = [
    // Direct model/LLM/AI/version questions
    /\bwhat\s+(?:model|llm|ai|version|engine)\s+(?:are\s+you|is\s+this|do\s+you)/i,
    /\bwhich\s+(?:model|llm|ai)/i,
    /\bwhat(?:'s|\s+is)\s+(?:your|the|this)\s+(?:model|llm|ai|version|engine)/i,
    /\bwhat\s+are\s+you\s+(?:running|built|powered|based)\s+on\b/i,
    /\bwhat\s+powers\s+you\b/i,
    /\bwhat'?s?\s+running\s+(?:on\s+)?(?:behind|under)\s+(?:you|the\s+hood)/i,

    // "Are you Claude / GPT / Gemini / etc."
    /\bare\s+you\s+(?:claude|gpt|chatgpt|gemini|llama|mistral|deepseek|kimi|grok|qwen|sonnet|opus|haiku|nemotron)/i,
    /\byou(?:'re|\s+are)\s+(?:actually|really|just)\s+(?:claude|gpt|chatgpt|gemini|llama|mistral|deepseek|kimi|grok|qwen)/i,

    // "Who are you" with model-y framing
    /\bwho\s+are\s+you\b(?:.*\b(?:really|actually|model|ai|llm)\b)?/i,
    /\bwhat\s+are\s+you\b(?:.*\b(?:really|actually|model|ai|llm)\b)?/i,

    // Contradictions of a prior identity claim (user pushing back)
    /\bno\s+you'?re?\s+not\b/i,
    /\bthat'?s\s+(?:not\s+true|wrong|false)\b.*\b(?:claude|gpt|model|llm)\b/i,
    /\byou\s+(?:lied|hallucinated|made\s+that\s+up)/i,
];

/**
 * Returns true if the message reads as an identity question worth intercepting.
 * Conservative-side errors (false positives) are preferred over false negatives.
 */
export function isIdentityQuestion(text: string): boolean {
    if (!text || typeof text !== 'string') return false;
    const collapsed = text.trim().slice(0, 500); // cap so long pastes can't slow us
    if (collapsed.length === 0) return false;
    for (const pat of IDENTITY_PATTERNS) {
        if (pat.test(collapsed)) return true;
    }
    return false;
}

/**
 * Build the fact-sheet that gets appended to the system prompt. This is the
 * authoritative answer the model should use verbatim. Format: prose block
 * with a small JSON island for unambiguous extraction.
 */
export function buildIdentityFactSheet(): string {
    let report;
    try {
        report = buildCurrentModelReport();
    } catch (err) {
        // If the report builder ever fails, fall back to a minimal block.
        // We never want this intercept to break the request path.
        logger.warn(COMPONENT, `Fact-sheet build failed: ${(err as Error).message}`);
        return [
            '## IDENTITY FACT — GROUND TRUTH (use this verbatim if asked)',
            '',
            'You are TITAN (The Intelligent Task Automation Network), built by Tony Elliott.',
            'You are NOT Claude, GPT, Gemini, or any other branded foreign model.',
            'If the user asks what model you are, say "I am TITAN" and admit the underlying model name is unavailable at this moment.',
        ].join('\n');
    }

    const lines = [
        '## IDENTITY FACT-SHEET — GROUND TRUTH (use this for your next reply)',
        '',
        'The user just asked an identity-related question. These facts came from the',
        '`current_model` tool that you SHOULD have called. Use them verbatim — they',
        'override any answer you might generate from training data.',
        '',
        '```json',
        JSON.stringify({
            titanVersion: report.titanVersion,
            activeModel: report.activeModel,
            provider: report.provider,
            providerDisplayName: report.providerDisplayName,
            keyConfigured: report.keyConfigured,
            persona: report.persona,
        }, null, 2),
        '```',
        '',
        `Use this exact phrasing (or a close paraphrase):`,
        `"${report.summary}"`,
        '',
        '## What you MUST NOT do',
        '',
        '- Do NOT say you are Claude, GPT, ChatGPT, Gemini, Llama, Mistral, DeepSeek, Kimi, Grok, Qwen, Sonnet, Opus, Haiku, Nemotron, or any other branded model name UNLESS it matches `activeModel` above.',
        `- Do NOT say "I'm Claude Sonnet 4 running as TITAN" or similar — you are running on \`${report.activeModel}\`, NOT Claude. The fact-sheet above is the only correct answer.`,
        '- Do NOT capitulate if the user contradicts you. The fact-sheet is authoritative. Cite it.',
    ];
    return lines.join('\n');
}

/**
 * Convenience: only build + return the fact-sheet if the message is an
 * identity question. Returns null otherwise so callers can do
 * `prompt += maybeBuildIdentityFactSheet(msg) || ''`.
 */
export function maybeBuildIdentityFactSheet(message: string): string | null {
    if (!isIdentityQuestion(message)) return null;
    const sheet = buildIdentityFactSheet();
    logger.info(COMPONENT, 'Identity intercept fired — fact-sheet appended to system prompt');
    return sheet;
}
