/**
 * TITAN — CI Stub Provider (v6.1.0-beta.11)
 *
 * Deterministic pattern-matched LLM provider used by CI eval suites
 * and offline tests. Returns canned, useful responses without making
 * any network call — so the Eval Gate workflow can run on every PR
 * without burning Anthropic / OpenAI credits OR requiring secrets
 * configured on the runner.
 *
 * WHAT this is:
 *   - A real LLMProvider implementation registered as `'stub'`.
 *   - Model IDs `stub/echo`, `stub/json`, `stub/refuse` route here.
 *   - Pattern-matches the last user message + system prompt against a
 *     small table of recognized shapes (chat, structured-JSON,
 *     tool-call, safety-refusal) and emits the appropriate response.
 *
 * WHY it exists:
 *   - Phase B.1 truth-table audit showed Eval Gate runs were scoring
 *     0% on every suite because no provider had credentials in CI.
 *   - The fix isn't "give CI an API key" — that bakes a real-money
 *     dependency into every push. The fix is a provider that can
 *     stand in for the real model deterministically.
 *   - The harness-engineering catalog (Picrew/awesome-agent-harness)
 *     explicitly recommends a "stub mode" so the harness itself is
 *     testable independent of any single LLM.
 *
 * TRADE-OFFS we deliberately accept:
 *   - The stub can't answer open-ended questions. It pattern-matches
 *     a fixed vocabulary. Suites that probe model creativity have
 *     no business running against the stub.
 *   - The stub knows the exact shapes our agent code expects (widget
 *     gate JSON, structuredSpawn JSON, tool-call format). When those
 *     shapes change, this file changes too. That coupling is OK —
 *     it's the price of CI-grade determinism.
 *
 * FOLLOW-UP:
 *   - When we add a new gated agent shape, add a recognizer here.
 *   - When we add a new built-in tool, add a recognizer here so
 *     tool-routing evals can exercise the dispatch path.
 */
import { LLMProvider } from './base.js';
import type {
    ChatMessage,
    ChatOptions,
    ChatResponse,
    ChatStreamChunk,
    ToolCall,
} from './base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'provider.stub';

/* ───────────────────────────  Pattern recognizers  ─────────────────────────── */

interface RecognizedIntent {
    /** Stable id of the matched pattern. Used by tests + telemetry. */
    kind: string;
    /** Plain-text body of the response. */
    content: string;
    /** Optional tool calls to emit alongside the text. */
    toolCalls?: ToolCall[];
    /** finish_reason on the response. */
    finishReason: 'stop' | 'tool_calls' | 'error';
}

/**
 * Inspect the conversation and decide what kind of response to emit.
 * Order matters — safety refusals first, then structured outputs,
 * then tool-call shapes, then default chat.
 */
function recognize(messages: ChatMessage[], hasTools: boolean): RecognizedIntent {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
    const system = messages.find(m => m.role === 'system')?.content ?? '';
    const combined = `${system}\n${lastUser}`.toLowerCase();
    const userOnly = lastUser.toLowerCase();

    // ── Safety refusal — keep first so injection attempts in the
    //    system prompt don't override it.
    if (
        /\b(rm\s+-rf|delete\s+everything|wipe\s+the\s+disk|drop\s+all\s+tables|format\s+the\s+drive)\b/i.test(lastUser)
    ) {
        return {
            kind: 'safety_refusal',
            content: 'Stub: I won\'t execute destructive system commands. Ask the user to confirm and run those manually.',
            finishReason: 'stop',
        };
    }

    // ── Structured JSON output — when the system prompt is asking
    //    for the structuredSpawn JSON envelope. The driver loop
    //    relies on this shape so the "done" path is reachable in CI.
    //    Recognizers are deliberately broad: any prompt asking for
    //    JSON output, or any mention of the spawn-envelope fields
    //    ("status", "artifacts", "confidence") together, triggers
    //    the structured-output path.
    const mentionsJsonOutput = /(respond|reply|return|output)\s+(with\s+)?(strict\s+)?json|json\s+containing|json\s+envelope|structuredSpawn|spawn\s+envelope/i.test(combined);
    const mentionsEnvelopeFields =
        /"status"/i.test(combined) &&
        /"artifacts"/i.test(combined) &&
        /"confidence"/i.test(combined);
    if (mentionsJsonOutput || mentionsEnvelopeFields) {
        const json = JSON.stringify({
            status: 'done',
            artifacts: [],
            questions: [],
            confidence: 0.9,
            reasoning: `Stub: pattern-matched structured-output request on prompt "${userOnly.slice(0, 60)}".`,
        });
        return {
            kind: 'structured_done',
            content: '```json\n' + json + '\n```',
            finishReason: 'stop',
        };
    }

    // ── Widget gate — TITAN's chat surface listens for a
    //    `_____widget` gate followed by a JSON line. The 100+ widget
    //    gallery routes off this signal; eval suites assert it.
    if (/widget|panel|gauge|dashboard|stock\s+ticker|pomodoro|calendar/i.test(userOnly)) {
        const widgetName = pickWidget(userOnly);
        const widgetJson = JSON.stringify({
            name: widgetName,
            format: 'system',
            source: 'gallery',
            w: 360,
            h: 240,
        });
        return {
            kind: 'widget_gate',
            content: `Adding the **${widgetName}** widget to your canvas.\n\n_____widget\n${widgetJson}`,
            finishReason: 'stop',
        };
    }

    // ── Tool-call shape — when tools are offered AND the user prompt
    //    clearly asks for one. Emits a tool_calls finish_reason so
    //    the agent loop dispatches the tool. The agent will then
    //    feed a tool_result back; that's handled below.
    if (hasTools) {
        const toolMatch = pickTool(userOnly);
        if (toolMatch) {
            return {
                kind: `tool_call:${toolMatch.name}`,
                content: '',
                toolCalls: [{
                    id: `stub-tool-${Date.now()}`,
                    type: 'function',
                    function: {
                        name: toolMatch.name,
                        arguments: JSON.stringify(toolMatch.args),
                    },
                }],
                finishReason: 'tool_calls',
            };
        }
    }

    // ── Tool-result continuation — if the LAST message is a tool
    //    result, we wrap up with a brief acknowledgement so the
    //    multi-round loop terminates cleanly.
    if (messages[messages.length - 1]?.role === 'tool') {
        return {
            kind: 'tool_result_ack',
            content: 'Stub: tool finished. Done.',
            finishReason: 'stop',
        };
    }

    // ── Default — plain chat echo. Includes the first 60 chars of
    //    the prompt so eval suites can assert on prompt threading.
    return {
        kind: 'echo',
        content: `Stub response. Echoing your request: "${lastUser.slice(0, 60)}".`,
        finishReason: 'stop',
    };
}

/* ───────────────────────────  Sub-recognizers  ─────────────────────────── */

/** Pick a widget name keyed off the user prompt. Defaults to a generic
 *  "Note" panel so the agent always has SOMETHING to add. */
function pickWidget(prompt: string): string {
    if (/stock|ticker|nasdaq|nyse/.test(prompt)) return 'Stock Ticker';
    if (/pomodoro|timer|focus/.test(prompt)) return 'Pomodoro Timer';
    if (/calendar|schedule/.test(prompt)) return 'Calendar';
    if (/gauge|meter|metric/.test(prompt)) return 'Gauge';
    if (/dashboard/.test(prompt)) return 'Dashboard';
    if (/clock|time/.test(prompt)) return 'Clock';
    return 'Note';
}

/** Pick a tool + arguments keyed off the user prompt. Returns null if
 *  no tool matches — caller falls through to text-only response. */
function pickTool(prompt: string): { name: string; args: Record<string, unknown> } | null {
    if (/search\s+for|google|find\s+information|web\s+search/.test(prompt)) {
        return { name: 'web_search', args: { query: extractAfter(prompt, /search\s+for|find/) || prompt.slice(0, 80) } };
    }
    if (/write\s+(a\s+)?file|save\s+to|create\s+(a\s+)?file/.test(prompt)) {
        return { name: 'write_file', args: { path: '/tmp/stub-output.txt', content: 'Stub provider wrote this file.' } };
    }
    if (/read\s+(a\s+)?file|open\s+the\s+file|show\s+me\s+the\s+contents/.test(prompt)) {
        return { name: 'read_file', args: { path: '/tmp/stub-input.txt' } };
    }
    if (/list\s+(the\s+)?(files|directory|dir)|what.s\s+in\s+the\s+folder/.test(prompt)) {
        return { name: 'list_dir', args: { path: '/tmp' } };
    }
    if (/fetch|http|download.+url/.test(prompt)) {
        return { name: 'web_fetch', args: { url: 'https://example.com' } };
    }
    if (/download\s+(an?\s+)?image|embed\s+image/.test(prompt)) {
        return { name: 'download_image', args: { url: 'https://example.com/sample.jpg' } };
    }
    return null;
}

/** Extract the part of the prompt AFTER a matched intent verb. Used to
 *  pull the search query / file name / etc. out of the prompt. */
function extractAfter(prompt: string, re: RegExp): string {
    const m = prompt.match(re);
    if (!m) return '';
    const idx = (m.index ?? -1) + m[0].length;
    if (idx < 0) return '';
    return prompt.slice(idx).trim().replace(/[.?!]+$/, '').slice(0, 80);
}

/* ───────────────────────────  Provider  ─────────────────────────── */

export class StubProvider extends LLMProvider {
    readonly name = 'stub';
    readonly displayName = 'TITAN Stub (CI/offline)';

    /**
     * Always configured. The whole point is that the stub works
     * without any credentials so CI can run end-to-end.
     */
    isConfigured(): boolean {
        return true;
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const intent = recognize(options.messages, !!options.tools?.length);
        logger.debug(COMPONENT, `chat() kind=${intent.kind} model=${options.model ?? 'stub/echo'}`);
        const promptTokens = approxTokens(options.messages);
        const completionTokens = approxTokens([{ role: 'assistant', content: intent.content }]);
        return {
            id: `stub-${Date.now()}`,
            content: intent.content,
            toolCalls: intent.toolCalls,
            usage: {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
            },
            finishReason: intent.finishReason,
            model: options.model || 'stub/echo',
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const intent = recognize(options.messages, !!options.tools?.length);
        logger.debug(COMPONENT, `chatStream() kind=${intent.kind}`);
        // Emit text content first (if any), then any tool calls,
        // then a done marker. Matches the shape real providers use.
        if (intent.content) {
            yield { type: 'text', content: intent.content };
        }
        if (intent.toolCalls) {
            for (const tc of intent.toolCalls) {
                yield { type: 'tool_call', toolCall: tc };
            }
        }
        yield { type: 'done' };
    }

    async listModels(): Promise<string[]> {
        return ['stub/echo', 'stub/json', 'stub/refuse'];
    }

    async healthCheck(): Promise<boolean> {
        return true;
    }
}

/* ───────────────────────────  Token estimator  ─────────────────────────── */

/** ~4 chars per token rule-of-thumb. Not exact, but stable enough for
 *  cost-budget tests that only need monotonicity. */
function approxTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) chars += (m.content ?? '').length;
    return Math.max(1, Math.ceil(chars / 4));
}

/* ───────────────────────────  CI detection  ─────────────────────────── */

/**
 * Returns true when the runtime should fall back to the stub provider
 * because no real provider credentials are available. The default
 * model picker (`defaultModel.ts`) calls this to choose `stub/echo`
 * as the floor model in CI / offline environments.
 *
 * Trigger conditions (any one is enough):
 *   - Explicit opt-in:    `TITAN_STUB_PROVIDER=1`
 *   - Standard CI signal: `CI=true`  AND  no Anthropic/OpenAI/Google key
 *
 * NOTE: we DELIBERATELY do NOT trigger on `VITEST=true`. Existing
 * unit tests (default-model-picker.test.ts in particular) pin the
 * "no keys → ollama" behavior; flipping that under VITEST would
 * break those tests. Tests that want the stub should set
 * `TITAN_STUB_PROVIDER=1` in their setup explicitly.
 */
export function shouldUseStubProvider(): boolean {
    if (process.env.TITAN_STUB_PROVIDER === '1') return true;
    if (process.env.CI === 'true') {
        const hasRealKey = !!(
            process.env.ANTHROPIC_API_KEY ||
            process.env.OPENAI_API_KEY ||
            process.env.GOOGLE_API_KEY ||
            process.env.OPENROUTER_API_KEY
        );
        return !hasRealKey;
    }
    return false;
}
