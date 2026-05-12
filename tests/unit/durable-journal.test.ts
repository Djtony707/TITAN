/**
 * v6.0 CP upgrade #4 — durable journal unit tests.
 *
 * Pins per-context append, replay, and the pure-fold property:
 * `replayGoal === history.reduce(applyEventToGoalState, seed)`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    recordJournalEvent,
    readJournal,
    replayGoal,
    applyEventToGoalState,
    type JournalEvent,
    type GoalReplayState,
} from '../../src/agent/durableJournal.js';

let TMP_HOME = '';
let SAVED_HOME = '';

beforeEach(() => {
    SAVED_HOME = process.env.HOME || '';
    TMP_HOME = mkdtempSync(join(tmpdir(), 'titan-journal-test-'));
    process.env.HOME = TMP_HOME;
    process.env.TITAN_HOME = join(TMP_HOME, '.titan');
    mkdirSync(join(TMP_HOME, '.titan'), { recursive: true });
});

afterEach(() => {
    rmSync(TMP_HOME, { recursive: true, force: true });
    process.env.HOME = SAVED_HOME;
    delete process.env.TITAN_HOME;
});

describe('durableJournal — recordJournalEvent + readJournal', () => {
    it('writes per-goal shard when goalId scope is provided', () => {
        recordJournalEvent({ goalId: 'g-1' }, 'task_started', { agentId: 'sage' });
        const events = readJournal('goals', 'g-1');
        expect(events.length).toBe(1);
        expect(events[0].kind).toBe('task_started');
        expect((events[0].payload as { agentId?: string }).agentId).toBe('sage');
    });

    it('writes to multiple scopes from a single call', () => {
        recordJournalEvent(
            { goalId: 'g-1', agentId: 'sage', sessionId: 's-abc' },
            'tool_called',
            { tool: 'shell' },
        );
        expect(readJournal('goals', 'g-1').length).toBe(1);
        expect(readJournal('agents', 'sage').length).toBe(1);
        expect(readJournal('sessions', 's-abc').length).toBe(1);
    });

    it('appends rather than overwriting', () => {
        recordJournalEvent({ goalId: 'g-2' }, 'task_started', {});
        recordJournalEvent({ goalId: 'g-2' }, 'tool_called', { tool: 'shell' });
        recordJournalEvent({ goalId: 'g-2' }, 'task_completed', {});
        expect(readJournal('goals', 'g-2').length).toBe(3);
    });

    it('skips writes when no scope is set (no orphan files)', () => {
        recordJournalEvent({}, 'task_started', {});
        const journalDir = join(TMP_HOME, '.titan', 'journals');
        expect(existsSync(journalDir)).toBe(false);
    });

    it('returns empty array when no journal exists', () => {
        expect(readJournal('goals', 'never-existed')).toEqual([]);
    });

    it('sanitizes path-traversal attempts in id', () => {
        recordJournalEvent({ goalId: '../../../etc/passwd' }, 'task_started', {});
        const journalsDir = join(TMP_HOME, '.titan', 'journals', 'goals');
        const files = require('fs').readdirSync(journalsDir);
        // The id should have been sanitized — no `..` in the resulting filename.
        for (const f of files) {
            expect(f).not.toContain('..');
        }
    });

    it('tolerates a malformed jsonl line without crashing the replay', () => {
        recordJournalEvent({ goalId: 'g-malformed' }, 'task_started', {});
        // Inject a junk line directly
        const path = join(TMP_HOME, '.titan', 'journals', 'goals', 'g-malformed.jsonl');
        require('fs').appendFileSync(path, 'NOT_JSON_AT_ALL\n');
        recordJournalEvent({ goalId: 'g-malformed' }, 'task_completed', {});
        const events = readJournal('goals', 'g-malformed');
        // The two valid events survive; the junk line is skipped.
        expect(events.length).toBe(2);
    });
});

describe('durableJournal — applyEventToGoalState (pure fold)', () => {
    const seed: GoalReplayState = {
        goalId: 'g-test',
        completed: false,
        failed: false,
        currentAgentId: null,
        toolCallCount: 0,
        subAgentCount: 0,
        stepStatus: {},
        lessonsRecorded: [],
        lastEventAt: null,
        eventCount: 0,
    };

    const evt = (kind: JournalEvent['kind'], payload: Record<string, unknown> = {}): JournalEvent => ({
        at: '2026-05-11T17:00:00.000Z',
        kind,
        payload,
    });

    it('task_started sets currentAgentId + clears failed', () => {
        const after = applyEventToGoalState({ ...seed, failed: true }, evt('task_started', { agentId: 'sage' }));
        expect(after.currentAgentId).toBe('sage');
        expect(after.failed).toBe(false);
    });

    it('task_completed flips completed = true', () => {
        const after = applyEventToGoalState(seed, evt('task_completed'));
        expect(after.completed).toBe(true);
    });

    it('task_failed flips failed = true (but completed stays false)', () => {
        const after = applyEventToGoalState(seed, evt('task_failed'));
        expect(after.failed).toBe(true);
        expect(after.completed).toBe(false);
    });

    it('tool_called and subagent_spawned increment counters', () => {
        let s = applyEventToGoalState(seed, evt('tool_called'));
        s = applyEventToGoalState(s, evt('tool_called'));
        s = applyEventToGoalState(s, evt('subagent_spawned'));
        expect(s.toolCallCount).toBe(2);
        expect(s.subAgentCount).toBe(1);
    });

    it('plan_step_updated records the latest status per step', () => {
        let s = applyEventToGoalState(seed, evt('plan_step_updated', { stepId: 's1', status: 'in_progress' }));
        s = applyEventToGoalState(s, evt('plan_step_updated', { stepId: 's1', status: 'done' }));
        s = applyEventToGoalState(s, evt('plan_step_updated', { stepId: 's2', status: 'in_progress' }));
        expect(s.stepStatus).toEqual({ s1: 'done', s2: 'in_progress' });
    });

    it('lesson_recorded appends to lessonsRecorded', () => {
        const s = applyEventToGoalState(seed, evt('lesson_recorded', { text: 'Always run typecheck first.' }));
        expect(s.lessonsRecorded).toEqual(['Always run typecheck first.']);
    });

    it('eventCount + lastEventAt update on every event', () => {
        let s = applyEventToGoalState(seed, evt('tool_called'));
        s = applyEventToGoalState(s, evt('tool_result'));
        expect(s.eventCount).toBe(2);
        expect(s.lastEventAt).toBe('2026-05-11T17:00:00.000Z');
    });

    it('purity — same input yields same output (no shared refs leak)', () => {
        const s1 = applyEventToGoalState(seed, evt('lesson_recorded', { text: 'a' }));
        const s2 = applyEventToGoalState(seed, evt('lesson_recorded', { text: 'a' }));
        expect(s1).toEqual(s2);
        // seed must not have been mutated
        expect(seed.lessonsRecorded).toEqual([]);
    });
});

describe('durableJournal — replayGoal reconstructs state from disk alone', () => {
    it('a fresh process call yields the same state as a hot fold', () => {
        recordJournalEvent({ goalId: 'g-replay' }, 'task_started', { agentId: 'sage' });
        recordJournalEvent({ goalId: 'g-replay' }, 'tool_called', { tool: 'shell' });
        recordJournalEvent({ goalId: 'g-replay' }, 'tool_called', { tool: 'read_file' });
        recordJournalEvent({ goalId: 'g-replay' }, 'plan_step_updated', { stepId: 's1', status: 'done' });
        recordJournalEvent({ goalId: 'g-replay' }, 'lesson_recorded', { text: 'Pinned vitest 2.1 avoided OOM.' });

        const replayed = replayGoal('g-replay');
        expect(replayed.currentAgentId).toBe('sage');
        expect(replayed.toolCallCount).toBe(2);
        expect(replayed.stepStatus).toEqual({ s1: 'done' });
        expect(replayed.lessonsRecorded.length).toBe(1);
        expect(replayed.eventCount).toBe(5);
        expect(replayed.completed).toBe(false);
        expect(replayed.failed).toBe(false);
    });

    it('replay of a completed goal reflects completion', () => {
        recordJournalEvent({ goalId: 'g-done' }, 'task_started', { agentId: 'a' });
        recordJournalEvent({ goalId: 'g-done' }, 'task_completed', {});
        expect(replayGoal('g-done').completed).toBe(true);
    });

    it('on-disk format is one JSON object per line (greppable)', () => {
        recordJournalEvent({ goalId: 'g-fmt' }, 'task_started', { agentId: 'a' });
        const path = join(TMP_HOME, '.titan', 'journals', 'goals', 'g-fmt.jsonl');
        const raw = readFileSync(path, 'utf-8');
        expect(raw.trim().split('\n').length).toBe(1);
        // Each line is parseable
        const parsed = JSON.parse(raw.trim());
        expect(parsed.kind).toBe('task_started');
        expect(typeof parsed.at).toBe('string');
    });
});
