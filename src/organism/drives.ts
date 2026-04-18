/**
 * TITAN — Drive Layer (Soma organism / endocrine system)
 *
 * Five homeostatic drives. Each computes a 0-1 "satisfaction" from existing
 * TITAN telemetry — no new instrumentation. When satisfaction dips below the
 * drive's setpoint, pressure accumulates. Cross-drive pressure fusion (see
 * pressure.ts) eventually produces a soma_proposal for human approval.
 *
 * Gated by config.organism.enabled — this module is inert when disabled.
 *
 * DRIVES SHIPPED IN v4.0:
 *   Purpose   — alignment with priority-1 goals
 *   Hunger    — backlog size vs. throughput
 *   Curiosity — task-type diversity in recent trajectories
 *   Safety    — budget runway + recent error rate
 *   Social    — stale agent fraction
 *
 * DEFERRED TO v4.1+:
 *   Hygiene   — needs npm test + git status shell hooks
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import { listGoals, getReadyTasks, type Goal } from '../agent/goals.js';
import { getRegisteredAgents, getBudgetPolicies, listRuns, type RegisteredAgent, type BudgetPolicy, type CPRun } from '../agent/commandPost.js';
import { getRecentTrajectories, type TaskTrajectory } from '../agent/trajectoryLogger.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Drives';
const DRIVE_STATE_PATH = join(TITAN_HOME, 'drive-state.json');

// ── Types ────────────────────────────────────────────────────────

export type DriveId = 'purpose' | 'hunger' | 'curiosity' | 'safety' | 'social';

export interface DriveSnapshot {
    /** Timestamp of the snapshot in epoch ms. */
    now: number;
    /** All goals from goals.ts. */
    goals: Goal[];
    /** Output of getReadyTasks() — ready-to-execute subtasks. */
    readyTasks: Array<{ goal: Goal; subtask: Goal['subtasks'][number] }>;
    /** Recent CPRun history (up to 100 most recent). */
    recentRuns: CPRun[];
    /** Active budget policies. */
    budgets: BudgetPolicy[];
    /** All registered agents. */
    agents: RegisteredAgent[];
    /** Last 100 trajectory entries. */
    trajectories: TaskTrajectory[];
    /**
     * v4.9.0: fraction of GPU VRAM in use (0–1). Undefined when no GPU
     * is attached or the orchestrator hasn't refreshed yet.
     */
    vramSaturation?: number;
    /**
     * v4.9.0: error rate across recent LLM / tool calls from the
     * gateway metrics layer (0–1). Undefined when metrics are unavailable.
     */
    telemetryErrorRate?: number;
    /** v4.9.0: total LLM + tool-call requests since gateway start. */
    telemetryTotalRequests?: number;
    /**
     * v4.9.0: count of error patterns the learning layer has accumulated
     * but not yet resolved. High count pulls Curiosity toward an
     * investigate/improve proposal.
     */
    unresolvedErrorPatterns?: number;
}

export interface DriveDefinition {
    id: DriveId;
    label: string;
    /** Satisfaction level below which this drive starts contributing pressure. */
    defaultSetpoint: number;
    /** Relative weight in cross-drive pressure fusion (1.0 is baseline). */
    weight: number;
    /** Pure function — computes satisfaction 0-1 from the snapshot. */
    compute: (snapshot: DriveSnapshot) => { satisfaction: number; inputs?: Record<string, unknown> };
    /** Short human-readable explanation used in prompts, UI tooltips, and activity feed. */
    describe: (satisfaction: number, inputs?: Record<string, unknown>) => string;
}

export interface DriveState {
    id: DriveId;
    label: string;
    satisfaction: number;
    setpoint: number;
    /** 0 when satisfaction >= setpoint, else (setpoint − satisfaction) × weight. */
    pressure: number;
    weight: number;
    inputs?: Record<string, unknown>;
    description: string;
}

export interface DriveTickResult {
    timestamp: string;
    drives: DriveState[];
    totalPressure: number;
    dominantDrives: DriveId[];
}

// ── Numeric helpers ──────────────────────────────────────────────

/** Clamp to [0,1]. */
function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

/** Sigmoid centred on `mid` with slope `k`. Returns high → 1 when x is low. */
function invertedSigmoid(x: number, mid: number, k = 1): number {
    return clamp01(1 / (1 + Math.exp(k * (x - mid))));
}

/** Gini coefficient of a count distribution. 0 = uniform, 1 = all same task. */
function gini(counts: number[]): number {
    if (counts.length === 0) return 0;
    const n = counts.length;
    const sum = counts.reduce((a, b) => a + b, 0);
    if (sum === 0) return 0;
    const sorted = [...counts].sort((a, b) => a - b);
    let cum = 0;
    for (let i = 0; i < n; i++) cum += (i + 1) * sorted[i];
    return clamp01((2 * cum) / (n * sum) - (n + 1) / n);
}

// ── Drive definitions ────────────────────────────────────────────

const PURPOSE: DriveDefinition = {
    id: 'purpose',
    label: 'Purpose',
    defaultSetpoint: 0.7,
    weight: 1.4,
    compute: (snap) => {
        // Priority-1 goals tagged as high-priority. Satisfaction reflects how
        // recently any of them progressed. No priority-1 goals → satiated
        // (nothing to worry about).
        const priorityOne = snap.goals.filter(g =>
            g.status === 'active' && g.priority === 1,
        );
        if (priorityOne.length === 0) {
            return { satisfaction: 0.9, inputs: { priorityOneCount: 0 } };
        }
        const latest = Math.max(...priorityOne.map(g =>
            new Date(g.updatedAt || g.createdAt).getTime(),
        ));
        const hoursSince = Math.max(0, (snap.now - latest) / 3_600_000);
        const satisfaction = clamp01(1 - hoursSince / 24);
        return {
            satisfaction,
            inputs: { priorityOneCount: priorityOne.length, hoursSinceProgress: Math.round(hoursSince * 10) / 10 },
        };
    },
    describe: (s, inputs) => {
        const count = (inputs?.priorityOneCount as number) ?? 0;
        if (count === 0) return 'no priority-1 goals in flight';
        const hours = (inputs?.hoursSinceProgress as number) ?? 0;
        if (s < 0.3) return `${count} priority-1 goal(s) stalled — no progress in ${hours.toFixed(1)}h`;
        if (s < 0.6) return `${count} priority-1 goal(s) need attention`;
        return `${count} priority-1 goal(s) on track`;
    },
};

const HUNGER: DriveDefinition = {
    id: 'hunger',
    label: 'Hunger',
    defaultSetpoint: 0.6,
    weight: 1.0,
    compute: (snap) => {
        const readyCount = snap.readyTasks.length;
        // Oldest ready subtask age in hours, using parent goal createdAt as proxy.
        const oldestAgeHours = snap.readyTasks.length === 0
            ? 0
            : Math.max(...snap.readyTasks.map(r =>
                (snap.now - new Date(r.goal.createdAt).getTime()) / 3_600_000,
            ));
        // Both signals independently drag satisfaction down.
        const backlogSatisfaction = invertedSigmoid(readyCount, 5, 0.35);
        const ageSatisfaction = invertedSigmoid(oldestAgeHours, 4, 0.5);
        const satisfaction = Math.min(backlogSatisfaction, ageSatisfaction);
        return {
            satisfaction,
            inputs: { readyCount, oldestAgeHours: Math.round(oldestAgeHours * 10) / 10 },
        };
    },
    describe: (s, inputs) => {
        const count = (inputs?.readyCount as number) ?? 0;
        const age = (inputs?.oldestAgeHours as number) ?? 0;
        if (count === 0) return 'backlog empty';
        if (s < 0.3) return `backlog ${count}, oldest ${age.toFixed(1)}h — elevated`;
        if (s < 0.6) return `backlog ${count}, oldest ${age.toFixed(1)}h`;
        return `backlog ${count} — fed`;
    },
};

const CURIOSITY: DriveDefinition = {
    id: 'curiosity',
    label: 'Curiosity',
    defaultSetpoint: 0.5,
    weight: 0.8,
    compute: (snap) => {
        // Novelty = task-type diversity across recent trajectories.
        // Few distinct task types → elevated curiosity (stale). Rich variety
        // → satiated. We compose two signals:
        //   1) coverage: how many distinct types relative to a target of 5
        //   2) balance: how evenly distributed those types are (1 − gini)
        // Satisfaction = min(coverage, balance) so either deficit pulls it
        // down. Low sample counts default to middling satisfaction.
        if (snap.trajectories.length < 5) {
            return { satisfaction: 0.6, inputs: { trajectoryCount: snap.trajectories.length } };
        }
        const typeCounts: Record<string, number> = {};
        for (const t of snap.trajectories) {
            typeCounts[t.taskType || 'unknown'] = (typeCounts[t.taskType || 'unknown'] || 0) + 1;
        }
        const typeCount = Object.keys(typeCounts).length;
        const coverage = clamp01(typeCount / 5);
        const counts = Object.values(typeCounts);
        const balance = typeCount <= 1 ? 0 : clamp01(1 - gini(counts));
        const diversitySat = typeCount <= 1 ? coverage : Math.min(coverage, balance);

        // v4.9.0: unresolved error patterns are a form of "task-type
        // novelty the organism hasn't figured out yet." More than a
        // handful of unresolved patterns pulls Curiosity toward an
        // investigate-and-improve proposal (feeds Self-Improve pipeline).
        // Scales 0→10+ patterns linearly.
        let errorPatternSat = 1;
        if (typeof snap.unresolvedErrorPatterns === 'number' && snap.unresolvedErrorPatterns > 2) {
            errorPatternSat = clamp01(1 - (snap.unresolvedErrorPatterns - 2) / 10);
        }

        const satisfaction = Math.min(diversitySat, errorPatternSat);
        return {
            satisfaction,
            inputs: {
                trajectoryCount: snap.trajectories.length,
                taskTypes: typeCount,
                coverage: Math.round(coverage * 100) / 100,
                balance: Math.round(balance * 100) / 100,
                unresolvedErrorPatterns: snap.unresolvedErrorPatterns ?? 0,
                errorPatternSat: Math.round(errorPatternSat * 100) / 100,
            },
        };
    },
    describe: (s, inputs) => {
        const types = (inputs?.taskTypes as number) ?? 0;
        const patterns = (inputs?.unresolvedErrorPatterns as number) ?? 0;
        if (patterns >= 5) return `${patterns} unresolved error patterns — needs investigation`;
        if (s < 0.3) return `stuck in ${types} task type(s) — stale`;
        if (s < 0.6) return `${types} task type(s) — could use novelty`;
        return `${types} distinct task type(s) — engaged`;
    },
};

const SAFETY: DriveDefinition = {
    id: 'safety',
    label: 'Safety',
    defaultSetpoint: 0.8,
    weight: 1.6,
    compute: (snap) => {
        // Budget runway: min runway across all enabled budgets.
        let budgetSatisfaction = 1;
        const relevantBudgets = snap.budgets.filter(b => b.enabled && b.limitUsd > 0);
        if (relevantBudgets.length > 0) {
            const runways = relevantBudgets.map(b => clamp01(1 - b.currentSpend / b.limitUsd));
            budgetSatisfaction = Math.min(...runways);
        }
        // Recent error rate from last 100 CPRuns in the last 24h.
        const dayMs = 86_400_000;
        const recent = snap.recentRuns.filter(r =>
            snap.now - new Date(r.startedAt).getTime() < dayMs,
        );
        let errorSatisfaction = 1;
        if (recent.length >= 5) {
            const errors = recent.filter(r => r.status === 'error' || r.status === 'failed').length;
            errorSatisfaction = clamp01(1 - errors / recent.length);
        }

        // v4.9.0: VRAM saturation above 85% presses Safety. Below 85%,
        // saturation has no effect. Scales linearly 85%–100% → sat 1→0.
        let vramSatisfaction = 1;
        if (snap.vramSaturation !== undefined) {
            if (snap.vramSaturation > 0.85) {
                vramSatisfaction = clamp01(1 - (snap.vramSaturation - 0.85) / 0.15);
            }
        }

        // v4.9.0: gateway-level telemetry error rate (LLM/tool calls).
        // Independent of CPRun error rate — catches tool failures that
        // never bubbled up to Command Post.
        let telemetrySatisfaction = 1;
        if (snap.telemetryErrorRate !== undefined) {
            telemetrySatisfaction = clamp01(1 - snap.telemetryErrorRate * 2);
        }

        // Safety is a min-aggregate — the weakest link dominates.
        const satisfaction = Math.min(
            budgetSatisfaction,
            errorSatisfaction,
            vramSatisfaction,
            telemetrySatisfaction,
        );
        return {
            satisfaction,
            inputs: {
                budgetSatisfaction: Math.round(budgetSatisfaction * 100) / 100,
                errorSatisfaction: Math.round(errorSatisfaction * 100) / 100,
                vramSatisfaction: Math.round(vramSatisfaction * 100) / 100,
                telemetrySatisfaction: Math.round(telemetrySatisfaction * 100) / 100,
                recentRunCount: recent.length,
                vramSaturationPct: snap.vramSaturation !== undefined ? Math.round(snap.vramSaturation * 100) : null,
                telemetryErrorRatePct: snap.telemetryErrorRate !== undefined ? Math.round(snap.telemetryErrorRate * 100) : null,
            },
        };
    },
    describe: (s, inputs) => {
        const budget = (inputs?.budgetSatisfaction as number) ?? 1;
        const errors = (inputs?.errorSatisfaction as number) ?? 1;
        const vram = (inputs?.vramSatisfaction as number) ?? 1;
        const tel = (inputs?.telemetrySatisfaction as number) ?? 1;
        if (budget < 0.2) return 'budget runway critical';
        if (vram < 0.4) return `VRAM saturated (${inputs?.vramSaturationPct}%) — spawns at risk`;
        if (tel < 0.5) return `gateway error rate elevated (${inputs?.telemetryErrorRatePct}%)`;
        if (errors < 0.5) return 'elevated error rate in recent runs';
        if (s < 0.6) return 'safety posture weakening';
        return 'safety posture healthy';
    },
};

const SOCIAL: DriveDefinition = {
    id: 'social',
    label: 'Social',
    defaultSetpoint: 0.7,
    weight: 0.7,
    compute: (snap) => {
        // v4.8.1: ignore specialists that were registered but never given
        // work (`totalTasksCompleted === 0`). They have nothing to heartbeat
        // about; counting them as "unresponsive" was a false negative.
        const eligible = snap.agents.filter(a => (a.totalTasksCompleted ?? 0) > 0 || a.status === 'active');
        if (eligible.length === 0) {
            return { satisfaction: 0.9, inputs: { totalAgents: snap.agents.length, staleAgents: 0 } };
        }
        const hourMs = 3_600_000;
        const stale = eligible.filter(a =>
            snap.now - new Date(a.lastHeartbeat).getTime() > hourMs,
        ).length;
        const satisfaction = clamp01(1 - stale / eligible.length);
        return {
            satisfaction,
            inputs: { totalAgents: eligible.length, staleAgents: stale },
        };
    },
    describe: (_s, inputs) => {
        const total = (inputs?.totalAgents as number) ?? 0;
        const stale = (inputs?.staleAgents as number) ?? 0;
        if (stale === 0) return `${total} agent(s) all alive`;
        return `${stale}/${total} agent(s) unresponsive`;
    },
};

export const DRIVES: DriveDefinition[] = [PURPOSE, HUNGER, CURIOSITY, SAFETY, SOCIAL];

// ── Snapshot builder ─────────────────────────────────────────────

/** Build a DriveSnapshot by reading current TITAN state. Synchronous —
 *  all inputs are in-memory or cheap disk reads. */
export function buildSnapshot(): DriveSnapshot {
    const goals = listGoals();
    let readyTasks: DriveSnapshot['readyTasks'] = [];
    try { readyTasks = getReadyTasks(); } catch { /* empty */ }
    const agents = getRegisteredAgents();
    const budgets = getBudgetPolicies();
    let recentRuns: CPRun[] = [];
    try { recentRuns = listRuns(undefined, 100); } catch { /* empty */ }
    let trajectories: TaskTrajectory[] = [];
    try { trajectories = getRecentTrajectories(100); } catch { /* empty */ }

    // v4.9.0 — pull optional closed-loop signals. Each wrapped in try so
    // drive tick never fails if a downstream module is missing or throws.

    let vramSaturation: number | undefined;
    try {
        const vr = readCachedVRAMSignal();
        if (vr !== null) vramSaturation = vr;
    } catch { /* no signal */ }

    let telemetryErrorRate: number | undefined;
    let telemetryTotalRequests: number | undefined;
    try {
        const metrics = readCachedTelemetrySignal();
        if (metrics) {
            telemetryErrorRate = metrics.errorRate;
            telemetryTotalRequests = metrics.totalRequests;
        }
    } catch { /* no signal */ }

    let unresolvedErrorPatterns: number | undefined;
    try {
        const patterns = readUnresolvedErrorPatternCount();
        if (patterns !== null) unresolvedErrorPatterns = patterns;
    } catch { /* no signal */ }

    return {
        now: Date.now(),
        goals,
        readyTasks,
        recentRuns,
        budgets,
        agents,
        trajectories,
        vramSaturation,
        telemetryErrorRate,
        telemetryTotalRequests,
        unresolvedErrorPatterns,
    };
}

// ── v4.9.0 signal readers ──────────────────────────────────────────

/**
 * Reads the VRAM orchestrator's last cached snapshot (no refresh) and
 * returns used/total saturation as 0–1. Returns null when no GPU is
 * attached or the orchestrator hasn't polled yet.
 *
 * Synchronous: buildSnapshot() is called in the drive-tick hot path
 * every 60s, and we don't want to add an async nvidia-smi probe on
 * top of the existing 10s VRAM refresh.
 */
function readCachedVRAMSignal(): number | null {
    try {
        // Dynamic require-like import from the already-loaded module
        // singleton. If VRAM module hasn't been initialized (e.g., in
        // tests), just return null.
        const mod = (globalThis as unknown as { __titan_vram_last?: { freeMB?: number; totalMB?: number; usedMB?: number } }).__titan_vram_last;
        if (!mod) return null;
        const total = mod.totalMB ?? 0;
        if (!Number.isFinite(total) || total <= 0) return null;
        const used = Number.isFinite(mod.usedMB) ? mod.usedMB! : (total - (mod.freeMB ?? total));
        const pct = used / total;
        if (!Number.isFinite(pct)) return null;
        return Math.max(0, Math.min(1, pct));
    } catch {
        return null;
    }
}

/** Reads the gateway metrics layer's summary (sync, in-memory). */
function readCachedTelemetrySignal(): { errorRate: number; totalRequests: number } | null {
    try {
        // Using require-style resolve so tests that mock the drives
        // module don't pull in the metrics graph.
        const mod = (globalThis as unknown as { __titan_metrics_summary?: () => { totalRequests?: number; errorRate?: number } | null }).__titan_metrics_summary;
        if (typeof mod !== 'function') return null;
        const s = mod();
        if (!s || typeof s.totalRequests !== 'number' || typeof s.errorRate !== 'number') return null;
        // Only treat the signal as meaningful once we have enough samples.
        if (s.totalRequests < 10) return null;
        return { errorRate: s.errorRate, totalRequests: s.totalRequests };
    } catch {
        return null;
    }
}

/** Reads count of unresolved error patterns from the learning layer. */
function readUnresolvedErrorPatternCount(): number | null {
    try {
        const mod = (globalThis as unknown as { __titan_unresolved_error_patterns?: () => number }).__titan_unresolved_error_patterns;
        if (typeof mod !== 'function') return null;
        const n = mod();
        if (typeof n !== 'number' || !Number.isFinite(n)) return null;
        return n;
    } catch {
        return null;
    }
}

// ── Drive state computation ──────────────────────────────────────

/** Compute all drive states for a given snapshot, applying per-drive
 *  setpoint + weight overrides + disabled-drive filter (all from
 *  config.organism.{driveSetpoints,driveWeights,disabledDrives}). */
export function computeAllDrives(
    snapshot: DriveSnapshot,
    setpointOverrides: Partial<Record<DriveId, number>> = {},
    weightOverrides: Partial<Record<DriveId, number>> = {},
    disabledDrives: DriveId[] = [],
): DriveState[] {
    const out: DriveState[] = [];
    const disabled = new Set(disabledDrives);
    for (const def of DRIVES) {
        if (disabled.has(def.id)) continue;
        const { satisfaction, inputs } = def.compute(snapshot);
        const setpoint = setpointOverrides[def.id] ?? def.defaultSetpoint;
        const weight = weightOverrides[def.id] ?? def.weight;
        const pressure = satisfaction < setpoint
            ? (setpoint - satisfaction) * weight
            : 0;
        out.push({
            id: def.id,
            label: def.label,
            satisfaction: clamp01(satisfaction),
            setpoint,
            pressure,
            weight,
            inputs,
            description: def.describe(satisfaction, inputs),
        });
    }
    return out;
}

// ── Persistence ──────────────────────────────────────────────────

export interface PersistedDriveHistory {
    latest: DriveTickResult;
    /** Ring buffer of last ≤1440 ticks (~24h at 60s cadence). */
    history: Array<{ timestamp: string; satisfactions: Record<DriveId, number> }>;
}

/** Load the last-written drive state (if any). Returns null on first run. */
export function loadDriveHistory(): PersistedDriveHistory | null {
    if (!existsSync(DRIVE_STATE_PATH)) return null;
    try {
        return JSON.parse(readFileSync(DRIVE_STATE_PATH, 'utf-8')) as PersistedDriveHistory;
    } catch (err) {
        logger.warn(COMPONENT, `drive-state.json corrupt: ${(err as Error).message}`);
        return null;
    }
}

/** Persist the tick. Ring-buffers history to a max of 1440 entries. */
export function saveDriveTick(tick: DriveTickResult): void {
    try {
        ensureDir(TITAN_HOME);
        const existing = loadDriveHistory();
        const satisfactions: Record<string, number> = {};
        for (const d of tick.drives) satisfactions[d.id] = d.satisfaction;
        const history = (existing?.history || []).concat([{
            timestamp: tick.timestamp,
            satisfactions: satisfactions as Record<DriveId, number>,
        }]);
        const trimmed = history.length > 1440 ? history.slice(-1440) : history;
        const payload: PersistedDriveHistory = { latest: tick, history: trimmed };
        writeFileSync(DRIVE_STATE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `Failed to save drive state: ${(err as Error).message}`);
    }
}

// ── One-call convenience ─────────────────────────────────────────

/** Build snapshot → compute drives → package as a DriveTickResult. Does NOT
 *  persist; callers decide whether to save (daemon tick does; read-only API
 *  endpoints don't). */
export function runDriveTick(
    setpointOverrides: Partial<Record<DriveId, number>> = {},
    weightOverrides: Partial<Record<DriveId, number>> = {},
    disabledDrives: DriveId[] = [],
): DriveTickResult {
    const snapshot = buildSnapshot();
    const drives = computeAllDrives(snapshot, setpointOverrides, weightOverrides, disabledDrives);
    const totalPressure = drives.reduce((sum, d) => sum + d.pressure, 0);
    const dominantDrives = drives
        .filter(d => d.pressure > 0)
        .sort((a, b) => b.pressure - a.pressure)
        .slice(0, 2)
        .map(d => d.id);
    return {
        timestamp: new Date().toISOString(),
        drives,
        totalPressure,
        dominantDrives,
    };
}
