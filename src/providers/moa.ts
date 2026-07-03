/**
 * MoA — Mixture-of-Agents virtual provider (v7.1).
 *
 * A MoA preset = N reference "advisors" + 1 aggregator, exposed as a virtual
 * model (`moa/<preset>`) selectable anywhere a model is. On every chat call:
 *
 *   1. Advisors receive a TRIMMED conversation (no TITAN system prompt, no
 *      tool schemas, tool results truncated) plus an advisory system prompt —
 *      they advise, they never act.
 *   2. Advisors fan out in parallel with per-reference timeouts; a slow or
 *      failed advisor is dropped/noted, never awaited into oblivion.
 *   3. Their labeled guidance is appended at the END of the aggregator's
 *      prompt (prompt-cache prefix stays stable).
 *   4. The aggregator — the only voice — answers with the FULL tool schema
 *      through the normal loop.
 *
 * TITAN's edge over the same feature elsewhere: advisors default to LOCAL
 * models spread across separate machines (a "local council"), so the
 * mixture costs nothing and parallelizes across GPUs; and because whole
 * agents can be advisors via MCP, the mixture isn't limited to bare models.
 */
import { LLMProvider, type ChatOptions, type ChatResponse, type ChatStreamChunk, type ChatMessage } from './base.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'MoA';
const DEFAULT_REFERENCE_TIMEOUT_MS = 45_000;
const DEFAULT_REFERENCE_MAX_TOKENS = 1_024;
const TOOL_RESULT_TRIM = 4_000;

export interface MoaReference {
    /** provider/model id, e.g. "litellm/glm-4.7-flash" */
    model: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
}

export interface MoaPreset {
    references: MoaReference[];
    /** provider/model id of the acting aggregator */
    aggregator: string;
    enabled?: boolean;
    /** Optional cap for the aggregator's output */
    maxTokens?: number;
}

const ADVISOR_SYSTEM_PROMPT = [
    'You are a reference advisor inside a Mixture-of-Agents process. You are NOT the acting agent:',
    'you cannot call tools, and the user never sees your words. Another model (the aggregator) acts',
    'and answers — your output is private guidance handed to it. Give concise, concrete advice:',
    'the likely best next steps, tool-use strategy, risks, and anything the aggregator might miss.',
    'If the conversation references tools or systems you cannot access, advise from reasoning alone —',
    'never refuse for lack of access.',
].join(' ');

/** Trim the conversation for advisors: no system prompt, no tool schemas,
 *  tool transcripts flattened + truncated. Exported for tests. */
export function trimForReference(messages: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [{ role: 'system', content: ADVISOR_SYSTEM_PROMPT }];
    for (const m of messages) {
        if (m.role === 'system') continue; // TITAN's own harness prompt stays private
        if (m.role === 'tool') {
            const body = (m.content || '').slice(0, TOOL_RESULT_TRIM);
            out.push({ role: 'user', content: `[Tool result]\n${body}` } as ChatMessage);
            continue;
        }
        if (m.role === 'assistant' && m.toolCalls?.length) {
            const calls = m.toolCalls.map(tc => `${tc.function.name}(${(tc.function.arguments || '').slice(0, 300)})`).join('; ');
            out.push({ role: 'assistant', content: `${m.content || ''}\n[Called tools: ${calls}]`.trim() } as ChatMessage);
            continue;
        }
        out.push({ role: m.role, content: m.content } as ChatMessage);
    }
    return out;
}

/** Build the guidance block appended to the aggregator's prompt. Exported for tests. */
export function buildGuidanceBlock(results: Array<{ model: string; content: string | null; error?: string }>): string {
    const blocks = results.map((r, i) => {
        if (r.content) return `Reference ${i + 1} — ${r.model}:\n${r.content}`;
        return `Reference ${i + 1} — ${r.model}: (unavailable: ${r.error || 'no response'})`;
    });
    return [
        '[Mixture of Agents context — private guidance from reference advisors. The user cannot see this.',
        'Weigh it critically; you are the acting agent and the only voice.]',
        '',
        ...blocks,
    ].join('\n');
}

export function getMoaPresets(): Record<string, MoaPreset> {
    try {
        const cfg = loadConfig() as { moa?: { presets?: Record<string, MoaPreset> } };
        return cfg.moa?.presets || {};
    } catch {
        return {};
    }
}

export class MoaProvider extends LLMProvider {
    readonly name = 'moa';
    readonly displayName = 'Mixture of Agents';

    async healthCheck(): Promise<boolean> {
        return Object.keys(getMoaPresets()).length > 0;
    }

    async listModels(): Promise<string[]> {
        return Object.keys(getMoaPresets()).map(p => `moa/${p}`);
    }

    private resolvePreset(model?: string): { name: string; preset: MoaPreset } {
        const presets = getMoaPresets();
        const name = (model || '').replace(/^moa\//, '') || 'default';
        const preset = presets[name];
        if (!preset) throw new Error(`MoA preset "${name}" not found. Configure moa.presets.${name} in titan.json`);
        if (preset.references.some(r => r.model.startsWith('moa/'))) {
            throw new Error('MoA presets cannot reference other MoA presets (recursion blocked)');
        }
        if (preset.aggregator.startsWith('moa/')) {
            throw new Error('MoA aggregator cannot itself be a MoA preset (recursion blocked)');
        }
        return { name, preset };
    }

    /** Fan out to advisors; never throws — failures become guidance footnotes. */
    private async gatherGuidance(preset: MoaPreset, messages: ChatMessage[], signal?: AbortSignal):
        Promise<Array<{ model: string; content: string | null; error?: string; ms: number }>> {
        const { chat } = await import('./router.js');
        const trimmed = trimForReference(messages);
        const tasks = preset.references.map(async ref => {
            const started = Date.now();
            const timeoutMs = ref.timeoutMs ?? DEFAULT_REFERENCE_TIMEOUT_MS;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const onOuter = () => controller.abort();
            signal?.addEventListener('abort', onOuter, { once: true });
            try {
                const res = await chat({
                    model: ref.model,
                    messages: trimmed,
                    maxTokens: ref.maxTokens ?? DEFAULT_REFERENCE_MAX_TOKENS,
                    temperature: ref.temperature,
                    signal: controller.signal,
                    noFallback: true,
                } as ChatOptions & { noFallback: boolean });
                return { model: ref.model, content: res.content || null, ms: Date.now() - started };
            } catch (e) {
                return { model: ref.model, content: null, error: (e as Error).message.slice(0, 160), ms: Date.now() - started };
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onOuter);
            }
        });
        return Promise.all(tasks);
    }

    private async prepare(options: ChatOptions): Promise<{ preset: MoaPreset; name: string; aggregatorOptions: ChatOptions }> {
        const { name, preset } = this.resolvePreset(options.model);
        if (preset.enabled === false) {
            // Preset disabled → aggregator acts alone (Hermes-compatible semantics)
            return { preset, name, aggregatorOptions: { ...options, model: preset.aggregator } };
        }
        const t0 = Date.now();
        const guidance = await this.gatherGuidance(preset, options.messages, options.signal);
        const ok = guidance.filter(g => g.content).length;
        logger.info(COMPONENT, `[${name}] ${ok}/${preset.references.length} advisors answered in ${Date.now() - t0}ms (${guidance.map(g => `${g.model.split('/').pop()}:${g.ms}ms`).join(', ')})`);

        // Emit an observable event for the UI (mascot/Live Studio can narrate)
        try {
            const { titanEvents } = await import('../agent/daemon.js');
            titanEvents.emit('moa:guidance', { preset: name, advisors: guidance.map(g => ({ model: g.model, ok: !!g.content, ms: g.ms })) });
        } catch { /* events are best-effort */ }

        // Append guidance at the END (prompt-cache prefix stays stable)
        const messages: ChatMessage[] = [
            ...options.messages,
            { role: 'user', content: buildGuidanceBlock(guidance) } as ChatMessage,
        ];
        return {
            preset, name,
            aggregatorOptions: { ...options, model: preset.aggregator, messages, maxTokens: preset.maxTokens ?? options.maxTokens },
        };
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const { chat } = await import('./router.js');
        const { aggregatorOptions } = await this.prepare(options);
        return chat(aggregatorOptions);
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const { chatStream } = await import('./router.js');
        const { aggregatorOptions } = await this.prepare(options);
        yield* chatStream(aggregatorOptions);
    }
}
