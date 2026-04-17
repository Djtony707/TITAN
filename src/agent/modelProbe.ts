/**
 * TITAN — Empirical Model Probe
 *
 * Models are unreliable narrators of their own behavior. We empirically probe
 * each model to discover its actual capabilities — thinking field routing,
 * native tool calling support, tool call format, latency, chain-of-thought
 * leaking, and system prompt handling.
 *
 * Results are cached in ~/.titan/model-capabilities.json and consulted at
 * call time by the provider layer so TITAN adapts automatically.
 *
 * Usage:
 *   const result = await probeModel('ollama/glm-5.1:cloud');
 *   // → { needsExplicitThinkFalse: true, nativeToolCalls: true, ... }
 */
import { chat } from '../providers/router.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ModelProbe';

// ── Types ────────────────────────────────────────────────────────

export type ThinkingRouting = 'content' | 'thinking' | 'both' | 'unknown';
export type ToolCallFormat = 'native' | 'xml' | 'json-text' | 'none' | 'unknown';

export interface ProbeResult {
    model: string;
    probedAt: string;

    // Thinking field behavior
    thinkingFieldRouting: ThinkingRouting;
    needsExplicitThinkFalse: boolean;
    hasThinkingMode: boolean;

    // Tool calling
    nativeToolCalls: boolean;
    toolCallFormat: ToolCallFormat;

    // Performance
    avgLatencyMs: number;
    samplesCount: number;

    // Quality
    leaksChainOfThought: boolean;
    chainOfThoughtSample?: string;

    // System prompt
    respectsSystemPrompt: boolean;

    // Metadata
    probeDurationMs: number;
    errors: string[];
}

// ── Probe implementations ────────────────────────────────────────

/**
 * Probe 1: Thinking field routing.
 * Send a simple prompt WITHOUT setting the think parameter, and check
 * whether the response comes back in content or thinking field.
 */
async function probeThinkingRouting(modelId: string): Promise<{
    routing: ThinkingRouting;
    needsExplicit: boolean;
    hasThinking: boolean;
}> {
    try {
        // Call without think parameter — let the model's default kick in.
        // noFallback: probes MUST hit the target model or fail cleanly. A silent
        // fallback to a different model would poison the capabilities registry.
        const response = await chat({
            model: modelId,
            messages: [{ role: 'user', content: 'Say the word "PROBE_OK" and nothing else.' }],
            maxTokens: 50,
            temperature: 0,
            noFallback: true,
        });

        const content = (response.content || '').trim();
        const thinking = ((response as unknown as Record<string, unknown>).thinking as string || '').trim();

        const contentHasReal = content.length > 0 && content.toLowerCase().includes('probe_ok');
        const thinkingHasReal = thinking.length > 0;

        if (contentHasReal && !thinkingHasReal) {
            return { routing: 'content', needsExplicit: false, hasThinking: false };
        }
        if (contentHasReal && thinkingHasReal) {
            return { routing: 'both', needsExplicit: false, hasThinking: true };
        }
        if (!contentHasReal && thinkingHasReal) {
            // Content empty but thinking has data — this is the problem case
            return { routing: 'thinking', needsExplicit: true, hasThinking: true };
        }
        return { routing: 'unknown', needsExplicit: false, hasThinking: false };
    } catch (err) {
        throw new Error(`thinking probe failed: ${(err as Error).message}`);
    }
}

/**
 * Probe 2: Native tool calling support.
 * Request a tool call and check whether the model returns tool_calls natively
 * or embeds them in the content (XML, JSON-in-text, etc.)
 */
async function probeToolCalling(modelId: string): Promise<{
    native: boolean;
    format: ToolCallFormat;
}> {
    try {
        const response = await chat({
            model: modelId,
            messages: [{ role: 'user', content: 'Call the echo tool with the message "hello probe".' }],
            tools: [{
                type: 'function',
                function: {
                    name: 'echo',
                    description: 'Echoes a message back',
                    parameters: {
                        type: 'object',
                        properties: {
                            message: { type: 'string', description: 'Message to echo' },
                        },
                        required: ['message'],
                    },
                },
            }],
            maxTokens: 200,
            temperature: 0,
            noFallback: true,
        });

        // Check for native tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
            return { native: true, format: 'native' };
        }

        // Check content for XML-wrapped or JSON-in-text tool calls
        const content = (response.content || '').toLowerCase();
        if (/<function_calls|<invoke|<tool_call/.test(content)) {
            return { native: false, format: 'xml' };
        }
        if (/^\s*\{\s*"(?:name|function|tool)"\s*:/.test(response.content || '')) {
            return { native: false, format: 'json-text' };
        }
        return { native: false, format: 'none' };
    } catch (err) {
        throw new Error(`tool calling probe failed: ${(err as Error).message}`);
    }
}

/**
 * Probe 3: Latency — 3 samples, return average.
 */
async function probeLatency(modelId: string, samples = 3): Promise<{
    avgMs: number;
    count: number;
}> {
    const latencies: number[] = [];
    for (let i = 0; i < samples; i++) {
        const start = Date.now();
        try {
            await chat({
                model: modelId,
                messages: [{ role: 'user', content: 'Reply with one word.' }],
                maxTokens: 10,
                temperature: 0,
                noFallback: true,
            });
            latencies.push(Date.now() - start);
        } catch {
            // Skip failed samples
        }
    }
    if (latencies.length === 0) return { avgMs: 0, count: 0 };
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    return { avgMs: Math.round(avg), count: latencies.length };
}

/**
 * Probe 4: Chain-of-thought leaking.
 * Ask for a short direct answer. If the model responds with planning
 * preamble ("Let me think...", "The user wants...", brainstorm lists),
 * it leaks chain-of-thought.
 */
async function probeCOT(modelId: string): Promise<{
    leaks: boolean;
    sample?: string;
}> {
    try {
        const response = await chat({
            model: modelId,
            messages: [{ role: 'user', content: 'Output only the word YES. Nothing else.' }],
            maxTokens: 100,
            temperature: 0,
            noFallback: true,
        });

        const content = (response.content || '').trim();
        const thinking = ((response as unknown as Record<string, unknown>).thinking as string || '').trim();
        const combined = (content || thinking).toLowerCase();

        // Detect common chain-of-thought preamble patterns
        const leakPatterns = [
            /^(?:the user (?:wants|asked|needs))/i,
            /^(?:let me\s+\w+)/i,
            /^(?:okay|alright|well|hmm|so),?\s+(?:let|i)/i,
            /^(?:i'?ll|i should|i need to|i can|i could)/i,
            /^(?:based on|looking at|here's|here is)/i,
            /^\d+\.\s+.{5,}\n\s*\d+\.\s+/, // Numbered brainstorm list
        ];

        const leaks = leakPatterns.some(p => p.test(content.toLowerCase()) || p.test(combined));
        return {
            leaks,
            sample: leaks ? (content || thinking).slice(0, 120) : undefined,
        };
    } catch (err) {
        throw new Error(`COT probe failed: ${(err as Error).message}`);
    }
}

/**
 * Probe 5: System prompt respect.
 * Set a system prompt that instructs a specific output. Check if the
 * model complies (respects it) or ignores it (needs merging into user message).
 */
async function probeSystemPrompt(modelId: string): Promise<{
    respects: boolean;
}> {
    try {
        const response = await chat({
            model: modelId,
            messages: [
                { role: 'system', content: 'You always start every response with the word "BEGIN:" followed by your answer.' },
                { role: 'user', content: 'What is 2+2?' },
            ],
            maxTokens: 50,
            temperature: 0,
            noFallback: true,
        });

        const content = ((response.content || '') + ((response as unknown as Record<string, unknown>).thinking as string || '')).trim();
        const respects = /\bBEGIN\s*:/i.test(content);
        return { respects };
    } catch (err) {
        throw new Error(`system prompt probe failed: ${(err as Error).message}`);
    }
}

// ── Main probe orchestrator ──────────────────────────────────────

/**
 * Run the full probe suite against a model. Returns a ProbeResult
 * with discovered capabilities and any probe errors.
 */
export async function probeModel(modelId: string): Promise<ProbeResult> {
    logger.info(COMPONENT, `Probing model: ${modelId}`);
    const start = Date.now();
    const errors: string[] = [];

    const result: ProbeResult = {
        model: modelId,
        probedAt: new Date().toISOString(),
        thinkingFieldRouting: 'unknown',
        needsExplicitThinkFalse: false,
        hasThinkingMode: false,
        nativeToolCalls: false,
        toolCallFormat: 'unknown',
        avgLatencyMs: 0,
        samplesCount: 0,
        leaksChainOfThought: false,
        respectsSystemPrompt: false,
        probeDurationMs: 0,
        errors: [],
    };

    // Probe 1: Thinking routing. This is the first real call to the target
    // model — if it fails with noFallback (target unreachable), abort the
    // entire probe so we never save partial/misleading data to the registry.
    try {
        const p = await probeThinkingRouting(modelId);
        result.thinkingFieldRouting = p.routing;
        result.needsExplicitThinkFalse = p.needsExplicit;
        result.hasThinkingMode = p.hasThinking;
    } catch (err) {
        const msg = (err as Error).message;
        if (/noFallback=true|Probe target .* unreachable/.test(msg)) {
            throw new Error(`Probe aborted for ${modelId}: target unreachable (${msg}). Registry not updated.`);
        }
        errors.push(`thinking: ${msg}`);
    }

    // Probe 2: Tool calling
    try {
        const p = await probeToolCalling(modelId);
        result.nativeToolCalls = p.native;
        result.toolCallFormat = p.format;
    } catch (err) {
        errors.push(`tools: ${(err as Error).message}`);
    }

    // Probe 3: Latency
    try {
        const p = await probeLatency(modelId, 3);
        result.avgLatencyMs = p.avgMs;
        result.samplesCount = p.count;
    } catch (err) {
        errors.push(`latency: ${(err as Error).message}`);
    }

    // Probe 4: Chain-of-thought
    try {
        const p = await probeCOT(modelId);
        result.leaksChainOfThought = p.leaks;
        result.chainOfThoughtSample = p.sample;
    } catch (err) {
        errors.push(`cot: ${(err as Error).message}`);
    }

    // Probe 5: System prompt
    try {
        const p = await probeSystemPrompt(modelId);
        result.respectsSystemPrompt = p.respects;
    } catch (err) {
        errors.push(`sysprompt: ${(err as Error).message}`);
    }

    result.probeDurationMs = Date.now() - start;
    result.errors = errors;

    logger.info(COMPONENT, `Probed ${modelId} in ${result.probeDurationMs}ms — routing=${result.thinkingFieldRouting}, native_tools=${result.nativeToolCalls}, latency=${result.avgLatencyMs}ms, cot_leaks=${result.leaksChainOfThought}`);

    return result;
}

/**
 * Summarize a probe result as a human-readable report line.
 */
export function formatProbeResult(r: ProbeResult): string {
    const flags: string[] = [];
    if (r.needsExplicitThinkFalse) flags.push('NEEDS think:false');
    if (r.nativeToolCalls) flags.push('native-tools');
    else if (r.toolCallFormat === 'xml') flags.push('xml-tools');
    if (r.leaksChainOfThought) flags.push('CoT-leaks');
    if (!r.respectsSystemPrompt) flags.push('ignores-system');

    return [
        `${r.model}`,
        `  latency: ${r.avgLatencyMs}ms (${r.samplesCount} samples)`,
        `  thinking: routes to ${r.thinkingFieldRouting}${r.hasThinkingMode ? ' (has thinking)' : ''}`,
        `  tools: ${r.toolCallFormat}`,
        `  flags: [${flags.join(', ') || 'clean'}]`,
        r.errors.length > 0 ? `  errors: ${r.errors.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}
