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
    updateArtifact,
    recordCost,
    type MissionRoom,
    type MissionStatus,
} from './missionRoom.js';

const COMPONENT = 'MissionLifecycle';

// Per-mission cleanup handlers. When a mission completes, we tear down
// these subscriptions so the bus doesn't leak listeners.
const lifecycles = new Map<string, Array<() => void>>();

/** The wire that the gateway / missions router calls when a mission is
 *  created. Returns the linked goal id. */
export async function startMissionWork(mission: MissionRoom): Promise<string | null> {
    try {
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
        logger.info(COMPONENT, `Mission ${mission.id} linked to goal ${goal.id} (play=${mission.playId})`);

        // Set every team member to working so the team strip lights up
        // immediately. As the goal driver picks subtasks for real
        // specialists, the message bus bridge below will narrow each
        // member's `currentActivity` to what they're really doing.
        for (const member of mission.team) {
            setMemberState(mission.id, member.agentId, 'working', 'getting ready');
        }

        // Wire the agent message bus → mission room bridge for THIS mission.
        const cleanups: Array<() => void> = [];
        cleanups.push(await wireAgentBusBridge(mission.id, mission.team.map(t => t.agentId)));
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

/** Subscribe to the agent event bus so specialist output becomes chat
 *  messages in the mission room. Returns an unsubscribe. */
async function wireAgentBusBridge(missionId: string, expectedAgentIds: string[]): Promise<() => void> {
    let unsubscribe: () => void = () => { /* default no-op */ };
    try {
        // We import the existing sub-agent bus lazily; the gateway uses
        // it to broadcast specialist progress events for the dashboard.
        // We attach the same way, but filter to OUR mission's specialists
        // and route their outputs to postAgentMessage.
        const mod = await import('./subAgent.js') as unknown as {
            onSubAgentEvent?: (handler: (ev: SubAgentBusEvent) => void) => () => void;
        };
        if (typeof mod.onSubAgentEvent !== 'function') {
            return unsubscribe;
        }
        const known = new Set(expectedAgentIds);
        unsubscribe = mod.onSubAgentEvent((ev: SubAgentBusEvent) => {
            // Filter: only events from agents on THIS mission's team.
            const agentId = (ev.agentId ?? '').toLowerCase();
            if (!known.has(agentId)) return;
            switch (ev.type) {
                case 'agent_start':
                    setMemberState(missionId, agentId, 'working', shortenActivity(ev.task));
                    break;
                case 'agent_progress':
                    if (ev.message) {
                        setMemberState(missionId, agentId, 'working', shortenActivity(ev.message));
                    }
                    break;
                case 'agent_message':
                    if (ev.content) {
                        postAgentMessage(missionId, agentId, ev.content, ev.actions);
                    }
                    break;
                case 'artifact_chunk':
                    if (typeof ev.content === 'string' && ev.content.length > 0) {
                        // Caller passes the FULL latest content (caller knows
                        // the artifact format, not us). We snapshot + diff
                        // inside updateArtifact.
                        updateArtifact(missionId, agentId, ev.content, ev.summary ?? 'updated');
                    }
                    break;
                case 'cost':
                    if (typeof ev.tokens === 'number' && typeof ev.usd === 'number') {
                        recordCost(missionId, ev.tokens, ev.usd);
                    }
                    break;
                case 'agent_done':
                    setMemberState(missionId, agentId, 'idle', undefined);
                    break;
            }
        });
    } catch (err) {
        logger.debug(COMPONENT, `Agent bus bridge unavailable: ${(err as Error).message}`);
    }
    return unsubscribe;
}

/** Subscribe to the Command Post approval queue and translate any
 *  approval filed against this mission's goal into an inline question
 *  message. */
async function wireApprovalBridge(missionId: string, goalId: string): Promise<() => void> {
    let unsubscribe: () => void = () => { /* default no-op */ };
    try {
        const cp = await import('./commandPost.js') as unknown as {
            onApprovalCreated?: (handler: (approval: CPApprovalLike) => void) => () => void;
        };
        if (typeof cp.onApprovalCreated !== 'function') {
            return unsubscribe;
        }
        unsubscribe = cp.onApprovalCreated((approval: CPApprovalLike) => {
            // Filter: only approvals tied to this mission's goal.
            const payload = (approval.payload ?? {}) as Record<string, unknown>;
            if (payload.goalId !== goalId) return;
            const agentId = String(payload.specialist ?? approval.requestedBy ?? 'sage').toLowerCase();
            const content = String(payload.question ?? approval.title ?? 'Quick question.');
            const quickReplies = Array.isArray(payload.quickReplies)
                ? (payload.quickReplies as string[]).slice(0, 4)
                : [];
            raiseQuestion({
                missionId,
                agentId,
                content,
                approvalId: approval.id,
                quickReplies,
            });
        });
    } catch (err) {
        logger.debug(COMPONENT, `Approval bridge unavailable: ${(err as Error).message}`);
    }
    return unsubscribe;
}

// ── Types shared with the subAgent / commandPost modules ──────────
//
// We don't import their full types here because that would couple the
// mission lifecycle to internal shapes the rest of the codebase might
// reshape. We declare a minimal surface and rely on duck-typing.

interface SubAgentBusEvent {
    type: 'agent_start' | 'agent_progress' | 'agent_message' | 'artifact_chunk' | 'cost' | 'agent_done';
    agentId?: string;
    task?: string;
    message?: string;
    content?: string;
    summary?: string;
    actions?: { name: string; detail?: string }[];
    tokens?: number;
    usd?: number;
}

interface CPApprovalLike {
    id: string;
    title?: string;
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
