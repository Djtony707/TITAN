/**
 * TITAN — Builtin Skills Tests
 * Tests for low-coverage builtin skill modules:
 * apply_patch, browser, cron, process, shell, vision, voice,
 * web_search, webhook, image_gen, sessions, memory_graph
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Global mocks ──────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        providers: {},
        security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
        skills: {},
    }),
    updateConfig: vi.fn(),
    getDefaultConfig: vi.fn(),
    resetConfigCache: vi.fn(),
}));

// ════════════════════════════════════════════════════════════════════
// Apply Patch Skill
// ════════════════════════════════════════════════════════════════════

describe('Apply Patch Skill', () => {
    let patchHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
        }));

        const handlers = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                handlers.set(handler.name, handler);
            }),
        }));

        // Mock fs operations
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                readFileSync: vi.fn().mockReturnValue('line1\nline2\nline3\n'),
                writeFileSync: vi.fn(),
                existsSync: vi.fn().mockReturnValue(true),
            };
        });

        vi.doMock('../src/utils/helpers.js', () => ({
            ensureDir: vi.fn(),
            mkdirIfNotExists: vi.fn(),
        }));

        const { registerApplyPatchSkill } = await import('../src/skills/builtin/apply_patch.js');
        registerApplyPatchSkill();
        patchHandler = handlers.get('apply_patch');
    });

    it('should register the apply_patch handler', () => {
        expect(patchHandler).toBeDefined();
        expect(patchHandler.name).toBe('apply_patch');
        expect(patchHandler.parameters.required).toContain('patch');
    });

    it('should handle git diff format patch for new file', async () => {
        const { existsSync } = await import('fs');
        (existsSync as any).mockReturnValue(false);

        const patch = `diff --git a/newfile.txt b/newfile.txt
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,3 @@
+hello
+world
+test`;

        const result = await patchHandler.execute({ patch, cwd: '/tmp' });
        expect(result).toContain('Created');
        expect(result).toContain('newfile.txt');
    });

    it('should handle git diff format patch for existing file', async () => {
        const patch = `diff --git a/existing.txt b/existing.txt
--- a/existing.txt
+++ b/existing.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2_modified
 line3`;

        const result = await patchHandler.execute({ patch, cwd: '/tmp' });
        expect(result).toContain('Patched');
        expect(result).toContain('existing.txt');
    });

    it('should fallback to simple patch when no diff --git header', async () => {
        const patch = `--- a/simple.txt
+++ b/simple.txt
@@ -1,2 +1,2 @@
-old line
+new line`;

        const result = await patchHandler.execute({ patch, cwd: '/tmp' });
        expect(result).toContain('Patched');
    });

    it('should return error for simple patch with no +++ line', async () => {
        const patch = `just some random text`;
        const result = await patchHandler.execute({ patch, cwd: '/tmp' });
        expect(result).toContain('Could not determine target file');
    });

    it('should create new file via simple patch when file does not exist', async () => {
        const { existsSync } = await import('fs');
        (existsSync as any).mockReturnValue(false);

        const patch = `--- /dev/null
+++ b/brand_new.txt
@@ -0,0 +1,2 @@
+first line
+second line`;

        const result = await patchHandler.execute({ patch, cwd: '/tmp' });
        expect(result).toContain('Created');
    });

    it('should handle patch with no determinable target file', async () => {
        const patch = `diff --git something
some random lines with no --- or +++ markers`;

        const result = await patchHandler.execute({ patch, cwd: '/tmp' });
        expect(result).toContain('Could not determine');
    });

    it('should use process.cwd() when no cwd provided', async () => {
        const patch = `--- a/test.txt
+++ b/test.txt
-old
+new`;
        const result = await patchHandler.execute({ patch });
        expect(typeof result).toBe('string');
    });

    it('should handle errors during patch application', async () => {
        const { readFileSync } = await import('fs');
        (readFileSync as any).mockImplementation(() => { throw new Error('Read failed'); });

        const patch = `diff --git a/fail.txt b/fail.txt
--- a/fail.txt
+++ b/fail.txt
@@ -1 +1 @@
-old
+new`;

        const result = await patchHandler.execute({ patch, cwd: '/tmp' });
        expect(result).toContain('Error');
    });
});

// ════════════════════════════════════════════════════════════════════
// Browser Skill
// ════════════════════════════════════════════════════════════════════

describe('Browser Skill', () => {
    let browserHandler: any;

    beforeEach(async () => {
        vi.resetModules();
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
                browserHandler = handler;
            }),
        }));

        // Mock child_process.execFile
        vi.doMock('child_process', () => ({
            execFile: vi.fn().mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
                cb(null, '<html><title>Test Page</title><body><p>Hello World</p><a href="https://example.com">Example</a></body></html>', '');
            }),
        }));

        const { registerBrowserSkill } = await import('../src/skills/builtin/browser.js');
        registerBrowserSkill();
    });

    it('should register the browser handler', () => {
        expect(browserHandler).toBeDefined();
        expect(browserHandler.name).toBe('browser');
    });

    it('should have action parameter with enum values', () => {
        const actionProp = browserHandler.parameters.properties.action;
        expect(actionProp.enum).toContain('navigate');
        expect(actionProp.enum).toContain('snapshot');
        expect(actionProp.enum).toContain('click');
        expect(actionProp.enum).toContain('type');
        expect(actionProp.enum).toContain('evaluate');
        expect(actionProp.enum).toContain('extract');
        expect(actionProp.enum).toContain('screenshot');
    });

    it('navigate should return error when url is missing', async () => {
        const result = await browserHandler.execute({ action: 'navigate' });
        expect(result).toContain('Error');
        expect(result).toContain('url is required');
    });

    it('navigate should fetch and return page content', async () => {
        const result = await browserHandler.execute({ action: 'navigate', url: 'https://example.com' });
        expect(result).toContain('Page content from');
        expect(result).toContain('Hello World');
    });

    it('navigate should handle fetch errors', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('child_process', () => ({
            execFile: vi.fn().mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
                cb(new Error('Connection refused'), '', '');
            }),
        }));
        const { registerBrowserSkill } = await import('../src/skills/builtin/browser.js');
        registerBrowserSkill();
        const result = await handler.execute({ action: 'navigate', url: 'https://fail.example.com' });
        expect(result).toContain('Error');
    });

    it('snapshot should return error when url is missing', async () => {
        const result = await browserHandler.execute({ action: 'snapshot' });
        expect(result).toContain('Error');
        expect(result).toContain('url is required');
    });

    it('snapshot should extract title, description and links', async () => {
        const result = await browserHandler.execute({ action: 'snapshot', url: 'https://example.com' });
        expect(result).toContain('Page:');
        expect(result).toContain('Test Page');
        expect(result).toContain('Links:');
    });

    it('extract should work the same as snapshot', async () => {
        const result = await browserHandler.execute({ action: 'extract', url: 'https://example.com' });
        expect(result).toContain('Page:');
        expect(result).toContain('Test Page');
    });

    it('evaluate should return error when script is missing', async () => {
        const result = await browserHandler.execute({ action: 'evaluate' });
        expect(result).toContain('Error');
        expect(result).toContain('script is required');
    });

    it('evaluate should return note about CDP requirement', async () => {
        const result = await browserHandler.execute({ action: 'evaluate', script: 'document.title' });
        expect(result).toContain('CDP');
        expect(result).toContain('document.title');
    });

    it('screenshot should return error when url is missing', async () => {
        const result = await browserHandler.execute({ action: 'screenshot' });
        expect(result).toContain('Error');
        expect(result).toContain('url is required');
    });

    it('screenshot should return CDP requirement message', async () => {
        const result = await browserHandler.execute({ action: 'screenshot', url: 'https://example.com' });
        expect(result).toContain('CDP');
    });

    it('click should return error when selector is missing', async () => {
        const result = await browserHandler.execute({ action: 'click' });
        expect(result).toContain('Error');
        expect(result).toContain('selector is required');
    });

    it('click should return CDP requirement message', async () => {
        const result = await browserHandler.execute({ action: 'click', selector: '#btn' });
        expect(result).toContain('CDP');
        expect(result).toContain('#btn');
    });

    it('type should return error when selector or text is missing', async () => {
        const result = await browserHandler.execute({ action: 'type', selector: '#input' });
        expect(result).toContain('Error');
        expect(result).toContain('selector and text are required');
    });

    it('type should return CDP requirement message', async () => {
        const result = await browserHandler.execute({ action: 'type', selector: '#input', text: 'hello' });
        expect(result).toContain('CDP');
        expect(result).toContain('#input');
        expect(result).toContain('hello');
    });

    it('should handle unknown action', async () => {
        const result = await browserHandler.execute({ action: 'fly' });
        expect(result).toContain('Unknown browser action');
    });
});

// ════════════════════════════════════════════════════════════════════
// Cron Skill
// ════════════════════════════════════════════════════════════════════

describe('Cron Skill', () => {
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
            validate: vi.fn().mockImplementation((expr: string) => {
                // Accept standard cron expressions, reject junk
                return /^[\d*/,-]+(\s+[\d*/,-]+){4,5}$/.test(expr.trim());
            }),
            schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
        }));

        vi.doMock('uuid', () => ({
            v4: vi.fn().mockReturnValue('test-uuid-1234-5678-abcdefghijkl'),
        }));

        vi.doMock('child_process', () => ({
            exec: vi.fn(),
        }));

        vi.doMock('../../memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ cronJobs: mockCronJobs }),
        }));

        const { registerCronSkill } = await import('../src/skills/builtin/cron.js');
        registerCronSkill();
    });

    it('should register the cron handler', () => {
        expect(cronHandler).toBeDefined();
        expect(cronHandler.name).toBe('cron');
    });

    it('should have correct parameter schema', () => {
        const props = cronHandler.parameters.properties;
        expect(props.action).toBeDefined();
        expect(props.action.enum).toContain('create');
        expect(props.action.enum).toContain('list');
        expect(props.action.enum).toContain('delete');
        expect(props.action.enum).toContain('enable');
        expect(props.action.enum).toContain('disable');
    });

    it('create should require name, schedule, and command', async () => {
        const result = await cronHandler.execute({ action: 'create' });
        expect(result).toContain('Error');
        expect(result).toContain('name, schedule, and command are required');
    });

    it('create should reject invalid cron expression', async () => {
        const result = await cronHandler.execute({
            action: 'create',
            name: 'test',
            schedule: 'not a cron',
            command: 'echo hi',
        });
        expect(result).toContain('Error');
        expect(result).toContain('not a valid cron');
    });

    it('create should create and schedule a valid cron job', async () => {
        const result = await cronHandler.execute({
            action: 'create',
            name: 'test job',
            schedule: '0 9 * * *',
            command: 'echo hello',
        });
        expect(result).toContain('Created cron job');
        expect(result).toContain('test job');
        expect(result).toContain('0 9 * * *');
        expect(result).toContain('echo hello');
        expect(result).toContain('Active');
    });

    it('list should return empty message when no jobs', async () => {
        const result = await cronHandler.execute({ action: 'list' });
        expect(result).toContain('No cron jobs');
    });

    it('list should display cron jobs', async () => {
        mockCronJobs.push({
            id: 'job-1',
            name: 'daily backup',
            schedule: '0 2 * * *',
            command: 'backup.sh',
            enabled: true,
            created_at: '2026-01-01T00:00:00Z',
        });
        const result = await cronHandler.execute({ action: 'list' });
        expect(result).toContain('daily backup');
        expect(result).toContain('job-1');
        expect(result).toContain('0 2 * * *');
    });

    it('delete should require jobId', async () => {
        const result = await cronHandler.execute({ action: 'delete' });
        expect(result).toContain('Error');
        expect(result).toContain('jobId is required');
    });

    it('delete should return error for non-existent job', async () => {
        const result = await cronHandler.execute({ action: 'delete', jobId: 'nonexistent' });
        expect(result).toContain('Error');
        expect(result).toContain('no cron job found');
    });

    it('delete should remove a cron job', async () => {
        mockCronJobs.push({
            id: 'del-1',
            name: 'to delete',
            schedule: '* * * * *',
            command: 'echo bye',
            enabled: true,
        });
        const result = await cronHandler.execute({ action: 'delete', jobId: 'del-1' });
        expect(result).toContain('Deleted');
        expect(result).toContain('to delete');
    });

    it('enable should require jobId', async () => {
        const result = await cronHandler.execute({ action: 'enable' });
        expect(result).toContain('Error');
        expect(result).toContain('jobId is required');
    });

    it('enable should return error for non-existent job', async () => {
        const result = await cronHandler.execute({ action: 'enable', jobId: 'missing' });
        expect(result).toContain('Error');
        expect(result).toContain('no cron job found');
    });

    it('enable should enable a disabled job', async () => {
        mockCronJobs.push({
            id: 'en-1',
            name: 'disabled job',
            schedule: '0 9 * * *',
            command: 'echo hi',
            enabled: false,
        });
        const result = await cronHandler.execute({ action: 'enable', jobId: 'en-1' });
        expect(result).toContain('Enabled');
        expect(result).toContain('disabled job');
    });

    it('disable should require jobId', async () => {
        const result = await cronHandler.execute({ action: 'disable' });
        expect(result).toContain('Error');
        expect(result).toContain('jobId is required');
    });

    it('disable should return error for non-existent job', async () => {
        const result = await cronHandler.execute({ action: 'disable', jobId: 'missing' });
        expect(result).toContain('Error');
        expect(result).toContain('no cron job found');
    });

    it('disable should disable an enabled job', async () => {
        mockCronJobs.push({
            id: 'dis-1',
            name: 'active job',
            schedule: '0 9 * * *',
            command: 'echo hi',
            enabled: true,
        });
        const result = await cronHandler.execute({ action: 'disable', jobId: 'dis-1' });
        expect(result).toContain('Disabled');
        expect(result).toContain('active job');
    });

    it('should handle unknown action', async () => {
        const result = await cronHandler.execute({ action: 'restart' });
        expect(result).toContain('Unknown action');
    });
});

// ════════════════════════════════════════════════════════════════════
// Process Skill
// ════════════════════════════════════════════════════════════════════

describe('Process Skill', () => {
    let execHandler: any;
    let processHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));

        const handlers = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                handlers.set(handler.name, handler);
            }),
        }));

        vi.doMock('uuid', () => ({
            v4: vi.fn().mockReturnValue('proc-uuid-1234'),
        }));

        // Mock child_process
        const mockStdout = { on: vi.fn() };
        const mockStderr = { on: vi.fn() };
        const mockStdin = { write: vi.fn() };
        const mockChild = {
            pid: 12345,
            stdout: mockStdout,
            stderr: mockStderr,
            stdin: mockStdin,
            on: vi.fn(),
            kill: vi.fn(),
        };

        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, 'command output', '');
            }),
            spawn: vi.fn().mockReturnValue(mockChild),
        }));

        const { registerProcessSkill } = await import('../src/skills/builtin/process.js');
        registerProcessSkill();
        execHandler = handlers.get('exec');
        processHandler = handlers.get('process');
    });

    it('should register both exec and process handlers', () => {
        expect(execHandler).toBeDefined();
        expect(execHandler.name).toBe('exec');
        expect(processHandler).toBeDefined();
        expect(processHandler.name).toBe('process');
    });

    it('exec should have correct parameters', () => {
        expect(execHandler.parameters.properties.command).toBeDefined();
        expect(execHandler.parameters.properties.background).toBeDefined();
        expect(execHandler.parameters.properties.timeout).toBeDefined();
        expect(execHandler.parameters.required).toContain('command');
    });

    it('exec should run a synchronous command', async () => {
        const result = await execHandler.execute({ command: 'echo hello' });
        expect(result).toContain('command output');
    });

    it('exec sync should handle timeout (killed)', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                const err: any = new Error('timeout');
                err.killed = true;
                cb(err, 'partial', '');
            }),
            spawn: vi.fn(),
        }));
        const { registerProcessSkill } = await import('../src/skills/builtin/process.js');
        registerProcessSkill();
        const result = await handlers2.get('exec').execute({ command: 'sleep 999' });
        expect(result).toContain('timed out');
    });

    it('exec sync should handle non-zero exit code', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                const err: any = new Error('exit');
                err.code = 1;
                err.killed = false;
                cb(err, 'output', 'error output');
            }),
            spawn: vi.fn(),
        }));
        const { registerProcessSkill } = await import('../src/skills/builtin/process.js');
        registerProcessSkill();
        const result = await handlers2.get('exec').execute({ command: 'false' });
        expect(result).toContain('Exit code: 1');
    });

    it('exec should return no output message when empty', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, '', '');
            }),
            spawn: vi.fn(),
        }));
        const { registerProcessSkill } = await import('../src/skills/builtin/process.js');
        registerProcessSkill();
        const result = await handlers2.get('exec').execute({ command: 'true' });
        expect(result).toContain('no output');
    });

    it('exec background should start a background process', async () => {
        const result = await execHandler.execute({ command: 'sleep 10', background: true });
        expect(result).toContain('background');
        expect(result).toContain('Session ID');
        expect(result).toContain('PID');
    });

    it('process list should return empty when no processes', async () => {
        const result = await processHandler.execute({ action: 'list' });
        expect(result).toContain('No managed processes');
    });

    it('process poll should return not found for unknown session', async () => {
        const result = await processHandler.execute({ action: 'poll', sessionId: 'unknown' });
        expect(result).toContain('not found');
    });

    it('process log should return not found for unknown session', async () => {
        const result = await processHandler.execute({ action: 'log', sessionId: 'unknown' });
        expect(result).toContain('not found');
    });

    it('process write should return not running for unknown session', async () => {
        const result = await processHandler.execute({ action: 'write', sessionId: 'unknown', input: 'hi' });
        expect(result).toContain('not running');
    });

    it('process kill should return not found for unknown session', async () => {
        const result = await processHandler.execute({ action: 'kill', sessionId: 'unknown' });
        expect(result).toContain('not found');
    });

    it('process clear should clear completed processes', async () => {
        const result = await processHandler.execute({ action: 'clear' });
        expect(result).toContain('Cleared');
        expect(result).toContain('0');
    });

    it('process remove should return not found for unknown session', async () => {
        const result = await processHandler.execute({ action: 'remove', sessionId: 'nonexistent' });
        expect(result).toContain('not found');
    });

    it('process should handle unknown action', async () => {
        const result = await processHandler.execute({ action: 'restart' });
        expect(result).toContain('Unknown action');
    });

    it('process should have correct action enum', () => {
        const actionProp = processHandler.parameters.properties.action;
        expect(actionProp.enum).toContain('list');
        expect(actionProp.enum).toContain('poll');
        expect(actionProp.enum).toContain('log');
        expect(actionProp.enum).toContain('write');
        expect(actionProp.enum).toContain('kill');
        expect(actionProp.enum).toContain('clear');
        expect(actionProp.enum).toContain('remove');
    });
});

// ════════════════════════════════════════════════════════════════════
// Shell Skill
// ════════════════════════════════════════════════════════════════════

describe('Shell Skill', () => {
    let shellHandler: any;

    beforeEach(async () => {
        vi.resetModules();
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
                shellHandler = handler;
            }),
        }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, 'shell output', '');
            }),
        }));

        const { registerShellSkill } = await import('../src/skills/builtin/shell.js');
        registerShellSkill();
    });

    it('should register the shell handler', () => {
        expect(shellHandler).toBeDefined();
        expect(shellHandler.name).toBe('shell');
    });

    it('should have command as required parameter', () => {
        expect(shellHandler.parameters.required).toContain('command');
        expect(shellHandler.parameters.properties.command).toBeDefined();
        expect(shellHandler.parameters.properties.cwd).toBeDefined();
        expect(shellHandler.parameters.properties.timeout).toBeDefined();
    });

    it('should execute a command and return output', async () => {
        const result = await shellHandler.execute({ command: 'echo hello' });
        expect(result).toContain('shell output');
    });

    it('should handle stderr output', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, 'stdout', 'stderr warning');
            }),
        }));
        const { registerShellSkill } = await import('../src/skills/builtin/shell.js');
        registerShellSkill();
        const result = await handler.execute({ command: 'test' });
        expect(result).toContain('stdout');
        expect(result).toContain('stderr');
    });

    it('should handle error with exit code', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                const err: any = new Error('fail');
                err.code = 2;
                err.killed = false;
                cb(err, '', '');
            }),
        }));
        const { registerShellSkill } = await import('../src/skills/builtin/shell.js');
        registerShellSkill();
        const result = await handler.execute({ command: 'false' });
        expect(result).toContain('exit code: 2');
    });

    it('should handle timeout (killed)', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                const err: any = new Error('timeout');
                err.killed = true;
                cb(err, '', '');
            }),
        }));
        const { registerShellSkill } = await import('../src/skills/builtin/shell.js');
        registerShellSkill();

        try {
            await handler.execute({ command: 'sleep 999' });
        } catch (e: any) {
            expect(e.message).toContain('timed out');
        }
    });

    it('should return no output message when stdout and stderr are empty', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('child_process', () => ({
            exec: vi.fn().mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, '', '');
            }),
        }));
        const { registerShellSkill } = await import('../src/skills/builtin/shell.js');
        registerShellSkill();
        const result = await handler.execute({ command: 'true' });
        expect(result).toBe('(no output)');
    });
});

// ════════════════════════════════════════════════════════════════════
// Vision Skill
// ════════════════════════════════════════════════════════════════════

describe('Vision Skill', () => {
    let visionHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: {},
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                visionHandler = handler;
            }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-image-data')),
            };
        });

        const { registerVisionSkill } = await import('../src/skills/builtin/vision.js');
        registerVisionSkill();
    });

    it('should register the analyze_image handler', () => {
        expect(visionHandler).toBeDefined();
        expect(visionHandler.name).toBe('analyze_image');
    });

    it('should have filePath and prompt as required parameters', () => {
        expect(visionHandler.parameters.required).toContain('filePath');
        expect(visionHandler.parameters.required).toContain('prompt');
    });

    it('should return error when filePath is missing', async () => {
        const result = await visionHandler.execute({ prompt: 'describe' });
        expect(result).toContain('Error');
        expect(result).toContain('missing');
    });

    it('should return error when prompt is missing', async () => {
        const result = await visionHandler.execute({ filePath: '/tmp/img.png' });
        expect(result).toContain('Error');
        expect(result).toContain('missing');
    });

    it('should return error when file does not exist', async () => {
        const { existsSync } = await import('fs');
        (existsSync as any).mockReturnValue(false);
        const result = await visionHandler.execute({ filePath: '/tmp/noexist.png', prompt: 'describe' });
        expect(result).toContain('Error');
        expect(result).toContain('not found');
    });

    it('should return error when no API keys configured', async () => {
        const result = await visionHandler.execute({ filePath: '/tmp/test.png', prompt: 'describe' });
        expect(result).toContain('Error');
        expect(result).toContain('API key');
    });

    it('should call Anthropic API when anthropic key configured', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { anthropic: { apiKey: 'test-key-anthropic' } },
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-png')),
            };
        });

        // Mock global fetch
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ content: [{ text: 'A beautiful sunset' }] }),
        }) as any;

        try {
            const { registerVisionSkill } = await import('../src/skills/builtin/vision.js');
            registerVisionSkill();
            const result = await handler.execute({ filePath: '/tmp/test.png', prompt: 'describe' });
            expect(result).toContain('A beautiful sunset');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should call OpenAI API when openai key configured', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-key-openai' } },
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-jpg')),
            };
        });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'An image of a cat' } }] }),
        }) as any;

        try {
            const { registerVisionSkill } = await import('../src/skills/builtin/vision.js');
            registerVisionSkill();
            const result = await handler.execute({ filePath: '/tmp/test.jpg', prompt: 'describe' });
            expect(result).toContain('An image of a cat');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should handle Anthropic API error', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { anthropic: { apiKey: 'test-key' } },
            }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('data')),
            };
        });

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            text: async () => 'Unauthorized',
        }) as any;

        try {
            const { registerVisionSkill } = await import('../src/skills/builtin/vision.js');
            registerVisionSkill();
            const result = await handler.execute({ filePath: '/tmp/test.webp', prompt: 'describe' });
            expect(result).toContain('Failed');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

// ════════════════════════════════════════════════════════════════════
// Voice Skill
// ════════════════════════════════════════════════════════════════════

describe('Voice Skill', () => {
    let sttHandler: any;
    let ttsHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: {},
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));

        const handlers = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                handlers.set(handler.name, handler);
            }),
        }));

        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-audio-data')),
                writeFileSync: vi.fn(),
            };
        });

        vi.doMock('uuid', () => ({
            v4: vi.fn().mockReturnValue('voice-uuid-1234'),
        }));

        const { registerVoiceSkills } = await import('../src/skills/builtin/voice.js');
        registerVoiceSkills();
        sttHandler = handlers.get('transcribe_audio');
        ttsHandler = handlers.get('generate_speech');
    });

    it('should register both STT and TTS handlers', () => {
        expect(sttHandler).toBeDefined();
        expect(sttHandler.name).toBe('transcribe_audio');
        expect(ttsHandler).toBeDefined();
        expect(ttsHandler.name).toBe('generate_speech');
    });

    it('STT should return error when file not found', async () => {
        const { existsSync } = await import('fs');
        (existsSync as any).mockReturnValue(false);
        const result = await sttHandler.execute({ filePath: '/tmp/missing.mp3' });
        expect(result).toContain('Error');
        expect(result).toContain('not found');
    });

    it('STT should return error when no OpenAI API key', async () => {
        const result = await sttHandler.execute({ filePath: '/tmp/audio.mp3' });
        expect(result).toContain('Error');
        expect(result).toContain('OpenAI API key');
    });

    it('STT should transcribe audio with OpenAI key configured', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-openai-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('audio')),
                writeFileSync: vi.fn(),
            };
        });
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ text: 'Hello world from audio' }),
        }) as any;

        try {
            const { registerVoiceSkills } = await import('../src/skills/builtin/voice.js');
            registerVoiceSkills();
            const result = await handlers2.get('transcribe_audio').execute({ filePath: '/tmp/test.mp3' });
            expect(result).toContain('Transcript');
            expect(result).toContain('Hello world from audio');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('STT should handle API error', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('audio')),
                writeFileSync: vi.fn(),
            };
        });
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            text: async () => 'Rate limited',
        }) as any;

        try {
            const { registerVoiceSkills } = await import('../src/skills/builtin/voice.js');
            registerVoiceSkills();
            const result = await handlers2.get('transcribe_audio').execute({ filePath: '/tmp/test.mp3' });
            expect(result).toContain('Error');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('TTS should return error when text is missing', async () => {
        const result = await ttsHandler.execute({});
        expect(result).toContain('Error');
        expect(result).toContain('text');
    });

    it('TTS should return error when no OpenAI API key', async () => {
        const result = await ttsHandler.execute({ text: 'Hello' });
        expect(result).toContain('Error');
        expect(result).toContain('OpenAI API key');
    });

    it('TTS should generate speech with OpenAI key configured', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-openai-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('data')),
                writeFileSync: vi.fn(),
            };
        });
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('voice-1234-5678') }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(100),
        }) as any;

        try {
            const { registerVoiceSkills } = await import('../src/skills/builtin/voice.js');
            registerVoiceSkills();
            const result = await handlers2.get('generate_speech').execute({ text: 'Hello world', voice: 'nova' });
            expect(result).toContain('Success');
            expect(result).toContain('.mp3');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('TTS should handle API error', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('data')),
                writeFileSync: vi.fn(),
            };
        });
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            text: async () => 'Server error',
        }) as any;

        try {
            const { registerVoiceSkills } = await import('../src/skills/builtin/voice.js');
            registerVoiceSkills();
            const result = await handlers2.get('generate_speech').execute({ text: 'Hello' });
            expect(result).toContain('Error');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

// ════════════════════════════════════════════════════════════════════
// Web Search Skill
// ════════════════════════════════════════════════════════════════════

describe('Web Search Skill', () => {
    let webSearchHandler: any;

    beforeEach(async () => {
        vi.resetModules();
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
                webSearchHandler = handler;
            }),
        }));

        const { registerWebSearchSkill } = await import('../src/skills/builtin/web_search.js');
        registerWebSearchSkill();
    });

    it('should register the web_search handler', () => {
        expect(webSearchHandler).toBeDefined();
        expect(webSearchHandler.name).toBe('web_search');
    });

    it('should have query as required parameter', () => {
        expect(webSearchHandler.parameters.required).toContain('query');
        expect(webSearchHandler.parameters.properties.query).toBeDefined();
        expect(webSearchHandler.parameters.properties.maxResults).toBeDefined();
    });

    it('should handle search with results', async () => {
        const originalFetch = globalThis.fetch;
        const mockHtml = `
            <div>
                <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fresult1">Example Result 1</a>
                <a class="result__snippet">This is the first result snippet</a>
            </div>
        `;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => mockHtml,
        }) as any;

        try {
            const result = await webSearchHandler.execute({ query: 'test query' });
            expect(result).toContain('Example Result 1');
            expect(result).toContain('example.com');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should return no results message when nothing found', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => '<html><body>No results</body></html>',
        }) as any;

        try {
            const result = await webSearchHandler.execute({ query: 'xyzabc123nonsense' });
            expect(result).toContain('No results found');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should handle HTTP error responses', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
        }) as any;

        try {
            const result = await webSearchHandler.execute({ query: 'test' });
            expect(result).toContain('Search failed');
            expect(result).toContain('429');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should handle network errors', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any;

        try {
            const result = await webSearchHandler.execute({ query: 'test' });
            expect(result).toContain('Search error');
            expect(result).toContain('Network error');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

// ════════════════════════════════════════════════════════════════════
// Webhook Skill
// ════════════════════════════════════════════════════════════════════

describe('Webhook Skill', () => {
    let webhookHandler: any;

    beforeEach(async () => {
        vi.resetModules();
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
            recallFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
        vi.doMock('uuid', () => ({
            v4: vi.fn().mockReturnValue('webhook-uuid-1234-5678-abcdef'),
        }));

        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();
    });

    it('should register the webhook handler', () => {
        expect(webhookHandler).toBeDefined();
        expect(webhookHandler.name).toBe('webhook');
    });

    it('should have correct parameter schema', () => {
        const props = webhookHandler.parameters.properties;
        expect(props.action).toBeDefined();
        expect(props.action.enum).toContain('create');
        expect(props.action.enum).toContain('list');
        expect(props.action.enum).toContain('delete');
    });

    it('create should create a new webhook', async () => {
        const result = await webhookHandler.execute({
            action: 'create',
            name: 'my-hook',
            path: '/hooks/test',
            method: 'GET',
            handler: 'echo triggered',
        });
        expect(result).toContain('Created webhook');
        expect(result).toContain('my-hook');
        expect(result).toContain('/hooks/test');
        expect(result).toContain('GET');
    });

    it('create should use defaults for missing optional params', async () => {
        const result = await webhookHandler.execute({ action: 'create' });
        expect(result).toContain('Created webhook');
        expect(result).toContain('POST');
    });

    it('list should return empty message when no webhooks', async () => {
        const result = await webhookHandler.execute({ action: 'list' });
        expect(result).toContain('No active webhooks');
    });

    it('list should show webhooks after creation', async () => {
        await webhookHandler.execute({
            action: 'create',
            name: 'test-hook',
            path: '/test',
            handler: 'echo hello',
        });
        const result = await webhookHandler.execute({ action: 'list' });
        expect(result).toContain('test-hook');
    });

    it('delete should require webhookId', async () => {
        const result = await webhookHandler.execute({ action: 'delete' });
        expect(result).toContain('Error');
        expect(result).toContain('webhookId is required');
    });

    it('delete should remove a webhook', async () => {
        await webhookHandler.execute({
            action: 'create',
            name: 'to-delete',
            path: '/del',
        });
        const result = await webhookHandler.execute({
            action: 'delete',
            webhookId: 'webhook-uuid-1234-5678-abcdef',
        });
        expect(result).toContain('Deleted webhook');
    });

    it('should handle unknown action', async () => {
        const result = await webhookHandler.execute({ action: 'update' });
        expect(result).toContain('Unknown action');
    });
});

describe('Webhook — initPersistentWebhooks', () => {
    it('should load webhooks from memory on init', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
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
            recallFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([
                {
                    category: 'webhook',
                    key: 'wh-1',
                    value: JSON.stringify({ id: 'wh-1', path: '/test', name: 'loaded', method: 'POST', handler: 'echo' }),
                },
            ]),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const { initPersistentWebhooks, getActiveWebhooks } = await import('../src/skills/builtin/webhook.js');
        await initPersistentWebhooks();
        expect(getActiveWebhooks().size).toBeGreaterThan(0);
    });

    it('should handle corrupted webhook entries gracefully', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
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
            recallFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([
                { category: 'webhook', key: 'bad', value: 'not-json' },
            ]),
        }));
        vi.doMock('uuid', () => ({ v4: vi.fn().mockReturnValue('id') }));

        const { initPersistentWebhooks } = await import('../src/skills/builtin/webhook.js');
        // Should not throw
        await expect(initPersistentWebhooks()).resolves.not.toThrow();
    });
});

// ════════════════════════════════════════════════════════════════════
// Image Gen Skill
// ════════════════════════════════════════════════════════════════════

describe('Image Gen Skill', () => {
    let generateHandler: any;
    let editHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: {},
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));

        const handlers = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                handlers.set(handler.name, handler);
            }),
        }));

        const { registerImageGenSkill } = await import('../src/skills/builtin/image_gen.js');
        registerImageGenSkill();
        generateHandler = handlers.get('generate_image');
        editHandler = handlers.get('edit_image');
    });

    it('should register generate_image and edit_image handlers', () => {
        expect(generateHandler).toBeDefined();
        expect(generateHandler.name).toBe('generate_image');
        expect(editHandler).toBeDefined();
        expect(editHandler.name).toBe('edit_image');
    });

    it('generate_image should have correct parameters', () => {
        expect(generateHandler.parameters.required).toContain('prompt');
        expect(generateHandler.parameters.properties.size).toBeDefined();
        expect(generateHandler.parameters.properties.quality).toBeDefined();
        expect(generateHandler.parameters.properties.style).toBeDefined();
    });

    it('generate_image should return error for empty prompt', async () => {
        const result = await generateHandler.execute({ prompt: '' });
        expect(result).toContain('Error');
        expect(result).toContain('prompt is required');
    });

    it('generate_image should return error for whitespace-only prompt', async () => {
        const result = await generateHandler.execute({ prompt: '   ' });
        expect(result).toContain('Error');
        expect(result).toContain('prompt is required');
    });

    it('generate_image should return error when no API key', async () => {
        const result = await generateHandler.execute({ prompt: 'A sunset over mountains' });
        expect(result).toContain('Error');
        expect(result).toContain('OpenAI API key');
    });

    it('generate_image should call API and return image URL', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [{
                    url: 'https://images.openai.com/generated/test.png',
                    revised_prompt: 'A stunning sunset',
                }],
            }),
        }) as any;

        try {
            const { registerImageGenSkill } = await import('../src/skills/builtin/image_gen.js');
            registerImageGenSkill();
            const result = await handlers2.get('generate_image').execute({
                prompt: 'A sunset',
                size: '1792x1024',
                quality: 'hd',
                style: 'natural',
            });
            expect(result).toContain('Image generated successfully');
            expect(result).toContain('https://images.openai.com/generated/test.png');
            expect(result).toContain('1792x1024');
            expect(result).toContain('hd');
            expect(result).toContain('natural');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('generate_image should handle API error response', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => 'Bad request: content policy violation',
        }) as any;

        try {
            const { registerImageGenSkill } = await import('../src/skills/builtin/image_gen.js');
            registerImageGenSkill();
            const result = await handlers2.get('generate_image').execute({ prompt: 'test' });
            expect(result).toContain('Error');
            expect(result).toContain('400');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('generate_image should handle empty data response', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [] }),
        }) as any;

        try {
            const { registerImageGenSkill } = await import('../src/skills/builtin/image_gen.js');
            registerImageGenSkill();
            const result = await handlers2.get('generate_image').execute({ prompt: 'test' });
            expect(result).toContain('Error');
            expect(result).toContain('No image data');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('generate_image should handle network error', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                providers: { openai: { apiKey: 'test-key' } },
            }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

        try {
            const { registerImageGenSkill } = await import('../src/skills/builtin/image_gen.js');
            registerImageGenSkill();
            const result = await handlers2.get('generate_image').execute({ prompt: 'test' });
            expect(result).toContain('Error');
            expect(result).toContain('ECONNREFUSED');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('edit_image should require imagePath and prompt', async () => {
        const result = await editHandler.execute({});
        expect(result).toContain('Error');
        expect(result).toContain('imagePath and prompt are required');
    });

    it('edit_image should return information about editing process', async () => {
        const result = await editHandler.execute({ imagePath: '/tmp/image.png', prompt: 'add a hat' });
        expect(result).toContain('Image editing information');
        expect(result).toContain('/tmp/image.png');
        expect(result).toContain('add a hat');
    });
});

// ════════════════════════════════════════════════════════════════════
// Sessions Skill
// ════════════════════════════════════════════════════════════════════

describe('Sessions Skill', () => {
    let sessionsListHandler: any;
    let sessionsHistoryHandler: any;
    let sessionsSendHandler: any;
    let sessionsCloseHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));

        const handlers = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                handlers.set(handler.name, handler);
            }),
        }));

        vi.doMock('../src/agent/session.js', () => ({
            listSessions: vi.fn().mockReturnValue([]),
            getOrCreateSession: vi.fn().mockReturnValue({ id: 'sess-1', channel: 'test', userId: 'user1' }),
            addMessage: vi.fn(),
            getContextMessages: vi.fn().mockReturnValue([]),
            closeSession: vi.fn(),
        }));

        vi.doMock('../src/agent/agent.js', () => ({
            processMessage: vi.fn().mockResolvedValue({ content: 'Agent response' }),
        }));

        const { registerSessionsSkill } = await import('../src/skills/builtin/sessions.js');
        registerSessionsSkill();

        sessionsListHandler = handlers.get('sessions_list');
        sessionsHistoryHandler = handlers.get('sessions_history');
        sessionsSendHandler = handlers.get('sessions_send');
        sessionsCloseHandler = handlers.get('sessions_close');
    });

    it('should register all four session handlers', () => {
        expect(sessionsListHandler).toBeDefined();
        expect(sessionsListHandler.name).toBe('sessions_list');
        expect(sessionsHistoryHandler).toBeDefined();
        expect(sessionsHistoryHandler.name).toBe('sessions_history');
        expect(sessionsSendHandler).toBeDefined();
        expect(sessionsSendHandler.name).toBe('sessions_send');
        expect(sessionsCloseHandler).toBeDefined();
        expect(sessionsCloseHandler.name).toBe('sessions_close');
    });

    it('sessions_list should return empty message', async () => {
        const result = await sessionsListHandler.execute({});
        expect(result).toContain('No active sessions');
    });

    it('sessions_list should list active sessions', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/agent/session.js', () => ({
            listSessions: vi.fn().mockReturnValue([
                { id: 'abcdefgh-1234', channel: 'discord', userId: 'user1', messageCount: 5, lastActive: '2026-01-01' },
            ]),
            getOrCreateSession: vi.fn(),
            addMessage: vi.fn(),
            getContextMessages: vi.fn().mockReturnValue([]),
            closeSession: vi.fn(),
        }));
        vi.doMock('../src/agent/agent.js', () => ({
            processMessage: vi.fn(),
        }));
        const { registerSessionsSkill } = await import('../src/skills/builtin/sessions.js');
        registerSessionsSkill();
        const result = await handlers2.get('sessions_list').execute({});
        expect(result).toContain('discord');
        expect(result).toContain('user1');
    });

    it('sessions_history should return empty message', async () => {
        const result = await sessionsHistoryHandler.execute({ sessionChannel: 'test', sessionUserId: 'user1' });
        expect(result).toContain('No messages');
    });

    it('sessions_history should show messages', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/agent/session.js', () => ({
            listSessions: vi.fn().mockReturnValue([]),
            getOrCreateSession: vi.fn().mockReturnValue({ id: 's1' }),
            addMessage: vi.fn(),
            getContextMessages: vi.fn().mockReturnValue([
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
            ]),
            closeSession: vi.fn(),
        }));
        vi.doMock('../src/agent/agent.js', () => ({
            processMessage: vi.fn(),
        }));
        const { registerSessionsSkill } = await import('../src/skills/builtin/sessions.js');
        registerSessionsSkill();
        const result = await handlers2.get('sessions_history').execute({ sessionChannel: 'test', sessionUserId: 'u1' });
        expect(result).toContain('[user]');
        expect(result).toContain('Hello');
        expect(result).toContain('[assistant]');
    });

    it('sessions_send should deliver a message and return response', async () => {
        const result = await sessionsSendHandler.execute({
            targetChannel: 'discord',
            targetUserId: 'user2',
            message: 'Hello from agent',
        });
        expect(result).toContain('Message delivered');
        expect(result).toContain('discord/user2');
        expect(result).toContain('Agent response');
    });

    it('sessions_send should handle errors', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/agent/session.js', () => ({
            listSessions: vi.fn(),
            getOrCreateSession: vi.fn(),
            addMessage: vi.fn(),
            getContextMessages: vi.fn(),
            closeSession: vi.fn(),
        }));
        vi.doMock('../src/agent/agent.js', () => ({
            processMessage: vi.fn().mockRejectedValue(new Error('Processing failed')),
        }));
        const { registerSessionsSkill } = await import('../src/skills/builtin/sessions.js');
        registerSessionsSkill();
        const result = await handlers2.get('sessions_send').execute({
            targetChannel: 'discord',
            targetUserId: 'user2',
            message: 'test',
        });
        expect(result).toContain('Error');
        expect(result).toContain('Processing failed');
    });

    it('sessions_close should close a session', async () => {
        const result = await sessionsCloseHandler.execute({ sessionId: 'sess-1' });
        expect(result).toContain('Session sess-1 closed');
    });
});

// ════════════════════════════════════════════════════════════════════
// Memory Graph Skill
// ════════════════════════════════════════════════════════════════════

describe('Memory Graph Skill', () => {
    let graphRememberHandler: any;
    let graphSearchHandler: any;
    let graphEntitiesHandler: any;
    let graphRecallHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));

        const handlers = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                handlers.set(handler.name, handler);
            }),
        }));

        vi.doMock('../src/memory/graph.js', () => ({
            addEpisode: vi.fn().mockResolvedValue({ id: 'ep-12345678-abcd' }),
            searchMemory: vi.fn().mockReturnValue([]),
            listEntities: vi.fn().mockReturnValue([]),
            getEntity: vi.fn().mockReturnValue(null),
            getEntityEpisodes: vi.fn().mockReturnValue([]),
            getRecentEpisodes: vi.fn().mockReturnValue([]),
        }));

        const { registerMemoryGraphSkill } = await import('../src/skills/builtin/memory_graph.js');
        registerMemoryGraphSkill();

        graphRememberHandler = handlers.get('graph_remember');
        graphSearchHandler = handlers.get('graph_search');
        graphEntitiesHandler = handlers.get('graph_entities');
        graphRecallHandler = handlers.get('graph_recall');
    });

    it('should register all four graph handlers', () => {
        expect(graphRememberHandler).toBeDefined();
        expect(graphRememberHandler.name).toBe('graph_remember');
        expect(graphSearchHandler).toBeDefined();
        expect(graphSearchHandler.name).toBe('graph_search');
        expect(graphEntitiesHandler).toBeDefined();
        expect(graphEntitiesHandler.name).toBe('graph_entities');
        expect(graphRecallHandler).toBeDefined();
        expect(graphRecallHandler.name).toBe('graph_recall');
    });

    // ── graph_remember ──

    it('graph_remember should require content', async () => {
        const result = await graphRememberHandler.execute({});
        expect(result).toContain('Error');
        expect(result).toContain('content is required');
    });

    it('graph_remember should add episode to graph', async () => {
        const result = await graphRememberHandler.execute({ content: 'Tony prefers TypeScript', source: 'cli' });
        expect(result).toContain('Remembered');
        // Episode ID is truncated to 8 chars in the output
        expect(result).toContain('ep-');
    });

    it('graph_remember should use default source', async () => {
        const result = await graphRememberHandler.execute({ content: 'Some fact' });
        expect(result).toContain('Remembered');
    });

    // ── graph_search ──

    it('graph_search should return no results message', async () => {
        const result = await graphSearchHandler.execute({ query: 'nonexistent' });
        expect(result).toContain('No matching memories');
    });

    it('graph_search should return formatted results', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/memory/graph.js', () => ({
            addEpisode: vi.fn(),
            searchMemory: vi.fn().mockReturnValue([
                { id: 'ep1', content: 'TypeScript is great', source: 'cli', createdAt: '2026-01-15T10:00:00Z', entities: [] },
                { id: 'ep2', content: 'TITAN is an AI agent', source: 'agent', createdAt: '2026-01-16T12:00:00Z', entities: [] },
            ]),
            listEntities: vi.fn().mockReturnValue([]),
            getEntity: vi.fn(),
            getEntityEpisodes: vi.fn(),
            getRecentEpisodes: vi.fn(),
        }));
        const { registerMemoryGraphSkill } = await import('../src/skills/builtin/memory_graph.js');
        registerMemoryGraphSkill();
        const result = await handlers2.get('graph_search').execute({ query: 'TypeScript' });
        expect(result).toContain('[1]');
        expect(result).toContain('TypeScript is great');
        expect(result).toContain('cli');
    });

    // ── graph_entities ──

    it('graph_entities should return no entities message', async () => {
        const result = await graphEntitiesHandler.execute({});
        expect(result).toContain('No entities');
    });

    it('graph_entities should return filtered no entities message', async () => {
        const result = await graphEntitiesHandler.execute({ type: 'person' });
        expect(result).toContain('No person entities');
    });

    it('graph_entities should list entities', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/memory/graph.js', () => ({
            addEpisode: vi.fn(),
            searchMemory: vi.fn(),
            listEntities: vi.fn().mockReturnValue([
                { id: 'e1', name: 'Tony', type: 'person', facts: ['Likes TypeScript', 'Built TITAN'], aliases: [] },
                { id: 'e2', name: 'TITAN', type: 'project', facts: ['AI agent framework'], aliases: [] },
            ]),
            getEntity: vi.fn(),
            getEntityEpisodes: vi.fn(),
            getRecentEpisodes: vi.fn(),
        }));
        const { registerMemoryGraphSkill } = await import('../src/skills/builtin/memory_graph.js');
        registerMemoryGraphSkill();
        const result = await handlers2.get('graph_entities').execute({});
        expect(result).toContain('Tony');
        expect(result).toContain('person');
        expect(result).toContain('TITAN');
        expect(result).toContain('project');
    });

    // ── graph_recall ──

    it('graph_recall should require entity name', async () => {
        const result = await graphRecallHandler.execute({});
        expect(result).toContain('Error');
        expect(result).toContain('entity name is required');
    });

    it('graph_recall should fallback to search when entity not found', async () => {
        const result = await graphRecallHandler.execute({ entity: 'unknown' });
        expect(result).toContain('No memories found');
    });

    it('graph_recall should return search results when entity not found but search has results', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/memory/graph.js', () => ({
            addEpisode: vi.fn(),
            searchMemory: vi.fn().mockReturnValue([
                { id: 'ep1', content: 'Tony mentioned TITAN at the meetup', source: 'discord', createdAt: '2026-02-01T00:00:00Z', entities: [] },
            ]),
            listEntities: vi.fn().mockReturnValue([]),
            getEntity: vi.fn().mockReturnValue(null),
            getEntityEpisodes: vi.fn().mockReturnValue([]),
            getRecentEpisodes: vi.fn().mockReturnValue([]),
        }));
        const { registerMemoryGraphSkill } = await import('../src/skills/builtin/memory_graph.js');
        registerMemoryGraphSkill();
        const result = await handlers2.get('graph_recall').execute({ entity: 'Tony' });
        expect(result).toContain('No entity named "Tony"');
        expect(result).toContain('1 related episodes');
        expect(result).toContain('Tony mentioned TITAN');
    });

    it('graph_recall should show entity details with episodes', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/memory/graph.js', () => ({
            addEpisode: vi.fn(),
            searchMemory: vi.fn(),
            listEntities: vi.fn(),
            getEntity: vi.fn().mockReturnValue({
                id: 'e1',
                name: 'Tony',
                type: 'person',
                facts: ['Built TITAN', 'Prefers TypeScript'],
                firstSeen: '2026-01-01T00:00:00Z',
                lastSeen: '2026-03-01T00:00:00Z',
                aliases: [],
            }),
            getEntityEpisodes: vi.fn().mockReturnValue([
                { id: 'ep1', content: 'Tony discussed architecture', source: 'cli', createdAt: '2026-02-15T10:00:00Z', entities: ['e1'] },
            ]),
            getRecentEpisodes: vi.fn(),
        }));
        const { registerMemoryGraphSkill } = await import('../src/skills/builtin/memory_graph.js');
        registerMemoryGraphSkill();
        const result = await handlers2.get('graph_recall').execute({ entity: 'Tony' });
        expect(result).toContain('**Tony**');
        expect(result).toContain('person');
        expect(result).toContain('Built TITAN');
        expect(result).toContain('Prefers TypeScript');
        expect(result).toContain('Tony discussed architecture');
        expect(result).toContain('First seen');
    });

    it('graph_recall should handle entity with no facts and no episodes', async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        const handlers2 = new Map<string, any>();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handlers2.set(h.name, h); }),
        }));
        vi.doMock('../src/memory/graph.js', () => ({
            addEpisode: vi.fn(),
            searchMemory: vi.fn(),
            listEntities: vi.fn(),
            getEntity: vi.fn().mockReturnValue({
                id: 'e2',
                name: 'EmptyEntity',
                type: 'topic',
                facts: [],
                firstSeen: '2026-01-01T00:00:00Z',
                lastSeen: '2026-01-01T00:00:00Z',
                aliases: [],
            }),
            getEntityEpisodes: vi.fn().mockReturnValue([]),
            getRecentEpisodes: vi.fn(),
        }));
        const { registerMemoryGraphSkill } = await import('../src/skills/builtin/memory_graph.js');
        registerMemoryGraphSkill();
        const result = await handlers2.get('graph_recall').execute({ entity: 'EmptyEntity' });
        expect(result).toContain('**EmptyEntity**');
        expect(result).toContain('none recorded');
        expect(result).toContain('No episodes');
    });
});

// ════════════════════════════════════════════════════════════════════
// Computer Use Skill
// ════════════════════════════════════════════════════════════════════

describe('Computer Use Skill', () => {
    let handlers: Map<string, any>;

    beforeEach(async () => {
        vi.resetModules();
        handlers = new Map<string, any>();

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                handlers.set(handler.name, handler);
            }),
        }));
        vi.doMock('child_process', () => ({
            execFileSync: vi.fn().mockReturnValue(Buffer.from('success')),
        }));
        vi.doMock('fs', async () => {
            const actual = await vi.importActual<typeof import('fs')>('fs');
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readFileSync: vi.fn().mockReturnValue(Buffer.from('data')),
                mkdirSync: vi.fn(),
            };
        });
    });

    it('should register all computer use handlers', async () => {
        const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
        registerComputerUseSkill();

        expect(handlers.has('screenshot')).toBe(true);
        expect(handlers.has('mouse_click')).toBe(true);
        expect(handlers.has('mouse_move')).toBe(true);
        expect(handlers.has('keyboard_type')).toBe(true);
        expect(handlers.has('keyboard_press')).toBe(true);
        expect(handlers.has('screen_read')).toBe(true);
    });

    it('screenshot handler should invoke scrot on linux', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('screenshot');
            const result = await handler.execute({ target: 'screen' });
            // The mock readFileSync returns Buffer.from('data'), which base64-encodes to 'ZGF0YQ=='
            expect(result).toContain('data:image/png;base64,');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('screenshot handler should invoke screencapture on macOS', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

        try {
            vi.resetModules();
            handlers = new Map<string, any>();

            vi.doMock('../src/utils/logger.js', () => ({
                default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            }));
            vi.doMock('../src/config/config.js', () => ({
                loadConfig: vi.fn().mockReturnValue({
                    security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
                }),
            }));
            vi.doMock('../src/skills/registry.js', () => ({
                registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                    handlers.set(handler.name, handler);
                }),
            }));
            vi.doMock('child_process', () => ({
                execFileSync: vi.fn().mockReturnValue(Buffer.from('success')),
            }));
            vi.doMock('fs', async () => {
                const actual = await vi.importActual<typeof import('fs')>('fs');
                return {
                    ...actual,
                    existsSync: vi.fn().mockReturnValue(true),
                    readFileSync: vi.fn().mockReturnValue(Buffer.from('screenshot-data')),
                    mkdirSync: vi.fn(),
                };
            });

            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('screenshot');
            const result = await handler.execute({ target: 'screen' });
            expect(result).toContain('data:image/png;base64,');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('screenshot should return error when no screenshot tool is available', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            vi.resetModules();
            handlers = new Map<string, any>();

            vi.doMock('../src/utils/logger.js', () => ({
                default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            }));
            vi.doMock('../src/config/config.js', () => ({
                loadConfig: vi.fn().mockReturnValue({
                    security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
                }),
            }));
            vi.doMock('../src/skills/registry.js', () => ({
                registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                    handlers.set(handler.name, handler);
                }),
            }));
            // execFileSync throws for 'which' calls (no tools available)
            vi.doMock('child_process', () => ({
                execFileSync: vi.fn().mockImplementation((cmd: string) => {
                    if (cmd === 'which') throw new Error('not found');
                    return Buffer.from('success');
                }),
            }));
            vi.doMock('fs', async () => {
                const actual = await vi.importActual<typeof import('fs')>('fs');
                return {
                    ...actual,
                    existsSync: vi.fn().mockReturnValue(false),
                    readFileSync: vi.fn().mockReturnValue(Buffer.from('data')),
                    mkdirSync: vi.fn(),
                };
            });

            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('screenshot');
            const result = await handler.execute({ target: 'screen' });
            expect(result).toContain('Error');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('mouse_click should accept valid coordinates', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('mouse_click');
            const result = await handler.execute({ x: 100, y: 200 });
            expect(typeof result).toBe('string');
            // Should succeed or report missing xdotool — not a coordinate error
            expect(result).not.toContain('Invalid coordinate');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('mouse_click should return error for invalid coordinates (NaN)', async () => {
        const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
        registerComputerUseSkill();

        const handler = handlers.get('mouse_click');
        const result = await handler.execute({ x: 'abc', y: 200 });
        expect(result).toContain('Error');
        expect(result).toContain('Invalid coordinate');
    });

    it('mouse_click should return error for invalid button name', async () => {
        const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
        registerComputerUseSkill();

        const handler = handlers.get('mouse_click');
        const result = await handler.execute({ x: 100, y: 200, button: 'invalid_btn' });
        expect(result).toContain('Error');
        expect(result).toContain('Invalid button');
    });

    it('keyboard_type should type text', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('keyboard_type');
            const result = await handler.execute({ text: 'Hello TITAN' });
            expect(typeof result).toBe('string');
            // Either succeeds or reports xdotool missing, but no empty-text error
            expect(result).not.toContain('non-empty string');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('keyboard_type should reject empty text', async () => {
        const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
        registerComputerUseSkill();

        const handler = handlers.get('keyboard_type');
        const result = await handler.execute({ text: '' });
        expect(result).toContain('Error');
        expect(result).toContain('non-empty string');
    });

    it('keyboard_press should validate named keys', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('keyboard_press');
            const result = await handler.execute({ keys: 'Enter' });
            expect(typeof result).toBe('string');
            // Should not contain 'Unknown key' error
            expect(result).not.toContain('Unknown key');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('keyboard_press should return error for invalid key name', async () => {
        const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
        registerComputerUseSkill();

        const handler = handlers.get('keyboard_press');
        const result = await handler.execute({ keys: 'InvalidKeyXYZ123' });
        expect(result).toContain('Error');
        expect(result).toContain('Unknown key');
    });

    it('keyboard_press should reject empty keys parameter', async () => {
        const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
        registerComputerUseSkill();

        const handler = handlers.get('keyboard_press');
        const result = await handler.execute({ keys: '' });
        expect(result).toContain('Error');
        expect(result).toContain('non-empty string');
    });

    it('screen_read should return clipboard content on linux', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('screen_read');
            const result = await handler.execute({ method: 'clipboard' });
            expect(typeof result).toBe('string');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('mouse_move should accept valid coordinates', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('mouse_move');
            const result = await handler.execute({ x: 500, y: 300 });
            expect(typeof result).toBe('string');
            expect(result).not.toContain('Invalid coordinate');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });

    it('mouse_move should return error for non-finite coordinates', async () => {
        const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
        registerComputerUseSkill();

        const handler = handlers.get('mouse_move');
        const result = await handler.execute({ x: Infinity, y: 300 });
        expect(result).toContain('Error');
        expect(result).toContain('Invalid coordinate');
    });

    it('keyboard_press should accept modifier+key combos like Control+C', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

        try {
            const { registerComputerUseSkill } = await import('../src/skills/builtin/computer_use.js');
            registerComputerUseSkill();

            const handler = handlers.get('keyboard_press');
            const result = await handler.execute({ keys: 'Control+c' });
            expect(typeof result).toBe('string');
            expect(result).not.toContain('Unknown');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
        }
    });
});

// ════════════════════════════════════════════════════════════════════
// Web Fetch Skill (web_browser / browse_url equivalent)
// ════════════════════════════════════════════════════════════════════

describe('Web Fetch Skill', () => {
    let fetchHandler: any;

    beforeEach(async () => {
        vi.resetModules();

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                fetchHandler = handler;
            }),
        }));
    });

    it('should register the web_fetch handler', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        expect(fetchHandler).toBeDefined();
        expect(fetchHandler.name).toBe('web_fetch');
    });

    it('should have url as a required parameter', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        expect(fetchHandler.parameters.required).toContain('url');
    });

    it('should return error for missing url', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        const result = await fetchHandler.execute({});
        expect(result).toContain('Error');
    });

    it('should block internal/localhost URLs (SSRF protection)', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        const result = await fetchHandler.execute({ url: 'http://localhost:8080/admin' });
        expect(result).toContain('Error');
        expect(result).toContain('internal');
    });

    it('should block private network 10.x.x.x URLs', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        const result = await fetchHandler.execute({ url: 'http://10.0.0.1/admin' });
        expect(result).toContain('Error');
        expect(result).toContain('internal');
    });

    it('should block 192.168.x.x URLs', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        const result = await fetchHandler.execute({ url: 'http://192.168.1.1/config' });
        expect(result).toContain('Error');
        expect(result).toContain('internal');
    });

    it('should block 127.0.0.1 URLs', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        const result = await fetchHandler.execute({ url: 'http://127.0.0.1:3000' });
        expect(result).toContain('Error');
        expect(result).toContain('internal');
    });

    it('should support extractMode text parameter', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        const props = fetchHandler.parameters.properties;
        expect(props.extractMode).toBeDefined();
        expect(props.extractMode.enum).toContain('markdown');
        expect(props.extractMode.enum).toContain('text');
    });

    it('should support maxChars parameter', async () => {
        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();

        const props = fetchHandler.parameters.properties;
        expect(props.maxChars).toBeDefined();
        expect(props.maxChars.type).toBe('number');
    });

    it('should handle fetch errors gracefully', async () => {
        // Mock global fetch to throw
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

        try {
            const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
            registerWebFetchSkill();

            const result = await fetchHandler.execute({ url: 'https://example.com' });
            expect(result).toContain('Error');
            expect(result).toContain('Network error');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

// ════════════════════════════════════════════════════════════════════
// Webhook Skill (Extended)
// ════════════════════════════════════════════════════════════════════

describe('Webhook Skill — Extended', () => {
    let webhookHandler: any;

    beforeEach(async () => {
        vi.resetModules();

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                webhookHandler = handler;
            }),
        }));
        vi.doMock('uuid', () => ({
            v4: vi.fn().mockReturnValue('wh-test-uuid-1234-5678'),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
        vi.doMock('../../memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
    });

    it('should register the webhook handler', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        expect(webhookHandler).toBeDefined();
        expect(webhookHandler.name).toBe('webhook');
    });

    it('should have action parameter with create, list, delete', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        const actionProp = webhookHandler.parameters.properties.action;
        expect(actionProp.enum).toContain('create');
        expect(actionProp.enum).toContain('list');
        expect(actionProp.enum).toContain('delete');
    });

    it('webhook_create should create a webhook and return its details', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        const result = await webhookHandler.execute({
            action: 'create',
            name: 'test-hook',
            path: '/hooks/test',
            handler: 'echo hello',
        });
        expect(result).toContain('Created webhook');
        expect(result).toContain('test-hook');
        expect(result).toContain('/hooks/test');
        expect(result).toContain('wh-test-uuid');
    });

    it('webhook_create should use defaults when name/path missing', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        const result = await webhookHandler.execute({ action: 'create' });
        expect(result).toContain('Created webhook');
        // Default name uses uuid prefix
        expect(result).toContain('webhook-');
        // Default method is POST
        expect(result).toContain('POST');
    });

    it('webhook_list should report no active webhooks when empty', async () => {
        const { registerWebhookSkill, getActiveWebhooks } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        // Clear any webhooks that might exist from other tests
        getActiveWebhooks().clear();

        const result = await webhookHandler.execute({ action: 'list' });
        expect(result).toContain('No active webhooks');
    });

    it('webhook_list should return active webhooks after creation', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        await webhookHandler.execute({ action: 'create', name: 'my-hook', path: '/my-hook', handler: 'notify' });
        const result = await webhookHandler.execute({ action: 'list' });
        expect(result).toContain('my-hook');
        expect(result).toContain('/my-hook');
    });

    it('webhook_delete should require webhookId parameter', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        const result = await webhookHandler.execute({ action: 'delete' });
        expect(result).toContain('Error');
        expect(result).toContain('webhookId is required');
    });

    it('webhook_delete should remove a webhook by id', async () => {
        const { registerWebhookSkill, getActiveWebhooks } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        await webhookHandler.execute({ action: 'create', name: 'to-delete', path: '/delete-me' });
        const hookId = Array.from(getActiveWebhooks().keys())[0];

        const result = await webhookHandler.execute({ action: 'delete', webhookId: hookId });
        expect(result).toContain('Deleted webhook');
        expect(getActiveWebhooks().has(hookId)).toBe(false);
    });

    it('webhook_create should support custom method (GET)', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        const result = await webhookHandler.execute({
            action: 'create',
            name: 'get-hook',
            path: '/get-test',
            method: 'GET',
            handler: 'list items',
        });
        expect(result).toContain('GET');
        expect(result).toContain('get-hook');
    });

    it('should handle unknown action gracefully', async () => {
        const { registerWebhookSkill } = await import('../src/skills/builtin/webhook.js');
        registerWebhookSkill();

        const result = await webhookHandler.execute({ action: 'restart' });
        expect(result).toContain('Unknown action');
    });

    it('initPersistentWebhooks should load webhooks from memory', async () => {
        vi.resetModules();

        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn(),
        }));
        vi.doMock('uuid', () => ({
            v4: vi.fn().mockReturnValue('init-uuid'),
        }));
        vi.doMock('../src/memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([
                {
                    key: 'hook-1',
                    value: JSON.stringify({
                        id: 'hook-1',
                        path: '/restored',
                        name: 'restored-hook',
                        method: 'POST',
                        handler: 'do stuff',
                    }),
                    category: 'webhook',
                },
            ]),
        }));
        vi.doMock('../../memory/memory.js', () => ({
            getDb: vi.fn().mockReturnValue({ memories: [] }),
            rememberFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([
                {
                    key: 'hook-1',
                    value: JSON.stringify({
                        id: 'hook-1',
                        path: '/restored',
                        name: 'restored-hook',
                        method: 'POST',
                        handler: 'do stuff',
                    }),
                    category: 'webhook',
                },
            ]),
        }));

        const { initPersistentWebhooks, getActiveWebhooks } = await import('../src/skills/builtin/webhook.js');
        await initPersistentWebhooks();

        expect(getActiveWebhooks().has('hook-1')).toBe(true);
        const hook = getActiveWebhooks().get('hook-1');
        expect(hook?.name).toBe('restored-hook');
        expect(hook?.path).toBe('/restored');
    });
});
