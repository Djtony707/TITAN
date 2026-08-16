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
import { nudgeAction, executeNudge, performNudge, nudgeHint } from '../../ui/src/pages/mission/nudgeLogic';
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

function makeCallbacks() {
  return {
    onClose: vi.fn(),
    onError: vi.fn(),
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

// ── Orchestration boundary: performNudge (criterion 3 — observable) ──
//
// performNudge wraps executeNudge with the onClose/onError callbacks
// that AgentMenu provides. These tests assert the OBSERVABLE side effects
// (onClose called, onError called with the right message) — not just
// that executeNudge throws. This is the exact boundary AgentMenu calls.

describe('performNudge — success (criterion 3: onClose called, onError not)', () => {
  it('blocked success: calls onClose once, onError zero, nudgeMission once, postMessage zero', async () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'blocked' });
    const deps = makeDeps();
    const cb = makeCallbacks();

    await performNudge(room, member, deps, cb);

    expect(cb.onClose).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
    expect(deps.nudgeMission).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('normal success: calls onClose once, onError zero, postMessage once, nudgeMission zero', async () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'idle' });
    const deps = makeDeps();
    const cb = makeCallbacks();

    await performNudge(room, member, deps, cb);

    expect(cb.onClose).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.nudgeMission).not.toHaveBeenCalled();
  });
});

describe('performNudge — rejection (criterion 3: onClose zero, onError with message)', () => {
  it('blocked rejection: nudgeMission throws → onClose zero, onError called with error message', async () => {
    const room = makeRoom({ status: 'blocked' });
    const member = makeMember({ state: 'blocked' });
    const deps = makeDeps();
    deps.nudgeMission.mockRejectedValue(new Error('HTTP 500: internal error'));
    const cb = makeCallbacks();

    await performNudge(room, member, deps, cb);

    expect(cb.onClose).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError).toHaveBeenCalledWith('HTTP 500: internal error');
    expect(deps.nudgeMission).toHaveBeenCalledTimes(1);
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('normal rejection: postMessage throws → onClose zero, onError called with error message', async () => {
    const room = makeRoom({ status: 'working' });
    const member = makeMember({ state: 'idle' });
    const deps = makeDeps();
    deps.postMessage.mockRejectedValue(new Error('HTTP 403: forbidden'));
    const cb = makeCallbacks();

    await performNudge(room, member, deps, cb);

    expect(cb.onClose).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onError).toHaveBeenCalledWith('HTTP 403: forbidden');
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.nudgeMission).not.toHaveBeenCalled();
  });
});

describe('performNudge — cancelled room (boundary: no callbacks fired)', () => {
  it('cancelled: onClose zero, onError zero, neither API called', async () => {
    const room = makeRoom({ status: 'cancelled' });
    const member = makeMember({ state: 'blocked' });
    const deps = makeDeps();
    const cb = makeCallbacks();

    await performNudge(room, member, deps, cb);

    expect(cb.onClose).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(deps.nudgeMission).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
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
