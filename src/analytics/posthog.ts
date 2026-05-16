/**
 * TITAN — PostHog Analytics Bridge
 *
 * v6.1.0 Phase B (`6.1.0-beta.2`):
 *   - Migrated from hand-rolled `fetch()` to the official `posthog-node` SDK.
 *   - SDK is **lazy-imported** — `posthog-node` never enters memory until
 *     telemetry is enabled AND the user has consented to the current
 *     `REQUIRED_CONSENT_VERSION`. This is the GDPR "no pre-consent network
 *     calls" guarantee.
 *   - CLI-tuned init: `flushAt: 1`, `flushInterval: 0`, `disableGeoip: true`
 *     so events flush immediately on short-lived CLI invocations.
 *   - Graceful shutdown on `SIGTERM`, `SIGINT`, `beforeExit`.
 *   - `$process_person_profile: false` on every event by default — anonymous
 *     capture, no person profile is created. Identified capture (with
 *     `$set` / `$set_once`) will land in a later phase once `titan login`
 *     ships.
 *   - Preserves Phase A: env-var override (`TITAN_POSTHOG_KEY`,
 *     `TITAN_POSTHOG_HOST`), EU/US timezone-based resolver, secret scrubber
 *     on outbound payloads.
 *   - Honors `TITAN_TELEMETRY_DISABLED=1` (or `'true'`) — runtime kill switch
 *     that overrides any config state and short-circuits before any
 *     `posthog-node` import.
 */
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { redactSecrets } from '../security/secretGuard.js';
import { REQUIRED_CONSENT_VERSION } from './consent.js';

const COMPONENT = 'PostHog';

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

/**
 * Runtime kill switch. Honored before any consent / config check so an
 * operator can hard-disable telemetry without touching config files (CI,
 * sandboxes, ephemeral container runs, paranoid users).
 */
function isHardDisabledByEnv(): boolean {
    const v = process.env.TITAN_TELEMETRY_DISABLED;
    return v === '1' || v === 'true';
}

/**
 * Read consent + config. Returns `undefined` if telemetry isn't supposed
 * to fire (disabled, no key, no consent for current version, hard env
 * kill). Caller MUST treat undefined as "do nothing" — no network, no
 * `posthog-node` import.
 */
function getPostHogConfig(): { apiKey: string; host: string } | undefined {
    if (isHardDisabledByEnv()) return undefined;
    const cfg = loadConfig();
    const tel = cfg.telemetry as Record<string, unknown> | undefined;
    if (!tel?.enabled) return undefined;
    // v6.1.0 Phase B — re-consent gate. If the user hasn't agreed to the
    // current payload generation, treat as opted-out until the CLI
    // re-prompts and bumps consentVersion.
    const consentVersion = typeof tel.consentVersion === 'number' ? tel.consentVersion : 0;
    if (consentVersion < REQUIRED_CONSENT_VERSION) return undefined;
    const apiKey = process.env.TITAN_POSTHOG_KEY || (tel.posthogApiKey as string) || undefined;
    if (!apiKey) return undefined;
    const host = process.env.TITAN_POSTHOG_HOST
        || (tel.posthogHost as string)
        || resolvePostHogHost();
    return { apiKey, host };
}

// ── Lazy SDK client ────────────────────────────────────────────────
//
// `posthog-node` must NOT be imported at module load. It's only pulled in
// the first time a send is attempted AND only after consent + enabled
// checks pass. Once instantiated the client is reused for the lifetime
// of the process.

// Use a structural type so we don't import `PostHog` at module load. The
// real type comes in via dynamic `await import('posthog-node')`.
interface MinimalPostHogClient {
    capture(props: {
        distinctId: string;
        event: string;
        properties?: Record<string, unknown>;
        timestamp?: Date;
    }): unknown;
    shutdown(): Promise<void> | unknown;
    flush?(): Promise<void> | unknown;
}

let _client: MinimalPostHogClient | null = null;
let _shutdownHooksInstalled = false;

/**
 * Install graceful-shutdown hooks once per process so queued events
 * aren't dropped on `SIGTERM` / `SIGINT` / `beforeExit`. PostHog docs
 * explicitly require `await posthog.shutdown()` before process exit.
 */
function installShutdownHooks(): void {
    if (_shutdownHooksInstalled) return;
    _shutdownHooksInstalled = true;
    const shutdown = async () => {
        if (!_client) return;
        try {
            await _client.shutdown();
        } catch {
            /* never let telemetry shutdown itself crash exit */
        }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('beforeExit', shutdown);
}

/**
 * Lazy SDK accessor. Returns `null` if telemetry is off or unconfigured.
 * The `posthog-node` module is only `import()`-ed inside the success
 * branch, so a user who never opts in has the module out of their
 * `require.cache` entirely.
 */
async function getClient(): Promise<{
    client: MinimalPostHogClient;
    apiKey: string;
    host: string;
} | null> {
    const cfg = getPostHogConfig();
    if (!cfg) return null;
    if (_client) return { client: _client, apiKey: cfg.apiKey, host: cfg.host };

    // Lazy import — first place `posthog-node` enters memory.
    const mod = await import('posthog-node');
    const PostHog = (mod as unknown as { PostHog: new (key: string, opts: Record<string, unknown>) => MinimalPostHogClient }).PostHog;
    _client = new PostHog(cfg.apiKey, {
        host: cfg.host,
        // CLI-tuned: TITAN commands are usually short-lived. The SDK
        // defaults (`flushAt: 20`, `flushInterval: 10000`) would delay
        // events past process exit.
        flushAt: 1,
        flushInterval: 0,
        // Explicitly pin geoip off — the SDK default is true but we want
        // a hard guarantee that no IP-based geolocation is happening on
        // our anonymous events. EU/US routing is already handled via
        // `resolvePostHogHost()` from the local IANA timezone.
        disableGeoip: true,
    });
    installShutdownHooks();
    return { client: _client, apiKey: cfg.apiKey, host: cfg.host };
}

// ── Status surface ─────────────────────────────────────────────────

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

// ── Payload scrubbing ──────────────────────────────────────────────
//
// Defense-in-depth: callers (bugReports.ts, featureTracker.ts) already
// scrub before handing payloads here, but anything string-shaped that
// slips through gets caught here too. The local jsonl keeps the
// un-scrubbed copy for operator review.

function scrubProps(props: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
        if (typeof v === 'string') {
            out[k] = redactSecrets(v);
        } else if (Array.isArray(v)) {
            out[k] = v.map(item => (typeof item === 'string' ? redactSecrets(item) : item));
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Map a TITAN analytics payload to PostHog event(s) and send.
 * Best-effort: failures are logged but never thrown.
 *
 * Anonymous capture default — every event sets `$process_person_profile:
 * false` so PostHog does NOT create a person profile. Events remain
 * queryable by `distinct_id` (the anonymous install UUID) for funnels /
 * retention, but no `$set` person properties accumulate. The hardware
 * fingerprint that used to flow through `$identify` is now sent as
 * regular event properties on a `system_profile` event.
 */
export async function sendPostHogEvent(payload: Record<string, unknown>): Promise<void> {
    const handle = await getClient();
    if (!handle) {
        status.enabled = false;
        return;
    }

    status.enabled = true;
    const { client } = handle;
    const distinctId = typeof payload.installId === 'string' ? payload.installId : 'unknown';
    const type = typeof payload.type === 'string' ? payload.type : 'unknown';
    const timestamp = typeof payload.timestamp === 'string'
        ? payload.timestamp
        : typeof payload.collectedAt === 'string'
            ? payload.collectedAt
            : undefined;

    const tsDate = timestamp ? new Date(timestamp) : new Date();

    try {
        const { TITAN_VERSION } = await import('../utils/constants.js');
        // Common properties stamped on every event so downstream PostHog
        // filters can pivot by library + version without re-checking
        // each event type.
        const baseProps: Record<string, unknown> = {
            // Anonymous-by-default — no person profile created.
            // Switch to identified capture (with `$set` / `$set_once`)
            // only after an explicit `titan login` flow.
            $process_person_profile: false,
            $lib: 'titan-analytics',
            $lib_version: TITAN_VERSION,
        };

        const send = (event: string, props: Record<string, unknown>) => {
            client.capture({
                distinctId,
                event,
                properties: scrubProps({ ...baseProps, ...props }),
                timestamp: tsDate,
            });
        };

        if (type === 'system_profile') {
            const allowlist = [
                'os', 'osRelease', 'arch', 'cpuCores',
                'ramTotalGB', 'gpuVendor', 'gpuVramGB',
                'installMethod', 'diskTotalGB', 'version', 'nodeVersion',
            ];
            const props: Record<string, unknown> = {};
            for (const key of allowlist) {
                if (key in payload) props[key] = payload[key];
            }
            send('system_profile', props);
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
            send('heartbeat', props);
        } else if (type === 'install' || type === 'update') {
            send(type, {
                version: payload.version,
                from_version: payload.fromVersion,
                install_method: payload.installMethod,
            });
        } else if (type === 'error') {
            send('error', {
                error_type: payload.errorType,
                message: payload.message,
                version: payload.version,
            });
        } else {
            // Passthrough for any future event types
            const { type: _type, installId: _installId, ...rest } = payload;
            send(type, rest);
        }

        // flushAt=1 means each capture flushes immediately, but call
        // flush() defensively in case the user is on a gateway runtime
        // that overrode the CLI defaults.
        try { await client.flush?.(); } catch { /* ignore */ }

        status.sentCount += 1;
        status.lastSuccessAt = new Date().toISOString();
        status.lastError = undefined;
    } catch (err) {
        status.failedCount += 1;
        status.lastError = (err as Error).message || String(err);
        logger.debug(COMPONENT, `PostHog send failed: ${status.lastError}`);
    }
}

/**
 * Test-only: reset the lazy client + shutdown-hook installation flag.
 * Real CLI flow keeps the client alive for the process lifetime. Used by
 * `tests/v610-posthog-lazy-require.test.ts` to verify the module isn't
 * imported until consent + enabled gates pass.
 */
export function _resetPostHogClientForTests(): void {
    _client = null;
    _shutdownHooksInstalled = false;
}
