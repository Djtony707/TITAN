/**
 * TITAN — Daily Digest (v4.10.0-local, Phase B)
 *
 * Generates a proactive "here's what happened in the last 24h" summary
 * each day (default: 9am PDT). Surfaced via:
 *   - SSE broadcast on topic 'digest:daily'
 *   - Persisted to ~/.titan/digest/<YYYY-MM-DD>.json for history
 *   - GET /api/digest/today returns latest
 *   - Optional push to Telegram / Discord if configured (channel
 *     adapter picks it up from the SSE topic)
 *
 * Content: goals done + failed + blocked, driver-pipeline health,
 * drive state deltas, pending approvals ranked by urgency.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';

const COMPONENT = 'DailyDigest';
const DIGEST_DIR = join(TITAN_HOME, 'digest');

// ── Shape ────────────────────────────────────────────────────────

export interface DailyDigest {
    date: string; // YYYY-MM-DD
    generatedAt: string;
    summary: {
        goalsCompleted: number;
        goalsFailed: number;
        goalsBlocked: number;
        goalsActive: number;
    };
    topCompletedGoals: Array<{
        id: string;
        title: string;
        durationMs: number;
        specialists: string[];
    }>;
    blockedGoals: Array<{
        id: string;
        title: string;
        blockedSince: string;
        question: string;
    }>;
    failedGoals: Array<{
        id: string;
        title: string;
        reason: string;
    }>;
    drives: {
        purpose: number;
        hunger: number;
        curiosity: number;
        safety: number;
        social: number;
    };
    pendingApprovals: Array<{
        id: string;
        type: string;
        requestedBy: string;
        ageMins: number;
        urgency: 'high' | 'medium' | 'low';
        summary: string;
    }>;
    highlights: string[]; // 1-liner bullet points for TL;DR
}

// ── Generation ──────────────────────────────────────────────────

export async function generateDigest(): Promise<DailyDigest> {
    const now = new Date();
    const yesterdayMs = now.getTime() - 24 * 60 * 60 * 1000;

    const summary = { goalsCompleted: 0, goalsFailed: 0, goalsBlocked: 0, goalsActive: 0 };
    const topCompletedGoals: DailyDigest['topCompletedGoals'] = [];
    const blockedGoals: DailyDigest['blockedGoals'] = [];
    const failedGoals: DailyDigest['failedGoals'] = [];
    const highlights: string[] = [];

    // 1. Goals + drivers
    try {
        const { listAllDrivers } = await import('./goalDriver.js');
        const { listGoals } = await import('./goals.js');
        const drivers = listAllDrivers();
        for (const d of drivers) {
            const completedAt = d.retrospective?.durationMs
                ? new Date(d.startedAt).getTime() + d.retrospective.durationMs
                : 0;
            if (completedAt > 0 && completedAt < yesterdayMs) continue; // older than 24h
            if (d.phase === 'done') {
                summary.goalsCompleted++;
                const goal = listGoals().find(g => g.id === d.goalId);
                if (goal && topCompletedGoals.length < 10) {
                    topCompletedGoals.push({
                        id: goal.id,
                        title: goal.title,
                        durationMs: d.retrospective?.durationMs ?? 0,
                        specialists: d.retrospective?.specialistsUsed ?? [],
                    });
                }
            } else if (d.phase === 'failed') {
                summary.goalsFailed++;
                const goal = listGoals().find(g => g.id === d.goalId);
                if (goal) {
                    failedGoals.push({
                        id: goal.id,
                        title: goal.title,
                        reason: d.retrospective?.lessonsLearned[0] ?? 'unknown',
                    });
                }
            } else if (d.phase === 'blocked') {
                summary.goalsBlocked++;
                const goal = listGoals().find(g => g.id === d.goalId);
                if (goal && d.blockedReason) {
                    blockedGoals.push({
                        id: goal.id,
                        title: goal.title,
                        blockedSince: d.blockedReason.sinceAt,
                        question: d.blockedReason.question,
                    });
                }
            } else {
                summary.goalsActive++;
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `Driver scan failed: ${(err as Error).message}`);
    }

    // 2. Drive state
    let drives: DailyDigest['drives'] = {
        purpose: 0, hunger: 0, curiosity: 0, safety: 0, social: 0,
    };
    try {
        const drivesPath = join(TITAN_HOME, 'drive-state.json');
        if (existsSync(drivesPath)) {
            const raw = JSON.parse(readFileSync(drivesPath, 'utf-8'));
            // v4.10.0-local fix: drive-state.json actual shape is
            // { latest: { timestamp, drives: [...] }, history: [...] }
            // (not a top-level `drives` array). Read from latest.drives.
            const driveList = raw?.latest?.drives ?? raw?.drives ?? [];
            const byId: Record<string, { satisfaction?: number }> = {};
            for (const d of driveList) byId[d.id] = d;
            drives = {
                purpose: byId.purpose?.satisfaction ?? 0,
                hunger: byId.hunger?.satisfaction ?? 0,
                curiosity: byId.curiosity?.satisfaction ?? 0,
                safety: byId.safety?.satisfaction ?? 0,
                social: byId.social?.satisfaction ?? 0,
            };
        }
    } catch (err) {
        logger.debug(COMPONENT, `Drive load: ${(err as Error).message}`);
    }

    // 3. Pending approvals
    const pendingApprovals: DailyDigest['pendingApprovals'] = [];
    try {
        const { listApprovals } = await import('./commandPost.js');
        const approvals = listApprovals('pending');
        for (const a of approvals) {
            const ageMins = Math.round((Date.now() - new Date(a.createdAt).getTime()) / 60_000);
            const kind = (a.payload as Record<string, unknown>)?.kind as string | undefined;
            const urgency: 'high' | 'medium' | 'low' =
                kind === 'driver_blocked' ? 'high' :
                kind === 'self_mod_pr' ? 'high' :
                a.type === 'hire_agent' ? 'medium' :
                'low';
            const title =
                (a.payload as Record<string, unknown>)?.goalTitle as string ||
                (a.payload as Record<string, unknown>)?.title as string ||
                (a.payload as Record<string, unknown>)?.reason as string ||
                a.type;
            pendingApprovals.push({
                id: a.id,
                type: a.type,
                requestedBy: a.requestedBy,
                ageMins,
                urgency,
                summary: String(title).slice(0, 120),
            });
        }
        // Sort: urgency desc, age desc
        pendingApprovals.sort((a, b) => {
            const u: Record<string, number> = { high: 3, medium: 2, low: 1 };
            return (u[b.urgency] - u[a.urgency]) || (b.ageMins - a.ageMins);
        });
    } catch (err) {
        logger.debug(COMPONENT, `Approval scan failed: ${(err as Error).message}`);
    }

    // 4. Highlights — 3-5 TL;DR bullets
    if (summary.goalsCompleted > 0) {
        highlights.push(`✓ ${summary.goalsCompleted} goal${summary.goalsCompleted > 1 ? 's' : ''} completed`);
    }
    if (summary.goalsBlocked > 0) {
        highlights.push(`⏸ ${summary.goalsBlocked} blocked on you — see pending approvals`);
    }
    if (summary.goalsFailed > 0) {
        highlights.push(`✗ ${summary.goalsFailed} failed — check retrospectives`);
    }
    if (pendingApprovals.filter(a => a.urgency === 'high').length > 0) {
        highlights.push(`⚠ ${pendingApprovals.filter(a => a.urgency === 'high').length} high-urgency approval(s) waiting`);
    }
    if (drives.hunger < 0.3) {
        highlights.push(`🍽 Hunger drive low (${drives.hunger.toFixed(2)}) — TITAN has work backlog`);
    }
    if (drives.safety < 0.5) {
        highlights.push(`🛡 Safety drive pressured (${drives.safety.toFixed(2)}) — investigate`);
    }

    const digest: DailyDigest = {
        date: now.toISOString().slice(0, 10),
        generatedAt: now.toISOString(),
        summary,
        topCompletedGoals,
        blockedGoals,
        failedGoals,
        drives,
        pendingApprovals,
        highlights,
    };

    persistDigest(digest);
    broadcastDigest(digest);
    return digest;
}

// ── Storage ──────────────────────────────────────────────────────

function persistDigest(digest: DailyDigest): void {
    try {
        mkdirSync(DIGEST_DIR, { recursive: true });
        writeFileSync(join(DIGEST_DIR, `${digest.date}.json`), JSON.stringify(digest, null, 2));
    } catch (err) {
        logger.warn(COMPONENT, `Persist failed: ${(err as Error).message}`);
    }
}

export function getLatestDigest(): DailyDigest | null {
    try {
        if (!existsSync(DIGEST_DIR)) return null;
        const files = readdirSync(DIGEST_DIR).filter((f: string) => f.endsWith('.json')).sort().reverse();
        if (files.length === 0) return null;
        return JSON.parse(readFileSync(join(DIGEST_DIR, files[0]), 'utf-8')) as DailyDigest;
    } catch { return null; }
}

export function getDigestByDate(date: string): DailyDigest | null {
    try {
        const path = join(DIGEST_DIR, `${date}.json`);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, 'utf-8')) as DailyDigest;
    } catch { return null; }
}

function broadcastDigest(digest: DailyDigest): void {
    const g = globalThis as unknown as { __titan_sse_broadcast?: (topic: string, payload: unknown) => void };
    if (typeof g.__titan_sse_broadcast === 'function') {
        try { g.__titan_sse_broadcast('digest:daily', digest); } catch { /* ok */ }
    }
}

// ── Cron ─────────────────────────────────────────────────────────

let digestInterval: NodeJS.Timeout | null = null;

/**
 * Kick off a daily-9am-PDT timer. Runs once per day. Also generates
 * one digest immediately at boot so the endpoint always has fresh data.
 */
export function startDailyDigestCron(): void {
    // Immediate run so /api/digest/today has data right after boot
    void generateDigest().catch(err => logger.warn(COMPONENT, `initial digest: ${(err as Error).message}`));

    // Schedule next 9am PDT
    function scheduleNext(): void {
        const now = new Date();
        const target = new Date(now);
        target.setHours(9, 0, 0, 0); // local time — Titan PC is on PDT
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        const msUntil = target.getTime() - now.getTime();
        if (digestInterval) clearTimeout(digestInterval);
        digestInterval = setTimeout(async () => {
            try { await generateDigest(); } catch (err) { logger.warn(COMPONENT, `cron digest: ${(err as Error).message}`); }
            scheduleNext();
        }, msUntil);
        digestInterval.unref?.();
        logger.info(COMPONENT, `Next daily digest scheduled at ${target.toISOString()} (${Math.round(msUntil / 60_000)} min from now)`);
    }
    scheduleNext();
}

export function stopDailyDigestCron(): void {
    if (digestInterval) {
        clearTimeout(digestInterval);
        digestInterval = null;
    }
}
