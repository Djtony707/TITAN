/**
 * TITAN — Auto-mode precedence regression (v6.1.0-beta.17)
 *
 * Codex P1 #1: explicit user approval config MUST win over the
 * classifier. The beta.16 wire-in had these reversed — the classifier
 * could declare `auto` for a tool the user had explicitly added to
 * their approval list, silently bypassing user intent.
 *
 * This test reaches into the toolRunner via a mocked approval_gates
 * module and asserts the precedence: when `requiresApproval()`
 * returns true, the call gets gated even if the classifier returned
 * `auto`. Belt-and-suspenders coverage for the precedence rule
 * defined in toolRunner.ts Step 1 / Step 2 comments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const { configHolder, approvalState } = vi.hoisted(() => ({
    configHolder: { current: {} as Record<string, unknown> },
    approvalState: {
        requireFor: new Set<string>(),
        createCalls: [] as Array<{ tool: string; args: unknown }>,
    },
}));

// Mock the config so the classifier reads 'standard' policy.
vi.mock('../src/config/config.js', () => ({
    loadConfig: () => configHolder.current,
}));

// Mock the approval_gates skill module so we can drive
// requiresApproval()/createApprovalRequest() from the test.
vi.mock('../src/skills/builtin/approval_gates.js', () => ({
    requiresApproval: (tool: string) => approvalState.requireFor.has(tool),
    createApprovalRequest: (tool: string, args: unknown) => {
        approvalState.createCalls.push({ tool, args });
        return { id: `req-${tool}`, status: 'pending' as const, decision: undefined };
    },
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Plugin / telemetry stubs so toolRunner doesn't try to load real ones.
vi.mock('../src/plugins/contextEngine.js', () => ({
    runPreTool: async (_args: unknown) => ({ args: _args }),
    runPostTool: async (_result: unknown) => _result,
    listPlugins: () => [],
}));

vi.mock('../src/telemetry/activityLog.js', () => ({
    logActivity: vi.fn(),
}));

import { executeTools, registerTool, unregisterTool } from '../src/agent/toolRunner.js';
import {
    registerToolContract,
    clearToolContracts,
    type ToolContract,
} from '../src/agent/toolContract.js';

/* ──────────────────────────  Helpers  ────────────────────────── */

/**
 * Build a config skeleton the tool runner can read. We supply the
 * minimum surface — security fields it indexes into + agent fields
 * + autoMode policy — so the runner doesn't trip on a missing
 * property mid-dispatch. Real config builds the full Zod object; we
 * only need the keys the dispatch path touches.
 */
function setPolicy(policy?: string): void {
    configHolder.current = {
        agent: { model: 'stub/echo' },
        security: {
            sandboxMode: 'host',
            allowedTools: [] as string[],
            deniedTools: [] as string[],
            redactPII: false,
            secretScan: { level: 'tool_only' },
            preExecScan: 'off',
            preExecScanAllow: [] as string[],
            autoMode: { policy: policy ?? 'standard' },
        },
        organism: {},
    };
}

function safeContract(name: string): ToolContract {
    return {
        name,
        summary: `safe test contract for ${name}`,
        input: z.object({}),
        sideEffects: ['read'],
        riskLevel: 'safe',
        exampleCalls: [{ description: 'ex', args: {} }],
    };
}

const TOOL_NAME = 'test-precedence-tool';

beforeEach(() => {
    clearToolContracts();
    approvalState.requireFor.clear();
    approvalState.createCalls = [];
    setPolicy('standard');

    // (Re-)register the test tool — its execute() is never called in
    // these tests because we assert on the gate response, but it has
    // to be registered so the runner can find it.
    try { unregisterTool(TOOL_NAME); } catch { /* not registered yet */ }
    registerTool({
        name: TOOL_NAME,
        description: 'tool used to test classifier/approval precedence',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'should not be reached when gated',
    });
});

/* ──────────────────────────  Tests  ────────────────────────── */

describe('Auto-mode + approval-gate precedence (Codex P1 #1)', () => {
    it('classifier says auto → call runs without gating (baseline)', async () => {
        registerToolContract(safeContract(TOOL_NAME));
        approvalState.requireFor.clear(); // user has not added the tool

        const results = await executeTools([{
            id: 'tc-1',
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{}' },
        }]);

        expect(results).toHaveLength(1);
        expect(results[0].approvalPending).toBeFalsy();
        expect(results[0].content).not.toMatch(/Awaiting approval/);
        expect(approvalState.createCalls).toHaveLength(0);
    });

    it('REGRESSION: classifier says auto BUT user requires approval → call IS gated', async () => {
        // The exact bug Codex caught. Pre-beta.17 this returned the
        // tool's result, bypassing the user's explicit approval list.
        registerToolContract(safeContract(TOOL_NAME));
        approvalState.requireFor.add(TOOL_NAME);

        const results = await executeTools([{
            id: 'tc-2',
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{}' },
        }]);

        expect(results).toHaveLength(1);
        expect(results[0].approvalPending).toBe(true);
        expect(results[0].content).toMatch(/Awaiting approval/);
        expect(approvalState.createCalls).toHaveLength(1);
        expect(approvalState.createCalls[0].tool).toBe(TOOL_NAME);
    });

    it('user requires approval AND classifier says gate → still gated, once', async () => {
        // High-risk contract — classifier returns 'gate'.
        const c = safeContract(TOOL_NAME);
        c.riskLevel = 'high';
        registerToolContract(c);
        approvalState.requireFor.add(TOOL_NAME);

        const results = await executeTools([{
            id: 'tc-3',
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{}' },
        }]);

        expect(results[0].approvalPending).toBe(true);
        // Exactly one approval request — we don't want belt-and-
        // suspenders to file TWO requests for the same call.
        expect(approvalState.createCalls).toHaveLength(1);
    });

    it('classifier says gate AND user does NOT require approval → still gated (classifier path)', async () => {
        const c = safeContract(TOOL_NAME);
        c.riskLevel = 'high';
        registerToolContract(c);
        approvalState.requireFor.clear();

        const results = await executeTools([{
            id: 'tc-4',
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{}' },
        }]);

        expect(results[0].approvalPending).toBe(true);
        expect(approvalState.createCalls).toHaveLength(1);
    });

    it('paranoid policy gates a "safe" contract regardless of user config', async () => {
        setPolicy('paranoid');
        registerToolContract(safeContract(TOOL_NAME));
        approvalState.requireFor.clear();

        const results = await executeTools([{
            id: 'tc-5',
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{}' },
        }]);

        expect(results[0].approvalPending).toBe(true);
    });
});
