/**
 * TITAN — PostHog Analytics Bridge
 * Sends opt-in telemetry events to PostHog Cloud (or self-hosted).
 * Only active when telemetry.enabled=true AND posthogApiKey is configured.
 */
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'PostHog';

// In-memory cache for config-derived client state
let cachedKey: string | undefined;
let cachedHost: string | undefined;

/**
 * v6.1.0-beta.1 — env-var override + EU/US auto-detection.
 *
 * Precedence (highest first):
 *   1. `process.env.TITAN_POSTHOG_KEY`  → overrides project key
 *   2. `process.env.TITAN_POSTHOG_HOST` → overrides ingest host
 *   3. `telemetry.posthogApiKey` / `telemetry.posthogHost` from config
 *   4. EU/US auto-detection via IANA timezone (NO network / NO IP lookup —
 *      privacy-safe + offline-safe)
 *   5. US default
 *
 * EU detection (GDPR data-residency):
 *   `Intl.DateTimeFormat().resolvedOptions().timeZone` is consulted; if it
 *   starts with `Europe/`, or matches one of the EU-adjacent Atlantic /
 *   Africa zones (Azores, Canary, Faroe, Madeira, Reykjavik, Ceuta) the
 *   host resolves to `https://eu.i.posthog.com` (PostHog Cloud Frankfurt).
 *   Everything else routes to the US.
 *
 * Rationale: timezone is offline-resolvable, requires zero pre-consent
 * network calls, and is good-enough for "is this user EU?" at the
 * data-residency level. IP-based geolocation would be more precise but
 * costs a privacy hit + a network round-trip BEFORE consent is granted
 * — exactly what GDPR is trying to prevent.
 */
const EU_TIMEZONE_REGEX = /^Europe\//;
const EU_ADJACENT_ZONES = new Set([
    'Atlantic/Azores',
    'Atlantic/Canary',
    'Atlantic/Faroe',
    'Atlantic/Madeira',
    'Atlantic/Reykjavik',
    'Africa/Ceuta',
]);

export function resolvePostHogHost(now?: { timeZone?: string }): string {
    if (process.env.TITAN_POSTHOG_HOST) return process.env.TITAN_POSTHOG_HOST;
    const tz = (() => {
        if (now?.timeZone) return now.timeZone;
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
        catch { return ''; }
    })();
    if (EU_TIMEZONE_REGEX.test(tz) || EU_ADJACENT_ZONES.has(tz)) {
        return 'https://eu.i.posthog.com';
    }
    return 'https://us.i.posthog.com';
}

function getPostHogConfig(): { apiKey: string; host: string } | undefined {
    const cfg = loadConfig();
    const tel = cfg.telemetry as Record<string, unknown> | undefined;
    if (!tel?.enabled) return undefined;
    const apiKey = process.env.TITAN_POSTHOG_KEY || (tel.posthogApiKey as string) || undefined;
    if (!apiKey) return undefined;
    // env > config-explicit > auto-detected (EU vs US via timezone) > US default
    // NOTE: env var must be checked here too — the test "TITAN_POSTHOG_HOST
    // overrides the schema host" exercises the case where config has a
    // non-empty default (which would otherwise short-circuit before
    // resolvePostHogHost() is reached).
    const host = process.env.TITAN_POSTHOG_HOST
        || (tel.posthogHost as string)
        || resolvePostHogHost();
    return { apiKey, host };
}

/** Fire a single event to PostHog's /capture endpoint via fetch. */
async function capture(
    apiKey: string,
    host: string,
    distinctId: string,
    event: string,
    properties: Record<string, unknown>,
    timestamp?: string
): Promise<void> {
    const url = `${host.replace(/\/$/, '')}/capture/`;
    const body = {
        api_key: apiKey,
        event,
        distinct_id: distinctId,
        properties: {
            ...properties,
            // Mark these as TITAN-generated so PostHog filters work
            $lib: 'titan-analytics',
            $lib_version: (await import('../utils/constants.js')).TITAN_VERSION,
        },
        timestamp: timestamp || new Date().toISOString(),
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`PostHog HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
}

/** Send a $identify call with person properties (hardware profile). */
async function identify(
    apiKey: string,
    host: string,
    distinctId: string,
    properties: Record<string, unknown>,
    timestamp?: string
): Promise<void> {
    await capture(apiKey, host, distinctId, '$identify', {
        $set: properties,
    }, timestamp);
}

export interface PostHogSendStatus {
    enabled: boolean;
    sentCount: number;
    failedCount: number;
    lastError?: string;
    lastSuccessAt?: string;
}

const status: PostHogSendStatus = { enabled: false, sentCount: 0, failedCount: 0 };

export function getPostHogStatus(): PostHogSendStatus {
    return { ...status };
}

/**
 * Map a TITAN analytics payload to PostHog event(s) and send.
 * This is best-effort: failures are logged but not thrown.
 */
export async function sendPostHogEvent(payload: Record<string, unknown>): Promise<void> {
    const cfg = getPostHogConfig();
    if (!cfg) {
        status.enabled = false;
        return;
    }

    status.enabled = true;
    const { apiKey, host } = cfg;
    const distinctId = typeof payload.installId === 'string' ? payload.installId : 'unknown';
    const type = typeof payload.type === 'string' ? payload.type : 'unknown';
    const timestamp = typeof payload.timestamp === 'string'
        ? payload.timestamp
        : typeof payload.collectedAt === 'string'
            ? payload.collectedAt
            : undefined;

    const ts = timestamp || new Date().toISOString();
    try {
        if (type === 'system_profile') {
            // Hardware specs become person properties so we can segment by GPU, OS, etc.
            const personProps: Record<string, unknown> = {};
            const allowlist = [
                'os', 'osRelease', 'arch', 'cpuCores',
                'ramTotalGB', 'gpuVendor', 'gpuVramGB',
                'installMethod', 'diskTotalGB', 'version', 'nodeVersion',
            ];
            for (const key of allowlist) {
                if (key in payload) personProps[key] = payload[key];
            }
            await identify(apiKey, host, distinctId, personProps, ts);

            // Also fire a lightweight system_profile event for funnels
            await capture(apiKey, host, distinctId, 'system_profile', {
                version: payload.version,
                installMethod: payload.installMethod,
            }, ts);
        } else if (type === 'heartbeat') {
            const props: Record<string, unknown> = {
                uptime_seconds: payload.uptimeSeconds,
                active_sessions: payload.activeSessions,
                version: payload.version,
            };
            if (payload.features) {
                const f = payload.features as Record<string, unknown>;
                for (const [k, v] of Object.entries(f)) {
                    props[`feature_${k}`] = v;
                }
            }
            await capture(apiKey, host, distinctId, 'heartbeat', props, ts);
        } else if (type === 'install' || type === 'update') {
            await capture(apiKey, host, distinctId, type, {
                version: payload.version,
                from_version: payload.fromVersion,
                install_method: payload.installMethod,
            }, ts);
        } else if (type === 'error') {
            await capture(apiKey, host, distinctId, 'error', {
                error_type: payload.errorType,
                message: payload.message,
                version: payload.version,
            }, ts);
        } else {
            // Passthrough for any future event types
            const { type: _type, installId: _installId, ...rest } = payload;
            await capture(apiKey, host, distinctId, type, rest, ts);
        }

        status.sentCount += 1;
        status.lastSuccessAt = new Date().toISOString();
        status.lastError = undefined;
    } catch (err) {
        status.failedCount += 1;
        status.lastError = (err as Error).message || String(err);
        logger.debug(COMPONENT, `PostHog send failed: ${status.lastError}`);
    }
}
