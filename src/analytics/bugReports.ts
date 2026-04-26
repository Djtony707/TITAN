/**
 * TITAN — Bug Report Capture
 *
 * Captures runtime errors with rich agent context so the human team
 * (Tony) plus the agent collaborators (Claude, Kimi) can review and
 * fix them. Telemetry-gated like everything else: no data leaves the
 * machine unless `telemetry.enabled === true`.
 *
 * Each report is:
 *   • appended to `~/.titan/bug-reports.jsonl` (always, when capture is wired)
 *   • forwarded to PostHog as a `bug_report` event when telemetry is on
 *   • exposed at `GET /api/bug-reports` for review
 *
 * Stack traces are scrubbed by the existing `outboundSanitizer`
 * before they leave the machine. The local file is the un-scrubbed
 * source of truth for the operator.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'BugReports';

const BUG_REPORTS_DIR = TITAN_HOME;
const BUG_REPORTS_PATH = join(BUG_REPORTS_DIR, 'bug-reports.jsonl');
const BUG_REPORTS_PREVIOUS = join(BUG_REPORTS_DIR, 'bug-reports.previous.jsonl');
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB before rotation
const MAX_REPORTS_RETURNED = 200;

export interface BugReportContext {
    /** Active session id, if any */
    sessionId?: string;
    /** Channel where the work originated (webchat, voice, telegram, etc.) */
    channel?: string;
    /** Resolved model id at time of failure */
    model?: string;
    /** Last user message, truncated to 240 chars */
    lastUserMessage?: string;
    /** Last assistant content preview, truncated to 240 chars */
    lastAssistantPreview?: string;
    /** Up to last 5 tool names called this turn */
    toolsUsed?: string[];
    /** System prompt token estimate at failure */
    promptLength?: number;
    /** 1-indexed turn within the session */
    turnNumber?: number;
    /** Free-form tag for callers (e.g. 'agent.processMessage', 'gateway.api') */
    origin?: string;
}

export interface BugReport {
    /** Stable id for cross-system reference (`bug_<ts>_<rand>`) */
    id: string;
    /** ISO timestamp when capture fired */
    ts: string;
    /** TITAN runtime version */
    version: string;
    /** Anonymous install id from mesh identity */
    installId: string;
    /** Error name, message, stack — stack truncated to 4 KB */
    error: {
        name: string;
        message: string;
        stack: string;
    };
    /** Caller-provided agent/turn context */
    context: BugReportContext;
    /** Bucketed system info — never the exact CPU/GPU model */
    system: {
        os: string;
        arch: string;
        nodeMajor: number;
        ramGB?: number;
        gpuVramGB?: number;
    };
}

let lastBugReportTs = 0;
const MIN_INTERVAL_MS = 250; // burst guard

function ensureDir(): void {
    if (!existsSync(BUG_REPORTS_DIR)) {
        mkdirSync(BUG_REPORTS_DIR, { recursive: true });
    }
}

function rotateIfNeeded(): void {
    try {
        if (!existsSync(BUG_REPORTS_PATH)) return;
        const size = statSync(BUG_REPORTS_PATH).size;
        if (size < MAX_FILE_BYTES) return;
        renameSync(BUG_REPORTS_PATH, BUG_REPORTS_PREVIOUS);
    } catch {
        /* non-fatal */
    }
}

function safeStack(err: Error): string {
    const stack = err.stack || `${err.name}: ${err.message}`;
    return stack.length > 4096 ? stack.slice(0, 4096) + '\n…(truncated)' : stack;
}

function bucketGB(mb?: number, step = 4): number | undefined {
    if (typeof mb !== 'number' || !Number.isFinite(mb) || mb <= 0) return undefined;
    const gb = mb / 1024;
    return Math.round(gb / step) * step;
}

async function buildSystemSummary(): Promise<BugReport['system']> {
    const { platform, arch, totalmem } = await import('os');
    let gpuVramMB: number | undefined;
    try {
        const { detectHardware } = await import('../hardware/autoConfig.js');
        const hw = await detectHardware();
        gpuVramMB = hw.gpuVramMB;
    } catch { /* ignore */ }
    const nodeMajor = parseInt((process.version.match(/^v(\d+)/) || ['', '0'])[1] || '0', 10);
    return {
        os: platform(),
        arch: arch(),
        nodeMajor,
        ramGB: bucketGB(totalmem() / (1024 * 1024)),
        gpuVramGB: bucketGB(gpuVramMB),
    };
}

function newReportId(): string {
    return `bug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Capture an error with surrounding agent context. Best-effort: never
 * throws back to the caller — if persistence or telemetry fails, the
 * original error path stays intact.
 */
export async function captureBugReport(err: unknown, context: BugReportContext = {}): Promise<BugReport | null> {
    try {
        // Burst guard: drop reports that fire within 250ms of each other
        // to avoid overwhelming disk + PostHog when an error loops.
        const now = Date.now();
        if (now - lastBugReportTs < MIN_INTERVAL_MS) return null;
        lastBugReportTs = now;

        const error: Error = err instanceof Error ? err : new Error(String(err ?? 'unknown error'));
        const { TITAN_VERSION } = await import('../utils/constants.js');
        const { getOrCreateNodeId } = await import('../mesh/identity.js');

        // Trim PII-prone fields defensively. Operators see the full thing
        // in the local file but PostHog never gets a long user message.
        const ctx: BugReportContext = {
            ...context,
            lastUserMessage: context.lastUserMessage?.slice(0, 240),
            lastAssistantPreview: context.lastAssistantPreview?.slice(0, 240),
            toolsUsed: context.toolsUsed?.slice(0, 5),
        };

        const report: BugReport = {
            id: newReportId(),
            ts: new Date().toISOString(),
            version: TITAN_VERSION,
            installId: getOrCreateNodeId(),
            error: {
                name: error.name,
                message: error.message,
                stack: safeStack(error),
            },
            context: ctx,
            system: await buildSystemSummary(),
        };

        // Persist locally first — operator-readable record of truth.
        try {
            ensureDir();
            rotateIfNeeded();
            appendFileSync(BUG_REPORTS_PATH, JSON.stringify(report) + '\n');
        } catch (writeErr) {
            logger.warn(COMPONENT, `Local persist failed: ${(writeErr as Error).message}`);
        }

        // Forward to PostHog if telemetry is on. featureTracker handles
        // the opt-in gate, sanitizer, and best-effort fetch.
        try {
            const { trackEvent } = await import('./featureTracker.js');
            await trackEvent('bug_report', {
                bug_id: report.id,
                error_name: report.error.name,
                error_message: report.error.message,
                origin: report.context.origin,
                model: report.context.model,
                channel: report.context.channel,
                tools_used: report.context.toolsUsed,
                prompt_length: report.context.promptLength,
                turn_number: report.context.turnNumber,
                os: report.system.os,
                arch: report.system.arch,
                node_major: report.system.nodeMajor,
                ram_gb: report.system.ramGB,
                gpu_vram_gb: report.system.gpuVramGB,
                titan_version: report.version,
                stack_preview: report.error.stack.slice(0, 800),
            });
        } catch (sendErr) {
            logger.debug(COMPONENT, `Remote send skipped: ${(sendErr as Error).message}`);
        }

        return report;
    } catch (selfErr) {
        // Never let bug-report capture itself become a bug.
        try {
            logger.warn(COMPONENT, `captureBugReport itself failed: ${(selfErr as Error).message}`);
        } catch { /* deeply broken */ }
        return null;
    }
}

/**
 * List recent bug reports for review. Reads the local jsonl file —
 * never PostHog — so the operator can review even when telemetry is
 * off. Returns most-recent first.
 */
export function listRecentBugReports(limit = 50): BugReport[] {
    try {
        if (!existsSync(BUG_REPORTS_PATH)) return [];
        const raw = readFileSync(BUG_REPORTS_PATH, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        const cap = Math.min(Math.max(1, limit), MAX_REPORTS_RETURNED);
        const tail = lines.slice(-cap).reverse();
        const reports: BugReport[] = [];
        for (const line of tail) {
            try {
                reports.push(JSON.parse(line));
            } catch { /* skip malformed */ }
        }
        return reports;
    } catch (err) {
        logger.warn(COMPONENT, `listRecentBugReports failed: ${(err as Error).message}`);
        return [];
    }
}

/** Lookup one report by id from the local file. */
export function getBugReport(id: string): BugReport | null {
    try {
        if (!existsSync(BUG_REPORTS_PATH)) return null;
        const raw = readFileSync(BUG_REPORTS_PATH, 'utf-8');
        for (const line of raw.split('\n')) {
            if (!line) continue;
            try {
                const r = JSON.parse(line) as BugReport;
                if (r.id === id) return r;
            } catch { /* skip */ }
        }
        return null;
    } catch {
        return null;
    }
}

/** File path so /api/bug-reports/raw can stream the operator file. */
export function getBugReportsPath(): string {
    return BUG_REPORTS_PATH;
}
