/**
 * Self-Improvement Skill — Phase 9 safety tests
 * Rate limiting, checkpoint/rollback, evaluation scoring
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Per-suite temp dir so two parallel vitest forks (CI runs --pool=forks
// with maxForks=2) don't race on a shared TITAN_HOME/self-improve path.
// Pre-fix the test imported the constants TITAN_HOME and shared
// .last-mutation across processes — failed sporadically in CI when
// another fork's beforeEach raced this fork's recordMutation().
const SELF_IMPROVE_DIR = mkdtempSync(join(tmpdir(), 'titan-self-improve-test-'));
const LAST_MUTATION_PATH = join(SELF_IMPROVE_DIR, '.last-mutation');
const CHECKPOINTS_DIR = join(SELF_IMPROVE_DIR, 'checkpoints');

// Re-implement the helpers to test them in isolation (they're private in the module)
function canMutate(minIntervalMs = 60 * 60 * 1000): boolean {
    try {
        if (!existsSync(LAST_MUTATION_PATH)) return true;
        const last = parseInt(readFileSync(LAST_MUTATION_PATH, 'utf-8').trim(), 10);
        return Date.now() - last >= minIntervalMs;
    } catch {
        return true;
    }
}

function recordMutation(): void {
    try {
        writeFileSync(LAST_MUTATION_PATH, String(Date.now()), 'utf-8');
    } catch { /* non-critical */ }
}

function createCheckpoint(areaId: string, content: string): string {
    try {
        mkdirSync(CHECKPOINTS_DIR, { recursive: true });
        const checkpointId = `${areaId}-${Date.now()}`;
        const path = join(CHECKPOINTS_DIR, `${checkpointId}.txt`);
        writeFileSync(path, content, 'utf-8');
        return path;
    } catch {
        return '';
    }
}

function restoreCheckpoint(areaId: string): string | null {
    try {
        const files = readdirSync(CHECKPOINTS_DIR)
            .filter(f => f.startsWith(areaId + '-'))
            .sort()
            .reverse();
        if (files.length === 0) return null;
        const path = join(CHECKPOINTS_DIR, files[0]);
        return readFileSync(path, 'utf-8');
    } catch {
        return null;
    }
}

describe('self-improve rate limiting', () => {
    const BASE_TIME = 1_000_000_000_000;

    beforeEach(() => {
        // Ensure clean state
        try { rmSync(LAST_MUTATION_PATH); } catch { /* ignore */ }
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
    });

    afterEach(() => {
        vi.useRealTimers();
        try { rmSync(LAST_MUTATION_PATH); } catch { /* ignore */ }
    });

    it('allows mutation when no prior mutation recorded', () => {
        expect(canMutate()).toBe(true);
    });

    it('blocks mutation within the cooldown window', () => {
        recordMutation();
        vi.setSystemTime(BASE_TIME + 30 * 60 * 1000); // 30 minutes later
        expect(canMutate()).toBe(false);
    });

    it('allows mutation after the cooldown window expires', () => {
        recordMutation();
        vi.setSystemTime(BASE_TIME + 61 * 60 * 1000); // 61 minutes later
        expect(canMutate()).toBe(true);
    });

    it('uses custom interval when provided', () => {
        recordMutation();
        vi.setSystemTime(BASE_TIME + 5 * 60 * 1000); // 5 minutes later
        expect(canMutate(10 * 60 * 1000)).toBe(false); // 10 min interval
        vi.setSystemTime(BASE_TIME + 11 * 60 * 1000); // 11 minutes later
        expect(canMutate(10 * 60 * 1000)).toBe(true);
    });
});

describe('self-improve checkpoint/rollback', () => {
    beforeEach(() => {
        try { rmSync(CHECKPOINTS_DIR, { recursive: true }); } catch { /* ignore */ }
    });

    afterEach(() => {
        try { rmSync(CHECKPOINTS_DIR, { recursive: true }); } catch { /* ignore */ }
    });

    it('creates a checkpoint file with the given content', () => {
        const path = createCheckpoint('prompt-1', 'original prompt content');
        expect(path).not.toBe('');
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, 'utf-8')).toBe('original prompt content');
    });

    it('restores the most recent checkpoint for an area', () => {
        createCheckpoint('area-a', 'version-1');
        createCheckpoint('area-a', 'version-2');
        createCheckpoint('area-b', 'version-b');

        const restored = restoreCheckpoint('area-a');
        expect(restored).toBe('version-2');
    });

    it('returns null when no checkpoint exists for an area', () => {
        const restored = restoreCheckpoint('nonexistent');
        expect(restored).toBeNull();
    });
});

afterAll(() => {
    // Clean up the per-suite temp dir so we don't leak fixtures into /tmp.
    try { rmSync(SELF_IMPROVE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
