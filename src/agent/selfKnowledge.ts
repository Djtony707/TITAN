/**
 * TITAN Self-Knowledge
 *
 * Pure measured facts the social autopilot is allowed to cite. This module
 * must never call an LLM; it only reads local state, config, telemetry, and
 * low-cost host metrics.
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { statfs } from 'fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'os';
import { join } from 'path';
import { loadConfig } from '../config/config.js';
import { getSkills } from '../skills/registry.js';
import { getRegisteredTools } from './toolRunner.js';
import { getActivitySummary, readActivityEvents } from '../telemetry/activityLog.js';
import { TELEMETRY_EVENTS_PATH, TITAN_HOME, TITAN_LOGS_DIR, TITAN_VERSION } from '../utils/constants.js';

const FB_STATE_PATH = join(TITAN_HOME, 'fb-autopilot-state.json');
const SOMA_DRIVE_STATE_PATH = join(TITAN_HOME, 'soma-drive-state.json');
const DRIVE_STATE_PATH = join(TITAN_HOME, 'drive-state.json');
const RESTART_HISTORY_PATH = join(TITAN_HOME, 'restart-history.jsonl');
const CHANGELOG_PATH = join(process.cwd(), 'CHANGELOG.md');
const CACHE_MS = 60_000;

interface DriveLevels {
    purpose: number;
    hunger: number;
    curiosity: number;
    safety: number;
    social: number;
}

export interface SelfKnowledge {
    version: string;
    uptimeSeconds: number;
    npmDownloads: number;
    skillCount: number;
    toolCount: number;
    recentCommitMessages: string[];
    recentReleaseNotes: string[];
    activityLast24h: {
        toolCalls: number;
        missionsCompleted: number;
        postsToFb: number;
        ssePushes: number;
    };
    drives: DriveLevels | null;
    errorsLast24h: number;
    currentModel: string;
    hostMetrics: {
        cpuPercent: number;
        memPercent: number;
        diskPercent: number;
    };
}

let cachedAt = 0;
let cachedSnapshot: SelfKnowledge | null = null;

/** Return a 60s-cached factual snapshot of TITAN's current state. */
export async function getSelfKnowledge(): Promise<SelfKnowledge> {
    const now = Date.now();
    if (cachedSnapshot && now - cachedAt < CACHE_MS) {
        return cachedSnapshot;
    }

    const config = loadConfig();
    const activity = getActivitySummary(24);
    const events24h = readActivityEvents().filter(e => e.t >= now - 24 * 60 * 60 * 1000);
    const snapshot: SelfKnowledge = {
        version: TITAN_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        npmDownloads: await getNpmDownloads(),
        skillCount: getSkills().length,
        toolCount: getRegisteredTools().length,
        recentCommitMessages: getRecentCommitMessages(),
        recentReleaseNotes: getRecentReleaseNotes(),
        activityLast24h: {
            toolCalls: activity.toolCalls,
            missionsCompleted: countMissionCompletions(events24h, activity.goalsCompleted),
            postsToFb: countRecentFacebookPosts(now),
            ssePushes: events24h.filter(e => (e.event as string) === 'sse_push').length,
        },
        drives: readDrives(),
        errorsLast24h: countErrorsLast24h(now, events24h),
        currentModel: config.agent?.model || '',
        hostMetrics: await getHostMetrics(),
    };

    cachedAt = now;
    cachedSnapshot = snapshot;
    return snapshot;
}

async function getNpmDownloads(): Promise<number> {
    let downloads = 25000;
    try {
        const res = await fetch('https://api.npmjs.org/downloads/point/last-month/titan-agent', {
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
            const data = await res.json() as { downloads?: number };
            if (typeof data.downloads === 'number' && Number.isFinite(data.downloads)) {
                downloads = data.downloads;
            }
        }
    } catch {
        /* non-critical: use known conservative fallback */
    }
    return downloads;
}

function getRecentCommitMessages(): string[] {
    try {
        const out = execSync('git log --oneline -5 --no-decorate', {
            cwd: process.cwd(),
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000,
        });
        return out.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5);
    } catch {
        return [];
    }
}

function getRecentReleaseNotes(): string[] {
    try {
        if (!existsSync(CHANGELOG_PATH)) return [];
        const text = readFileSync(CHANGELOG_PATH, 'utf-8');
        const matches = [...text.matchAll(/^## (v\d.+)$/gm)];
        return matches.map(m => m[1].trim()).filter(Boolean).slice(0, 3);
    } catch {
        return [];
    }
}

function countMissionCompletions(events24h: Array<{ event: string }>, goalCompletions: number): number {
    const explicit = events24h.filter(e =>
        e.event === 'mission_complete' ||
        e.event === 'mission_completed' ||
        e.event === 'goal_complete' ||
        e.event === 'goal_completed'
    ).length;
    return Math.max(explicit, goalCompletions);
}

function countRecentFacebookPosts(now: number): number {
    try {
        if (!existsSync(FB_STATE_PATH)) return 0;
        const state = JSON.parse(readFileSync(FB_STATE_PATH, 'utf-8')) as {
            postHistory?: Array<{ date?: string }>;
        };
        const cutoff = now - 24 * 60 * 60 * 1000;
        return (state.postHistory || []).filter(post => {
            if (!post.date) return false;
            const t = new Date(post.date).getTime();
            return Number.isFinite(t) && t > cutoff;
        }).length;
    } catch {
        return 0;
    }
}

function readDrives(): DriveLevels | null {
    for (const path of [SOMA_DRIVE_STATE_PATH, DRIVE_STATE_PATH]) {
        try {
            if (!existsSync(path)) continue;
            const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
            const normalized = normalizeDrives(parsed);
            if (normalized) return normalized;
        } catch {
            /* try the next state file */
        }
    }
    return null;
}

function normalizeDrives(value: unknown): DriveLevels | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const direct = readDriveLevels(record);
    if (direct) return direct;

    const latest = record.latest;
    if (latest && typeof latest === 'object') {
        const latestRecord = latest as Record<string, unknown>;
        const latestDirect = readDriveLevels(latestRecord);
        if (latestDirect) return latestDirect;
        const drives = latestRecord.drives;
        if (Array.isArray(drives)) {
            const out: Partial<DriveLevels> = {};
            for (const drive of drives) {
                if (!drive || typeof drive !== 'object') continue;
                const d = drive as Record<string, unknown>;
                const id = d.id;
                const satisfaction = d.satisfaction;
                if (isDriveKey(id) && typeof satisfaction === 'number' && Number.isFinite(satisfaction)) {
                    out[id] = satisfaction;
                }
            }
            return isCompleteDriveLevels(out) ? out : null;
        }
    }

    const history = record.history;
    if (Array.isArray(history) && history.length > 0) {
        const last = history[history.length - 1] as Record<string, unknown> | undefined;
        const satisfactions = last?.satisfactions;
        if (satisfactions && typeof satisfactions === 'object') {
            return readDriveLevels(satisfactions as Record<string, unknown>);
        }
    }

    return null;
}

function readDriveLevels(record: Record<string, unknown>): DriveLevels | null {
    const out: Partial<DriveLevels> = {};
    for (const key of ['purpose', 'hunger', 'curiosity', 'safety', 'social'] as const) {
        const value = record[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        out[key] = value;
    }
    return out as DriveLevels;
}

function isDriveKey(value: unknown): value is keyof DriveLevels {
    return value === 'purpose' || value === 'hunger' || value === 'curiosity' || value === 'safety' || value === 'social';
}

function isCompleteDriveLevels(value: Partial<DriveLevels>): value is DriveLevels {
    return ['purpose', 'hunger', 'curiosity', 'safety', 'social'].every(key =>
        typeof value[key as keyof DriveLevels] === 'number',
    );
}

function countErrorsLast24h(now: number, events24h: Array<{ event: string }>): number {
    let count = events24h.filter(e => e.event === 'error_recovery' || e.event === 'error').length;
    count += countTelemetryErrorsLast24h(now);
    count += countRestartsLast24h(now);
    try {
        if (!existsSync(TITAN_LOGS_DIR)) return count;
        const cutoff = now - 24 * 60 * 60 * 1000;
        for (const file of readdirSync(TITAN_LOGS_DIR)) {
            if (!file.endsWith('.log')) continue;
            const text = readFileSync(join(TITAN_LOGS_DIR, file), 'utf-8');
            for (const line of text.split('\n')) {
                if (!/\sERROR\s+\[/.test(line)) continue;
                const ts = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1];
                if (!ts) {
                    count++;
                    continue;
                }
                const t = new Date(ts.replace(' ', 'T')).getTime();
                if (Number.isFinite(t) && t >= cutoff) count++;
            }
        }
    } catch {
        /* logs are best-effort */
    }
    return count;
}

function countTelemetryErrorsLast24h(now: number): number {
    return readJsonLines(TELEMETRY_EVENTS_PATH).filter(entry => {
        const level = typeof entry.level === 'string' ? entry.level.toLowerCase() : '';
        if (level !== 'error') return false;
        return timestampInLast24h(entry, now);
    }).length;
}

function countRestartsLast24h(now: number): number {
    return readJsonLines(RESTART_HISTORY_PATH).filter(entry => timestampInLast24h(entry, now)).length;
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
    try {
        if (!existsSync(path)) return [];
        return readFileSync(path, 'utf-8')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .flatMap(line => {
                try {
                    const parsed = JSON.parse(line) as unknown;
                    return parsed && typeof parsed === 'object'
                        ? [parsed as Record<string, unknown>]
                        : [];
                } catch {
                    return [];
                }
            });
    } catch {
        return [];
    }
}

function timestampInLast24h(entry: Record<string, unknown>, now: number): boolean {
    const raw = entry.t ?? entry.time ?? entry.timestamp ?? entry.ts ?? entry.createdAt;
    const millis = typeof raw === 'number' ? raw : typeof raw === 'string' ? new Date(raw).getTime() : NaN;
    return Number.isFinite(millis) && millis >= now - 24 * 60 * 60 * 1000;
}

async function getHostMetrics(): Promise<SelfKnowledge['hostMetrics']> {
    const avg = loadavg()[0] || 0;
    const cores = cpus().length || 1;
    const cpuPercent = Math.round(Math.min(1, avg / cores) * 1000) / 10;
    const totalMem = totalmem();
    const usedMem = totalMem - freemem();
    const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

    let diskPercent = 0;
    try {
        const s = await statfs(TITAN_HOME);
        const diskTotalBytes = s.blocks * s.bsize;
        const diskFreeBytes = s.bavail * s.bsize;
        const usedDisk = diskTotalBytes - diskFreeBytes;
        diskPercent = diskTotalBytes > 0
            ? Math.round((usedDisk / diskTotalBytes) * 1000) / 10
            : 0;
    } catch {
        diskPercent = 0;
    }

    return { cpuPercent, memPercent, diskPercent };
}
