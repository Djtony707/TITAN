/**
 * TITAN — Restart Tracker
 *
 * Persists gateway start timestamps to disk so we can compute restart rate
 * across systemd-managed restarts. Without this, a 5-minute restart loop is
 * invisible from inside any single process — each gateway boot starts with
 * a fresh `process.uptime()` and no memory of the previous boot.
 *
 * Hunt Finding (2026-05-07): A 5-min restart loop ran for ~3 days before we
 * caught it. NRestarts was sitting at 700+ in systemd while every individual
 * /api/health response looked fine.
 */
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { TITAN_HOME } from './constants.js';
import { mkdirIfNotExists } from './helpers.js';
import { logger } from './logger.js';

const COMPONENT = 'RestartTracker';
export const RESTART_HISTORY_PATH = join(TITAN_HOME, 'restart-history.jsonl');

interface RestartRecord {
    timestamp: string;
    pid: number;
    version: string;
    nRestartsAtBoot?: number;
}

/** Read systemd's NRestarts for this service. Returns null when not under systemd. */
function readSystemdNRestarts(): number | null {
    if (process.platform !== 'linux') return null;
    try {
        const out = execSync('systemctl show titan.service --property=NRestarts --value', {
            timeout: 1000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
        const n = parseInt(out, 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

let bootRecorded = false;

/** Record that this gateway just booted. Idempotent within a process. */
export function recordBoot(version: string): void {
    if (bootRecorded) return;
    bootRecorded = true;
    try {
        mkdirIfNotExists(TITAN_HOME);
        const record: RestartRecord = {
            timestamp: new Date().toISOString(),
            pid: process.pid,
            version,
            nRestartsAtBoot: readSystemdNRestarts() ?? undefined,
        };
        appendFileSync(RESTART_HISTORY_PATH, JSON.stringify(record) + '\n');
    } catch (err) {
        logger.warn(COMPONENT, `recordBoot failed: ${(err as Error).message}`);
    }
}

function readHistory(): RestartRecord[] {
    if (!existsSync(RESTART_HISTORY_PATH)) return [];
    try {
        const raw = readFileSync(RESTART_HISTORY_PATH, 'utf8');
        const out: RestartRecord[] = [];
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                out.push(JSON.parse(trimmed) as RestartRecord);
            } catch { /* skip malformed line */ }
        }
        return out;
    } catch {
        return [];
    }
}

export interface RestartStats {
    /** Total recorded boots in history file. */
    totalBoots: number;
    /** Boots in the last 60 minutes (excluding the current one). */
    restartsLastHour: number;
    /** Boots in the last 10 minutes (excluding the current one). */
    restartsLast10Min: number;
    /** systemd's NRestarts counter, when available. */
    nRestartsSystemd: number | null;
    /** ISO timestamp of the prior boot (the one before this process). */
    previousBootAt: string | null;
    /** Severity assessment: ok if rate is sane, warning/critical otherwise. */
    severity: 'ok' | 'warning' | 'critical';
    /** Reason string when severity > ok. */
    reason: string | null;
}

/**
 * Compute restart stats. The current process counts as one entry in the
 * history file; we exclude it from "restarts last X" so a healthy boot
 * reports 0 restarts when it just started.
 */
export function getRestartStats(): RestartStats {
    const history = readHistory();
    const now = Date.now();
    const myPid = process.pid;

    // Anything from the current process counts as "this boot", not a restart.
    const otherBoots = history.filter(r => r.pid !== myPid);
    const last60 = otherBoots.filter(r => now - new Date(r.timestamp).getTime() <= 60 * 60 * 1000);
    const last10 = otherBoots.filter(r => now - new Date(r.timestamp).getTime() <= 10 * 60 * 1000);

    const nRestartsSystemd = readSystemdNRestarts();
    const previousBootAt = otherBoots.length > 0 ? otherBoots[otherBoots.length - 1].timestamp : null;

    let severity: 'ok' | 'warning' | 'critical' = 'ok';
    let reason: string | null = null;
    if (last10.length >= 2) {
        severity = 'critical';
        reason = `${last10.length} restarts in last 10 minutes — gateway may be in a restart loop`;
    } else if (last60.length >= 5) {
        severity = 'warning';
        reason = `${last60.length} restarts in last hour — investigate cause`;
    }

    return {
        totalBoots: history.length,
        restartsLastHour: last60.length,
        restartsLast10Min: last10.length,
        nRestartsSystemd,
        previousBootAt,
        severity,
        reason,
    };
}
