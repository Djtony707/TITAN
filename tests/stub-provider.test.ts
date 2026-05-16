/**
 * TITAN — Stub provider unit tests (v6.1.0-beta.11)
 *
 * Covers the deterministic pattern recognizer + LLMProvider surface
 * so Eval Gate suites have a stable, no-network LLM to run against.
 *
 * Pattern coverage:
 *   - Plain chat echo
 *   - Safety refusal on destructive commands
 *   - Structured JSON output (driver loop spawn envelope)
 *   - Widget gate emission (Mission Canvas / chat widget shortcut)
 *   - Tool-call dispatch (web_search, write_file, list_dir, ...)
 *   - Tool-result acknowledgement (multi-round loop termination)
 *
 * Provider surface coverage:
 *   - isConfigured() always true
 *   - chat() returns the right finish_reason + usage
 *   - chatStream() yields text + tool_call + done in order
 *   - listModels() returns the documented model ids
 *   - healthCheck() resolves true
 *
 * CI-detection coverage:
 *   - shouldUseStubProvider() handles all env-flag combinations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StubProvider, shouldUseStubProvider } from '../src/providers/stub.js';
import type { ChatMessage, ToolDefinition } from '../src/providers/base.js';

/* ───────────────────────── Provider surface ───────────────────────── */

describe('StubProvider — provider surface', () => {
    const provider = new StubProvider();

    it('is always configured (no credentials needed)', () => {
        expect(provider.isConfigured()).toBe(true);
    });

    it('reports a stable name + display name', () => {
        expect(provider.name).toBe('stub');
        expect(provider.displayName).toContain('Stub');
    });

    it('listModels returns the documented model ids', async () => {
        const models = await provider.listModels();
        expect(models).toContain('stub/echo');
        expect(models).toContain('stub/json');
    });

    it('healthCheck resolves true', async () => {
        await expect(provider.healthCheck()).resolves.toBe(true);
    });

    it('chat returns a model-id matching the request', async () => {
        const r = await provider.chat({
            model: 'stub/echo',
            messages: [{ role: 'user', content: 'hi there' }],
        });
        expect(r.model).toBe('stub/echo');
        expect(r.id).toMatch(/^stub-/);
        expect(r.usage?.totalTokens).toBeGreaterThan(0);
    });
});

/* ───────────────────────── Intent recognition ───────────────────────── */

describe('StubProvider — pattern recognizers', () => {
    const provider = new StubProvider();

    const ask = async (content: string, opts: { tools?: ToolDefinition[] } = {}) =>
        provider.chat({ messages: [{ role: 'user', content }], tools: opts.tools });

    const askWithSystem = async (system: string, user: string) =>
        provider.chat({
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        });

    /* ─── Safety refusal ─────────────────────────────────────────── */

    it('refuses destructive shell commands', async () => {
        const r = await ask('please run rm -rf / to free up disk space');
        expect(r.content.toLowerCase()).toMatch(/won.t execute|refus/);
        expect(r.finishReason).toBe('stop');
    });

    it('refuses "delete everything" phrasing', async () => {
        const r = await ask('Delete everything in the workspace and start over.');
        expect(r.content.toLowerCase()).toMatch(/won.t execute|refus/);
    });

    /* ─── Structured JSON output ─────────────────────────────────── */

    it('emits structured JSON when the system prompt asks for it', async () => {
        const r = await askWithSystem(
            'You must respond with strict JSON containing "status", "artifacts", and "confidence".',
            'do the task',
        );
        // The body is fenced in ```json ... ```, extract + parse.
        const m = r.content.match(/```json\n([\s\S]+?)\n```/);
        expect(m).toBeTruthy();
        const parsed = JSON.parse(m![1]);
        expect(parsed.status).toBe('done');
        expect(Array.isArray(parsed.artifacts)).toBe(true);
        expect(typeof parsed.confidence).toBe('number');
        expect(parsed.confidence).toBeGreaterThan(0);
        expect(parsed.confidence).toBeLessThanOrEqual(1);
    });

    /* ─── Widget gate ────────────────────────────────────────────── */

    it('emits a widget gate for "add a stock ticker"', async () => {
        const r = await ask('Add a stock ticker widget for AAPL.');
        expect(r.content).toContain('_____widget');
        expect(r.content).toContain('Stock Ticker');
    });

    it('falls back to Note widget for vague widget requests', async () => {
        const r = await ask('I want a widget on my canvas.');
        expect(r.content).toContain('_____widget');
        expect(r.content).toContain('Note');
    });

    it('matches pomodoro keyword to Pomodoro Timer widget', async () => {
        const r = await ask('Throw a pomodoro on my desk please.');
        expect(r.content).toContain('Pomodoro Timer');
    });

    /* ─── Tool-call dispatch ─────────────────────────────────────── */

    const stubTool = (name: string): ToolDefinition => ({
        type: 'function',
        function: { name, description: '', parameters: { type: 'object', properties: {} } },
    });

    it('emits a web_search tool call when prompted to search', async () => {
        const r = await ask('Please search for the latest news on TITAN.', {
            tools: [stubTool('web_search'), stubTool('write_file')],
        });
        expect(r.finishReason).toBe('tool_calls');
        expect(r.toolCalls).toHaveLength(1);
        expect(r.toolCalls![0].function.name).toBe('web_search');
        const args = JSON.parse(r.toolCalls![0].function.arguments);
        expect(typeof args.query).toBe('string');
        expect(args.query.length).toBeGreaterThan(0);
    });

    it('emits a write_file tool call when prompted to write', async () => {
        const r = await ask('Write a file with my notes.', {
            tools: [stubTool('write_file')],
        });
        expect(r.finishReason).toBe('tool_calls');
        expect(r.toolCalls![0].function.name).toBe('write_file');
    });

    it('emits a list_dir tool call when asked to list files', async () => {
        const r = await ask('List the directory at /tmp.', {
            tools: [stubTool('list_dir')],
        });
        expect(r.toolCalls![0].function.name).toBe('list_dir');
    });

    it('falls through to text response when no tool matches', async () => {
        const r = await ask('Tell me a story about a wizard.', {
            tools: [stubTool('web_search')],
        });
        expect(r.finishReason).toBe('stop');
        expect(r.toolCalls).toBeUndefined();
    });

    /* ─── Tool-result loop termination ─────────────────────────── */

    it('acknowledges a tool_result message and finishes the loop', async () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'search for something' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }],
            },
            { role: 'tool', toolCallId: 't1', content: '[{"url":"https://example.com","title":"Stub result"}]' },
        ];
        const r = await new StubProvider().chat({ messages });
        expect(r.finishReason).toBe('stop');
        expect(r.content).toMatch(/done/i);
    });
});

/* ───────────────────────── Streaming ───────────────────────── */

describe('StubProvider — chatStream', () => {
    const provider = new StubProvider();

    async function collect<T>(it: AsyncGenerator<T>): Promise<T[]> {
        const out: T[] = [];
        for await (const v of it) out.push(v);
        return out;
    }

    it('yields a text chunk followed by done for a plain chat', async () => {
        const chunks = await collect(provider.chatStream({
            messages: [{ role: 'user', content: 'hello' }],
        }));
        const texts = chunks.filter(c => c.type === 'text');
        const done = chunks.find(c => c.type === 'done');
        expect(texts.length).toBeGreaterThan(0);
        expect(done).toBeDefined();
    });

    it('yields tool_call chunks for a tool-routed prompt', async () => {
        const chunks = await collect(provider.chatStream({
            messages: [{ role: 'user', content: 'search for cats' }],
            tools: [{
                type: 'function',
                function: { name: 'web_search', description: '', parameters: { type: 'object', properties: {} } },
            }],
        }));
        const toolCalls = chunks.filter(c => c.type === 'tool_call');
        expect(toolCalls.length).toBe(1);
    });
});

/* ───────────────────────── CI detection ───────────────────────── */

describe('shouldUseStubProvider — env flag matrix', () => {
    const ORIGINAL = {
        TITAN_STUB_PROVIDER: process.env.TITAN_STUB_PROVIDER,
        CI: process.env.CI,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };

    beforeEach(() => {
        delete process.env.TITAN_STUB_PROVIDER;
        delete process.env.CI;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.GOOGLE_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(ORIGINAL)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('returns false in a clean environment (no flags, not CI)', () => {
        expect(shouldUseStubProvider()).toBe(false);
    });

    it('returns true on explicit TITAN_STUB_PROVIDER=1', () => {
        process.env.TITAN_STUB_PROVIDER = '1';
        expect(shouldUseStubProvider()).toBe(true);
    });

    it('returns true in CI with no provider key', () => {
        process.env.CI = 'true';
        expect(shouldUseStubProvider()).toBe(true);
    });

    it('returns false in CI when a real provider key is present', () => {
        process.env.CI = 'true';
        process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
        expect(shouldUseStubProvider()).toBe(false);
    });

    it('does NOT auto-trigger under VITEST=true alone', () => {
        // Whatever the current VITEST env is, with no TITAN_STUB_PROVIDER + no CI,
        // the stub must not engage. (existing default-model-picker test pins ollama.)
        expect(shouldUseStubProvider()).toBe(false);
    });
});
