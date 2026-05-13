/**
 * TITAN — Mission lifecycle adapter (v6.1.0)
 *
 * Connects a freshly-created Mission Room to the existing goal driver
 * + Command Post pipeline. When a mission is created:
 *
 *   1. Create a Goal (in the goals subsystem) with title = goal text,
 *      tagged with the mission id and play id so the bridge below can
 *      filter events back to the right room.
 *   2. Subscribe to the agent message bus so each specialist's tool
 *      calls / answers / progress messages get rewritten as a chat
 *      message in the mission thread.
 *   3. Subscribe to the Command Post approval queue so blocking
 *      questions filed against this mission's goal show up as inline
 *      question messages in the chat.
 *
 * The bridge is one-way (driver → mission room). User actions (replies
 * to questions, status toggles) go through the mission router and
 * propagate to the goal driver / Command Post via existing APIs.
 *
 * Idempotent: subscribing a second mission doesn't double-fire. We
 * track per-mission unsubscribe functions in `lifecycles`.
 */
import logger from '../utils/logger.js';
import { createGoal } from './goals.js';
import {
    postAgentMessage,
    setMemberState,
    setStatus,
    raiseQuestion,
    recordCost,
    ensureMember,
    getMissionByGoalId,
    setLinkedGoal,
    type MissionRoom,
    type MissionStatus,
} from './missionRoom.js';
import { onAgentEvent, type AgentEvent } from './agentEvents.js';

const COMPONENT = 'MissionLifecycle';

// Per-mission cleanup handlers. When a mission completes, we tear down
// these subscriptions so the bus doesn't leak listeners.
const lifecycles = new Map<string, Array<() => void>>();

/**
 * v6.1.0-alpha.1 — a SINGLE global subscription to the shared
 * agentEvents bus. Every mission piggybacks off this; we filter by
 * goalId at dispatch time. This is much cheaper than N per-mission
 * subscriptions (which is what alpha.0's broken bridge attempted) and
 * survives the case where the goal driver routes to a specialist that
 * isn't on the predicted Plays team — we add them dynamically.
 */
let globalBusUnsub: (() => void) | null = null;
function ensureGlobalBusBridge(): void {
    if (globalBusUnsub) return;
    globalBusUnsub = onAgentEvent((ev: AgentEvent) => {
        // The goalDriver-emitted events carry data.goalId; events from
        // ad-hoc spawns (CLI, channels) don't, and we silently ignore
        // those — they aren't part of a mission.
        const data = ev.data ?? {};
        const goalId = typeof data.goalId === 'string' ? data.goalId : undefined;
        if (!goalId) return;
        const mission = getMissionByGoalId(goalId);
        if (!mission) return;
        const agentId = (ev.agentId ?? ev.agentName ?? '').toLowerCase();
        if (!agentId) return;
        try {
            switch (ev.type) {
                case 'agent_spawn': {
                    ensureMember(mission.id, agentId);
                    const subtaskTitle = typeof data.subtaskTitle === 'string' ? data.subtaskTitle : 'something';
                    setMemberState(mission.id, agentId, 'working', shortenActivity(subtaskTitle));
                    break;
                }
                case 'tool_call': {
                    const name = typeof data.name === 'string' ? data.name : 'tool';
                    setMemberState(mission.id, agentId, 'working', shortenActivity(`running ${name}`));
                    break;
                }
                case 'tool_end': {
                    // Don't transition state — the next tool_call or agent_done
                    // will overwrite. Just no-op (avoids flicker).
                    break;
                }
                case 'agent_done': {
                    ensureMember(mission.id, agentId);
                    const reasoning = typeof data.reasoning === 'string' && data.reasoning.trim().length > 0
                        ? data.reasoning.trim()
                        : null;
                    const toolsUsed = Array.isArray(data.toolsUsed)
                        ? (data.toolsUsed as string[]).slice(0, 6)
                        : [];
                    const actions = toolsUsed.map(t => ({ name: 'used', detail: t }));
                    const status = typeof data.status === 'string' ? data.status : 'done';
                    // v6.1.0-alpha.1 — every agent_done emits SOMETHING into
                    // the chat. The pre-fix path returned nothing when
                    // `reasoning` was empty, which is common on cloud
                    // specialists that return JSON-only responses (their
                    // reasoning field is empty because the *artifact* is
                    // the value). The chat shouldn't go silent.
                    if (reasoning) {
                        postAgentMessage(mission.id, agentId, reasoning, actions.length > 0 ? actions : undefined);
                    } else if (status === 'failed') {
                        postAgentMessage(
                            mission.id,
                            agentId,
                            `I ran into trouble on this one and couldn't finish — handing back to the team.`,
                            actions.length > 0 ? actions : undefined,
                        );
                    } else if (status === 'needs_info' || status === 'blocked') {
                        postAgentMessage(
                            mission.id,
                            agentId,
                            `I have a quick question before I can finish — see below.`,
                            actions.length > 0 ? actions : undefined,
                        );
                    } else {
                        // status === 'done' with empty reasoning. Common with
                        // JSON-only specialists. Don't go silent — say something
                        // honest about what they did.
                        const summary = toolsUsed.length > 0
                            ? `Done — used ${toolsUsed.slice(0, 3).join(', ')}.`
                            : `Done.`;
                        postAgentMessage(mission.id, agentId, summary, actions.length > 0 ? actions : undefined);
                    }
                    setMemberState(mission.id, agentId, 'idle', undefined);
                    const tokens = typeof data.tokensUsed === 'number' ? data.tokensUsed : 0;
                    const cost = typeof data.costUsd === 'number' ? data.costUsd : 0;
                    if (tokens > 0 || cost > 0) {
                        recordCost(mission.id, tokens, cost);
                    }
                    break;
                }
            }
        } catch (err) {
            logger.debug(COMPONENT, `Bridge dispatch threw for ${mission.id}/${ev.type}: ${(err as Error).message}`);
        }
    });
    logger.info(COMPONENT, 'Global agent-event bridge attached (goalId → mission room dispatch)');
}

/** The wire that the gateway / missions router calls when a mission is
 *  created. Returns the linked goal id. */
export async function startMissionWork(mission: MissionRoom): Promise<string | null> {
    try {
        // Make sure the global event bridge is alive. Idempotent.
        ensureGlobalBusBridge();

        // Tag the goal with the mission + play id so message-bus event
        // bridges can filter "which mission did this belong to."
        const goal = createGoal({
            title: mission.goal,
            description: `Mission ${mission.id}` + (mission.playId ? ` (play: ${mission.playId})` : ''),
            tags: [
                `mission:${mission.id}`,
                mission.playId ? `play:${mission.playId}` : 'play:generic',
            ],
        });
        // v6.1.0-alpha.1 — link the goal id INSIDE startMissionWork so any
        // event the goal driver fires (even before the missions router gets
        // back to set it) can resolve the mission via getMissionByGoalId.
        // The router's redundant setLinkedGoal call is now a no-op safety
        // net rather than the source of truth.
        setLinkedGoal(mission.id, goal.id);
        logger.info(COMPONENT, `Mission ${mission.id} linked to goal ${goal.id} (play=${mission.playId})`);

        // Mark every Plays-predicted member as "ready" so the team strip
        // lights up immediately. The goal driver routes for real, and the
        // global bridge will narrow each member's `currentActivity` (and
        // ADD new members if the driver picks specialists Plays didn't
        // predict).
        for (const member of mission.team) {
            setMemberState(mission.id, member.agentId, 'idle', 'standing by');
        }

        // The approval bridge stays per-mission for now — most approval
        // payloads don't carry goalId in a uniform way, so we register a
        // listener scoped to the goal id we just created.
        const cleanups: Array<() => void> = [];
        cleanups.push(await wireApprovalBridge(mission.id, goal.id));
        lifecycles.set(mission.id, cleanups);

        return goal.id;
    } catch (err) {
        logger.error(COMPONENT, `Failed to start mission ${mission.id}: ${(err as Error).message}`);
        setStatus(mission.id, 'failed', `Couldn't start the team: ${(err as Error).message}`);
        return null;
    }
}

/** Called when the UI posts a user message into an active mission. For
 *  v1 the user message is treated as supplemental context (recorded in
 *  the chat, queued for the next agent loop). Real-time injection into
 *  a running specialist's prompt is a v6.1.1 follow-up. */
export async function handleUserMessage(missionId: string, content: string): Promise<void> {
    // For v1 we use the existing messageBus. We don't know which
    // specialist is "current" — broadcast to every registered member's
    // mailbox so whichever one is in-flight picks the note up at the
    // start of its next round. Mailbox names match the specialist ids.
    try {
        const { sendMessage } = await import('./messageBus.js');
        const { getMission } = await import('./missionRoom.js');
        const room = getMission(missionId);
        const recipients = room?.team.map(t => t.agentId) ?? [];
        for (const to of recipients) {
            // sendMessage(from, to, content, opts?)
            sendMessage('user', to, content, { priority: 'urgent' });
        }
    } catch (err) {
        logger.debug(COMPONENT, `messageBus dispatch skipped: ${(err as Error).message}`);
    }
}

/** Called when the UI toggles status (pause / resume). */
export async function handleStatusChange(missionId: string, status: MissionStatus): Promise<void> {
    if (status !== 'paused' && status !== 'working') return;
    try {
        // Look up the linked goal and toggle its driver state via the
        // existing user-controls surface. We import dynamically so the
        // lifecycle module doesn't have a top-level goal-driver
        // dependency (matches the rest of the file's pattern).
        const room = (await import('./missionRoom.js')).getMission(missionId);
        if (!room?.goalId) return;
        const driver = await import('./goalDriver.js');
        if (status === 'paused' && typeof driver.pauseDriver === 'function') {
            driver.pauseDriver(room.goalId);
        } else if (status === 'working' && typeof driver.resumeDriverControl === 'function') {
            driver.resumeDriverControl(room.goalId);
        }
    } catch (err) {
        logger.debug(COMPONENT, `Couldn't toggle driver state for ${missionId}: ${(err as Error).message}`);
    }
}

/** Tear down a mission's bridges. Called when the goal completes,
 *  fails, or the mission is deleted. */
export function teardownMissionWork(missionId: string): void {
    const cleanups = lifecycles.get(missionId);
    if (!cleanups) return;
    for (const fn of cleanups) {
        try { fn(); }
        catch (err) { logger.debug(COMPONENT, `Cleanup threw: ${(err as Error).message}`); }
    }
    lifecycles.delete(missionId);
}

// ── Bridges ────────────────────────────────────────────────────────

/** Subscribe to the Command Post approval queue and translate any
 *  approval filed against this mission's goal into an inline question
 *  message. v6.1.0-alpha.1 — uses the real titanEvents bus
 *  ('commandpost:approval:created' event added in commandPost.ts).
 *  Returns an unsubscribe. */
async function wireApprovalBridge(missionId: string, goalId: string): Promise<() => void> {
    const { titanEvents } = await import('./daemon.js');
    const handler = (approval: CPApprovalLike) => {
        try {
            // Filter: only approvals tied to this mission's goal.
            const payload = (approval.payload ?? {}) as Record<string, unknown>;
            if (payload.goalId !== goalId) return;
            const agentId = String(payload.specialist ?? payload.subtaskKind ?? approval.requestedBy ?? 'sage').toLowerCase();
            // Different approval kinds use different fields for "the actual
            // question." Try the most common ones in order.
            const content = String(
                payload.question
                ?? payload.allQuestions
                ?? approval.title
                ?? approval.reason
                ?? `${approval.type} approval needed`
            );
            const quickReplies = Array.isArray(payload.quickReplies)
                ? (payload.quickReplies as string[]).slice(0, 4)
                : defaultQuickReplies(approval);
            raiseQuestion({
                missionId,
                agentId,
                content,
                approvalId: approval.id,
                quickReplies,
            });
        } catch (err) {
            logger.debug(COMPONENT, `Approval bridge handler threw: ${(err as Error).message}`);
        }
    };
    titanEvents.on('commandpost:approval:created', handler);
    return () => titanEvents.off('commandpost:approval:created', handler);
}

/** Sensible default reply set for the common approval kinds. */
function defaultQuickReplies(approval: CPApprovalLike): string[] {
    const payloadKind = (approval.payload as Record<string, unknown> | undefined)?.kind;
    if (payloadKind === 'driver_blocked') return ['Use your best judgment', 'Pause for me', 'Try a different angle'];
    if (payloadKind === 'self_repair')    return ['Approve fix', 'Skip', 'Tell me more'];
    return ['Approve', 'Skip'];
}

// ── Types shared with the commandPost module ───────────────────────
//
// We don't import the full CPApproval shape because that would couple
// the mission lifecycle to internal commandPost types that may reshape.
// Duck-type only what we need.

interface CPApprovalLike {
    id: string;
    type?: string;
    title?: string;
    reason?: string;
    requestedBy?: string;
    payload?: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────

function shortenActivity(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const trimmed = s.trim();
    if (trimmed.length <= 80) return trimmed;
    return trimmed.slice(0, 77).trimEnd() + '…';
}
