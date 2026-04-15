/**
 * TITAN — Data Analysis Skill Tests
 * Tests for src/skills/builtin/data_analysis.ts
 * Covers all 3 tool handlers: csv_parse, csv_stats, csv_query
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Global mocks ──────────────────────────────────────────────────

const handlers = new Map<string, any>();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
        handlers.set(handler.name, handler);
    }),
}));

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return { ...actual, readFileSync: vi.fn() };
});

// ─── Sample data ────────────────────────────────────────────────────

const SAMPLE_CSV = `name,age,city,salary
Alice,30,NYC,75000
Bob,25,LA,65000
Charlie,35,Chicago,85000
Diana,28,NYC,70000
Eve,32,LA,90000`;

const SEMICOLON_CSV = `name;age;city
Alice;30;NYC
Bob;25;LA`;

const TAB_CSV = `name\tage\tcity
Alice\t30\tNYC
Bob\t25\tLA`;

const QUOTED_CSV = `name,description,value
Alice,"Has a comma, here",100
Bob,"Simple text",200`;

const ESCAPED_QUOTES_CSV = `name,note,value
Alice,"She said ""hello""",10
Bob,"A ""quoted"" word",20`;

// ─── Setup ──────────────────────────────────────────────────────────

let readFileSyncMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    handlers.clear();

    const fs = await import('fs');
    readFileSyncMock = fs.readFileSync as ReturnType<typeof vi.fn>;
    readFileSyncMock.mockReset();
    readFileSyncMock.mockReturnValue(SAMPLE_CSV);

    const { registerSkill } = await import('../src/skills/registry.js');
    vi.mocked(registerSkill).mockClear();

    const { registerDataAnalysisSkill } = await import('../src/skills/builtin/data_analysis.js');
    registerDataAnalysisSkill();
});

// ════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════

describe('Data Analysis Skill — Registration', () => {
    it('should register all 4 tool handlers', () => {
        // Hunt Finding #41 (2026-04-15): added `data_analysis` as a top-level
        // tool so the README Tools table claim holds. Previously 3 handlers
        // (csv_parse, csv_stats, csv_query); now 4 with data_analysis wrapper.
        expect(handlers.size).toBe(4);
        expect(handlers.has('csv_parse')).toBe(true);
        expect(handlers.has('csv_stats')).toBe(true);
        expect(handlers.has('csv_query')).toBe(true);
        expect(handlers.has('data_analysis')).toBe(true);
    });

    it('should have path as a required parameter for csv_parse', () => {
        const handler = handlers.get('csv_parse');
        expect(handler.parameters.required).toContain('path');
    });

    it('should have path as a required parameter for csv_stats', () => {
        const handler = handlers.get('csv_stats');
        expect(handler.parameters.required).toContain('path');
    });

    it('should have path as a required parameter for csv_query', () => {
        const handler = handlers.get('csv_query');
        expect(handler.parameters.required).toContain('path');
    });
});

// ════════════════════════════════════════════════════════════════════
// csv_parse
// ════════════════════════════════════════════════════════════════════

describe('Data Analysis Skill — csv_parse', () => {
    it('should parse basic CSV with headers and rows', async () => {
        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/test.csv' });

        expect(result).toContain('5 rows');
        expect(result).toContain('Alice');
        expect(result).toContain('Bob');
        expect(result).toContain('Charlie');
        expect(result).toContain('Diana');
        expect(result).toContain('Eve');
        expect(result).toContain('name');
        expect(result).toContain('age');
        expect(result).toContain('city');
        expect(result).toContain('salary');
    });

    it('should parse CSV with semicolon delimiter', async () => {
        readFileSyncMock.mockReturnValue(SEMICOLON_CSV);

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/semi.csv', delimiter: ';' });

        expect(result).toContain('Alice');
        expect(result).toContain('NYC');
        expect(result).toContain('2 rows');
    });

    it('should parse CSV with tab delimiter', async () => {
        readFileSyncMock.mockReturnValue(TAB_CSV);

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/tab.csv', delimiter: '\t' });

        expect(result).toContain('Alice');
        expect(result).toContain('NYC');
    });

    it('should handle quoted fields with embedded commas', async () => {
        readFileSyncMock.mockReturnValue(QUOTED_CSV);

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/quoted.csv' });

        expect(result).toContain('Alice');
        // Quoted field should be parsed (commas inside quotes are preserved)
        expect(result).toContain('Parsed 2 rows');
    });

    it('should handle escaped quotes in fields', async () => {
        readFileSyncMock.mockReturnValue(ESCAPED_QUOTES_CSV);

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/escaped.csv' });

        expect(result).toContain('Alice');
        expect(result).toContain('Parsed 2 rows');
    });

    it('should return empty result for empty file', async () => {
        readFileSyncMock.mockReturnValue('');

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/empty.csv' });

        expect(result).toContain('0 rows');
    });

    it('should respect maxRows limit', async () => {
        readFileSyncMock.mockReturnValue(SAMPLE_CSV);

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/test.csv', maxRows: 2 });

        expect(result).toContain('showing first 2');
        // Should contain first 2 rows but the table still renders
        expect(result).toContain('Alice');
        expect(result).toContain('Bob');
    });

    it('should return error when file is not found', async () => {
        readFileSyncMock.mockImplementation(() => {
            throw new Error('ENOENT: no such file or directory');
        });

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/missing.csv' });

        expect(result).toContain('Error');
        expect(result).toContain('ENOENT');
    });

    it('should handle header-only CSV (no data rows)', async () => {
        readFileSyncMock.mockReturnValue('name,age,city');

        const handler = handlers.get('csv_parse');
        const result = await handler.execute({ path: '/data/header-only.csv' });

        expect(result).toContain('0 rows');
    });
});

// ════════════════════════════════════════════════════════════════════
// csv_stats
// ════════════════════════════════════════════════════════════════════

describe('Data Analysis Skill — csv_stats', () => {
    it('should calculate numeric stats for all columns', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv' });

        // age stats: 30, 25, 35, 28, 32
        expect(result).toContain('age');
        expect(result).toContain('Count: 5');
        expect(result).toContain('Sum:');
        expect(result).toContain('Average:');
        expect(result).toContain('Min:');
        expect(result).toContain('Max:');
        expect(result).toContain('Std Dev:');
    });

    it('should report string column stats with count and unique', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv' });

        // name column has 5 unique values, city has 3 unique values (NYC, LA, Chicago)
        expect(result).toContain('name');
        expect(result).toContain('Unique:');
    });

    it('should compute correct sum for salary column', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv', columns: 'salary' });

        // salary: 75000 + 65000 + 85000 + 70000 + 90000 = 385000
        expect(result).toContain('385000');
    });

    it('should compute correct average for age column', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv', columns: 'age' });

        // age: (30 + 25 + 35 + 28 + 32) / 5 = 30
        expect(result).toContain('Average: 30');
    });

    it('should compute correct min and max for age column', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv', columns: 'age' });

        expect(result).toContain('Min: 25');
        expect(result).toContain('Max: 35');
    });

    it('should handle specific column selection', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv', columns: 'salary' });

        expect(result).toContain('salary');
        // Should not include unselected columns in a dedicated stats section
        // (name, city will not appear as stats headers since we only selected salary)
    });

    it('should skip columns not in headers', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv', columns: 'nonexistent' });

        // No stats should be produced for a column not in the CSV
        expect(result).toContain('Column Statistics');
    });

    it('should handle mixed numeric and string data', async () => {
        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/test.csv' });

        // city column is strings -> should show count and unique
        expect(result).toContain('city');
        // age column is numbers -> should show sum, avg, etc.
        expect(result).toContain('age');
    });

    it('should return error when file is not found', async () => {
        readFileSyncMock.mockImplementation(() => {
            throw new Error('ENOENT: no such file or directory');
        });

        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/missing.csv' });

        expect(result).toContain('Error');
    });

    it('should use custom delimiter for stats', async () => {
        readFileSyncMock.mockReturnValue(SEMICOLON_CSV);

        const handler = handlers.get('csv_stats');
        const result = await handler.execute({ path: '/data/semi.csv', delimiter: ';' });

        expect(result).toContain('age');
        expect(result).toContain('Count: 2');
    });
});

// ════════════════════════════════════════════════════════════════════
// csv_query
// ════════════════════════════════════════════════════════════════════

describe('Data Analysis Skill — csv_query', () => {
    it('should filter with > operator', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', filter: 'age > 30' });

        // Charlie(35), Eve(32) match age > 30
        expect(result).toContain('Charlie');
        expect(result).toContain('Eve');
        expect(result).not.toContain('Bob');
    });

    it('should filter with == operator', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', filter: 'city == NYC' });

        expect(result).toContain('Alice');
        expect(result).toContain('Diana');
        expect(result).not.toContain('Charlie');
    });

    it('should filter with contains operator', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', filter: 'name contains ali' });

        // case-insensitive contains
        expect(result).toContain('Alice');
    });

    it('should sort by numeric column', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', sort: 'age' });

        // Sorted by age ascending: Bob(25), Diana(28), Alice(30), Eve(32), Charlie(35)
        const bobIdx = result.indexOf('Bob');
        const charlieIdx = result.indexOf('Charlie');
        expect(bobIdx).toBeLessThan(charlieIdx);
    });

    it('should sort by string column', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', sort: 'name' });

        // Sorted alphabetically: Alice, Bob, Charlie, Diana, Eve
        const aliceIdx = result.indexOf('Alice');
        const eveIdx = result.indexOf('Eve');
        expect(aliceIdx).toBeLessThan(eveIdx);
    });

    it('should select specific columns', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', columns: 'name,city' });

        expect(result).toContain('name');
        expect(result).toContain('city');
        expect(result).toContain('Alice');
    });

    it('should respect limit parameter', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', limit: 2 });

        expect(result).toContain('displaying first 2');
    });

    it('should return all rows when no filter is specified', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv' });

        expect(result).toContain('5 rows');
        expect(result).toContain('Alice');
        expect(result).toContain('Eve');
    });

    it('should return error when file cannot be read', async () => {
        readFileSyncMock.mockImplementation(() => {
            throw new Error('Permission denied');
        });

        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/noperm.csv' });

        expect(result).toContain('Error');
        expect(result).toContain('Permission denied');
    });

    it('should combine filter and sort', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({ path: '/data/test.csv', filter: 'salary > 70000', sort: 'salary' });

        // Matching: Alice(75000), Charlie(85000), Eve(90000) — sorted ascending
        const aliceIdx = result.indexOf('Alice');
        const eveIdx = result.indexOf('Eve');
        expect(aliceIdx).toBeLessThan(eveIdx);
        expect(result).not.toContain('Bob');
    });

    it('should handle filter and column selection together', async () => {
        const handler = handlers.get('csv_query');
        const result = await handler.execute({
            path: '/data/test.csv',
            filter: 'city == LA',
            columns: 'name,salary',
        });

        expect(result).toContain('Bob');
        expect(result).toContain('Eve');
    });

    it('should use custom delimiter for query', async () => {
        readFileSyncMock.mockReturnValue(SEMICOLON_CSV);

        const handler = handlers.get('csv_query');
        const result = await handler.execute({
            path: '/data/semi.csv',
            delimiter: ';',
            filter: 'age > 26',
        });

        expect(result).toContain('Alice');
        expect(result).not.toContain('Bob');
    });
});
