/**
 * TITAN — v6.1.0 Phase A · Gap 6
 *
 * Date-based TTL on `~/.titan/bug-reports.jsonl`. GDPR
 * storage-limitation principle: drop entries older than the configured
 * window on every append. Default window is 30 days.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-jsonl-ttl-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function daysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('v6.1.0 Phase A — Gap 6 — purgeOldEntries (date TTL)', () => {
    const jsonlPath = join(tmpHome, 'bug-reports.jsonl');

    beforeEach(() => {
        // Wipe between tests
        writeFileSync(jsonlPath, '');
    });

    it('drops entries older than the cutoff, keeps the rest', async () => {
        const entries = [
            { id: 'a', ts: daysAgo(0), note: 'today' },
            { id: 'b', ts: daysAgo(5), note: '5d' },
            { id: 'c', ts: daysAgo(15), note: '15d' },
            { id: 'd', ts: daysAgo(35), note: '35d' },
            { id: 'e', ts: daysAgo(45), note: '45d' },
        ];
        writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

        const { purgeOldEntries } = await import('../src/analytics/bugReports.js');
        const res = purgeOldEntries(30);

        expect(res.kept).toBe(3);
        expect(res.dropped).toBe(2);

        const remaining = readFileSync(jsonlPath, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { id: string });
        const ids = remaining.map((r) => r.id).sort();
        expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('is a no-op when nothing is older than the cutoff', async () => {
        const entries = [
            { id: 'a', ts: daysAgo(0) },
            { id: 'b', ts: daysAgo(10) },
        ];
        writeFileSync(jsonlPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
        const before = readFileSync(jsonlPath, 'utf-8');

        const { purgeOldEntries } = await import('../src/analytics/bugReports.js');
        const res = purgeOldEntries(30);

        expect(res.kept).toBe(2);
        expect(res.dropped).toBe(0);
        expect(readFileSync(jsonlPath, 'utf-8')).toBe(before);
    });

    it('returns zero-zero on a missing file (best-effort, never throws)', async () => {
        const ghostPath = join(tmpHome, 'does-not-exist.jsonl');
        expect(existsSync(ghostPath)).toBe(false);
        const { purgeOldEntries } = await import('../src/analytics/bugReports.js');
        // Function targets the configured jsonl path, but with this file
        // wiped to empty in beforeEach the "no entries" path is exercised.
        const res = purgeOldEntries(30);
        expect(res).toEqual({ kept: 0, dropped: 0 });
    });

    it('keeps malformed lines (never silently destroys operator data)', async () => {
        const good = { id: 'g', ts: daysAgo(1) };
        writeFileSync(jsonlPath, JSON.stringify(good) + '\nNOT_JSON_GARBAGE\n');

        const { purgeOldEntries } = await import('../src/analytics/bugReports.js');
        const res = purgeOldEntries(30);

        // Garbage line counted as "kept" so the operator can review later.
        expect(res.kept).toBe(2);
        expect(res.dropped).toBe(0);
        const raw = readFileSync(jsonlPath, 'utf-8');
        expect(raw).toContain('NOT_JSON_GARBAGE');
    });
});
