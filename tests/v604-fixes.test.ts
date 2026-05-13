/**
 * TITAN — v6.0.4 Bug-Fix Coverage
 *
 * Three router / sub-agent bugs caught in a Titan PC log audit after the
 * v6.0.3 ship. Each one is a real autonomy hazard — TITAN doing something
 * plausibly correct that produces compounding failure. No bandaids.
 *
 *   A. recordFailure window-reset — failureCount never reset when the
 *      window expired (the old code set lastFailureTime=now BEFORE the
 *      compare so prev<windowStart was always false). Net effect:
 *      breaker counters grew monotonically, OPEN log line said
 *      "13 failures" with a threshold of 8.
 *
 *   B. 429 retry amplification — when a primary returned a long
 *      Retry-After, the router blocked the spawn waiting for that single
 *      provider even though the fallback chain was idle. Also: a primary
 *      whose breaker opened mid-spawn kept retrying instead of routing
 *      to fallback.
 *
 *   C. Hallucinated-tool budget — a weak quantized model could call
 *      successive different hallucinated tool names (`ls .`, `ls /`,
 *      `ls /tmp`) and slip past the exact-args loop detector. We now
 *      track hallucinated-tool count per spawn and abort cleanly after
 *      `HALLUCINATED_TOOL_BUDGET` (2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Fix A: circuit-breaker window reset ────────────────────────────

describe('v6.0.4 — recordFailure window reset (Fix A)', () => {
    beforeEach(async () => {
        const { __resetCircuitBreakers__ } = await import('../src/providers/router.js');
        __resetCircuitBreakers__();
    });

    it('opens the circuit after `failureThreshold` failures inside the window', async () => {
        const {
            __internal_recordFailure,
            __internal_getCircuitBreaker,
            __internal_CIRCUIT_BREAKER_CONFIG,
        } = await import('../src/providers/router.js');
        const threshold = __internal_CIRCUIT_BREAKER_CONFIG.failureThreshold;
        for (let i = 0; i < threshold; i++) {
            __internal_recordFailure('test-provider');
        }
        const cb = __internal_getCircuitBreaker('test-provider');
        expect(cb.state).toBe('open');
        // The OPEN log line / dashboard should report exactly the threshold,
        // not some inflated 13. (Before the fix, the counter overshot.)
        expect(cb.failureCount).toBe(threshold);
    });

    it('resets failureCount when the prior failure fell outside the monitoring window', async () => {
        const {
            __internal_recordFailure,
            __internal_getCircuitBreaker,
            __internal_CIRCUIT_BREAKER_CONFIG,
        } = await import('../src/providers/router.js');
        // 5 quick failures within the window
        for (let i = 0; i < 5; i++) __internal_recordFailure('p1');
        const cb = __internal_getCircuitBreaker('p1');
        expect(cb.failureCount).toBe(5);
        // Simulate the prior failure being older than the window
        cb.lastFailureTime = Date.now() - (__internal_CIRCUIT_BREAKER_CONFIG.monitoringWindow + 10_000);
        __internal_recordFailure('p1');
        // The fresh failure should re-seed the counter at 1, not jump to 6.
        const after = __internal_getCircuitBreaker('p1');
        expect(after.failureCount).toBe(1);
        expect(after.state).toBe('closed');
    });

    it('does NOT reset when failures stay inside the window', async () => {
        const { __internal_recordFailure, __internal_getCircuitBreaker } =
            await import('../src/providers/router.js');
        for (let i = 0; i < 3; i++) __internal_recordFailure('p2');
        const cb = __internal_getCircuitBreaker('p2');
        expect(cb.failureCount).toBe(3);
        // Two more failures, all within the same monitoring window.
        __internal_recordFailure('p2');
        __internal_recordFailure('p2');
        expect(__internal_getCircuitBreaker('p2').failureCount).toBe(5);
    });
});

// ── Fix B: 429 amplification escape hatches ─────────────────────────

describe('v6.0.4 — 429 retry amplification (Fix B)', () => {
    beforeEach(async () => {
        const { __resetCircuitBreakers__ } = await import('../src/providers/router.js');
        __resetCircuitBreakers__();
    });

    it('records primary-side rate-limit cooldown so subsequent fallback probes skip the provider', async () => {
        const {
            __internal_recordRateLimitCooldown,
            __internal_isInRateLimitCooldown,
        } = await import('../src/providers/router.js');
        expect(__internal_isInRateLimitCooldown('flaky')).toBe(false);
        __internal_recordRateLimitCooldown('flaky');
        expect(__internal_isInRateLimitCooldown('flaky')).toBe(true);
    });

    it('threshold constant is set to a sane value (>=10s, <=60s)', async () => {
        const { __internal_RETRY_AFTER_FALLBACK_THRESHOLD_MS } =
            await import('../src/providers/router.js');
        // Below 10s: too aggressive, would trigger fallback on normal-jitter
        // 429s. Above 60s: too lenient — defeats the purpose.
        expect(__internal_RETRY_AFTER_FALLBACK_THRESHOLD_MS).toBeGreaterThanOrEqual(10_000);
        expect(__internal_RETRY_AFTER_FALLBACK_THRESHOLD_MS).toBeLessThanOrEqual(60_000);
    });

    it('breaker state transitions to OPEN at threshold so the retry loop can detect it', async () => {
        // The retry loop's "abort if breaker opened mid-spawn" guard relies
        // on getCircuitBreaker(name).state === 'open' becoming true the
        // moment threshold is crossed. Confirm that contract holds.
        const {
            __internal_recordFailure,
            __internal_getCircuitBreaker,
            __internal_CIRCUIT_BREAKER_CONFIG,
        } = await import('../src/providers/router.js');
        const threshold = __internal_CIRCUIT_BREAKER_CONFIG.failureThreshold;
        for (let i = 0; i < threshold - 1; i++) {
            __internal_recordFailure('breaker-test');
            expect(__internal_getCircuitBreaker('breaker-test').state).toBe('closed');
        }
        __internal_recordFailure('breaker-test');
        expect(__internal_getCircuitBreaker('breaker-test').state).toBe('open');
    });
});

// ── Fix C: hallucinated-tool fail-fast in subAgent ──────────────────

describe('v6.0.4 — hallucinated-tool budget (Fix C)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    async function setupSubAgentMocks(toolCallNames: string[][]) {
        // toolCallNames is one array per round; on each round chat() returns
        // the listed tool calls. Empty array = no tool calls (terminal).
        const chatStub = vi.fn();
        for (const callNames of toolCallNames) {
            if (callNames.length === 0) {
                chatStub.mockResolvedValueOnce({ content: 'Done.', toolCalls: [] });
            } else {
                chatStub.mockResolvedValueOnce({
                    content: '',
                    toolCalls: callNames.map((n, i) => ({
                        id: `tc-${n}-${i}`,
                        function: { name: n, arguments: '{}' },
                    })),
                });
            }
        }
        // Default for any unexpected extra rounds: terminal.
        chatStub.mockResolvedValue({ content: 'Done (default).', toolCalls: [] });

        vi.doMock('../src/providers/router.js', () => ({ chat: chatStub }));
        vi.doMock('../src/agent/toolRunner.js', () => ({
            registerTool: vi.fn(),
            getToolDefinitions: vi.fn().mockReturnValue([
                { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
                { type: 'function', function: { name: 'shell', description: '', parameters: {} } },
            ]),
            executeTools: vi.fn(async (calls: Array<{ id: string; function: { name: string } }>) => {
                // Mirror executeTool()'s real "not a valid tool" prefix so
                // subAgent's hallucinated-tool detector matches.
                return calls.map(c => ({
                    toolCallId: c.id,
                    name: c.function.name,
                    content: c.function.name === 'read_file' || c.function.name === 'shell'
                        ? 'tool ran ok'
                        : `Error: "${c.function.name}" is not a valid tool.\nAvailable tools include: read_file, shell.`,
                    success: c.function.name === 'read_file' || c.function.name === 'shell',
                    durationMs: 1,
                }));
            }),
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: () => ({
                agent: { model: 'ollama/test', maxTokens: 4096, temperature: 0.2 },
                providers: {},
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
        }));
        // Defang heavy side-channel imports that subAgent pulls in.
        vi.doMock('../src/agent/messageBus.js', () => ({
            registerMailbox: vi.fn(),
            unregisterMailbox: vi.fn(),
            drainMessages: () => [],
            formatMessagesForContext: () => '',
        }));
        vi.doMock('../src/agent/toolCategories.js', () => ({
            resolveToolsFromCategories: (defs: unknown[]) => defs,
        }));
        vi.doMock('../src/agent/agentPool.js', () => ({
            acquireAgent: vi.fn(async () => null),
            releaseAgent: vi.fn(),
            createPooledAgent: vi.fn(),
        }));
        vi.doMock('../src/personas/manager.js', () => ({
            getActivePersonaContent: vi.fn(async () => ''),
        }));
        vi.doMock('../src/agent/systemPromptParts.js', () => ({
            assembleSystemPrompt: vi.fn(async () => 'sys'),
        }));
        vi.doMock('../src/agent/durableJournal.js', () => ({
            recordJournalEvent: vi.fn(),
        }));
        vi.doMock('../src/telemetry/activityLog.js', () => ({ logActivity: vi.fn() }));
        return chatStub;
    }

    it('aborts the spawn after HALLUCINATED_TOOL_BUDGET (2) invalid-tool calls — slips past the exact-args loop detector', async () => {
        // Real-world failure mode the existing `allToolsFailed` bail and the
        // exact-args loop detector both miss:
        //   Round 1: model calls one real tool (`read_file`) + one
        //            hallucinated (`ls`) → allToolsFailed = false (read_file
        //            succeeded), and there's no prior call to match against.
        //            hallucinatedToolCalls = 1.
        //   Round 2: model calls another real tool (`shell`) + a DIFFERENT
        //            hallucinated name (`cat`) → allToolsFailed = false,
        //            loop detector misses (args differ). But
        //            hallucinatedToolCalls hits 2 → abort.
        const chatStub = await setupSubAgentMocks([
            ['read_file', 'ls'],
            ['shell', 'cat'],
            ['find'], // safety: would fail too if Fix C didn't fire
        ]);
        const { spawnSubAgent } = await import('../src/agent/subAgent.js');
        const result = await spawnSubAgent({
            name: 'tester',
            task: 'do a thing',
            maxRounds: 10,
        });
        expect(result.content).toMatch(/cannot use the available tool set/i);
        expect(result.content).toMatch(/hallucinated tool name/i);
        // Confirm chat() was NOT called a third time — we aborted at round 2.
        expect(chatStub).toHaveBeenCalledTimes(2);
    });

    it('does NOT abort when a real tool runs successfully alongside one bad call', async () => {
        // Round 1: model calls one valid tool (`read_file`) + one hallucinated (`ls`).
        // hallucinatedToolCalls = 1, below budget of 2 → loop continues.
        // Round 2: model returns no tool calls → spawn completes normally.
        const chatStub = await setupSubAgentMocks([
            ['read_file', 'ls'],
            [],
        ]);
        const { spawnSubAgent } = await import('../src/agent/subAgent.js');
        const result = await spawnSubAgent({
            name: 'tester',
            task: 'do a mixed thing',
            maxRounds: 5,
        });
        expect(result.content).not.toMatch(/cannot use the available tool set/i);
        expect(chatStub).toHaveBeenCalledTimes(2);
    });
});
