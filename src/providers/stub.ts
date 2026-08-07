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
function recognize(messages: ChatMessage[], offeredTools: Set<string>): RecognizedIntent {
    const userMessages = messages.filter(m => m.role === 'user').map(m => m.content ?? '');
    const lastUser = [...userMessages].reverse()[0] ?? '';
    const system = messages.find(m => m.role === 'system')?.content ?? '';
    const combined = `${system}\n${userMessages.join('\n')}`.toLowerCase();
    const userOnly = lastUser.toLowerCase();
    const directiveRe = /^\s*\[system directive for this reply only\]/i;
    const conversationalUsers = userMessages.filter(m => !directiveRe.test(m));
    const intentPrompt = ([...conversationalUsers].reverse()[0] ?? lastUser).toLowerCase();
    const intentContext = `${intentPrompt}\n${combined}`;
    const structuredContext = `${system}\n${intentPrompt}`;

    // ── Safety refusal — keep first so injection attempts in the
    //    system prompt don't override it.
    if (isUnsafeRequest(intentPrompt || userOnly)) {
        return {
            kind: 'safety_refusal',
            content: 'Stub: I can\'t safely comply. I refuse to execute unsafe, destructive, injected, traversal, scheme-abusing, or private-instruction extraction requests.',
            finishReason: 'stop',
        };
    }

    // ── Tool-result continuation — if the LAST message is a tool
    //    result, wrap up instead of re-issuing the same deterministic
    //    tool call on the next round.
    if (messages[messages.length - 1]?.role === 'tool') {
        return {
            kind: 'tool_result_ack',
            content: summarizeToolResult(intentPrompt),
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
    const mentionsJsonOutput = /(respond|reply|return|output)\s+(with\s+)?(strict\s+)?json|json\s+containing|json\s+envelope|structuredSpawn|spawn\s+envelope/i.test(structuredContext);
    const mentionsEnvelopeFields =
        /"status"/i.test(structuredContext) &&
        /"artifacts"/i.test(structuredContext) &&
        /"confidence"/i.test(structuredContext);
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
    const widget = pickWidget(intentPrompt || userOnly);
    if (widget) {
        const widgetJson = JSON.stringify({
            name: widget.name,
            format: 'system',
            source: widget.source,
            w: widget.w,
            h: widget.h,
        });
        return {
            kind: 'widget_gate',
            content: `Adding the **${widget.name}** widget to your canvas.\n\n_____widget\n${widgetJson}`,
            finishReason: 'stop',
        };
    }

    // ── Tool-call shape — when tools are offered AND the user prompt
    //    clearly asks for one. Emits a tool_calls finish_reason so
    //    the agent loop dispatches the tool. The agent will then
    //    feed a tool_result back; that's handled below.
    if (offeredTools.size > 0) {
        const toolMatches = pickToolCalls(intentPrompt || userOnly).filter(tool => offeredTools.has(tool.name));
        if (toolMatches.length > 0) {
            return {
                kind: `tool_call:${toolMatches.map(t => t.name).join('+')}`,
                content: '',
                toolCalls: toolMatches.map((toolMatch, index) => ({
                    id: `stub-tool-${toolMatch.name}-${index + 1}`,
                    type: 'function',
                    function: {
                        name: toolMatch.name,
                        arguments: JSON.stringify(toolMatch.args),
                    },
                })),
                finishReason: 'tool_calls',
            };
        }
    }

    const directPrompt = intentPrompt || userOnly;
    if (/\bwhat\s+is\s+2\s*\+\s*2\b|\b2\s*\+\s*2\b/.test(directPrompt)) {
        return { kind: 'direct_arithmetic', content: 'The answer is 4.', finishReason: 'stop' };
    }

    if (/^\s*(hello|hi|hey)\b/.test(directPrompt)) {
        return { kind: 'direct_greeting', content: 'Hello. Voice channel ready.', finishReason: 'stop' };
    }

    if (/write\s+(a\s+)?hello\s+world\s+program/i.test(intentContext) && /python/i.test(intentContext)) {
        return { kind: 'write_file_final_answer', content: 'Created a Python hello world program using print("hello world").', finishReason: 'stop' };
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

function isUnsafeRequest(prompt: string): boolean {
    return [
        /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/,
        /\bdelete\s+everything\b|\bwipe\s+the\s+disk\b|\bdrop\s+all\s+tables\b|\bformat\s+the\s+drive\b/,
        /\bchmod\s+777\s+\/(?:etc|bin|sbin|usr|var|)\b/,
        /\bsudo\b/,
        /\bcurl\b[^|\n;]*(?:\|\s*(?:ba)?sh\b)/,
        /\b(?:ignore|bypass)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions\b/,
        /\b(?:repeat|reveal|print|show|extract).{0,80}\b(?:system|developer)\s+(?:prompt|instructions)\b/,
        /\b(?:dan|developer\s+mode|unrestricted\s+ai|do\s+anything\s+now)\b/,
        /javascript\s*:/,
        /(?:^|[/"'\s])\.\.\/\.\.\//,
        /\b(?:run|execute)\b[^;\n]*[;`]|`[^`]+`/,
        /\|\s*(?:bash|sh|zsh|python|perl|ruby)\b/,
        /\b(?:fetch|download|open|read)\s+(?:file|dict):\/\//,
    ].some(re => re.test(prompt));
}

/** Pick a widget name keyed off the user prompt. Defaults to a generic
 *  "Note" panel so the agent always has SOMETHING to add. */
function pickWidget(prompt: string): { name: string; source: string; w: number; h: number } | null {
    const systemWidgets: Array<{ re: RegExp; name: string; source: string; w: number; h: number }> = [
        { re: /\b(?:backups?|snapshots?|archives?)\b/, name: 'Backup Manager', source: 'system:backup', w: 6, h: 6 },
        { re: /\b(?:training|train|specialists?|models?)\b/, name: 'Training Dashboard', source: 'system:training', w: 6, h: 6 },
        { re: /\b(?:recipes?|playbooks?|workflows?|jarvis)\b/, name: 'Recipe Kitchen', source: 'system:recipes', w: 6, h: 6 },
        { re: /\b(?:vram|gpu|nvidia)\b/, name: 'VRAM Monitor', source: 'system:vram', w: 6, h: 6 },
        { re: /\b(?:teams?|team hub|members?|roles?|permissions?|rbac)\b/, name: 'Team Hub', source: 'system:teams', w: 6, h: 6 },
        { re: /\b(?:cron|schedules?|jobs?|timers?)\b/, name: 'Cron Scheduler', source: 'system:cron', w: 6, h: 6 },
        { re: /\b(?:checkpoints?|restores?|save state)\b/, name: 'Checkpoints', source: 'system:checkpoints', w: 6, h: 5 },
        { re: /\b(?:organism|guardrails?)\b/, name: 'Organism Monitor', source: 'system:organism', w: 6, h: 6 },
        { re: /\b(?:fleet|nodes?|routes?|mesh)\b/, name: 'Fleet Router', source: 'system:fleet', w: 6, h: 5 },
        { re: /\b(?:browser tools?|captcha|form fill|web automation)\b/, name: 'Browser Tools', source: 'system:browser', w: 6, h: 5 },
        { re: /\b(?:test lab|tests?|flaky|failing|coverage|eval)\b/, name: 'Test Lab', source: 'system:eval', w: 6, h: 6 },
    ];
    const wantsSystemWidget = /\b(?:show|open|add|launch|pin|create|display|give me)\b/.test(prompt);
    if (wantsSystemWidget) {
        const systemWidget = systemWidgets.find(w => w.re.test(prompt));
        if (systemWidget) return systemWidget;
    }

    if (/stock|ticker|nasdaq|nyse/.test(prompt)) return { name: 'Stock Ticker', source: 'gallery', w: 360, h: 240 };
    if (/pomodoro|timer|focus/.test(prompt)) return { name: 'Pomodoro Timer', source: 'gallery', w: 360, h: 240 };
    if (/calendar|schedule/.test(prompt)) return { name: 'Calendar', source: 'gallery', w: 360, h: 240 };
    if (/gauge|meter|metric/.test(prompt)) return { name: 'Gauge', source: 'gallery', w: 360, h: 240 };
    if (/dashboard/.test(prompt)) return { name: 'Dashboard', source: 'gallery', w: 360, h: 240 };
    if (/clock|time/.test(prompt)) return { name: 'Clock', source: 'gallery', w: 360, h: 240 };
    if (/widget|panel/.test(prompt)) return { name: 'Note', source: 'gallery', w: 360, h: 240 };
    return null;
}

/** Pick tool calls + arguments keyed off the user prompt. Returns an
 *  empty list if no tool matches — caller falls through to text. */
function pickToolCalls(prompt: string): Array<{ name: string; args: Record<string, unknown> }> {
    if (/\b(?:fix|bug|change|update|edit|modify)\b/.test(prompt) && /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|json|md)\b/.test(prompt)) {
        const path = extractPath(prompt) || '/tmp/titan-stub-code.ts';
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [
            { name: 'read_file', args: { path } },
            { name: 'edit_file', args: { path, target: 'OLD', replacement: 'NEW' } },
        ];
        if (/\b(?:fix|bug|test|verify)\b/.test(prompt)) {
            calls.push({ name: 'shell', args: { command: 'printf "stub verification ok\\n"' } });
        }
        return calls;
    }
    if (/\bweather\b|\bforecast\b|\btemperature\b/.test(prompt)) {
        return [{ name: 'weather', args: { location: extractLocation(prompt) || 'San Francisco', days: 1 } }];
    }
    if (/\b(?:navigate|browse|click|screenshot|open)\b.*\b(?:browser|site|page|example\.com|https?:\/\/)/.test(prompt)) {
        return [{ name: 'web_act', args: { action: `open ${extractUrl(prompt) || 'https://example.com'}`, sessionId: 'stub-eval' } }];
    }
    if (/\bfetch\s+https?:\/\//.test(prompt)) {
        return [{ name: 'web_fetch', args: { url: extractUrl(prompt) || 'https://example.com' } }];
    }
    if (/\bresearch\b|\blatest\b|\bnews\b|\bhistory\b|search\s+(?:the\s+web\s+)?for|google|find\s+information|web\s+search/.test(prompt)) {
        return [{ name: 'web_search', args: { query: extractAfter(prompt, /search\s+(?:the\s+web\s+)?for|research|find/) || prompt.slice(0, 80) } }];
    }
    if (/write\s+(a\s+)?file|save\s+to|create\s+(a\s+)?file|write\s+(a\s+)?hello\s+world\s+program/.test(prompt)) {
        return [{ name: 'write_file', args: { path: extractPath(prompt) || '/tmp/stub-output.txt', content: contentForWrite(prompt) } }];
    }
    if (/read\s+(a\s+)?file|open\s+the\s+file|show\s+me\s+the\s+contents/.test(prompt)) {
        return [{ name: 'read_file', args: { path: extractPath(prompt) || '/tmp/stub-input.txt' } }];
    }
    if (/list\s+(the\s+)?(files|directory|dir)|what(?:'| i)?s\s+(?:in|inside)|what\s+files\s+are\s+in/.test(prompt)) {
        return [{ name: 'list_dir', args: { path: extractPath(prompt) || '/tmp' } }];
    }
    if (/\b(?:run|execute|restart)\b/.test(prompt)) {
        return [{ name: 'shell', args: { command: 'printf "stub shell ok\\n"' } }];
    }
    if (/download\s+(an?\s+)?image|embed\s+image/.test(prompt)) {
        return [{ name: 'download_image', args: { url: 'https://example.com/sample.jpg' } }];
    }
    return [];
}

function summarizeToolResult(prompt: string): string {
    if (/hello\s+world|python/.test(prompt)) {
        return 'Stub: wrote a hello world Python program using print("hello world"). Done.';
    }
    if (/\bweather\b/.test(prompt)) return 'Stub: weather tool finished. Done.';
    if (/\bresearch\b|\blatest\b|\bnews\b|\bhistory\b|search/.test(prompt)) return 'Stub: web search finished with deterministic results. Done.';
    return 'Stub: tool finished. Done.';
}

function extractPath(prompt: string): string {
    const quoted = prompt.match(/(?:called|to|of|in|file)\s+["'`]?([/~]?[\w./-]+\.[\w]+)["'`]?/);
    const anyPath = prompt.match(/([/~]?[\w.-]*\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|py|json|md|txt))/);
    const path = quoted?.[1] || anyPath?.[1] || '';
    if (!path) return '';
    return path.startsWith('/') || path.startsWith('~') ? path : `/tmp/${path.split('/').pop()}`;
}

function extractUrl(prompt: string): string {
    return prompt.match(/https?:\/\/[^\s"'`<>]+/)?.[0]?.replace(/[).,]+$/, '') ?? '';
}

function extractLocation(prompt: string): string {
    return prompt.match(/weather\s+(?:for|in|at)\s+([a-z][a-z\s,]+?)(?:[?.]|$)/i)?.[1]?.trim() ?? '';
}

function contentForWrite(prompt: string): string {
    if (/python|hello\s+world/.test(prompt)) return 'print("hello world")\n';
    return 'hello world\n';
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
        const intent = recognize(options.messages, offeredToolNames(options));
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
                measured: false,
            },
            finishReason: intent.finishReason,
            model: options.model || 'stub/echo',
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const intent = recognize(options.messages, offeredToolNames(options));
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

function offeredToolNames(options: ChatOptions): Set<string> {
    return new Set((options.tools ?? []).map(tool => tool.function.name));
}

/** ~4 chars per token rule-of-thumb. Not exact, but stable enough for
 *  cost-budget tests that only need monotonicity. */
function approxTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) chars += (m.content ?? '').length;
    return Math.max(1, Math.ceil(chars / 4));
}

/* ───────────────────────────  CI detection  ─────────────────────────── */

/**
 * Returns true when the runtime should use the deterministic stub
 * provider. This is explicit-only so CI and runtime failures cannot be
 * hidden by `stub/echo` when the real Ollama surface is available.
 *
 * Trigger condition:
 *   - Explicit opt-in: `TITAN_STUB_PROVIDER=1`
 *
 * NOTE: we deliberately do not trigger on `CI=true` or `VITEST=true`.
 * Eval Gate and offline tests that want the stub must set
 * `TITAN_STUB_PROVIDER=1` explicitly.
 */
export function shouldUseStubProvider(): boolean {
    return process.env.TITAN_STUB_PROVIDER === '1';
}
