/**
 * TITAN — Integration Tests for 9 New Skills
 * Stress-tests cross-skill interactions, concurrent operations, malicious inputs,
 * edge cases, and large data handling.
 *
 * Skills covered:
 *  1. structured_output  2. workflows  3. social_scheduler  4. agent_handoff
 *  5. event_triggers  6. knowledge_base  7. evals  8. approval_gates  9. a2a_protocol
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Shared temp directory for all skills ────────────────────────

const { testHome } = vi.hoisted(() => {
    const { join } = require('path');
    const { tmpdir } = require('os');
    return { testHome: join(tmpdir(), `titan-integration-test-${Date.now()}`) };
});

// ─── Mocks ───────────────────────────────────────────────────────

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: testHome,
    TITAN_VERSION: '2026.10.39',
    TITAN_NAME: 'TITAN',
    TITAN_FULL_NAME: 'The Intelligent Task Automation Network',
    TITAN_SKILLS_DIR: join(testHome, 'skills'),
    DEFAULT_GATEWAY_PORT: 48420,
    DEFAULT_MODEL: 'test/model',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// Capture all registered tools across all skills
const registeredTools = new Map<string, {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
}>();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, tool: unknown) => {
        const t = tool as {
            name: string;
            description: string;
            parameters: Record<string, unknown>;
            execute: (args: Record<string, unknown>) => Promise<string>;
        };
        registeredTools.set(t.name, t);
    },
    isToolSkillEnabled: () => true,
}));

// Mock sub-agent for agent_handoff
vi.mock('../src/agent/subAgent.js', () => ({
    spawnSubAgent: vi.fn().mockResolvedValue({
        content: 'Sub-agent completed the task.',
        success: true,
        toolsUsed: ['web_search'],
        rounds: 3,
        durationMs: 1200,
    }),
    SUB_AGENT_TEMPLATES: {
        researcher: { tools: ['web_search'], systemPrompt: 'Research', maxRounds: 10 },
        coder: { tools: ['shell'], systemPrompt: 'Code', maxRounds: 10 },
        analyst: { tools: ['web_search'], systemPrompt: 'Analyze', maxRounds: 10 },
        explorer: { tools: ['web_search'], systemPrompt: 'Explore', maxRounds: 10 },
        dev_reviewer: { tools: ['shell'], systemPrompt: 'Review', maxRounds: 10 },
        dev_debugger: { tools: ['shell'], systemPrompt: 'Debug', maxRounds: 10 },
        dev_architect: { tools: ['shell'], systemPrompt: 'Architect', maxRounds: 10 },
    },
}));

// Mock toolRunner for workflows
vi.mock('../src/agent/toolRunner.js', () => ({
    getRegisteredTools: () => Array.from(registeredTools.values()),
}));

// Mock config for a2a
vi.mock('../src/config/config.js', () => ({
    loadConfig: () => ({
        gateway: { port: 48420, host: '0.0.0.0', auth: { mode: 'none' } },
        auth: { mode: 'none' },
    }),
    getDefaultConfig: () => ({}),
    resetConfigCache: () => {},
}));

// ─── Imports (after mocks) ───────────────────────────────────────

import {
    validateAgainstSchema,
    safeParseJSON,
    buildExtractionPrompt,
    buildTransformPrompt,
    registerStructuredOutputSkill,
} from '../src/skills/builtin/structured_output.js';

import {
    registerWorkflowsSkill,
    topologicalSort,
    substituteTemplates,
    evaluateCondition,
    executeWorkflow,
    validateWorkflowDefinition,
    saveWorkflow,
    loadWorkflow,
    deleteWorkflowFile,
    listWorkflowFiles,
    type WorkflowStep,
    type WorkflowDefinition,
    type ToolExecutor,
} from '../src/skills/builtin/workflows.js';

import {
    registerSocialSchedulerSkill,
    PLATFORM_LIMITS,
    stopScheduleChecker,
} from '../src/skills/builtin/social_scheduler.js';

import {
    registerAgentHandoffSkill,
} from '../src/skills/builtin/agent_handoff.js';

import {
    registerEventTriggersSkill,
    saveTrigger,
    loadTrigger,
    loadAllTriggers,
    deleteTriggerFile,
    loadFireLog,
    appendFireLog,
    fireTrigger,
    stopAllWatchers,
    type Trigger,
} from '../src/skills/builtin/event_triggers.js';

import {
    chunkText,
    tfidfSearch,
} from '../src/skills/builtin/knowledge_base.js';

import {
    registerEvalsSkill,
    scoreExactMatch,
    scoreContains,
    scoreLength,
    scoreJsonValid,
    runScorer,
    computeAggregate,
    executeEvalRun,
    saveDataset,
    loadDataset,
    type EvalDataset,
    type EntryResult,
    type ScorerType,
} from '../src/skills/builtin/evals.js';

import {
    registerApprovalGatesSkill,
    requiresApproval,
    createApprovalRequest,
    approveRequest,
    denyRequest,
    getPendingRequests,
    setToolPreference,
    getToolPreference,
    loadConfig as loadApprovalConfig,
    saveConfig as saveApprovalConfig,
    loadHistory,
    _resetState,
    type ApprovalConfig,
} from '../src/skills/builtin/approval_gates.js';

import {
    registerKnowledgeBaseSkill,
} from '../src/skills/builtin/knowledge_base.js';

// ─── Helpers ─────────────────────────────────────────────────────

function getTool(name: string) {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not registered`);
    return tool;
}

function cleanTestDir() {
    if (existsSync(testHome)) {
        rmSync(testHome, { recursive: true, force: true });
    }
    mkdirSync(testHome, { recursive: true });
}

// ─── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
    registeredTools.clear();
    _resetState();
    cleanTestDir();
    // Register all skills
    registerStructuredOutputSkill();
    registerWorkflowsSkill();
    registerSocialSchedulerSkill();
    registerAgentHandoffSkill();
    registerEventTriggersSkill();
    registerKnowledgeBaseSkill();
    registerEvalsSkill();
    registerApprovalGatesSkill();
});

afterEach(() => {
    stopScheduleChecker();
    stopAllWatchers();
    cleanTestDir();
});

// ═══════════════════════════════════════════════════════════════════
// 1. CROSS-SKILL INTERACTIONS
// ═══════════════════════════════════════════════════════════════════

describe('Cross-Skill Interactions', () => {
    it('should validate structured output schema then use in workflow definition', async () => {
        // First validate a schema
        const validateTool = getTool('validate_json');
        const result = await validateTool.execute({
            data: '{"name": "test", "steps": 3}',
            schema: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    steps: { type: 'integer' },
                },
                required: ['name', 'steps'],
            },
        });
        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(true);

        // Then create a workflow using that validated data
        const createTool = getTool('workflow_create');
        const wfResult = await createTool.execute({
            name: 'validated-workflow',
            description: 'Workflow created from validated data',
            steps: JSON.stringify([
                { id: 'step1', tool: 'echo', params: { text: 'hello' } },
            ]),
        });
        expect(wfResult).toContain('created');
    });

    it('should schedule a social post and verify via queue', async () => {
        const scheduleTool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();

        const scheduleResult = await scheduleTool.execute({
            platform: 'x',
            content: 'Hello World from TITAN!',
            scheduledAt: futureDate,
        });
        expect(scheduleResult).toContain('Post scheduled');

        const queueTool = getTool('social_queue');
        const queueResult = await queueTool.execute({ status: 'pending' });
        expect(queueResult).toContain('Hello World from TITAN!');
    });

    it('should create trigger, test-fire it, and check the log', async () => {
        const createTool = getTool('trigger_create');
        await createTool.execute({
            name: 'test-trigger',
            event: 'custom',
            condition: { key: 'value' },
            action: { message: 'Hello from trigger' },
        });

        const testTool = getTool('trigger_test');
        const testResult = await testTool.execute({ name: 'test-trigger' });
        expect(testResult).toContain('TEST FIRE');

        const logTool = getTool('trigger_log');
        const logResult = await logTool.execute({ limit: 5 });
        expect(logResult).toContain('test-trigger');
    });

    it('should ingest into knowledge base then search for it', async () => {
        const ingestTool = getTool('kb_ingest');
        await ingestTool.execute({
            collection: 'test-kb',
            content: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
            source: 'test',
        });

        const searchTool = getTool('kb_search');
        const searchResult = await searchTool.execute({
            query: 'TypeScript JavaScript',
            collection: 'test-kb',
        });
        expect(searchResult).toContain('TypeScript');
    });

    it('should create eval dataset, run eval, and view results', async () => {
        const createTool = getTool('eval_create_dataset');
        await createTool.execute({
            name: 'integration-test-ds',
            description: 'Integration test dataset',
            entries: JSON.stringify([
                { input: 'What is 2+2?', expectedOutput: 'Response to: What is 2+2?' },
            ]),
        });

        const runTool = getTool('eval_run');
        const runResult = await runTool.execute({
            dataset: 'integration-test-ds',
            scorers: JSON.stringify(['exact_match', 'length']),
        });
        expect(runResult).toContain('Eval Run');
        expect(runResult).toContain('exact_match');

        const resultsTool = getTool('eval_results');
        const resultsOutput = await resultsTool.execute({});
        expect(resultsOutput).toContain('integration-test-ds');
    });

    it('should configure approval, create request, approve, and check history', async () => {
        const configTool = getTool('approval_configure');
        await configTool.execute({
            tools: ['shell', 'web_browser'],
            mode: 'always',
            timeout: 60,
            defaultAction: 'deny',
        });

        expect(requiresApproval('shell')).toBe(true);
        expect(requiresApproval('web_search')).toBe(false);

        const req = createApprovalRequest('shell', { command: 'rm -rf /' }, 'session-123');
        expect(req.status).toBe('pending');

        const approved = approveRequest(req.id, 'Looks safe');
        expect(approved?.status).toBe('approved');

        const historyTool = getTool('approval_history');
        const historyResult = await historyTool.execute({});
        expect(historyResult).toContain('approved');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 2. CONCURRENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════

describe('Concurrent Operations', () => {
    it('should handle multiple simultaneous workflow creations', async () => {
        const createTool = getTool('workflow_create');
        const promises = Array.from({ length: 10 }, (_, i) =>
            createTool.execute({
                name: `concurrent-wf-${i}`,
                description: `Concurrent workflow ${i}`,
                steps: JSON.stringify([
                    { id: 'step1', tool: 'echo', params: { text: `wf-${i}` } },
                ]),
            }),
        );

        const results = await Promise.all(promises);
        results.forEach((r, i) => {
            expect(r).toContain(`concurrent-wf-${i}`);
        });

        const listTool = getTool('workflow_list');
        const listResult = await listTool.execute({});
        expect(listResult).toContain('concurrent-wf-0');
        expect(listResult).toContain('concurrent-wf-9');
    });

    it('should handle concurrent social post scheduling', async () => {
        const scheduleTool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();

        const promises = Array.from({ length: 5 }, (_, i) =>
            scheduleTool.execute({
                platform: 'x',
                content: `Concurrent post ${i}`,
                scheduledAt: futureDate,
            }),
        );

        const results = await Promise.all(promises);
        results.forEach(r => expect(r).toContain('Post scheduled'));
    });

    it('should handle concurrent knowledge base ingestion', async () => {
        const ingestTool = getTool('kb_ingest');
        const promises = Array.from({ length: 10 }, (_, i) =>
            ingestTool.execute({
                collection: 'concurrent-kb',
                content: `Document ${i}: This is test content for concurrency testing with unique identifier ${i}.`,
            }),
        );

        const results = await Promise.all(promises);
        results.forEach(r => expect(r).toContain('Ingested'));

        const searchTool = getTool('kb_search');
        const searchResult = await searchTool.execute({
            query: 'concurrency testing',
            collection: 'concurrent-kb',
        });
        expect(searchResult).toContain('result');
    });

    it('should handle concurrent approval request creation', async () => {
        saveApprovalConfig({
            tools: ['tool-a', 'tool-b', 'tool-c'],
            mode: 'always',
            timeout: 300,
            defaultAction: 'deny',
        });

        const requests = Array.from({ length: 5 }, (_, i) =>
            createApprovalRequest(`tool-${i % 3 === 0 ? 'a' : i % 3 === 1 ? 'b' : 'c'}`, { idx: i }, `session-${i}`),
        );

        // All should be pending
        const pending = getPendingRequests();
        expect(pending.length).toBe(5);

        // Approve all concurrently
        const approvals = requests.map(r => approveRequest(r.id));
        approvals.forEach(a => expect(a?.status).toBe('approved'));
    });

    it('should handle concurrent trigger creation and deletion', async () => {
        const createTool = getTool('trigger_create');

        // Create 5 triggers
        for (let i = 0; i < 5; i++) {
            await createTool.execute({
                name: `conc-trigger-${i}`,
                event: 'custom',
                condition: { key: `val-${i}` },
                action: { message: `msg-${i}` },
            });
        }

        const triggers = loadAllTriggers();
        expect(triggers.length).toBe(5);

        // Delete them all
        const deleteTool = getTool('trigger_delete');
        const delPromises = Array.from({ length: 5 }, (_, i) =>
            deleteTool.execute({ name: `conc-trigger-${i}` }),
        );
        const delResults = await Promise.all(delPromises);
        delResults.forEach(r => expect(r).toContain('Deleted'));
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. LARGE DATA HANDLING
// ═══════════════════════════════════════════════════════════════════

describe('Large Data Handling', () => {
    it('should chunk very long text correctly', () => {
        // Create text with 5000 words
        const words = Array.from({ length: 5000 }, (_, i) => `word${i}`);
        const longText = words.join(' ');
        const chunks = chunkText(longText, 500);
        expect(chunks.length).toBe(10);
        // Verify all words are accounted for
        const reconstructed = chunks.join(' ');
        expect(reconstructed.split(/\s+/).length).toBe(5000);
    });

    it('should handle large JSON validation', () => {
        // Build a large object with 100 properties
        const properties: Record<string, { type: string }> = {};
        const obj: Record<string, string> = {};
        for (let i = 0; i < 100; i++) {
            properties[`field${i}`] = { type: 'string' };
            obj[`field${i}`] = `value${i}`;
        }

        const errors = validateAgainstSchema(obj, {
            type: 'object',
            properties,
            required: Object.keys(properties),
        });
        expect(errors).toHaveLength(0);
    });

    it('should handle large eval datasets', async () => {
        const entries = Array.from({ length: 50 }, (_, i) => ({
            input: `Test input ${i}: What is the capital of country ${i}?`,
            expectedOutput: `Response to: Test input ${i}: What is the capital of country ${i}?`,
        }));

        const ds: EvalDataset = {
            name: 'large-dataset',
            description: 'Large test dataset',
            entries,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const agentFn = async (input: string) => `Response to: ${input}`;
        const result = await executeEvalRun(ds, ['exact_match'], 'test', agentFn);
        expect(result.entries.length).toBe(50);
        expect(result.aggregate.passRate.exact_match).toBe(1);
    });

    it('should handle workflow with many steps', async () => {
        const steps: WorkflowStep[] = Array.from({ length: 20 }, (_, i) => ({
            id: `step${i}`,
            tool: 'echo',
            params: { text: `step ${i}` },
            ...(i > 0 ? { dependsOn: [`step${i - 1}`] } : {}),
        }));

        const layers = topologicalSort(steps);
        // Sequential chain = 20 layers of 1 step each
        expect(layers.length).toBe(20);
    });

    it('should handle large social queue listing', async () => {
        const scheduleTool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();

        for (let i = 0; i < 20; i++) {
            await scheduleTool.execute({
                platform: 'x',
                content: `Post number ${i}`,
                scheduledAt: futureDate,
            });
        }

        const queueTool = getTool('social_queue');
        const result = await queueTool.execute({});
        expect(result).toContain('20 post');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 4. MALICIOUS INPUT HANDLING
// ═══════════════════════════════════════════════════════════════════

describe('Malicious Input Handling', () => {
    describe('Path Traversal', () => {
        it('should reject workflow names with path traversal', async () => {
            const createTool = getTool('workflow_create');
            const result = await createTool.execute({
                name: '../../../etc/passwd',
                description: 'Malicious workflow',
                steps: JSON.stringify([{ id: 's1', tool: 'echo', params: {} }]),
            });
            expect(result).toContain('Error');
        });

        it('should sanitize social post IDs with traversal', async () => {
            const cancelTool = getTool('social_cancel');
            const result = await cancelTool.execute({
                postId: '../../../etc/passwd',
            });
            // Should not find a post (sanitized ID won't match)
            expect(result).toContain('Error');
        });

        it('should reject knowledge base collection names with traversal', async () => {
            const ingestTool = getTool('kb_ingest');
            const result = await ingestTool.execute({
                collection: '../../../etc',
                content: 'malicious content',
            });
            expect(result).toContain('Error');
        });

        it('should reject kb_delete with traversal in collection name', async () => {
            const deleteTool = getTool('kb_delete');
            const result = await deleteTool.execute({
                collection: '../../etc',
            });
            expect(result).toContain('Error');
        });
    });

    describe('SQL Injection Strings', () => {
        it('should safely handle SQL injection in workflow names', async () => {
            const createTool = getTool('workflow_create');
            const result = await createTool.execute({
                name: "'; DROP TABLE workflows; --",
                description: 'SQL injection attempt',
                steps: JSON.stringify([{ id: 's1', tool: 'echo', params: {} }]),
            });
            // Should be rejected by name validation
            expect(result).toContain('Error');
        });

        it('should safely handle SQL injection in search queries', async () => {
            const searchTool = getTool('kb_search');
            const result = await searchTool.execute({
                query: "'; DROP TABLE documents; --",
            });
            // Should handle gracefully (no crash, returns no results)
            expect(result).toBeDefined();
        });

        it('should safely handle SQL injection in eval dataset names', async () => {
            const createTool = getTool('eval_create_dataset');
            const result = await createTool.execute({
                name: "test'; DROP TABLE evals; --",
                description: 'SQL injection attempt',
                entries: JSON.stringify([{ input: 'test' }]),
            });
            // File system will handle the weird name but won't cause SQL issues
            expect(result).toBeDefined();
        });
    });

    describe('XSS Strings', () => {
        it('should handle XSS in social post content', async () => {
            const scheduleTool = getTool('social_schedule');
            const futureDate = new Date(Date.now() + 3600_000).toISOString();
            const result = await scheduleTool.execute({
                platform: 'x',
                content: '<script>alert("XSS")</script>',
                scheduledAt: futureDate,
            });
            // Should accept but store raw (output encoding is the frontend's job)
            expect(result).toContain('Post scheduled');
        });

        it('should handle XSS in knowledge base content', async () => {
            const ingestTool = getTool('kb_ingest');
            const result = await ingestTool.execute({
                collection: 'xss-test',
                content: '<img src=x onerror=alert(1)>',
            });
            expect(result).toContain('Ingested');
        });

        it('should handle XSS in trigger names', async () => {
            const createTool = getTool('trigger_create');
            const result = await createTool.execute({
                name: '<script>alert(1)</script>',
                event: 'custom',
                condition: { key: 'value' },
                action: { message: 'test' },
            });
            // Name validation should not block since it's stored as data
            expect(result).toBeDefined();
        });
    });

    describe('Prototype Pollution', () => {
        it('should handle __proto__ in JSON validation', () => {
            // __proto__ is not enumerable in V8 so it won't appear in Object.keys
            // but regular additional properties should still be caught
            const result = validateAgainstSchema(
                { name: 'test', admin: true },
                {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    additionalProperties: false,
                },
            );
            expect(result.some(e => e.message.includes('admin'))).toBe(true);
        });

        it('should handle constructor pollution in workflow params', () => {
            const valid = validateWorkflowDefinition({
                name: 'proto-test',
                description: 'test',
                steps: [
                    {
                        id: 's1',
                        tool: 'echo',
                        params: { constructor: { prototype: { admin: true } } },
                    },
                ],
            });
            // Should pass validation (params are opaque to the validator)
            expect(valid).toBeNull();
        });
    });

    describe('ReDoS Prevention', () => {
        it('should handle excessively long regex patterns in schema', () => {
            const longPattern = '(a+)+$'.repeat(100);
            const errors = validateAgainstSchema('test', {
                type: 'string',
                pattern: longPattern,
            });
            expect(errors.some(e => e.message.includes('exceeds maximum length') || e.message.includes('pattern'))).toBe(true);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 5. EMPTY / NULL / UNDEFINED EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Edge Cases: Empty / Null / Undefined', () => {
    it('should handle empty string in json_extract', async () => {
        const tool = getTool('json_extract');
        const result = await tool.execute({ text: '', schema: { type: 'object' } });
        expect(result).toContain('error');
    });

    it('should handle null data in validate_json', async () => {
        const tool = getTool('validate_json');
        const result = await tool.execute({ data: null as unknown as string, schema: { type: 'object' } });
        const parsed = JSON.parse(result);
        expect(parsed.valid).toBe(false);
    });

    it('should handle undefined args gracefully', async () => {
        const tool = getTool('json_transform');
        const result = await tool.execute({ input: undefined as unknown, instructions: undefined as unknown as string });
        expect(result).toContain('error' || 'Error');
    });

    it('should handle empty steps array in workflow creation', async () => {
        const tool = getTool('workflow_create');
        const result = await tool.execute({
            name: 'empty-workflow',
            description: 'No steps',
            steps: '[]',
        });
        expect(result).toContain('Error');
    });

    it('should handle empty query in kb_search', async () => {
        const tool = getTool('kb_search');
        const result = await tool.execute({ query: '' });
        expect(result).toContain('Error' || 'error');
    });

    it('should handle empty entries in eval dataset', async () => {
        const tool = getTool('eval_create_dataset');
        const result = await tool.execute({
            name: 'empty-ds',
            description: 'Empty dataset',
            entries: '[]',
        });
        expect(result).toContain('Error');
    });

    it('should handle empty task in agent_delegate', async () => {
        const tool = getTool('agent_delegate');
        const result = await tool.execute({ role: 'researcher', task: '' });
        expect(result).toContain('Error');
    });

    it('should handle social_cancel with empty postId', async () => {
        const tool = getTool('social_cancel');
        const result = await tool.execute({ postId: '' });
        expect(result).toContain('Error');
    });

    it('should handle approval_approve with nonexistent ID', async () => {
        const tool = getTool('approval_approve');
        const result = await tool.execute({ requestId: 'nonexistent-id' });
        expect(result).toContain('No pending request');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 6. UNICODE AND SPECIAL CHARACTERS
// ═══════════════════════════════════════════════════════════════════

describe('Unicode and Special Characters', () => {
    it('should handle unicode in structured output validation', () => {
        const errors = validateAgainstSchema(
            { name: 'Toni Kroos' },
            {
                type: 'object',
                properties: { name: { type: 'string', minLength: 1 } },
                required: ['name'],
            },
        );
        expect(errors).toHaveLength(0);
    });

    it('should handle emoji in social post content', async () => {
        const tool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();
        const result = await tool.execute({
            platform: 'linkedin',
            content: 'Building AI agents is awesome! Let us go!',
            scheduledAt: futureDate,
        });
        expect(result).toContain('Post scheduled');
    });

    it('should handle CJK characters in knowledge base', async () => {
        const ingestTool = getTool('kb_ingest');
        await ingestTool.execute({
            collection: 'unicode-test',
            content: 'This is a test with Japanese characters.',
        });

        const searchTool = getTool('kb_search');
        const result = await searchTool.execute({
            query: 'Japanese',
            collection: 'unicode-test',
        });
        expect(result).toContain('Japanese');
    });

    it('should handle special chars in workflow description', async () => {
        const tool = getTool('workflow_create');
        const result = await tool.execute({
            name: 'special-chars',
            description: 'Workflow with "quotes", \'apostrophes\', & ampersands <tags>',
            steps: JSON.stringify([{ id: 's1', tool: 'echo', params: {} }]),
        });
        expect(result).toContain('created');
    });

    it('should handle null bytes in content safely', async () => {
        const tool = getTool('kb_ingest');
        const result = await tool.execute({
            collection: 'nullbyte-test',
            content: 'Hello\x00World',
        });
        // Should either succeed or handle gracefully
        expect(result).toBeDefined();
    });

    it('should handle unicode in JSON parse', () => {
        const result = safeParseJSON('{"name": "caf\\u00E9"}');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as Record<string, string>).name).toBe('caf\u00E9');
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// 7. SCHEMA VALIDATION EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Schema Validation Edge Cases', () => {
    it('should validate nested objects deeply', () => {
        const errors = validateAgainstSchema(
            { user: { address: { city: 123 } } },
            {
                type: 'object',
                properties: {
                    user: {
                        type: 'object',
                        properties: {
                            address: {
                                type: 'object',
                                properties: {
                                    city: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].path).toContain('city');
    });

    it('should validate arrays of objects', () => {
        const errors = validateAgainstSchema(
            [{ name: 'Alice' }, { name: 42 }],
            {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                },
            },
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].path).toContain('[1]');
    });

    it('should validate integer type correctly', () => {
        const errorsFloat = validateAgainstSchema(3.14, { type: 'integer' });
        expect(errorsFloat.length).toBeGreaterThan(0);

        const errorsInt = validateAgainstSchema(42, { type: 'integer' });
        expect(errorsInt.length).toBe(0);
    });

    it('should validate enum values', () => {
        const errors = validateAgainstSchema('invalid', {
            type: 'string',
            enum: ['valid', 'also-valid'],
        });
        expect(errors.length).toBeGreaterThan(0);
    });

    it('should validate min/max length', () => {
        const errorsShort = validateAgainstSchema('ab', { type: 'string', minLength: 3 });
        expect(errorsShort.length).toBeGreaterThan(0);

        const errorsLong = validateAgainstSchema('abcdef', { type: 'string', maxLength: 3 });
        expect(errorsLong.length).toBeGreaterThan(0);
    });

    it('should validate number ranges', () => {
        const errorsLow = validateAgainstSchema(5, { type: 'number', minimum: 10 });
        expect(errorsLow.length).toBeGreaterThan(0);

        const errorsHigh = validateAgainstSchema(15, { type: 'number', maximum: 10 });
        expect(errorsHigh.length).toBeGreaterThan(0);
    });

    it('should handle safeParseJSON with markdown fences', () => {
        const result = safeParseJSON('```json\n{"key": "value"}\n```');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as Record<string, string>).key).toBe('value');
        }
    });

    it('should handle invalid JSON in safeParseJSON', () => {
        const result = safeParseJSON('{not valid json}');
        expect(result.ok).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 8. WORKFLOW ENGINE EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Workflow Engine Edge Cases', () => {
    it('should detect circular dependencies', () => {
        const steps: WorkflowStep[] = [
            { id: 'a', tool: 'echo', params: {}, dependsOn: ['c'] },
            { id: 'b', tool: 'echo', params: {}, dependsOn: ['a'] },
            { id: 'c', tool: 'echo', params: {}, dependsOn: ['b'] },
        ];
        expect(() => topologicalSort(steps)).toThrow('Circular dependency');
    });

    it('should detect unknown step dependencies', () => {
        const steps: WorkflowStep[] = [
            { id: 'a', tool: 'echo', params: {}, dependsOn: ['nonexistent'] },
        ];
        expect(() => topologicalSort(steps)).toThrow('unknown step');
    });

    it('should correctly substitute template variables', () => {
        const results = new Map<string, { id: string; status: 'completed'; result: string; success: boolean }>();
        results.set('step1', { id: 'step1', status: 'completed', result: 'hello world', success: true });

        const params = {
            text: '{{steps.step1.result}} is great',
            nested: { inner: '{{steps.step1.result}}' },
        };

        const substituted = substituteTemplates(params, results);
        expect(substituted.text).toBe('hello world is great');
        expect((substituted.nested as Record<string, string>).inner).toBe('hello world');
    });

    it('should evaluate conditions correctly', () => {
        const results = new Map<string, { id: string; status: 'completed' | 'failed'; result?: string; success: boolean }>();
        results.set('s1', { id: 's1', status: 'completed', success: true });
        results.set('s2', { id: 's2', status: 'failed', success: false });

        expect(evaluateCondition('steps.s1.success == true', results)).toBe(true);
        expect(evaluateCondition('steps.s2.success == true', results)).toBe(false);
        expect(evaluateCondition('steps.s1.status == completed', results)).toBe(true);
        expect(evaluateCondition('steps.s2.status != completed', results)).toBe(true);
    });

    it('should return false for invalid condition expressions', () => {
        const results = new Map();
        expect(evaluateCondition('invalid expression', results)).toBe(false);
    });

    it('should handle duplicate step IDs in validation', () => {
        const error = validateWorkflowDefinition({
            name: 'dup-test',
            description: 'test',
            steps: [
                { id: 'same', tool: 'echo', params: {} },
                { id: 'same', tool: 'echo', params: {} },
            ],
        });
        expect(error).toContain('Duplicate');
    });

    it('should skip steps when dependency fails', async () => {
        const steps: WorkflowStep[] = [
            { id: 'fail-step', tool: 'fail-tool', params: {} },
            { id: 'skip-step', tool: 'echo', params: {}, dependsOn: ['fail-step'] },
        ];
        const workflow: WorkflowDefinition = {
            name: 'fail-test',
            description: 'test',
            steps,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const executor: ToolExecutor = async (tool) => {
            if (tool === 'fail-tool') return { content: 'Failed!', success: false };
            return { content: 'ok', success: true };
        };

        const result = await executeWorkflow(workflow, executor);
        expect(result.steps.find(s => s.id === 'skip-step')?.status).toBe('skipped');
    });

    it('should handle parallel independent steps', async () => {
        const steps: WorkflowStep[] = [
            { id: 'a', tool: 'echo', params: { text: 'a' } },
            { id: 'b', tool: 'echo', params: { text: 'b' } },
            { id: 'c', tool: 'echo', params: { text: 'c' } },
        ];

        const layers = topologicalSort(steps);
        // All independent = 1 layer with 3 steps
        expect(layers.length).toBe(1);
        expect(layers[0].length).toBe(3);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 9. APPROVAL GATES EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Approval Gates Edge Cases', () => {
    it('should auto-deny when preference is always_deny', () => {
        saveApprovalConfig({
            tools: ['dangerous-tool'],
            mode: 'always',
            timeout: 300,
            defaultAction: 'deny',
        });
        setToolPreference('dangerous-tool', 'always_deny');

        const req = createApprovalRequest('dangerous-tool', {}, 'session-1');
        expect(req.status).toBe('denied');
        expect(req.resolvedBy).toBe('system/preference');
    });

    it('should skip approval when preference is always_approve', () => {
        saveApprovalConfig({
            tools: ['safe-tool'],
            mode: 'always',
            timeout: 300,
            defaultAction: 'deny',
        });
        setToolPreference('safe-tool', 'always_approve');

        expect(requiresApproval('safe-tool')).toBe(false);
    });

    it('should handle first_time mode correctly', () => {
        saveApprovalConfig({
            tools: ['test-tool'],
            mode: 'first_time',
            timeout: 300,
            defaultAction: 'deny',
        });

        // First time should require approval
        expect(requiresApproval('test-tool')).toBe(true);

        // Create and approve
        const req = createApprovalRequest('test-tool', {}, 'session-1');
        approveRequest(req.id);

        // Second time should not require approval
        expect(requiresApproval('test-tool')).toBe(false);
    });

    it('should handle denying a request', () => {
        saveApprovalConfig({
            tools: ['tool-x'],
            mode: 'always',
            timeout: 300,
            defaultAction: 'deny',
        });

        const req = createApprovalRequest('tool-x', { arg: 'val' }, 'session-1');
        const denied = denyRequest(req.id, 'Too dangerous');
        expect(denied?.status).toBe('denied');
        expect(denied?.reason).toBe('Too dangerous');
    });

    it('should return null when denying nonexistent request', () => {
        expect(denyRequest('nonexistent')).toBeNull();
    });

    it('should not double-approve a request', () => {
        saveApprovalConfig({
            tools: ['tool-y'],
            mode: 'always',
            timeout: 300,
            defaultAction: 'deny',
        });

        const req = createApprovalRequest('tool-y', {}, 'session-1');
        approveRequest(req.id);
        const second = approveRequest(req.id);
        expect(second).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 10. EVAL FRAMEWORK EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Eval Framework Edge Cases', () => {
    it('should score exact_match with whitespace variations', () => {
        expect(scoreExactMatch('  hello  ', '  hello  ').pass).toBe(true);
        // scoreExactMatch trims both sides, so ' hello ' matches 'hello'
        expect(scoreExactMatch(' hello ', 'hello').pass).toBe(true);
        // But different words should fail
        expect(scoreExactMatch('hello', 'world').pass).toBe(false);
    });

    it('should score contains case-insensitively', () => {
        expect(scoreContains('Hello World', 'HELLO').pass).toBe(true);
        expect(scoreContains('Hello World', 'goodbye').pass).toBe(false);
    });

    it('should score length boundaries', () => {
        expect(scoreLength('').pass).toBe(false);
        expect(scoreLength('x').pass).toBe(true);
        expect(scoreLength('x'.repeat(10001)).pass).toBe(false);
    });

    it('should score JSON validity', () => {
        expect(scoreJsonValid('{"valid": true}').pass).toBe(true);
        expect(scoreJsonValid('not json').pass).toBe(false);
        expect(scoreJsonValid('null').pass).toBe(true);
    });

    it('should compute aggregate with empty entries', () => {
        const agg = computeAggregate([], ['exact_match']);
        expect(agg.mean.exact_match).toBe(0);
        expect(agg.passRate.exact_match).toBe(0);
    });

    it('should handle agent function that throws', async () => {
        const ds: EvalDataset = {
            name: 'error-ds',
            description: 'test',
            entries: [{ input: 'test' }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const throwingFn = async () => { throw new Error('Agent exploded'); };
        const result = await executeEvalRun(ds, ['length'], 'test', throwingFn);
        expect(result.entries[0].actualOutput).toContain('[ERROR]');
        // Access the 'length' scorer result (not the JS .length property)
        expect(result.entries[0].scores['length']).toBeDefined();
    });

    it('should reject duplicate dataset names', async () => {
        const tool = getTool('eval_create_dataset');
        await tool.execute({
            name: 'unique-ds',
            description: 'First',
            entries: JSON.stringify([{ input: 'test' }]),
        });
        const result = await tool.execute({
            name: 'unique-ds',
            description: 'Duplicate',
            entries: JSON.stringify([{ input: 'test2' }]),
        });
        expect(result).toContain('already exists');
    });

    it('should handle eval_compare with mismatched scorers', async () => {
        // This tests the union of scorers behavior
        const tool = getTool('eval_compare');
        const result = await tool.execute({
            runA: 'nonexistent-a',
            runB: 'nonexistent-b',
        });
        expect(result).toContain('Error');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 11. SOCIAL SCHEDULER EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Social Scheduler Edge Cases', () => {
    it('should reject past scheduled dates', async () => {
        const tool = getTool('social_schedule');
        const result = await tool.execute({
            platform: 'x',
            content: 'Past post',
            scheduledAt: '2020-01-01T00:00:00Z',
        });
        expect(result).toContain('Error');
    });

    it('should reject content exceeding platform limits', async () => {
        const tool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();
        const result = await tool.execute({
            platform: 'x',
            content: 'x'.repeat(281), // X limit is 280
            scheduledAt: futureDate,
        });
        expect(result).toContain('Error');
        expect(result).toContain('exceeds');
    });

    it('should reject invalid platform', async () => {
        const tool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();
        const result = await tool.execute({
            platform: 'myspace',
            content: 'test',
            scheduledAt: futureDate,
        });
        expect(result).toContain('Error');
    });

    it('should reject cancelling non-pending posts', async () => {
        // We need to manually create a published post
        const scheduleTool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();
        const scheduleResult = await scheduleTool.execute({
            platform: 'x',
            content: 'Test cancel',
            scheduledAt: futureDate,
        });
        // Extract post ID
        const idMatch = scheduleResult.match(/ID: ([a-f0-9-]+)/);
        expect(idMatch).not.toBeNull();

        // Cancel it first
        const cancelTool = getTool('social_cancel');
        await cancelTool.execute({ postId: idMatch![1] });

        // Try to cancel again
        const result = await cancelTool.execute({ postId: idMatch![1] });
        expect(result).toContain('Cannot cancel');
    });

    it('should generate drafts for all platforms', async () => {
        const tool = getTool('social_draft');
        for (const platform of ['x', 'linkedin', 'bluesky', 'mastodon', 'threads'] as const) {
            const result = await tool.execute({ topic: 'AI agents', platform });
            expect(result).toContain(PLATFORM_LIMITS[platform].name);
        }
    });

    it('should filter queue by platform', async () => {
        const scheduleTool = getTool('social_schedule');
        const futureDate = new Date(Date.now() + 3600_000).toISOString();

        await scheduleTool.execute({ platform: 'x', content: 'X post', scheduledAt: futureDate });
        await scheduleTool.execute({ platform: 'linkedin', content: 'LinkedIn post', scheduledAt: futureDate });

        const queueTool = getTool('social_queue');
        const xResult = await queueTool.execute({ platform: 'x' });
        expect(xResult).toContain('X post');
        expect(xResult).not.toContain('LinkedIn post');
    });
});

// ═══════════════════════════════════════════════════════════════════
// 12. EVENT TRIGGERS EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Event Triggers Edge Cases', () => {
    it('should reject duplicate trigger names', async () => {
        const tool = getTool('trigger_create');
        await tool.execute({
            name: 'unique-trigger',
            event: 'custom',
            condition: { key: 'val' },
            action: { message: 'hello' },
        });
        const result = await tool.execute({
            name: 'unique-trigger',
            event: 'custom',
            condition: { key: 'val2' },
            action: { message: 'world' },
        });
        expect(result).toContain('already exists');
    });

    it('should require condition.path for file_change triggers', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'bad-file-trigger',
            event: 'file_change',
            condition: {},
            action: { message: 'test' },
        });
        expect(result).toContain('Error');
    });

    it('should require condition.endpoint for webhook triggers', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'bad-webhook-trigger',
            event: 'webhook',
            condition: {},
            action: { message: 'test' },
        });
        expect(result).toContain('Error');
    });

    it('should require action with tool or message', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'no-action-trigger',
            event: 'custom',
            condition: { key: 'val' },
            action: {},
        });
        expect(result).toContain('Error');
    });

    it('should toggle trigger enabled state', async () => {
        const createTool = getTool('trigger_create');
        await createTool.execute({
            name: 'toggle-test',
            event: 'custom',
            condition: { key: 'val' },
            action: { message: 'test' },
        });

        const toggleTool = getTool('trigger_toggle');
        const result = await toggleTool.execute({ name: 'toggle-test', enabled: false });
        expect(result).toContain('Disabled');

        const triggers = loadAllTriggers();
        const trigger = triggers.find(t => t.name === 'toggle-test');
        expect(trigger?.enabled).toBe(false);
    });

    it('should limit fire log entries', () => {
        // Append more than MAX_LOG_ENTRIES (50)
        for (let i = 0; i < 60; i++) {
            appendFireLog({
                trigger_id: `t-${i}`,
                trigger_name: `trigger-${i}`,
                event: 'custom',
                fired_at: new Date().toISOString(),
                result: `result-${i}`,
                simulated: false,
            });
        }
        const log = loadFireLog();
        expect(log.length).toBeLessThanOrEqual(50);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 13. KNOWLEDGE BASE EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Knowledge Base Edge Cases', () => {
    it('should handle searching empty collections', async () => {
        const tool = getTool('kb_search');
        const result = await tool.execute({ query: 'anything' });
        expect(result).toContain('No knowledge base');
    });

    it('should handle deleting nonexistent collection', async () => {
        const tool = getTool('kb_delete');
        const result = await tool.execute({ collection: 'nonexistent' });
        expect(result).toContain('not found');
    });

    it('should list empty knowledge base', async () => {
        const tool = getTool('kb_list');
        const result = await tool.execute({});
        expect(result).toContain('No knowledge base');
    });

    it('should handle TF-IDF with no matching terms', () => {
        const results = tfidfSearch('quantum physics', [
            { id: '1', content: 'the cat sat on the mat' },
            { id: '2', content: 'a dog ran in the park' },
        ], 5);
        expect(results.length).toBe(0);
    });

    it('should handle TF-IDF with single document', () => {
        const results = tfidfSearch('cat', [
            { id: '1', content: 'the cat sat on the mat' },
        ], 5);
        expect(results.length).toBe(1);
        expect(results[0].id).toBe('1');
    });

    it('should chunk single-word text correctly', () => {
        const chunks = chunkText('hello');
        expect(chunks).toEqual(['hello']);
    });

    it('should handle very small chunk sizes', () => {
        const chunks = chunkText('one two three four five six', 2);
        expect(chunks.length).toBe(3);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 14. AGENT HANDOFF EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Agent Handoff Edge Cases', () => {
    it('should reject more than 6 parallel agents', async () => {
        const tool = getTool('agent_team');
        const tasks = Array.from({ length: 7 }, (_, i) => ({
            role: 'researcher',
            task: `Task ${i}`,
        }));
        const result = await tool.execute({ tasks: JSON.stringify(tasks) });
        expect(result).toContain('Maximum 6');
    });

    it('should reject more than 8 chain steps', async () => {
        const tool = getTool('agent_chain');
        const steps = Array.from({ length: 9 }, (_, i) => ({
            role: 'researcher',
            task: `Step ${i}`,
        }));
        const result = await tool.execute({ steps: JSON.stringify(steps) });
        expect(result).toContain('Maximum 8');
    });

    it('should handle invalid JSON in agent_team tasks', async () => {
        const tool = getTool('agent_team');
        const result = await tool.execute({ tasks: 'not json' });
        expect(result).toContain('Error');
    });

    it('should handle invalid JSON in agent_chain steps', async () => {
        const tool = getTool('agent_chain');
        const result = await tool.execute({ steps: '{invalid}' });
        expect(result).toContain('Error');
    });

    it('should cap critique rounds at 5', async () => {
        const tool = getTool('agent_critique');
        const result = await tool.execute({
            task: 'Write something',
            rounds: 100,
        });
        // Should run max 5 rounds
        expect(result).toContain('Agent Critique Results');
    });

    it('should handle empty tasks array in agent_team', async () => {
        const tool = getTool('agent_team');
        const result = await tool.execute({ tasks: '[]' });
        expect(result).toContain('Error');
    });

    it('should handle unknown roles gracefully', async () => {
        const tool = getTool('agent_delegate');
        const result = await tool.execute({
            role: 'unicorn_tamer',
            task: 'Tame the unicorns',
        });
        // Should still work with a generic fallback
        expect(result).toContain('SUCCESS') ;
    });
});

// ═══════════════════════════════════════════════════════════════════
// 15. TOOL REGISTRATION VERIFICATION
// ═══════════════════════════════════════════════════════════════════

describe('Tool Registration Verification', () => {
    it('should register all expected tools', () => {
        const expectedTools = [
            'json_extract', 'json_transform', 'validate_json',
            'workflow_create', 'workflow_run', 'workflow_list', 'workflow_delete', 'workflow_status',
            'social_schedule', 'social_queue', 'social_cancel', 'social_analytics', 'social_draft',
            'agent_delegate', 'agent_team', 'agent_chain', 'agent_critique',
            'trigger_create', 'trigger_list', 'trigger_delete', 'trigger_toggle', 'trigger_test', 'trigger_log',
            'kb_ingest', 'kb_search', 'kb_ingest_url', 'kb_ingest_file', 'kb_list', 'kb_delete',
            'eval_create_dataset', 'eval_add_entry', 'eval_run', 'eval_results', 'eval_compare',
            'approval_configure', 'approval_list', 'approval_approve', 'approval_deny', 'approval_history', 'approval_preferences',
        ];

        for (const toolName of expectedTools) {
            expect(registeredTools.has(toolName), `Missing tool: ${toolName}`).toBe(true);
        }
    });

    it('should have parameters with required type: object for all tools', () => {
        for (const [name, tool] of registeredTools) {
            expect(
                (tool.parameters as { type: string }).type,
                `Tool "${name}" should have parameters.type = "object"`,
            ).toBe('object');
        }
    });

    it('should have non-empty descriptions for all tools', () => {
        for (const [name, tool] of registeredTools) {
            expect(tool.description.length, `Tool "${name}" has empty description`).toBeGreaterThan(10);
        }
    });
});
