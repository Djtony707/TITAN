/**
 * TITAN — Structured Spawn (v4.10.0-local, Phase A)
 *
 * Wraps spawnSubAgent() to force structured JSON output. The spawned
 * specialist's prompt gets a tail instruction: "end your response with
 * a JSON block in this shape." The parser is tolerant — extracts JSON
 * even if there's prose before/after, falls back to `needs_info` if no
 * JSON is found at all.
 *
 * Why this matters: without structured output, the driver has to parse
 * prose and guess whether the specialist succeeded. That guess is where
 * the "I don't know what to do" bug landed as `done`. With structured
 * output, the driver reads a boolean.
 */
import logger from '../utils/logger.js';
import { spawnSubAgent } from './subAgent.js';
import { resolveSpecialist } from './specialistRouter.js';
import { getSessionGoal } from './autonomyContext.js';
import type {
    StructuredSpawnResult,
    StructuredSpawnStatus,
    StructuredArtifact,
} from './structuredSpawnTypes.js';

const COMPONENT = 'StructuredSpawn';

export interface StructuredSpawnOpts {
    specialistId: string; // 'scout' | 'builder' | 'writer' | 'analyst' | 'default'
    template?: string; // optional template for spawnSubAgent routing
    task: string;
    modelOverride?: string;
    toolAllowlist?: string[];
    maxRounds?: number;
    /** Additional system context appended to the specialist's prompt. */
    extraContext?: string;
}

// ── Tail instruction that forces the JSON output ─────────────────

const JSON_TAIL_INSTRUCTION = `

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL — END YOUR RESPONSE WITH THIS JSON BLOCK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your final response MUST end with a JSON block in this exact shape,
wrapped in \`\`\`json code fences, placed at the very end:

\`\`\`json
{
  "status": "done" | "failed" | "needs_info" | "blocked",
  "artifacts": [
    {"type": "file" | "url" | "fact" | "report", "ref": "path or url or key", "description": "brief"}
  ],
  "questions": ["If status is needs_info, put your clarifying questions here"],
  "confidence": 0.0 to 1.0,
  "reasoning": "1-3 sentence summary of what you did and why you chose this status"
}
\`\`\`

Status meanings:
  done        — the task is complete; artifacts produced
  failed      — you tried but couldn't complete (include reason in reasoning)
  needs_info  — you need information from the human before continuing
  blocked     — external dependency is blocking (credential, service, etc.)

Do NOT claim "done" unless you have concrete artifacts (files written,
URLs fetched, facts established). When in doubt, use "needs_info" and
put your actual question in the questions array.
`;

// ── Parser ───────────────────────────────────────────────────────

const STATUS_VALUES: ReadonlySet<StructuredSpawnStatus> = new Set([
    'done', 'failed', 'needs_info', 'blocked',
]);

function extractJsonBlock(text: string): string | null {
    // Preferred: ```json ... ``` code fence
    const fence = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fence) {
        const inner = fence[1].trim();
        if (inner.startsWith('{')) return inner;
    }
    // Fallback: last standalone JSON object at end of text
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > 0) {
        // Find matching '{' by walking back from lastBrace
        let depth = 0;
        for (let i = lastBrace; i >= 0; i--) {
            if (text[i] === '}') depth++;
            else if (text[i] === '{') {
                depth--;
                if (depth === 0) {
                    return text.slice(i, lastBrace + 1);
                }
            }
        }
    }
    return null;
}

function sanitizeArtifact(raw: unknown): StructuredArtifact | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const type = typeof r.type === 'string' ? r.type : 'fact';
    const ref = typeof r.ref === 'string' ? r.ref : '';
    if (!ref) return null;
    const validTypes = new Set(['file', 'url', 'fact', 'report']);
    return {
        type: (validTypes.has(type) ? type : 'fact') as StructuredArtifact['type'],
        ref,
        description: typeof r.description === 'string' ? r.description : undefined,
    };
}

/**
 * Prose-fallback: when the specialist returns natural language without a
 * JSON block, heuristically infer status + extract artifacts (URLs, file
 * paths) from the prose. Better than failing to `needs_info` for every
 * specialist that ignores the formatting instruction.
 *
 * Conservative — we only use this path when the prose has a clear signal
 * that the work is either (a) demonstrably done (file paths, URLs, clear
 * completion phrases) or (b) demonstrably failed. Otherwise we still fall
 * through to needs_info so the human gets asked.
 *
 * v4.10.0-local fix: Added "thinking" pattern detection. When specialists
 * (especially local Ollama models like glm-5.1) return "Now let me check..."
 * prose, this indicates they're starting work, not failing. Treat as failed
 * with a retry signal so the driver can respawn rather than blocking forever.
 */
function proseFallback(raw: string): Omit<StructuredSpawnResult, 'rawResponse'> | null {
    const lower = raw.toLowerCase();

    // Give-up phrases → failed (not needs_info — the spec is clear)
    const giveups = [
        "i don't have a specific task",
        'no specific task to act on',
        "i don't know what to do",
        'cannot complete',
        'unable to determine',
    ];
    if (giveups.some(g => lower.includes(g))) {
        return {
            status: 'failed',
            artifacts: [],
            questions: [],
            confidence: 0.2,
            reasoning: `Prose-fallback: specialist gave up. ${raw.slice(0, 200)}`,
            parseError: 'prose-fallback:give-up',
        };
    }

    // v4.10.0-local fix: "Thinking" patterns indicate the model is starting
    // work but hasn't produced JSON yet. Treat as failed with retry signal.
    // This handles Ollama models (glm-5.1, qwen3.6) that emit "Now let me..."
    // instead of following the JSON tail instruction.
    const thinkingPatterns = [
        /^now let me /i,
        /^let me /i,
        /^i will /i,
        /^i'll /i,
        /^first,? let me /i,
        /^ok, let me /i,
        /^okay, let me /i,
        /^sure,? let me /i,
        /^alright,? let me /i,
    ];
    const isThinking = thinkingPatterns.some(p => p.test(raw.trim()));
    if (isThinking) {
        return {
            status: 'failed',
            artifacts: [],
            questions: [],
            confidence: 0,
            reasoning: `Prose-fallback: specialist returned thinking prose instead of JSON. Treating as retryable. Raw: ${raw.slice(0, 200)}`,
            parseError: 'prose-fallback:thinking',
        };
    }

    // Clear completion signals in prose
    const doneMarkers = [
        /\b(i['']ve |i have |just )?(completed|finished|done|written|created|wrote|saved|produced|cataloged|catalogued|recorded|stored|documented|summarized)\b/i,
        /\b(the )?(task|work|research|report|analysis|catalog|investigation) is (complete|done|finished)\b/i,
        /\bhere (is|are) (the |my )?(result|summary|report|findings|answer|catalog|analysis)/i,
        /\b(successfully|verified).{0,30}(wrote|created|completed|built|stored|saved|cataloged)\b/i,
        /\bstored (the |a )?(result|summary|catalog|analysis|findings) (in|to) memory\b/i,
        /\b\d+\s+(error patterns?|items?|entries?|categories?)\s+(cataloged|catalogued|analyzed|stored|recorded)\b/i,
    ];
    const hasDoneMarker = doneMarkers.some(p => p.test(raw));

    // Extract artifacts from prose
    const urls = Array.from(raw.matchAll(/https?:\/\/[^\s)\]]+/g)).map(m => m[0]);
    const filePaths = Array.from(raw.matchAll(/(?:^|\s)(\/[a-zA-Z0-9_\-.\/]+\.[a-zA-Z]{1,6})\b/g)).map(m => m[1]);
    const artifacts: StructuredArtifact[] = [
        ...urls.slice(0, 10).map(u => ({ type: 'url' as const, ref: u })),
        ...filePaths.slice(0, 10).map(p => ({ type: 'file' as const, ref: p })),
    ];

    // Question signals
    const askMarkers = [
        /\b(could you|can you|please (tell|clarify|confirm|specify)|need (more info|clarification))/i,
        /\?\s*$/,
    ];
    const looksLikeQuestion = askMarkers.some(p => p.test(raw.slice(-400)));

    // Decision ladder:
    //   - Clear done marker + ≥200 chars of content → 'done' with moderate confidence
    //   - Clear done marker without content → 'done' with low confidence
    //   - Asking a question → 'needs_info'
    //   - Otherwise, null (caller falls back to original needs_info path)
    if (hasDoneMarker) {
        const contentLen = raw.trim().length;
        if (contentLen < 50) return null;
        return {
            status: 'done',
            artifacts,
            questions: [],
            confidence: contentLen >= 200 && artifacts.length > 0 ? 0.75
                : contentLen >= 200 ? 0.65
                : 0.5,
            reasoning: `Prose-fallback: specialist reported completion in prose (no JSON). Content: ${raw.slice(0, 300)}`,
            parseError: 'prose-fallback:done',
        };
    }

    if (looksLikeQuestion && raw.length > 30) {
        const questions = Array.from(raw.matchAll(/([^.!?\n]+\?)/g)).map(m => m[1].trim()).slice(0, 3);
        return {
            status: 'needs_info',
            artifacts,
            questions: questions.length > 0 ? questions : ['Specialist asked a clarifying question'],
            confidence: 0.3,
            reasoning: `Prose-fallback: specialist asked clarifying questions instead of completing. ${raw.slice(0, 200)}`,
            parseError: 'prose-fallback:question',
        };
    }

    return null;
}

export function parseStructuredResponse(
    raw: string,
): Omit<StructuredSpawnResult, 'rawResponse'> {
    const jsonText = extractJsonBlock(raw);
    if (!jsonText) {
        // v4.10.0-local (Phase E polish): prose-fallback. Try to infer
        // status from natural language before giving up to needs_info.
        // Most LLMs under 10B params ignore structured-output instructions
        // when the task is conversational. This salvages those responses.
        const prose = proseFallback(raw);
        if (prose) return prose;
        // v4.10.0-local (post-deploy fix): when ALL fallbacks fail, return
        // `failed` — NOT `needs_info`. A parse error is a machine-level
        // problem ("the specialist returned prose instead of JSON"), not
        // a human-answerable question. Returning needs_info blocks the
        // driver on a bogus approval Tony can never resolve. Returning
        // failed lets the driver retry the subtask with a fresh spawn
        // (which with gemma4:31b/glm-5.1:cloud now succeeds).
        return {
            status: 'failed',
            artifacts: [],
            questions: [],
            confidence: 0,
            reasoning: `Parser could not extract JSON from specialist response. Raw (200 chars): ${raw.slice(0, 200)}`,
            parseError: 'no JSON block found',
        };
    }
    try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const rawStatus = typeof parsed.status === 'string' ? parsed.status : 'needs_info';
        const status: StructuredSpawnStatus = STATUS_VALUES.has(rawStatus as StructuredSpawnStatus)
            ? (rawStatus as StructuredSpawnStatus)
            : 'needs_info';
        const artifacts = Array.isArray(parsed.artifacts)
            ? parsed.artifacts.map(sanitizeArtifact).filter((a): a is StructuredArtifact => a !== null)
            : [];
        const questions = Array.isArray(parsed.questions)
            ? parsed.questions.filter((q): q is string => typeof q === 'string')
            : [];
        const confidenceRaw = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
        const confidence = Math.max(0, Math.min(1, confidenceRaw));
        const reasoning = typeof parsed.reasoning === 'string'
            ? parsed.reasoning
            : (typeof parsed.summary === 'string' ? parsed.summary : '');
        return { status, artifacts, questions, confidence, reasoning };
    } catch (err) {
        // v4.10.0-local (post-deploy fix): JSON.parse failure is a machine
        // error, not a human-answerable question. Return `failed` so the
        // driver retries with a fresh spawn instead of blocking on an
        // approval Tony can never meaningfully answer. Matches the
        // extractJsonBlock path above.
        return {
            status: 'failed',
            artifacts: [],
            questions: [],
            confidence: 0,
            reasoning: `JSON.parse failure: ${(err as Error).message}. Raw (200 chars): ${raw.slice(0, 200)}`,
            parseError: (err as Error).message,
        };
    }
}

// ── Main entry ───────────────────────────────────────────────────

export async function structuredSpawn(opts: StructuredSpawnOpts): Promise<StructuredSpawnResult> {
    const specialist = resolveSpecialist(opts.specialistId);
    const model = opts.modelOverride || specialist?.model || 'fast';

    // Compose the task with the JSON-tail instruction + any extra context
    // + specialist system prompt (if specialist resolves).
    let task = opts.task;

    // v4.10.0-local polish: inject TITAN architecture map when the active
    // goal is self-mod tagged. Gives specialists the "where does my code
    // plug in?" knowledge so they don't leave dangling modules. Observed
    // 2026-04-19 morning: auto-heal module was built but never wired into
    // self-repair.ts because Builder didn't know the integration point.
    const goalCtx = getSessionGoal(null);
    if (goalCtx) {
        try {
            const { goalMatchesSelfModContext } = await import('./selfModStaging.js');
            const isSelfMod = goalMatchesSelfModContext(goalCtx.goalTitle, goalCtx.tags);
            if (isSelfMod) {
                const { renderArchitectureBlock } = await import('../memory/architecture.js');
                const archBlock = renderArchitectureBlock({ title: goalCtx.goalTitle, tags: goalCtx.tags });
                task = `${archBlock}\n\n${task}`;
            }
        } catch { /* architecture module unavailable — fall through */ }
    }

    if (opts.extraContext) task = `${task}\n\n${opts.extraContext}`;
    if (specialist?.systemPromptSuffix) {
        task = `${specialist.systemPromptSuffix}\n\n${task}`;
    }
    task = task + JSON_TAIL_INSTRUCTION;

    const template = opts.template || opts.specialistId;
    const startedAt = Date.now();

    logger.info(COMPONENT, `Spawning ${opts.specialistId} (model=${model}, maxRounds=${opts.maxRounds ?? 10})`);

    try {
        const result = await spawnSubAgent({
            name: template,
            task,
            model,
            maxRounds: opts.maxRounds ?? 10,
            tools: opts.toolAllowlist,
        });

        const raw = result?.content || '';
        const parsed = parseStructuredResponse(raw);
        const durationMs = Date.now() - startedAt;
        const full: StructuredSpawnResult = {
            ...parsed,
            rawResponse: raw,
            specialistId: opts.specialistId,
            toolsUsed: result?.toolsUsed || [],
            durationMs,
        };
        // Briefly log outcome so the driver's log has a trail
        logger.info(
            COMPONENT,
            `Spawn ${opts.specialistId} → status=${full.status} confidence=${full.confidence.toFixed(2)} artifacts=${full.artifacts.length} durationMs=${durationMs}`,
        );
        // Silence unused goalCtx (kept for future signature pass-through)
        void goalCtx;
        return full;
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        const msg = (err as Error).message;
        logger.warn(COMPONENT, `Spawn ${opts.specialistId} threw: ${msg}`);
        return {
            status: 'failed',
            artifacts: [],
            questions: [],
            confidence: 0,
            reasoning: `Spawn error: ${msg}`,
            rawResponse: '',
            specialistId: opts.specialistId,
            durationMs,
            parseError: msg,
        };
    }
}
