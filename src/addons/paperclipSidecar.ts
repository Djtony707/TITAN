/**
 * Paperclip Sidecar — manages the real Paperclip server as a child process,
 * proxies requests, and bridges events into TITAN's event system.
 */
import { fork, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import logger from '../utils/logger.js';

const COMPONENT = 'PaperclipSidecar';
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 2000;
const HEALTH_CHECK_INTERVAL_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

interface PaperclipConfig {
    enabled: boolean;
    port: number;
    databaseUrl?: string;
    autoStart: boolean;
}

let childProcess: ChildProcess | null = null;
let restartCount = 0;
let healthInterval: ReturnType<typeof setInterval> | null = null;
let eventBridgeWs: WebSocket | null = null;
let eventBridgeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentConfig: PaperclipConfig | null = null;
let titanEventsEmitter: { emit: (event: string, data: unknown) => boolean } | null = null;

function getPaperclipDir(): string {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // In dev: src/addons/ -> addons/paperclip/
    // In dist: dist/addons/ -> addons/paperclip/
    return join(__dirname, '..', '..', 'addons', 'paperclip');
}

export async function startPaperclip(
    config: PaperclipConfig,
    events?: { emit: (event: string, data: unknown) => boolean },
): Promise<void> {
    if (!config.enabled || !config.autoStart) {
        logger.info(COMPONENT, 'Paperclip sidecar disabled or autoStart=false, skipping');
        return;
    }

    currentConfig = config;
    if (events) titanEventsEmitter = events;

    const paperclipDir = getPaperclipDir();
    const serverEntry = join(paperclipDir, 'server', 'src', 'index.ts');

    // Ensure npm global bin is in PATH so adapters can find claude, gemini, etc.
    const npmGlobalBin = join(process.env.HOME || '/root', '.npm-global', 'bin');
    const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

    // Generate a stable JWT secret for agent API keys (persisted in config)
    const configDir = join(process.env.HOME || '/root', '.paperclip', 'instances', 'default');
    let jwtSecret = '';
    try {
        const configPath = join(configDir, 'config.json');
        const configData = JSON.parse((await import('fs')).readFileSync(configPath, 'utf8'));
        jwtSecret = configData.localAgentJwtSecret || '';
    } catch { /* no config yet */ }
    if (!jwtSecret) {
        // Generate and persist a new JWT secret
        const { randomBytes } = await import('crypto');
        jwtSecret = randomBytes(32).toString('hex');
        try {
            const fs = await import('fs');
            fs.mkdirSync(configDir, { recursive: true });
            const configPath = join(configDir, 'config.json');
            let existing: Record<string, unknown> = {};
            try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* new file */ }
            existing.localAgentJwtSecret = jwtSecret;
            fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
            logger.info(COMPONENT, 'Generated and saved Paperclip agent JWT secret');
        } catch (e) {
            logger.warn(COMPONENT, `Could not persist JWT secret: ${(e as Error).message}`);
        }
    }

    const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        PATH: currentPath.includes(npmGlobalBin) ? currentPath : `${npmGlobalBin}:${currentPath}`,
        PORT: String(config.port),
        DEPLOYMENT_MODE: 'local_trusted',
        PAPERCLIP_MIGRATION_AUTO_APPLY: 'true',
        PAPERCLIP_AGENT_JWT_SECRET: jwtSecret,
        NODE_ENV: 'production',
    };

    if (config.databaseUrl) {
        env.DATABASE_URL = config.databaseUrl;
    }

    // Allow CORS from TITAN's origin
    const titanPort = process.env.PORT || '48420';
    env.CORS_ORIGIN = `http://localhost:${titanPort}`;

    logger.info(COMPONENT, `Starting Paperclip server on port ${config.port}...`);

    try {
        // Use tsx to run TypeScript directly (same as Paperclip's dev mode)
        childProcess = fork(serverEntry, [], {
            cwd: paperclipDir,
            env,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            execArgv: ['--import', 'tsx'],
        });

        childProcess.stdout?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) logger.info(COMPONENT, `[paperclip] ${msg}`);
        });

        childProcess.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) logger.warn(COMPONENT, `[paperclip] ${msg}`);
        });

        childProcess.on('exit', (code, signal) => {
            logger.warn(COMPONENT, `Paperclip exited (code=${code}, signal=${signal})`);
            childProcess = null;
            cleanupEventBridge();

            if (restartCount < MAX_RESTARTS && currentConfig) {
                restartCount++;
                logger.info(COMPONENT, `Restarting Paperclip (attempt ${restartCount}/${MAX_RESTARTS})...`);
                setTimeout(() => {
                    if (currentConfig) startPaperclip(currentConfig, titanEventsEmitter || undefined).catch(() => {});
                }, RESTART_DELAY_MS);
            } else {
                logger.error(COMPONENT, `Paperclip failed after ${MAX_RESTARTS} restarts, giving up`);
            }
        });

        childProcess.on('error', (err) => {
            logger.error(COMPONENT, `Paperclip process error: ${err.message}`);
        });

        // Wait for server to be ready
        await waitForReady(config.port);
        restartCount = 0;
        logger.info(COMPONENT, `Paperclip server running on port ${config.port}`);

        // Start health check
        startHealthCheck(config.port);

        // Start event bridge
        connectEventBridge(config.port);
    } catch (err) {
        logger.error(COMPONENT, `Failed to start Paperclip: ${(err as Error).message}`);
        throw err;
    }
}

export async function stopPaperclip(): Promise<void> {
    if (healthInterval) {
        clearInterval(healthInterval);
        healthInterval = null;
    }

    cleanupEventBridge();

    if (!childProcess) return;

    logger.info(COMPONENT, 'Stopping Paperclip server...');

    return new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
            if (childProcess) {
                logger.warn(COMPONENT, 'Force-killing Paperclip (SIGKILL)');
                childProcess.kill('SIGKILL');
            }
            resolve();
        }, 5000);

        childProcess!.on('exit', () => {
            clearTimeout(forceKillTimer);
            childProcess = null;
            resolve();
        });

        childProcess!.kill('SIGTERM');
    });
}

export async function getPaperclipStatus(): Promise<{
    running: boolean;
    port: number | null;
    pid: number | null;
    restarts: number;
    healthy: boolean;
}> {
    const port = currentConfig?.port ?? null;
    if (!childProcess) {
        return { running: false, port, pid: null, restarts: restartCount, healthy: false };
    }

    let healthy = false;
    if (port) {
        try {
            healthy = await healthCheck(port);
        } catch { /* unhealthy */ }
    }

    return {
        running: true,
        port,
        pid: childProcess.pid ?? null,
        restarts: restartCount,
        healthy,
    };
}

async function waitForReady(port: number, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const ok = await healthCheck(port);
            if (ok) return;
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Paperclip server did not become ready within ${timeoutMs}ms`);
}

async function healthCheck(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
        const res = await fetch(`http://localhost:${port}/api/health`, {
            signal: controller.signal,
        });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function startHealthCheck(port: number): void {
    if (healthInterval) clearInterval(healthInterval);
    healthInterval = setInterval(async () => {
        try {
            const ok = await healthCheck(port);
            if (!ok) {
                logger.warn(COMPONENT, 'Paperclip health check failed');
            }
        } catch { /* ignore */ }
    }, HEALTH_CHECK_INTERVAL_MS);
    healthInterval.unref();
}

// ── Event Bridge: Paperclip WebSocket → TITAN events ──────────────

function connectEventBridge(port: number): void {
    if (eventBridgeWs) {
        try { eventBridgeWs.close(); } catch { /* ignore */ }
    }

    // Paperclip's live events WebSocket (company 1 for local_trusted mode)
    const wsUrl = `ws://localhost:${port}/api/companies/1/events/ws`;

    try {
        eventBridgeWs = new WebSocket(wsUrl);

        eventBridgeWs.on('open', () => {
            logger.info(COMPONENT, 'Event bridge connected to Paperclip');
        });

        eventBridgeWs.on('message', (data) => {
            try {
                const event = JSON.parse(data.toString());
                if (titanEventsEmitter && event.type) {
                    titanEventsEmitter.emit(`paperclip:${event.type}`, event);
                }
            } catch { /* malformed event */ }
        });

        eventBridgeWs.on('close', () => {
            logger.info(COMPONENT, 'Event bridge disconnected');
            scheduleReconnect(port);
        });

        eventBridgeWs.on('error', () => {
            scheduleReconnect(port);
        });
    } catch {
        scheduleReconnect(port);
    }
}

function scheduleReconnect(port: number): void {
    if (eventBridgeReconnectTimer) return;
    if (!childProcess) return; // Don't reconnect if Paperclip is stopped

    eventBridgeReconnectTimer = setTimeout(() => {
        eventBridgeReconnectTimer = null;
        if (childProcess) connectEventBridge(port);
    }, 5000);
}

function cleanupEventBridge(): void {
    if (eventBridgeReconnectTimer) {
        clearTimeout(eventBridgeReconnectTimer);
        eventBridgeReconnectTimer = null;
    }
    if (eventBridgeWs) {
        try { eventBridgeWs.close(); } catch { /* ignore */ }
        eventBridgeWs = null;
    }
}
