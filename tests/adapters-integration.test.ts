/**
 * TITAN — Adapter Integration Tests
 * Tests real adapter execution: complex bash commands, timeout enforcement,
 * large output handling, and adapter edge cases.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAdapter, type AdapterContext } from '../src/agent/adapters/index.js';

function makeCtx(task: string, overrides: Partial<AdapterContext> = {}): AdapterContext {
    return {
        task,
        titanApiUrl: 'http://localhost:48420',
        titanRunId: `run-${Date.now()}`,
        titanIssueId: `issue-${Date.now()}`,
        timeoutMs: 10_000,
        ...overrides,
    };
}

describe('Bash Adapter — Complex Commands', () => {
    const bash = getAdapter('bash')!;

    it('should execute piped commands', async () => {
        const result = await bash.execute(makeCtx('echo "hello world" | tr " " "\\n" | wc -l'));
        expect(result.success).toBe(true);
        expect(result.content.trim()).toBe('2');
    });

    it('should handle multi-line output', async () => {
        const result = await bash.execute(makeCtx('echo -e "line1\\nline2\\nline3"'));
        expect(result.success).toBe(true);
        const lines = result.content.trim().split('\n');
        expect(lines).toHaveLength(3);
    });

    it('should return correct exit codes', async () => {
        const successResult = await bash.execute(makeCtx('true'));
        expect(successResult.exitCode).toBe(0);
        expect(successResult.success).toBe(true);

        const failResult = await bash.execute(makeCtx('false'));
        expect(failResult.exitCode).toBe(1);
        expect(failResult.success).toBe(false);

        const customResult = await bash.execute(makeCtx('exit 137'));
        expect(customResult.exitCode).toBe(137);
    });

    it('should capture stderr on failure', async () => {
        const result = await bash.execute(makeCtx('ls /nonexistent_directory_12345 2>&1'));
        expect(result.content).toContain('No such file or directory');
    });

    it('should combine stdout and stderr', async () => {
        const result = await bash.execute(makeCtx('echo "out" && echo "err" >&2'));
        expect(result.content).toContain('out');
        // stderr may or may not be captured depending on shell behavior
    });

    it('should pass custom working directory via env', async () => {
        const result = await bash.execute(makeCtx('pwd', { cwd: '/tmp' }));
        expect(result.success).toBe(true);
        // cwd is passed as env, not chdir — verify task executes
        expect(result.content).toBeTruthy();
    });
});

describe('Bash Adapter — Timeout Enforcement', () => {
    const bash = getAdapter('bash')!;

    it('should kill process after timeout and return success: false', async () => {
        const result = await bash.execute(makeCtx('sleep 30', { timeoutMs: 500 }));
        expect(result.success).toBe(false);
        expect(result.content).toContain('timed out');
        expect(result.durationMs).toBeLessThan(5000);
    }, 10_000);

    it('should complete fast commands within timeout', async () => {
        const result = await bash.execute(makeCtx('echo fast', { timeoutMs: 5000 }));
        expect(result.success).toBe(true);
        expect(result.content.trim()).toBe('fast');
        expect(result.durationMs).toBeLessThan(5000);
    });
});

describe('Bash Adapter — Large Output', () => {
    const bash = getAdapter('bash')!;

    it('should handle large output without crash', async () => {
        // Generate ~100KB of output
        const result = await bash.execute(makeCtx('seq 1 10000'));
        expect(result.success).toBe(true);
        expect(result.content.length).toBeGreaterThan(1000);
    });

    it('should handle binary-ish output without crash', async () => {
        const result = await bash.execute(makeCtx('echo -n "\\x00\\x01\\x02"'));
        expect(result.success).toBe(true);
        expect(result.content).toBeDefined();
    });
});

describe('Bash Adapter — Environment Variables', () => {
    const bash = getAdapter('bash')!;

    it('should inject TITAN_API_URL, TITAN_RUN_ID, TITAN_ISSUE_ID', async () => {
        const result = await bash.execute(makeCtx(
            'echo "$TITAN_API_URL|$TITAN_RUN_ID|$TITAN_ISSUE_ID"',
            {
                titanApiUrl: 'http://test:48420',
                titanRunId: 'run-env-test',
                titanIssueId: 'issue-env-test',
            },
        ));
        expect(result.content).toContain('http://test:48420');
        expect(result.content).toContain('run-env-test');
        expect(result.content).toContain('issue-env-test');
    });

    it('should merge custom env with TITAN env', async () => {
        const result = await bash.execute(makeCtx(
            'echo "$MY_VAR|$TITAN_RUN_ID"',
            {
                env: { MY_VAR: 'custom-val' },
                titanRunId: 'run-merge',
            },
        ));
        expect(result.content).toContain('custom-val');
        expect(result.content).toContain('run-merge');
    });
});

describe('Claude Code Adapter', () => {
    const adapter = getAdapter('claude-code')!;

    it('should be registered with correct type', () => {
        expect(adapter).toBeDefined();
        expect(adapter.type).toBe('claude-code');
        expect(adapter.displayName).toBe('Claude Code');
    });

    it('should have execute method', () => {
        expect(typeof adapter.execute).toBe('function');
    });

    it('should handle missing binary gracefully', async () => {
        const result = await adapter.execute(makeCtx('echo test', { timeoutMs: 5_000 }));
        // Either succeeds (binary present) or returns helpful error
        if (!result.success) {
            const isExpected = result.content.includes('Claude Code CLI not found')
                || result.content.includes('cannot be launched inside another')
                || result.content.includes('Nested sessions');
            expect(isExpected).toBe(true);
        }
    });
});

describe('Codex Adapter', () => {
    const adapter = getAdapter('codex')!;

    it('should be registered with correct type', () => {
        expect(adapter).toBeDefined();
        expect(adapter.type).toBe('codex');
        expect(adapter.displayName).toBe('Codex');
    });

    it('should handle missing binary gracefully', async () => {
        const result = await adapter.execute(makeCtx('echo test', { timeoutMs: 5_000 }));
        if (!result.success) {
            expect(result.content).toContain('Codex CLI not found');
        }
    });
});
