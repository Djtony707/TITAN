/**
 * TITAN — Output Guardrails Pipeline
 *
 * Centralized post-processing for ALL LLM output before it reaches users.
 * Treats every LLM response as untrusted data — structurally validates,
 * strips chain-of-thought leaks, and scores quality before delivery.
 *
 * Inspired by OpenClaw's 6-stage output pipeline but adapted for Ollama
 * cloud models (glm-5.1, qwen3-coder, nemotron) that don't have structured
 * thinking blocks and leak chain-of-thought as plain text.
 *
 * Pipeline: EXTRACT → CLEAN → VALIDATE → SCORE
 *
 * Usage:
 *   const result = applyOutputGuardrails(rawLLMOutput, { type: 'chat_response' });
 *   if (result.passed) deliverToUser(result.content);
 *   else retry();
 */
import logger from '../utils/logger.js';

const COMPONENT = 'OutputGuardrails';

// ── Types ────────────────────────────────────────────────────────

export type OutputContext =
    | 'chat_response'
    | 'facebook_post'
    | 'email'
    | 'sub_agent'
    | 'tool_result';

export interface GuardrailOptions {
    type: OutputContext;
    originalMessage?: string;
    model?: string;
    /** Custom structural requirements for validation stage */
    requirements?: {
        minLength?: number;
        maxLength?: number;
        mustContain?: string[];
        mustNotStartWith?: RegExp[];
    };
}

export interface GuardrailResult {
    content: string;
    originalContent: string;
    score: number;
    passed: boolean;
    stages: {
        extracted: string;
        cleaned: string;
        validated: boolean;
        validationIssues: string[];
    };
}

// ── Stage 1: EXTRACT ─────────────────────────────────────────────
// Strip thinking blocks, XML tags, internal markers.
// Equivalent to OpenClaw's dropThinkingBlocks + stripBlockTags.

function extractContent(raw: string): string {
    let text = raw;

    // Strip <think>...</think> blocks (Qwen, DeepSeek thinking models)
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Strip <final>...</final> wrapper tags but keep inner content
    text = text.replace(/<\/?final>/gi, '').trim();

    // Strip markdown response headers the model sometimes adds
    text = text.replace(/^#+\s*(?:Response|Answer|Reply|Output|Result)\s*:?\s*\n/i, '').trim();

    // Strip XML-style tags that aren't part of actual content
    // (tool_call blocks, system blocks, internal markers)
    text = text.replace(/<\/?(?:tool_call|system|internal|context|instruction)[^>]*>/gi, '').trim();

    // Strip triple-backtick wrapper if the entire content is wrapped
    // (model outputting `\`\`\`\nactual content\n\`\`\``)
    const codeBlockMatch = text.match(/^```\w*\n([\s\S]+?)\n```$/);
    if (codeBlockMatch && !text.includes('\n```\n')) {
        text = codeBlockMatch[1].trim();
    }

    return text;
}

// ── Stage 2: CLEAN ───────────────────────────────────────────────
// Remove meta-language, instruction echoes, narrator preamble.
// Absorbs TITAN's existing stripNarratorPreamble + stripToolJson.

/** Patterns that indicate the model is talking ABOUT the task instead of doing it */
const META_PREAMBLE_PATTERNS: RegExp[] = [
    // "The user wants/asked/needs..." — narrator describing the request
    /^(?:The user (?:wants|asked|needs|is asking|requested|said)[^.]*\.\s*)/i,
    // "I should/need to/will..." — model planning out loud
    /^(?:I (?:should|need to|will|can|could|would|might|must)\s+\w+[^.]*\.\s*)/i,
    // "Let me think/brainstorm/analyze..." — model narrating its process
    /^(?:Let me\s+\w+[^.]*\.\s*)/i,
    /^(?:Let's\s+(?:brainstorm|think|see|try|start|figure|look|analyze)[^.]*\.\s*)/i,
    // "Okay/OK/Alright/Well, let me..." — filler + planning
    /^(?:(?:Okay|OK|Alright|Well|Hmm|Sure|Right),?\s+(?:let me|let's|I'll|I should|I need|so)[^.]*\.\s*)/i,
    // "Looking at the results..." — narrating observation
    /^(?:Looking at\s+[^.]*\.\s*)/i,
    // "Based on my analysis/research, ..." — unnecessary preamble (only strip up to the comma)
    /^(?:Based on\s+(?:my|the|this)\s+\w+[^,]*,\s*)/i,
    // "Here's what I found:" — meta-introduction.
    // `[^:{}]*` excludes braces so we don't accidentally eat into leaked
    // tool JSON like `Here is the answer. {"name": ...}` and strip the
    // real answer along with it (Hunt 2026-04-17).
    /^(?:Here(?:'s| is) (?:what|the|my)\s+[^:{}\n]*:\s*)/i,
    // "Actually, ..." — model self-correcting out loud
    /^(?:Actually,?\s+)/i,
];

/** Patterns that indicate the model is echoing instructions or examples back */
const INSTRUCTION_ECHO_PATTERNS: RegExp[] = [
    /\b(?:under \d+ (?:char|word|sentence))/i,
    /\b(?:output only|write only|respond with only)\b/i,
    /\b(?:no explanation|no brainstorming|no numbered list|no planning)\b/i,
    /\b(?:in first person|confident.*tone|playful.*tone)\b/i,
    /\b(?:similar style|like the example|following the format)\b/i,
    /\b(?:include \d+-?\d* hashtag)/i,
    // Parenthetical instruction echo: "(under 280 chars, 2-3 hashtags)"
    /\((?:under \d+|must include|should be|include \d+)/i,
    // Starts with parenthetical instruction description
    /^\s*\((?:under|must|should|include|use|keep|make)/i,
    // Example echoing — model copies the example instead of writing new content
    /^(?:Example\s*(?:given|post|of|:))/i,
    /^(?:\*?\*?Reference\s*(?:Example|Post)\*?\*?\s*:)/i,
    /\b(?:did you know I can)\b.*\byeah,?\s+I'm kind of a big deal\b/i,
    /\b(?:Pro tip:.*autonomous mode.*independently)\b/i, // Specific example echo
];

function cleanContent(text: string, type: OutputContext): string {
    if (type === 'tool_result') return text; // Don't clean tool results

    let cleaned = text;

    // Strip narrator preamble — try each pattern, take the first match
    for (const pattern of META_PREAMBLE_PATTERNS) {
        const match = cleaned.match(pattern);
        if (match) {
            const remainder = cleaned.slice(match[0].length).trim();
            // Only strip if there's meaningful content after the preamble
            if (remainder.length > 20) {
                logger.debug(COMPONENT, `[Clean] Stripped preamble: "${match[0].slice(0, 60)}"`);
                cleaned = remainder;
                break; // Only strip one preamble layer
            }
        }
    }

    // Strip instruction echoes embedded in the content
    for (const pattern of INSTRUCTION_ECHO_PATTERNS) {
        if (pattern.test(cleaned)) {
            // Don't strip — just flag. The score stage will deduct points.
            break;
        }
    }

    // Strip trailing planning ("I should also...", "Next I'll...")
    cleaned = cleaned.replace(/\s*(?:I should also|Next I'll|I could also|Additionally, I)[^.]*\.?\s*$/i, '').trim();

    // Strip example/reference labels that the model prepended
    cleaned = cleaned.replace(/^\*?\*?(?:Reference|Example|Sample|Draft)\s*(?:Example|Post|:)?\*?\*?\s*:?\s*/i, '').trim();
    // Strip wrapping quotes (model sometimes quotes the post)
    cleaned = cleaned.replace(/^["'""]|["'""]$/g, '').trim();

    // Strip tool JSON blocks that leaked into text
    cleaned = cleaned.replace(/```json\s*\{[\s\S]*?\}\s*```/g, '').trim();
    cleaned = cleaned.replace(/\{"(?:name|function|tool_call)"[\s\S]*?\}/g, '').trim();

    // Collapse multiple newlines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    return cleaned;
}

// ── Stage 3: VALIDATE ────────────────────────────────────────────
// Context-specific structural checks.

interface ValidationResult {
    valid: boolean;
    issues: string[];
}

function validateContent(text: string, opts: GuardrailOptions): ValidationResult {
    const issues: string[] = [];
    const req = opts.requirements || {};

    // Universal: must not be empty
    if (!text || text.trim().length === 0) {
        issues.push('empty');
        return { valid: false, issues };
    }

    // Custom length requirements
    if (req.minLength && text.length < req.minLength) {
        issues.push(`too_short:${text.length}<${req.minLength}`);
    }
    if (req.maxLength && text.length > req.maxLength) {
        issues.push(`too_long:${text.length}>${req.maxLength}`);
    }

    // Custom must-contain checks
    if (req.mustContain) {
        for (const pattern of req.mustContain) {
            if (!text.includes(pattern)) {
                issues.push(`missing:${pattern}`);
            }
        }
    }

    // Context-specific validation
    switch (opts.type) {
        case 'chat_response': {
            // Must not start with meta-language that slipped past cleaning
            const badStarts = /^\s*(?:I'll\s+(?:go with|brainstorm|think|start)|I should\s|I could\s|I would\s|I need to\s|Let me\s|Let's\s|The user\s|The example\s|Option \d|Approach\s*:|Topic\s*:)/i;
            if (badStarts.test(text)) {
                issues.push('starts_with_meta');
            }
            break;
        }

        case 'facebook_post': {
            // Must have at least one hashtag
            if (!/#\w+/.test(text)) {
                issues.push('no_hashtag');
            }
            // Must be 40-400 chars
            if (text.length < 40) issues.push('fb_too_short');
            if (text.length > 400) issues.push('fb_too_long');
            // Must not start with planning/brainstorming
            const fbBadStarts = /^\s*(?:I'll\s|I should\s|I could\s|Let me\s|Let's\s|The user\s|Here(?:'s| is)\s|(?:OK|Okay|Alright|Well|So|Hmm),?\s|^\d+\.\s|Should I|What if I|How about|Maybe I)/i;
            if (fbBadStarts.test(text)) {
                issues.push('fb_starts_with_meta');
            }
            // Must not start with a parenthetical — that's always an instruction echo
            if (/^\s*\(/.test(text)) {
                issues.push('fb_starts_with_paren');
            }
            // Must not be a numbered brainstorm list
            if (/^\s*1\.\s+.{5,}\n\s*2\.\s+/.test(text)) {
                issues.push('fb_numbered_list');
            }
            // Must have real sentence structure — not just instructions wrapped in hashtags
            // Count actual words vs instruction words
            const instructionWords = /\b(?:under|must|include|should|character|hashtag|tone|first person)\b/gi;
            const matches = text.match(instructionWords) || [];
            if (matches.length >= 3) {
                issues.push('fb_instruction_heavy');
            }
            break;
        }

        case 'email':
            // Minimal validation — just ensure it's not empty
            break;

        case 'sub_agent':
        case 'tool_result':
            // Pass through — these don't need structural validation
            break;
    }

    return { valid: issues.length === 0, issues };
}

// ── Stage 4: SCORE ───────────────────────────────────────────────
// Quality gate — score 0-100, pass/fail threshold.

function scoreContent(
    original: string,
    cleaned: string,
    validation: ValidationResult,
    opts: GuardrailOptions,
): number {
    let score = 100;

    // Deductions for cleaning that was needed
    if (original.length > 0 && cleaned.length < original.length * 0.5) {
        score -= 30; // More than half was stripped — likely garbage
    }

    // Deductions for instruction echoes
    for (const pattern of INSTRUCTION_ECHO_PATTERNS) {
        if (pattern.test(cleaned)) {
            score -= 10;
            break;
        }
    }

    // Deductions for validation issues
    for (const issue of validation.issues) {
        if (issue === 'empty') score -= 100;
        else if (issue.startsWith('starts_with_meta') || issue.startsWith('fb_starts_with_meta')) score -= 60;
        else if (issue === 'fb_starts_with_paren') score -= 80;   // Instruction echo in parens
        else if (issue === 'fb_instruction_heavy') score -= 70;   // Too many instruction words
        else if (issue === 'no_hashtag') score -= 60;       // FB post MUST have hashtag
        else if (issue === 'fb_numbered_list') score -= 80;  // Brainstorm lists are never valid posts
        else if (issue.startsWith('fb_too_short')) score -= 60;  // Under 40 chars is never a valid FB post
        else if (issue.startsWith('too_short')) score -= 30;
        else if (issue.startsWith('too_long') || issue.startsWith('fb_too_long')) score -= 10;
        else if (issue.startsWith('missing:')) score -= 15;
        else score -= 10;
    }

    return Math.max(0, Math.min(100, score));
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Apply the full output guardrails pipeline to raw LLM output.
 *
 * @param raw - The raw LLM response text
 * @param opts - Context and requirements for validation
 * @returns GuardrailResult with cleaned content, score, and pass/fail
 */
export function applyOutputGuardrails(raw: string, opts: GuardrailOptions): GuardrailResult {
    const original = raw || '';

    // Stage 1: Extract
    const extracted = extractContent(original);

    // Stage 2: Clean
    const cleaned = cleanContent(extracted, opts.type);

    // Stage 3: Validate
    const validation = validateContent(cleaned, opts);

    // Stage 4: Score
    const score = scoreContent(original, cleaned, validation, opts);
    const passed = score >= 50;

    // Truncate if over max length (after validation flagged it)
    let finalContent = cleaned;
    if (opts.requirements?.maxLength && finalContent.length > opts.requirements.maxLength) {
        finalContent = finalContent.slice(0, opts.requirements.maxLength - 3) + '...';
    }

    if (!passed) {
        logger.warn(COMPONENT, `[REJECTED] score=${score}/100 type=${opts.type} issues=[${validation.issues.join(',')}] content="${finalContent.slice(0, 120)}"`);
    } else if (original !== finalContent) {
        logger.debug(COMPONENT, `[CLEANED] score=${score}/100 type=${opts.type} stripped=${original.length - finalContent.length} chars`);
    }

    return {
        content: finalContent,
        originalContent: original,
        score,
        passed,
        stages: {
            extracted,
            cleaned,
            validated: validation.valid,
            validationIssues: validation.issues,
        },
    };
}
