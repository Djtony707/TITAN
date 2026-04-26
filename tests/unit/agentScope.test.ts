/**
 * TITAN — AgentScope Unit Tests (Phase 7)
 *
 * Pure, deterministic tests for agentScope.ts config resolution.
 * No LLM calls. Fast (< 50ms total).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Each test gets its own config
let mockConfig: Record<string, unknown> = {};
vi.mock('../../src/config/config.js', () => ({
    loadConfig: vi.fn(() => mockConfig),
}));

import {
    resolveAgentConfig,
    listConfiguredAgentIds,
    listResolvedAgents,
    getAgentEntry,
    agentAllowsSkill,
    type ResolvedAgentConfig,
} from '../../src/agent/agentScope.js';

describe('AgentScope — Config Resolution', () => {
    beforeEach(() => {
        mockConfig = {};
    });

    it('resolveAgentConfig returns null for missing agent', () => {
        expect(resolveAgentConfig('nonexistent')).toBeNull();
    });

    it('resolveAgentConfig returns null for disabled agent', () => {
        mockConfig = {
            agents: {
                entries: {
                    disabledAgent: { enabled: false },
                },
            },
        };
        expect(resolveAgentConfig('disabledAgent')).toBeNull();
    });

    it('resolveAgentConfig merges defaults + entry overrides', () => {
        mockConfig = {
            agents: {
                defaults: {
                    model: 'ollama/qwen3.5:cloud',
                    maxRounds: 10,
                    persona: 'default',
                },
                entries: {
                    coder: {
                        name: 'Rust Coder',
                        model: 'ollama/kimi-k2.6:cloud',
                        maxRounds: 20,
                        skillsFilter: ['shell', 'read_file', 'write_file'],
                    },
                },
            },
        };
        const cfg = resolveAgentConfig('coder');
        expect(cfg).not.toBeNull();
        expect(cfg!.name).toBe('Rust Coder');
        expect(cfg!.model).toBe('ollama/kimi-k2.6:cloud');
        expect(cfg!.maxRounds).toBe(20);
        expect(cfg!.persona).toBe('default'); // from defaults
        expect(cfg!.skillsFilter).toEqual(['shell', 'read_file', 'write_file']);
    });

    it('resolveAgentConfig uses entry-only when no defaults', () => {
        mockConfig = {
            agents: {
                entries: {
                    scout: {
                        name: 'Scout',
                        model: 'ollama/gemma4:31b:cloud',
                    },
                },
            },
        };
        const cfg = resolveAgentConfig('scout');
        expect(cfg).not.toBeNull();
        expect(cfg!.name).toBe('Scout');
        expect(cfg!.model).toBe('ollama/gemma4:31b:cloud');
        expect(cfg!.maxRounds).toBe(15); // hardcoded default
        expect(cfg!.maxTokens).toBe(4000); // hardcoded default
    });

    it('resolveAgentConfig falls back to sensible defaults', () => {
        mockConfig = {
            agents: {
                entries: {
                    minimal: {},
                },
            },
        };
        const cfg = resolveAgentConfig('minimal');
        expect(cfg).not.toBeNull();
        expect(cfg!.id).toBe('minimal');
        expect(cfg!.name).toBe('minimal');
        expect(cfg!.template).toBe('default');
        expect(cfg!.maxRounds).toBe(15);
        expect(cfg!.maxTokens).toBe(4000);
        expect(cfg!.enabled).toBe(true);
        expect(cfg!.skillsFilter).toBeNull();
    });

    it('resolveAgentConfig handles modelFallbacks', () => {
        mockConfig = {
            agents: {
                entries: {
                    reliable: {
                        modelFallbacks: ['ollama/qwen3.5:cloud', 'ollama/gemma4:31b:cloud'],
                    },
                },
            },
        };
        const cfg = resolveAgentConfig('reliable');
        expect(cfg!.modelFallbacks).toEqual(['ollama/qwen3.5:cloud', 'ollama/gemma4:31b:cloud']);
    });

    it('resolveAgentConfig handles tags and workspaceDir', () => {
        mockConfig = {
            agents: {
                entries: {
                    scoped: {
                        tags: ['backend', 'rust'],
                        workspaceDir: '/projects/rust-backend',
                    },
                },
            },
        };
        const cfg = resolveAgentConfig('scoped');
        expect(cfg!.tags).toEqual(['backend', 'rust']);
        expect(cfg!.workspaceDir).toBe('/projects/rust-backend');
    });

    it('resolveAgentConfig handles systemPromptOverride', () => {
        mockConfig = {
            agents: {
                entries: {
                    custom: {
                        systemPromptOverride: 'Always use TypeScript strict mode.',
                    },
                },
            },
        };
        const cfg = resolveAgentConfig('custom');
        expect(cfg!.systemPromptOverride).toBe('Always use TypeScript strict mode.');
    });

    it('listConfiguredAgentIds returns only enabled agents', () => {
        mockConfig = {
            agents: {
                entries: {
                    active1: { enabled: true },
                    active2: {}, // enabled by default
                    inactive: { enabled: false },
                },
            },
        };
        const ids = listConfiguredAgentIds();
        expect(ids).toContain('active1');
        expect(ids).toContain('active2');
        expect(ids).not.toContain('inactive');
    });

    it('listResolvedAgents returns fully resolved configs', () => {
        mockConfig = {
            agents: {
                entries: {
                    a: { name: 'Agent A' },
                    b: { name: 'Agent B' },
                },
            },
        };
        const agents = listResolvedAgents();
        expect(agents.length).toBe(2);
        expect(agents[0].name).toBe('Agent A');
        expect(agents[1].name).toBe('Agent B');
    });

    it('getAgentEntry returns raw config without merging defaults', () => {
        mockConfig = {
            agents: {
                defaults: { model: 'default-model' },
                entries: {
                    test: { name: 'Test' },
                },
            },
        };
        const entry = getAgentEntry('test');
        expect(entry).not.toBeNull();
        expect(entry!.name).toBe('Test');
        expect(entry!.model).toBeUndefined(); // defaults not merged
    });

    it('getAgentEntry returns null for missing agent', () => {
        expect(getAgentEntry('missing')).toBeNull();
    });
});

describe('AgentScope — Skill Filtering', () => {
    it('allows all skills when filter is null', () => {
        const agent: ResolvedAgentConfig = {
            id: 'open',
            name: 'Open',
            description: '',
            model: '',
            modelFallbacks: [],
            skillsFilter: null,
            persona: 'default',
            systemPromptOverride: '',
            template: 'default',
            maxRounds: 10,
            maxTokens: 4000,
            workspaceDir: null,
            tags: [],
            enabled: true,
        };
        expect(agentAllowsSkill(agent, 'shell')).toBe(true);
        expect(agentAllowsSkill(agent, 'read_file')).toBe(true);
    });

    it('allows exact skill matches', () => {
        const agent: ResolvedAgentConfig = {
            id: 'restricted',
            name: 'Restricted',
            description: '',
            model: '',
            modelFallbacks: [],
            skillsFilter: ['shell', 'read_file'],
            persona: 'default',
            systemPromptOverride: '',
            template: 'default',
            maxRounds: 10,
            maxTokens: 4000,
            workspaceDir: null,
            tags: [],
            enabled: true,
        };
        expect(agentAllowsSkill(agent, 'shell')).toBe(true);
        expect(agentAllowsSkill(agent, 'read_file')).toBe(true);
        expect(agentAllowsSkill(agent, 'write_file')).toBe(false);
    });

    it('supports wildcard prefix matching', () => {
        const agent: ResolvedAgentConfig = {
            id: 'github',
            name: 'GitHub',
            description: '',
            model: '',
            modelFallbacks: [],
            skillsFilter: ['github_*'],
            persona: 'default',
            systemPromptOverride: '',
            template: 'default',
            maxRounds: 10,
            maxTokens: 4000,
            workspaceDir: null,
            tags: [],
            enabled: true,
        };
        expect(agentAllowsSkill(agent, 'github_search')).toBe(true);
        expect(agentAllowsSkill(agent, 'github_create_issue')).toBe(true);
        expect(agentAllowsSkill(agent, 'shell')).toBe(false);
    });

    it('supports mixed exact and wildcard patterns', () => {
        const agent: ResolvedAgentConfig = {
            id: 'mixed',
            name: 'Mixed',
            description: '',
            model: '',
            modelFallbacks: [],
            skillsFilter: ['shell', 'github_*', 'read_file'],
            persona: 'default',
            systemPromptOverride: '',
            template: 'default',
            maxRounds: 10,
            maxTokens: 4000,
            workspaceDir: null,
            tags: [],
            enabled: true,
        };
        expect(agentAllowsSkill(agent, 'shell')).toBe(true);
        expect(agentAllowsSkill(agent, 'github_clone')).toBe(true);
        expect(agentAllowsSkill(agent, 'read_file')).toBe(true);
        expect(agentAllowsSkill(agent, 'write_file')).toBe(false);
    });

    it('handles empty filter array', () => {
        const agent: ResolvedAgentConfig = {
            id: 'empty',
            name: 'Empty',
            description: '',
            model: '',
            modelFallbacks: [],
            skillsFilter: [],
            persona: 'default',
            systemPromptOverride: '',
            template: 'default',
            maxRounds: 10,
            maxTokens: 4000,
            workspaceDir: null,
            tags: [],
            enabled: true,
        };
        // Empty array is truthy, so it should block everything
        expect(agentAllowsSkill(agent, 'shell')).toBe(false);
    });
});
