/**
 * TITAN — Lead Scorer Skill Tests
 * Tests for src/skills/builtin/lead_scorer.ts
 * Covers all 4 tool handlers: lead_scan, lead_score, lead_queue, lead_report
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Global mocks ──────────────────────────────────────────────────

const handlers = new Map<string, any>();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
        handlers.set(handler.name, handler);
    }),
}));

vi.mock('../src/utils/constants.js', () => ({
    LEADS_PATH: '/tmp/titan-test-leads.jsonl',
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

let mockFiles: Record<string, string> = {};
const LEADS_PATH = '/tmp/titan-test-leads.jsonl';

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

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(async () => {
    handlers.clear();
    mockFiles = {};
    mockFetch.mockReset();

    const { registerSkill } = await import('../src/skills/registry.js');
    vi.mocked(registerSkill).mockClear();

    const { registerLeadScorerSkill } = await import('../src/skills/builtin/lead_scorer.js');
    registerLeadScorerSkill();
});

// ════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════

describe('Lead Scorer Skill — Registration', () => {
    it('should register all 4 tool handlers', () => {
        expect(handlers.size).toBe(4);
        expect(handlers.has('lead_scan')).toBe(true);
        expect(handlers.has('lead_score')).toBe(true);
        expect(handlers.has('lead_queue')).toBe(true);
        expect(handlers.has('lead_report')).toBe(true);
    });

    it('should have query as required for lead_scan', () => {
        const handler = handlers.get('lead_scan');
        expect(handler.parameters.required).toContain('query');
    });
});

// ════════════════════════════════════════════════════════════════════
// lead_scan
// ════════════════════════════════════════════════════════════════════

describe('Lead Scorer — lead_scan', () => {
    it('should scan and return scored results', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => `
                <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freddit.com%2Fr%2Ftest%2F1">Looking for AI automation developer</a>
                <a class="result__snippet">Need help with building an automation bot, willing to pay budget $5000</a>
            `,
        });

        const handler = handlers.get('lead_scan');
        const result = await handler.execute({ query: 'AI automation', platform: 'reddit' });

        expect(result).toContain('Lead Scan Results');
        expect(result).toContain('Score:');
    });

    it('should handle no results', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => '<html></html>',
        });

        const handler = handlers.get('lead_scan');
        const result = await handler.execute({ query: 'xyznonexistent' });

        expect(result).toContain('No leads found');
    });
});

// ════════════════════════════════════════════════════════════════════
// lead_score
// ════════════════════════════════════════════════════════════════════

describe('Lead Scorer — lead_score', () => {
    it('should score a high-intent lead', async () => {
        const handler = handlers.get('lead_score');
        const result = await handler.execute({
            title: 'Looking for automation developer',
            content: 'Need help with building a bot. Budget is $5000. Need someone ASAP.',
            daysOld: 1,
        });

        expect(result).toContain('Lead Score:');
        expect(result).toContain('/10');
        expect(result).toContain('looking for');
    });

    it('should score a low-intent lead', async () => {
        const handler = handlers.get('lead_score');
        const result = await handler.execute({
            title: 'General discussion about AI',
            content: 'What do you think about the latest AI developments?',
            daysOld: 30,
        });

        expect(result).toContain('Lead Score:');
        expect(result).toContain('LOW');
    });

    it('should detect multiple intent signals', async () => {
        const handler = handlers.get('lead_score');
        const result = await handler.execute({
            title: 'Looking for a freelancer',
            content: 'Need help with automation. Anyone know a good contractor? Willing to pay well.',
            daysOld: 1,
        });

        expect(result).toContain('looking for');
    });
});

// ════════════════════════════════════════════════════════════════════
// lead_queue
// ════════════════════════════════════════════════════════════════════

describe('Lead Scorer — lead_queue', () => {
    it('should add a lead to the queue', async () => {
        const handler = handlers.get('lead_queue');
        const result = await handler.execute({
            action: 'add',
            platform: 'reddit',
            title: 'Need automation help',
            url: 'https://reddit.com/r/test/1',
            score: 8,
        });

        expect(result).toContain('Lead saved');
        expect(result).toContain('Need automation help');
    });

    it('should list empty queue', async () => {
        const handler = handlers.get('lead_queue');
        const result = await handler.execute({ action: 'list' });

        expect(result).toContain('No leads in queue');
    });

    it('should list existing leads', async () => {
        const leads = [
            { id: 'lead-1', timestamp: new Date().toISOString(), platform: 'reddit', title: 'Test Lead', url: '', snippet: '', score: 7, signals: [], status: 'new', notes: '' },
        ];
        mockFiles[LEADS_PATH] = leads.map(l => JSON.stringify(l)).join('\n') + '\n';

        const handler = handlers.get('lead_queue');
        const result = await handler.execute({ action: 'list' });

        expect(result).toContain('Test Lead');
        expect(result).toContain('reddit');
    });

    it('should update lead status', async () => {
        const leads = [
            { id: 'lead-1', timestamp: new Date().toISOString(), platform: 'reddit', title: 'Test Lead', url: '', snippet: '', score: 7, signals: [], status: 'new', notes: '' },
        ];
        mockFiles[LEADS_PATH] = leads.map(l => JSON.stringify(l)).join('\n') + '\n';

        const handler = handlers.get('lead_queue');
        const result = await handler.execute({
            action: 'update',
            id: 'lead-1',
            status: 'contacted',
        });

        expect(result).toContain('Lead updated');
        expect(result).toContain('contacted');
    });

    it('should require id for update', async () => {
        const handler = handlers.get('lead_queue');
        const result = await handler.execute({ action: 'update' });

        expect(result).toContain('Error');
    });
});

// ════════════════════════════════════════════════════════════════════
// lead_report
// ════════════════════════════════════════════════════════════════════

describe('Lead Scorer — lead_report', () => {
    it('should return empty message when no leads', async () => {
        const handler = handlers.get('lead_report');
        const result = await handler.execute({});

        expect(result).toContain('No leads to report');
    });

    it('should generate report with existing leads', async () => {
        const now = new Date();
        const leads = [
            { id: 'lead-1', timestamp: now.toISOString(), platform: 'reddit', title: 'Lead 1', url: '', snippet: '', score: 8, signals: ['looking for'], status: 'new', notes: '' },
            { id: 'lead-2', timestamp: now.toISOString(), platform: 'hackernews', title: 'Lead 2', url: '', snippet: '', score: 5, signals: [], status: 'contacted', notes: '' },
        ];
        mockFiles[LEADS_PATH] = leads.map(l => JSON.stringify(l)).join('\n') + '\n';

        const handler = handlers.get('lead_report');
        const result = await handler.execute({ period: 'week' });

        expect(result).toContain('Lead Report');
        expect(result).toContain('Total Leads: 2');
        expect(result).toContain('By Status');
        expect(result).toContain('By Platform');
    });

    it('should highlight high priority leads', async () => {
        const now = new Date();
        const leads = [
            { id: 'lead-1', timestamp: now.toISOString(), platform: 'reddit', title: 'Hot Lead', url: 'https://example.com', snippet: '', score: 9, signals: ['looking for', 'budget'], status: 'new', notes: '' },
        ];
        mockFiles[LEADS_PATH] = leads.map(l => JSON.stringify(l)).join('\n') + '\n';

        const handler = handlers.get('lead_report');
        const result = await handler.execute({ period: 'all' });

        expect(result).toContain('High Priority');
        expect(result).toContain('Hot Lead');
    });
});
