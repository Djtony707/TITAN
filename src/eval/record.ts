/**
 * TITAN — Auto-Corpus Expansion (Phase 6)
 *
 * When a production trace fails eval, automatically add it to the tape corpus.
 * Deduplication prevents bloating. Configurable retention purges old auto-tapes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { EvalCase, EvalResult } from './harness.js';

const AUTO_DIR = join(process.cwd(), 'tests', 'fixtures', 'tapes', 'auto');
const DEFAULT_RETENTION_DAYS = 30;

/** Compute a stable hash of the input for deduplication */
function hashInput(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Ensure the auto-tape directory exists */
function ensureAutoDir(): void {
    if (!existsSync(AUTO_DIR)) {
        mkdirSync(AUTO_DIR, { recursive: true });
    }
}

/** Build a tape filename from metadata */
function buildTapeName(suite: string, name: string, timestamp: number, inputHash: string): string {
    const safeSuite = suite.replace(/[^a-z0-9_-]/gi, '_');
    const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
    return `${timestamp}_${safeSuite}_${safeName}_${inputHash}.json`;
}

/** Check if an auto-tape with the same input hash already exists */
function hasExistingTape(inputHash: string): boolean {
    if (!existsSync(AUTO_DIR)) return false;
    const files = readdirSync(AUTO_DIR);
    return files.some(f => f.includes(`_${inputHash}.json`));
}

export interface RecordOptions {
    suite?: string;
    name?: string;
    retentionDays?: number;
}

export interface RecordedTape {
    path: string;
    deduplicated: boolean;
    inputHash: string;
}

/**
 * Record a failed eval trace as a new auto-tape.
 *
 * Returns the path to the written file, or null if deduplicated.
 * Throws on I/O errors.
 */
export function recordFailedTrace(
    input: string,
    expected: EvalCase,
    actual: EvalResult,
    options: RecordOptions = {},
): RecordedTape {
    ensureAutoDir();

    const inputHash = hashInput(input);

    if (hasExistingTape(inputHash)) {
        return { path: '', deduplicated: true, inputHash };
    }

    const timestamp = Date.now();
    const suite = options.suite || 'unknown';
    const name = options.name || expected.name || 'untitled';
    const filename = buildTapeName(suite, name, timestamp, inputHash);
    const filepath = join(AUTO_DIR, filename);

    const tape = {
        name,
        suite,
        model: 'auto-corpus',
        recorded_at: new Date(timestamp).toISOString(),
        titan_version: process.env.npm_package_version || '0.0.0',
        input,
        expected: {
            tools: expected.expectedTools,
            toolSequence: expected.expectedToolSequence,
            content: expected.expectedContent?.toString(),
            forbiddenTools: expected.forbiddenTools,
        },
        actual: {
            passed: actual.passed,
            errors: actual.errors,
            toolsUsed: actual.toolsUsed,
            content: actual.content,
        },
        exchanges: [],
    };

    writeFileSync(filepath, JSON.stringify(tape, null, 2), 'utf-8');

    return { path: filepath, deduplicated: false, inputHash };
}

/**
 * Purge auto-tapes older than the retention threshold.
 *
 * Returns the number of files removed.
 */
export function purgeOldAutoTapes(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
    if (!existsSync(AUTO_DIR)) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(AUTO_DIR);
    let removed = 0;

    for (const file of files) {
        const filepath = join(AUTO_DIR, file);
        try {
            const stats = statSync(filepath);
            if (stats.mtimeMs < cutoff) {
                rmSync(filepath);
                removed++;
            }
        } catch {
            // Ignore stat/rm errors on individual files
        }
    }

    return removed;
}

/**
 * List all auto-tapes with metadata.
 */
export function listAutoTapes(): Array<{ name: string; path: string; size: number; mtime: Date }> {
    if (!existsSync(AUTO_DIR)) return [];

    return readdirSync(AUTO_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const filepath = join(AUTO_DIR, f);
            const stats = statSync(filepath);
            return {
                name: f,
                path: filepath,
                size: stats.size,
                mtime: stats.mtime,
            };
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
