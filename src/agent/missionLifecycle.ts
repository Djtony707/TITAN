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
    postSystemMessage,
    setMemberState,
    setStatus,
    raiseQuestion,
    recordCost,
    ensureMember,
    getMission,
    getMissionByGoalId,
    setLinkedGoal,
    setLinkedIssue,
    type MissionRoom,
    type MissionStatus,
} from './missionRoom.js';
import { onAgentEvent, type AgentEvent } from './agentEvents.js';
import { createIssue, updateIssue, addIssueComment } from './commandPost.js';

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
                    // v6.1.0-alpha.5 — be defensive: ensure the member
                    // exists before setting state. Tool calls fire from
                    // mid-spawn — the specialist could be one the goal
                    // driver routed to outside the predicted team.
                    ensureMember(mission.id, agentId);
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
                    const rawReasoning = typeof data.reasoning === 'string' && data.reasoning.trim().length > 0
                        ? data.reasoning.trim()
                        : null;
                    // v6.1.0-alpha.12 — pluck the specialist's concrete
                    // artifacts (URLs visited, files written, facts
                    // memorized) so the chat can render them as clickable
                    // sources. Pre-alpha.12 these were silently discarded —
                    // a "Successfully researched" reasoning summary made it
                    // to chat but the actual URLs/files behind it did not,
                    // so the user couldn't follow up on anything.
                    const sources: Array<{ type: 'url' | 'file' | 'fact' | 'report'; ref: string; description?: string }> = [];
                    if (Array.isArray(data.artifacts)) {
                        for (const raw of data.artifacts) {
                            if (!raw || typeof raw !== 'object') continue; // skip null/undefined/primitive
                            const a = raw as Record<string, unknown>;
                            const t = typeof a.type === 'string' ? a.type : '';
                            const ref = typeof a.ref === 'string' ? a.ref : '';
                            if (!ref) continue;
                            if (t !== 'url' && t !== 'file' && t !== 'fact' && t !== 'report') continue;
                            sources.push({
                                type: t as 'url' | 'file' | 'fact' | 'report',
                                ref,
                                description: typeof a.description === 'string' ? a.description : undefined,
                            });
                            if (sources.length >= 12) break;
                        }
                    }
                    // v6.1.0-alpha.7 — scrub internal-error stack traces.
                    // When a spawn fails, the `reasoning` field can be the
                    // raw error chain: "Parser could not extract JSON...
                    // Sub-agent error: All providers failed: HTTP 429
                    // <html>..." That's pure jargon for users. Detect it
                    // and replace with the friendly fallback. The original
                    // text is preserved on `meta.failureDetail` so power
                    // users can still see it via click-to-expand.
                    const reasoning = looksLikeInternalErrorTrace(rawReasoning)
                        ? null
                        : rawReasoning;
                    const toolsUsed = Array.isArray(data.toolsUsed)
                        ? (data.toolsUsed as string[]).slice(0, 6)
                        : [];
                    const actions = toolsUsed.map(t => ({ name: 'used', detail: t }));
                    const status = typeof data.status === 'string' ? data.status : 'done';
                    // v6.1.0-alpha.4 — pass the rich context as the message
                    // `meta` field. The chat UI hides it by default and
                    // surfaces it when the user clicks the bubble — keeps
                    // the thread readable while making "what actually
                    // happened here" one tap away.
                    //
                    // v6.1.0-alpha.7 — if the raw reasoning was a scrubbed
                    // internal-error trace, stash it on `meta.failureDetail`
                    // so power users can still see it via click-to-expand.
                    // The chat surface stays clean.
                    const meta: Record<string, unknown> = {
                        subtaskTitle: typeof data.subtaskTitle === 'string' ? data.subtaskTitle : undefined,
                        status,
                        durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
                        tokensUsed: typeof data.tokensUsed === 'number' ? data.tokensUsed : undefined,
                        costUsd: typeof data.costUsd === 'number' ? data.costUsd : undefined,
                        model: typeof data.model === 'string' ? data.model : undefined,
                    };
                    if (rawReasoning && rawReasoning !== reasoning) {
                        meta.failureDetail = rawReasoning;
                    }
                    // v6.1.0-alpha.1 — every agent_done emits SOMETHING into
                    // the chat. The pre-fix path returned nothing when
                    // `reasoning` was empty, which is common on cloud
                    // specialists that return JSON-only responses (their
                    // reasoning field is empty because the *artifact* is
                    // the value). The chat shouldn't go silent.
                    // v6.1.0-alpha.12 — also pass `sources` so URLs +
                    // files the specialist worked with render clickably.
                    const sourcesArg = sources.length > 0 ? sources : undefined;
                    if (reasoning) {
                        postAgentMessage(mission.id, agentId, reasoning, actions.length > 0 ? actions : undefined, meta, sourcesArg);
                    } else if (status === 'failed') {
                        postAgentMessage(
                            mission.id,
                            agentId,
                            `I ran into trouble on this one and couldn't finish — handing back to the team.`,
                            actions.length > 0 ? actions : undefined,
                            meta,
                            sourcesArg,
                        );
                    } else if (status === 'needs_info' || status === 'blocked') {
                        postAgentMessage(
                            mission.id,
                            agentId,
                            `I have a quick question before I can finish — see below.`,
                            actions.length > 0 ? actions : undefined,
                            meta,
                            sourcesArg,
                        );
                    } else {
                        // status === 'done' with empty reasoning. Common with
                        // JSON-only specialists. Don't go silent — say something
                        // honest about what they did.
                        const summary = toolsUsed.length > 0
                            ? `Done — used ${toolsUsed.slice(0, 3).join(', ')}.`
                            : `Done.`;
                        postAgentMessage(mission.id, agentId, summary, actions.length > 0 ? actions : undefined, meta, sourcesArg);
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
            // v6.1.0-alpha.5 — Mission Chat goals are user-initiated. The
            // autonomous-creation rate limit (10/hour) + active-goals cap
            // exists to throttle runaway self-mod / self-repair loops, not
            // to throttle the user typing into the chat. Bypass it so
            // missions never silently fail with "Couldn't start the team:
            // rate limited" after the user's 11th request in an hour.
            force: true,
        });
        // v6.1.0-alpha.1 — link the goal id INSIDE startMissionWork so any
        // event the goal driver fires (even before the missions router gets
        // back to set it) can resolve the mission via getMissionByGoalId.
        // The router's redundant setLinkedGoal call is now a no-op safety
        // net rather than the source of truth.
        setLinkedGoal(mission.id, goal.id);

        // v6.1.0-alpha.10 — auto-create a Command Post issue for this
        // mission. The issue becomes the durable audit trail (every
        // significant lifecycle event mirrors as a comment) and the
        // Command Post Issues panel + Mission Chat / Canvas surface the
        // same record. Failure to create the issue should never block
        // the mission itself — it's audit, not behavior.
        let issueIdent: string | undefined;
        try {
            const issue = createIssue({
                title: mission.goal,
                description: `Mission ${mission.id}` + (mission.playId ? ` · play: ${mission.playId}` : '') +
                    `\n\nLinked goal: ${goal.id}` +
                    `\n\nTeam: ${mission.team.map(t => t.name).join(', ') || '(forming)'}`,
                priority: 'medium',
                createdByUser: 'mission-chat',
                goalId: goal.id,
            });
            setLinkedIssue(mission.id, issue.id);
            issueIdent = issue.identifier;
            updateIssue(issue.id, { status: 'in_progress' });
            addIssueComment(
                issue.id,
                `Mission opened with team: ${mission.team.map(t => t.name).join(', ') || '(forming)'}.`,
                { user: 'mission-chat' },
            );
        } catch (issueErr) {
            logger.warn(COMPONENT, `Issue link skipped for mission ${mission.id}: ${(issueErr as Error).message}`);
        }
        logger.info(
            COMPONENT,
            `Mission ${mission.id} linked to goal ${goal.id}` +
            (issueIdent ? ` and issue ${issueIdent}` : '') +
            ` (play=${mission.playId})`,
        );

        // Mark every Plays-predicted member as "ready" so the team strip
        // lights up immediately. The goal driver routes for real, and the
        // global bridge will narrow each member's `currentActivity` (and
        // ADD new members if the driver picks specialists Plays didn't
        // predict).
        for (const member of mission.team) {
            setMemberState(mission.id, member.agentId, 'idle', 'standing by');
        }

        // The approval bridge + goal-lifecycle bridge are both
        // per-mission — they filter by goalId, so we register them
        // scoped to the goal we just created.
        const cleanups: Array<() => void> = [];
        cleanups.push(await wireApprovalBridge(mission.id, goal.id));
        cleanups.push(await wireGoalLifecycleBridge(mission.id, goal.id));
        lifecycles.set(mission.id, cleanups);

        return goal.id;
    } catch (err) {
        logger.error(COMPONENT, `Failed to start mission ${mission.id}: ${(err as Error).message}`);
        setStatus(mission.id, 'failed', `Couldn't start the team: ${(err as Error).message}`);
        return null;
    }
}

/** Called when the UI posts a user message into a mission. Two paths:
 *
 *   1. **Mission is live** (working/blocked/paused/forming) — broadcast
 *      the user's note to every registered specialist mailbox so the
 *      next agent loop picks it up. Same behavior as alpha.1+.
 *
 *   2. **Mission is terminal** (done/failed) — v6.1.0-alpha.13: reopen
 *      the mission with this message as a new direction. Creates a
 *      fresh Goal, re-wires the lifecycle bridges, flips status back
 *      to 'working', posts a "Picking this back up…" system note,
 *      mirrors to the linked Command Post issue. The DriverScheduler
 *      picks up the new active goal on its next tick (~10s).
 */
export async function handleUserMessage(missionId: string, content: string): Promise<void> {
    const room = getMission(missionId);
    if (!room) return;
    const isTerminal = room.status === 'done' || room.status === 'failed';
    if (isTerminal) {
        await reopenMissionWithFollowUp(missionId, content);
        return;
    }
    // For v1 we use the existing messageBus. We don't know which
    // specialist is "current" — broadcast to every registered member's
    // mailbox so whichever one is in-flight picks the note up at the
    // start of its next round. Mailbox names match the specialist ids.
    //
    // v6.1.0-alpha.1 — only dispatch to mailboxes that are actually
    // REGISTERED right now. Specialists register their mailbox at spawn
    // time and unregister when done. If no team member is mid-spawn,
    // there's no mailbox to deliver to — that's fine, the user's note
    // is already in the chat thread and the goal driver will see it
    // when it next decides which subtask to schedule. Sending to an
    // unregistered mailbox would emit a noisy warn for every team
    // member every time.
    try {
        const { sendMessage, hasMailbox } = await import('./messageBus.js');
        const recipients = room.team.map(t => t.agentId);
        let delivered = 0;
        for (const to of recipients) {
            if (!hasMailbox(to)) continue; // skip non-registered to avoid noisy warns
            const result = sendMessage('user', to, content, { priority: 'urgent' });
            if (result) delivered++;
        }
        if (delivered === 0) {
            logger.debug(COMPONENT, `User message recorded in chat; no specialist mailboxes were live to receive it (team will pick up at next subtask).`);
        }
    } catch (err) {
        logger.debug(COMPONENT, `messageBus dispatch skipped: ${(err as Error).message}`);
    }
}

/**
 * v6.1.0-alpha.13 — reopen a terminal mission with a follow-up direction.
 *
 * Creates a brand-new Goal with the user's new content as the title.
 * The mission keeps its id + history; the chat thread continues
 * organically; the team strip keeps showing previous helpers (and
 * picks up new ones automatically as the new goal spawns specialists
 * via the dynamic-team logic from alpha.1).
 *
 * Re-wires the per-mission bridges (approval bridge, goal-lifecycle
 * bridge) since the previous bridges were torn down when the mission
 * first reached its terminal state. The agent-event bridge is global
 * and looks up missions by goalId at dispatch time — it picks up the
 * new goal automatically without re-registration.
 */
async function reopenMissionWithFollowUp(missionId: string, newContent: string): Promise<void> {
    const room = getMission(missionId);
    if (!room) return;
    try {
        ensureGlobalBusBridge();
        const newGoal = createGoal({
            title: newContent,
            description:
                `Follow-up on mission ${missionId} (continued from previous goal ${room.goalId ?? '?'}).\n\n` +
                `Original mission: "${room.goal}"\n\n` +
                `User wants: ${newContent}`,
            tags: [
                `mission:${missionId}`,
                room.playId ? `play:${room.playId}` : 'play:generic',
                'mission-followup',
            ],
            // Same rationale as startMissionWork — user-initiated, not
            // autonomous; bypass the 10-goals-per-hour rate limit.
            force: true,
        });
        setLinkedGoal(missionId, newGoal.id);
        // Tear down any stale bridges (in case completion teardown
        // didn't run yet) and wire fresh ones for the new goal.
        teardownMissionWork(missionId);
        const cleanups: Array<() => void> = [];
        cleanups.push(await wireApprovalBridge(missionId, newGoal.id));
        cleanups.push(await wireGoalLifecycleBridge(missionId, newGoal.id));
        lifecycles.set(missionId, cleanups);

        // Wake the team back up in the team strip.
        for (const member of room.team) {
            setMemberState(missionId, member.agentId, 'idle', 'getting back on it');
        }

        // Chat surface: explain what just happened.
        postSystemMessage(
            missionId,
            'Picking this back up — the team is taking another swing with your new direction.',
            'mission_resumed',
        );
        setStatus(missionId, 'working');

        // Mirror to the linked Command Post issue.
        if (room.issueId) {
            try {
                updateIssue(room.issueId, { status: 'in_progress' });
                addIssueComment(
                    room.issueId,
                    `User picked the mission back up: "${newContent.slice(0, 200)}${newContent.length > 200 ? '…' : ''}"`,
                    { user: 'mission-chat' },
                );
            } catch { /* mirror failure never blocks the reopen */ }
        }

        logger.info(
            COMPONENT,
            `Mission ${missionId} reopened — new goal ${newGoal.id} linked (was: ${room.goalId ?? 'unset'})`,
        );
    } catch (err) {
        logger.error(COMPONENT, `Reopen failed for mission ${missionId}: ${(err as Error).message}`);
        // Surface the failure to the user instead of going silent.
        try {
            postSystemMessage(
                missionId,
                `Couldn't pick this back up: ${(err as Error).message}. Try starting a fresh mission instead.`,
                'mission_resume_failed',
            );
        } catch { /* ok */ }
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

// ── Issue mirror ───────────────────────────────────────────────────
//
// v6.1.0-alpha.10 — mirror big mission lifecycle events to the linked
// Command Post issue. Keeps the issue useful as the durable audit
// trail without spamming it with every chat message (chat thread
// already serves that purpose). What we mirror:
//
//   - Mission start (in startMissionWork): "Mission opened with team: …"
//   - Question raised: `Sage asked: "<question>"`
//   - Question answered: `User answered: "<answer>"`
//   - Mission complete / failed: the same one-liner posted to chat,
//     plus an issue status update (done / cancelled).
//
// Every individual agent_message is NOT mirrored — too noisy.
// Subtask-grain events stay in the chat thread.

interface IssueMirror {
    status?: 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
    comment?: string;
}

function mirrorToIssue(missionId: string, mirror: IssueMirror): void {
    try {
        const room = getMission(missionId);
        const issueId = room?.issueId;
        if (!issueId) return;
        if (mirror.comment) {
            addIssueComment(issueId, mirror.comment, { user: 'mission-chat' });
        }
        if (mirror.status) {
            updateIssue(issueId, { status: mirror.status });
        }
    } catch (err) {
        logger.debug(COMPONENT, `Issue mirror skipped: ${(err as Error).message}`);
    }
}

// ── Bridges ────────────────────────────────────────────────────────

/**
 * Subscribe to goal-lifecycle events on the titanEvents bus and
 * translate goal completion / failure into:
 *   1. a system message in the mission thread ("Mission complete." or
 *      "Couldn't finish this one — here's what we have so far.")
 *   2. a status transition (working → done | failed)
 *
 * Without this, the mission room sat in 'working' indefinitely after
 * the underlying goal completed — the chat showed an idle team strip
 * and no closure message, which looked like the mission was stuck even
 * when it had successfully finished.
 */
async function wireGoalLifecycleBridge(missionId: string, goalId: string): Promise<() => void> {
    const { titanEvents } = await import('./daemon.js');
    const completedHandler = (data: unknown) => {
        try {
            const d = (data ?? {}) as Record<string, unknown>;
            if (d.goalId !== goalId) return;
            const durationMs = typeof d.durationMs === 'number' ? d.durationMs : 0;
            const seconds = Math.max(1, Math.round(durationMs / 1000));
            const specialistsUsed = Array.isArray(d.specialistsUsed) ? (d.specialistsUsed as string[]) : [];
            const namesList = specialistsUsed.length > 0
                ? ` with help from ${specialistsUsed.slice(0, 5).join(', ')}`
                : '';
            const completionLine = `Mission complete in ${seconds}s${namesList}.`;
            postSystemMessage(missionId, completionLine, 'mission_complete');
            setStatus(missionId, 'done');
            // v6.1.0-alpha.10 — mirror to the linked Command Post issue.
            mirrorToIssue(missionId, { status: 'done', comment: completionLine });
            // Mission reached a terminal state — tear down its bridges so
            // we don't leak event-bus listeners. Defer one tick so any
            // remaining synchronous work inside this handler chain runs
            // before the bridges go away.
            setImmediate(() => teardownMissionWork(missionId));
        } catch (err) {
            logger.debug(COMPONENT, `goal:completed handler threw: ${(err as Error).message}`);
        }
    };
    const failedHandler = (data: unknown) => {
        try {
            const d = (data ?? {}) as Record<string, unknown>;
            if (d.goalId !== goalId) return;
            const retries = typeof d.retries === 'number' ? d.retries : 0;
            const failureLine = retries > 0
                ? `Couldn't finish this one after ${retries} retry attempt(s). Take a look at what we did manage and tell me what to try next.`
                : `Couldn't finish this one. Take a look at what we did manage and tell me what to try next.`;
            postSystemMessage(missionId, failureLine, 'mission_failed');
            setStatus(missionId, 'failed');
            mirrorToIssue(missionId, { status: 'cancelled', comment: failureLine });
            setImmediate(() => teardownMissionWork(missionId));
        } catch (err) {
            logger.debug(COMPONENT, `goal:failed handler threw: ${(err as Error).message}`);
        }
    };
    titanEvents.on('goal:completed', completedHandler);
    titanEvents.on('goal:failed', failedHandler);
    return () => {
        titanEvents.off('goal:completed', completedHandler);
        titanEvents.off('goal:failed', failedHandler);
    };
}

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
            const rawContent = String(
                payload.question
                ?? payload.allQuestions
                ?? approval.title
                ?? approval.reason
                ?? `${approval.type} approval needed`
            );
            // v6.1.0-alpha.5 — strip the goalDriver boilerplate prefix so the
            // question reads like something a person would actually ask, not
            // an internal stack trace. The driver's auto-generated questions
            // look like:
            //   `Goal "X" — subtask "Y" failed after N attempt(s) with
            //    specialist Z. Error: ... What should the specialist do next?`
            // After this cleanup they read like:
            //   `Error: ... What should the specialist do next?`
            const content = stripDriverBoilerplate(rawContent);
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
            // v6.1.0-alpha.10 — mirror to issue audit trail.
            mirrorToIssue(missionId, {
                comment: `${agentId} asked: "${content.slice(0, 200)}${content.length > 200 ? '…' : ''}"`,
                status: 'blocked',
            });
        } catch (err) {
            logger.debug(COMPONENT, `Approval bridge handler threw: ${(err as Error).message}`);
        }
    };
    titanEvents.on('commandpost:approval:created', handler);
    return () => titanEvents.off('commandpost:approval:created', handler);
}

/**
 * Strip the goalDriver's auto-generated boilerplate from blocked-approval
 * question text so it reads like a person's question. The driver wraps
 * the specialist's actual question (or a fallback) with internal context
 * (subtask title, attempt count, specialist id) that's noise to the user.
 *
 * Patterns matched:
 *   - `Goal "..." is stuck on subtask "..." (attempt N, specialist: X).\n\n`
 *   - `Goal "..." — subtask "..." failed after N attempt(s) with specialist X.\n\n`
 *   - `Goal "..." — subtask "..." is blocked after N attempt(s) with specialist X. The specialist could not complete the task and needs guidance on how to proceed.`
 */
export function stripDriverBoilerplate(text: string): string {
    if (!text || typeof text !== 'string') return text ?? '';
    let cleaned = text;
    // Pattern 1: prefix → "Goal '...' is stuck on subtask '...' (...).\n\n<real question>"
    cleaned = cleaned.replace(
        /^Goal\s+"[^"]*"\s+is\s+stuck\s+on\s+subtask\s+"[^"]*"\s+\([^)]*\)\.\s*\n+/i,
        '',
    );
    // Pattern 2: prefix → "Goal '...' — subtask '...' failed after N attempt(s) with specialist X.\n\nError: ..."
    cleaned = cleaned.replace(
        /^Goal\s+"[^"]*"\s+—\s+subtask\s+"[^"]*"\s+failed\s+after\s+\d+\s+attempt\(s\)\s+with\s+specialist\s+\S+\.\s*\n+/i,
        '',
    );
    // Pattern 3: fallback (no real question, just the driver's placeholder)
    cleaned = cleaned.replace(
        /^Goal\s+"[^"]*"\s+—\s+subtask\s+"[^"]*"\s+is\s+blocked\s+after\s+\d+\s+attempt\(s\)\s+with\s+specialist\s+\S+\.\s*The\s+specialist\s+could\s+not\s+complete\s+the\s+task\s+and\s+needs\s+guidance\s+on\s+how\s+to\s+proceed\.?\s*/i,
        '',
    );
    cleaned = cleaned.trim();
    // If we stripped everything, fall back to a friendly default — the
    // user shouldn't see an empty question.
    if (cleaned.length === 0) {
        return 'I need more direction to keep going. What should I focus on?';
    }
    return cleaned;
}

/**
 * Detect internal error-chain text that should NOT be shown to the user
 * as the specialist's "reasoning." Examples seen in the wild post-alpha.5:
 *
 *   `Parser could not extract JSON from specialist response. Raw (200 chars):
 *    Sub-agent error: All providers failed: Provider ollama/glm-5:cloud
 *    failed: [HTTP 429] Ollama error (429): <!doctype html>...`
 *
 * The bridge scrubs these strings and falls through to the friendly
 * fallback ("I ran into trouble on this one and couldn't finish — handing
 * back to the team.") rather than dumping a stack trace into the chat.
 * The raw text is preserved on the message's `meta.failureDetail` so it
 * stays available via the click-to-expand details panel.
 */
export function looksLikeInternalErrorTrace(text: string | null | undefined): boolean {
    if (!text || typeof text !== 'string') return false;
    const markers = [
        /Parser could not extract JSON/i,
        /Sub-agent error:/i,
        /All providers failed/i,
        /HTTP\s+\d{3}.*Ollama error/i,
        /Circuit breaker OPEN for/i,
        /<!doctype html>/i,
        /\bToo Many Requests\b/i,
    ];
    return markers.some(re => re.test(text));
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
