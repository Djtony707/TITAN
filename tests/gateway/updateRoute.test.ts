/**
 * Regression tests for src/gateway/routes/update.ts.
 *
 * Pre-fix bugs (see route file for full history):
 *   1. Hard-coded `sudo systemctl restart titan-gateway` (wrong service name).
 *   2. Required passwordless sudo → hung detached script → service died.
 *   3. Ran `git pull` against /opt/TITAN even though it's an rsync target.
 *   4. Returned `{ok: true}` before the restart, lying to the UI.
 *
 * What these tests pin:
 *   - GET returns mode alongside version info.
 *   - Systemd mode is restart-only: no shell command, SIGTERM-to-self.
 *   - Dev-git mode runs `git pull && npm run build` then SIGTERMs.
 *   - npm-global mode runs `npm update -g titan-agent`.
 *   - All success responses carry willRestart/expectedDownMs.
 *   - Failure responses carry an error and willRestart=false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { ExecException } from 'child_process';
import { createUpdateRouter, detectUpdateMode, type UpdateRouterDeps } from '../../src/gateway/routes/update.js';

type ExecCallback = (error: ExecException | null, stdout: string, stderr: string) => void;

async function buildApp(deps: UpdateRouterDeps) {
    const app = express();
    app.use(express.json());
    app.use('/api', createUpdateRouter(deps));
    return app;
}

async function request(app: express.Express, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const server = app.listen(0);
    try {
        const port = (server.address() as { port: number }).port;
        const r = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        let json: unknown = text;
        try { json = JSON.parse(text); } catch { /* keep text */ }
        return { status: r.status, body: json };
    } finally {
        server.close();
    }
}

// Common deps factory — every test starts from sane defaults and only overrides
// what it cares about. Keeps each test focused and avoids cross-pollination.
function baseDeps(overrides: Partial<UpdateRouterDeps> = {}): UpdateRouterDeps {
    return {
        killSelf: vi.fn(),
        existsSyncFn: () => false,
        execFn: vi.fn() as any,
        getUpdateInfoFn: async () => ({ current: '6.2.1', latest: '6.2.2', isNewer: true }),
        cwdFn: () => '/srv/titan',
        envFn: () => undefined,
        ...overrides,
    };
}

describe('detectUpdateMode', () => {
    it('returns dev-git when .git exists at cwd (highest priority)', () => {
        const existsSyncFn = (p: string) => p === '/srv/titan/.git';
        expect(detectUpdateMode('/srv/titan', existsSyncFn)).toBe('dev-git');
    });

    it('returns dev-git even when systemd is also present (dev wins)', () => {
        // A dev who happens to be on a systemd box still wants build behavior,
        // not a blind restart. This is the precedence rule.
        const existsSyncFn = (p: string) => p === '/srv/titan/.git' || p === '/run/systemd/system';
        expect(detectUpdateMode('/srv/titan', existsSyncFn)).toBe('dev-git');
    });

    it('returns systemd when /run/systemd/system exists and no .git', () => {
        const existsSyncFn = (p: string) => p === '/run/systemd/system';
        expect(detectUpdateMode('/srv/titan', existsSyncFn)).toBe('systemd');
    });

    it('returns systemd via .systemd-service marker even without /run/systemd', () => {
        const existsSyncFn = (p: string) => p === '/srv/titan/.systemd-service';
        expect(detectUpdateMode('/srv/titan', existsSyncFn)).toBe('systemd');
    });

    it('returns npm-global when neither .git nor systemd markers exist', () => {
        expect(detectUpdateMode('/srv/titan', () => false)).toBe('npm-global');
    });
});

describe('GET /api/update', () => {
    it('returns version info plus detected mode', async () => {
        const app = await buildApp(baseDeps({
            existsSyncFn: (p) => p === '/run/systemd/system',
        }));
        const { status, body } = await request(app, 'GET', '/api/update');
        expect(status).toBe(200);
        expect(body).toMatchObject({
            current: '6.2.1',
            latest: '6.2.2',
            isNewer: true,
            mode: 'systemd',
        });
    });

    it('handles a getUpdateInfo failure mode gracefully (returns nulls)', async () => {
        const app = await buildApp(baseDeps({
            getUpdateInfoFn: async () => ({ current: '6.2.1', latest: null, isNewer: false }),
        }));
        const { status, body } = await request(app, 'GET', '/api/update');
        expect(status).toBe(200);
        expect(body.latest).toBeNull();
        expect(body.isNewer).toBe(false);
        expect(body.mode).toBe('npm-global');
    });
});

describe('POST /api/update — systemd mode (the bug that prompted this fix)', () => {
    beforeEach(() => vi.useFakeTimers());

    it('returns ok=true with willRestart=true and DOES NOT exec any shell command', async () => {
        const execFn = vi.fn() as any;
        const killSelf = vi.fn();
        const app = await buildApp(baseDeps({
            existsSyncFn: (p) => p === '/run/systemd/system',
            execFn,
            killSelf,
        }));
        const { status, body } = await request(app, 'POST', '/api/update', { restart: true });
        expect(status).toBe(200);
        expect(body).toMatchObject({
            ok: true,
            mode: 'systemd',
            willRestart: true,
        });
        expect(body.expectedDownMs).toBeGreaterThan(0);
        // The whole point of the fix: NO sudo systemctl, NO git pull, NO spawn.
        expect(execFn).not.toHaveBeenCalled();
        // killSelf scheduled but not yet fired (1s delay).
        expect(killSelf).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1100);
        expect(killSelf).toHaveBeenCalledTimes(1);
    });

    it('with restart=false returns no-op without scheduling a SIGTERM', async () => {
        const killSelf = vi.fn();
        const app = await buildApp(baseDeps({
            existsSyncFn: (p) => p === '/run/systemd/system',
            killSelf,
        }));
        const { status, body } = await request(app, 'POST', '/api/update', { restart: false });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.willRestart).toBe(false);
        expect(body.expectedDownMs).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2000);
        expect(killSelf).not.toHaveBeenCalled();
    });

    it('uses TITAN_SERVICE_NAME env in the message for operator clarity', async () => {
        const killSelf = vi.fn();
        const app = await buildApp(baseDeps({
            existsSyncFn: (p) => p === '/run/systemd/system',
            envFn: (k) => (k === 'TITAN_SERVICE_NAME' ? 'titan-prod' : undefined),
            killSelf,
        }));
        const { body } = await request(app, 'POST', '/api/update', { restart: true });
        expect(body.message).toContain('titan-prod');
    });
});

describe('POST /api/update — dev-git mode', () => {
    beforeEach(() => vi.useFakeTimers());

    it('runs git pull && npm run build then schedules a restart', async () => {
        const killSelf = vi.fn();
        let capturedCmd = '';
        const execFn = vi.fn((cmd: string, _opts: any, cb: ExecCallback) => {
            capturedCmd = cmd;
            cb(null, 'updated 12 files', '');
            return {} as any;
        }) as any;
        const app = await buildApp(baseDeps({
            existsSyncFn: (p) => p === '/srv/titan/.git',
            execFn,
            killSelf,
        }));
        const { status, body } = await request(app, 'POST', '/api/update', { restart: true });
        expect(status).toBe(200);
        expect(body).toMatchObject({ ok: true, mode: 'dev-git', willRestart: true });
        expect(capturedCmd).toBe('git pull && npm run build');
        await vi.advanceTimersByTimeAsync(1100);
        expect(killSelf).toHaveBeenCalledTimes(1);
    });

    it('surfaces exec errors as ok=false and skips restart', async () => {
        const killSelf = vi.fn();
        const execFn = vi.fn((_cmd: string, _opts: any, cb: ExecCallback) => {
            cb(new Error('merge conflict') as ExecException, '', 'CONFLICT');
            return {} as any;
        }) as any;
        const app = await buildApp(baseDeps({
            existsSyncFn: (p) => p === '/srv/titan/.git',
            execFn,
            killSelf,
        }));
        const { status, body } = await request(app, 'POST', '/api/update', { restart: true });
        expect(status).toBe(200);
        expect(body.ok).toBe(false);
        expect(body.willRestart).toBe(false);
        expect(body.error).toContain('merge conflict');
        await vi.advanceTimersByTimeAsync(2000);
        expect(killSelf).not.toHaveBeenCalled();
    });
});

describe('POST /api/update — npm-global mode', () => {
    beforeEach(() => vi.useFakeTimers());

    it('runs npm update -g titan-agent', async () => {
        let capturedCmd = '';
        const execFn = vi.fn((cmd: string, _opts: any, cb: ExecCallback) => {
            capturedCmd = cmd;
            cb(null, '+ titan-agent@6.2.2', '');
            return {} as any;
        }) as any;
        const app = await buildApp(baseDeps({
            existsSyncFn: () => false,
            execFn,
        }));
        const { status, body } = await request(app, 'POST', '/api/update', { restart: false });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.mode).toBe('npm-global');
        expect(capturedCmd).toBe('npm update -g titan-agent');
    });

    it('surfaces EACCES from sudo-installed prefix honestly', async () => {
        const execFn = vi.fn((_cmd: string, _opts: any, cb: ExecCallback) => {
            const err = Object.assign(new Error('EACCES: permission denied, /usr/lib/node_modules'), { code: 'EACCES' });
            cb(err as ExecException, '', '');
            return {} as any;
        }) as any;
        const app = await buildApp(baseDeps({
            existsSyncFn: () => false,
            execFn,
        }));
        const { body } = await request(app, 'POST', '/api/update');
        expect(body.ok).toBe(false);
        expect(body.error).toContain('EACCES');
    });
});
