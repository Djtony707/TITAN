/**
 * TITAN v8 Slice 4 — Nightly RECOGNIZE Clustering
 *
 * Runs on the autopilot scheduler (mode: "recognize"). Groups successful
 * task trajectories by their task signature (intent + typed entities),
 * scores each cluster by frequency × outcome-stability × success-rate,
 * and surfaces the top clusters as a READ-ONLY compile-queue.
 *
 * This is the "RECOGNIZE" phase — it identifies WHAT patterns exist.
 * Compilation (Slice 5, Forge) turns qualifying clusters into recipes.
 * Routing (Slice 6, Ivy) uses the signatures for the three-way router.
 *
 * Flag-off invariant: when v8 is disabled, this mode is unreachable
 * (autopilot mode enum doesn't include "recognize"). No clustering
 * runs, no files are written, no CPU is consumed.
 *
 * Seams:
 *   - src/agent/taskSignature.ts — task signature extraction
 *   - src/agent/trajectoryLogger.ts — getRecentTrajectories
 *   - src/agent/muscleMemory.ts — mineCandidates (tool-sequence mining)
 *   - src/agent/autopilot.ts — autopilot mode dispatch
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { getRecentTrajectories, type TaskTrajectory } from './trajectoryLogger.js';
import { extractTaskSignature, signTrajectories, computeStability, type TaskSignature, type SignedTrajectory } from './taskSignature.js';
import logger from '../utils/logger.js';

const COMPONENT = 'RecognizeCluster';

/** Where the cluster state is persisted. Resolved at call time so tests
 *  can isolate per-fixture TITAN_HOME (same convention as traceStore.ts). */
function clusterStorePath(): string {
    const envHome = process.env.TITAN_HOME?.trim();
    if (envHome) {
        if (envHome.startsWith('~/')) return join(homedir(), envHome.slice(2), 'recognize-clusters.json');
        if (envHome === '~') return join(homedir(), 'recognize-clusters.json');
        return join(envHome, 'recognize-clusters.json');
    }
    return join(homedir(), '.titan', 'recognize-clusters.json');
}

/** Minimum trajectories in a cluster before it qualifies. */
const MIN_CLUSTER_SIZE = 5;

/** Minimum success rate for a cluster to qualify (0.0–1.0). */
const MIN_SUCCESS_RATE = 0.7;

/** Minimum stability for a cluster to qualify (0.0–1.0). */
const MIN_STABILITY = 0.5;

/** Maximum clusters to surface in the compile queue. */
const MAX_QUEUE_SIZE = 20;

// ── Types ───────────────────────────────────────────────────────────

/** A scored cluster of task trajectories sharing the same signature. */
export interface TaskCluster {
    /** The canonical task signature. */
    signature: TaskSignature;
    /** Number of trajectories in this cluster. */
    frequency: number;
    /** Fraction of trajectories that succeeded (0.0–1.0). */
    successRate: number;
    /** Fraction of trajectories sharing the same tool sequence (0.0–1.0). */
    outcomeStability: number;
    /** Composite score: frequency × stability × successRate. */
    score: number;
    /** The dominant tool sequence (most common). */
    dominantToolSequence: string[];
    /** Example task texts (up to 3). */
    examples: string[];
    /** When this cluster was first seen. */
    firstSeen: string;
    /** When this cluster was last updated. */
    lastUpdated: string;
    /** Whether this cluster is new since the last clustering run. */
    isNew: boolean;
}

/** The persisted cluster store. */
export interface ClusterStore {
    /** All known clusters, keyed by signature hash. */
    clusters: Record<string, TaskCluster>;
    /** When the last clustering run completed. */
    lastRunAt: string | null;
    /** Total trajectories processed in the last run. */
    lastTrajectoryCount: number;
    /** Total clusters found in the last run. */
    lastClusterCount: number;
}

// ── Persistence ─────────────────────────────────────────────────────

function readClusterStore(): ClusterStore {
    try {
        const path = clusterStorePath();
        if (existsSync(path)) {
            return JSON.parse(readFileSync(path, 'utf-8')) as ClusterStore;
        }
    } catch (e) {
        logger.warn(COMPONENT, `Cluster store unreadable, starting fresh: ${(e as Error).message}`);
    }
    return { clusters: {}, lastRunAt: null, lastTrajectoryCount: 0, lastClusterCount: 0 };
}

function writeClusterStore(store: ClusterStore): void {
    const path = clusterStorePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2));
}

// ── Clustering ──────────────────────────────────────────────────────

/**
 * Group signed trajectories by their signature hash.
 */
function groupBySignature(signed: SignedTrajectory[]): Map<string, SignedTrajectory[]> {
    const groups = new Map<string, SignedTrajectory[]>();
    for (const t of signed) {
        const key = t.signature.hash;
        const group = groups.get(key) || [];
        group.push(t);
        groups.set(key, group);
    }
    return groups;
}

/**
 * Score a group of trajectories sharing the same signature.
 * score = frequency × outcomeStability × successRate
 *
 * This rewards clusters that are:
 *   - Frequent (happens a lot)
 *   - Stable (same tool sequence reliably solves it)
 *   - Successful (high success rate)
 */
function scoreCluster(group: SignedTrajectory[]): TaskCluster {
    const frequency = group.length;
    const successes = group.filter(t => t.success);
    const successCount = successes.length;
    const successRate = successCount / frequency;
    const stability = computeStability(successes);
    const score = frequency * stability * successRate;

    // Find the dominant tool sequence. Computed over SUCCESSFUL trajectories
    // only — same population as outcomeStability above. If this counted
    // the whole group (successes + failures), a sequence that mostly fails
    // could still "win" by raw occurrence count and get published as the
    // cluster's recommended workflow.
    const seqCounts = new Map<string, string[]>();
    for (const t of successes) {
        const key = t.toolSequence.join(' → ');
        if (!seqCounts.has(key)) seqCounts.set(key, t.toolSequence);
    }
    let dominantSeq: string[] = [];
    let maxCount = 0;
    for (const [key, seq] of seqCounts) {
        const count = successes.filter(t => t.toolSequence.join(' → ') === key).length;
        if (count > maxCount) { maxCount = count; dominantSeq = seq; }
    }
    
    // Pick up to 3 example tasks
    const examples = group.slice(0, 3).map(t => t.task.slice(0, 200));
    
    const timestamps = group.map(t => {
        // We don't have timestamps on SignedTrajectory, so use now
        return Date.now();
    });
    const firstSeen = new Date(Math.min(...timestamps)).toISOString();
    const lastUpdated = new Date(Math.max(...timestamps)).toISOString();
    
    return {
        signature: group[0].signature,
        frequency,
        successRate: Math.round(successRate * 100) / 100,
        outcomeStability: Math.round(stability * 100) / 100,
        score: Math.round(score * 100) / 100,
        dominantToolSequence: dominantSeq,
        examples,
        firstSeen,
        lastUpdated,
        isNew: false,
    };
}

/**
 * Run one clustering pass over recent trajectories.
 * Returns the top clusters sorted by score descending.
 */
export function runClustering(
    trajectoryLimit: number = 500,
): { clusters: TaskCluster[]; trajectoryCount: number } {
    const trajectories = getRecentTrajectories(trajectoryLimit);
    if (trajectories.length === 0) {
        return { clusters: [], trajectoryCount: 0 };
    }
    
    // INVARIANT: a cluster candidate must have made at least one tool call.
    // Tool-less chat trajectories all share toolSequence [], which makes
    // them look like a single "cluster" with stability=1.0 and a perfect
    // successRate — a bogus compile candidate with nothing to compile
    // (dominantToolSequence: []). Excluded here, before grouping, so no
    // empty-toolSequence cluster can ever reach the scoring/queue stage.
    const eligible = trajectories.filter(t => t.toolSequence.length > 0);

    // Convert to the shape signTrajectories expects
    const shaped = eligible.map(t => ({
        id: t.id,
        task: t.task,
        success: t.success,
        durationMs: t.durationMs,
        rounds: t.rounds,
        toolSequence: t.toolSequence,
    }));
    
    const signed = signTrajectories(shaped);
    const groups = groupBySignature(signed);
    
    const clusters: TaskCluster[] = [];
    for (const [, group] of groups) {
        if (group.length < MIN_CLUSTER_SIZE) continue;
        const cluster = scoreCluster(group);
        if (cluster.successRate < MIN_SUCCESS_RATE) continue;
        if (cluster.outcomeStability < MIN_STABILITY) continue;
        clusters.push(cluster);
    }
    
    clusters.sort((a, b) => b.score - a.score);
    
    return {
        clusters: clusters.slice(0, MAX_QUEUE_SIZE),
        trajectoryCount: trajectories.length,
    };
}

/**
 * Run the nightly clustering pass and persist results.
 * Called from autopilot when mode === "recognize".
 */
export function runNightlyClustering(): { 
    clusters: TaskCluster[]; 
    newClusters: TaskCluster[];
    trajectoryCount: number;
} {
    const store = readClusterStore();
    const prevHashes = new Set(Object.keys(store.clusters));
    
    const { clusters, trajectoryCount } = runClustering(500);
    
    const newClusters: TaskCluster[] = [];
    const updated: Record<string, TaskCluster> = {};
    
    for (const cluster of clusters) {
        const hash = cluster.signature.hash;
        const existing = store.clusters[hash];
        if (existing) {
            // Merge: keep the original firstSeen, update the rest
            cluster.firstSeen = existing.firstSeen;
            cluster.isNew = false;
        } else {
            cluster.isNew = true;
            newClusters.push(cluster);
        }
        updated[hash] = cluster;
    }
    
    // Keep clusters that didn't appear in this run but were previously known
    // (they may reappear later — don't lose them)
    for (const [hash, cluster] of Object.entries(store.clusters)) {
        if (!updated[hash]) {
            updated[hash] = cluster;
        }
    }
    
    store.clusters = updated;
    store.lastRunAt = new Date().toISOString();
    store.lastTrajectoryCount = trajectoryCount;
    store.lastClusterCount = clusters.length;
    writeClusterStore(store);
    
    logger.info(COMPONENT, 
        `Clustering complete: ${clusters.length} clusters from ${trajectoryCount} trajectories, ${newClusters.length} new`);
    
    return { clusters, newClusters, trajectoryCount };
}

/**
 * Get the current compile queue (top clusters, read-only).
 * This is the data source for the dashboard panel.
 */
export function getCompileQueue(): TaskCluster[] {
    const store = readClusterStore();
    return Object.values(store.clusters)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_QUEUE_SIZE);
}

/**
 * Get clustering statistics for the dashboard.
 */
export function getClusterStats(): {
    totalClusters: number;
    totalTrajectories: number;
    lastRunAt: string | null;
    topCluster: TaskCluster | null;
} {
    const store = readClusterStore();
    const sorted = Object.values(store.clusters).sort((a, b) => b.score - a.score);
    return {
        totalClusters: sorted.length,
        totalTrajectories: store.lastTrajectoryCount,
        lastRunAt: store.lastRunAt,
        topCluster: sorted[0] || null,
    };
}
