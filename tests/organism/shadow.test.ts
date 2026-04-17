/**
 * Shadow rehearsal tests — JSON parsing robustness + fallback path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/providers/router.js', () => ({ chat: mockChat }));
vi.mock('../../src/config/config.js', () => ({ loadConfig: mockLoadConfig }));

const defaultConfig = {
    agent: {
        model: 'openai/gpt-4o-mini',
        modelAliases: { fast: 'openai/gpt-4o-mini', smart: 'anthropic/claude' },
    },
};

import { rehearseShadow } from '../../src/organism/shadow.js';

describe('shadow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadConfig.mockReturnValue(defaultConfig);
    });

    it('parses clean JSON verdict', async () => {
        mockChat.mockResolvedValue({
            content: JSON.stringify({
                reversibilityScore: 0.8,
                estimatedCostUsd: 0.12,
                breakRisks: ['could overwrite X'],
                affectedSystems: ['filesystem'],
            }),
        });
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.fallback).toBe(false);
        expect(v.reversibilityScore).toBe(0.8);
        expect(v.estimatedCostUsd).toBe(0.12);
        expect(v.breakRisks).toEqual(['could overwrite X']);
    });

    it('tolerates code fences', async () => {
        mockChat.mockResolvedValue({
            content: '```json\n{"reversibilityScore":0.5,"estimatedCostUsd":1,"breakRisks":["x"],"affectedSystems":["git"]}\n```',
        });
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.fallback).toBe(false);
        expect(v.affectedSystems).toEqual(['git']);
    });

    it('extracts JSON from surrounding prose', async () => {
        mockChat.mockResolvedValue({
            content: 'Here is the analysis:\n\n{"reversibilityScore": 0.3, "estimatedCostUsd": 2, "breakRisks": ["y"], "affectedSystems": []}\n\nlet me know if you need more.',
        });
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.fallback).toBe(false);
        expect(v.reversibilityScore).toBe(0.3);
    });

    it('falls back when LLM returns non-JSON', async () => {
        mockChat.mockResolvedValue({ content: "I cannot predict this action's outcome." });
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.fallback).toBe(true);
        expect(v.breakRisks[0]).toContain('shadow rehearsal unavailable');
    });

    it('falls back when LLM throws', async () => {
        mockChat.mockRejectedValue(new Error('provider down'));
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.fallback).toBe(true);
    });

    it('clamps reversibilityScore to [0,1]', async () => {
        mockChat.mockResolvedValue({
            content: JSON.stringify({
                reversibilityScore: 1.8, estimatedCostUsd: -5,
                breakRisks: [], affectedSystems: [],
            }),
        });
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.reversibilityScore).toBeLessThanOrEqual(1);
        expect(v.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    });

    it('skips when proposal missing title/description', async () => {
        const v = await rehearseShadow({ title: '', description: 'd', rationale: 'r' });
        expect(v.fallback).toBe(true);
        expect(mockChat).not.toHaveBeenCalled();
    });

    it('falls back when score or cost are NaN', async () => {
        mockChat.mockResolvedValue({
            content: JSON.stringify({
                reversibilityScore: 'not a number',
                estimatedCostUsd: 'also not',
                breakRisks: [], affectedSystems: [],
            }),
        });
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.fallback).toBe(true);
    });

    it('defaults breakRisks when empty', async () => {
        mockChat.mockResolvedValue({
            content: JSON.stringify({
                reversibilityScore: 0.6, estimatedCostUsd: 0.1,
                breakRisks: [], affectedSystems: [],
            }),
        });
        const v = await rehearseShadow({ title: 't', description: 'd', rationale: 'r' });
        expect(v.breakRisks.length).toBeGreaterThan(0);
    });
});
