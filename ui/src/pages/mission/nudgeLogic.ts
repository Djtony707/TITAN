/**
 * TITAN — Nudge action decision logic (v6.1.0-alpha.42, Bug #5).
 *
 * Pure functions that decide which nudge path to take based on mission
 * and member state. Extracted from AgentMenu.tsx so the branching logic
 * is unit-testable without a DOM/jsdom environment.
 *
 * Two paths:
 *   - 'recovery' — mission or agent is blocked; call nudgeMission() which
 *     hits POST /api/missions/:id/nudge to force a driver tick.
 *   - 'chat' — normal state; send a friendly @mention check-in via
 *     postMessage().
 */
import type { MissionMember, MissionRoom } from '@/api/missions';

export type NudgeAction =
  | { kind: 'recovery' }
  | { kind: 'chat'; message: string };

/**
 * Returns the nudge action for the given room + member state.
 * Blocked missions or agents get the recovery-nudge API path;
 * everyone else gets a chat check-in.
 */
export function nudgeAction(room: MissionRoom, member: MissionMember): NudgeAction {
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
 * Returns the UI hint string for the Nudge button, reflecting the
 * action that will be taken when clicked.
 */
export function nudgeHint(room: MissionRoom, member: MissionMember): string {
  const action = nudgeAction(room, member);
  return action.kind === 'recovery' ? 'Force a retry' : 'A friendly check-in';
}
