/**
 * TITAN — Nudge action decision + execution logic (v6.1.0-alpha.42, Bug #5).
 *
 * Pure decision function + injectable async executor so the branching
 * logic is unit-testable without a DOM/jsdom environment. Tests inject
 * spy nudgeMission/postMessage functions and assert actual call counts,
 * arguments, exclusivity, and rejection behavior.
 *
 * Two paths:
 *   - 'recovery' — mission or agent is blocked; call nudgeMission() which
 *     hits POST /api/missions/:id/nudge to force a driver tick.
 *   - 'chat' — normal state; send a friendly @mention check-in via
 *     postMessage().
 *
 * Cancelled missions: no-op. A cancelled room is terminated; nudging
 * makes no sense and must not call either API.
 */
import type { MissionMember, MissionRoom } from '@/api/missions';

export type NudgeAction =
  | { kind: 'recovery' }
  | { kind: 'chat'; message: string }
  | { kind: 'noop' };

/** Injected API dependencies for executeNudge. */
export interface NudgeDeps {
  nudgeMission: (missionId: string) => Promise<unknown>;
  postMessage: (missionId: string, content: string) => Promise<unknown>;
}

/**
 * Returns the nudge action for the given room + member state.
 * Blocked missions or agents get the recovery-nudge API path;
 * cancelled missions get no-op; everyone else gets a chat check-in.
 */
export function nudgeAction(room: MissionRoom, member: MissionMember): NudgeAction {
  if (room.status === 'cancelled') return { kind: 'noop' };
  const needsRecovery = room.status === 'blocked' || member.state === 'blocked';
  if (needsRecovery) {
    return { kind: 'recovery' };
  }
  return {
    kind: 'chat',
    message: `@${member.name} quick check-in — how's it going? Anything I can clear for you?`,
  };
}

/**
 * Executes the nudge action by calling the injected API deps.
 * Returns true if the nudge succeeded (caller closes menu);
 * returns false for no-op (cancelled room);
 * throws on API failure (caller surfaces error, menu stays open).
 *
 * Guarantees:
 *   - Exactly one of nudgeMission/postMessage is called (never both, never neither, except noop).
 *   - nudgeMission receives room.id.
 *   - postMessage receives room.id and the chat message.
 *   - Cancelled room: neither is called.
 */
export async function executeNudge(
  room: MissionRoom,
  member: MissionMember,
  deps: NudgeDeps,
): Promise<boolean> {
  const action = nudgeAction(room, member);
  if (action.kind === 'noop') return false;
  if (action.kind === 'recovery') {
    await deps.nudgeMission(room.id);
    return true;
  }
  await deps.postMessage(room.id, action.message);
  return true;
}

/**
 * Returns the UI hint string for the Nudge button, reflecting the
 * action that will be taken when clicked.
 */
export function nudgeHint(room: MissionRoom, member: MissionMember): string {
  const action = nudgeAction(room, member);
  if (action.kind === 'recovery') return 'Force a retry';
  if (action.kind === 'noop') return 'Mission cancelled';
  return 'A friendly check-in';
}
