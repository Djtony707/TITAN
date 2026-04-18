/**
 * TITAN — Self-Proposals capture + storage tests (v4.8.0)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'fs';

// Hoisted so the vi.mock factory can close over it (mocks are hoisted
// above normal imports/top-level code).
const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-selfproposals-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));
vi.mock('../../src/config/config.js', () => ({
    loadConfig: loadConfigMock,
}));

vi.mock('../../src/substrate/traceBus.js', () => ({
    emit: vi.fn(),
}));

import {
    captureWrite,
    shouldCapture,
    listProposals,
    getProposal,
    getProposalFileContent,
    updateStatus,
    attachVerdict,
    isReadyForPR,
    driveFromProposer,
} from '../../src/agent/selfProposals.js';

describe('selfProposals', () => {
    beforeEach(() => {
        // Clean slate each test
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
        loadConfigMock.mockReturnValue({
            selfMod: { enabled: true },
        });
    });

    describe('shouldCapture', () => {
        it('captures write_file under autonomous + soma goal', () => {
            expect(shouldCapture({
                toolName: 'write_file',
                autonomous: true,
                goalProposedBy: 'soma:curiosity',
            })).toBe(true);
        });

        it('skips non-autonomous writes', () => {
            expect(shouldCapture({
                toolName: 'write_file',
                autonomous: false,
                goalProposedBy: 'soma:curiosity',
            })).toBe(false);
        });

        it('skips writes without a soma goal (user-driven)', () => {
            expect(shouldCapture({
                toolName: 'write_file',
                autonomous: true,
                goalProposedBy: 'tony',
            })).toBe(false);
        });

        it('skips non-mutating tools', () => {
            expect(shouldCapture({
                toolName: 'read_file',
                autonomous: true,
                goalProposedBy: 'soma:curiosity',
            })).toBe(false);
        });

        it('skips when selfMod.enabled is false', () => {
            loadConfigMock.mockReturnValue({ selfMod: { enabled: false } });
            expect(shouldCapture({
                toolName: 'write_file',
                autonomous: true,
                goalProposedBy: 'soma:curiosity',
            })).toBe(false);
        });

        it('captures edit_file / append_file / apply_patch too', () => {
            for (const tool of ['edit_file', 'append_file', 'apply_patch']) {
                expect(shouldCapture({
                    toolName: tool,
                    autonomous: true,
                    goalProposedBy: 'soma:hunger',
                })).toBe(true);
            }
        });
    });

    describe('driveFromProposer', () => {
        it('extracts drive from soma:drive', () => {
            expect(driveFromProposer('soma:curiosity')).toBe('curiosity');
            expect(driveFromProposer('soma:hunger')).toBe('hunger');
        });

        it('returns null for non-soma proposers', () => {
            expect(driveFromProposer('tony')).toBeNull();
            expect(driveFromProposer(null)).toBeNull();
            expect(driveFromProposer(undefined)).toBeNull();
        });
    });

    describe('captureWrite', () => {
        it('creates a new proposal and stores the file', () => {
            const p = captureWrite({
                toolName: 'write_file',
                filePath: '/home/dj/test-project/src/foo.ts',
                content: 'export const x = 1;\n',
                sessionId: 'sess-1',
                agentId: 'agent-1',
                goalId: 'goal-1',
                goalTitle: 'Test goal',
                goalProposedBy: 'soma:curiosity',
            });
            expect(p).not.toBeNull();
            expect(p!.files).toHaveLength(1);
            expect(p!.drive).toBe('curiosity');
            expect(p!.status).toBe('captured');
            expect(p!.files[0].sourcePath).toBe('/home/dj/test-project/src/foo.ts');

            // File content should be retrievable
            const content = getProposalFileContent(p!.id, p!.files[0].capturedPath);
            expect(content).toBe('export const x = 1;\n');
        });

        it('appends additional files to the same session proposal', () => {
            const p1 = captureWrite({
                toolName: 'write_file',
                filePath: '/tmp/a.ts',
                content: 'a',
                sessionId: 'sess-2',
                agentId: null,
                goalId: 'g', goalTitle: 'G', goalProposedBy: 'soma:curiosity',
            });
            const p2 = captureWrite({
                toolName: 'write_file',
                filePath: '/tmp/b.ts',
                content: 'b',
                sessionId: 'sess-2',
                agentId: null,
                goalId: 'g', goalTitle: 'G', goalProposedBy: 'soma:curiosity',
            });
            expect(p1!.id).toBe(p2!.id);
            expect(p2!.files).toHaveLength(2);
        });

        it('deduplicates repeat writes to the same path', () => {
            const p1 = captureWrite({
                toolName: 'write_file',
                filePath: '/tmp/c.ts',
                content: 'v1',
                sessionId: 'sess-3',
                agentId: null,
                goalId: 'g', goalTitle: 'G', goalProposedBy: 'soma:curiosity',
            });
            const p2 = captureWrite({
                toolName: 'edit_file',
                filePath: '/tmp/c.ts',
                content: 'v2',
                sessionId: 'sess-3',
                agentId: null,
                goalId: 'g', goalTitle: 'G', goalProposedBy: 'soma:curiosity',
            });
            expect(p2!.files).toHaveLength(1);
            // Latest content wins
            const content = getProposalFileContent(p1!.id, p1!.files[0].capturedPath);
            expect(content).toBe('v2');
        });
    });

    describe('listProposals / getProposal', () => {
        it('returns newest-first', () => {
            captureWrite({
                toolName: 'write_file', filePath: '/tmp/a.ts', content: 'a',
                sessionId: 's1', agentId: null, goalId: null, goalTitle: null, goalProposedBy: 'soma:curiosity',
            });
            captureWrite({
                toolName: 'write_file', filePath: '/tmp/b.ts', content: 'b',
                sessionId: 's2', agentId: null, goalId: null, goalTitle: null, goalProposedBy: 'soma:hunger',
            });
            const list = listProposals(10);
            expect(list.length).toBe(2);
            // newer first
            expect(list[0].drive).toBe('hunger');
            expect(list[1].drive).toBe('curiosity');
        });
    });

    describe('isReadyForPR', () => {
        it('requires all 3 specialist approvals', () => {
            const p = captureWrite({
                toolName: 'write_file', filePath: '/tmp/x.ts', content: 'x',
                sessionId: 's-pr', agentId: null, goalId: null, goalTitle: null, goalProposedBy: 'soma:curiosity',
            })!;
            updateStatus(p.id, 'review_pending');

            // Only 2 of 3 approved
            attachVerdict(p.id, { specialistId: 'analyst', vote: 'approve', rationale: 'ok', reviewedAt: new Date().toISOString() });
            attachVerdict(p.id, { specialistId: 'builder', vote: 'approve', rationale: 'ok', reviewedAt: new Date().toISOString() });
            expect(isReadyForPR(getProposal(p.id)!)).toBe(false);

            attachVerdict(p.id, { specialistId: 'writer', vote: 'approve', rationale: 'ok', reviewedAt: new Date().toISOString() });
            expect(isReadyForPR(getProposal(p.id)!)).toBe(true);
        });

        it('single reject blocks readiness', () => {
            const p = captureWrite({
                toolName: 'write_file', filePath: '/tmp/y.ts', content: 'y',
                sessionId: 's-reject', agentId: null, goalId: null, goalTitle: null, goalProposedBy: 'soma:curiosity',
            })!;
            updateStatus(p.id, 'review_pending');
            attachVerdict(p.id, { specialistId: 'analyst', vote: 'approve', rationale: 'ok', reviewedAt: new Date().toISOString() });
            attachVerdict(p.id, { specialistId: 'builder', vote: 'reject', rationale: 'bugs', reviewedAt: new Date().toISOString() });
            attachVerdict(p.id, { specialistId: 'writer', vote: 'approve', rationale: 'ok', reviewedAt: new Date().toISOString() });
            expect(isReadyForPR(getProposal(p.id)!)).toBe(false);
        });
    });

    describe('getProposalFileContent path traversal guard', () => {
        it('refuses paths that escape the proposal dir', () => {
            const p = captureWrite({
                toolName: 'write_file', filePath: '/tmp/safe.ts', content: 'safe',
                sessionId: 's-sec', agentId: null, goalId: null, goalTitle: null, goalProposedBy: 'soma:curiosity',
            })!;
            expect(getProposalFileContent(p.id, '../../../etc/passwd')).toBeNull();
            expect(getProposalFileContent(p.id, '/etc/passwd')).toBeNull();
        });
    });
});
