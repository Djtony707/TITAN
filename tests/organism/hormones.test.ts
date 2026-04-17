/**
 * Hormones tests — prompt formatting + broadcast change detection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockEmit = vi.hoisted(() => vi.fn());

vi.mock('fs', async (orig) => ({
    ...(await orig<typeof import('fs')>()),
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
}));
vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/utils/constants.js', () => ({ TITAN_HOME: '/tmp/titan-test-hormones' }));
vi.mock('../../src/utils/helpers.js', () => ({ ensureDir: vi.fn() }));
vi.mock('../../src/substrate/traceBus.js', () => ({ emit: mockEmit }));
vi.mock('../../src/agent/goals.js', () => ({ listGoals: vi.fn(() => []), getReadyTasks: vi.fn(() => []) }));
vi.mock('../../src/agent/commandPost.js', () => ({
    getRegisteredAgents: vi.fn(() => []),
    getBudgetPolicies: vi.fn(() => []),
    listRuns: vi.fn(() => []),
}));
vi.mock('../../src/agent/trajectoryLogger.js', () => ({ getRecentTrajectories: vi.fn(() => []) }));

import {
    buildBlock, formatForSystemPrompt, getHormonalState,
    broadcastHormonalUpdate, __resetHormonalBroadcastCache__,
} from '../../src/organism/hormones.js';
import type { DriveState } from '../../src/organism/drives.js';

function makeDrive(id: string, satisfaction: number, pressure: number): DriveState {
    return {
        id: id as DriveState['id'],
        label: id.charAt(0).toUpperCase() + id.slice(1),
        satisfaction, setpoint: 0.7, pressure, weight: 1,
        description: `${id} description`,
    };
}

describe('hormones', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        __resetHormonalBroadcastCache__();
    });

    describe('buildBlock', () => {
        it('lists all drives in levels map', () => {
            const drives = [
                makeDrive('hunger', 0.3, 0.4),
                makeDrive('safety', 0.9, 0),
            ];
            const block = buildBlock(drives, 't');
            expect(block.available).toBe(true);
            expect(block.levels).toEqual({ hunger: 0.3, safety: 0.9 });
            expect(block.dominant).toBe('hunger');
            expect(block.elevated).toHaveLength(1);
        });

        it('returns dominant=null when no drives elevated', () => {
            const drives = [makeDrive('hunger', 0.9, 0), makeDrive('safety', 0.9, 0)];
            const block = buildBlock(drives, 't');
            expect(block.dominant).toBeNull();
            expect(block.elevated).toEqual([]);
        });
    });

    describe('formatForSystemPrompt', () => {
        it('returns empty string when block unavailable', () => {
            const out = formatForSystemPrompt({ available: false, asOf: null, levels: {}, elevated: [], dominant: null });
            expect(out).toBe('');
        });

        it('produces short satiated line when all drives healthy', () => {
            const out = formatForSystemPrompt({ available: true, asOf: 't', levels: {}, elevated: [], dominant: null });
            expect(out).toContain('All drives satiated');
            expect(out.length).toBeLessThan(200);
        });

        it('names dominant + top-3 elevated drives', () => {
            const out = formatForSystemPrompt({
                available: true, asOf: 't', levels: { hunger: 0.3 }, dominant: 'hunger',
                elevated: [{ id: 'hunger', label: 'Hunger', satisfaction: 0.3, reason: 'backlog 12' }],
            });
            expect(out).toContain('Dominant: hunger');
            expect(out).toContain('Hunger at 30%');
            expect(out).toContain('backlog 12');
        });

        it('caps elevated list at 3', () => {
            const elevated = Array.from({ length: 5 }, (_, i) => ({
                id: `d${i}`, label: `D${i}`, satisfaction: 0.1, reason: `r${i}`,
            }));
            const out = formatForSystemPrompt({ available: true, asOf: 't', levels: {}, dominant: 'd0', elevated });
            expect(out).toContain('D0');
            expect(out).toContain('D2');
            expect(out).not.toContain('D3');
        });
    });

    describe('broadcastHormonalUpdate', () => {
        it('emits when levels change', () => {
            const block = buildBlock([makeDrive('hunger', 0.3, 0.4)], 't');
            broadcastHormonalUpdate(block);
            expect(mockEmit).toHaveBeenCalledWith('hormone:update', expect.objectContaining({
                dominant: 'hunger',
            }));
        });

        it('does not re-emit when state is stable', () => {
            const block = buildBlock([makeDrive('hunger', 0.3, 0.4)], 't');
            broadcastHormonalUpdate(block);
            mockEmit.mockClear();
            broadcastHormonalUpdate(block);
            expect(mockEmit).not.toHaveBeenCalled();
        });

        it('re-emits when satisfaction shifts', () => {
            broadcastHormonalUpdate(buildBlock([makeDrive('hunger', 0.3, 0.4)], 't'));
            mockEmit.mockClear();
            broadcastHormonalUpdate(buildBlock([makeDrive('hunger', 0.7, 0)], 't'));
            expect(mockEmit).toHaveBeenCalled();
        });
    });

    describe('getHormonalState', () => {
        it('returns unavailable when no disk state', () => {
            mockExistsSync.mockReturnValue(false);
            const state = getHormonalState();
            expect(state.available).toBe(false);
        });

        it('parses disk state when present', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({
                latest: {
                    timestamp: 't',
                    drives: [{ id: 'hunger', label: 'Hunger', satisfaction: 0.3, setpoint: 0.6, pressure: 0.3, weight: 1, description: 'x' }],
                    totalPressure: 0.3,
                    dominantDrives: ['hunger'],
                },
                history: [],
            }));
            const state = getHormonalState();
            expect(state.available).toBe(true);
            expect(state.dominant).toBe('hunger');
        });
    });
});
