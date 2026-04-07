/**
 * TITAN — Income Tracker Skill Tests
 * Tests for src/skills/builtin/income_tracker.ts
 * Covers all 4 tool handlers: income_log, income_summary, income_list, income_goal
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Global mocks ──────────────────────────────────────────────────

const handlers = new Map<string, any>();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
        handlers.set(handler.name, handler);
    }),
}));

let mockFiles: Record<string, string> = {};
const LEDGER_PATH = '/tmp/titan-test-income-ledger.jsonl';
const GOALS_PATH = '/tmp/titan-test-income-ledger-goals.json';

vi.mock('../src/utils/constants.js', () => ({
    INCOME_LEDGER_PATH: '/tmp/titan-test-income-ledger.jsonl',
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: vi.fn().mockImplementation((path: string) => path in mockFiles),
        readFileSync: vi.fn().mockImplementation((path: string) => mockFiles[path] || ''),
        appendFileSync: vi.fn().mockImplementation((path: string, data: string) => {
            mockFiles[path] = (mockFiles[path] || '') + data;
        }),
        writeFileSync: vi.fn().mockImplementation((path: string, data: string) => {
            mockFiles[path] = data;
        }),
        mkdirSync: vi.fn(),
    };
});

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(async () => {
    handlers.clear();
    mockFiles = {};

    const { registerSkill } = await import('../src/skills/registry.js');
    vi.mocked(registerSkill).mockClear();

    const { registerIncomeTrackerSkill } = await import('../src/skills/builtin/income_tracker.js');
    registerIncomeTrackerSkill();
});

// ════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════

describe('Income Tracker Skill — Registration', () => {
    it('should register all 4 tool handlers', () => {
        expect(handlers.size).toBe(4);
        expect(handlers.has('income_log')).toBe(true);
        expect(handlers.has('income_summary')).toBe(true);
        expect(handlers.has('income_list')).toBe(true);
        expect(handlers.has('income_goal')).toBe(true);
    });

    it('should have required parameters for income_log', () => {
        const handler = handlers.get('income_log');
        expect(handler.parameters.required).toContain('type');
        expect(handler.parameters.required).toContain('amount');
        expect(handler.parameters.required).toContain('source');
    });
});

// ════════════════════════════════════════════════════════════════════
// income_log
// ════════════════════════════════════════════════════════════════════

describe('Income Tracker — income_log', () => {
    it('should log an income entry', async () => {
        const handler = handlers.get('income_log');
        const result = await handler.execute({
            type: 'income',
            amount: 500,
            source: 'Upwork',
            category: 'freelance',
            description: 'Web scraping project',
        });

        expect(result).toContain('Logged income');
        expect(result).toContain('$500.00');
        expect(result).toContain('Upwork');
    });

    it('should log an expense entry', async () => {
        const handler = handlers.get('income_log');
        const result = await handler.execute({
            type: 'expense',
            amount: 29.99,
            source: 'AWS',
            category: 'hosting',
        });

        expect(result).toContain('Logged expense');
        expect(result).toContain('$29.99');
    });

    it('should reject invalid type', async () => {
        const handler = handlers.get('income_log');
        const result = await handler.execute({
            type: 'invalid',
            amount: 100,
            source: 'test',
        });

        expect(result).toContain('Error');
    });

    it('should use absolute value for negative amounts', async () => {
        const handler = handlers.get('income_log');
        const result = await handler.execute({
            type: 'income',
            amount: -100,
            source: 'test',
        });

        expect(result).toContain('$100.00');
    });
});

// ════════════════════════════════════════════════════════════════════
// income_summary
// ════════════════════════════════════════════════════════════════════

describe('Income Tracker — income_summary', () => {
    it('should return empty message for no entries', async () => {
        const handler = handlers.get('income_summary');
        const result = await handler.execute({});

        expect(result).toContain('No entries');
    });

    it('should summarize entries by period', async () => {
        const now = new Date();
        const entries = [
            { id: '1', timestamp: now.toISOString(), type: 'income', amount: 500, source: 'Upwork', category: 'freelance', description: '' },
            { id: '2', timestamp: now.toISOString(), type: 'income', amount: 300, source: 'Fiverr', category: 'freelance', description: '' },
            { id: '3', timestamp: now.toISOString(), type: 'expense', amount: 50, source: 'AWS', category: 'hosting', description: '' },
        ];
        mockFiles[LEDGER_PATH] = entries.map(e => JSON.stringify(e)).join('\n') + '\n';

        const handler = handlers.get('income_summary');
        const result = await handler.execute({ period: 'month' });

        expect(result).toContain('Income Summary');
        expect(result).toContain('$800.00');
        expect(result).toContain('$50.00');
        expect(result).toContain('$750.00');
    });
});

// ════════════════════════════════════════════════════════════════════
// income_list
// ════════════════════════════════════════════════════════════════════

describe('Income Tracker — income_list', () => {
    it('should return empty message when no entries', async () => {
        const handler = handlers.get('income_list');
        const result = await handler.execute({});

        expect(result).toContain('No entries');
    });

    it('should list recent entries', async () => {
        const entries = [
            { id: '1', timestamp: new Date().toISOString(), type: 'income', amount: 500, source: 'Upwork', category: 'freelance', description: 'Project A' },
        ];
        mockFiles[LEDGER_PATH] = entries.map(e => JSON.stringify(e)).join('\n') + '\n';

        const handler = handlers.get('income_list');
        const result = await handler.execute({ limit: 10 });

        expect(result).toContain('Upwork');
        expect(result).toContain('$500.00');
    });

    it('should filter by type', async () => {
        const entries = [
            { id: '1', timestamp: new Date().toISOString(), type: 'income', amount: 500, source: 'Upwork', category: 'freelance', description: '' },
            { id: '2', timestamp: new Date().toISOString(), type: 'expense', amount: 30, source: 'AWS', category: 'hosting', description: '' },
        ];
        mockFiles[LEDGER_PATH] = entries.map(e => JSON.stringify(e)).join('\n') + '\n';

        const handler = handlers.get('income_list');
        const result = await handler.execute({ type: 'expense' });

        expect(result).toContain('AWS');
        expect(result).not.toContain('Upwork');
    });
});

// ════════════════════════════════════════════════════════════════════
// income_goal
// ════════════════════════════════════════════════════════════════════

describe('Income Tracker — income_goal', () => {
    it('should set a monthly goal', async () => {
        const handler = handlers.get('income_goal');
        const result = await handler.execute({
            action: 'set',
            target: 5000,
        });

        expect(result).toContain('Goal set');
        expect(result).toContain('$5000.00');
    });

    it('should reject invalid target', async () => {
        const handler = handlers.get('income_goal');
        const result = await handler.execute({
            action: 'set',
            target: -100,
        });

        expect(result).toContain('Error');
    });

    it('should check progress with no goal set', async () => {
        const handler = handlers.get('income_goal');
        const result = await handler.execute({ action: 'check' });

        expect(result).toContain('No goal set');
    });
});
