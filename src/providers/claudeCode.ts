/**
 * TITAN — Claude Code provider (v4.10.0-local polish)
 *
 * Full Paperclip-pattern adapter for the `claude` CLI:
 *   • yolo mode   — `--dangerously-skip-permissions`, no confirmation prompts
 *   • stream-json — `--output-format stream-json --verbose`, NDJSON events
 *   • sessions    — `--resume <id>` for multi-turn continuity
 *   • sys-prompt  — `--append-system-prompt-file` (cached by session)
 *   • add-dir     — `--add-dir` for extra read scopes (skills, staging)
 *   • quota aware — 60% throttle, rate-limit backoff per MAX plan cycle
 *   • env scrub   — drops CLAUDE_CODE_{ENTRYPOINT,SESSION,PARENT_SESSION}
 *   • pgid kill   — SIGTERM → 20s grace → SIGKILL of entire pgroup
 *
 * Tony's MAX plan OAuth is used (not metered API) — verified 2026-04-19.
 * Rate-limit watchdog protects interactive quota from automation burn.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import logger from '../utils/logger.js';
import { LLMProvider } from './base.js';
import type { ChatOptions, ChatResponse, ChatStreamChunk } from './base.js';
import {
    checkBudget, recordSpend, recordRateLimitHit,
    parseRateLimitResetTime, looksLikeRateLimit,
} from './claudeCodeBudget.js';

const COMPONENT = 'ClaudeCode';

// ── Error class for quota-aware failover ─────────────────────────

export class ClaudeCodeQuotaError extends Error {
    readonly retryAfter?: string;
    readonly percentUsed: number;
    constructor(message: string, opts: { retryAfter?: string; percentUsed: number }) {
        super(message);
        this.name = 'ClaudeCodeQuotaError';
        this.retryAfter = opts.retryAfter;
        this.percentUsed = opts.percentUsed;
    }
}

// ── Binary path resolver (unchanged from prior version) ──────────

let resolvedBinaryCache: string | null | undefined;
function resolveClaudeBinary(): string | null {
    if (resolvedBinaryCache !== undefined) return resolvedBinaryCache;
    const explicitPaths = [
        process.env.CLAUDE_CLI_PATH,
        join(homedir(), '.npm-global/bin/claude'),
        join(homedir(), '.nvm/versions/node/current/bin/claude'),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        '/opt/homebrew/bin/claude',
    ].filter((c): c is string => Boolean(c));
    for (const c of explicitPaths) {
        if (existsSync(c)) { resolvedBinaryCache = c; return c; }
    }
    resolvedBinaryCache = 'claude';
    return 'claude';
}

// ── Model aliases ────────────────────────────────────────────────

const MODEL_ALIAS: Record<string, string> = {
    'sonnet-4.5': 'claude-sonnet-4-5-20250929',
    'sonnet-4': 'claude-sonnet-4-20250514',
    'opus-4.6': 'claude-opus-4-6-20250514',
    'opus-4.5': 'claude-opus-4-5-20250514',
    'opus-4': 'claude-opus-4-20250514',
    'haiku-4.5': 'claude-haiku-4-5-20250514',
    'haiku-4': 'claude-haiku-4-20250414',
    'default': '',
};

function resolveModel(short: string): string {
    return MODEL_ALIAS[short] ?? short;
}

// ── NDJSON event shapes (loose — only read the fields we need) ──

interface InitEvent {
    type: 'system';
    subtype: 'init';
    session_id: string;
    model?: string;
    tools?: string[];
}

interface AssistantEvent {
    type: 'assistant';
    session_id?: string;
    message?: {
        content?: Array<{
            type: 'text' | 'tool_use';
            text?: string;
            name?: string;
            input?: unknown;
        }>;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };
}

interface UserEvent {
    type: 'user';
    session_id?: string;
    message?: { content?: Array<{ type: string; [k: string]: unknown }> };
}

interface ResultEvent {
    type: 'result';
    subtype?: 'success' | 'error_max_turns' | 'error' | string;
    is_error?: boolean;
    session_id?: string;
    model?: string;
    result?: string;
    error?: string;
    total_cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}

type StreamEvent = InitEvent | AssistantEvent | UserEvent | ResultEvent | { type: string; [k: string]: unknown };

// ── Extended options for claude-code specific features ───────────

export interface ClaudeCodeExtras {
    /** Resume a prior session id (returned in ChatResponse.id). */
    resumeSessionId?: string;
    /** Extra directories the CLI may read from (symlinked skills, staging bundles). */
    addDirs?: string[];
    /** Cap on CLI turn count. Default: unlimited (-1 → flag omitted). */
    maxTurns?: number;
    /** Allowed tools. Can be string[], comma-joined string, or '*' for all. */
    allowedTools?: string[] | string;
    /** Alias for allowedTools (non-clashing with other providers). */
    claudeCodeTools?: string[] | string;
    /** Working directory for the spawned CLI. */
    cwd?: string;
    /** Override timeout in ms. */
    timeoutMs?: number;
    /**
     * When true, stream `chatStream` yields per-assistant-message chunks
     * as they arrive (for live UI). When false/absent, chatStream still
     * works but buffers until completion. Default: true.
     */
    liveStream?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

function writeSystemPromptFile(systemPrompt: string): string {
    const dir = join(tmpdir(), 'titan-claude-sys');
    try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    const path = join(dir, `sp-${randomBytes(8).toString('hex')}.md`);
    writeFileSync(path, systemPrompt, 'utf-8');
    return path;
}

function safeUnlink(path: string): void {
    try { unlinkSync(path); } catch { /* ok */ }
}

/**
 * Composite view of an NDJSON run, built by aggregateEvents().
 */
interface AggregatedRun {
    sessionId?: string;
    model?: string;
    assistantText: string;
    toolCalls: Array<{ name: string; input: unknown }>;
    result?: ResultEvent;
    isError: boolean;
    errorText?: string;
}

function aggregateEvents(events: StreamEvent[]): AggregatedRun {
    const agg: AggregatedRun = {
        assistantText: '',
        toolCalls: [],
        isError: false,
    };
    for (const ev of events) {
        if (ev.type === 'system' && (ev as InitEvent).subtype === 'init') {
            const init = ev as InitEvent;
            agg.sessionId = init.session_id;
            agg.model = init.model;
        } else if (ev.type === 'assistant') {
            const a = ev as AssistantEvent;
            for (const block of a.message?.content ?? []) {
                if (block.type === 'text' && block.text) agg.assistantText += block.text;
                else if (block.type === 'tool_use' && block.name) {
                    agg.toolCalls.push({ name: block.name, input: block.input });
                }
            }
        } else if (ev.type === 'result') {
            const r = ev as ResultEvent;
            agg.result = r;
            if (r.session_id && !agg.sessionId) agg.sessionId = r.session_id;
            if (r.model) agg.model = r.model;
            if (r.is_error) {
                agg.isError = true;
                agg.errorText = r.error || r.result;
            }
            // If result.result is set and assistant content is empty, use it
            if (!agg.assistantText && r.result && !r.is_error) agg.assistantText = r.result;
        }
    }
    return agg;
}

// ── Main provider ────────────────────────────────────────────────

export class ClaudeCodeProvider extends LLMProvider {
    readonly name = 'claude-code';
    readonly displayName = 'Claude Code (MAX plan via CLI)';

    /**
     * Quota watchdog — call BEFORE spawning. Throws ClaudeCodeQuotaError
     * if we're throttled or blocked so the router's failover chain can
     * skip to the next model.
     */
    private checkQuotaOrThrow(): void {
        const check = checkBudget();
        if (check.verdict === 'block') {
            throw new ClaudeCodeQuotaError(
                check.reason || `Claude Code blocked at ${check.percentUsed.toFixed(0)}% of window budget`,
                { retryAfter: check.retryAfter, percentUsed: check.percentUsed },
            );
        }
        if (check.verdict === 'throttle') {
            throw new ClaudeCodeQuotaError(
                check.reason || `Claude Code throttled at ${check.percentUsed.toFixed(0)}% — falling back to preserve interactive quota`,
                { retryAfter: check.retryAfter, percentUsed: check.percentUsed },
            );
        }
    }

    /**
     * The low-level streaming runner. Spawns the CLI with
     * `--output-format stream-json --verbose` and yields parsed NDJSON
     * events as they arrive. Used by both chat() (aggregates) and
     * chatStream() (live per-turn).
     */
    private async *spawnStream(options: ChatOptions & ClaudeCodeExtras): AsyncGenerator<StreamEvent> {
        // Hard gate: autonomous paths must NOT call Claude Code. Only
        // user-initiated UI/API chat requests (which set allowClaudeCode)
        // are accepted. This protects the interactive Claude Code quota
        // from runaway autonomous burn — autopilot, goal driver, specialists,
        // graph extraction, self-mod review, and every other internal path
        // leaves the flag unset and gets rejected here.
        if (!options.allowClaudeCode) {
            throw new Error(
                'Claude Code blocked for autonomous use. Set ChatOptions.allowClaudeCode=true ' +
                'only from user-initiated chat endpoints after explicit model selection.',
            );
        }
        this.checkQuotaOrThrow();

        const modelShort = options.model ?? 'sonnet-4.5';
        const model = resolveModel(modelShort);

        // Compose prompt + system prompt.
        const systemParts: string[] = [];
        const convoParts: string[] = [];
        for (const m of options.messages || []) {
            if (m.role === 'system') systemParts.push(String(m.content));
            else convoParts.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`);
        }
        const prompt = convoParts.join('\n\n');
        const systemPrompt = systemParts.join('\n\n');

        // Write system prompt to a tmpfile so we can pass --append-system-prompt-file.
        // Skipped when resuming (session already has the system prompt cached).
        let systemPromptFile: string | undefined;
        if (systemPrompt && !options.resumeSessionId) {
            systemPromptFile = writeSystemPromptFile(systemPrompt);
        }

        // Build argv — stream-json + verbose per Paperclip.
        const args = [
            '--print', '-',                       // read prompt from stdin
            '--output-format', 'stream-json',     // NDJSON events
            '--verbose',                          // required with stream-json
            '--dangerously-skip-permissions',     // yolo
        ];
        if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
        if (model) args.push('--model', model);
        if (options.maxTurns && options.maxTurns > 0) args.push('--max-turns', String(options.maxTurns));
        if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
        for (const dir of options.addDirs ?? []) {
            if (existsSync(dir)) args.push('--add-dir', dir);
        }

        // Tool allowlist
        const toolsArg = options.claudeCodeTools ?? options.allowedTools;
        let allowedTools: string | '' = '';
        if (toolsArg === '*' || toolsArg === '[all]') {
            allowedTools = '';
        } else if (Array.isArray(toolsArg) && toolsArg.length > 0) {
            allowedTools = toolsArg.join(',');
        } else if (typeof toolsArg === 'string' && toolsArg.length > 0) {
            allowedTools = toolsArg;
        } else {
            allowedTools = 'Read,Glob,Grep,WebFetch,WebSearch';
        }
        if (allowedTools) args.push('--allowedTools', allowedTools);

        const cwd = options.cwd ?? process.cwd();
        // v4.10.0-local (cost cap): capped default from 5 min to 2 min.
        // Most claude-code spawns finish in 10-40s; a 5-min hang usually
        // means the CLI got stuck in a tool loop — and every second
        // counts against MAX plan quota. Callers can override via
        // options.timeoutMs when they really need longer runs.
        const timeoutMs = options.timeoutMs ?? 120_000;

        const binary = resolveClaudeBinary();
        if (!binary) {
            if (systemPromptFile) safeUnlink(systemPromptFile);
            throw new Error(`claude CLI not found. Install: npm install -g @anthropic-ai/claude-code`);
        }

        // Env scrub (Paperclip pattern)
        const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
        delete childEnv.CLAUDE_CODE_ENTRYPOINT;
        delete childEnv.CLAUDE_CODE_SESSION;
        delete childEnv.CLAUDE_CODE_PARENT_SESSION;

        logger.info(
            COMPONENT,
            `Spawning claude CLI: model=${modelShort} resume=${options.resumeSessionId ?? '(none)'} ` +
            `allowedTools=${allowedTools || '[all]'} addDirs=${(options.addDirs || []).length} ` +
            `sysPrompt=${systemPromptFile ? 'file' : 'none'} cwd=${cwd}`,
        );

        const proc = spawn(binary, args, {
            cwd,
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });

        // Pipe prompt to stdin then close
        proc.stdin?.write(prompt);
        proc.stdin?.end();

        // Timeout with pgid kill
        const graceMs = 20_000;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            try {
                if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGTERM');
                else proc.kill('SIGTERM');
            } catch { /* gone */ }
            setTimeout(() => {
                try {
                    if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGKILL');
                    else proc.kill('SIGKILL');
                } catch { /* gone */ }
            }, graceMs).unref?.();
        }, timeoutMs);
        timeout.unref?.();

        // Stream stdout line-by-line. Each line is a JSON event.
        let buffer = '';
        let stderr = '';
        proc.stderr?.on('data', chunk => { stderr += chunk.toString('utf-8'); });

        // We need to yield events AS they arrive. Buffer the raw events in
        // a queue + use a promise chain to await next event.
        const queue: StreamEvent[] = [];
        let done = false;
        let closeError: Error | undefined;
        let resolveNext: ((ok: boolean) => void) | null = null;
        function push(ev: StreamEvent) {
            queue.push(ev);
            if (resolveNext) { const r = resolveNext; resolveNext = null; r(true); }
        }
        function signalDone() {
            done = true;
            if (resolveNext) { const r = resolveNext; resolveNext = null; r(false); }
        }

        proc.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf-8');
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                try {
                    const ev = JSON.parse(line) as StreamEvent;
                    push(ev);
                } catch { /* non-JSON line — ignore */ }
            }
        });

        proc.on('error', err => {
            closeError = new Error(
                (err as NodeJS.ErrnoException).code === 'ENOENT'
                    ? `claude CLI not found on PATH. Install: npm install -g @anthropic-ai/claude-code, then: claude login`
                    : err.message,
            );
            signalDone();
        });

        proc.on('close', code => {
            clearTimeout(timeout);
            // Flush any trailing line in buffer
            if (buffer.trim()) {
                try { push(JSON.parse(buffer.trim()) as StreamEvent); } catch { /* ok */ }
                buffer = '';
            }
            if (systemPromptFile) safeUnlink(systemPromptFile);
            if (timedOut) closeError = new Error(`claude CLI timed out after ${timeoutMs}ms`);
            else if (code !== 0 && code !== null) {
                // Could be a JSON error on a single line — let the consumer see events
                // Only flag as error if we have NO useful events
                if (queue.length === 0) {
                    closeError = new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`);
                }
            }
            signalDone();
        });

        try {
            while (true) {
                if (queue.length > 0) {
                    const ev = queue.shift()!;
                    yield ev;
                    continue;
                }
                if (done) {
                    if (closeError) throw closeError;
                    return;
                }
                await new Promise<boolean>(resolve => { resolveNext = resolve; });
            }
        } finally {
            if (systemPromptFile) safeUnlink(systemPromptFile);
        }
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        const startedAt = Date.now();
        const events: StreamEvent[] = [];
        try {
            for await (const ev of this.spawnStream(options as ChatOptions & ClaudeCodeExtras)) {
                events.push(ev);
            }
        } catch (err) {
            // Rate-limit detection on low-level failures (CLI returning
            // rate-limit before any events fire).
            const msg = (err as Error).message || '';
            if (looksLikeRateLimit(msg)) {
                const resetAt = parseRateLimitResetTime(msg);
                recordRateLimitHit(resetAt, msg.slice(0, 200));
            }
            throw err;
        }
        const agg = aggregateEvents(events);
        const durationMs = Date.now() - startedAt;

        // Rate-limit detection on completion
        if (agg.isError && agg.errorText && looksLikeRateLimit(agg.errorText)) {
            const resetAt = parseRateLimitResetTime(agg.errorText);
            recordRateLimitHit(resetAt, agg.errorText.slice(0, 200));
            throw new Error(`Claude CLI rate-limited: ${agg.errorText.slice(0, 300)}`);
        }
        if (agg.isError) {
            throw new Error(`Claude CLI error: ${agg.errorText?.slice(0, 500) || '(unknown)'}`);
        }

        // Accounting
        const usage = agg.result?.usage;
        const inputTok = (usage?.input_tokens ?? 0) +
                         (usage?.cache_read_input_tokens ?? 0) +
                         (usage?.cache_creation_input_tokens ?? 0);
        const outputTok = usage?.output_tokens ?? 0;
        const costUsd = agg.result?.total_cost_usd ?? 0;
        recordSpend({
            costUsd,
            inputTokens: inputTok,
            outputTokens: outputTok,
            model: agg.model,
        });

        logger.info(
            COMPONENT,
            `claude CLI result: model=${agg.model} duration=${durationMs}ms in=${inputTok} out=${outputTok} ` +
            `cost=$${costUsd.toFixed(4)} turns=${agg.result?.num_turns ?? '?'} ` +
            `sessionId=${agg.sessionId ?? '?'}`,
        );

        return {
            id: agg.sessionId || `cc-${Date.now()}`,
            content: agg.assistantText,
            usage: {
                promptTokens: inputTok,
                completionTokens: outputTok,
                totalTokens: inputTok + outputTok,
            },
            finishReason: 'stop',
            model: agg.model || resolveModel(options.model ?? 'sonnet-4.5'),
        };
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const live = (options as ChatOptions & ClaudeCodeExtras).liveStream !== false;
        try {
            for await (const ev of this.spawnStream(options as ChatOptions & ClaudeCodeExtras)) {
                if (!live) continue; // accumulate silently
                if (ev.type === 'assistant') {
                    const a = ev as AssistantEvent;
                    for (const block of a.message?.content ?? []) {
                        if (block.type === 'text' && block.text) {
                            yield { type: 'text', content: block.text } as ChatStreamChunk;
                        } else if (block.type === 'tool_use' && block.name) {
                            yield {
                                type: 'tool_call',
                                toolCall: {
                                    id: `tc-${Date.now()}`,
                                    type: 'function',
                                    function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
                                },
                            } as unknown as ChatStreamChunk;
                        }
                    }
                } else if (ev.type === 'result') {
                    const r = ev as ResultEvent;
                    if (r.is_error) {
                        yield { type: 'error', error: r.error || r.result || 'error' } as ChatStreamChunk;
                    }
                }
            }
            yield { type: 'done' } as ChatStreamChunk;
        } catch (err) {
            yield { type: 'error', error: (err as Error).message } as ChatStreamChunk;
        }
    }

    async listModels(): Promise<string[]> {
        return Object.keys(MODEL_ALIAS).map(a => `claude-code/${a}`);
    }

    async healthCheck(): Promise<boolean> {
        const binary = resolveClaudeBinary();
        if (!binary) return false;
        return new Promise<boolean>((resolve) => {
            try {
                const proc = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
                let ok = false;
                proc.stdout?.on('data', () => { ok = true; });
                proc.on('error', () => resolve(false));
                proc.on('close', (code) => resolve(ok && code === 0));
                setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 5000).unref?.();
            } catch {
                resolve(false);
            }
        });
    }
}
