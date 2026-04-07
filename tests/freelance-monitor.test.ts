/**
 * TITAN — Freelance Monitor Skill Tests
 * Tests for src/skills/builtin/freelance_monitor.ts
 * Covers all 4 tool handlers: freelance_search, freelance_match, freelance_draft, freelance_track
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
    FREELANCE_LEADS_PATH: '/tmp/titan-test-freelance-leads.jsonl',
    FREELANCE_PROFILE_PATH: '/tmp/titan-test-freelance-profile.json',
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

let mockFiles: Record<string, string> = {};
const LEADS_PATH = '/tmp/titan-test-freelance-leads.jsonl';
const PROFILE_PATH = '/tmp/titan-test-freelance-profile.json';

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

    const { registerFreelanceMonitorSkill } = await import('../src/skills/builtin/freelance_monitor.js');
    registerFreelanceMonitorSkill();
});

// ════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════

describe('Freelance Monitor Skill — Registration', () => {
    it('should register all 4 tool handlers', () => {
        expect(handlers.size).toBe(4);
        expect(handlers.has('freelance_search')).toBe(true);
        expect(handlers.has('freelance_match')).toBe(true);
        expect(handlers.has('freelance_draft')).toBe(true);
        expect(handlers.has('freelance_track')).toBe(true);
    });

    it('should have query as required parameter for freelance_search', () => {
        const handler = handlers.get('freelance_search');
        expect(handler.parameters.required).toContain('query');
    });
});

// ════════════════════════════════════════════════════════════════════
// freelance_search
// ════════════════════════════════════════════════════════════════════

describe('Freelance Monitor — freelance_search', () => {
    it('should search and return results', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => `
                <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fupwork.com%2Fjob%2F123">Node.js Developer Needed</a>
                <a class="result__snippet">Looking for experienced Node.js developer for API work</a>
            `,
        });

        const handler = handlers.get('freelance_search');
        const result = await handler.execute({ query: 'node.js developer', platform: 'upwork' });

        expect(result).toContain('Node.js Developer');
    });

    it('should handle search failure gracefully', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 503 });

        const handler = handlers.get('freelance_search');
        const result = await handler.execute({ query: 'test', platform: 'upwork' });

        expect(result).toContain('503');
    });

    it('should handle no results', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            text: async () => '<html><body>No results</body></html>',
        });

        const handler = handlers.get('freelance_search');
        const result = await handler.execute({ query: 'xyznonexistent', platform: 'upwork' });

        expect(result).toContain('No results');
    });
});

// ════════════════════════════════════════════════════════════════════
// freelance_match
// ════════════════════════════════════════════════════════════════════

describe('Freelance Monitor — freelance_match', () => {
    it('should return error when no profile exists', async () => {
        const handler = handlers.get('freelance_match');
        const result = await handler.execute({
            title: 'Node.js API Dev',
            description: 'Build a REST API',
        });

        expect(result).toContain('No freelance profile');
    });

    it('should score job against profile', async () => {
        mockFiles[PROFILE_PATH] = JSON.stringify({
            name: 'Tony',
            title: 'Full Stack Developer',
            skills: ['Node.js', 'TypeScript', 'React', 'Python', 'API Development'],
            hourlyRate: 100,
            bio: 'Experienced developer',
            experience: ['Built enterprise APIs'],
            portfolio: [],
        });

        const handler = handlers.get('freelance_match');
        const result = await handler.execute({
            title: 'Node.js API Development',
            description: 'Need a TypeScript developer to build REST API with Node.js',
            requiredSkills: 'Node.js,TypeScript,API Development',
        });

        expect(result).toContain('Match Score:');
        expect(result).toContain('/10');
        expect(result).toContain('Matched Skills');
    });

    it('should detect weak matches', async () => {
        mockFiles[PROFILE_PATH] = JSON.stringify({
            name: 'Tony',
            title: 'Developer',
            skills: ['Python'],
            hourlyRate: 50,
            bio: '',
            experience: [],
            portfolio: [],
        });

        const handler = handlers.get('freelance_match');
        const result = await handler.execute({
            title: 'Java Spring Boot Expert',
            description: 'Need Java developer with Spring Boot experience',
            requiredSkills: 'Java,Spring Boot,Kubernetes',
        });

        expect(result).toContain('Missing Skills');
    });
});

// ════════════════════════════════════════════════════════════════════
// freelance_draft
// ════════════════════════════════════════════════════════════════════

describe('Freelance Monitor — freelance_draft', () => {
    it('should generate proposal outline', async () => {
        const handler = handlers.get('freelance_draft');
        const result = await handler.execute({
            title: 'Build a REST API',
            description: 'Need Node.js API for SaaS product',
        });

        expect(result).toContain('PROPOSAL OUTLINE');
        expect(result).toContain('OPENING HOOK');
        expect(result).toContain('RELEVANT EXPERIENCE');
        expect(result).toContain('PROPOSED APPROACH');
    });

    it('should include profile info when available', async () => {
        mockFiles[PROFILE_PATH] = JSON.stringify({
            name: 'Tony',
            title: 'Full Stack Developer',
            skills: ['Node.js', 'TypeScript'],
            hourlyRate: 100,
            bio: '',
            experience: ['Built enterprise APIs'],
            portfolio: [],
        });

        const handler = handlers.get('freelance_draft');
        const result = await handler.execute({ title: 'API Project' });

        expect(result).toContain('Full Stack Developer');
        expect(result).toContain('$100/hr');
    });
});

// ════════════════════════════════════════════════════════════════════
// freelance_track
// ════════════════════════════════════════════════════════════════════

describe('Freelance Monitor — freelance_track', () => {
    it('should add a new lead', async () => {
        const handler = handlers.get('freelance_track');
        const result = await handler.execute({
            action: 'add',
            platform: 'upwork',
            title: 'Node.js API Project',
            url: 'https://upwork.com/job/123',
            budget: '$1000-2000',
            skills: 'Node.js,TypeScript',
            matchScore: 8,
        });

        expect(result).toContain('Lead saved');
        expect(result).toContain('Node.js API Project');
    });

    it('should list leads when empty', async () => {
        const handler = handlers.get('freelance_track');
        const result = await handler.execute({ action: 'list' });

        expect(result).toContain('No leads tracked');
    });

    it('should list existing leads', async () => {
        const leads = [
            { id: 'lead-1', timestamp: new Date().toISOString(), platform: 'upwork', title: 'Test Job', url: '', budget: '$500', skills: ['Node.js'], matchScore: 7, status: 'new', notes: '' },
        ];
        mockFiles[LEADS_PATH] = leads.map(l => JSON.stringify(l)).join('\n') + '\n';

        const handler = handlers.get('freelance_track');
        const result = await handler.execute({ action: 'list' });

        expect(result).toContain('Test Job');
        expect(result).toContain('upwork');
    });

    it('should update lead status', async () => {
        const leads = [
            { id: 'lead-1', timestamp: new Date().toISOString(), platform: 'upwork', title: 'Test Job', url: '', budget: '$500', skills: ['Node.js'], matchScore: 7, status: 'new', notes: '' },
        ];
        mockFiles[LEADS_PATH] = leads.map(l => JSON.stringify(l)).join('\n') + '\n';

        const handler = handlers.get('freelance_track');
        const result = await handler.execute({
            action: 'update',
            id: 'lead-1',
            status: 'applied',
        });

        expect(result).toContain('Lead updated');
        expect(result).toContain('applied');
    });

    it('should require id for update', async () => {
        const handler = handlers.get('freelance_track');
        const result = await handler.execute({ action: 'update' });

        expect(result).toContain('Error');
    });
});
