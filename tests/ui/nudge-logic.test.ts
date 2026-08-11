/**
 * Behavioral tests for Bug #5 — AgentMenu nudge action.
 *
 * Honey's 3 acceptance criteria:
 *   1. blocked state invokes nudgeMission(room.id) and not postMessage
 *   2. normal state invokes postMessage and not nudgeMission
 *   3. a rejected request throws (error surfaced, menu stays open)
 *
 * No DOM/jsdom needed — exercises executeNudge with injected spy deps,
 * asserting actual call counts, arguments, exclusivity, and rejection.
 */
import { describe, it, expect, vi } from 'vitest';
import { nudgeAction, executeNudge, nudgeHint } from '../../ui/src/pages/mission/nudgeLogic';
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

function makeDeps() {
  return {
    nudgeMission: vi.fn().mockResolvedValue({ ok: true }),
    postMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
}

// ── Acceptance criterion 1: blocked → recovery, not chat ──────────

describe('executeNudge — blocked state (criterion 1)', () => {
  it('calls nudgeMission(room.id) and not postMessage when mission is blocked', async () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'working' });
    const deps = makeDeps();

    const result = await executeNudge(room, member, deps);

    expect(result).toBe(true);
    expect(deps.nudgeMission).toHaveBeenCalledTimes(1);
    expect(deps.nudgeMission).toHaveBeenCalledWith('m-test');
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('calls nudgeMission(room.id) and not postMessage when agent is blocked', async () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'blocked' });
    const deps = makeDeps();

    await executeNudge(room, member, deps);

    expect(deps.nudgeMission).toHaveBeenCalledTimes(1);
    expect(deps.nudgeMission).toHaveBeenCalledWith('m-test');
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('calls nudgeMission exactly once when both mission and agent are blocked', async () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'blocked' });
    const deps = makeDeps();

    await executeNudge(room, member, deps);

    expect(deps.nudgeMission).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).not.toHaveBeenCalled();
  });
});

// ── Acceptance criterion 2: normal → chat, not recovery ───────────

describe('executeNudge — normal state (criterion 2)', () => {
  it('calls postMessage(room.id, message) and not nudgeMission when working/idle', async () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'idle' });
    const deps = makeDeps();

    const result = await executeNudge(room, member, deps);

    expect(result).toBe(true);
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).toHaveBeenCalledWith('m-test', expect.stringContaining('@Writer'));
    expect(deps.postMessage).toHaveBeenCalledWith('m-test', expect.stringContaining('check-in'));
    expect(deps.nudgeMission).not.toHaveBeenCalled();
  });

  it('calls postMessage and not nudgeMission when done/done', async () => {
    const room = makeRoom({ status: 'done' });
    const member = makeMember({ state: 'done' });
    const deps = makeDeps();

    await executeNudge(room, member, deps);

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.nudgeMission).not.toHaveBeenCalled();
  });

  it('calls postMessage and not nudgeMission when paused/editing', async () => {
    const room = makeRoom({ status: 'paused' });
    const member = makeMember({ state: 'editing' });
    const deps = makeDeps();

    await executeNudge(room, member, deps);

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.nudgeMission).not.toHaveBeenCalled();
  });
});

// ── Acceptance criterion 3: rejected request throws ───────────────

describe('executeNudge — rejection (criterion 3)', () => {
  it('throws when nudgeMission rejects (error surfaces, caller can keep menu open)', async () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'blocked' });
    const deps = makeDeps();
    const apiError = new Error('HTTP 500: internal error');
    deps.nudgeMission.mockRejectedValue(apiError);

    await expect(executeNudge(room, member, deps)).rejects.toThrow('HTTP 500: internal error');

    // nudgeMission was called (attempted), postMessage was not
    expect(deps.nudgeMission).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('throws when postMessage rejects (error surfaces, caller can keep menu open)', async () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'idle' });
    const deps = makeDeps();
    const apiError = new Error('HTTP 403: forbidden');
    deps.postMessage.mockRejectedValue(apiError);

    await expect(executeNudge(room, member, deps)).rejects.toThrow('HTTP 403: forbidden');

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.nudgeMission).not.toHaveBeenCalled();
  });
});

// ── Cancelled room boundary ───────────────────────────────────────

describe('executeNudge — cancelled room (boundary)', () => {
  it('calls neither API when mission is cancelled', async () => {
    const room = makeRoom({ status: 'cancelled' });
    const member = makeMember({ state: 'blocked' });
    const deps = makeDeps();

    const result = await executeNudge(room, member, deps);

    expect(result).toBe(false);
    expect(deps.nudgeMission).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('nudgeAction returns noop for cancelled room even if agent is blocked', () => {
    const room = makeRoom({ status: 'cancelled' });
    const member = makeMember({ state: 'blocked' });
    expect(nudgeAction(room, member).kind).toBe('noop');
  });

  it('nudgeHint shows "Mission cancelled" for cancelled room', () => {
    const room = makeRoom({ status: 'cancelled' });
    const member = makeMember({ state: 'blocked' });
    expect(nudgeHint(room, member)).toBe('Mission cancelled');
  });
});

// ── Hint string ───────────────────────────────────────────────────

describe('nudgeHint (button label)', () => {
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
});
