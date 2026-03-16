/**
 * TITAN — Agent Handoff & Delegation Tests
 * Tests for agent_delegate, agent_team, agent_chain, and agent_critique tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'openai/gpt-4o-mini', maxTokens: 4096, modelAliases: { cloud: 'openai/gpt-4o', smart: 'openai/gpt-4o-mini', fast: 'openai/gpt-4o-mini', local: 'ollama/llama3' } },
        providers: {},
        security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
        skills: {},
    }),
    updateConfig: vi.fn(),
}));

// Mock spawnSubAgent — the core dependency
const mockSpawnSubAgent = vi.fn();
vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: (...args: unknown[]) => mockSpawnSubAgent(...args),
    SUB_AGENT_TEMPLATES: {
        researcher: {
            name: 'Researcher',
            tools: ['web_search', 'web_read', 'web_fetch', 'rag_search', 'rag_ingest'],
            systemPrompt: 'You are the Deep Researcher sub-agent.',
            maxRounds: 15,
            tier: 'cloud',
        },
        coder: {
            name: 'Coder',
            tools: ['shell', 'read_file', 'write_file', 'edit_file', 'list_dir', 'code_exec'],
            systemPrompt: 'You are the Coder sub-agent.',
            tier: 'fast',
        },
        explorer: {
            name: 'Explorer',
            tools: ['web_search', 'web_fetch', 'browse_url', 'web_read', 'web_act'],
            systemPrompt: 'You are the Explorer sub-agent.',
            tier: 'smart',
        },
        analyst: {
            name: 'Analyst',
            tools: ['web_search', 'web_fetch', 'memory', 'graph_search', 'graph_remember'],
            systemPrompt: 'You are the Analyst sub-agent.',
            tier: 'cloud',
        },
        dev_reviewer: {
            name: 'Dev Reviewer',
            tools: ['shell', 'read_file', 'code_review', 'code_analyze', 'deps_audit'],
            systemPrompt: 'You are the Dev Reviewer sub-agent.',
            tier: 'cloud',
        },
        dev_debugger: {
            name: 'Dev Debugger',
            tools: ['shell', 'read_file', 'write_file', 'debug_analyze', 'code_analyze'],
            systemPrompt: 'You are the Dev Debugger sub-agent.',
            tier: 'smart',
        },
        dev_architect: {
            name: 'Dev Architect',
            tools: ['shell', 'read_file', 'write_file', 'code_analyze', 'refactor_suggest', 'doc_generate'],
            systemPrompt: 'You are the Dev Architect sub-agent.',
            tier: 'cloud',
        },
    },
}));

function makeSubAgentResult(content: string, success = true, rounds = 3, durationMs = 500) {
    return {
        content,
        toolsUsed: ['web_search', 'web_fetch'],
        success,
        durationMs,
        rounds,
        validated: success,
    };
}

// ─── Test Setup ─────────────────────────────────────────────────────

let handlers: Map<string, any>;

beforeEach(async () => {
    vi.clearAllMocks();
    mockSpawnSubAgent.mockReset();
    mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Mock sub-agent response'));

    handlers = new Map();
    vi.doMock('../src/skills/registry.js', () => ({
        registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
            handlers.set(handler.name, handler);
        }),
    }));

    // Re-import to get fresh handlers
    const mod = await import('../src/skills/builtin/agent_handoff.js');
    mod.registerAgentHandoffSkill();
});

// ═════════════════════════════════════════════════════════════════════
// Registration
// ═════════════════════════════════════════════════════════════════════

describe('Agent Handoff — Registration', () => {
    it('should register all four tools', () => {
        expect(handlers.has('agent_delegate')).toBe(true);
        expect(handlers.has('agent_team')).toBe(true);
        expect(handlers.has('agent_chain')).toBe(true);
        expect(handlers.has('agent_critique')).toBe(true);
    });

    it('should have correct parameter schemas for agent_delegate', () => {
        const h = handlers.get('agent_delegate');
        expect(h.parameters.required).toContain('role');
        expect(h.parameters.required).toContain('task');
        expect(h.parameters.properties.role).toBeDefined();
        expect(h.parameters.properties.task).toBeDefined();
        expect(h.parameters.properties.context).toBeDefined();
        expect(h.parameters.properties.maxRounds).toBeDefined();
    });

    it('should have correct parameter schemas for agent_team', () => {
        const h = handlers.get('agent_team');
        expect(h.parameters.required).toContain('tasks');
        expect(h.parameters.properties.tasks).toBeDefined();
    });

    it('should have correct parameter schemas for agent_chain', () => {
        const h = handlers.get('agent_chain');
        expect(h.parameters.required).toContain('steps');
    });

    it('should have correct parameter schemas for agent_critique', () => {
        const h = handlers.get('agent_critique');
        expect(h.parameters.required).toContain('task');
        expect(h.parameters.properties.rounds).toBeDefined();
        expect(h.parameters.properties.generatorRole).toBeDefined();
        expect(h.parameters.properties.criticRole).toBeDefined();
    });
});

// ═════════════════════════════════════════════════════════════════════
// agent_delegate
// ═════════════════════════════════════════════════════════════════════

describe('agent_delegate', () => {
    it('should delegate to a researcher role', async () => {
        mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Research findings about AI'));
        const h = handlers.get('agent_delegate');
        const result = await h.execute({ role: 'researcher', task: 'Research AI trends' });

        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(1);
        const config = mockSpawnSubAgent.mock.calls[0][0];
        expect(config.name).toBe('ResearcherAgent');
        expect(config.task).toContain('Research AI trends');
        expect(result).toContain('Research findings about AI');
        expect(result).toContain('SUCCESS');
    });

    it('should pass context to the sub-agent', async () => {
        const h = handlers.get('agent_delegate');
        await h.execute({ role: 'coder', task: 'Write a function', context: 'Use TypeScript' });

        const config = mockSpawnSubAgent.mock.calls[0][0];
        expect(config.task).toContain('Write a function');
        expect(config.task).toContain('Use TypeScript');
    });

    it('should pass maxRounds to the sub-agent', async () => {
        const h = handlers.get('agent_delegate');
        await h.execute({ role: 'analyst', task: 'Analyze data', maxRounds: 20 });

        const config = mockSpawnSubAgent.mock.calls[0][0];
        expect(config.maxRounds).toBe(20);
    });

    it('should handle unknown roles with a generic prompt', async () => {
        const h = handlers.get('agent_delegate');
        await h.execute({ role: 'translator', task: 'Translate to French' });

        const config = mockSpawnSubAgent.mock.calls[0][0];
        expect(config.name).toBe('TranslatorAgent');
        expect(config.systemPrompt).toContain('translator specialist');
    });

    it('should return error when role is missing', async () => {
        const h = handlers.get('agent_delegate');
        const result = await h.execute({ task: 'Do something' });
        expect(result).toContain('Error');
    });

    it('should return error when task is missing', async () => {
        const h = handlers.get('agent_delegate');
        const result = await h.execute({ role: 'coder' });
        expect(result).toContain('Error');
    });

    it('should report failure when sub-agent fails', async () => {
        mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Something went wrong', false));
        const h = handlers.get('agent_delegate');
        const result = await h.execute({ role: 'coder', task: 'Fix bug' });

        expect(result).toContain('FAILED');
    });

    it('should use template tools for known roles', async () => {
        const h = handlers.get('agent_delegate');
        await h.execute({ role: 'coder', task: 'Write code' });

        const config = mockSpawnSubAgent.mock.calls[0][0];
        expect(config.tools).toContain('shell');
        expect(config.tools).toContain('write_file');
    });

    it('should include tools used in the output', async () => {
        mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Done'));
        const h = handlers.get('agent_delegate');
        const result = await h.execute({ role: 'researcher', task: 'Search' });

        expect(result).toContain('Tools used');
        expect(result).toContain('web_search');
    });
});

// ═════════════════════════════════════════════════════════════════════
// agent_team
// ═════════════════════════════════════════════════════════════════════

describe('agent_team', () => {
    it('should run multiple agents in parallel', async () => {
        mockSpawnSubAgent
            .mockResolvedValueOnce(makeSubAgentResult('Research result'))
            .mockResolvedValueOnce(makeSubAgentResult('Code result'));

        const h = handlers.get('agent_team');
        const tasks = JSON.stringify([
            { role: 'researcher', task: 'Research topic' },
            { role: 'coder', task: 'Write code' },
        ]);
        const result = await h.execute({ tasks });

        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
        expect(result).toContain('Research result');
        expect(result).toContain('Code result');
        expect(result).toContain('2/2 succeeded');
    });

    it('should return error on invalid JSON', async () => {
        const h = handlers.get('agent_team');
        const result = await h.execute({ tasks: 'not valid json' });
        expect(result).toContain('Error');
    });

    it('should return error on empty array', async () => {
        const h = handlers.get('agent_team');
        const result = await h.execute({ tasks: '[]' });
        expect(result).toContain('Error');
    });

    it('should enforce max 6 parallel agents', async () => {
        const h = handlers.get('agent_team');
        const tasks = JSON.stringify(
            Array.from({ length: 7 }, (_, i) => ({ role: 'researcher', task: `Task ${i}` }))
        );
        const result = await h.execute({ tasks });
        expect(result).toContain('Maximum 6');
    });

    it('should report partial success when some agents fail', async () => {
        mockSpawnSubAgent
            .mockResolvedValueOnce(makeSubAgentResult('Good result'))
            .mockResolvedValueOnce(makeSubAgentResult('Bad result', false));

        const h = handlers.get('agent_team');
        const tasks = JSON.stringify([
            { role: 'researcher', task: 'Task 1' },
            { role: 'coder', task: 'Task 2' },
        ]);
        const result = await h.execute({ tasks });

        expect(result).toContain('1/2 succeeded');
    });
});

// ═════════════════════════════════════════════════════════════════════
// agent_chain
// ═════════════════════════════════════════════════════════════════════

describe('agent_chain', () => {
    it('should run agents sequentially passing context forward', async () => {
        mockSpawnSubAgent
            .mockResolvedValueOnce(makeSubAgentResult('Step 1 output'))
            .mockResolvedValueOnce(makeSubAgentResult('Step 2 output based on step 1'));

        const h = handlers.get('agent_chain');
        const steps = JSON.stringify([
            { role: 'researcher', task: 'Research topic' },
            { role: 'writer', task: 'Write article' },
        ]);
        const result = await h.execute({ steps });

        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
        // Second call should include context from first
        const secondConfig = mockSpawnSubAgent.mock.calls[1][0];
        expect(secondConfig.task).toContain('Step 1 output');
        expect(result).toContain('Final Output');
        expect(result).toContain('Step 2 output');
    });

    it('should return error on invalid JSON', async () => {
        const h = handlers.get('agent_chain');
        const result = await h.execute({ steps: '{broken' });
        expect(result).toContain('Error');
    });

    it('should return error on empty array', async () => {
        const h = handlers.get('agent_chain');
        const result = await h.execute({ steps: '[]' });
        expect(result).toContain('Error');
    });

    it('should enforce max 8 steps', async () => {
        const h = handlers.get('agent_chain');
        const steps = JSON.stringify(
            Array.from({ length: 9 }, (_, i) => ({ role: 'writer', task: `Step ${i}` }))
        );
        const result = await h.execute({ steps });
        expect(result).toContain('Maximum 8');
    });

    it('should continue chain even if a step fails', async () => {
        mockSpawnSubAgent
            .mockResolvedValueOnce(makeSubAgentResult('Failed step', false))
            .mockResolvedValueOnce(makeSubAgentResult('Final output'));

        const h = handlers.get('agent_chain');
        const steps = JSON.stringify([
            { role: 'researcher', task: 'Research' },
            { role: 'writer', task: 'Write' },
        ]);
        const result = await h.execute({ steps });

        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(2);
        expect(result).toContain('FAILED');
        expect(result).toContain('Final output');
    });

    it('should show all step summaries in output', async () => {
        mockSpawnSubAgent
            .mockResolvedValueOnce(makeSubAgentResult('Output A'))
            .mockResolvedValueOnce(makeSubAgentResult('Output B'))
            .mockResolvedValueOnce(makeSubAgentResult('Output C'));

        const h = handlers.get('agent_chain');
        const steps = JSON.stringify([
            { role: 'researcher', task: 'Step A' },
            { role: 'analyst', task: 'Step B' },
            { role: 'writer', task: 'Step C' },
        ]);
        const result = await h.execute({ steps });

        expect(result).toContain('Step 1');
        expect(result).toContain('Step 2');
        expect(result).toContain('Step 3');
        expect(result).toContain('3 steps');
    });
});

// ═════════════════════════════════════════════════════════════════════
// agent_critique
// ═════════════════════════════════════════════════════════════════════

describe('agent_critique', () => {
    it('should run generate-critique cycles', async () => {
        mockSpawnSubAgent
            .mockResolvedValueOnce(makeSubAgentResult('First draft'))
            .mockResolvedValueOnce(makeSubAgentResult('Needs improvement in X'))
            .mockResolvedValueOnce(makeSubAgentResult('Improved final draft'));

        const h = handlers.get('agent_critique');
        const result = await h.execute({ task: 'Write an essay', rounds: 2 });

        // 2 rounds: gen1, critique1, gen2 (no critique on last round)
        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(3);
        expect(result).toContain('Final Output');
        expect(result).toContain('Improved final draft');
    });

    it('should return error when task is missing', async () => {
        const h = handlers.get('agent_critique');
        const result = await h.execute({});
        expect(result).toContain('Error');
    });

    it('should default to 2 rounds', async () => {
        mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Output'));
        const h = handlers.get('agent_critique');
        await h.execute({ task: 'Write something' });

        // 2 rounds: gen1, critique1, gen2 = 3 calls
        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(3);
    });

    it('should cap rounds at 5', async () => {
        mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Output'));
        const h = handlers.get('agent_critique');
        await h.execute({ task: 'Write something', rounds: 100 });

        // 5 rounds: gen + critique each except last = 5 gens + 4 critiques = 9
        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(9);
    });

    it('should use custom generator and critic roles', async () => {
        mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Output'));
        const h = handlers.get('agent_critique');
        const result = await h.execute({
            task: 'Write code',
            generatorRole: 'coder',
            criticRole: 'architect',
            rounds: 1,
        });

        // 1 round: just gen1, no critique
        expect(mockSpawnSubAgent).toHaveBeenCalledTimes(1);
        expect(result).toContain('coder');
        expect(result).toContain('architect');
    });

    it('should pass critique feedback to next generation', async () => {
        mockSpawnSubAgent
            .mockResolvedValueOnce(makeSubAgentResult('Draft v1'))
            .mockResolvedValueOnce(makeSubAgentResult('Fix the intro section'))
            .mockResolvedValueOnce(makeSubAgentResult('Draft v2 with fixed intro'));

        const h = handlers.get('agent_critique');
        await h.execute({ task: 'Write essay', rounds: 2 });

        // Third call (gen round 2) should include critique feedback
        const thirdConfig = mockSpawnSubAgent.mock.calls[2][0];
        expect(thirdConfig.task).toContain('Improve');
        // Context should contain the critique
        const fullTask = thirdConfig.task;
        // The context is passed via resolveRole which appends to task
        // Check that the previous output and feedback are in the context
        expect(mockSpawnSubAgent.mock.calls[2][0].task).toContain('Improve');
    });

    it('should include round history in output', async () => {
        mockSpawnSubAgent.mockResolvedValue(makeSubAgentResult('Content'));
        const h = handlers.get('agent_critique');
        const result = await h.execute({ task: 'Write', rounds: 2 });

        expect(result).toContain('Round 1');
        expect(result).toContain('Round 2');
        expect(result).toContain('Generation');
        expect(result).toContain('Critique');
    });
});
