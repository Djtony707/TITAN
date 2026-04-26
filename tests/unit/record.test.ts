/**
 * TITAN — Auto-Corpus Expansion Tests (Phase 6)
 *
 * Pure, deterministic tests for eval/record.ts.
 * No LLM calls. Fast (< 50ms total).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEMP_AUTO_DIR = mkdtempSync(join(tmpdir(), 'titan-record-test-'));
const AUTO_DIR = join(TEMP_AUTO_DIR, 'tests', 'fixtures', 'tapes', 'auto');

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Reset modules so record.ts re-evaluates AUTO_DIR after spy is set
vi.resetModules();
vi.spyOn(process, 'cwd').mockReturnValue(TEMP_AUTO_DIR);

let record: typeof import('../../src/eval/record.js');

beforeAll(async () => {
    record = await import('../../src/eval/record.js');
});

describe('Auto-Corpus Expansion', () => {
    const mockEvalCase = {
        name: 'test-case',
        input: 'test input',
    };

    const mockEvalResult = {
        name: 'test-case',
        passed: false,
        errors: ['Expected tool not called'],
        durationMs: 100,
        toolsUsed: ['read_file'] as string[],
        content: 'test response',
    };

    function cleanAutoDir(): void {
        try {
            if (!existsSync(AUTO_DIR)) return;
            const files = readdirSync(AUTO_DIR);
            for (const f of files) {
                if (f.endsWith('.json')) {
                    rmSync(join(AUTO_DIR, f));
                }
            }
        } catch {
            // ignore
        }
    }

    beforeEach(() => {
        cleanAutoDir();
    });

    afterEach(() => {
        cleanAutoDir();
    });

    it('records a failed trace to disk', () => {
        const result = record.recordFailedTrace(
            'malicious input',
            mockEvalCase,
            mockEvalResult,
            { suite: 'safety', name: 'malicious_case' },
        );

        expect(result.deduplicated).toBe(false);
        expect(result.path).toBeTruthy();
        expect(existsSync(result.path)).toBe(true);

        const raw = readFileSync(result.path, 'utf-8');
        const tape = JSON.parse(raw);
        expect(tape.input).toBe('malicious input');
        expect(tape.suite).toBe('safety');
        expect(tape.name).toBe('malicious_case');
        expect(tape.actual.passed).toBe(false);
    });

    it('deduplicates identical inputs', () => {
        const result1 = record.recordFailedTrace(
            'same input',
            mockEvalCase,
            mockEvalResult,
            { suite: 'safety', name: 'case_a' },
        );
        expect(result1.deduplicated).toBe(false);

        const result2 = record.recordFailedTrace(
            'same input',
            mockEvalCase,
            mockEvalResult,
            { suite: 'safety', name: 'case_b' },
        );
        expect(result2.deduplicated).toBe(true);
        expect(result2.path).toBe('');
    });

    it('allows different inputs with same name', () => {
        const result1 = record.recordFailedTrace(
            'input one',
            mockEvalCase,
            mockEvalResult,
            { suite: 'safety', name: 'same_name' },
        );
        expect(result1.deduplicated).toBe(false);

        const result2 = record.recordFailedTrace(
            'input two',
            mockEvalCase,
            mockEvalResult,
            { suite: 'safety', name: 'same_name' },
        );
        expect(result2.deduplicated).toBe(false);
    });

    it('purges old auto-tapes', async () => {
        const result = record.recordFailedTrace(
            'old input',
            mockEvalCase,
            mockEvalResult,
            { suite: 'safety', name: 'old_case' },
        );
        expect(existsSync(result.path)).toBe(true);

        await new Promise(r => setTimeout(r, 50));

        const removed = record.purgeOldAutoTapes(0);
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(existsSync(result.path)).toBe(false);
    });

    it('lists auto-tapes sorted by mtime', () => {
        record.recordFailedTrace('input a', mockEvalCase, mockEvalResult, { suite: 'safety', name: 'a' });
        record.recordFailedTrace('input b', mockEvalCase, mockEvalResult, { suite: 'safety', name: 'b' });

        const tapes = record.listAutoTapes();
        expect(tapes.length).toBe(2);
        expect(tapes[0].mtime.getTime()).toBeGreaterThanOrEqual(tapes[1].mtime.getTime());
    });

    it('returns empty list when no auto-tapes exist', () => {
        const tapes = record.listAutoTapes();
        expect(Array.isArray(tapes)).toBe(true);
        expect(tapes.length).toBe(0);
    });

    it('produces valid tape JSON', () => {
        const result = record.recordFailedTrace(
            'json test',
            { ...mockEvalCase, expectedTools: ['weather'], forbiddenTools: ['shell'] },
            mockEvalResult,
            { suite: 'routing', name: 'weather_check' },
        );

        const raw = readFileSync(result.path, 'utf-8');
        const tape = JSON.parse(raw);
        expect(tape).toHaveProperty('name');
        expect(tape).toHaveProperty('suite');
        expect(tape).toHaveProperty('model');
        expect(tape).toHaveProperty('recorded_at');
        expect(tape).toHaveProperty('titan_version');
        expect(tape).toHaveProperty('input');
        expect(tape).toHaveProperty('expected');
        expect(tape).toHaveProperty('actual');
        expect(tape).toHaveProperty('exchanges');
        expect(tape.exchanges).toEqual([]);
    });

    it('uses defaults when options omitted', () => {
        const result = record.recordFailedTrace('default test', mockEvalCase, mockEvalResult);
        expect(result.deduplicated).toBe(false);

        const raw = readFileSync(result.path, 'utf-8');
        const tape = JSON.parse(raw);
        expect(tape.suite).toBe('unknown');
        expect(tape.name).toBe('test-case');
    });
});

afterAll(() => {
    try {
        rmSync(TEMP_AUTO_DIR, { recursive: true, force: true });
    } catch {
        // ignore cleanup errors
    }
});
