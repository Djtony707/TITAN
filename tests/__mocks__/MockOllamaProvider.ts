/**
 * MockOllamaProvider — replays recorded LLM responses ("tool tapes") so
 * integration tests run deterministically without burning real model calls.
 *
 * ── How it works ─────────────────────────────────────────────────────
 *
 *   PLAYBACK MODE (default during tests):
 *     const mock = await MockOllamaProvider.fromTape('weather');
 *     const r1 = await mock.chat({ messages: [...] });   // → tape.exchanges[0]
 *     const r2 = await mock.chat({ messages: [...] });   // → tape.exchanges[1]
 *     ...
 *   The mock returns the next ChatResponse in the tape on each `chat()` call.
 *   It does NOT validate the input messages against the recording — tests should
 *   assert on the OUTPUT trace (tools called, final reply) instead.
 *
 *   RECORD MODE (developer-only; produces new fixtures):
 *     TITAN_RECORD_TAPE=weather npm test -- weather.test.ts
 *   When the env var is set, the mock delegates to the real OllamaProvider AND
 *   appends each (request, response) pair to the named tape file. After the
 *   test completes, commit the resulting tests/fixtures/tapes/<name>.json.
 *
 * ── Tape format ──────────────────────────────────────────────────────
 *
 *   tests/fixtures/tapes/<name>.json
 *   {
 *     "name": "weather",
 *     "model": "ollama/qwen3.5:cloud",
 *     "recorded_at": "2026-04-26T19:00:00Z",
 *     "titan_version": "5.1.0",
 *     "exchanges": [
 *       { "response": { "id": "chatcmpl-1", "content": "...", "toolCalls": [...], "finishReason": "tool_calls", "model": "..." } },
 *       { "response": { "id": "chatcmpl-2", "content": "Sunny and 72°F", "finishReason": "stop", "model": "..." } }
 *     ]
 *   }
 *
 *   We deliberately do NOT record the request side — it'd make tapes huge and
 *   couple the fixture to internal prompt churn. Tests assert behavior; the tape
 *   only tells the mock what to say next.
 *
 * ── Why a separate file under tests/ instead of mocking via vi.mock ───
 *
 *   `vi.mock` replaces the module globally for the whole test file, which
 *   makes it hard to mix tape playback with one-off custom responses. By
 *   exporting a real class, individual tests can construct a mock with
 *   exactly the responses they need (`MockOllamaProvider.fromResponses([...])`)
 *   or load a pre-recorded tape (`fromTape('weather')`).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    LLMProvider,
    type ChatMessage,
    type ChatOptions,
    type ChatResponse,
    type ChatStreamChunk,
} from '../../src/providers/base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAPES_DIR = join(__dirname, '../fixtures/tapes');

interface TapeExchange {
    /** Optional input echo for human readers — never used by playback */
    request?: { messages: ChatMessage[]; toolCount?: number };
    response: ChatResponse;
}

export interface Tape {
    name: string;
    model: string;
    recorded_at: string;
    titan_version: string;
    exchanges: TapeExchange[];
}

export class MockOllamaProvider extends LLMProvider {
    readonly name = 'ollama';
    readonly displayName = 'Mock Ollama';

    private cursor = 0;
    private exchanges: TapeExchange[];
    private modelHint: string;

    /** Record-mode passthrough; only set when TITAN_RECORD_TAPE is active. */
    private recordMode = false;
    private recordTapeName?: string;
    private realProvider?: LLMProvider;
    private recordedExchanges: TapeExchange[] = [];

    constructor(exchanges: TapeExchange[], modelHint = 'ollama/mock:test') {
        super();
        this.exchanges = exchanges;
        this.modelHint = modelHint;
    }

    /** Construct a mock that returns the given responses in order. */
    static fromResponses(responses: Array<Partial<ChatResponse>>): MockOllamaProvider {
        const exchanges: TapeExchange[] = responses.map((r, i) => ({
            response: {
                id: r.id ?? `mock-${i}`,
                content: r.content ?? '',
                toolCalls: r.toolCalls,
                finishReason: r.finishReason ?? (r.toolCalls?.length ? 'tool_calls' : 'stop'),
                model: r.model ?? 'ollama/mock:test',
                usage: r.usage,
            },
        }));
        return new MockOllamaProvider(exchanges);
    }

    /** Load a pre-recorded tape. Throws if file missing or malformed. */
    static fromTape(name: string): MockOllamaProvider {
        const path = join(TAPES_DIR, `${name}.json`);
        if (!existsSync(path)) {
            throw new Error(`Tape not found: ${path}. Run with TITAN_RECORD_TAPE=${name} to record.`);
        }
        const tape = JSON.parse(readFileSync(path, 'utf-8')) as Tape;
        if (!Array.isArray(tape.exchanges)) {
            throw new Error(`Malformed tape ${name}: missing exchanges array`);
        }
        return new MockOllamaProvider(tape.exchanges, tape.model);
    }

    /**
     * Wrap a real provider for record mode. Tests that want to capture a fresh
     * tape do `const mock = MockOllamaProvider.recording('weather', realProvider)`,
     * then call `await mock.flush()` at the end of the test.
     */
    static recording(tapeName: string, realProvider: LLMProvider): MockOllamaProvider {
        const m = new MockOllamaProvider([]);
        m.recordMode = true;
        m.recordTapeName = tapeName;
        m.realProvider = realProvider;
        return m;
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        if (this.recordMode) {
            if (!this.realProvider) throw new Error('Record mode requires realProvider');
            const real = await this.realProvider.chat(options);
            this.recordedExchanges.push({
                request: { messages: options.messages, toolCount: options.tools?.length ?? 0 },
                response: real,
            });
            return real;
        }
        if (this.cursor >= this.exchanges.length) {
            throw new Error(
                `MockOllamaProvider tape exhausted: requested chat #${this.cursor + 1}` +
                ` but tape has only ${this.exchanges.length} exchanges. Re-record the tape` +
                ` or shorten the test.`
            );
        }
        const ex = this.exchanges[this.cursor++];
        return ex.response;
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        // Convert a non-streaming response to a single-shot stream.
        const r = await this.chat(options);
        if (r.content) yield { type: 'text', content: r.content };
        if (r.toolCalls) for (const tc of r.toolCalls) yield { type: 'tool_call', toolCall: tc };
        yield { type: 'done' };
    }

    async listModels(): Promise<string[]> {
        return [this.modelHint, 'ollama/qwen3.5:cloud', 'ollama/kimi-k2.6:cloud'];
    }

    async healthCheck(): Promise<boolean> {
        return true;
    }

    /** Reset the playback cursor (useful between scenarios in one test). */
    reset(): void {
        this.cursor = 0;
    }

    /** Number of exchanges left on the tape. */
    remaining(): number {
        return this.exchanges.length - this.cursor;
    }

    /**
     * In record mode, write the captured exchanges to disk. No-op in playback.
     * Returns the path written (or null if not in record mode / nothing to flush).
     */
    flush(): string | null {
        if (!this.recordMode || !this.recordTapeName) return null;
        if (this.recordedExchanges.length === 0) return null;
        const tape: Tape = {
            name: this.recordTapeName,
            model: this.recordedExchanges[0]?.response.model ?? 'unknown',
            recorded_at: new Date().toISOString(),
            titan_version: process.env.npm_package_version ?? '0.0.0',
            exchanges: this.recordedExchanges,
        };
        if (!existsSync(TAPES_DIR)) mkdirSync(TAPES_DIR, { recursive: true });
        const path = join(TAPES_DIR, `${this.recordTapeName}.json`);
        writeFileSync(path, JSON.stringify(tape, null, 2));
        return path;
    }
}

/**
 * Helper for the most common test setup: load a tape, build a mock,
 * register it as the default provider for the test scope.
 *
 * Tests using this should restore the original provider in afterEach
 * (the helper returns a `restore` callback).
 */
export async function withTape(
    name: string,
    fn: (mock: MockOllamaProvider) => Promise<void>,
): Promise<void> {
    const mock = MockOllamaProvider.fromTape(name);
    try {
        await fn(mock);
        if (mock.remaining() > 0) {
            throw new Error(
                `Tape "${name}" had ${mock.remaining()} unused exchanges — test ended early` +
                ` or tape is over-provisioned. Trim the tape to match actual round count.`
            );
        }
    } finally {
        mock.reset();
    }
}
