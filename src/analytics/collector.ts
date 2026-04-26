/**
 * TITAN — Analytics Collector
 * Collects anonymized system profile and usage heartbeat for product analytics.
 * All data is privacy-respecting: no IP, no personal data, no conversation content.
 */
import { platform, arch, release, cpus, totalmem } from 'os';
import { detectHardware } from '../hardware/autoConfig.js';
import { getOrCreateNodeId } from '../mesh/identity.js';
import { TITAN_VERSION } from '../utils/constants.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { sendPostHogEvent, getPostHogStatus } from './posthog.js';

const COMPONENT = 'Analytics';

export interface SystemProfile {
    /** Anonymous install ID — stable per ~/.titan/ */
    installId: string;
    /** TITAN version */
    version: string;
    /** Node.js version */
    nodeVersion: string;
    /** OS platform */
    os: string;
    /** OS release */
    osRelease: string;
    /** CPU architecture */
    arch: string;
    /** CPU cores */
    cpuCores: number;
    /** Total RAM in GB (bucketed to nearest GB) */
    ramTotalGB: number;
    /** GPU vendor */
    gpuVendor: string;
    /** GPU VRAM in GB (bucketed to nearest GB) */
    gpuVramGB: number;
    /** Install method: 'git' | 'npm' | 'unknown' */
    installMethod: string;
    /** Total disk GB (bucketed to nearest 10GB) */
    diskTotalGB: number;
    /** Timestamp of collection */
    collectedAt: string;
}

export interface HeartbeatEvent {
    installId: string;
    version: string;
    event: 'heartbeat' | 'startup' | 'shutdown';
    timestamp: string;
    uptimeSeconds: number;
    activeSessions: number;
    /** Feature adoption snapshot — which major subsystems are enabled */
    features?: {
        voice: boolean;
        mesh: boolean;
        brain: boolean;
        tunnel: boolean;
        autopilot: boolean;
        selfImprove: boolean;
        training: boolean;
        daemon: boolean;
        nvidia: boolean;
        organism: boolean;
        selfMod: boolean;
        commandPost: boolean;
        mcpServer: boolean;
        /** Count of enabled channel adapters */
        channelsEnabled: number;
        /** Count of providers with at least one auth profile or apiKey */
        providersConfigured: number;
    };
}

/** Detect how TITAN was installed */
async function detectInstallMethod(): Promise<'git' | 'npm' | 'unknown'> {
    try {
        const { existsSync } = await import('fs');
        const { join } = await import('path');
        if (existsSync(join(process.cwd(), '.git'))) return 'git';
        if (process.cwd().includes('node_modules') || process.cwd().includes('/lib/node')) return 'npm';
    } catch { /* ignore */ }
    return 'unknown';
}

/** Bucket a value to the nearest step */
function bucketToNearest(value: number, step: number): number {
    return Math.round(value / step) * step;
}

/** Collect full system profile (privacy-respecting: no cpuModel/gpuName, bucketed sizes) */
export async function collectSystemProfile(): Promise<SystemProfile> {
    const hw = await detectHardware();
    const installMethod = await detectInstallMethod();
    const cpuList = cpus();

    return {
        installId: getOrCreateNodeId(),
        version: TITAN_VERSION,
        nodeVersion: process.version,
        os: platform(),
        osRelease: release(),
        arch: arch(),
        cpuCores: cpuList.length || hw.cpuCores,
        ramTotalGB: bucketToNearest(hw.ramTotalMB / 1024, 4),
        gpuVendor: hw.gpuVendor,
        gpuVramGB: bucketToNearest(hw.gpuVramMB / 1024, 4),
        installMethod,
        diskTotalGB: bucketToNearest(hw.diskTotalGB, 50),
        collectedAt: new Date().toISOString(),
    };
}

/** Snapshot of which major features are enabled in the current config */
function getFeatureSnapshot(cfg: ReturnType<typeof loadConfig>): HeartbeatEvent['features'] {
    const channels = cfg.channels || {};
    const providers = cfg.providers || {};
    const chEnabled = Object.values(channels).filter((c: unknown) => (c as Record<string, unknown>)?.enabled === true).length;
    const provConfigured = Object.entries(providers).filter(([, p]) => {
        const pr = p as Record<string, unknown>;
        return Boolean(pr?.apiKey) || (Array.isArray(pr?.authProfiles) && (pr.authProfiles as unknown[]).length > 0);
    }).length;
    return {
        voice: cfg.voice?.enabled === true,
        mesh: cfg.mesh?.enabled === true,
        brain: cfg.brain?.enabled === true,
        tunnel: cfg.tunnel?.enabled === true,
        autopilot: cfg.autopilot?.enabled === true,
        selfImprove: cfg.selfImprove?.enabled === true,
        training: cfg.training?.enabled === true,
        daemon: cfg.daemon?.enabled === true,
        nvidia: cfg.nvidia?.enabled === true,
        organism: cfg.organism?.enabled === true,
        selfMod: cfg.selfMod?.enabled === true,
        commandPost: cfg.commandPost?.enabled === true,
        mcpServer: cfg.mcp?.server?.enabled === true,
        channelsEnabled: chEnabled,
        providersConfigured: provConfigured,
    };
}

/** Build a heartbeat event */
export function buildHeartbeat(activeSessions = 0): HeartbeatEvent {
    const cfg = loadConfig();
    return {
        installId: getOrCreateNodeId(),
        version: TITAN_VERSION,
        event: 'heartbeat',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        activeSessions,
        features: getFeatureSnapshot(cfg),
    };
}

/**
 * Remote-send status. Exposed so the gateway and Mission Control can
 * show Tony whether telemetry is actually landing anywhere. Prior to
 * v5.0 the send function swallowed errors silently — the new state
 * struct records the last attempt so the Privacy widget can surface
 * "last sent 14s ago ✓" vs "last send failed: connection refused".
 */
export interface RemoteAnalyticsStatus {
    configured: boolean;
    remoteUrl?: string;
    sentCount: number;
    failedCount: number;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    lastEventType?: string;
    /** PostHog bridge status (parallel send) */
    posthog?: { enabled: boolean; sentCount: number; failedCount: number; lastError?: string; lastSuccessAt?: string };
}
const remoteStatus: RemoteAnalyticsStatus = {
    configured: false,
    sentCount: 0,
    failedCount: 0,
};
export function getRemoteAnalyticsStatus(): RemoteAnalyticsStatus {
    return { ...remoteStatus, posthog: getPostHogStatus() };
}

/** Send analytics event to remote endpoint if configured */
export async function sendRemoteAnalytics(payload: Record<string, unknown>): Promise<void> {
    const cfg = loadConfig();
    const remoteUrl = (cfg.telemetry as Record<string, unknown> | undefined)?.remoteUrl as string | undefined;
    remoteStatus.configured = Boolean(remoteUrl);
    remoteStatus.remoteUrl = remoteUrl;
    if (!remoteUrl) return;

    const now = new Date().toISOString();
    remoteStatus.lastAttemptAt = now;
    remoteStatus.lastEventType = typeof payload.type === 'string' ? payload.type : 'unknown';
    try {
        const res = await fetch(remoteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        remoteStatus.sentCount += 1;
        remoteStatus.lastSuccessAt = now;
        remoteStatus.lastError = undefined;
    } catch (err) {
        remoteStatus.failedCount += 1;
        remoteStatus.lastError = (err as Error).message || String(err);
        // Remote analytics is best-effort — we don't throw, but the
        // status struct lets callers see the failure.
    }

    // Parallel send to PostHog (if configured) — never blocks or throws.
    sendPostHogEvent(payload).catch(() => {});
}

/**
 * Read the postinstall marker (written by `scripts/postinstall.cjs`) and,
 * if the user has consented to telemetry, fire a one-shot `install` or
 * `update` event the first time the gateway boots after an install/upgrade.
 *
 * The marker stays on disk regardless of consent; we just won't SEND anything
 * until the user opts in. The `reported: true` flag prevents re-sending after
 * a gateway restart.
 */
async function reportInstallMarkerOnce(): Promise<void> {
    try {
        const { readFileSync, writeFileSync, existsSync } = await import('fs');
        const { join } = await import('path');
        const { homedir } = await import('os');
        const markerPath = join(homedir(), '.titan', 'install-marker.json');
        if (!existsSync(markerPath)) return;

        type Marker = {
            installedVersion?: string;
            previousVersion?: string | null;
            installedAt?: string;
            installMethod?: string;
            reported?: boolean;
        };
        const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as Marker;
        if (marker.reported) return;

        const cfg = loadConfig();
        if (!cfg.telemetry?.enabled) return; // Stays unreported until consent

        const isUpdate = Boolean(marker.previousVersion && marker.previousVersion !== marker.installedVersion);
        await sendRemoteAnalytics({
            type: isUpdate ? 'update' : 'install',
            installId: getOrCreateNodeId(),
            version: marker.installedVersion || TITAN_VERSION,
            fromVersion: isUpdate ? marker.previousVersion : null,
            installMethod: marker.installMethod || 'unknown',
            installedAt: marker.installedAt || new Date().toISOString(),
        });

        writeFileSync(markerPath, JSON.stringify({ ...marker, reported: true }, null, 2), 'utf-8');
        logger.info(COMPONENT, `Reported ${isUpdate ? 'update' : 'install'} event for ${marker.installedVersion}`);
    } catch (e) {
        logger.debug(COMPONENT, `Install-marker reporter skipped: ${(e as Error).message}`);
    }
}

/** Record startup profile + heartbeat via local telemetry */
export async function recordStartupAnalytics(): Promise<void> {
    const cfg = loadConfig();
    if (!cfg.telemetry?.enabled) return;

    try {
        const profile = await collectSystemProfile();
        const { getStorage } = await import('../storage/index.js');
        const storage = await getStorage();

        await storage.appendTelemetryEvent?.({
            event: 'system_profile',
            properties: profile as unknown as Record<string, unknown>,
            timestamp: new Date().toISOString(),
            sessionId: profile.installId,
        });

        await sendRemoteAnalytics({
            type: 'system_profile',
            ...profile,
        });

        logger.info(COMPONENT, `System profile recorded: ${profile.os} ${profile.arch}, ${profile.cpuCores}c/${profile.ramTotalGB}GB, GPU: ${profile.gpuVendor || 'none'}`);

        // Fire install/update event once per new install — only when consented.
        await reportInstallMarkerOnce();
    } catch (e) {
        logger.warn(COMPONENT, `Failed to record startup analytics: ${(e as Error).message}`);
    }
}

/** Schedule periodic heartbeat analytics */
export function startHeartbeatAnalytics(activeSessionsProvider: () => number): void {
    const cfg = loadConfig();
    if (!cfg.telemetry?.enabled) return;

    const HEARTBEAT_INTERVAL_MS = 300_000; // 5 minutes

    const tick = async () => {
        try {
            const heartbeat = buildHeartbeat(activeSessionsProvider());
            const { getStorage } = await import('../storage/index.js');
            const storage = await getStorage();

            await storage.appendTelemetryEvent?.({
                event: 'heartbeat',
                properties: heartbeat as unknown as Record<string, unknown>,
                timestamp: heartbeat.timestamp,
                sessionId: heartbeat.installId,
            });

            await sendRemoteAnalytics({
                type: 'heartbeat',
                ...heartbeat,
            });
        } catch {
            // Best-effort
        }
    };

    tick();
    setInterval(tick, HEARTBEAT_INTERVAL_MS);
}
