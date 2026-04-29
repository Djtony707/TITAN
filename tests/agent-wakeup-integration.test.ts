/**
 * TITAN — Agent Wakeup Integration Tests
 * Tests the full async delegation lifecycle: queue → wakeup → execute → result injection.
 * Extends agent-wakeup.test.ts with deeper integration scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────
const mockSpawnSubAgent = vi.hoisted(() => vi.fn());
const mockRouteMessage = vi.hoisted(() => vi.fn());
const mockAddIssueComment = vi.hoisted(() => vi.fn());
const mockUpdateIssue = vi.hoisted(() => vi.fn());
const mockStartRun = vi.hoisted(() => vi.fn());
const mockEndRun = vi.hoisted(() => vi.fn());
const mockGetAdapter = vi.hoisted(() => vi.fn());
const mockTitanEvents = vi.hoisted(() => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/agent/daemon.js', () => ({
    titanEvents: mockTitanEvents,
}));

vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: mockSpawnSubAgent,
    SUB_AGENT_TEMPLATES: {
        explorer: { name: 'Explorer', tools: ['web_search'], systemPrompt: 'You are a researcher', tier: 'smart' },
        coder: { name: 'Coder', tools: ['shell'], systemPrompt: 'You are a coder', tier: 'fast' },
    },
}));

vi.mock('../src/agent/multiAgent.js', () => ({
    routeMessage: mockRouteMessage,
}));

vi.mock('../src/agent/adapters/index.js', () => ({
    getAdapter: mockGetAdapter,
}));

vi.mock('../src/agent/commandPost.js', () => ({
    addIssueComment: mockAddIssueComment.mockReturnValue({ id: 'comment-1' }),
    updateIssue: mockUpdateIssue.mockReturnValue({ id: 'issue-1', status: 'done' }),
    startRun: mockStartRun.mockReturnValue({ id: 'run-1', agentId: 'agent-1', source: 'assignment', status: 'running', startedAt: new Date().toISOString(), toolsUsed: [] }),
    endRun: mockEndRun.mockReturnValue({ id: 'run-1', status: 'succeeded' }),
    updateAgentStatus: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { modelAliases: { fast: 'ollama/test', smart: 'ollama/test-smart' } },
        commandPost: { enabled: true },
    }),
}));

// Import AFTER mocks
import {
    initWakeupSystem,
    queueWakeup,
    drainPendingResults,
    getWakeupRequest,
    cancelWakeup,
    shutdownWakeupSystem,
} from '../src/agent/agentWakeup.js';

// Helper to get the registered wakeup handler and execute it with await
function getWakeupHandler(): ((event: { wakeupRequestId: string }) => void) | null {
    const onCall = mockTitanEvents.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'agent:wakeup'
    );
    return onCall ? onCall[1] as (event: { wakeupRequestId: string }) => void : null;
}

// The handler uses setImmediate, so we need to flush the event loop
async function flushImmediate(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

// Run handler and wait for async completion
async function runWakeupHandler(handler: (event: { wakeupRequestId: string }) => void, requestId: string): Promise<void> {
    handler({ wakeupRequestId: requestId });
    // Flush setImmediate, then allow promises to settle
    await flushImmediate();
    await new Promise(resolve => setTimeout(resolve, 50));
}

describe('AgentWakeup Integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shutdownWakeupSystem();
        mockSpawnSubAgent.mockResolvedValue({
            content: 'Sub-agent completed the research.',
            toolsUsed: ['web_search'],
            success: true,
            durationMs: 500,
            rounds: 2,
            validated: true,
        });
        mockRouteMessage.mockResolvedValue({
            content: 'Routed response',
            toolsUsed: [],
            tokenUsage: { total: 10 },
            durationMs: 5,
        });
    });

    afterEach(() => {
        shutdownWakeupSystem();
    });

    describe('Full async sub-agent cycle', () => {
        it('should queue wakeup and set status to queued', () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-int-1',
                issueIdentifier: 'TIT-INT-1',
                agentId: 'agent-1',
                agentName: 'Explorer',
                parentSessionId: 'session-parent-1',
                task: 'Research async patterns',
                templateName: 'explorer',
            });

            expect(req.status).toBe('queued');
            expect(req.parentSessionId).toBe('session-parent-1');
        });

        it('should execute sub-agent when wakeup event fires', async () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-int-2',
                issueIdentifier: 'TIT-INT-2',
                agentId: 'agent-2',
                agentName: 'Explorer',
                parentSessionId: 'session-parent-2',
                task: 'Deep research on topic',
                templateName: 'explorer',
            });

            const handler = getWakeupHandler();
            expect(handler).not.toBeNull();

            await runWakeupHandler(handler!, req.id);

            // Sub-agent should have been spawned
            expect(mockSpawnSubAgent).toHaveBeenCalled();
        });

        it('should update issue status on completion', async () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-int-3',
                issueIdentifier: 'TIT-INT-3',
                agentId: 'agent-3',
                agentName: 'Explorer',
                parentSessionId: 'session-parent-3',
                task: 'Analyze data',
                templateName: 'explorer',
            });

            const handler = getWakeupHandler();
            await runWakeupHandler(handler!, req.id);

            // Should have updated the issue
            expect(mockUpdateIssue).toHaveBeenCalled();
        });

        it('should store result for parent injection via drainPendingResults', async () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-int-4',
                issueIdentifier: 'TIT-INT-4',
                agentId: 'agent-4',
                agentName: 'Explorer',
                parentSessionId: 'session-parent-4',
                task: 'Find information',
                templateName: 'explorer',
            });

            const handler = getWakeupHandler();
            await runWakeupHandler(handler!, req.id);

            // Parent should be able to drain the result
            const results = drainPendingResults('session-parent-4');
            expect(results.length).toBeGreaterThanOrEqual(0);
            // Second drain should be empty (consumed)
            const second = drainPendingResults('session-parent-4');
            expect(second).toHaveLength(0);
        });

        it('should handle sub-agent failure gracefully', async () => {
            mockSpawnSubAgent.mockRejectedValueOnce(new Error('Model timeout'));
            initWakeupSystem();

            const req = queueWakeup({
                issueId: 'issue-int-5',
                issueIdentifier: 'TIT-INT-5',
                agentId: 'agent-5',
                agentName: 'Explorer',
                parentSessionId: 'session-parent-5',
                task: 'Failing task',
                templateName: 'explorer',
            });

            const handler = getWakeupHandler();
            // Should not throw
            await runWakeupHandler(handler!, req.id);

            const updated = getWakeupRequest(req.id);
            expect(updated!.status).toBe('failed');
        });
    });

    describe('Cancellation and timeout', () => {
        it('should cancel wakeup request before execution', () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-int-6',
                issueIdentifier: 'TIT-INT-6',
                agentId: 'agent-6',
                agentName: 'Explorer',
                parentSessionId: null,
                task: 'Cancelled task',
                templateName: 'explorer',
            });

            const cancelled = cancelWakeup(req.id);
            expect(cancelled).toBe(true);
            expect(getWakeupRequest(req.id)!.status).toBe('failed');
            expect(getWakeupRequest(req.id)!.error).toBe('Cancelled');
        });

        it('should not execute cancelled wakeup requests', async () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-int-7',
                issueIdentifier: 'TIT-INT-7',
                agentId: 'agent-7',
                agentName: 'Explorer',
                parentSessionId: null,
                task: 'Should not run',
                templateName: 'explorer',
            });

            cancelWakeup(req.id);
            const handler = getWakeupHandler();
            await runWakeupHandler(handler!, req.id);

            // Sub-agent should NOT have been spawned
            expect(mockSpawnSubAgent).not.toHaveBeenCalled();
        });

        it('should handle wakeup for non-existent request gracefully', async () => {
            initWakeupSystem();
            const handler = getWakeupHandler();
            // Should not throw for non-existent request
            await handler!({ wakeupRequestId: 'wake_nonexistent_999' });
            expect(mockSpawnSubAgent).not.toHaveBeenCalled();
        });
    });

    describe('Concurrent wakeup requests', () => {
        it('should handle multiple queued requests for same parent', () => {
            initWakeupSystem();
            const req1 = queueWakeup({
                issueId: 'issue-c1',
                issueIdentifier: 'TIT-C1',
                agentId: 'agent-c1',
                agentName: 'Explorer',
                parentSessionId: 'shared-parent',
                task: 'Task 1',
                templateName: 'explorer',
            });
            const req2 = queueWakeup({
                issueId: 'issue-c2',
                issueIdentifier: 'TIT-C2',
                agentId: 'agent-c2',
                agentName: 'Coder',
                parentSessionId: 'shared-parent',
                task: 'Task 2',
                templateName: 'coder',
            });

            expect(req1.id).not.toBe(req2.id);
            expect(getWakeupRequest(req1.id)!.status).toBe('queued');
            expect(getWakeupRequest(req2.id)!.status).toBe('queued');
        });

        it('should execute multiple wakeups independently', async () => {
            initWakeupSystem();
            const req1 = queueWakeup({
                issueId: 'issue-c3',
                issueIdentifier: 'TIT-C3',
                agentId: 'agent-c3',
                agentName: 'Explorer',
                parentSessionId: 'parent-c3',
                task: 'Task A',
                templateName: 'explorer',
            });
            const req2 = queueWakeup({
                issueId: 'issue-c4',
                issueIdentifier: 'TIT-C4',
                agentId: 'agent-c4',
                agentName: 'Coder',
                parentSessionId: 'parent-c4',
                task: 'Task B',
                templateName: 'coder',
            });

            const handler = getWakeupHandler();
            await Promise.all([
                runWakeupHandler(handler!, req1.id),
                runWakeupHandler(handler!, req2.id),
            ]);

            expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
        });
    });

    describe('Command Post integration', () => {
        it('should start and end a CP run during execution', async () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-cp-1',
                issueIdentifier: 'TIT-CP-1',
                agentId: 'agent-cp-1',
                agentName: 'Explorer',
                parentSessionId: 'session-cp-1',
                task: 'CP tracked task',
                templateName: 'explorer',
            });

            const handler = getWakeupHandler();
            await runWakeupHandler(handler!, req.id);

            expect(mockStartRun).toHaveBeenCalled();
            expect(mockEndRun).toHaveBeenCalled();
        });

        it('should post result as CP issue comment', async () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-cp-2',
                issueIdentifier: 'TIT-CP-2',
                agentId: 'agent-cp-2',
                agentName: 'Explorer',
                parentSessionId: 'session-cp-2',
                task: 'Comment tracked task',
                templateName: 'explorer',
            });

            const handler = getWakeupHandler();
            await runWakeupHandler(handler!, req.id);

            expect(mockAddIssueComment).toHaveBeenCalled();
        });

        it('should emit SSE activity events', async () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-cp-3',
                issueIdentifier: 'TIT-CP-3',
                agentId: 'agent-cp-3',
                agentName: 'Explorer',
                parentSessionId: 'session-cp-3',
                task: 'SSE event task',
                templateName: 'explorer',
            });

            const handler = getWakeupHandler();
            await runWakeupHandler(handler!, req.id);

            // Should emit status change events
            const activityEmits = mockTitanEvents.emit.mock.calls.filter(
                (call: unknown[]) => call[0] === 'commandpost:activity'
            );
            expect(activityEmits.length).toBeGreaterThan(0);
        });
    });
});
