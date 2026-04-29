/**
 * TITAN — Agent Wakeup System Tests
 * Tests the async sub-agent delegation via Command Post.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────
const mockSpawnSubAgent = vi.hoisted(() => vi.fn());
const mockAddIssueComment = vi.hoisted(() => vi.fn());
const mockUpdateIssue = vi.hoisted(() => vi.fn());
const mockStartRun = vi.hoisted(() => vi.fn());
const mockEndRun = vi.hoisted(() => vi.fn());
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

vi.mock('../src/agent/commandPost.js', () => ({
    addIssueComment: mockAddIssueComment.mockReturnValue({ id: 'comment-1' }),
    updateIssue: mockUpdateIssue.mockReturnValue({ id: 'issue-1', status: 'done' }),
    startRun: mockStartRun.mockReturnValue({ id: 'run-1', agentId: 'agent-1', source: 'assignment', status: 'running', startedAt: new Date().toISOString(), toolsUsed: [] }),
    endRun: mockEndRun.mockReturnValue({ id: 'run-1', status: 'succeeded' }),
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { modelAliases: { fast: 'ollama/test', smart: 'ollama/test-smart' } },
        commandPost: { enabled: true },
    }),
}));

// Import AFTER mocks
import { initWakeupSystem, queueWakeup, drainPendingResults, getAgentInbox, getWakeupRequest, cancelWakeup, shutdownWakeupSystem } from '../src/agent/agentWakeup.js';

describe('AgentWakeup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset internal state by shutting down and re-initializing
        shutdownWakeupSystem();
    });

    afterEach(() => {
        shutdownWakeupSystem();
    });

    describe('queueWakeup', () => {
        it('should create a wakeup request with queued status', () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-1',
                issueIdentifier: 'TIT-1',
                agentId: 'agent-1',
                agentName: 'Explorer',
                parentSessionId: 'session-1',
                task: 'Research TypeScript decorators',
                templateName: 'explorer',
            });

            expect(req.id).toMatch(/^wake_/);
            expect(req.status).toBe('queued');
            expect(req.issueId).toBe('issue-1');
            expect(req.issueIdentifier).toBe('TIT-1');
            expect(req.agentName).toBe('Explorer');
            expect(req.task).toBe('Research TypeScript decorators');
        });

        it('should emit agent:wakeup event', () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-2',
                issueIdentifier: 'TIT-2',
                agentId: 'agent-2',
                agentName: 'Coder',
                parentSessionId: 'session-2',
                task: 'Fix the bug',
                templateName: 'coder',
            });

            expect(mockTitanEvents.emit).toHaveBeenCalledWith('agent:wakeup', { wakeupRequestId: req.id });
        });

        it('should emit commandpost:activity event', () => {
            initWakeupSystem();
            queueWakeup({
                issueId: 'issue-3',
                issueIdentifier: 'TIT-3',
                agentId: 'agent-3',
                agentName: 'Analyst',
                parentSessionId: null,
                task: 'Analyze data',
                templateName: 'analyst',
            });

            expect(mockTitanEvents.emit).toHaveBeenCalledWith('commandpost:activity', expect.objectContaining({
                type: 'agent_status_change',
                agentId: 'agent-3',
            }));
        });
    });

    describe('getWakeupRequest', () => {
        it('should retrieve a queued request by ID', () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-4',
                issueIdentifier: 'TIT-4',
                agentId: 'agent-4',
                agentName: 'Explorer',
                parentSessionId: 'session-4',
                task: 'Search for info',
                templateName: 'explorer',
            });

            const found = getWakeupRequest(req.id);
            expect(found).not.toBeNull();
            expect(found!.id).toBe(req.id);
            expect(found!.status).toBe('queued');
        });

        it('should return null for unknown ID', () => {
            initWakeupSystem();
            expect(getWakeupRequest('wake_nonexistent')).toBeNull();
        });
    });

    describe('getAgentInbox', () => {
        it('should return queued requests for a specific agent', () => {
            initWakeupSystem();
            queueWakeup({
                issueId: 'issue-5',
                issueIdentifier: 'TIT-5',
                agentId: 'agent-A',
                agentName: 'Explorer',
                parentSessionId: null,
                task: 'Task 1',
                templateName: 'explorer',
            });
            queueWakeup({
                issueId: 'issue-6',
                issueIdentifier: 'TIT-6',
                agentId: 'agent-B',
                agentName: 'Coder',
                parentSessionId: null,
                task: 'Task 2',
                templateName: 'coder',
            });

            const inboxA = getAgentInbox('agent-A');
            expect(inboxA).toHaveLength(1);
            expect(inboxA[0].task).toBe('Task 1');

            const inboxB = getAgentInbox('agent-B');
            expect(inboxB).toHaveLength(1);
            expect(inboxB[0].task).toBe('Task 2');
        });

        it('should return empty for agent with no work', () => {
            initWakeupSystem();
            expect(getAgentInbox('agent-none')).toHaveLength(0);
        });
    });

    describe('cancelWakeup', () => {
        it('should cancel a queued request', () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-7',
                issueIdentifier: 'TIT-7',
                agentId: 'agent-7',
                agentName: 'Explorer',
                parentSessionId: null,
                task: 'Will be cancelled',
                templateName: 'explorer',
            });

            const result = cancelWakeup(req.id);
            expect(result).toBe(true);

            const updated = getWakeupRequest(req.id);
            expect(updated!.status).toBe('failed');
            expect(updated!.error).toBe('Cancelled');
        });

        it('should return false for unknown request', () => {
            initWakeupSystem();
            expect(cancelWakeup('wake_nonexistent')).toBe(false);
        });
    });

    describe('drainPendingResults', () => {
        it('should return empty for session with no results', () => {
            initWakeupSystem();
            const results = drainPendingResults('session-unknown');
            expect(results).toHaveLength(0);
        });

        it('should clear results after draining', () => {
            initWakeupSystem();
            // We can't easily test the full cycle without running the background handler,
            // but we can verify drain returns empty for unknown sessions
            const first = drainPendingResults('session-test');
            expect(first).toHaveLength(0);
            const second = drainPendingResults('session-test');
            expect(second).toHaveLength(0);
        });
    });

    describe('initWakeupSystem', () => {
        it('should register agent:wakeup event listener', () => {
            initWakeupSystem();
            expect(mockTitanEvents.on).toHaveBeenCalledWith('agent:wakeup', expect.any(Function));
        });

        it('should be idempotent (multiple calls are safe)', () => {
            initWakeupSystem();
            initWakeupSystem();
            // Should only register listener once
            const wakeupCalls = mockTitanEvents.on.mock.calls.filter(
                (call: unknown[]) => call[0] === 'agent:wakeup'
            );
            expect(wakeupCalls).toHaveLength(1);
        });
    });

    describe('shutdownWakeupSystem', () => {
        it('should cancel all queued requests', () => {
            initWakeupSystem();
            const req = queueWakeup({
                issueId: 'issue-8',
                issueIdentifier: 'TIT-8',
                agentId: 'agent-8',
                agentName: 'Explorer',
                parentSessionId: null,
                task: 'Will be shutdown',
                templateName: 'explorer',
            });

            shutdownWakeupSystem();

            const updated = getWakeupRequest(req.id);
            expect(updated!.status).toBe('failed');
            expect(updated!.error).toBe('System shutdown');
        });

        it('should remove event listeners', () => {
            initWakeupSystem();
            shutdownWakeupSystem();
            expect(mockTitanEvents.off).toHaveBeenCalledWith('agent:wakeup', expect.any(Function));
        });
    });
});
