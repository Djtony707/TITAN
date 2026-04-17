/**
 * Drive layer tests — each drive's compute() with canned snapshots.
 * Validates pressure math + clamp behavior. Uses real module logic (no
 * mocks of drives internals), mocks only the disk/registry inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/utils/constants.js', () => ({ TITAN_HOME: '/tmp/titan-test-drives' }));
vi.mock('../../src/utils/helpers.js', () => ({ ensureDir: vi.fn() }));
vi.mock('../../src/agent/goals.js', () => ({
    listGoals: vi.fn(() => []),
    getReadyTasks: vi.fn(() => []),
}));
vi.mock('../../src/agent/commandPost.js', () => ({
    getRegisteredAgents: vi.fn(() => []),
    getBudgetPolicies: vi.fn(() => []),
    listRuns: vi.fn(() => []),
}));
vi.mock('../../src/agent/trajectoryLogger.js', () => ({
    getRecentTrajectories: vi.fn(() => []),
}));
vi.mock('fs', async (orig) => ({
    ...(await orig<typeof import('fs')>()),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
}));

import { DRIVES, computeAllDrives, runDriveTick, type DriveSnapshot } from '../../src/organism/drives.js';

function makeSnapshot(overrides: Partial<DriveSnapshot> = {}): DriveSnapshot {
    return {
        now: Date.now(),
        goals: [],
        readyTasks: [],
        recentRuns: [],
        budgets: [],
        agents: [],
        trajectories: [],
        ...overrides,
    };
}

describe('drives', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('exports all 5 drives', () => {
        const ids = DRIVES.map(d => d.id).sort();
        expect(ids).toEqual(['curiosity', 'hunger', 'purpose', 'safety', 'social']);
    });

    describe('Purpose', () => {
        it('high satisfaction when no priority-1 goals exist', () => {
            const snap = makeSnapshot();
            const drives = computeAllDrives(snap);
            const purpose = drives.find(d => d.id === 'purpose')!;
            expect(purpose.satisfaction).toBeGreaterThan(0.7);
            expect(purpose.pressure).toBe(0);
        });

        it('low satisfaction when priority-1 goal stalled 24h+', () => {
            const oneDayAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
            const snap = makeSnapshot({
                goals: [{
                    id: 'g1', title: 'ship it', description: '', status: 'active',
                    priority: 1, subtasks: [], totalCost: 0, progress: 0,
                    createdAt: oneDayAgo, updatedAt: oneDayAgo,
                }],
            });
            const drives = computeAllDrives(snap);
            const purpose = drives.find(d => d.id === 'purpose')!;
            expect(purpose.satisfaction).toBeLessThan(0.1);
            expect(purpose.pressure).toBeGreaterThan(0);
        });
    });

    describe('Hunger', () => {
        it('satiated when backlog empty', () => {
            const drives = computeAllDrives(makeSnapshot());
            const hunger = drives.find(d => d.id === 'hunger')!;
            expect(hunger.satisfaction).toBeGreaterThan(0.7);
        });

        it('elevated when 12 ready tasks pile up', () => {
            const readyTasks = Array.from({ length: 12 }, (_, i) => ({
                goal: {
                    id: `g${i}`, title: `goal ${i}`, description: '', status: 'active' as const,
                    priority: 3, subtasks: [], totalCost: 0, progress: 0,
                    createdAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                subtask: {
                    id: `st${i}`, title: 'x', description: '',
                    status: 'pending' as const, retries: 0,
                },
            }));
            const drives = computeAllDrives(makeSnapshot({ readyTasks }));
            const hunger = drives.find(d => d.id === 'hunger')!;
            expect(hunger.satisfaction).toBeLessThan(0.3);
            expect(hunger.pressure).toBeGreaterThan(0);
        });
    });

    describe('Curiosity', () => {
        it('satiated with low trajectory count (not enough data)', () => {
            const drives = computeAllDrives(makeSnapshot({ trajectories: [] }));
            const curiosity = drives.find(d => d.id === 'curiosity')!;
            expect(curiosity.satisfaction).toBeGreaterThanOrEqual(0.5);
        });

        it('elevated when all trajectories are same task type', () => {
            const trajectories = Array.from({ length: 50 }, (_, i) => ({
                id: `t${i}`, timestamp: '', task: '', taskType: 'research',
                model: 'x', toolSequence: [], toolDetails: [],
                success: true, rounds: 1, durationMs: 100, sessionId: 's',
            }));
            const drives = computeAllDrives(makeSnapshot({ trajectories }));
            const curiosity = drives.find(d => d.id === 'curiosity')!;
            expect(curiosity.satisfaction).toBeLessThan(0.5);
        });
    });

    describe('Safety', () => {
        it('satiated when budgets empty and no errors', () => {
            const drives = computeAllDrives(makeSnapshot());
            const safety = drives.find(d => d.id === 'safety')!;
            expect(safety.satisfaction).toBe(1);
        });

        it('elevated when budget runway low', () => {
            const snap = makeSnapshot({
                budgets: [{
                    id: 'b1', name: 'daily', scope: { type: 'global' },
                    period: 'daily', limitUsd: 10, warningThresholdPercent: 80,
                    action: 'warn', currentSpend: 9.5, periodStart: new Date().toISOString(),
                    enabled: true,
                }],
            });
            const drives = computeAllDrives(snap);
            const safety = drives.find(d => d.id === 'safety')!;
            expect(safety.satisfaction).toBeLessThan(0.1);
            expect(safety.pressure).toBeGreaterThan(0);
        });

        it('elevated when recent error rate > 0', () => {
            const recentRuns = Array.from({ length: 10 }, (_, i) => ({
                id: `r${i}`, agentId: 'a', source: 'manual' as const,
                status: (i < 5 ? 'error' : 'succeeded') as 'error' | 'succeeded',
                startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
                toolsUsed: [],
            }));
            const drives = computeAllDrives(makeSnapshot({ recentRuns }));
            const safety = drives.find(d => d.id === 'safety')!;
            expect(safety.satisfaction).toBeLessThan(0.6);
        });
    });

    describe('Social', () => {
        it('satiated when all agents fresh', () => {
            const agents = [
                { id: 'a', name: 'x', model: 'm', status: 'active' as const,
                  lastHeartbeat: new Date().toISOString(),
                  totalTasksCompleted: 0, totalCostUsd: 0, createdAt: '', role: 'general' as const },
            ];
            const drives = computeAllDrives(makeSnapshot({ agents }));
            const social = drives.find(d => d.id === 'social')!;
            expect(social.satisfaction).toBe(1);
        });

        it('elevated when half agents stale', () => {
            const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
            const fresh = new Date().toISOString();
            const agents = [
                { id: 'a', name: 'x', model: 'm', status: 'active' as const, lastHeartbeat: stale, totalTasksCompleted: 0, totalCostUsd: 0, createdAt: '', role: 'general' as const },
                { id: 'b', name: 'y', model: 'm', status: 'active' as const, lastHeartbeat: fresh, totalTasksCompleted: 0, totalCostUsd: 0, createdAt: '', role: 'general' as const },
            ];
            const drives = computeAllDrives(makeSnapshot({ agents }));
            const social = drives.find(d => d.id === 'social')!;
            expect(social.satisfaction).toBe(0.5);
            expect(social.pressure).toBeGreaterThan(0);
        });
    });

    describe('setpoint overrides', () => {
        it('changes which drives have pressure', () => {
            const snap = makeSnapshot();
            // With setpoint 0.99, Purpose (0.9 default) becomes elevated.
            const drives = computeAllDrives(snap, { purpose: 0.99 });
            const purpose = drives.find(d => d.id === 'purpose')!;
            expect(purpose.pressure).toBeGreaterThan(0);
        });
    });

    describe('runDriveTick', () => {
        it('returns a tick result with all drives + total pressure', () => {
            const tick = runDriveTick();
            expect(tick.drives.length).toBe(5);
            expect(typeof tick.totalPressure).toBe('number');
            expect(tick.timestamp).toBeDefined();
            expect(Array.isArray(tick.dominantDrives)).toBe(true);
        });
    });
});
