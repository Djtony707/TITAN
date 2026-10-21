import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, execSync } from 'child_process';
import type { ToolHandler } from '../src/agent/toolRunner.js';
import { useExternalCliFixture } from './helpers/external-cli-fixture.js';

vi.mock('child_process', async (original) => {
    const actual = await original<typeof import('child_process')>();
    return {
        ...actual,
        execSync: vi.fn(() => { throw new Error('Shell execution forbidden in fixture'); }),
        execFile: vi.fn((...args: unknown[]) => {
            // Keep the production timeout assertion while making the controlled
            // child timeout fixture finish promptly, without a two-minute wait.
            if (process.env.TITAN_CLI_FIXTURE_MODE === 'timeout') args[2] = { ...(args[2] as object), timeout: 50 };
            return Reflect.apply(actual.execFile, actual, args);
        }),
    };
});
let handler: ToolHandler;
vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, tool: ToolHandler) => { handler = tool; },
}));
vi.mock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { registerCrossProviderSkill } from '../src/skills/builtin/cross_provider.js';

const cli = useExternalCliFixture();
beforeEach(() => { vi.clearAllMocks(); registerCrossProviderSkill(); });

describe('bundled external_agent execution boundary', () => {
    it.each(['claude', 'claude-code', 'claude_code', 'Claude Code'])('rejects prohibited agent %s before discovery or execution', async (agent) => {
        expect(await handler.execute({ action: 'run', agent, task: 'fixture' })).toContain('disabled by TITAN standing policy');
        expect(execSync).not.toHaveBeenCalled();
        expect(execFile).not.toHaveBeenCalled();
        expect(cli.invocations()).toEqual([]);
    });

    it('detects installation presence without starting any executable', async () => {
        const result = await handler.execute({ action: 'detect' });
        expect(result).toContain('claude-code (disabled by TITAN standing policy)');
        expect(result).toContain('codex');
        expect(result).toContain('presence only');
        expect(execSync).not.toHaveBeenCalled();
        expect(execFile).not.toHaveBeenCalled();
        expect(cli.invocations()).toEqual([]);
    });

    it.each(['codex', 'aider'])('passes hostile shell syntax literally to controlled %s', async (agent) => {
        const marker = join(cli.directory(), 'must-not-exist');
        const task = `$(touch ${marker}) \`touch ${marker}\` "quoted"\nsecond line`;
        const result = await handler.execute({ action: 'run', agent, task, cwd: cli.directory() });
        expect(result).toContain(`[${agent}] Output:`);
        expect(existsSync(marker)).toBe(false);
        expect(cli.invocations()).toEqual([expect.objectContaining({
            cli: agent, args: agent === 'codex' ? ['exec', '--json', '-'] : ['--yes'], input: `${task}\n`,
        })]);
        expect(execSync).not.toHaveBeenCalled();
        expect(execFile).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
            shell: false, timeout: 120_000, maxBuffer: 65_536, killSignal: 'SIGKILL', cwd: cli.directory(),
        }), expect.any(Function));
    });

    it('reports nonzero controlled exits as failures', async () => {
        cli.mode('error');
        const result = await handler.execute({ action: 'run', agent: 'codex', task: 'fixture' });
        expect(result).toContain('[codex] Failed:');
        expect(result).toContain('synthetic-cli-error');
    });

    it.each(['--yolo', '--dangerously-bypass-approvals-and-sandbox'])('passes leading Codex option %s as stdin data', async (task) => {
        expect(await handler.execute({ action: 'run', agent: 'codex', task })).toContain('[codex] Output:');
        expect(cli.invocations()).toEqual([expect.objectContaining({ args: ['exec', '--json', '-'], input: `${task}\n` })]);
    });

    it('terminates a controlled child on timeout without putting its task in failure argv', async () => {
        cli.mode('timeout');
        const task = 'PRIVATE_SYNTHETIC_TASK';
        const start = Date.now();
        const result = await handler.execute({ action: 'run', agent: 'codex', task });
        expect(result).toContain('[codex] Failed:');
        expect(result).not.toContain(task);
        expect(Date.now() - start).toBeLessThan(2000);
        expect(execFile).toHaveBeenCalledWith(expect.any(String), ['exec', '--json', '-'], expect.objectContaining({ timeout: 120_000, killSignal: 'SIGKILL' }), expect.any(Function));
    });

    it('bounds captured and returned output from a controlled noisy child', async () => {
        cli.mode('large-output');
        const result = String(await handler.execute({ action: 'run', agent: 'codex', task: 'fixture' }));
        expect(result).toContain('[codex] Failed:');
        expect(result).toContain('maxBuffer');
        expect(result.length).toBeLessThan(5100);
    });
});
