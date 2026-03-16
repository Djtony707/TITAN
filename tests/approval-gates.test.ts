/**
 * TITAN — Approval Gates Skill Tests
 * Tests src/skills/builtin/approval_gates.ts: HITL approval gate tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture registered skills/tools
const registeredTools: Map<string, { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> }> = new Map();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, tool: unknown) => {
        const t = tool as { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> };
        registeredTools.set(t.name, t);
    },
}));

// Mock fs — in-memory file store
const fileStore: Map<string, string> = new Map();
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: (p: string) => fileStore.has(p),
        readFileSync: (p: string) => {
            const data = fileStore.get(p);
            if (!data) throw new Error(`ENOENT: ${p}`);
            return data;
        },
        writeFileSync: (p: string, data: string) => { fileStore.set(p, data); },
        mkdirSync: vi.fn(),
    };
});

import {
    registerApprovalGatesSkill,
    loadConfig,
    saveConfig,
    loadHistory,
    requiresApproval,
    createApprovalRequest,
    getPendingRequests,
    approveRequest,
    denyRequest,
    setToolPreference,
    getToolPreference,
    _resetState,
} from '../src/skills/builtin/approval_gates.js';

// ─── Helpers ────────────────────────────────────────────────────

function getTool(name: string) {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not registered`);
    return tool;
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
    registeredTools.clear();
    fileStore.clear();
    _resetState();
    registerApprovalGatesSkill();
});

afterEach(() => {
    _resetState();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Approval Gates Skill', () => {

    // ── Registration ──────────────────────────────────────────────

    it('registers all 6 approval tools', () => {
        expect(registeredTools.has('approval_configure')).toBe(true);
        expect(registeredTools.has('approval_list')).toBe(true);
        expect(registeredTools.has('approval_approve')).toBe(true);
        expect(registeredTools.has('approval_deny')).toBe(true);
        expect(registeredTools.has('approval_history')).toBe(true);
        expect(registeredTools.has('approval_preferences')).toBe(true);
    });

    // ── Configuration CRUD ────────────────────────────────────────

    it('saves and loads config', async () => {
        const tool = getTool('approval_configure');
        await tool.execute({ tools: ['shell', 'code_exec'], mode: 'always', timeout: 60, defaultAction: 'deny' });

        const config = loadConfig();
        expect(config.tools).toEqual(['shell', 'code_exec']);
        expect(config.mode).toBe('always');
        expect(config.timeout).toBe(60);
        expect(config.defaultAction).toBe('deny');
    });

    it('merges partial config updates', async () => {
        const tool = getTool('approval_configure');
        await tool.execute({ tools: ['shell'], mode: 'always', timeout: 120, defaultAction: 'deny' });
        await tool.execute({ timeout: 30 });

        const config = loadConfig();
        expect(config.tools).toEqual(['shell']);
        expect(config.timeout).toBe(30);
        expect(config.mode).toBe('always');
    });

    it('returns formatted config summary', async () => {
        const tool = getTool('approval_configure');
        const result = await tool.execute({ tools: ['shell'], mode: 'first_time' });
        expect(result).toContain('shell');
        expect(result).toContain('first_time');
    });

    it('handles empty tools list', async () => {
        const tool = getTool('approval_configure');
        const result = await tool.execute({ tools: [], mode: 'never' });
        expect(result).toContain('(none)');
    });

    // ── Approval / Denial Flow ────────────────────────────────────

    it('creates a pending approval request', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'rm -rf /' }, 'session-1');
        expect(req.status).toBe('pending');
        expect(req.tool).toBe('shell');
        expect(getPendingRequests()).toHaveLength(1);
    });

    it('approves a pending request', async () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');

        const tool = getTool('approval_approve');
        const result = await tool.execute({ requestId: req.id, note: 'Looks safe' });
        expect(result).toContain('Approved');
        expect(result).toContain('shell');
        expect(getPendingRequests()).toHaveLength(0);
    });

    it('denies a pending request', async () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'rm -rf /' }, 'session-1');

        const tool = getTool('approval_deny');
        const result = await tool.execute({ requestId: req.id, reason: 'Too dangerous' });
        expect(result).toContain('Denied');
        expect(result).toContain('shell');
        expect(getPendingRequests()).toHaveLength(0);
    });

    it('returns error for non-existent request ID on approve', async () => {
        const tool = getTool('approval_approve');
        const result = await tool.execute({ requestId: 'fake-id' });
        expect(result).toContain('No pending request');
    });

    it('returns error for non-existent request ID on deny', async () => {
        const tool = getTool('approval_deny');
        const result = await tool.execute({ requestId: 'fake-id' });
        expect(result).toContain('No pending request');
    });

    it('lists pending requests', async () => {
        saveConfig({ tools: ['shell', 'code_exec'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        createApprovalRequest('shell', { command: 'ls' }, 'session-1');
        createApprovalRequest('code_exec', { code: 'print(1)' }, 'session-2');

        const tool = getTool('approval_list');
        const result = await tool.execute({});
        expect(result).toContain('shell');
        expect(result).toContain('code_exec');
    });

    it('shows empty message when no pending requests', async () => {
        const tool = getTool('approval_list');
        const result = await tool.execute({});
        expect(result).toContain('No pending');
    });

    // ── Timeout Behavior ──────────────────────────────────────────

    it('auto-denies on timeout when defaultAction is deny', async () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 1, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');
        expect(req.status).toBe('pending');

        // Wait for timeout (1 second + buffer)
        await new Promise(r => setTimeout(r, 1500));

        expect(getPendingRequests()).toHaveLength(0);
        const history = loadHistory();
        expect(history.length).toBeGreaterThanOrEqual(1);
        const entry = history.find(h => h.id === req.id);
        expect(entry?.decision).toBe('timed_out');
    });

    it('auto-approves on timeout when defaultAction is allow', async () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 1, defaultAction: 'allow' });
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');

        await new Promise(r => setTimeout(r, 1500));

        const history = loadHistory();
        const entry = history.find(h => h.id === req.id);
        expect(entry?.decision).toBe('approved');
    });

    // ── Preferences ───────────────────────────────────────────────

    it('sets and retrieves tool preferences', async () => {
        const tool = getTool('approval_preferences');
        await tool.execute({ tool: 'shell', action: 'always_approve' });
        expect(getToolPreference('shell')).toBe('always_approve');
    });

    it('always_approve preference bypasses approval', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        setToolPreference('shell', 'always_approve');
        expect(requiresApproval('shell')).toBe(false);
    });

    it('always_deny preference requires approval (auto-denied)', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        setToolPreference('shell', 'always_deny');
        // requiresApproval returns true because auto-deny still needs to go through the flow
        expect(requiresApproval('shell')).toBe(true);

        // But createApprovalRequest auto-denies immediately
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');
        expect(req.status).toBe('denied');
        expect(req.reason).toContain('Auto-denied');
        expect(getPendingRequests()).toHaveLength(0);
    });

    it('ask preference defers to config', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        setToolPreference('shell', 'ask');
        expect(requiresApproval('shell')).toBe(true);
    });

    it('rejects invalid preference action', async () => {
        const tool = getTool('approval_preferences');
        const result = await tool.execute({ tool: 'shell', action: 'invalid_action' });
        expect(result).toContain('Invalid action');
    });

    // ── requiresApproval logic ────────────────────────────────────

    it('returns false for tools not in the config list', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        expect(requiresApproval('read_file')).toBe(false);
    });

    it('returns false when mode is never', () => {
        saveConfig({ tools: ['shell'], mode: 'never', timeout: 300, defaultAction: 'deny' });
        expect(requiresApproval('shell')).toBe(false);
    });

    it('first_time mode skips after first approval', () => {
        saveConfig({ tools: ['shell'], mode: 'first_time', timeout: 300, defaultAction: 'deny' });
        expect(requiresApproval('shell')).toBe(true);

        // Simulate approval
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');
        approveRequest(req.id);

        // Now should not require approval
        expect(requiresApproval('shell')).toBe(false);
    });

    // ── History Tracking ──────────────────────────────────────────

    it('records approval in history', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');
        approveRequest(req.id, 'Reviewed and safe');

        const history = loadHistory();
        expect(history).toHaveLength(1);
        expect(history[0].decision).toBe('approved');
        expect(history[0].note).toBe('Reviewed and safe');
        expect(history[0].tool).toBe('shell');
    });

    it('records denial in history', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'rm -rf /' }, 'session-1');
        denyRequest(req.id, 'Dangerous');

        const history = loadHistory();
        expect(history).toHaveLength(1);
        expect(history[0].decision).toBe('denied');
        expect(history[0].reason).toBe('Dangerous');
    });

    it('approval_history tool respects limit', async () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        // Create and approve 5 requests
        for (let i = 0; i < 5; i++) {
            const req = createApprovalRequest('shell', { i }, `session-${i}`);
            approveRequest(req.id);
        }

        const tool = getTool('approval_history');
        const result = await tool.execute({ limit: 3 });
        // Should show last 3 entries
        const lines = result.split('\n').filter((l: string) => l.startsWith('•'));
        expect(lines).toHaveLength(3);
    });

    it('approval_history shows empty message', async () => {
        const tool = getTool('approval_history');
        const result = await tool.execute({});
        expect(result).toContain('No approval history');
    });

    // ── Error Handling ────────────────────────────────────────────

    it('cannot approve the same request twice', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');
        const first = approveRequest(req.id);
        const second = approveRequest(req.id);
        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });

    it('cannot deny an already approved request', () => {
        saveConfig({ tools: ['shell'], mode: 'always', timeout: 300, defaultAction: 'deny' });
        const req = createApprovalRequest('shell', { command: 'ls' }, 'session-1');
        approveRequest(req.id);
        const result = denyRequest(req.id);
        expect(result).toBeNull();
    });

    it('handles default config when no file exists', () => {
        const config = loadConfig();
        expect(config.tools).toEqual([]);
        expect(config.mode).toBe('always');
        expect(config.timeout).toBe(300);
        expect(config.defaultAction).toBe('deny');
    });
});
