/**
 * TITAN — Feedback Tracker Skill Tests
 * Tests for feedback_submit, feedback_list, feedback_update tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const { mockRegisterSkill, mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockUuidV4 } = vi.hoisted(() => ({
    mockRegisterSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockUuidV4: vi.fn(() => 'test-uuid-12345678'),
}));

// ── Module mocks ─────────────────────────────────────────────────────────

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: mockRegisterSkill,
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('uuid', () => ({
    v4: mockUuidV4,
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
}));

// ── Import under test ────────────────────────────────────────────────────

import { registerFeedbackTrackerSkill } from '../src/skills/builtin/feedback_tracker.js';

// ── Helpers ──────────────────────────────────────────────────────────────

type ToolDef = { name: string; execute: (args: Record<string, unknown>) => Promise<string> };

function getToolHandler(toolName: string): ToolDef['execute'] {
    const call = vi.mocked(mockRegisterSkill).mock.calls.find(
        (c) => c[1]?.name === toolName,
    );
    if (!call) throw new Error(`Tool "${toolName}" not registered`);
    return call[1].execute;
}

function makeFeedback(overrides: Record<string, unknown> = {}) {
    return {
        id: 'fb-00001',
        timestamp: '2026-03-13T00:00:00Z',
        observation: 'The login page loads slowly',
        impact: 'Users abandon signup',
        recommendation: 'Optimize the login page bundle',
        category: 'ux',
        severity: 'medium',
        status: 'submitted',
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Feedback Tracker Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRegisterSkill.mockClear();
        registerFeedbackTrackerSkill();
    });

    describe('registration', () => {
        it('registers 3 tools', () => {
            expect(mockRegisterSkill).toHaveBeenCalledTimes(3);
        });

        it('registers all expected tool names', () => {
            const names = mockRegisterSkill.mock.calls.map((c: any) => c[1]?.name);
            expect(names).toContain('feedback_submit');
            expect(names).toContain('feedback_list');
            expect(names).toContain('feedback_update');
        });

        it('uses feedback_tracker skill meta', () => {
            const meta = mockRegisterSkill.mock.calls[0][0];
            expect(meta.name).toBe('feedback_tracker');
            expect(meta.version).toBe('1.0.0');
        });
    });

    describe('feedback_submit', () => {
        it('submits new feedback', async () => {
            mockExistsSync.mockReturnValue(false);
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_submit');
            const result = await execute({
                observation: 'Button is misaligned',
                impact: 'Looks unprofessional',
                recommendation: 'Fix CSS margin',
                category: 'ux',
                severity: 'low',
            });

            expect(result).toContain('Feedback submitted');
            expect(result).toContain('test-uui'); // uuid().slice(0,8)
            expect(result).toContain('ux');
            expect(result).toContain('low');
            expect(mockWriteFileSync).toHaveBeenCalled();
            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written).toHaveLength(1);
            expect(written[0].observation).toBe('Button is misaligned');
            expect(written[0].status).toBe('submitted');
        });

        it('includes optional evidence field', async () => {
            mockExistsSync.mockReturnValue(false);
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_submit');
            await execute({
                observation: 'Crash on submit',
                impact: 'Data loss',
                recommendation: 'Add error handling',
                category: 'bug',
                severity: 'critical',
                evidence: 'https://logs.example.com/crash-123',
            });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written[0].evidence).toBe('https://logs.example.com/crash-123');
        });

        it('detects duplicate with >50% word overlap', async () => {
            const existing = [makeFeedback({ observation: 'The login page loads very slowly on mobile devices' })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(existing));

            const execute = getToolHandler('feedback_submit');
            const result = await execute({
                observation: 'The login page loads slowly on mobile devices',
                impact: 'Bad UX',
                recommendation: 'Optimize',
                category: 'ux',
                severity: 'medium',
            });

            expect(result).toContain('Possible duplicate detected');
            expect(result).toContain(existing[0].id);
            expect(mockWriteFileSync).not.toHaveBeenCalled();
        });

        it('does not flag as duplicate when overlap is low', async () => {
            const existing = [makeFeedback({ observation: 'The login page loads slowly' })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(existing));
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_submit');
            const result = await execute({
                observation: 'The dashboard crashes when clicking export button',
                impact: 'Cannot export data',
                recommendation: 'Fix the export handler',
                category: 'bug',
                severity: 'high',
            });

            expect(result).toContain('Feedback submitted');
            expect(result).not.toContain('duplicate');
        });

        it('appends to existing feedback list', async () => {
            const existing = [makeFeedback({ id: 'old-001', observation: 'Old issue' })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(existing));
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_submit');
            await execute({
                observation: 'New completely different issue with the API',
                impact: 'API errors',
                recommendation: 'Fix endpoints',
                category: 'sdk',
                severity: 'high',
            });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written).toHaveLength(2);
            expect(written[0].id).toBe('old-001');
        });
    });

    describe('feedback_list', () => {
        it('lists all feedback', async () => {
            const entries = [
                makeFeedback({ id: 'fb-001', category: 'bug', severity: 'high', status: 'submitted' }),
                makeFeedback({ id: 'fb-002', category: 'ux', severity: 'low', status: 'resolved' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const execute = getToolHandler('feedback_list');
            const result = await execute({});

            expect(result).toContain('fb-001');
            expect(result).toContain('fb-002');
            expect(result).toContain('2 of 2');
        });

        it('filters by status', async () => {
            const entries = [
                makeFeedback({ id: 'fb-001', status: 'submitted' }),
                makeFeedback({ id: 'fb-002', status: 'resolved' }),
                makeFeedback({ id: 'fb-003', status: 'submitted' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const execute = getToolHandler('feedback_list');
            const result = await execute({ status: 'submitted' });

            expect(result).toContain('fb-001');
            expect(result).toContain('fb-003');
            expect(result).not.toContain('fb-002');
        });

        it('filters by category', async () => {
            const entries = [
                makeFeedback({ id: 'fb-001', category: 'bug' }),
                makeFeedback({ id: 'fb-002', category: 'ux' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const execute = getToolHandler('feedback_list');
            const result = await execute({ category: 'bug' });

            expect(result).toContain('fb-001');
            expect(result).not.toContain('fb-002');
        });

        it('filters by both status and category', async () => {
            const entries = [
                makeFeedback({ id: 'fb-001', category: 'bug', status: 'submitted' }),
                makeFeedback({ id: 'fb-002', category: 'bug', status: 'resolved' }),
                makeFeedback({ id: 'fb-003', category: 'ux', status: 'submitted' }),
            ];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const execute = getToolHandler('feedback_list');
            const result = await execute({ status: 'submitted', category: 'bug' });

            expect(result).toContain('1 of 1');
            expect(result).toContain('fb-001');
        });

        it('returns no entries message', async () => {
            mockExistsSync.mockReturnValue(false);

            const execute = getToolHandler('feedback_list');
            const result = await execute({});

            expect(result).toContain('No feedback entries found');
        });

        it('respects limit parameter', async () => {
            const entries = Array.from({ length: 20 }, (_, i) =>
                makeFeedback({ id: `fb-${String(i).padStart(3, '0')}` }),
            );
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));

            const execute = getToolHandler('feedback_list');
            const result = await execute({ limit: 3 });

            expect(result).toContain('3 of 20');
        });
    });

    describe('feedback_update', () => {
        it('updates status of an entry', async () => {
            const entries = [makeFeedback({ id: 'fb-001', status: 'submitted' })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_update');
            const result = await execute({ id: 'fb-001', status: 'acknowledged' });

            expect(result).toContain('submitted');
            expect(result).toContain('acknowledged');
            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written[0].status).toBe('acknowledged');
        });

        it('adds a note to an entry', async () => {
            const entries = [makeFeedback({ id: 'fb-001', status: 'submitted' })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_update');
            const result = await execute({ id: 'fb-001', status: 'planned', note: 'Scheduled for sprint 5' });

            expect(result).toContain('Note added');
            expect(result).toContain('Scheduled for sprint 5');
            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written[0].notes).toContain('Scheduled for sprint 5');
        });

        it('appends note to existing notes', async () => {
            const entries = [makeFeedback({
                id: 'fb-001',
                status: 'acknowledged',
                notes: '[2026-03-10] First note',
            })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_update');
            await execute({ id: 'fb-001', status: 'planned', note: 'Second note' });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written[0].notes).toContain('First note');
            expect(written[0].notes).toContain('Second note');
        });

        it('returns not found for unknown id', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify([makeFeedback({ id: 'fb-001' })]));

            const execute = getToolHandler('feedback_update');
            const result = await execute({ id: 'nonexistent', status: 'resolved' });

            expect(result).toContain('not found');
            expect(mockWriteFileSync).not.toHaveBeenCalled();
        });

        it('returns not found on empty list', async () => {
            mockExistsSync.mockReturnValue(false);

            const execute = getToolHandler('feedback_update');
            const result = await execute({ id: 'fb-001', status: 'resolved' });

            expect(result).toContain('not found');
        });

        it('updates without note when note is not provided', async () => {
            const entries = [makeFeedback({ id: 'fb-001', status: 'submitted' })];
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(entries));
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('feedback_update');
            const result = await execute({ id: 'fb-001', status: 'resolved' });

            expect(result).toContain('submitted');
            expect(result).toContain('resolved');
            expect(result).not.toContain('Note added');
            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written[0].notes).toBeUndefined();
        });
    });
});
