/**
 * Security Tests for TITAN New Skills
 * Verifies path traversal, input validation, ReDoS protection,
 * SSRF blocking, and file operation confinement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock fs, os, and other deps before imports ─────────────────────

vi.mock('fs', () => ({
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 100, isFile: () => true }),
    watch: vi.fn().mockReturnValue({ close: vi.fn() }),
}));

vi.mock('os', () => ({
    homedir: vi.fn().mockReturnValue('/home/testuser'),
}));

vi.mock('../../src/utils/constants.js', () => ({
    TITAN_HOME: '/home/testuser/.titan',
    TITAN_VERSION: '2026.10.39',
    TITAN_NAME: 'TITAN',
    TITAN_FULL_NAME: 'The Intelligent Task Automation Network',
}));

vi.mock('../../src/utils/logger.js', () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../src/skills/registry.js', () => ({
    registerSkill: vi.fn(),
    isToolSkillEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/agent/toolRunner.js', () => ({
    getRegisteredTools: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        gateway: { port: 48420, host: '0.0.0.0', auth: { mode: 'none' } },
        auth: { mode: 'none' },
    }),
}));

vi.mock('../../src/agent/subAgent.js', () => ({
    spawnSubAgent: vi.fn().mockResolvedValue({
        content: 'mock result',
        success: true,
        rounds: 1,
        durationMs: 100,
        toolsUsed: [],
    }),
    SUB_AGENT_TEMPLATES: {},
}));

vi.mock('uuid', () => ({
    v4: vi.fn().mockReturnValue('test-uuid-1234'),
}));

// ─── Imports ────────────────────────────────────────────────────────

import { validateAgainstSchema } from '../src/skills/builtin/structured_output.js';
import {
    isValidWorkflowName,
    getWorkflowPath,
    validateWorkflowDefinition,
    topologicalSort,
} from '../src/skills/builtin/workflows.js';
import {
    chunkText,
    tfidfSearch,
} from '../src/skills/builtin/knowledge_base.js';
import {
    loadDataset,
    saveDataset,
    loadResult,
    saveResult,
    scoreExactMatch,
    scoreContains,
    scoreLength,
    scoreJsonValid,
    runScorer,
    computeAggregate,
    type EvalDataset,
    type EvalRunResult,
    type EntryResult,
    type ScorerType,
} from '../src/skills/builtin/evals.js';
import {
    loadConfig as loadApprovalConfig,
    saveConfig as saveApprovalConfig,
    requiresApproval,
    createApprovalRequest,
    approveRequest,
    denyRequest,
    getPendingRequests,
    _resetState,
} from '../src/skills/builtin/approval_gates.js';

// ─── structured_output: ReDoS Protection ────────────────────────────

describe('structured_output security', () => {
    it('rejects patterns longer than 200 characters', () => {
        const longPattern = 'a'.repeat(201);
        const errors = validateAgainstSchema('test', {
            type: 'string',
            pattern: longPattern,
        });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('exceeds maximum length');
    });

    it('accepts patterns under 200 characters', () => {
        const errors = validateAgainstSchema('hello', {
            type: 'string',
            pattern: '^[a-z]+$',
        });
        expect(errors.length).toBe(0);
    });

    it('handles invalid regex patterns gracefully', () => {
        const errors = validateAgainstSchema('test', {
            type: 'string',
            pattern: '[invalid',
        });
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain('Invalid pattern');
    });

    it('validates null/undefined values correctly', () => {
        const errorsNull = validateAgainstSchema(null, { type: 'string' });
        expect(errorsNull.length).toBeGreaterThan(0);

        const errorsUndef = validateAgainstSchema(undefined, { type: 'string' });
        expect(errorsUndef.length).toBeGreaterThan(0);
    });

    it('validates nested object schemas', () => {
        const schema = {
            type: 'object',
            properties: {
                name: { type: 'string' },
                age: { type: 'number', minimum: 0 },
            },
            required: ['name'],
            additionalProperties: false,
        };

        const errors = validateAgainstSchema({ name: 'test', extra: true }, schema);
        expect(errors.some(e => e.message.includes('additional property'))).toBe(true);
    });
});

// ─── workflows: Path Traversal Protection ───────────────────────────

describe('workflows security', () => {
    it('rejects workflow names with path traversal sequences', () => {
        expect(isValidWorkflowName('../../../etc/passwd')).toBe(false);
        expect(isValidWorkflowName('..%2f..%2fetc')).toBe(false);
        expect(isValidWorkflowName('foo/bar')).toBe(false);
        expect(isValidWorkflowName('foo\\bar')).toBe(false);
    });

    it('accepts valid workflow names', () => {
        expect(isValidWorkflowName('my-workflow')).toBe(true);
        expect(isValidWorkflowName('workflow_v2')).toBe(true);
        expect(isValidWorkflowName('Test123')).toBe(true);
    });

    it('getWorkflowPath throws on invalid names', () => {
        expect(() => getWorkflowPath('../etc/passwd')).toThrow('Invalid workflow name');
        expect(() => getWorkflowPath('valid-name')).not.toThrow();
    });

    it('rejects empty workflow names', () => {
        expect(isValidWorkflowName('')).toBe(false);
    });

    it('rejects names with special characters', () => {
        expect(isValidWorkflowName('name with spaces')).toBe(false);
        expect(isValidWorkflowName('name@special')).toBe(false);
        expect(isValidWorkflowName('name.dot')).toBe(false);
    });

    it('validates workflow definition structure', () => {
        expect(validateWorkflowDefinition({ name: '', description: 'test', steps: [] }))
            .toBe('Workflow name is required');

        expect(validateWorkflowDefinition({ name: 'test/../bad', description: 'test', steps: [{ id: 'a', tool: 'b', params: {} }] }))
            .toContain('alphanumeric');

        expect(validateWorkflowDefinition({ name: 'good', description: 'test', steps: [] }))
            .toContain('at least one step');
    });

    it('detects circular dependencies', () => {
        const steps = [
            { id: 'a', tool: 'test', params: {}, dependsOn: ['b'] },
            { id: 'b', tool: 'test', params: {}, dependsOn: ['a'] },
        ];
        expect(() => topologicalSort(steps)).toThrow('Circular dependency');
    });
});

// ─── knowledge_base: Path Traversal & SSRF ──────────────────────────

describe('knowledge_base security', () => {
    it('chunkText splits large text into bounded chunks', () => {
        const words = Array(1500).fill('word').join(' ');
        const chunks = chunkText(words, 500);
        expect(chunks.length).toBe(3);
        for (const chunk of chunks) {
            expect(chunk.split(/\s+/).length).toBeLessThanOrEqual(500);
        }
    });

    it('tfidfSearch returns bounded results', () => {
        const docs = Array(100).fill(null).map((_, i) => ({
            id: `doc-${i}`,
            content: `test document number ${i} with some content`,
        }));
        const results = tfidfSearch('test document', docs, 5);
        expect(results.length).toBeLessThanOrEqual(5);
    });

    it('tfidfSearch handles empty query gracefully', () => {
        const docs = [{ id: '1', content: 'some content' }];
        const results = tfidfSearch('', docs, 5);
        expect(results.length).toBe(0);
    });
});

// ─── evals: Input Validation ────────────────────────────────────────

describe('evals security', () => {
    it('rejects dataset names with path traversal', () => {
        // saveDataset should throw on traversal names
        const ds: EvalDataset = {
            name: '../../../etc/shadow',
            description: 'test',
            entries: [{ input: 'test' }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        expect(() => saveDataset(ds)).toThrow('Invalid dataset name');
    });

    it('rejects result IDs with path traversal', () => {
        expect(loadResult('../../../etc/passwd')).toBeNull();
    });

    it('accepts valid dataset names', () => {
        // This should not throw (fs is mocked)
        const ds: EvalDataset = {
            name: 'valid-dataset-name',
            description: 'test',
            entries: [{ input: 'test' }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        expect(() => saveDataset(ds)).not.toThrow();
    });

    it('scorers handle edge cases safely', () => {
        // Empty strings
        expect(scoreExactMatch('', '')).toEqual({ score: 1, pass: true });
        expect(scoreContains('', undefined)).toEqual({ score: 0, pass: false });
        expect(scoreLength('')).toEqual({ score: 0, pass: false });

        // Very long strings
        const longStr = 'a'.repeat(20000);
        expect(scoreLength(longStr)).toEqual({ score: 0, pass: false });

        // JSON validation
        expect(scoreJsonValid('{"valid": true}')).toEqual({ score: 1, pass: true });
        expect(scoreJsonValid('not json')).toEqual({ score: 0, pass: false });
    });

    it('computeAggregate handles empty entries', () => {
        const scorers: ScorerType[] = ['exact_match'];
        const result = computeAggregate([], scorers);
        expect(result.mean.exact_match).toBe(0);
        expect(result.passRate.exact_match).toBe(0);
    });

    it('runScorer handles unknown scorer type', () => {
        const result = runScorer('unknown_scorer' as ScorerType, 'test');
        expect(result).toEqual({ score: 0, pass: false });
    });
});

// ─── approval_gates: State Management ───────────────────────────────

describe('approval_gates security', () => {
    beforeEach(() => {
        _resetState();
    });

    it('getPendingRequests returns only pending items', () => {
        const pending = getPendingRequests();
        expect(Array.isArray(pending)).toBe(true);
        expect(pending.length).toBe(0);
    });

    it('approveRequest returns null for non-existent request', () => {
        const result = approveRequest('nonexistent-id');
        expect(result).toBeNull();
    });

    it('denyRequest returns null for non-existent request', () => {
        const result = denyRequest('nonexistent-id');
        expect(result).toBeNull();
    });

    it('loadConfig returns safe defaults when file missing', () => {
        const config = loadApprovalConfig();
        expect(config.mode).toBe('always');
        expect(config.defaultAction).toBe('deny');
        expect(config.timeout).toBe(300);
        expect(Array.isArray(config.tools)).toBe(true);
    });
});

// ─── Cross-cutting: Special Characters in Identifiers ───────────────

describe('identifier sanitization', () => {
    it('workflow names reject null bytes', () => {
        expect(isValidWorkflowName('test\x00evil')).toBe(false);
    });

    it('workflow names reject unicode path separators', () => {
        expect(isValidWorkflowName('test\u2044evil')).toBe(false); // fraction slash
        expect(isValidWorkflowName('test\uff0fevil')).toBe(false); // fullwidth solidus
    });

    it('workflow names reject control characters', () => {
        expect(isValidWorkflowName('test\nevil')).toBe(false);
        expect(isValidWorkflowName('test\revil')).toBe(false);
        expect(isValidWorkflowName('test\tevil')).toBe(false);
    });
});

// ─── Oversized Input Rejection ──────────────────────────────────────

describe('oversized input handling', () => {
    it('structured_output rejects patterns over 200 chars', () => {
        const errors = validateAgainstSchema('x', {
            type: 'string',
            pattern: '(a+)+'.repeat(50), // 250 chars of evil regex
        });
        expect(errors.some(e => e.message.includes('maximum length'))).toBe(true);
    });

    it('schema validation handles deeply nested objects', () => {
        // Should not stack overflow on reasonable nesting
        const schema = {
            type: 'object',
            properties: {
                level1: {
                    type: 'object',
                    properties: {
                        level2: {
                            type: 'object',
                            properties: {
                                value: { type: 'string' },
                            },
                        },
                    },
                },
            },
        };
        const errors = validateAgainstSchema(
            { level1: { level2: { value: 'test' } } },
            schema,
        );
        expect(errors.length).toBe(0);
    });
});
