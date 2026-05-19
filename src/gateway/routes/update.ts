/**
 * Tests live in tests/gateway/updateRoute.test.ts. Keep DI seams intact so
 * those tests can mock killSelf/existsSyncFn/execFn/getUpdateInfoFn without
 * touching real disk, real npm, or real process signals.
 *
 * /api/update route — extracted from server.ts during the update-button fix.
 *
 * Why this exists as its own module:
 *   The inline POST /api/update handler in server.ts had four shipping bugs
 *   that broke the in-app "Update to vX.Y.Z" button for systemd installs
 *   (which is how Tony's box and the docs both deploy TITAN):
 *
 *     1. Hard-coded `sudo systemctl restart titan-gateway` — the real
 *        service name is `titan` everywhere we ship.
 *     2. Required passwordless sudo from the service user (`dj`), which
 *        is not configured by default → the detached restart script hung
 *        on the password prompt forever and the service stayed dead.
 *     3. Assumed `/opt/TITAN` is a git working tree and ran `git pull` in
 *        it. `/opt/TITAN` is an rsync target per the deploy procedure, not
 *        a git checkout, so this either errored or no-op'd silently.
 *     4. Returned `{ok: true}` to the UI before the restart actually ran,
 *        so users saw "Update completed" while the service was dying.
 *
 * The fix:
 *   - For systemd installs: send SIGTERM to ourselves and let
 *     `Restart=always` revive the process on whatever files are on disk.
 *     This is exactly the manual recovery path we already use; the button
 *     just automates it. No sudo, no service-name guessing, no fragile
 *     detached scripts.
 *   - For git-checkout dev installs: still run `git pull && npm run build`
 *     first, then SIGTERM-to-self (if Restart=always is wired) or spawn
 *     a fresh node child (if not).
 *   - For global-npm installs (no systemd, no .git): keep the existing
 *     `npm update -g titan-agent` path — works for users on nvm/volta/fnm.
 *     Users who installed with `sudo npm i -g` will still need to update
 *     from a terminal; that's outside the scope of an in-app button.
 *   - Always return an honest `{ok, willRestart, expectedDownMs, mode}`
 *     shape so the UI can show a real "Reconnecting…" state instead of
 *     a fake "Update completed" toast.
 */
import { exec as nodeExec, type ExecException } from 'child_process';
import nodeFs from 'fs';
import { join } from 'path';
import { Router } from 'express';
import logger from '../../utils/logger.js';
import { getUpdateInfo as defaultGetUpdateInfo } from '../../utils/updater.js';

const COMPONENT = 'update-route';

export type UpdateMode = 'dev-git' | 'systemd' | 'npm-global';

/**
 * Returned from POST /api/update. Older clients that only check `ok` keep
 * working; newer clients (StatusBar, TitanCanvas) can read `willRestart`
 * and `expectedDownMs` to drive a reconnect UX.
 */
export interface UpdateActionResult {
    ok: boolean;
    mode: UpdateMode;
    willRestart: boolean;
    expectedDownMs?: number;
    message?: string;
    output?: string;
    error?: string;
}

export interface UpdateRouterDeps {
    /** Override SIGTERM target for tests. Default: send SIGTERM to current pid. */
    killSelf?: () => void;
    /** fs.existsSync override for tests. */
    existsSyncFn?: (path: string) => boolean;
    /** child_process.exec override for tests. */
    execFn?: typeof nodeExec;
    /** getUpdateInfo override for tests. */
    getUpdateInfoFn?: typeof defaultGetUpdateInfo;
    /** Override process.cwd() for tests. */
    cwdFn?: () => string;
    /** Override env lookup for tests. */
    envFn?: (key: string) => string | undefined;
}

const RESTART_DELAY_MS = 1000;
const EXPECTED_DOWN_MS = 2500; // Conservative: systemd Restart=always usually revives within ~1s.

/**
 * Decide which update path applies based on what's on disk.
 *
 * Order matters:
 *   1. `.git/` at cwd → developer checkout, do the full git-pull+build path.
 *      We check this first because a dev who happens to be on a systemd box
 *      (rare but real) should still get build behavior, not a blind restart.
 *   2. `/run/systemd/system` exists or `.systemd-service` marker at cwd →
 *      production systemd install. Restart-only path; operator handles
 *      file deployment via rsync/ansible/docker.
 *   3. Otherwise → global npm install. `npm update -g`.
 */
export function detectUpdateMode(
    cwd: string,
    existsSyncFn: (p: string) => boolean,
): UpdateMode {
    if (existsSyncFn(join(cwd, '.git'))) return 'dev-git';
    if (existsSyncFn('/run/systemd/system') || existsSyncFn(join(cwd, '.systemd-service'))) {
        return 'systemd';
    }
    return 'npm-global';
}

export function createUpdateRouter(deps: UpdateRouterDeps = {}): Router {
    const router = Router();
    const killSelf = deps.killSelf ?? (() => process.kill(process.pid, 'SIGTERM'));
    const existsSyncFn = deps.existsSyncFn ?? nodeFs.existsSync;
    const execFn = deps.execFn ?? nodeExec;
    const getUpdateInfoFn = deps.getUpdateInfoFn ?? defaultGetUpdateInfo;
    const cwdFn = deps.cwdFn ?? (() => process.cwd());
    const envFn = deps.envFn ?? ((key: string) => process.env[key]);

    router.get('/update', async (_req, res) => {
        const info = await getUpdateInfoFn();
        const mode = detectUpdateMode(cwdFn(), existsSyncFn);
        res.json({ ...info, mode });
    });

    router.post('/update', (req, res) => {
        const restart = req.body?.restart === true;
        const mode = detectUpdateMode(cwdFn(), existsSyncFn);
        const serviceName = envFn('TITAN_SERVICE_NAME') || 'titan';

        // Commands per mode.
        // Systemd: nothing to fetch — files are deployed externally (rsync/ansible/docker).
        //          The button's only job is to reload the running process into them.
        // Dev-git: pull + build, then restart so the new dist/ is loaded.
        // npm-global: shell out to npm; if the user is on nvm/volta/fnm this works
        //          without sudo. If they did `sudo npm i -g`, npm will EACCES and we
        //          surface the error honestly instead of pretending.
        let command: string | null = null;
        if (mode === 'dev-git') command = 'git pull && npm run build';
        else if (mode === 'npm-global') command = 'npm update -g titan-agent';
        // mode === 'systemd' → command stays null, we skip exec entirely

        logger.info(
            COMPONENT,
            `Update requested: mode=${mode} restart=${restart} service=${serviceName} command=${command ?? '(none, restart-only)'}`,
        );

        const scheduleRestart = (): void => {
            // setTimeout-then-SIGTERM. With systemd Restart=always (verified on Titan PC)
            // this gives the HTTP response time to flush before we tear the process down.
            setTimeout(() => {
                logger.info(COMPONENT, `Sending SIGTERM to self (pid=${process.pid}) for restart`);
                try {
                    killSelf();
                } catch (err) {
                    logger.error(COMPONENT, `SIGTERM failed: ${(err as Error).message}`);
                }
            }, RESTART_DELAY_MS);
        };

        if (command === null) {
            // Pure-restart path. systemd will revive us.
            const result: UpdateActionResult = {
                ok: true,
                mode,
                willRestart: restart,
                expectedDownMs: restart ? EXPECTED_DOWN_MS : undefined,
                message: restart
                    ? `Restarting ${serviceName}. systemd will revive the process on the on-disk files.`
                    : 'No-op: no command to run for systemd mode. Pass {"restart": true} to reload the process.',
            };
            res.json(result);
            if (restart) scheduleRestart();
            return;
        }

        // dev-git or npm-global path: run command, then optionally restart.
        execFn(command, { timeout: 180_000 }, (error: ExecException | null, stdout: string) => {
            if (error) {
                logger.error(COMPONENT, `Update command failed (${mode}): ${error.message}`);
                if (!res.headersSent) {
                    const result: UpdateActionResult = {
                        ok: false,
                        mode,
                        willRestart: false,
                        error: error.message,
                        output: stdout?.slice(-500),
                    };
                    res.json(result);
                }
                return;
            }
            logger.info(COMPONENT, `Update command succeeded (${mode})`);
            if (!res.headersSent) {
                const result: UpdateActionResult = {
                    ok: true,
                    mode,
                    willRestart: restart,
                    expectedDownMs: restart ? EXPECTED_DOWN_MS : undefined,
                    message: restart ? 'Update complete. Restarting.' : 'Update complete.',
                    output: stdout?.slice(-500),
                };
                res.json(result);
            }
            if (restart) scheduleRestart();
        });
    });

    return router;
}
