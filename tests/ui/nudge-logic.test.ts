/**
 * Tests for nudge action decision logic (Bug #5, May 2026 audit).
 *
 * Verifies that AgentMenu's nudge button takes the correct path:
 *   - blocked mission/member → recovery-nudge API (nudgeMission)
 *   - normal state → chat check-in (postMessage)
 *   - hint string reflects the action
 *
 * No DOM/jsdom needed — exercises the pure decision functions.
 */
import { describe, it, expect } from 'vitest';
import { nudgeAction, nudgeHint } from '../../ui/src/pages/mission/nudgeLogic';
import type { MissionMember, MissionRoom } from '../../ui/src/api/missions';

function makeRoom(overrides: Partial<MissionRoom> = {}): MissionRoom {
  return {
    schemaVersion: 1,
    id: 'm-test',
    goal: 'Test goal',
    status: 'working',
    team: [],
    artifact: {
      format: 'markdown',
      content: '',
      snapshots: [],
      updatedAt: '2026-01-01T00:00:00Z',
    },
    messages: [],
    cost: { tokens: 0, usd: 0 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMember(overrides: Partial<MissionMember> = {}): MissionMember {
  return {
    agentId: 'writer',
    name: 'Writer',
    role: 'Writer',
    color: '#6366f1',
    state: 'idle',
    ...overrides,
  };
}

describe('nudgeAction (Bug #5 — recovery vs chat nudge)', () => {
  it('returns recovery when mission status is blocked', () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'working' });
    const action = nudgeAction(room, member);
    expect(action.kind).toBe('recovery');
  });

  it('returns recovery when agent state is blocked', () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'blocked' });
    const action = nudgeAction(room, member);
    expect(action.kind).toBe('recovery');
  });

  it('returns recovery when both mission and agent are blocked', () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'blocked' });
    const action = nudgeAction(room, member);
    expect(action.kind).toBe('recovery');
  });

  it('returns chat when mission is working and agent is idle', () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'idle' });
    const action = nudgeAction(room, member);
    expect(action.kind).toBe('chat');
    if (action.kind === 'chat') {
      expect(action.message).toContain('@Writer');
      expect(action.message).toContain('check-in');
    }
  });

  it('returns chat when mission is done and agent is working', () => {
    const room = makeRoom({ status: 'done' });
    const member = makeMember({ state: 'working' });
    const action = nudgeAction(room, member);
    expect(action.kind).toBe('chat');
  });

  it('returns chat when mission is paused and agent is editing', () => {
    const room = makeRoom({ status: 'paused' });
    const member = makeMember({ state: 'editing' });
    const action = nudgeAction(room, member);
    expect(action.kind).toBe('chat');
  });

  it('does not call postMessage path when blocked (action is recovery, not chat)', () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'blocked' });
    const action = nudgeAction(room, member);
    // The recovery action has no message field — callers must use
    // nudgeMission(), not postMessage()
    expect(action.kind).toBe('recovery');
    expect('message' in action).toBe(false);
  });
});

describe('nudgeHint (Bug #5 — button label)', () => {
  it('shows "Force a retry" when mission is blocked', () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'working' });
    expect(nudgeHint(room, member)).toBe('Force a retry');
  });

  it('shows "Force a retry" when agent is blocked', () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'blocked' });
    expect(nudgeHint(room, member)).toBe('Force a retry');
  });

  it('shows "A friendly check-in" when normal', () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'idle' });
    expect(nudgeHint(room, member)).toBe('A friendly check-in');
  });

  it('shows "A friendly check-in" when mission is done', () => {
    const room = makeRoom({ status: 'done' });
    const member = makeMember({ state: 'done' });
    expect(nudgeHint(room, member)).toBe('A friendly check-in');
  });
});
