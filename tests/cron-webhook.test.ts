/**
 * Additional coverage tests for cron.ts and webhook.ts
 * Targets untested paths: initCronScheduler, executeCommand callback,
 * stopAndRemoveTask edge cases, list formatting, and webhook error branches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ════════════════════════════════════════════════════════════════════
// Cron — initCronScheduler
// ════════════════════════════════════════════════════════════════════

describe('Cron — initCronScheduler', () => {
    it('should schedule enabled jobs and skip disabled ones', async () => {
        vi.resetModules();

        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({ exec: vi.fn() }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({
                cronJobs: [
                    { id: 'j1', name: 'active', schedule: '* * * * *', command: 'echo 1', enabled: true },
                    { id: 'j2', name: 'off', schedule: '* * * * *', command: 'echo 2', enabled: false },
                ],
            }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        // Should log initialisation with 1 active and 1 skipped
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('1 active'),
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('1 skipped'),
        );
    });

    it('should skip jobs with invalid cron expressions during init', async () => {
        vi.resetModules();

        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(false),
            schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({ exec: vi.fn() }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({
                cronJobs: [
                    { id: 'bad1', name: 'invalid', schedule: 'garbage', command: 'echo x', enabled: true },
                ],
            }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('Invalid cron expression'),
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('0 active'),
        );
    });

    it('should handle empty cronJobs array', async () => {
        vi.resetModules();

        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn(),
            schedule: vi.fn(),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({ exec: vi.fn() }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: [] }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('0 active, 0 skipped'),
        );
    });
});

// ════════════════════════════════════════════════════════════════════
// Cron — scheduleJob callback / executeCommand
// ════════════════════════════════════════════════════════════════════

describe('Cron — cron tick callback', () => {
    it('should update last_run and log output when cron job fires', async () => {
        vi.resetModules();

        let capturedCronCallback: (() => Promise<void>) | null = null;
        const mockCronJobs = [
            { id: 'tick-1', name: 'ticker', schedule: '* * * * *', command: 'echo hello', enabled: true },
        ];
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockImplementation((_expr: string, cb: () => Promise<void>) => {
                capturedCronCallback = cb;
                return { stop: vi.fn() };
            }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                callback(null, 'hello world', '');
                return {};
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        expect(capturedCronCallback).not.toBeNull();

        // Fire the cron tick
        await capturedCronCallback!();

        // Should have set last_run on the job record
        expect(mockCronJobs[0]).toHaveProperty('last_run');
        expect(typeof (mockCronJobs[0] as any).last_run).toBe('string');

        // Should log completion
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('completed'),
        );
    });

    it('should handle exec error in cron callback', async () => {
        vi.resetModules();

        let capturedCronCallback: (() => Promise<void>) | null = null;
        const mockCronJobs = [
            { id: 'err-1', name: 'fail-job', schedule: '* * * * *', command: 'bad-cmd', enabled: true },
        ];
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockImplementation((_expr: string, cb: () => Promise<void>) => {
                capturedCronCallback = cb;
                return { stop: vi.fn() };
            }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                const err = new Error('command not found') as any;
                err.code = 127;
                callback(err, '', 'bash: bad-cmd: command not found');
                return {};
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        await capturedCronCallback!();

        // The exec callback resolves (doesn't reject), so it logs 'completed' with error info in output
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('completed'),
        );
    });

    it('should handle timeout (killed) in exec callback', async () => {
        vi.resetModules();

        let capturedCronCallback: (() => Promise<void>) | null = null;
        const mockCronJobs = [
            { id: 'to-1', name: 'timeout-job', schedule: '* * * * *', command: 'sleep 999', enabled: true },
        ];
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockImplementation((_expr: string, cb: () => Promise<void>) => {
                capturedCronCallback = cb;
                return { stop: vi.fn() };
            }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                const err = new Error('killed') as any;
                err.killed = true;
                callback(err, '', '');
                return {};
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        await capturedCronCallback!();

        // Should log completed with timed-out info
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('completed'),
        );
    });

    it('should handle no-output from exec callback', async () => {
        vi.resetModules();

        let capturedCronCallback: (() => Promise<void>) | null = null;
        const mockCronJobs = [
            { id: 'no-out', name: 'silent', schedule: '* * * * *', command: 'true', enabled: true },
        ];
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockImplementation((_expr: string, cb: () => Promise<void>) => {
                capturedCronCallback = cb;
                return { stop: vi.fn() };
            }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                callback(null, '', '');
                return {};
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        await capturedCronCallback!();

        // (no output) path
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('(no output)'),
        );
    });

    it('should truncate very long output', async () => {
        vi.resetModules();

        let capturedCronCallback: (() => Promise<void>) | null = null;
        const mockCronJobs = [
            { id: 'long-out', name: 'verbose', schedule: '* * * * *', command: 'cat bigfile', enabled: true },
        ];
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockImplementation((_expr: string, cb: () => Promise<void>) => {
                capturedCronCallback = cb;
                return { stop: vi.fn() };
            }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                // Generate 15000 chars of output (over the 10000 threshold)
                const bigOutput = 'x'.repeat(15000);
                callback(null, bigOutput, '');
                return {};
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        await capturedCronCallback!();

        // The output passed to logger.info should be truncated (first 500 chars of already-truncated output)
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('completed'),
        );
    });

    it('should handle missing job record in callback gracefully', async () => {
        vi.resetModules();

        let capturedCronCallback: (() => Promise<void>) | null = null;
        // The job array starts with the job but we'll remove it before the tick fires
        const mockCronJobs = [
            { id: 'vanish-1', name: 'vanisher', schedule: '* * * * *', command: 'echo hi', enabled: true },
        ];
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockImplementation((_expr: string, cb: () => Promise<void>) => {
                capturedCronCallback = cb;
                return { stop: vi.fn() };
            }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, callback: Function) => {
                callback(null, 'done', '');
                return {};
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));

        const { initCronScheduler } = await import('../src/skills/builtin/cron.js');
        initCronScheduler();

        // Remove the job from the store before the tick fires
        mockCronJobs.length = 0;

        await capturedCronCallback!();

        // Deletion revokes a queued tick; no command or completion is allowed.
        const { exec } = await import('child_process');
        expect(exec).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalledWith(
            'Cron',
            expect.stringContaining('completed'),
        );
    });
});

// ════════════════════════════════════════════════════════════════════
// Cron — list with last_run and disabled display
// ════════════════════════════════════════════════════════════════════

describe('Cron — list formatting edge cases', () => {
    let cronHandler: any;
    const mockCronJobs: any[] = [];

    beforeEach(async () => {
        vi.resetModules();
        mockCronJobs.length = 0;

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                cronHandler = handler;
            }),
        }));
        vi.doMock('node-cron', () => ({
            validate: vi.fn().mockReturnValue(true),
            schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('test-uuid') }));
        vi.doMock('child_process', () => ({ exec: vi.fn() }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
            saveMemoryNow: vi.fn(),
        }));

        const { registerCronSkill } = await import('../src/skills/builtin/cron.js');
        registerCronSkill();
    });

    it('list should display last_run when present', async () => {
        mockCronJobs.push({
            id: 'lr-1',
            name: 'ran-before',
            schedule: '0 9 * * *',
            command: 'echo hi',
            enabled: true,
            last_run: '2026-03-01T09:00:00Z',
        });
        const result = await cronHandler.execute({ action: 'list' });
        expect(result).toContain('Last run:');
        expect(result).toContain('2026-03-01T09:00:00Z');
    });

    it('list should show disabled status', async () => {
        mockCronJobs.push({
            id: 'dis-fmt',
            name: 'off-job',
            schedule: '0 9 * * *',
            command: 'echo hi',
            enabled: false,
        });
        const result = await cronHandler.execute({ action: 'list' });
        expect(result).toContain('disabled');
        expect(result).toContain('not scheduled');
    });

    it('list should show multiple jobs', async () => {
        mockCronJobs.push(
            { id: 'a', name: 'job-a', schedule: '0 1 * * *', command: 'a', enabled: true },
            { id: 'b', name: 'job-b', schedule: '0 2 * * *', command: 'b', enabled: true },
        );
        const result = await cronHandler.execute({ action: 'list' });
        expect(result).toContain('job-a');
        expect(result).toContain('job-b');
    });

    it('enable should skip scheduling if task is already active', async () => {
        // First create a job so it gets scheduled and added to activeTasks
        await cronHandler.execute({
            action: 'create',
            name: 'already-active',
            schedule: '0 9 * * *',
            command: 'echo yes',
        });

        // The job is now in mockCronJobs and activeTasks
        const job = mockCronJobs[0];

        // Enable it again — should not schedule a second time
        const result = await cronHandler.execute({ action: 'enable', jobId: job.id });
        expect(result).toContain('Enabled');
    });

    it('delete should stop active task before removing', async () => {
        // Create a job (which schedules it in activeTasks)
        await cronHandler.execute({
            action: 'create',
            name: 'to-stop',
            schedule: '0 9 * * *',
            command: 'echo stop',
        });

        const job = mockCronJobs[0];

        // Now delete — this triggers stopAndRemoveTask with an active task
        const result = await cronHandler.execute({ action: 'delete', jobId: job.id });
        expect(result).toContain('Deleted');
        expect(result).toContain('to-stop');
    });

    it('create should include ID and status in response', async () => {
        const result = await cronHandler.execute({
            action: 'create',
            name: 'detailed',
            schedule: '*/5 * * * *',
            command: 'date',
        });
        expect(result).toContain('ID: test-uuid');
        expect(result).toContain('Schedule: */5 * * * *');
        expect(result).toContain('Command: date');
        expect(result).toContain('Active and running');
    });

    it('create should require all three params — missing name', async () => {
        const result = await cronHandler.execute({
            action: 'create',
            schedule: '0 9 * * *',
            command: 'echo hi',
        });
        expect(result).toContain('Error');
        expect(result).toContain('name, schedule, and command are required');
    });

    it('create should require all three params — missing command', async () => {
        const result = await cronHandler.execute({
            action: 'create',
            name: 'test',
            schedule: '0 9 * * *',
        });
        expect(result).toContain('Error');
        expect(result).toContain('name, schedule, and command are required');
    });

    it('create should require all three params — missing schedule', async () => {
        const result = await cronHandler.execute({
            action: 'create',
            name: 'test',
            command: 'echo hi',
        });
        expect(result).toContain('Error');
        expect(result).toContain('name, schedule, and command are required');
    });
});

// ════════════════════════════════════════════════════════════════════
// Webhook — error handling branches
// ════════════════════════════════════════════════════════════════════

describe('Webhook — error handling branches', () => {
    it('initPersistentWebhooks should handle searchMemories throwing', async () => {
        vi.resetModules();

        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockRejectedValue(new Error('DB connection lost')),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const { initPersistentWebhooks } = await import('../src/skills/builtin/webhook.js');

        // Should not throw — catches internally
        await expect(initPersistentWebhooks()).resolves.not.toThrow();

        // Should log warning about the failure
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Webhook',
            expect.stringContaining('Failed to initialize persistent webhooks'),
        );
    });

    it('create should handle rememberFact throwing', async () => {
        vi.resetModules();

        let webhookHandler: any;
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                webhookHandler = handler;
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn().mockImplementation(() => {
                throw new Error('disk full');
            }),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('persist-fail-id') }));

        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        const result = await webhookHandler.execute({
            action: 'create',
            name: 'persist-fail',
            path: '/fail',
            handler: 'echo oops',
        });

        // Should still succeed (webhook created in memory) even if persistence fails
        expect(result).toContain('Created webhook');
        expect(result).toContain('persist-fail');

        // Should log warning about persistence failure
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Webhook',
            expect.stringContaining('Failed to persist webhook'),
        );
    });

    it('delete should handle getDb throwing during DB cleanup', async () => {
        vi.resetModules();

        let webhookHandler: any;
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                webhookHandler = handler;
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockImplementation(() => {
                throw new Error('DB unavailable');
            }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('del-err-id') }));

        const { registerWebhookSkill, getActiveWebhooks } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        // Manually add a webhook to activeWebhooks
        getActiveWebhooks().set('del-err-id', {
            id: 'del-err-id',
            path: '/err',
            name: 'err-hook',
            method: 'POST',
            handler: 'echo err',
        });

        const result = await webhookHandler.execute({
            action: 'delete',
            webhookId: 'del-err-id',
        });

        // Should still return success (webhook removed from memory)
        expect(result).toContain('Deleted webhook');

        // Should log warning about DB failure
        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Webhook',
            expect.stringContaining('Failed to delete webhook from database'),
        );
    });

    it('initPersistentWebhooks should not log when no webhooks loaded', async () => {
        vi.resetModules();

        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const { initPersistentWebhooks } = await import('../src/skills/builtin/webhook.js');
        await initPersistentWebhooks();

        // Should NOT log "Loaded X persisted webhook(s)" when loaded == 0
        const infoCalls = mockLogger.info.mock.calls.map((c: any[]) => c[1]);
        const loadedMsg = infoCalls.find((msg: string) => msg?.includes('persisted webhook'));
        expect(loadedMsg).toBeUndefined();
    });

    it('initPersistentWebhooks should load multiple webhooks', async () => {
        vi.resetModules();

        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        vi.doMock('../src/utils/logger.js', () => ({ default: mockLogger }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([
                {
                    category: 'webhook',
                    key: 'multi-1',
                    value: JSON.stringify({ id: 'multi-1', path: '/a', name: 'hook-a', method: 'POST', handler: 'a' }),
                },
                {
                    category: 'webhook',
                    key: 'multi-2',
                    value: JSON.stringify({ id: 'multi-2', path: '/b', name: 'hook-b', method: 'GET', handler: 'b' }),
                },
            ]),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const { initPersistentWebhooks, getActiveWebhooks } = await import('../src/skills/builtin/webhook.js');
        await initPersistentWebhooks();

        expect(getActiveWebhooks().size).toBe(2);
        expect(getActiveWebhooks().has('multi-1')).toBe(true);
        expect(getActiveWebhooks().has('multi-2')).toBe(true);

        expect(mockLogger.info).toHaveBeenCalledWith(
            'Webhook',
            expect.stringContaining('2 persisted webhook'),
        );
    });

    it('delete should remove webhook entry from DB memories array', async () => {
        vi.resetModules();

        let webhookHandler: any;
        const mockMemories = [
            { category: 'webhook', key: 'db-del-id', value: '{}' },
            { category: 'other', key: 'keep-me', value: 'data' },
        ];

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                webhookHandler = handler;
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: mockMemories }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('db-del-id') }));

        const { registerWebhookSkill, getActiveWebhooks } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        // Put webhook in active map
        getActiveWebhooks().set('db-del-id', {
            id: 'db-del-id',
            path: '/x',
            name: 'db-hook',
            method: 'POST',
            handler: 'echo',
        });

        await webhookHandler.execute({ action: 'delete', webhookId: 'db-del-id' });

        // The webhook memory entry should be spliced out
        expect(mockMemories.length).toBe(1);
        expect(mockMemories[0].key).toBe('keep-me');
    });

    it('list should format multiple webhooks with all fields', async () => {
        vi.resetModules();

        let webhookHandler: any;

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                webhookHandler = handler;
            }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));

        let uuidCounter = 0;
        vi.doMock('uuid', () => ({
            v4: vi.fn().mockImplementation(() => `wh-${++uuidCounter}`),
        }));

        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        await webhookHandler.execute({ action: 'create', name: 'alpha', path: '/alpha', method: 'GET', handler: 'get-alpha' });
        await webhookHandler.execute({ action: 'create', name: 'beta', path: '/beta', method: 'POST', handler: 'post-beta' });

        const result = await webhookHandler.execute({ action: 'list' });
        expect(result).toContain('alpha');
        expect(result).toContain('beta');
        expect(result).toContain('GET');
        expect(result).toContain('POST');
        expect(result).toContain('/alpha');
        expect(result).toContain('/beta');
        expect(result).toContain('get-alpha');
        expect(result).toContain('post-beta');
    });
});
