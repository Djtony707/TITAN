/**
 * TITAN — Self-Mod Staging + Scope Lock tests (v4.9.0-local.8)
 *
 * Covers the three-layer defense that prevents TITAN from LARPing
 * self-modification into unrelated projects (the ~/titan-saas pattern
 * observed 2026-04-18):
 *   1. Goal rewriter — ambiguous "framework" resolves to explicit target
 *   2. Scope lock    — writes outside target refused when goal is tagged
 *   3. Staging       — writes inside target diverted to staging dir + PR
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome, tmpTarget } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    const tmpHome = mk(jn(td(), 'titan-selfmod-home-')) as string;
    const tmpTarget = mk(jn(td(), 'titan-selfmod-target-')) as string;
    return { tmpHome, tmpTarget };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', async (orig) => {
    const actual = await orig<typeof import('../src/config/config.js')>();
    return {
        ...actual,
        loadConfig: vi.fn().mockReturnValue({
            ...actual.getDefaultConfig(),
            autonomy: {
                ...actual.getDefaultConfig().autonomy,
                selfMod: {
                    target: tmpTarget,
                    tags: ['self-healing', 'self-repair', 'framework', 'core', 'self-mod'],
                    staging: true,
                    stagingDir: 'self-mod-staging',
                },
            },
        }),
    };
});

// Stub commandPost so we don't drag in the whole approval persistence layer
vi.mock('../src/agent/commandPost.js', () => ({
    createApproval: vi.fn((opts: Record<string, unknown>) => ({ id: 'appr-test-' + Math.random().toString(36).slice(2, 8), ...opts })),
    getApproval: vi.fn(() => null),
}));

// Stub shadowGit
vi.mock('../src/agent/shadowGit.js', () => ({
    snapshotBeforeWrite: vi.fn(async () => { /* ok */ }),
}));

// Stub opusReview — applyStagedPR now routes through the reviewer gate.
// In tests we want apply paths to succeed without spinning up a real LLM,
// so we return an auto-approve verdict with high confidence.
vi.mock('../src/safety/opusReview.js', () => ({
    reviewStagedBundle: vi.fn(async () => ({
        verdict: 'approve',
        confidence: 0.95,
        reasoning: 'mock reviewer auto-approve',
        concerns: [],
        suggestions: [],
        model: 'mock-reviewer',
    })),
    reviewerBlocksOnReject: vi.fn(() => false),
    reviewerEnabled: vi.fn(() => false),
}));

import {
    resolveSelfModConfig, goalMatchesSelfModTags, isInsideTarget,
    decideScope, recordStagedWrite, applyStagedPR, rejectStagedPR,
    _resetSelfModStagingForTests,
} from '../src/agent/selfModStaging.js';
import { setSessionGoal, clearSessionGoal } from '../src/agent/autonomyContext.js';

describe('self-mod staging + scope lock', () => {
    beforeEach(() => {
        _resetSelfModStagingForTests();
        // Clean staging dir between tests
        try { rmSync(join(tmpHome, 'self-mod-staging'), { recursive: true, force: true }); } catch { /* ok */ }
    });

    afterEach(() => {
        clearSessionGoal('sess-1');
    });

    describe('config resolution', () => {
        it('reads target + tags + staging flag from config', () => {
            const sm = resolveSelfModConfig();
            expect(sm.target).toBe(tmpTarget);
            expect(sm.tags).toContain('self-healing');
            expect(sm.staging).toBe(true);
        });
    });

    describe('goalMatchesSelfModTags', () => {
        it('matches when any goal tag is in selfMod.tags (case-insensitive)', () => {
            expect(goalMatchesSelfModTags(['Self-Healing', 'reliability'])).toBe(true);
            expect(goalMatchesSelfModTags(['framework'])).toBe(true);
        });

        it('does not match when no overlap', () => {
            expect(goalMatchesSelfModTags(['user-facing', 'ui'])).toBe(false);
            expect(goalMatchesSelfModTags([])).toBe(false);
            expect(goalMatchesSelfModTags(undefined)).toBe(false);
        });
    });

    describe('isInsideTarget', () => {
        it('accepts paths at or under target', () => {
            expect(isInsideTarget(tmpTarget)).toBe(true);
            expect(isInsideTarget(join(tmpTarget, 'src/foo.ts'))).toBe(true);
        });

        it('rejects sibling and unrelated paths', () => {
            expect(isInsideTarget('/home/dj/titan-saas/foo.ts')).toBe(false);
            expect(isInsideTarget(tmpTarget + '-sibling/foo.ts')).toBe(false); // prefix collision guard
        });
    });

    describe('decideScope', () => {
        it('allows when no session goal', () => {
            const d = decideScope(null, '/tmp/x');
            expect(d.action).toBe('allow');
        });

        it('allows when goal has no self-mod tags', () => {
            setSessionGoal('sess-1', {
                goalId: 'g1', goalTitle: 'Fix UI bug', proposedBy: 'user', tags: ['ui', 'bug'],
            });
            const d = decideScope('sess-1', '/home/dj/titan-saas/foo.ts');
            expect(d.action).toBe('allow');
            clearSessionGoal('sess-1');
        });

        it('rejects writes outside target when goal is self-mod tagged', () => {
            setSessionGoal('sess-1', {
                goalId: 'g1', goalTitle: 'Self-healing module', proposedBy: 'scout', tags: ['self-healing'],
            });
            const d = decideScope('sess-1', '/home/dj/titan-saas/lib/health.ts');
            expect(d.action).toBe('reject');
            expect(d.reason).toMatch(/self-modification-tagged/i);
            expect(d.reason).toContain(tmpTarget);
            clearSessionGoal('sess-1');
        });

        it('stages writes inside target when goal is self-mod tagged', () => {
            setSessionGoal('sess-1', {
                goalId: 'g-abc123', goalTitle: 'Core framework hardening', proposedBy: 'soma:safety', tags: ['framework'],
            });
            const target = join(tmpTarget, 'src/agent/toolRunner.ts');
            const d = decideScope('sess-1', target);
            expect(d.action).toBe('stage');
            expect(d.targetPath).toBe(target);
            expect(d.stagedPath).toContain('self-mod-staging');
            expect(d.stagedPath).toContain('g-abc123');
            expect(d.stagedPath).toMatch(/src\/agent\/toolRunner\.ts$/);
            clearSessionGoal('sess-1');
        });
    });

    describe('recordStagedWrite + applyStagedPR', () => {
        it('writes bundle.json, applies files to target, and archives staging dir', async () => {
            setSessionGoal('sess-1', {
                goalId: 'g-apply', goalTitle: 'Self-heal loop', proposedBy: 'scout', tags: ['self-repair'],
            });
            const d = decideScope('sess-1', join(tmpTarget, 'src/test.ts'));
            expect(d.action).toBe('stage');
            // Simulate the tool writing to staged path
            const { mkdirSync } = await import('fs');
            const { dirname } = await import('path');
            mkdirSync(dirname(d.stagedPath!), { recursive: true });
            writeFileSync(d.stagedPath!, 'export const x = 1;\n');

            await recordStagedWrite({
                sessionId: 'sess-1',
                toolName: 'write_file',
                stagedPath: d.stagedPath!,
                targetPath: d.targetPath!,
            });

            const bundlePath = join(tmpHome, 'self-mod-staging', 'g-apply', 'bundle.json');
            expect(existsSync(bundlePath)).toBe(true);
            const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
            expect(bundle.files).toHaveLength(1);
            expect(bundle.files[0].targetPath).toBe(d.targetPath);
            expect(bundle.files[0].sizeBytes).toBeGreaterThan(0);

            // Target file shouldn't exist yet — staging hasn't been applied
            expect(existsSync(d.targetPath!)).toBe(false);

            // Apply
            const result = await applyStagedPR('g-apply');
            expect(result.applied).toEqual([d.targetPath]);
            expect(result.failed).toHaveLength(0);
            expect(existsSync(d.targetPath!)).toBe(true);
            expect(readFileSync(d.targetPath!, 'utf-8')).toBe('export const x = 1;\n');
            // Staging dir is archived
            expect(existsSync(join(tmpHome, 'self-mod-staging', 'g-apply'))).toBe(false);
            clearSessionGoal('sess-1');
        });

        it('rejectStagedPR archives without applying', async () => {
            setSessionGoal('sess-1', {
                goalId: 'g-reject', goalTitle: 'Bad self-mod', proposedBy: 'scout', tags: ['self-mod'],
            });
            const d = decideScope('sess-1', join(tmpTarget, 'src/will-not-land.ts'));
            expect(d.action).toBe('stage');
            const { mkdirSync } = await import('fs');
            const { dirname } = await import('path');
            mkdirSync(dirname(d.stagedPath!), { recursive: true });
            writeFileSync(d.stagedPath!, 'dangerous');
            await recordStagedWrite({
                sessionId: 'sess-1',
                toolName: 'write_file',
                stagedPath: d.stagedPath!,
                targetPath: d.targetPath!,
            });

            const r = rejectStagedPR('g-reject', 'looks sketchy');
            expect(r.archived).toBe(true);
            expect(existsSync(d.targetPath!)).toBe(false);
            expect(existsSync(join(tmpHome, 'self-mod-staging', 'g-reject'))).toBe(false);
            clearSessionGoal('sess-1');
        });

        it('multiple writes for the same goal accumulate in one bundle', async () => {
            setSessionGoal('sess-1', {
                goalId: 'g-multi', goalTitle: 'Multi-file self-mod', proposedBy: 'scout', tags: ['self-healing'],
            });
            const { mkdirSync } = await import('fs');
            const { dirname } = await import('path');
            for (const rel of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
                const d = decideScope('sess-1', join(tmpTarget, rel));
                expect(d.action).toBe('stage');
                mkdirSync(dirname(d.stagedPath!), { recursive: true });
                writeFileSync(d.stagedPath!, `// ${rel}\n`);
                await recordStagedWrite({
                    sessionId: 'sess-1',
                    toolName: 'write_file',
                    stagedPath: d.stagedPath!,
                    targetPath: d.targetPath!,
                });
            }
            const bundle = JSON.parse(readFileSync(join(tmpHome, 'self-mod-staging', 'g-multi', 'bundle.json'), 'utf-8'));
            expect(bundle.files).toHaveLength(3);
            const result = await applyStagedPR('g-multi');
            expect(result.applied).toHaveLength(3);
            clearSessionGoal('sess-1');
        });

        it('dedupes repeat writes to the same target within one goal', async () => {
            setSessionGoal('sess-1', {
                goalId: 'g-dedup', goalTitle: 'Dedup test', proposedBy: 'scout', tags: ['self-healing'],
            });
            const target = join(tmpTarget, 'src/d.ts');
            const { mkdirSync } = await import('fs');
            const { dirname } = await import('path');
            for (const content of ['v1', 'v2', 'v3']) {
                const d = decideScope('sess-1', target);
                mkdirSync(dirname(d.stagedPath!), { recursive: true });
                writeFileSync(d.stagedPath!, content);
                await recordStagedWrite({
                    sessionId: 'sess-1',
                    toolName: 'write_file',
                    stagedPath: d.stagedPath!,
                    targetPath: d.targetPath!,
                });
            }
            const bundle = JSON.parse(readFileSync(join(tmpHome, 'self-mod-staging', 'g-dedup', 'bundle.json'), 'utf-8'));
            expect(bundle.files).toHaveLength(1);
            const result = await applyStagedPR('g-dedup');
            expect(result.applied).toEqual([target]);
            expect(readFileSync(target, 'utf-8')).toBe('v3'); // latest wins
            clearSessionGoal('sess-1');
        });
    });

    describe('applyStagedPR on missing bundle', () => {
        it('returns a failed result without throwing', async () => {
            const r = await applyStagedPR('g-nonexistent');
            expect(r.applied).toHaveLength(0);
            expect(r.failed).toHaveLength(1);
            expect(r.bundle).toBeNull();
        });
    });

    // Test cleanup
    afterEach(() => {
        try { rmSync(join(tmpHome, 'self-mod-staging'), { recursive: true, force: true }); } catch { /* ok */ }
    });
});

describe('goalProposer self-mod rewriter', () => {
    // The rewriter runs in normalizeProposal but that's a private function.
    // Easiest way to exercise it: call the module's exported side-effects
    // through a direct import path that returns a proposal. Since the
    // generateGoalProposals call requires a live LLM, we instead test
    // the detection logic indirectly via decideScope by constructing a
    // goal-tagged context manually. The rewriter is also covered by the
    // integration tests that run live against the proposer. Here we just
    // assert the tag normalization at the decideScope layer.

    it('a goal tagged with "framework" activates scope-lock', () => {
        setSessionGoal('sess-2', {
            goalId: 'g-fw', goalTitle: 'Do framework things', proposedBy: 'scout', tags: ['framework'],
        });
        const d = decideScope('sess-2', '/home/dj/titan-saas/some-file.ts');
        expect(d.action).toBe('reject');
        clearSessionGoal('sess-2');
    });

    it('a goal tagged with self-mod activates scope-lock', () => {
        setSessionGoal('sess-2', {
            goalId: 'g-sm', goalTitle: 'Self-mod things', proposedBy: 'scout', tags: ['self-mod'],
        });
        const d = decideScope('sess-2', '/elsewhere/file.ts');
        expect(d.action).toBe('reject');
        clearSessionGoal('sess-2');
    });
});

// Cleanup tmp dirs at end — tmpdir() entries are auto-GC'd but being tidy helps debug
import { afterAll } from 'vitest';
afterAll(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
    try { rmSync(tmpTarget, { recursive: true, force: true }); } catch { /* ok */ }
});

// Silence unused imports
void mkdtempSync; void tmpdir;
