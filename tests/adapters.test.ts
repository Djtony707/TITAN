/**
 * TITAN — External Agent Adapter Tests
 * Tests the adapter registry and adapter execution patterns.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks
import { getAdapter, listAdapters, registerAdapter, type ExternalAdapter, type AdapterContext } from '../src/agent/adapters/index.js';
import { useExternalCliFixture } from './helpers/external-cli-fixture.js';

const cliFixture = useExternalCliFixture();

describe('Adapter Registry', () => {
    it('does not register or advertise the prohibited Claude adapter', () => {
        expect(getAdapter('claude-code')).toBeNull();
        expect(listAdapters()).not.toContain('claude-code');
    });

    it('should have codex adapter registered', () => {
        const adapter = getAdapter('codex');
        expect(adapter).not.toBeNull();
        expect(adapter!.type).toBe('codex');
        expect(adapter!.displayName).toBe('Codex');
    });

    it('should have bash adapter registered', () => {
        const adapter = getAdapter('bash');
        expect(adapter).not.toBeNull();
        expect(adapter!.type).toBe('bash');
        expect(adapter!.displayName).toBe('Bash');
    });

    it('should return null for unknown adapter', () => {
        expect(getAdapter('unknown-adapter')).toBeNull();
    });

    it('should list all registered adapters', () => {
        const types = listAdapters();
        expect(types).not.toContain('claude-code');
        expect(types).toContain('codex');
        expect(types).toContain('bash');
        expect(types.length).toBeGreaterThanOrEqual(2);
    });

    it('should support custom adapter registration', () => {
        const custom: ExternalAdapter = {
            type: 'test-adapter',
            displayName: 'Test',
            execute: async () => ({ content: 'test', exitCode: 0, success: true, durationMs: 0, toolsUsed: [] }),
        };
        registerAdapter(custom);
        expect(getAdapter('test-adapter')).toBe(custom);
    });
});

describe('Bash Adapter', () => {
    it('should execute a simple echo command', async () => {
        const adapter = getAdapter('bash')!;
        const ctx: AdapterContext = {
            task: 'echo "hello from titan"',
            titanApiUrl: 'http://localhost:48420',
            titanRunId: 'test-run-1',
            titanIssueId: 'test-issue-1',
            timeoutMs: 10_000,
        };
        const result = await adapter.execute(ctx);
        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.content).toContain('hello from titan');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.toolsUsed).toContain('bash');
    });

    it('should capture exit code on failure', async () => {
        const adapter = getAdapter('bash')!;
        const ctx: AdapterContext = {
            task: 'exit 42',
            titanApiUrl: 'http://localhost:48420',
            titanRunId: 'test-run-2',
            titanIssueId: 'test-issue-2',
            timeoutMs: 10_000,
        };
        const result = await adapter.execute(ctx);
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(42);
    });

    it('should capture stderr', async () => {
        const adapter = getAdapter('bash')!;
        const ctx: AdapterContext = {
            task: 'echo "error msg" >&2',
            titanApiUrl: 'http://localhost:48420',
            titanRunId: 'test-run-3',
            titanIssueId: 'test-issue-3',
            timeoutMs: 10_000,
        };
        const result = await adapter.execute(ctx);
        expect(result.content).toContain('error msg');
    });

    it('should inject TITAN env vars', async () => {
        const adapter = getAdapter('bash')!;
        const ctx: AdapterContext = {
            task: 'echo $TITAN_API_URL $TITAN_RUN_ID $TITAN_ISSUE_ID',
            titanApiUrl: 'http://localhost:48420',
            titanRunId: 'run-xyz',
            titanIssueId: 'issue-abc',
            timeoutMs: 10_000,
        };
        const result = await adapter.execute(ctx);
        expect(result.content).toContain('http://localhost:48420');
        expect(result.content).toContain('run-xyz');
        expect(result.content).toContain('issue-abc');
    });

    it('should respect timeout', async () => {
        const adapter = getAdapter('bash')!;
        const ctx: AdapterContext = {
            task: 'sleep 30',
            titanApiUrl: 'http://localhost:48420',
            titanRunId: 'test-run-4',
            titanIssueId: 'test-issue-4',
            timeoutMs: 500, // 500ms timeout
        };
        const result = await adapter.execute(ctx);
        expect(result.success).toBe(false);
        expect(result.content).toContain('timed out');
        expect(result.durationMs).toBeLessThan(5000);
    }, 10_000);

    it('should support custom env vars', async () => {
        const adapter = getAdapter('bash')!;
        const ctx: AdapterContext = {
            task: 'echo $MY_CUSTOM_VAR',
            titanApiUrl: 'http://localhost:48420',
            titanRunId: 'test-run-5',
            titanIssueId: 'test-issue-5',
            env: { MY_CUSTOM_VAR: 'custom_value_123' },
            timeoutMs: 10_000,
        };
        const result = await adapter.execute(ctx);
        expect(result.content).toContain('custom_value_123');
    });
});

describe('Claude Code Adapter', () => {
    it('rejects direct imports and forbidden adapter registration without execution', async () => {
        const { claudeCodeAdapter } = await import('../src/agent/adapters/claudeCode.js');
        const result = await claudeCodeAdapter.execute({ task: 'fixture', titanApiUrl: '', titanRunId: '', titanIssueId: '' });
        expect(result.success).toBe(false);
        expect(result.content).toContain('disabled by TITAN standing policy');
        expect(cliFixture.invocations()).toEqual([]);
        for (const type of ['claude', 'claude-code', 'claude_code', 'Claude Code']) {
            expect(() => registerAdapter({ ...claudeCodeAdapter, type })).toThrow(/disabled by TITAN standing policy/);
            expect(getAdapter(type)).toBeNull();
        }
    });
});

describe('Codex Adapter', () => {
    it('should pass stdin, arguments and callback metadata to a controlled Codex executable', async () => {
        const adapter = getAdapter('codex')!;
        const ctx: AdapterContext = {
            task: 'echo test',
            titanApiUrl: 'http://localhost:48420',
            titanRunId: 'test-run-7',
            titanIssueId: 'test-issue-7',
            timeoutMs: 5_000,
        };
        const result = await adapter.execute(ctx);
        expect(result.success).toBe(true);
        expect(result.content).toBe('synthetic-codex-result');
        expect(cliFixture.invocations()).toEqual([{
            cli: 'codex', args: ['exec', '--json', '-'], input: 'echo test',
            apiUrl: ctx.titanApiUrl, runId: ctx.titanRunId, issueId: ctx.titanIssueId,
        }]);
    });
});
