/**
 * Pressure fusion tests — threshold logic + cycle integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockEmit = vi.hoisted(() => vi.fn());
const mockGenerateProposals = vi.hoisted(() => vi.fn());
const mockAttachShadow = vi.hoisted(() => vi.fn());
const mockGetApproval = vi.hoisted(() => vi.fn());
const mockRehearseShadow = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('../../src/substrate/traceBus.js', () => ({ emit: mockEmit }));
vi.mock('../../src/organism/shadow.js', () => ({ rehearseShadow: mockRehearseShadow }));
vi.mock('../../src/agent/goalProposer.js', () => ({ generateGoalProposals: mockGenerateProposals }));
vi.mock('../../src/agent/commandPost.js', () => ({
    requestGoalProposalApproval: vi.fn(),
    getApproval: mockGetApproval,
    attachShadowVerdictToApproval: mockAttachShadow,
}));

import { computePressureReading, evaluatePressure, runPressureCycle } from '../../src/organism/pressure.js';
import type { DriveState } from '../../src/organism/drives.js';

function makeDrive(id: string, pressure: number): DriveState {
    return {
        id: id as DriveState['id'], label: id, satisfaction: 0.5,
        setpoint: 0.7, pressure, weight: 1, description: `${id} desc`,
    };
}

describe('pressure', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadConfig.mockReturnValue({
            organism: { enabled: true, pressureThreshold: 1.2, shadowEnabled: true, shadowModel: 'fast' },
            agent: { modelAliases: { fast: 'openai/gpt-4o-mini' } },
        });
    });

    describe('computePressureReading', () => {
        it('sorts drives by pressure descending', () => {
            const reading = computePressureReading([
                makeDrive('hunger', 0.3), makeDrive('safety', 0.8), makeDrive('purpose', 0.1),
            ]);
            expect(reading.perDrive[0].id).toBe('safety');
            expect(reading.perDrive[1].id).toBe('hunger');
            expect(reading.totalPressure).toBeCloseTo(1.2, 5);
        });

        it('excludes drives with zero pressure', () => {
            const reading = computePressureReading([
                makeDrive('hunger', 0), makeDrive('safety', 0.5),
            ]);
            expect(reading.perDrive).toHaveLength(1);
            expect(reading.perDrive[0].id).toBe('safety');
        });
    });

    describe('evaluatePressure', () => {
        it('below threshold → should: false', () => {
            const d = evaluatePressure([makeDrive('hunger', 0.5)], 1.2);
            expect(d.should).toBe(false);
            expect(d.reason).toContain('below threshold');
        });

        it('at/above threshold → should: true', () => {
            const d = evaluatePressure([makeDrive('hunger', 0.8), makeDrive('safety', 0.5)], 1.2);
            expect(d.should).toBe(true);
            expect(d.dominantDrives[0]).toBe('hunger');
        });
    });

    describe('runPressureCycle', () => {
        it('skips when organism disabled', async () => {
            mockLoadConfig.mockReturnValue({ organism: { enabled: false } });
            const result = await runPressureCycle([makeDrive('hunger', 5)]);
            expect(result.fired).toBe(false);
            expect(result.skipped).toContain('enabled=false');
        });

        it('does not fire when below threshold', async () => {
            const result = await runPressureCycle([makeDrive('hunger', 0.5)]);
            expect(result.fired).toBe(false);
            expect(mockGenerateProposals).not.toHaveBeenCalled();
        });

        it('fires when threshold crossed and proposals returned', async () => {
            mockGenerateProposals.mockResolvedValue([{
                id: 'appr-1', type: 'goal_proposal', status: 'pending',
                payload: { title: 'x', description: 'd', rationale: 'r' },
                requestedBy: 'soma:hunger',
            }]);
            mockRehearseShadow.mockResolvedValue({
                reversibilityScore: 0.5, estimatedCostUsd: 0.1, breakRisks: [],
                affectedSystems: [], fallback: false,
            });
            const result = await runPressureCycle([makeDrive('hunger', 1.5)]);
            expect(result.fired).toBe(true);
            expect(result.approvalId).toBe('appr-1');
            expect(result.shadow).toBeDefined();
            expect(mockAttachShadow).toHaveBeenCalled();
            expect(mockEmit).toHaveBeenCalledWith('pressure:threshold', expect.anything());
            expect(mockEmit).toHaveBeenCalledWith('soma:proposal', expect.anything());
        });

        it('does not fire when proposer returns empty', async () => {
            mockGenerateProposals.mockResolvedValue([]);
            const result = await runPressureCycle([makeDrive('hunger', 1.5)]);
            expect(result.fired).toBe(false);
            expect(result.skipped).toContain('no actionable proposals');
        });

        it('skips shadow when shadowEnabled=false', async () => {
            mockLoadConfig.mockReturnValue({
                organism: { enabled: true, pressureThreshold: 1.2, shadowEnabled: false },
                agent: { modelAliases: {} },
            });
            mockGenerateProposals.mockResolvedValue([{
                id: 'appr-2', type: 'goal_proposal', status: 'pending',
                payload: { title: 'x', description: 'd', rationale: 'r' },
                requestedBy: 'soma:hunger',
            }]);
            const result = await runPressureCycle([makeDrive('hunger', 1.5)]);
            expect(result.fired).toBe(true);
            expect(result.shadow).toBeUndefined();
            expect(mockRehearseShadow).not.toHaveBeenCalled();
        });

        it('continues when shadow rehearsal throws', async () => {
            mockGenerateProposals.mockResolvedValue([{
                id: 'appr-3', type: 'goal_proposal', status: 'pending',
                payload: { title: 'x', description: 'd', rationale: 'r' },
                requestedBy: 'soma:hunger',
            }]);
            mockRehearseShadow.mockRejectedValue(new Error('boom'));
            const result = await runPressureCycle([makeDrive('hunger', 1.5)]);
            expect(result.fired).toBe(true);
            expect(result.shadow).toBeUndefined();
        });
    });
});
