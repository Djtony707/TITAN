/**
 * v6.0.2 — Soma advisory dedup + retention.
 *
 * Pins the fix for the production bug where steady-state user behaviour
 * was producing the same advisory ("you're active at weekday-17, set up
 * an auto-briefing?") every 5 minutes, accumulating 35+ duplicates that
 * spammed the SomaAdvisoryToast widget.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { enqueueAdvisory, readRecentAdvisories } from '../../src/agent/somaInitiative.js';

let TMP_HOME = '';
const USER = 'dedup-test-user';

beforeEach(() => {
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-advisory-dedup-'));
    process.env.TITAN_HOME = TMP_HOME;
    mkdirSync(join(TMP_HOME, 'users', USER), { recursive: true });
});

afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
    delete process.env.TITAN_HOME;
    delete process.env.TITAN_SOMA_DEDUP_WINDOW_MS;
    delete process.env.TITAN_SOMA_ADVISORY_RETENTION_MS;
});

function advisoryPath(): string {
    return join(TMP_HOME, 'users', USER, 'soma-advisories.jsonl');
}

function lineCount(): number {
    if (!existsSync(advisoryPath())) return 0;
    return readFileSync(advisoryPath(), 'utf-8').split('\n').filter(l => l.trim()).length;
}

describe('enqueueAdvisory — dedup', () => {
    it('skips a duplicate (same action + rationale) within the dedup window', () => {
        const now = Date.now();
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'You\'re active at weekday-17', confidence: 1.0 }, now);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'You\'re active at weekday-17', confidence: 1.0 }, now + 60_000);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'You\'re active at weekday-17', confidence: 1.0 }, now + 5 * 60_000);
        expect(lineCount()).toBe(1);
    });

    it('normalizes whitespace + capitalization + trailing punctuation for dedup', () => {
        const now = Date.now();
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'Hey there', confidence: 1.0 }, now);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'HEY  THERE.', confidence: 1.0 }, now + 60_000);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'hey there!', confidence: 1.0 }, now + 60_000);
        expect(lineCount()).toBe(1);
    });

    it('keeps separate entries for different actions even with same rationale', () => {
        const now = Date.now();
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'You\'re active', confidence: 1.0 }, now);
        enqueueAdvisory(USER, { action: 'pin-widget', rationale: 'You\'re active', confidence: 1.0 }, now + 60_000);
        expect(lineCount()).toBe(2);
    });

    it('keeps separate entries for different rationale even with same action', () => {
        const now = Date.now();
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'Briefing for weekday-17', confidence: 1.0 }, now);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'Briefing for weekday-21', confidence: 1.0 }, now + 60_000);
        expect(lineCount()).toBe(2);
    });

    it('re-files the same advisory once the dedup window has passed', () => {
        process.env.TITAN_SOMA_DEDUP_WINDOW_MS = String(1000); // 1s window for the test
        const now = Date.now();
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'X', confidence: 1.0 }, now);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'X', confidence: 1.0 }, now + 2000); // past window
        expect(lineCount()).toBe(2);
    });

    it('skips action:nothing as before (no entry written)', () => {
        enqueueAdvisory(USER, { action: 'nothing', rationale: 'fine', confidence: 0.5 });
        expect(lineCount()).toBe(0);
    });
});

describe('enqueueAdvisory — retention', () => {
    it('prunes entries older than the retention window when writing a new advisory', () => {
        process.env.TITAN_SOMA_ADVISORY_RETENTION_MS = String(60_000); // 1 minute
        const now = Date.now();
        // Seed an old entry directly
        writeFileSync(advisoryPath(), JSON.stringify({
            at: new Date(now - 5 * 60_000).toISOString(),
            action: 'add-cron',
            rationale: 'stale entry',
            confidence: 1.0,
        }) + '\n');
        expect(lineCount()).toBe(1);
        // Enqueue a fresh, different advisory — should prune the stale row
        enqueueAdvisory(USER, { action: 'pin-widget', rationale: 'new thing', confidence: 1.0 }, now);
        // Only the new entry remains
        const lines = readFileSync(advisoryPath(), 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
        expect(lines).toHaveLength(1);
        expect(lines[0].rationale).toBe('new thing');
    });

    it('still prunes when a duplicate is being skipped', () => {
        process.env.TITAN_SOMA_ADVISORY_RETENTION_MS = String(60_000);
        const now = Date.now();
        // Two pre-existing entries — one stale, one fresh
        const body =
            JSON.stringify({ at: new Date(now - 5 * 60_000).toISOString(), action: 'add-cron', rationale: 'stale', confidence: 1.0 }) + '\n' +
            JSON.stringify({ at: new Date(now - 30_000).toISOString(), action: 'add-cron', rationale: 'fresh', confidence: 1.0 }) + '\n';
        writeFileSync(advisoryPath(), body);
        expect(lineCount()).toBe(2);
        // Enqueue a duplicate of the fresh one — should skip the write
        // for the dup but still prune the stale row.
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'fresh', confidence: 1.0 }, now);
        const lines = readFileSync(advisoryPath(), 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
        expect(lines).toHaveLength(1);
        expect(lines[0].rationale).toBe('fresh');
    });
});

describe('enqueueAdvisory — integration with readRecentAdvisories', () => {
    it('readRecentAdvisories sees only the deduped + retained entries', () => {
        const now = Date.now();
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'A', confidence: 1.0 }, now);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'A', confidence: 1.0 }, now + 60_000); // dup
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'B', confidence: 1.0 }, now + 120_000);
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'C', confidence: 1.0 }, now + 180_000);
        const recent = readRecentAdvisories(USER, 10);
        expect(recent).toHaveLength(3);
        expect(recent.map(r => r.rationale)).toEqual(['C', 'B', 'A']);
    });
});

describe('enqueueAdvisory — graceful failure modes', () => {
    it('tolerates a corrupt advisory file (skips bad lines)', () => {
        writeFileSync(advisoryPath(), 'NOT_JSON\n' + JSON.stringify({ at: new Date().toISOString(), action: 'x', rationale: 'good', confidence: 1.0 }) + '\n');
        enqueueAdvisory(USER, { action: 'add-cron', rationale: 'new', confidence: 1.0 });
        const lines = readFileSync(advisoryPath(), 'utf-8').split('\n').filter(l => l.trim());
        // The corrupt row is dropped, the good row is preserved, plus the new entry
        expect(lines.length).toBeGreaterThanOrEqual(1);
        const parsed = lines.map(l => JSON.parse(l));
        expect(parsed.some(p => p.rationale === 'new')).toBe(true);
    });
});
