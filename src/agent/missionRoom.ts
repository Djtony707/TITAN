/**
 * TITAN — Mission Room (v6.1.0 "Mission Chat")
 *
 * The mission room is the data + event surface behind the chat-style
 * Mission Canvas UI. Each mission is a single goal with a team of
 * specialists, a live artifact buffer, and a chronological message log.
 *
 * Design notes:
 *   - One mission = one Goal in the existing goal driver, plus this
 *     room's metadata (team composition, artifact, messages). The room
 *     is the user-facing presentation layer; the goal driver does the
 *     actual work.
 *   - Persisted to disk so a server restart preserves in-flight missions.
 *     One JSON file per mission under MISSIONS_DIR (with .tmp+rename
 *     for atomicity, matching driver-state's convention).
 *   - Emits typed events to subscribers. The gateway adapts those into
 *     SSE frames for browser clients; tests can attach a sink listener.
 *   - No LLM calls live here — this module is pure state. Anything that
 *     needs a model call (e.g. choosing a team for an ambiguous goal)
 *     calls Plays first, falls through to a planner caller, and feeds
 *     the result back via setTeam().
 *
 * Schema is versioned (v1). Future schema changes go through a
 * migration step rather than mutating existing files in place.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { MISSIONS_DIR } from '../utils/constants.js';
import { shortId } from '../utils/helpers.js';

const COMPONENT = 'MissionRoom';
const SCHEMA_VERSION = 1;

// ── Types ──────────────────────────────────────────────────────────

export type MissionStatus = 'forming' | 'working' | 'paused' | 'blocked' | 'done' | 'failed';
export type MemberState = 'idle' | 'working' | 'editing' | 'blocked' | 'done';

/** A specialist on this mission, with their live state. */
export interface MissionMember {
    /** Canonical specialist id from SPECIALISTS (scout, builder, …). */
    agentId: string;
    /** Display name (Scout). */
    name: string;
    /** Friendly one-line role label ("the researcher"). */
    role: string;
    /** Hex color for UI tinting. */
    color: string;
    /** Current state shown in the team strip. */
    state: MemberState;
    /** What they're doing right now, in plain English. */
    currentActivity?: string;
    /** When they last did something visible. */
    lastActiveAt?: string;
    /**
     * v6.1.0-alpha.19 — per-agent model override. When set, the goal
     * driver should pick this model instead of the specialist's
     * default for any spawn delegated to this agent. Null/undefined =
     * use the specialist's default (resolveSpecialistModel).
     *
     * The consumer wiring (spawn-side model resolution) is on the
     * v6.1.0-alpha.20+ roadmap — this ship stores the preference so
     * the AgentMenu UI works end-to-end and the value survives mission
     * reloads.
     */
    modelOverride?: string;
    /**
     * v6.1.0-alpha.19 — user-paused this specific agent. The goal
     * driver should skip delegating to a paused agent. UI surfaces it
     * as a paused-state pill on the agent's card.
     *
     * Same pattern as `modelOverride` — stored now, consumer wiring
     * lands with the marathon-mode daemon next ship.
     */
    paused?: boolean;
    /**
     * v6.1.0-alpha.31 — rolling activity log per agent. Each entry is
     * a snippet of what the agent was doing (typically a tool call:
     * "searched: MLK 1963", "fetched: nytimes.com/...", "wrote: …").
     * The Mission Canvas renders these as live sticky notes on the
     * wood desk so the user sees research accumulate in real time
     * even before the agent's final agent_done event fires.
     *
     * Capped at 8 most recent entries per agent at write time so the
     * mission JSON file stays bounded.
     */
    activityLog?: Array<{ at: string; icon: string; activity: string; detail?: string }>;
}

/** One row in the chat thread. */
export type MissionMessage =
    | UserMessage
    | AgentMessage
    | SystemMessage
    | QuestionMessage
    | ArtifactUpdateMessage;

interface MessageBase {
    id: string;
    at: string; // ISO8601
    kind: string;
}
export interface UserMessage extends MessageBase {
    kind: 'user';
    content: string;
}
export interface AgentMessage extends MessageBase {
    kind: 'agent';
    from: { agentId: string; name: string; role: string; color: string };
    content: string;
    /** Lightweight "what I touched" chips, shown under the message. */
    actions?: { name: string; detail?: string }[];
    /**
     * v6.1.0-alpha.12 — concrete artifacts the specialist worked
     * with: URLs visited, files written, facts memorized, reports
     * produced. Rendered in the chat as clickable links (for URLs)
     * or file chips so the user can actually inspect what the team
     * found, not just read a summary.
     */
    sources?: Array<{
        type: 'url' | 'file' | 'fact' | 'report';
        ref: string;
        description?: string;
    }>;
    /**
     * v6.1.0-alpha.4 — optional rich context shown when the user clicks
     * the bubble. Lets a user see WHAT subtask the agent was working on,
     * HOW long it took, HOW much it cost, WHAT model produced it — without
     * polluting the chat thread with that detail by default.
     */
    meta?: {
        /** The subtask title this message came out of. */
        subtaskTitle?: string;
        /** done / failed / needs_info / blocked / cancelled / etc. */
        status?: string;
        /** Wall-clock duration of the underlying specialist spawn. */
        durationMs?: number;
        /** Tokens consumed in this spawn (prompt + completion combined). */
        tokensUsed?: number;
        /** USD spent on this spawn. */
        costUsd?: number;
        /** Which model actually answered (provider/model id when known). */
        model?: string;
        /**
         * v6.1.0-alpha.7 — the raw failure-detail string when the
         * bridge scrubbed an internal-error trace from the chat-visible
         * `content`. Surfaced via click-to-expand for power users.
         */
        failureDetail?: string;
    };
}
export interface SystemMessage extends MessageBase {
    kind: 'system';
    content: string;
    /** Optional category tag for styling (team_formed, paused, resumed, etc). */
    tag?: string;
}
export interface QuestionMessage extends MessageBase {
    kind: 'question';
    from: { agentId: string; name: string; role: string; color: string };
    content: string;
    /** The approval ID this question maps to. Resolving the approval marks
     *  the question as answered. */
    approvalId: string;
    /** Suggested replies as inline buttons. */
    quickReplies: string[];
    /** Filled in when the user answers. */
    answer?: { content: string; at: string };
}
export interface ArtifactUpdateMessage extends MessageBase {
    kind: 'artifact_update';
    /** Which agent caused the update. */
    by: { agentId: string; name: string };
    /** Short human summary ("added paragraph 3"). */
    summary: string;
    /** Word count after the update — for the small status line. */
    wordCount: number;
}

/** Snapshot of the live document so users can rewind. */
export interface ArtifactSnapshot {
    at: string;
    content: string;
    by: string; // agentId
    summary: string;
    wordCount: number;
}

/** What's being built. For v1 the artifact is markdown text — code/code-diff
 *  shapes will land later via a `format` discriminator. */
export interface MissionArtifact {
    /** 'markdown' for v1. Future: 'code', 'code-diff', 'json-report'. */
    format: 'markdown';
    /** Current live content. */
    content: string;
    /** Last 16 snapshots — keeps rewind cheap and the file bounded. */
    snapshots: ArtifactSnapshot[];
    /** Last update timestamp. */
    updatedAt: string;
}

export interface MissionCost {
    tokens: number;
    usd: number;
}

export interface MissionRoom {
    schemaVersion: typeof SCHEMA_VERSION;
    id: string;
    /** The user's original goal text. */
    goal: string;
    status: MissionStatus;
    /** Which Play (template) this mission used, if any. */
    playId?: string;
    /** Linked Goal id in the existing goal driver. Set after team formation. */
    goalId?: string;
    /**
     * v6.1.0-alpha.10 — linked Command Post issue id. Every mission
     * auto-creates an issue (createIssue) on start so the chat thread
     * and the Command Post Issues panel both surface the same record.
     * Key lifecycle events (team formed, question raised, question
     * answered, mission complete / failed) post as issue comments so
     * the issue becomes the durable audit trail.
     */
    issueId?: string;
    /** Owner — which user account opened this mission. Single-user installs
     *  can leave it empty; multi-user installs must scope reads by this. */
    ownerId?: string;
    team: MissionMember[];
    artifact: MissionArtifact;
    messages: MissionMessage[];
    cost: MissionCost;
    /**
     * v6.1.0-alpha.19 — "Marathon mode" — when enabled, the (future)
     * long-running orchestrator drives the team continuously toward
     * the mission goal for up to 72 hours, with cost / time caps and
     * automatic recovery. The autonomous-collaboration daemon that
     * actually CONSUMES this flag lands in v6.1.0-alpha.20+ alongside
     * the recurring-mission daemon — see HANDOFF-2026-05-13.md.
     *
     * Storing it now means the UX (the toggle on the canvas, the
     * status pill in the top bar) works end-to-end and the choice
     * survives mission reloads, so when the daemon lands the existing
     * marathon missions immediately start running.
     */
    longRunningMode?: boolean;
    createdAt: string;
    updatedAt: string;
}

// ── Default member metadata (friendly labels) ──────────────────────
//
// These taglines + colors are what the chat thread shows. They live
// here (not in specialists.ts) because they're presentation, not
// behavior. The specialist registry stays authoritative for behavior.

const MEMBER_META: Record<string, { role: string; color: string }> = {
    scout:   { role: 'the researcher',    color: '#6ea8ff' },
    builder: { role: 'the writer',        color: '#ff9a4a' }, // mockup-friendly: in code-missions Builder writes code
    writer:  { role: 'the wordsmith',     color: '#ff9a4a' },
    analyst: { role: 'the numbers nerd',  color: '#4adbb5' },
    sage:    { role: 'the skeptic',       color: '#ff5d6c' },
    driver:  { role: 'the orchestrator',  color: '#7c3aed' }, // v6.1.0-alpha.42 — system-level driver actor (Bug #4)
    default: { role: 'the generalist',    color: '#b07cff' },
};

/** Lookup display metadata for an agent id, with a friendly fallback. */
export function memberMetaFor(agentId: string): { role: string; color: string } {
    return MEMBER_META[agentId] ?? MEMBER_META.default;
}

// ── Event bus ──────────────────────────────────────────────────────
//
// Subscribers (the SSE bridge in the gateway, the SubAgent watcher,
// test sinks) listen to typed events. The bus is process-local — there's
// one shared emitter for the whole TITAN runtime.

export type MissionEventKind =
    | 'mission_created'
    | 'team_formed'
    | 'message_added'
    | 'agent_state_changed'
    | 'artifact_updated'
    | 'question_raised'
    | 'question_answered'
    | 'status_changed'
    | 'cost_changed'
    | 'mission_deleted';

export interface MissionEvent {
    kind: MissionEventKind;
    missionId: string;
    at: string;
    /** Event-specific payload. */
    data?: Record<string, unknown>;
}

const bus = new EventEmitter();
// We expect O(connected SSE clients) listeners — Node defaults to 10
// which trips a warning on healthy multi-tab installs. 256 is generous.
bus.setMaxListeners(256);

/** Subscribe to all mission events. Returns an unsubscribe function. */
export function onMissionEvent(handler: (ev: MissionEvent) => void): () => void {
    const wrapped = (ev: MissionEvent) => {
        try { handler(ev); }
        catch (err) { logger.warn(COMPONENT, `Mission event handler threw: ${(err as Error).message}`); }
    };
    bus.on('mission', wrapped);
    return () => bus.off('mission', wrapped);
}

function emit(kind: MissionEventKind, missionId: string, data?: Record<string, unknown>): void {
    const ev: MissionEvent = { kind, missionId, at: new Date().toISOString(), data };
    bus.emit('mission', ev);
}

// ── Persistence ────────────────────────────────────────────────────

function ensureDir(): void {
    try { mkdirSync(MISSIONS_DIR, { recursive: true }); } catch { /* ok */ }
}

function missionPath(id: string): string {
    return join(MISSIONS_DIR, `${id}.json`);
}

function saveRoom(room: MissionRoom): void {
    ensureDir();
    room.updatedAt = new Date().toISOString();
    const path = missionPath(room.id);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path + '.tmp', JSON.stringify(room, null, 2));
        renameSync(path + '.tmp', path);
    } catch (err) {
        logger.warn(COMPONENT, `Persist mission ${room.id} failed: ${(err as Error).message}`);
    }
}

function loadRoomFromDisk(id: string): MissionRoom | null {
    const path = missionPath(id);
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as MissionRoom;
        if (parsed.schemaVersion !== SCHEMA_VERSION) {
            logger.warn(COMPONENT, `Mission ${id} has unknown schemaVersion=${parsed.schemaVersion} — ignoring`);
            return null;
        }
        return parsed;
    } catch (err) {
        logger.warn(COMPONENT, `Could not parse mission ${id}: ${(err as Error).message}`);
        return null;
    }
}

// In-memory cache so repeated reads on the same tick don't re-parse JSON.
const cache = new Map<string, MissionRoom>();

function getOrLoad(id: string): MissionRoom | null {
    const cached = cache.get(id);
    if (cached) return cached;
    const fresh = loadRoomFromDisk(id);
    if (fresh) cache.set(id, fresh);
    return fresh;
}

function commit(room: MissionRoom): MissionRoom {
    cache.set(room.id, room);
    saveRoom(room);
    return room;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Create a new mission room. `members` is the initial team — Plays
 * usually fills this in; for ad-hoc missions the caller can pass an
 * empty array and call setTeam() once the planner decides.
 */
export function createMission(opts: {
    goal: string;
    members?: Array<{ agentId: string; name: string }>;
    playId?: string;
    ownerId?: string;
}): MissionRoom {
    const id = shortId();
    const now = new Date().toISOString();
    const team: MissionMember[] = (opts.members ?? []).map(m => {
        const meta = memberMetaFor(m.agentId);
        return {
            agentId: m.agentId,
            name: m.name,
            role: meta.role,
            color: meta.color,
            state: 'idle',
        };
    });
    const room: MissionRoom = {
        schemaVersion: SCHEMA_VERSION,
        id,
        goal: opts.goal,
        status: team.length > 0 ? 'working' : 'forming',
        playId: opts.playId,
        ownerId: opts.ownerId,
        team,
        artifact: {
            format: 'markdown',
            content: '',
            snapshots: [],
            updatedAt: now,
        },
        messages: [
            // Always seed with the user's mission as the first message.
            {
                id: shortId(),
                at: now,
                kind: 'user',
                content: opts.goal,
            } as UserMessage,
        ],
        cost: { tokens: 0, usd: 0 },
        createdAt: now,
        updatedAt: now,
    };

    // If we already have a team, post the "team formed" system note so the
    // chat reads naturally without a transition gap.
    if (team.length > 0) {
        const names = team.map(t => t.name).join(', ');
        room.messages.push({
            id: shortId(),
            at: now,
            kind: 'system',
            tag: 'team_formed',
            content: `Team formed — ${names}.`,
        } as SystemMessage);
    }

    commit(room);
    emit('mission_created', id, { goal: opts.goal, playId: opts.playId });
    if (team.length > 0) emit('team_formed', id, { team: team.map(t => t.agentId) });
    return room;
}

/** Get a mission, refreshing from disk if not cached. */
export function getMission(id: string): MissionRoom | null {
    return getOrLoad(id);
}

/**
 * v6.1.0-alpha.1 — look up a mission by its linked goalId. Used by the
 * lifecycle bridge to translate "this specialist event came in for goal
 * X" into "post this in mission room Y". Iterates all on-disk missions;
 * fine for the small-N case (single-user installs typically have <10
 * active missions at once). If we ever have thousands, swap to an index.
 */
export function getMissionByGoalId(goalId: string): MissionRoom | null {
    ensureDir();
    let entries: string[];
    try { entries = readdirSync(MISSIONS_DIR).filter(f => f.endsWith('.json')); }
    catch { return null; }
    for (const f of entries) {
        const id = f.slice(0, -5);
        const room = getOrLoad(id);
        if (room?.goalId === goalId) return room;
    }
    return null;
}

/**
 * v6.1.0-alpha.1 — ensure a team member exists. The Plays library
 * predicts the team, but the goal driver routes each subtask to
 * whichever specialist fits — sometimes a different one. When the
 * lifecycle bridge sees an event for an agent not on the team, we
 * add them rather than silently dropping the activity.
 */
export function ensureMember(missionId: string, agentId: string, name?: string): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    if (room.team.some(m => m.agentId === agentId)) return room;
    const meta = memberMetaFor(agentId);
    const displayName = name ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
    room.team.push({
        agentId,
        name: displayName,
        role: meta.role,
        color: meta.color,
        state: 'idle',
    });
    // Post a small system note so the user sees the team expanded.
    room.messages.push({
        id: shortId(),
        at: new Date().toISOString(),
        kind: 'system',
        tag: 'team_expanded',
        content: `${displayName} joined the team.`,
    } as SystemMessage);
    commit(room);
    emit('team_formed', missionId, { team: room.team.map(t => t.agentId), added: agentId });
    return room;
}

/** List missions sorted by updatedAt desc. Returns shallow summaries by
 *  default; pass `full=true` to include messages + artifact for a sync
 *  page render. */
export function listMissions(opts: { ownerId?: string; full?: boolean } = {}): MissionRoom[] {
    ensureDir();
    let entries: string[];
    try { entries = readdirSync(MISSIONS_DIR).filter(f => f.endsWith('.json')); }
    catch { return []; }
    const out: MissionRoom[] = [];
    for (const f of entries) {
        const id = f.slice(0, -5);
        const room = getOrLoad(id);
        if (!room) continue;
        if (opts.ownerId && room.ownerId && room.ownerId !== opts.ownerId) continue;
        if (!opts.full) {
            // Cheap summary: strip messages + artifact content.
            out.push({
                ...room,
                messages: [],
                artifact: { ...room.artifact, content: '', snapshots: [] },
            });
        } else {
            out.push(room);
        }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Replace the team on an existing mission. Used after a planner picks
 *  a team for an ambiguous goal that didn't match a Play. */
export function setTeam(missionId: string, members: Array<{ agentId: string; name: string }>): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    room.team = members.map(m => {
        const meta = memberMetaFor(m.agentId);
        return {
            agentId: m.agentId,
            name: m.name,
            role: meta.role,
            color: meta.color,
            state: 'idle',
        };
    });
    if (room.status === 'forming') room.status = 'working';
    room.messages.push({
        id: shortId(),
        at: new Date().toISOString(),
        kind: 'system',
        tag: 'team_formed',
        content: `Team formed — ${room.team.map(t => t.name).join(', ')}.`,
    } as SystemMessage);
    commit(room);
    emit('team_formed', missionId, { team: room.team.map(t => t.agentId) });
    return room;
}

/** Link a goal driver Goal to this mission. */
export function setLinkedGoal(missionId: string, goalId: string): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    room.goalId = goalId;
    commit(room);
    return room;
}

/**
 * v6.1.0-alpha.10 — link a Command Post Issue to this mission. Called
 * by startMissionWork after createIssue; surfaces in the chat via the
 * `/issue` slash command (and on the issue side via the linked
 * `goalId` field).
 */
export function setLinkedIssue(missionId: string, issueId: string): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    room.issueId = issueId;
    commit(room);
    return room;
}

/**
 * v6.1.0-alpha.19 — set or clear a per-agent model override. Passing
 * `null` clears it back to the specialist's default model.
 */
export function setMemberModelOverride(
    missionId: string,
    agentId: string,
    model: string | null,
): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const member = room.team.find(m => m.agentId === agentId);
    if (!member) return room;
    if (model === null || model === '') {
        delete member.modelOverride;
    } else {
        member.modelOverride = model;
    }
    commit(room);
    emit('agent_state_changed', missionId, { agentId, modelOverride: member.modelOverride });
    return room;
}

/**
 * v6.1.0-alpha.19 — pause / resume a specific agent. Paused agents
 * should be skipped for new delegations by the goal driver. The UI
 * surfaces the pause as a state pill.
 */
export function setMemberPaused(
    missionId: string,
    agentId: string,
    paused: boolean,
): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const member = room.team.find(m => m.agentId === agentId);
    if (!member) return room;
    member.paused = paused;
    commit(room);
    emit('agent_state_changed', missionId, { agentId, paused });
    return room;
}

/**
 * v6.1.0-alpha.31 — append an activity entry to an agent's rolling
 * log. Capped at 8 most recent entries per agent so the mission JSON
 * stays bounded. Emits an `agent_state_changed` event so the canvas
 * picks it up immediately via SSE.
 */
export function appendMemberActivity(
    missionId: string,
    agentId: string,
    entry: { icon: string; activity: string; detail?: string },
): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const member = room.team.find(m => m.agentId === agentId);
    if (!member) return room;
    const log = Array.isArray(member.activityLog) ? [...member.activityLog] : [];
    // De-dupe consecutive identical activity (a tool that fires many
    // times in a row shouldn't pile up identical stickies).
    const last = log[log.length - 1];
    if (last && last.icon === entry.icon && last.activity === entry.activity && last.detail === entry.detail) {
        return room;
    }
    log.push({ at: new Date().toISOString(), ...entry });
    // Keep only the 8 most recent.
    member.activityLog = log.slice(-8);
    commit(room);
    emit('agent_state_changed', missionId, { agentId, activityLog: member.activityLog });
    return room;
}

/**
 * v6.1.0-alpha.19 — toggle Marathon mode (long-running multi-agent
 * collaboration). The daemon that ACTUALLY runs in marathon mode
 * ships in alpha.20+; this setter persists the flag.
 */
export function setLongRunningMode(
    missionId: string,
    enabled: boolean,
): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    room.longRunningMode = enabled;
    commit(room);
    emit('status_changed', missionId, { longRunningMode: enabled });
    return room;
}

/** Update an agent's live state. The team strip in the UI reflects this. */
export function setMemberState(
    missionId: string,
    agentId: string,
    state: MemberState,
    currentActivity?: string,
): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const member = room.team.find(m => m.agentId === agentId);
    if (!member) return room;
    const changed = member.state !== state || member.currentActivity !== currentActivity;
    member.state = state;
    if (currentActivity !== undefined) member.currentActivity = currentActivity;
    member.lastActiveAt = new Date().toISOString();
    if (changed) {
        commit(room);
        emit('agent_state_changed', missionId, { agentId, state, currentActivity });
    }
    return room;
}

/** A specialist said something in the chat. Returns the new message. */
export function postAgentMessage(
    missionId: string,
    agentId: string,
    content: string,
    actions?: { name: string; detail?: string }[],
    meta?: AgentMessage['meta'],
    sources?: AgentMessage['sources'],
): AgentMessage | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const member = room.team.find(m => m.agentId === agentId);
    const displayMeta = memberMetaFor(agentId);
    const msg: AgentMessage = {
        id: shortId(),
        at: new Date().toISOString(),
        kind: 'agent',
        from: {
            agentId,
            name: member?.name ?? agentId,
            role: displayMeta.role,
            color: displayMeta.color,
        },
        content,
        actions,
        meta,
        sources,
    };
    room.messages.push(msg);
    commit(room);
    emit('message_added', missionId, { message: msg });
    return msg;
}

/** The user said something in the chat. */
export function postUserMessage(missionId: string, content: string): UserMessage | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const msg: UserMessage = {
        id: shortId(),
        at: new Date().toISOString(),
        kind: 'user',
        content,
    };
    room.messages.push(msg);
    commit(room);
    emit('message_added', missionId, { message: msg });
    return msg;
}

/** A system note (team_formed, paused, etc.). */
export function postSystemMessage(missionId: string, content: string, tag?: string): SystemMessage | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const msg: SystemMessage = {
        id: shortId(),
        at: new Date().toISOString(),
        kind: 'system',
        content,
        tag,
    };
    room.messages.push(msg);
    commit(room);
    emit('message_added', missionId, { message: msg });
    return msg;
}

/** Agent raises a question. Caller passes the approval id from the
 *  Command Post queue so the UI can resolve answers via the existing
 *  approval pipeline. */
export function raiseQuestion(opts: {
    missionId: string;
    agentId: string;
    content: string;
    approvalId: string;
    quickReplies?: string[];
}): QuestionMessage | null {
    const room = getOrLoad(opts.missionId);
    if (!room) return null;
    const member = room.team.find(m => m.agentId === opts.agentId);
    const meta = memberMetaFor(opts.agentId);
    const msg: QuestionMessage = {
        id: shortId(),
        at: new Date().toISOString(),
        kind: 'question',
        from: {
            agentId: opts.agentId,
            name: member?.name ?? opts.agentId,
            role: meta.role,
            color: meta.color,
        },
        content: opts.content,
        approvalId: opts.approvalId,
        quickReplies: opts.quickReplies ?? [],
    };
    room.messages.push(msg);
    if (member) {
        member.state = 'blocked';
        member.currentActivity = 'needs you';
    }
    room.status = 'blocked';
    commit(room);
    emit('question_raised', opts.missionId, { message: msg });
    emit('agent_state_changed', opts.missionId, { agentId: opts.agentId, state: 'blocked' });
    emit('status_changed', opts.missionId, { status: 'blocked' });
    return msg;
}

/** Resolve a previously-raised question. */
export function answerQuestion(
    missionId: string,
    approvalId: string,
    answer: string,
): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const q = room.messages.find(
        m => m.kind === 'question' && (m as QuestionMessage).approvalId === approvalId,
    ) as QuestionMessage | undefined;
    if (!q) return room;
    q.answer = { content: answer, at: new Date().toISOString() };
    // Resume the blocked member.
    const member = room.team.find(m => m.agentId === q.from.agentId);
    if (member) {
        member.state = 'working';
        member.currentActivity = undefined;
    }
    // If no one else is blocked, the mission resumes.
    const stillBlocked = room.team.some(m => m.state === 'blocked');
    if (!stillBlocked && room.status === 'blocked') room.status = 'working';
    commit(room);
    emit('question_answered', missionId, { approvalId, answer });
    if (member) emit('agent_state_changed', missionId, { agentId: member.agentId, state: 'working' });
    if (!stillBlocked) emit('status_changed', missionId, { status: room.status });
    return room;
}

/** Update the live artifact. Caller supplies the new full content and
 *  a short human summary of what changed. We snapshot every update
 *  (bounded to the last 16) for rewind. */
export function updateArtifact(
    missionId: string,
    agentId: string,
    content: string,
    summary: string,
): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    const now = new Date().toISOString();
    const member = room.team.find(m => m.agentId === agentId);
    const wordCount = content.trim() === '' ? 0 : content.trim().split(/\s+/).length;
    // Snapshot the prior state before overwriting, so rewind can land on
    // what existed BEFORE this update.
    const priorSnapshot: ArtifactSnapshot = {
        at: room.artifact.updatedAt,
        content: room.artifact.content,
        by: agentId,
        summary,
        wordCount: room.artifact.content.trim() === '' ? 0 : room.artifact.content.trim().split(/\s+/).length,
    };
    room.artifact.snapshots.push(priorSnapshot);
    if (room.artifact.snapshots.length > 16) {
        room.artifact.snapshots = room.artifact.snapshots.slice(-16);
    }
    room.artifact.content = content;
    room.artifact.updatedAt = now;
    // Append an artifact_update marker to the message log so the chat
    // can render the live-document card update inline.
    const marker: ArtifactUpdateMessage = {
        id: shortId(),
        at: now,
        kind: 'artifact_update',
        by: { agentId, name: member?.name ?? agentId },
        summary,
        wordCount,
    };
    room.messages.push(marker);
    commit(room);
    emit('artifact_updated', missionId, { summary, by: agentId, wordCount });
    emit('message_added', missionId, { message: marker });
    return room;
}

/** Add to the running cost. Triggers a cost_changed event so the UI
 *  fuel gauge can update without polling. */
export function recordCost(missionId: string, tokens: number, usd: number): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    room.cost.tokens += Math.max(0, Math.floor(tokens));
    room.cost.usd += Math.max(0, usd);
    commit(room);
    emit('cost_changed', missionId, { ...room.cost });
    return room;
}

/** Transition status. The status drives the team-health pill at the
 *  top of the chat ("4 working · 1 needs you" etc.). */
export function setStatus(missionId: string, status: MissionStatus, note?: string): MissionRoom | null {
    const room = getOrLoad(missionId);
    if (!room) return null;
    if (room.status === status) return room;
    room.status = status;
    if (note) {
        room.messages.push({
            id: shortId(),
            at: new Date().toISOString(),
            kind: 'system',
            tag: status,
            content: note,
        } as SystemMessage);
    }
    commit(room);
    emit('status_changed', missionId, { status, note });
    return room;
}

/** Delete a mission, its linked goal, and its driver state. Stops all
 *  running agents immediately so the mission does not keep burning tokens
 *  after the user deleted it. */
export function deleteMission(missionId: string): boolean {
    const path = missionPath(missionId);
    if (!existsSync(path)) return false;

    // Read goalId BEFORE we delete the mission file.
    let goalId: string | undefined;
    try {
        const room = JSON.parse(readFileSync(path, 'utf-8')) as MissionRoom;
        goalId = room.goalId;
    } catch { /* no goalId = nothing to cancel */ }

    try {
        const tomb = path + '.deleted';
        renameSync(path, tomb);
        cache.delete(missionId);
        emit('mission_deleted', missionId, {});
    } catch (err) {
        logger.warn(COMPONENT, `Delete mission ${missionId} failed: ${(err as Error).message}`);
        return false;
    }

    // v6.1.0-alpha.44 — stop the linked goal and driver so agents die
    // immediately instead of continuing to burn tokens for a deleted mission.
    if (goalId) {
        (async () => {
            try {
                const { updateGoal } = await import('./goals.js');
                updateGoal(goalId!, { status: 'failed' });
            } catch (e) {
                logger.warn(COMPONENT, `Failed to mark goal ${goalId} failed: ${(e as Error).message}`);
            }
            try {
                const { cancelDriver, deleteDriverState } = await import('./goalDriver.js');
                cancelDriver(goalId!);
                deleteDriverState(goalId!);
            } catch (e) {
                logger.warn(COMPONENT, `Failed to cancel driver ${goalId}: ${(e as Error).message}`);
            }
        })();
    }

    return true;
}

// Test-only — reset cache so successive tests don't see each other.
export function _resetMissionCacheForTests(): void {
    cache.clear();
}
