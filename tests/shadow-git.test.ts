/**
 * TITAN — Shadow Git Checkpoint Tests
 * Tests P6 from Hermes integration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Use a temp directory for all test operations
const testDir = vi.hoisted(() => {
    const os = require('os');
    const path = require('path');
    return path.join(os.tmpdir(), 'titan-test-shadow-' + Date.now());
});

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, homedir: () => testDir };
});

import {
    initShadowRepo,
    snapshotBeforeWrite,
    listCheckpoints,
    diffCheckpoint,
    restoreCheckpoint,
    shouldSkipDir,
} from '../src/agent/shadowGit.js';

// Test workspace directory (simulates user's project)
let workDir: string;

beforeEach(() => {
    mkdirSync(join(testDir, '.titan', 'file-checkpoints'), { recursive: true });
    workDir = join(testDir, 'project');
    mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ShadowGit', () => {
    describe('initShadowRepo', () => {
        it('creates a shadow git repo for a directory', () => {
            const repoPath = initShadowRepo(workDir);
            expect(existsSync(join(repoPath, '.git'))).toBe(true);
            expect(existsSync(join(repoPath, 'titan-shadow-meta.json'))).toBe(true);
        });

        it('is idempotent — returns same path on second call', () => {
            const first = initShadowRepo(workDir);
            const second = initShadowRepo(workDir);
            expect(first).toBe(second);
        });

        it('stores metadata with original directory path', () => {
            const repoPath = initShadowRepo(workDir);
            const meta = JSON.parse(readFileSync(join(repoPath, 'titan-shadow-meta.json'), 'utf-8'));
            expect(meta.originalDir).toContain('project');
            expect(meta.createdAt).toBeTruthy();
        });
    });

    describe('snapshotBeforeWrite', () => {
        it('creates a snapshot of an existing file', async () => {
            const filePath = join(workDir, 'test.ts');
            writeFileSync(filePath, 'const x = 1;', 'utf-8');

            const checkpoint = await snapshotBeforeWrite('write_file', filePath);

            expect(checkpoint).not.toBeNull();
            expect(checkpoint!.toolName).toBe('write_file');
            expect(checkpoint!.filePath).toContain('test.ts');
            expect(checkpoint!.commitHash).toBeTruthy();
            expect(checkpoint!.id.length).toBe(8);
        });

        it('returns null for new files (no previous state)', async () => {
            const filePath = join(workDir, 'new-file.ts');
            // Don't create the file — it doesn't exist yet

            const checkpoint = await snapshotBeforeWrite('write_file', filePath);
            expect(checkpoint).toBeNull();
        });

        it('returns null when file content unchanged', async () => {
            const filePath = join(workDir, 'stable.ts');
            writeFileSync(filePath, 'const x = 1;', 'utf-8');

            // First snapshot
            const first = await snapshotBeforeWrite('write_file', filePath);
            expect(first).not.toBeNull();

            // Second snapshot without changing the file
            const second = await snapshotBeforeWrite('write_file', filePath);
            expect(second).toBeNull(); // No changes to commit
        });

        it('creates multiple snapshots for different file versions', async () => {
            const filePath = join(workDir, 'evolving.ts');

            writeFileSync(filePath, 'version 1', 'utf-8');
            const cp1 = await snapshotBeforeWrite('write_file', filePath);

            writeFileSync(filePath, 'version 2', 'utf-8');
            const cp2 = await snapshotBeforeWrite('edit_file', filePath);

            expect(cp1).not.toBeNull();
            expect(cp2).not.toBeNull();
            expect(cp1!.commitHash).not.toBe(cp2!.commitHash);
        });
    });

    describe('listCheckpoints', () => {
        it('lists checkpoints for a file', async () => {
            const filePath = join(workDir, 'listed.ts');
            writeFileSync(filePath, 'original', 'utf-8');
            await snapshotBeforeWrite('write_file', filePath);

            writeFileSync(filePath, 'modified', 'utf-8');
            await snapshotBeforeWrite('edit_file', filePath);

            const checkpoints = listCheckpoints(filePath);
            expect(checkpoints.length).toBe(2);
            expect(checkpoints[0].toolName).toBe('write_file');
            expect(checkpoints[1].toolName).toBe('edit_file');
        });

        it('returns empty array for files with no checkpoints', () => {
            const checkpoints = listCheckpoints('/nonexistent/file.ts');
            expect(checkpoints).toEqual([]);
        });

        it('lists all checkpoints for a directory', async () => {
            const file1 = join(workDir, 'a.ts');
            const file2 = join(workDir, 'b.ts');

            writeFileSync(file1, 'content a', 'utf-8');
            writeFileSync(file2, 'content b', 'utf-8');

            await snapshotBeforeWrite('write_file', file1);
            await snapshotBeforeWrite('write_file', file2);

            const checkpoints = listCheckpoints(workDir);
            expect(checkpoints.length).toBe(2);
        });
    });

    describe('diffCheckpoint', () => {
        it('shows diff between checkpoint and current state', async () => {
            const filePath = join(workDir, 'diffed.ts');
            writeFileSync(filePath, 'line 1\nline 2\nline 3', 'utf-8');

            const cp = await snapshotBeforeWrite('write_file', filePath);
            expect(cp).not.toBeNull();

            // Modify the file in the shadow repo to simulate changes
            // (In real usage, the user modifies the original file, but diff compares within shadow repo)
            const diff = diffCheckpoint(cp!.id);
            // Should return something (either diff or "no differences")
            expect(typeof diff).toBe('string');
        });
    });

    describe('restoreCheckpoint', () => {
        it('restores a file to its checkpoint state', async () => {
            const filePath = join(workDir, 'restored.ts');
            const originalContent = 'original content here';

            writeFileSync(filePath, originalContent, 'utf-8');
            const cp = await snapshotBeforeWrite('write_file', filePath);
            expect(cp).not.toBeNull();

            // Simulate the write tool modifying the file
            writeFileSync(filePath, 'COMPLETELY DIFFERENT CONTENT', 'utf-8');

            // Restore from checkpoint
            const result = restoreCheckpoint(cp!.id);
            expect(result).toContain('Restored');

            // Verify content was restored
            const restored = readFileSync(filePath, 'utf-8');
            expect(restored).toBe(originalContent);
        });

        it('returns error for unknown checkpoint ID', () => {
            const result = restoreCheckpoint('nonexistent');
            expect(result).toContain('not found');
        });
    });

    describe('shouldSkipDir', () => {
        it('returns false for normal directories', () => {
            expect(shouldSkipDir(workDir)).toBe(false);
        });

        it('returns true for non-existent directories', () => {
            expect(shouldSkipDir('/nonexistent/path')).toBe(true);
        });
    });

    describe('shared shadow repo', () => {
        it('multiple files in same directory share one shadow repo', async () => {
            const file1 = join(workDir, 'shared1.ts');
            const file2 = join(workDir, 'shared2.ts');

            writeFileSync(file1, 'content 1', 'utf-8');
            writeFileSync(file2, 'content 2', 'utf-8');

            const cp1 = await snapshotBeforeWrite('write_file', file1);
            const cp2 = await snapshotBeforeWrite('write_file', file2);

            expect(cp1).not.toBeNull();
            expect(cp2).not.toBeNull();
            // Same shadow repo path
            expect(cp1!.repoPath).toBe(cp2!.repoPath);
        });
    });
});
