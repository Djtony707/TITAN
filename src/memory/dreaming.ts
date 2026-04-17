/**
 * TITAN — Dreaming Memory (Sleep-Cycle Consolidation)
 * Inspired by OpenClaw's 3-phase dreaming system.
 *
 * Phase 1 (Light Sleep): Score + deduplicate learning entries
 * Phase 2 (REM):         Cross-reference with knowledge graph, synthesize entity summaries
 * Phase 3 (Deep Sleep):  Prune low-quality data, compact graph, write consolidation log
 * Phase 4 (Dream):       Registered agents propose new goals (opt-in via
 *                        config.agent.autoProposeGoals). Proposals go into the
 *                        Command Post approval queue for human review.
 *
 * Triggered by daemon watcher on configurable schedule (default: daily 3am).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Dreaming';
const TITAN_HOME = join(homedir(), '.titan');
const LOG_FILE = join(TITAN_HOME, 'consolidation-log.json');

// ── Types ────────────────────────────────────────────────────────

export interface ConsolidationResult {
    phase: string;
    startedAt: string;
    completedAt: string;
    lightSleep: { entriesScored: number; duplicatesMerged: number; entriesDecayed: number };
    rem: { entitiesSummarized: number; orphansMarked: number };
    deepSleep: { entriesPruned: number; entitiesRemoved: number; edgesRemoved: number };
}

export interface DreamingStatus {
    enabled: boolean;
    lastRun: string | null;
    lastResult: ConsolidationResult | null;
    schedule: string;
    nextRun: string | null;
}

// ── State ────────────────────────────────────────────────────────

let lastResult: ConsolidationResult | null = null;
let lastRunTime: string | null = null;

// ── Jaccard Similarity ───────────────────────────────────────────

function jaccard(a: string, b: string): number {
    const setA = new Set(a.toLowerCase().split(/\s+/));
    const setB = new Set(b.toLowerCase().split(/\s+/));
    let intersection = 0;
    for (const w of setA) { if (setB.has(w)) intersection++; }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}

// ── Main Consolidation Cycle ─────────────────────────────────────

export async function runConsolidation(): Promise<ConsolidationResult> {
    const startedAt = new Date().toISOString();
    logger.info(COMPONENT, 'Starting memory consolidation cycle...');

    const config = loadConfig();
    const dreamConfig = (config.memory as Record<string, unknown>)?.dreaming as Record<string, unknown> | undefined;
    const decayFactor = (dreamConfig?.decayFactor as number) ?? 0.85;
    const prunePercent = (dreamConfig?.prunePercent as number) ?? 0.2;

    // Dynamic imports to avoid circular deps
    const { queryKnowledge, learnFact } = await import('./learning.js');
    const { initGraph, cleanupGraph } = await import('./graph.js');

    // Ensure graph is initialized
    initGraph();

    // ── Phase 1: Light Sleep ─────────────────────────────────
    logger.info(COMPONENT, 'Phase 1: Light Sleep — scoring and deduplication');

    let entriesScored = 0;
    let duplicatesMerged = 0;
    let entriesDecayed = 0;

    // Load knowledge base directly
    const kbPath = join(TITAN_HOME, 'knowledge.json');
    let kb: { entries: Array<{ id: string; type: string; category: string; content: string; score: number; accessCount: number; createdAt: string; updatedAt: string }> } | null = null;
    try {
        if (existsSync(kbPath)) {
            kb = JSON.parse(readFileSync(kbPath, 'utf-8'));
        }
    } catch { /* corrupt file */ }

    if (kb?.entries) {
        const now = Date.now();
        const sevenDays = 7 * 24 * 3600 * 1000;

        // Score and decay
        for (const entry of kb.entries) {
            entriesScored++;
            const age = now - new Date(entry.updatedAt || entry.createdAt).getTime();

            // Decay entries not accessed in 7+ days
            if (age > sevenDays && entry.accessCount < 3) {
                entry.score = Math.max(0.01, entry.score * decayFactor);
                entriesDecayed++;
            }

            // Boost frequently accessed entries
            if (entry.accessCount >= 5) {
                entry.score = Math.min(1.0, entry.score * 1.05);
            }
        }

        // Deduplicate: merge entries with Jaccard similarity > 0.9
        const toRemove = new Set<number>();
        for (let i = 0; i < kb.entries.length; i++) {
            if (toRemove.has(i)) continue;
            for (let j = i + 1; j < kb.entries.length; j++) {
                if (toRemove.has(j)) continue;
                if (kb.entries[i].category !== kb.entries[j].category) continue;
                if (jaccard(kb.entries[i].content, kb.entries[j].content) > 0.9) {
                    // Keep the one with higher score, merge access counts
                    if (kb.entries[i].score >= kb.entries[j].score) {
                        kb.entries[i].accessCount += kb.entries[j].accessCount;
                        toRemove.add(j);
                    } else {
                        kb.entries[j].accessCount += kb.entries[i].accessCount;
                        toRemove.add(i);
                        break;
                    }
                    duplicatesMerged++;
                }
            }
        }
        if (toRemove.size > 0) {
            kb.entries = kb.entries.filter((_, idx) => !toRemove.has(idx));
        }

        logger.info(COMPONENT, `Light Sleep: scored ${entriesScored}, merged ${duplicatesMerged} duplicates, decayed ${entriesDecayed}`);
    }

    // ── Phase 2: REM ─────────────────────────────────────────
    logger.info(COMPONENT, 'Phase 2: REM — entity cross-referencing');

    let entitiesSummarized = 0;
    let orphansMarked = 0;

    // Load graph for cross-referencing
    const graphPath = join(TITAN_HOME, 'graph.json');
    let graph: { entities: Array<{ id: string; name: string; facts: string[]; summary: string; lastSeen: string; type: string }>; edges: Array<{ from: string; to: string }>; episodes: unknown[] } | null = null;
    try {
        if (existsSync(graphPath)) {
            graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
        }
    } catch { /* corrupt */ }

    if (graph?.entities) {
        const edgeSet = new Set<string>();
        for (const e of graph.edges || []) {
            edgeSet.add(e.from);
            edgeSet.add(e.to);
        }

        for (const entity of graph.entities) {
            // Synthesize summary from facts if missing or stale
            if (entity.facts.length > 0 && (!entity.summary || entity.summary.length < 10)) {
                entity.summary = entity.facts.slice(0, 3).join('. ');
                entitiesSummarized++;
            }

            // Mark orphan entities (no edges, no recent episodes)
            if (!edgeSet.has(entity.id)) {
                const lastSeenAge = Date.now() - new Date(entity.lastSeen).getTime();
                if (lastSeenAge > 30 * 24 * 3600 * 1000) { // 30+ days old
                    orphansMarked++;
                }
            }
        }

        logger.info(COMPONENT, `REM: summarized ${entitiesSummarized} entities, marked ${orphansMarked} orphans`);
    }

    // ── Phase 3: Deep Sleep ──────────────────────────────────
    logger.info(COMPONENT, 'Phase 3: Deep Sleep — pruning and compaction');

    let entriesPruned = 0;
    let entitiesRemoved = 0;
    let edgesRemoved = 0;

    // Prune bottom N% of knowledge entries by score
    if (kb?.entries && kb.entries.length > 20) {
        const sorted = [...kb.entries].sort((a, b) => a.score - b.score);
        const cutoff = Math.floor(sorted.length * prunePercent);
        const minScore = sorted[cutoff]?.score ?? 0;

        const before = kb.entries.length;
        kb.entries = kb.entries.filter(e => e.score > minScore || e.accessCount >= 5); // Keep frequently accessed
        entriesPruned = before - kb.entries.length;

        // Save updated knowledge base
        try {
            writeFileSync(kbPath, JSON.stringify(kb, null, 2), 'utf-8');
        } catch (err) {
            logger.error(COMPONENT, `Failed to save knowledge base: ${(err as Error).message}`);
        }
    }

    // Clean up graph (reuses existing cleanupGraph function)
    try {
        const graphResult = cleanupGraph();
        entitiesRemoved = graphResult.removedEntities;
        edgesRemoved = graphResult.removedEdges;
    } catch (err) {
        logger.warn(COMPONENT, `Graph cleanup during deep sleep failed: ${(err as Error).message}`);
    }

    logger.info(COMPONENT, `Deep Sleep: pruned ${entriesPruned} entries, removed ${entitiesRemoved} entities, ${edgesRemoved} edges`);

    // ── Phase 4: Dream (Goal Proposals) ──────────────────────
    // Each registered agent gets a quiet window to propose new work.
    // Opt-in — guarded by config.agent.autoProposeGoals. Failures here never
    // fail the whole consolidation (memory work already landed).
    if (config.agent?.autoProposeGoals) {
        try {
            const { generateGoalProposals, buildDefaultContext } = await import('../agent/goalProposer.js');
            const { getRegisteredAgents } = await import('../agent/commandPost.js');
            const notes = `Consolidation summary: pruned ${entriesPruned} entries, merged ${duplicatesMerged} duplicates, summarized ${entitiesSummarized} entities, marked ${orphansMarked} orphans.`;
            const ctx = { ...buildDefaultContext(), consolidationNotes: notes };
            const agents = getRegisteredAgents();
            logger.info(COMPONENT, `Phase 4: Dream — inviting ${agents.length} registered agent(s) to propose goals`);
            let totalFiled = 0;
            for (const agent of agents) {
                try {
                    const approvals = await generateGoalProposals(agent.id, ctx);
                    totalFiled += approvals.length;
                } catch (err) {
                    logger.warn(COMPONENT, `Agent ${agent.id} proposal generation failed: ${(err as Error).message}`);
                }
            }
            logger.info(COMPONENT, `Dream: ${totalFiled} goal proposal(s) filed for approval`);
        } catch (err) {
            logger.warn(COMPONENT, `Phase 4 (Dream) failed, continuing: ${(err as Error).message}`);
        }
    }

    // ── Write Consolidation Log ──────────────────────────────
    const result: ConsolidationResult = {
        phase: 'completed',
        startedAt,
        completedAt: new Date().toISOString(),
        lightSleep: { entriesScored, duplicatesMerged, entriesDecayed },
        rem: { entitiesSummarized, orphansMarked },
        deepSleep: { entriesPruned, entitiesRemoved, edgesRemoved },
    };

    lastResult = result;
    lastRunTime = result.completedAt;

    // Append to consolidation log
    try {
        const logPath = LOG_FILE;
        let log: ConsolidationResult[] = [];
        if (existsSync(logPath)) {
            try { log = JSON.parse(readFileSync(logPath, 'utf-8')); } catch { log = []; }
        }
        log.push(result);
        // Keep last 30 entries
        if (log.length > 30) log = log.slice(-30);
        writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');
    } catch { /* log write failed, non-critical */ }

    logger.info(COMPONENT, `Consolidation complete: ${entriesPruned + duplicatesMerged} items cleaned, ${entitiesRemoved} entities removed`);
    return result;
}

// ── Status ───────────────────────────────────────────────────────

export function getDreamingStatus(): DreamingStatus {
    const config = loadConfig();
    const dreamConfig = (config.memory as Record<string, unknown>)?.dreaming as Record<string, unknown> | undefined;
    return {
        enabled: (dreamConfig?.enabled as boolean) ?? true,
        lastRun: lastRunTime,
        lastResult,
        schedule: (dreamConfig?.schedule as string) ?? '0 3 * * *',
        nextRun: null, // Could calculate from cron expression
    };
}

// ── History ──────────────────────────────────────────────────────

export function getConsolidationHistory(): ConsolidationResult[] {
    try {
        if (existsSync(LOG_FILE)) {
            return JSON.parse(readFileSync(LOG_FILE, 'utf-8'));
        }
    } catch { /* corrupt */ }
    return [];
}
