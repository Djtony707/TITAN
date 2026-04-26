/**
 * TITAN — Mission Driver (v4.10.0-local, Phase C)
 *
 * A "driver of drivers" for multi-goal projects. When Tony says
 * "build me a GPU-temp widget," that's a MISSION. The mission driver:
 *   1. Plans: decompose into child goals (research + design + implement + deploy)
 *   2. Creates each child as a proper Goal with parentGoalId linking back
 *   3. Waits for each child's goalDriver to finish
 *   4. Aggregates artifacts into a mission report
 *   5. Reports completion back to Tony
 *
 * State persisted to ~/.titan/mission-state/<missionId>.json. Restart-safe.
 *
 * Mission vs Goal: a mission has 2+ top-level child goals that need
 * coordination. A single-goal "mission" just passes through to goalDriver.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';

const COMPONENT = 'MissionDriver';
const STATE_DIR = join(TITAN_HOME, 'mission-state');

// ── Types ────────────────────────────────────────────────────────

export type MissionPhase =
    | 'planning'    // decomposing into child goals
    | 'executing'   // child drivers running
    | 'aggregating' // all children done → collecting artifacts
    | 'reporting'   // writing final mission report
    | 'blocked'     // a child is blocked AND the mission can't proceed without it
    | 'done'
    | 'failed'
    | 'cancelled';

export interface ChildGoal {
    goalId: string;
    title: string;
    dependsOn?: string[]; // other child goal IDs
    status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
}

export interface MissionState {
    schemaVersion: 1;
    missionId: string;
    title: string;
    description: string;
    phase: MissionPhase;
    startedAt: string;
    lastTickAt: string;
    requestedBy: string;
    children: ChildGoal[];
    artifacts: Array<{ goalId: string; type: string; ref: string; description?: string }>;
    history: Array<{ at: string; phase: MissionPhase; note: string }>;
    finalReport?: string;
    tags: string[];
}

// ── Storage ──────────────────────────────────────────────────────

function ensureDir(): void {
    try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ok */ }
}

function missionPath(id: string): string {
    return join(STATE_DIR, `${id}.json`);
}

function loadMission(id: string): MissionState | null {
    const p = missionPath(id);
    if (!existsSync(p)) return null;
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf-8')) as MissionState;
        if (parsed.schemaVersion !== 1) return null;
        return parsed;
    } catch { return null; }
}

function saveMission(s: MissionState): void {
    ensureDir();
    s.lastTickAt = new Date().toISOString();
    const p = missionPath(s.missionId);
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p + '.tmp', JSON.stringify(s, null, 2));
        renameSync(p + '.tmp', p);
    } catch (err) {
        logger.warn(COMPONENT, `Persist mission ${s.missionId} failed: ${(err as Error).message}`);
    }
}

function appendHistory(s: MissionState, phase: MissionPhase, note: string): void {
    s.history.push({ at: new Date().toISOString(), phase, note });
    if (s.history.length > 200) s.history = s.history.slice(-200);
}

// ── Phase transitions ────────────────────────────────────────────

async function tickPlanning(s: MissionState): Promise<void> {
    // If children are already defined (caller provided them), skip decomposition.
    if (s.children.length > 0) {
        s.phase = 'executing';
        appendHistory(s, 'executing', `Mission has ${s.children.length} pre-defined child goals`);
        return;
    }

    // Simple heuristic decomposition — full LLM decomposition happens in
    // orchestrator.ts's analyzeForDelegation. For Phase C we keep missions
    // simple: if the requester didn't provide children, we treat the
    // mission as a single-goal passthrough.
    //
    // A richer decomposition is easy to layer on in Phase D (playbooks)
    // via: "does a playbook match this title? use that template's children."
    try {
        const { createGoal } = await import('./goals.js');
        const goal = createGoal({
            title: s.title,
            description: s.description,
            tags: ['mission-auto', ...s.tags],
        });
        s.children.push({
            goalId: goal.id,
            title: goal.title,
            status: 'pending',
        });
        s.phase = 'executing';
        appendHistory(s, 'executing', `No child decomposition provided — created single-goal passthrough ${goal.id}`);
    } catch (err) {
        s.phase = 'failed';
        appendHistory(s, 'failed', `Planning failed: ${(err as Error).message}`);
    }
}

async function tickExecuting(s: MissionState): Promise<void> {
    try {
        const { getGoal } = await import('./goals.js');
        const { getDriverState } = await import('./goalDriver.js');
        let anyPending = false;
        let anyFailed = false;
        for (const child of s.children) {
            const goal = getGoal(child.goalId);
            const driver = getDriverState(child.goalId);
            if (!goal) {
                child.status = 'skipped';
                continue;
            }
            // Respect dependsOn — skip children whose deps aren't done
            if (child.dependsOn && child.dependsOn.length > 0) {
                const depsDone = child.dependsOn.every(depId => {
                    const depChild = s.children.find(c => c.goalId === depId);
                    return depChild?.status === 'done';
                });
                if (!depsDone) {
                    child.status = 'pending';
                    anyPending = true;
                    continue;
                }
            }
            // Reflect goal state
            if (goal.status === 'completed' || driver?.phase === 'done') {
                child.status = 'done';
                // Pull artifacts
                if (driver) {
                    for (const sub of Object.values(driver.subtaskStates)) {
                        for (const artRef of sub.artifacts) {
                            if (!s.artifacts.find(a => a.ref === artRef && a.goalId === child.goalId)) {
                                s.artifacts.push({
                                    goalId: child.goalId,
                                    type: 'file',
                                    ref: artRef,
                                });
                            }
                        }
                    }
                }
            } else if (goal.status === 'failed' || driver?.phase === 'failed') {
                child.status = 'failed';
                anyFailed = true;
            } else if (driver?.phase === 'blocked') {
                child.status = 'in_progress';
                anyPending = true;
                // Mission-level block is surfaced in aggregating if nothing else to do
            } else {
                child.status = 'in_progress';
                anyPending = true;
            }
        }
        if (!anyPending) {
            s.phase = anyFailed ? 'aggregating' : 'aggregating';
            appendHistory(s, 'aggregating', `All children resolved (${s.children.length}), aggregating`);
        }
    } catch (err) {
        logger.warn(COMPONENT, `tickExecuting error: ${(err as Error).message}`);
    }
}

async function tickAggregating(s: MissionState): Promise<void> {
    const failed = s.children.filter(c => c.status === 'failed');
    if (failed.length > 0 && failed.length === s.children.length) {
        s.phase = 'failed';
        appendHistory(s, 'failed', `All ${s.children.length} child goals failed`);
        return;
    }
    s.phase = 'reporting';
    appendHistory(s, 'reporting', `Aggregated artifacts from ${s.children.length} children (${failed.length} failed)`);
}

async function tickReporting(s: MissionState): Promise<void> {
    const doneChildren = s.children.filter(c => c.status === 'done');
    const failedChildren = s.children.filter(c => c.status === 'failed');
    const lines: string[] = [
        `# Mission: ${s.title}`,
        ``,
        `**Status**: ${failedChildren.length === 0 ? 'Completed' : failedChildren.length === s.children.length ? 'Failed' : 'Partial'}`,
        `**Duration**: ${Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000)}s`,
        `**Children**: ${doneChildren.length} done / ${failedChildren.length} failed / ${s.children.length} total`,
        ``,
        `## Child Goals`,
        ...s.children.map(c => `- ${c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '○'} ${c.title} (${c.goalId})`),
        ``,
        `## Artifacts (${s.artifacts.length})`,
        ...s.artifacts.slice(0, 20).map(a => `- ${a.goalId}: ${a.ref}`),
    ];
    s.finalReport = lines.join('\n');
    s.phase = failedChildren.length === s.children.length ? 'failed' : 'done';
    appendHistory(s, s.phase, `Mission ${s.phase === 'done' ? 'completed' : 'failed'}`);

    try {
        const { recordEpisode } = await import('../memory/episodic.js');
        recordEpisode({
            kind: s.phase === 'done' ? 'goal_completed' : 'goal_failed',
            summary: `Mission "${s.title}" ${s.phase === 'done' ? 'completed' : 'failed'} (${doneChildren.length}/${s.children.length} children done)`,
            detail: s.finalReport,
            tags: ['mission', ...s.tags, s.missionId],
        });
    } catch { /* ok */ }
}

// ── Main entry ───────────────────────────────────────────────────

export async function tickMission(missionId: string): Promise<MissionPhase> {
    const state = loadMission(missionId);
    if (!state) return 'failed';

    try {
        switch (state.phase) {
            case 'planning':    await tickPlanning(state); break;
            case 'executing':   await tickExecuting(state); break;
            case 'aggregating': await tickAggregating(state); break;
            case 'reporting':   await tickReporting(state); break;
            case 'blocked':
            case 'done':
            case 'failed':
            case 'cancelled':
                break;
        }
    } catch (err) {
        appendHistory(state, state.phase, `Tick error: ${(err as Error).message.slice(0, 120)}`);
    }
    saveMission(state);
    return state.phase;
}

export function createMission(opts: {
    title: string;
    description: string;
    requestedBy: string;
    children?: Array<{ goalId: string; title: string; dependsOn?: string[] }>;
    tags?: string[];
}): MissionState {
    const missionId = `mis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const state: MissionState = {
        schemaVersion: 1,
        missionId,
        title: opts.title,
        description: opts.description,
        phase: 'planning',
        startedAt: now,
        lastTickAt: now,
        requestedBy: opts.requestedBy,
        children: (opts.children || []).map(c => ({
            goalId: c.goalId,
            title: c.title,
            dependsOn: c.dependsOn,
            status: 'pending',
        })),
        artifacts: [],
        history: [{ at: now, phase: 'planning', note: `Mission created by ${opts.requestedBy}` }],
        tags: opts.tags || [],
    };
    saveMission(state);
    logger.info(COMPONENT, `Created mission ${missionId}: "${opts.title}" with ${state.children.length} children`);
    return state;
}

export function getMissionState(id: string): MissionState | null {
    return loadMission(id);
}

export function listActiveMissions(): MissionState[] {
    ensureDir();
    if (!existsSync(STATE_DIR)) return [];
    const out: MissionState[] = [];
    for (const file of readdirSync(STATE_DIR)) {
        if (!file.endsWith('.json')) continue;
        const m = loadMission(file.slice(0, -5));
        if (m && !['done', 'failed', 'cancelled'].includes(m.phase)) out.push(m);
    }
    return out;
}

export function cancelMission(id: string): boolean {
    const s = loadMission(id);
    if (!s) return false;
    s.phase = 'cancelled';
    appendHistory(s, 'cancelled', 'User-requested cancellation');
    saveMission(s);
    return true;
}

export function _resetMissionStateForTests(): void {
    try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}
