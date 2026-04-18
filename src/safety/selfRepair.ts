/**
 * TITAN — Self-Repair Daemon (v4.9.0+, local hard-takeoff)
 *
 * The meta-watcher that orchestrates the safety + memory systems.
 * Runs every 5 minutes (configurable). Each tick it checks the state
 * of the organism across multiple dimensions and, when something's
 * stuck, files a self-repair proposal to the approval queue.
 *
 * The daemon does NOT auto-fix — it proposes. Human-in-the-loop is
 * core: TITAN can detect "I'm stuck," but the decision of what to do
 * about it stays with Tony.
 *
 * Checks:
 *   1. Drive stuck high for > 6h — propose damping / goal reset for
 *      that drive
 *   2. Same goal active > 24h with 0 subtask progress — propose split
 *      or close
 *   3. Memory file shape drift — auto-repair from backup (and log)
 *   4. Episodic anomaly: >10 goal_failed events in 24h — propose
 *      safety investigation
 *   5. Integrity ratio below 0.5 — propose metric-gaming audit
 *   6. Working memory has > 5 open-question sessions > 6h old —
 *      propose review
 *
 * Each proposal carries a {type:'self_repair', reason, evidence,
 * suggestedAction} payload. Approvals approved by Tony fire the
 * suggested action; rejected ones get archived.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'SelfRepair';

// ── Check result types ──────────────────────────────────────────

export interface SelfRepairFinding {
    kind:
        | 'drive_stuck_high'
        | 'goal_stuck_active'
        | 'memory_shape_drift'
        | 'episodic_anomaly'
        | 'integrity_low'
        | 'working_memory_stale';
    reason: string;
    evidence: Record<string, unknown>;
    suggestedAction: string;
    /** When this finding first showed up — deduped across ticks. */
    firstSeenAt: string;
    /** Severity drives proposal priority. */
    severity: 'low' | 'medium' | 'high';
}

// ── Cached findings (dedupe across ticks) ────────────────────────

const findingsByKey = new Map<string, SelfRepairFinding>();

function findingKey(f: Pick<SelfRepairFinding, 'kind' | 'evidence'>): string {
    return `${f.kind}:${JSON.stringify(f.evidence)}`;
}

// ── The watcher ──────────────────────────────────────────────────

/** Runs a full self-repair sweep. Called by the daemon on its interval. */
export async function runSelfRepairSweep(): Promise<SelfRepairFinding[]> {
    const findings: SelfRepairFinding[] = [];

    await Promise.all([
        checkDrivesStuckHigh(findings),
        checkGoalsStuckActive(findings),
        checkEpisodicAnomaly(findings),
        checkIntegrityRatio(findings),
        checkWorkingMemoryStale(findings),
    ]);

    // Dedupe against prior ticks — only surface new findings.
    const newFindings: SelfRepairFinding[] = [];
    for (const f of findings) {
        const k = findingKey(f);
        if (!findingsByKey.has(k)) {
            findingsByKey.set(k, f);
            newFindings.push(f);
        }
    }

    // File approvals for new findings.
    for (const f of newFindings) {
        await fileRepairApproval(f);
    }

    // Prune stale findings (kind+evidence combo not seen in 24h)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, f] of findingsByKey) {
        if (new Date(f.firstSeenAt).getTime() < cutoff) findingsByKey.delete(k);
    }

    if (newFindings.length > 0) {
        logger.warn(COMPONENT, `Sweep: ${newFindings.length} new finding(s): ${newFindings.map(f => f.kind).join(', ')}`);
    }
    return findings;
}

// ── Individual checks ────────────────────────────────────────────

async function checkDrivesStuckHigh(out: SelfRepairFinding[]): Promise<void> {
    try {
        const { loadDriveHistory } = await import('../organism/drives.js');
        const hist = loadDriveHistory();
        if (!hist || !hist.history || hist.history.length < 72) return; // need ≥6h history @ 5min cadence
        // Look at last 6 hours — 72 ticks at 5 min cadence.
        const recent = hist.history.slice(-72);
        for (const driveId of ['curiosity', 'hunger', 'purpose', 'safety', 'social'] as const) {
            const sats = recent
                .map(h => (h.satisfactions as Record<string, number>)[driveId])
                .filter((s): s is number => typeof s === 'number');
            if (sats.length < 50) continue;
            // Under 0.3 consistently = stuck high pressure
            const stuck = sats.every(s => s < 0.3);
            if (!stuck) continue;
            out.push({
                kind: 'drive_stuck_high',
                reason: `${driveId} drive satisfaction < 0.3 across all ${sats.length} recent ticks`,
                evidence: { driveId, avgSatisfaction: Math.round((sats.reduce((a, b) => a + b, 0) / sats.length) * 100) / 100, sampleCount: sats.length },
                suggestedAction: `Temporarily dampen ${driveId} drive (lower its weight to 0.5× or disable for 24h) and investigate why satisfaction can't recover.`,
                firstSeenAt: new Date().toISOString(),
                severity: driveId === 'safety' ? 'high' : 'medium',
            });
        }
    } catch { /* ok */ }
}

async function checkGoalsStuckActive(out: SelfRepairFinding[]): Promise<void> {
    try {
        const { listGoals } = await import('../agent/goals.js');
        const goals = listGoals('active');
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const g of goals) {
            const startedAt = new Date(g.createdAt).getTime();
            if (startedAt > cutoff) continue; // younger than 24h
            const subs = g.subtasks || [];
            const done = subs.filter(s => s.status === 'done').length;
            if (done > 0) continue; // some progress
            out.push({
                kind: 'goal_stuck_active',
                reason: `Goal "${g.title}" has been active > 24h with 0 completed subtasks`,
                evidence: { goalId: g.id, title: g.title, subtaskCount: subs.length, ageHours: Math.round((Date.now() - startedAt) / 3_600_000) },
                suggestedAction: `Split this goal into smaller concrete subtasks OR close it as infeasible.`,
                firstSeenAt: new Date().toISOString(),
                severity: 'medium',
            });
        }
    } catch { /* ok */ }
}

async function checkEpisodicAnomaly(out: SelfRepairFinding[]): Promise<void> {
    try {
        const { getEpisodicStats } = await import('../memory/episodic.js');
        const s = getEpisodicStats(24);
        const failed = s.byKind.goal_failed ?? 0;
        if (failed >= 10) {
            out.push({
                kind: 'episodic_anomaly',
                reason: `${failed} goal_failed episodes in the last 24h`,
                evidence: { count: failed, byKind: s.byKind },
                suggestedAction: `Review recent goals — either the proposal quality dropped or an underlying subsystem is failing. Consider pausing autopilot until root cause identified.`,
                firstSeenAt: new Date().toISOString(),
                severity: 'high',
            });
        }
    } catch { /* ok */ }
}

async function checkIntegrityRatio(out: SelfRepairFinding[]): Promise<void> {
    try {
        const { getIntegrityRatio, getMetricGuardStats } = await import('./metricGuard.js');
        const ratio = getIntegrityRatio();
        const stats = getMetricGuardStats();
        // Only meaningful with ≥20 events
        if (stats.verified24h + stats.unverified24h < 20) return;
        if (ratio < 0.5) {
            out.push({
                kind: 'integrity_low',
                reason: `Satisfaction-event integrity ratio ${(ratio * 100).toFixed(1)}% (many unverified self-credits)`,
                evidence: { verified: stats.verified24h, unverified: stats.unverified24h, ratio },
                suggestedAction: `Audit the last 24h of drive-satisfaction events for Goodhart patterns — specifically look for repeated verifier failures from the same source.`,
                firstSeenAt: new Date().toISOString(),
                severity: 'high',
            });
        }
    } catch { /* ok */ }
}

async function checkWorkingMemoryStale(out: SelfRepairFinding[]): Promise<void> {
    try {
        const { listActiveSessions } = await import('../memory/workingMemory.js');
        const active = listActiveSessions();
        const cutoff = Date.now() - 6 * 60 * 60 * 1000;
        const stale = active.filter(r => r.openQuestions.length > 0 && new Date(r.lastActiveAt).getTime() < cutoff);
        if (stale.length >= 5) {
            out.push({
                kind: 'working_memory_stale',
                reason: `${stale.length} sessions have open questions and are >6h idle`,
                evidence: { count: stale.length, sessionIds: stale.map(s => s.sessionId.slice(0, 8)) },
                suggestedAction: `Review these sessions — resolve their open questions, close as abandoned, or revive with fresh attention.`,
                firstSeenAt: new Date().toISOString(),
                severity: 'low',
            });
        }
    } catch { /* ok */ }
}

// ── File the approval ────────────────────────────────────────────

async function fileRepairApproval(finding: SelfRepairFinding): Promise<void> {
    try {
        const cp = await import('../agent/commandPost.js');
        cp.createApproval({
            type: 'custom',
            requestedBy: 'self-repair-daemon',
            payload: {
                kind: 'self_repair',
                finding: finding.kind,
                reason: finding.reason,
                evidence: finding.evidence,
                suggestedAction: finding.suggestedAction,
                severity: finding.severity,
            },
            linkedIssueIds: [],
        });
        // Record as an episode so the pattern is recallable.
        const { recordEpisode } = await import('../memory/episodic.js');
        recordEpisode({
            kind: 'significant_learning',
            summary: `Self-repair flagged: ${finding.reason}`,
            detail: `Suggested action: ${finding.suggestedAction}`,
            tags: ['self-repair', finding.kind, finding.severity],
        });
    } catch (err) {
        logger.warn(COMPONENT, `file approval failed: ${(err as Error).message}`);
    }
}

export function getSelfRepairFindings(): SelfRepairFinding[] {
    return Array.from(findingsByKey.values());
}

/** Test-only: clear dedupe cache. */
export function _resetSelfRepairForTests(): void {
    findingsByKey.clear();
}
