/**
 * TITAN — v6.1.0 Phase B — Telemetry re-consent flow
 *
 * Runs at CLI startup. If the user previously opted in to telemetry on a
 * v5.x install (`enabled: true`, `consentVersion: 0`), we MUST re-prompt
 * before sending anything else under the new payload contract. Anything
 * other than an explicit "yes" turns telemetry OFF and records consent
 * at the current version so we don't ask again.
 *
 * Standalone module (not folded into `onboard-wizard.ts`) because:
 *   1. We need to call it from CLI startup before any command runs, not
 *      only during the full setup wizard.
 *   2. The `titan telemetry enable` subcommand uses the same prompt.
 *   3. Tests can mock stdin in isolation without dragging in the wizard's
 *      30+ inquirer prompts.
 */
import { loadConfig, updateConfig } from '../config/config.js';
import type { TitanConfig } from '../config/schema.js';
import { REQUIRED_CONSENT_VERSION } from '../analytics/consent.js';

/**
 * Plain-ASCII prompt text. Printed to stderr-style `process.stdout` so
 * piped CLI output doesn't carry the banner. Matches the wording approved
 * in the Phase B notes — DO NOT reword without bumping
 * `REQUIRED_CONSENT_VERSION`.
 */
export const RECONSENT_PROMPT = [
    '',
    'TITAN telemetry has changed in v6.',
    '',
    '  Collects: anonymous install ID, OS+CPU+RAM bucket, feature flags,',
    '            crash stacks (API keys + home paths scrubbed).',
    '  Does NOT: read prompts, file contents, model responses, chat history.',
    '',
    'You previously opted in. Confirm for v6?',
    '  Type "yes" to keep telemetry on. Anything else turns it off.',
    '> ',
].join('\n');

/**
 * Read one line from stdin. Resolves with the trimmed line (lowercased)
 * or `null` on EOF / SIGINT — both treated as "not yes" by callers.
 */
function readOneLine(input: NodeJS.ReadableStream = process.stdin): Promise<string | null> {
    return new Promise((resolve) => {
        let buf = '';
        let settled = false;
        const settle = (v: string | null) => {
            if (settled) return;
            settled = true;
            input.removeListener('data', onData);
            input.removeListener('end', onEnd);
            input.removeListener('error', onErr);
            resolve(v);
        };
        const onData = (chunk: Buffer | string) => {
            buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
            const nl = buf.indexOf('\n');
            if (nl !== -1) {
                settle(buf.slice(0, nl).trim().toLowerCase());
            }
        };
        const onEnd = () => settle(buf ? buf.trim().toLowerCase() : null);
        const onErr = () => settle(null);
        input.on('data', onData);
        input.on('end', onEnd);
        input.on('error', onErr);
    });
}

export interface ReconsentResult {
    /** True if the user actively typed "yes" / "y". */
    accepted: boolean;
    /** The new telemetry shape that was persisted. */
    enabled: boolean;
    /** Always set to REQUIRED_CONSENT_VERSION on return. */
    consentVersion: number;
}

/**
 * Show the v6 re-consent prompt and persist the result. Default-deny:
 * anything other than "yes" / "y" turns telemetry off. We always bump
 * `consentVersion` to `REQUIRED_CONSENT_VERSION` so the user is asked
 * exactly once per generation, regardless of their answer.
 *
 * Returns the new telemetry shape so callers can log / display it.
 */
export async function runReconsent(opts: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
} = {}): Promise<ReconsentResult> {
    const out = opts.output ?? process.stdout;
    out.write(RECONSENT_PROMPT);
    const answer = await readOneLine(opts.input ?? process.stdin);
    const accepted = answer === 'yes' || answer === 'y';
    const config = loadConfig();
    const nextTel: Record<string, unknown> = {
        ...(config.telemetry as Record<string, unknown>),
        enabled: accepted,
        consentVersion: REQUIRED_CONSENT_VERSION,
    };
    if (accepted) {
        // Stamp the version we got consent on so future audit / "when did
        // I opt in?" surfaces have an answer. `consentedAt` mirrors the
        // legacy v5.x SetupWizard field for backwards compatibility.
        nextTel.consentedAt = new Date().toISOString();
    }
    updateConfig({ telemetry: nextTel as TitanConfig['telemetry'] } as Partial<TitanConfig>);
    if (accepted) {
        out.write('\nTelemetry stays ON. Thank you — TITAN gets better because of this.\n');
    } else {
        out.write('\nTelemetry is OFF. No data leaves your machine.\n');
    }
    return {
        accepted,
        enabled: accepted,
        consentVersion: REQUIRED_CONSENT_VERSION,
    };
}

/**
 * Decide whether a re-consent prompt is needed at startup. Returns true
 * only when the user previously opted in (`enabled: true`) but is on an
 * older `consentVersion`. Users who never opted in stay opted out — no
 * re-prompt, no nag.
 */
export function needsReconsent(): boolean {
    const cfg = loadConfig();
    const tel = cfg.telemetry as Record<string, unknown> | undefined;
    if (!tel) return false;
    if (tel.enabled !== true) return false;
    const consentVersion = typeof tel.consentVersion === 'number' ? tel.consentVersion : 0;
    return consentVersion < REQUIRED_CONSENT_VERSION;
}

/**
 * Convenience for startup hooks: prompt only if needed. Returns the
 * `ReconsentResult` when we prompted, or `null` if no prompt was needed.
 * Wrapped in try so a malformed config / unwritable disk during startup
 * can never crash the CLI — telemetry stays off in that case.
 */
export async function reconsentIfNeeded(opts: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
} = {}): Promise<ReconsentResult | null> {
    try {
        if (!needsReconsent()) return null;
        return await runReconsent(opts);
    } catch {
        return null;
    }
}
