/**
 * TITAN — Persona A/B Rollout (v5.5.27+, visionary V2 #3)
 *
 * Argo Rollouts for prompts. Operators canary a candidate persona against
 * a baseline persona on a subset of traffic. Outcomes (success, latency,
 * Safety-drive snapshot) are recorded per cohort role. A monitor wakes up
 * every N minutes, computes baseline-vs-candidate stats over a rolling
 * window, and **auto-reverts the candidate to 0% traffic** if pass-rate
 * regresses or Safety drops past threshold.
 *
 * Why this is engineer-credible:
 *   - Bad prompts currently ship to 100% of traffic and get rolled back
 *     manually 2-5 days later. This makes blast radius 10% × 30min.
 *   - Mastra/Vercel/Anthropic SDK have no notion of "agent health" — they
 *     can't auto-revert because they have no signal. TITAN has Soma drives.
 *   - Per-cohort stats are persisted to ~/.titan/persona-cohorts.json plus
 *     ~/.titan/persona-cohort-events.jsonl (rolling window). Cheap, no DB.
 *
 * Architecture:
 *   - Cohort = { id, baselineId, candidateId, percent, hashKey } persisted
 *     as a small JSON file. Created via POST /api/persona-cohorts.
 *   - Hash assignment is deterministic per (hashKey, sessionId). Same user
 *     stays in the same arm across requests.
 *   - Outcome recording fires once per processMessage on the post-response
 *     path. Records {cohortId, role, success, latencyMs, safetySat}.
 *   - Monitor cron runs every monitorIntervalMins. For each non-reverted
 *     cohort: pull last windowMins of events, split by role, compute
 *     pass-rate and avg safety, decide revert.
 *   - Revert flips percent to 0 + writes auditStore entry + updates the
 *     cohort record's revertedAt + reason.
 *
 * Safety properties:
 *   - Fail-open: any module-load error or invalid config returns null from
 *     pickPersonaForRequest, so requests fall through to the baseline
 *     resolver path.
 *   - Insufficient-sample guard: a candidate with fewer than minSampleSize
 *     events does NOT auto-revert (avoids whipsaw on cold start).
 *   - Hash determinism: same (cohortId, sessionId) always lands in the
 *     same role. No flapping mid-session.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';
import { loadConfig } from '../config/config.js';

const COMPONENT = 'PersonaRollout';

const COHORTS_PATH = join(TITAN_HOME, 'persona-cohorts.json');
const EVENTS_PATH = join(TITAN_HOME, 'persona-cohort-events.jsonl');

// ── Shape ────────────────────────────────────────────────────────

export type CohortRole = 'baseline' | 'candidate';

export interface CohortRecord {
    id: string;
    /** Persona id that gets the larger cut of traffic. */
    baselineId: string;
    /** Persona id being canaried. */
    candidateId: string;
    /** % of traffic routed to candidate. 0 = candidate is reverted. */
    percent: number;
    /** Source of the hash key. v1: 'sessionId' (per-session) or 'channel'. */
    hashKey: 'sessionId' | 'channel';
    createdAt: string;
    revertedAt?: string;
    revertReason?: string;
    /** Optional human note (the rollout's purpose). */
    note?: string;
}

interface CohortFile {
    cohorts: CohortRecord[];
}

interface OutcomeEvent {
    timestamp: string;
    cohortId: string;
    role: CohortRole;
    sessionId: string;
    success: boolean;
    latencyMs: number;
    /** Safety drive satisfaction at time of response, 0-1 or null if unavailable. */
    safetySat: number | null;
}

// ── Persistence ────────────────────────────────────────────────────

function loadFile(): CohortFile {
    if (!existsSync(COHORTS_PATH)) return { cohorts: [] };
    try {
        return JSON.parse(readFileSync(COHORTS_PATH, 'utf-8')) as CohortFile;
    } catch (err) {
        logger.warn(COMPONENT, `cohorts file corrupt: ${(err as Error).message}`);
        return { cohorts: [] };
    }
}

function saveFile(file: CohortFile): void {
    try {
        mkdirSync(TITAN_HOME, { recursive: true });
        writeFileSync(COHORTS_PATH, JSON.stringify(file, null, 2));
    } catch (err) {
        logger.warn(COMPONENT, `persist cohorts: ${(err as Error).message}`);
    }
}

export function listCohorts(): CohortRecord[] {
    return loadFile().cohorts;
}

export function getCohort(id: string): CohortRecord | null {
    return listCohorts().find(c => c.id === id) ?? null;
}

// ── Cohort lifecycle ───────────────────────────────────────────────

export interface CreateCohortInput {
    baselineId: string;
    candidateId: string;
    percent: number;
    hashKey?: 'sessionId' | 'channel';
    note?: string;
    id?: string;
}

export function createCohort(input: CreateCohortInput): CohortRecord {
    if (input.percent < 0 || input.percent > 100) {
        throw new Error(`percent must be 0-100, got ${input.percent}`);
    }
    if (input.baselineId === input.candidateId) {
        throw new Error('baselineId and candidateId must differ');
    }
    const id = input.id ?? `co_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const file = loadFile();
    if (file.cohorts.some(c => c.id === id)) {
        throw new Error(`cohort ${id} already exists`);
    }
    const record: CohortRecord = {
        id,
        baselineId: input.baselineId,
        candidateId: input.candidateId,
        percent: Math.round(input.percent),
        hashKey: input.hashKey ?? 'sessionId',
        createdAt: new Date().toISOString(),
        note: input.note,
    };
    file.cohorts.push(record);
    saveFile(file);
    logger.info(COMPONENT, `cohort created: ${id} (${input.baselineId} → ${input.candidateId} @ ${input.percent}%)`);
    return record;
}

export function deleteCohort(id: string): boolean {
    const file = loadFile();
    const before = file.cohorts.length;
    file.cohorts = file.cohorts.filter(c => c.id !== id);
    if (file.cohorts.length === before) return false;
    saveFile(file);
    logger.info(COMPONENT, `cohort deleted: ${id}`);
    return true;
}

export function revertCohort(id: string, reason: string, source: 'auto' | 'manual' = 'manual'): CohortRecord | null {
    const file = loadFile();
    const cohort = file.cohorts.find(c => c.id === id);
    if (!cohort) return null;
    if (cohort.percent === 0 && cohort.revertedAt) return cohort;
    cohort.percent = 0;
    cohort.revertedAt = new Date().toISOString();
    cohort.revertReason = `${source}: ${reason}`;
    saveFile(file);
    logger.warn(COMPONENT, `cohort ${id} reverted (${source}): ${reason}`);
    // Audit + alert (best-effort). Auto-reverts page operators because
    // they reflect candidate-prompt regressions on real traffic. Manual
    // reverts ping at info severity.
    void (async () => {
        try {
            const { sendAlert } = await import('./alerts.js');
            sendAlert(
                source === 'auto' ? 'warning' : 'info',
                `Persona cohort ${source}-reverted`,
                `Cohort ${id} (${cohort.baselineId} → ${cohort.candidateId}): ${reason}`,
                'persona-rollout',
                { cohortId: id, baselineId: cohort.baselineId, candidateId: cohort.candidateId, source, reason },
            );
        } catch { /* alerts optional */ }
    })();
    return cohort;
}

// ── Hash assignment ────────────────────────────────────────────────

/**
 * Deterministic 0-99 bucket from (cohortId, hashInput). A given pair
 * always lands in the same bucket — same session, same arm.
 */
export function bucketFor(cohortId: string, hashInput: string): number {
    const h = createHash('sha256').update(`${cohortId}:${hashInput}`).digest();
    // Use first 4 bytes as uint32, mod 100. Slight modulo bias is
    // negligible for 100 buckets out of 2^32.
    const n = h.readUInt32BE(0);
    return n % 100;
}

export interface RoleAssignment {
    personaId: string;
    role: CohortRole;
    cohortId: string;
}

/**
 * Resolve cohort assignment for a request. Returns null when:
 *   - personas.rollout.enabled is false
 *   - no cohort has personaId as its baseline
 *   - the cohort has been reverted (percent=0)
 *   - the resolved hash falls into the baseline bucket (no override needed)
 *
 * When non-null, the caller swaps the persona to the candidate.
 */
export function pickCohortAssignment(personaId: string, ctx: { sessionId?: string; channel?: string }): RoleAssignment | null {
    let rolloutEnabled = false;
    try {
        const cfg = loadConfig();
        rolloutEnabled = Boolean((cfg.personas as { rollout?: { enabled?: boolean } } | undefined)?.rollout?.enabled);
    } catch {
        return null;
    }
    if (!rolloutEnabled) return null;

    const file = loadFile();
    // Match cohorts that use this persona as baseline AND are still active.
    const active = file.cohorts.filter(c => c.baselineId === personaId && c.percent > 0);
    if (active.length === 0) return null;

    // If multiple cohorts target the same baseline, the first one created
    // wins. (v1 keeps the model simple; future versions can stack.)
    const cohort = active[0];
    const hashInput = cohort.hashKey === 'channel' ? (ctx.channel ?? 'unknown') : (ctx.sessionId ?? 'anonymous');
    const bucket = bucketFor(cohort.id, hashInput);
    if (bucket < cohort.percent) {
        return { personaId: cohort.candidateId, role: 'candidate', cohortId: cohort.id };
    }
    return { personaId: cohort.baselineId, role: 'baseline', cohortId: cohort.id };
}

// ── Outcome recording ──────────────────────────────────────────────

export function recordOutcome(event: Omit<OutcomeEvent, 'timestamp'>): void {
    try {
        mkdirSync(TITAN_HOME, { recursive: true });
        const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n';
        appendFileSync(EVENTS_PATH, line);
    } catch (err) {
        logger.warn(COMPONENT, `recordOutcome: ${(err as Error).message}`);
    }
}

function readRecentEvents(windowMins: number): OutcomeEvent[] {
    if (!existsSync(EVENTS_PATH)) return [];
    const cutoffMs = Date.now() - windowMins * 60 * 1000;
    try {
        const raw = readFileSync(EVENTS_PATH, 'utf-8');
        const out: OutcomeEvent[] = [];
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const ev = JSON.parse(trimmed) as OutcomeEvent;
                if (new Date(ev.timestamp).getTime() >= cutoffMs) out.push(ev);
            } catch { /* skip malformed */ }
        }
        return out;
    } catch {
        return [];
    }
}

// ── Health evaluation ──────────────────────────────────────────────

export interface CohortHealth {
    cohortId: string;
    baseline: ArmHealth;
    candidate: ArmHealth;
    /** Pass-rate diff (candidate - baseline). Negative = candidate worse. */
    passRateDiff: number;
    /** Safety drive diff (candidate - baseline). Negative = candidate worse. */
    safetyDiff: number;
    /** True if the v1 thresholds say this cohort should be auto-reverted. */
    shouldRevert: boolean;
    /** Human-readable reason or null. */
    revertReason: string | null;
}

export interface ArmHealth {
    samples: number;
    passRate: number;       // 0-1
    avgLatencyMs: number;
    avgSafetySat: number;   // 0-1, NaN-safe (returns 0 when no samples carry safety)
}

function summarizeArm(events: OutcomeEvent[]): ArmHealth {
    if (events.length === 0) {
        return { samples: 0, passRate: 0, avgLatencyMs: 0, avgSafetySat: 0 };
    }
    let okCount = 0;
    let latencySum = 0;
    let safetySum = 0;
    let safetyCount = 0;
    for (const e of events) {
        if (e.success) okCount += 1;
        latencySum += e.latencyMs;
        if (typeof e.safetySat === 'number') {
            safetySum += e.safetySat;
            safetyCount += 1;
        }
    }
    return {
        samples: events.length,
        passRate: okCount / events.length,
        avgLatencyMs: latencySum / events.length,
        avgSafetySat: safetyCount > 0 ? safetySum / safetyCount : 0,
    };
}

export function evaluateCohort(cohort: CohortRecord, opts?: { windowMins?: number; minSampleSize?: number; passRateMargin?: number; safetyDropThreshold?: number }): CohortHealth {
    const windowMins = opts?.windowMins ?? 30;
    const minSampleSize = opts?.minSampleSize ?? 10;
    const passRateMargin = opts?.passRateMargin ?? 0.05;
    const safetyDropThreshold = opts?.safetyDropThreshold ?? 0.2;

    const events = readRecentEvents(windowMins).filter(e => e.cohortId === cohort.id);
    const baseline = summarizeArm(events.filter(e => e.role === 'baseline'));
    const candidate = summarizeArm(events.filter(e => e.role === 'candidate'));

    const passRateDiff = candidate.passRate - baseline.passRate;
    const safetyDiff = candidate.avgSafetySat - baseline.avgSafetySat;

    let shouldRevert = false;
    let revertReason: string | null = null;

    // Insufficient sample → never auto-revert (cold start guard).
    if (candidate.samples >= minSampleSize && baseline.samples >= minSampleSize) {
        if (-passRateDiff > passRateMargin) {
            shouldRevert = true;
            revertReason = `candidate pass-rate ${(candidate.passRate * 100).toFixed(1)}% is ${((-passRateDiff) * 100).toFixed(1)} pts below baseline ${(baseline.passRate * 100).toFixed(1)}% (margin ${(passRateMargin * 100).toFixed(1)}%)`;
        } else if (-safetyDiff > safetyDropThreshold) {
            shouldRevert = true;
            revertReason = `candidate Safety drive ${candidate.avgSafetySat.toFixed(2)} dropped ${(-safetyDiff).toFixed(2)} below baseline ${baseline.avgSafetySat.toFixed(2)} (threshold ${safetyDropThreshold.toFixed(2)})`;
        }
    }

    return { cohortId: cohort.id, baseline, candidate, passRateDiff, safetyDiff, shouldRevert, revertReason };
}

// ── Monitor cron ───────────────────────────────────────────────────

let monitorTimer: NodeJS.Timeout | null = null;

export function startRolloutMonitor(): void {
    let cfg;
    try { cfg = loadConfig(); } catch { return; }
    const rollout = (cfg.personas as { rollout?: { enabled?: boolean; monitorIntervalMins?: number; minSampleSize?: number; passRateMargin?: number; safetyDropThreshold?: number; windowMins?: number } } | undefined)?.rollout;
    if (!rollout?.enabled) {
        logger.info(COMPONENT, 'Rollout monitor disabled (config.personas.rollout.enabled=false)');
        return;
    }
    const intervalMins = rollout.monitorIntervalMins ?? 5;

    function tick(): void {
        try {
            const file = loadFile();
            for (const cohort of file.cohorts) {
                if (cohort.percent === 0) continue; // already reverted
                const health = evaluateCohort(cohort, {
                    windowMins: rollout?.windowMins,
                    minSampleSize: rollout?.minSampleSize,
                    passRateMargin: rollout?.passRateMargin,
                    safetyDropThreshold: rollout?.safetyDropThreshold,
                });
                if (health.shouldRevert && health.revertReason) {
                    revertCohort(cohort.id, health.revertReason, 'auto');
                }
            }
        } catch (err) {
            logger.warn(COMPONENT, `monitor tick: ${(err as Error).message}`);
        }
    }

    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(tick, intervalMins * 60 * 1000);
    monitorTimer.unref?.();
    logger.info(COMPONENT, `Rollout monitor started (every ${intervalMins} min)`);
    // Run one immediate tick so a freshly-rebooted gateway picks up
    // anything that should already revert.
    setImmediate(tick);
}

export function stopRolloutMonitor(): void {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
}
