/**
 * TITAN — trajectoryRecorder.ts unit tests (v6.1.0-beta.13)
 *
 * Covers the per-spawn JSONL recorder. We use vi.mock to redirect
 * TITAN_HOME to a temp directory so tests don't pollute the user's
 * real ~/.titan/trajectories/ folder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';

let TMP_HOME: string;

// Hoist tmp-dir creation so the mock can read it from module scope.
const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-traj-recorder-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

TMP_HOME = tmpHome;

import {
    startSpawnTrajectory,
    recordRound,
    recordToolCall,
    recordToolResult,
    recordNote,
    finishSpawnTrajectory,
    loadTrajectory,
    listTrajectories,
    trajectoryPathFor,
} from '../src/agent/trajectoryRecorder.js';

afterEach(() => {
    delete process.env.TITAN_TRAJECTORY_RECORD;
});

/* ───────────────────────── happy path ───────────────────────── */

describe('TrajectoryRecorder — happy path', () => {
    it('writes a start event when a trajectory begins', () => {
        const handle = startSpawnTrajectory({
            spawnId: 'spawn-happy-1',
            specialist: 'writer',
            model: 'stub/echo',
            task: 'write a paragraph',
            goalId: 'goal-1',
            toolNames: ['write_file'],
        });
        expect(handle.disabled).toBe(false);
        expect(existsSync(handle.path)).toBe(true);
        const events = loadTrajectory('spawn-happy-1');
        expect(events).not.toBeNull();
        expect(events).toHaveLength(1);
        expect(events![0].kind).toBe('start');
        if (events![0].kind === 'start') {
            expect(events![0].data.specialist).toBe('writer');
            expect(events![0].data.toolNames).toEqual(['write_file']);
        }
    });

    it('records a full round + tool_call + tool_result + finish sequence', () => {
        const handle = startSpawnTrajectory({
            spawnId: 'spawn-full',
            model: 'stub/echo',
            task: 't',
        });
        recordRound(handle, {
            roundNum: 1,
            promptBytes: 200,
            response: 'Calling write_file…',
            tokensUsed: 42,
            durationMs: 15,
        });
        recordToolCall(handle, {
            roundNum: 1,
            callId: 'tc-1',
            toolName: 'write_file',
            args: JSON.stringify({ path: '/tmp/x.txt', content: 'hi' }),
        });
        recordToolResult(handle, {
            callId: 'tc-1',
            content: 'Successfully wrote 2 bytes',
        });
        finishSpawnTrajectory(handle, {
            status: 'done',
            content: 'done',
            totalRounds: 1,
            toolsUsed: ['write_file'],
        });
        const events = loadTrajectory('spawn-full');
        expect(events).not.toBeNull();
        const kinds = events!.map(e => e.kind);
        expect(kinds).toEqual(['start', 'round', 'tool_call', 'tool_result', 'finish']);
        const finish = events![4];
        if (finish.kind !== 'finish') throw new Error('expected finish');
        expect(finish.data.status).toBe('done');
        expect(finish.data.durationMs).toBeGreaterThanOrEqual(0);
        expect(finish.data.toolsUsed).toEqual(['write_file']);
    });

    it('record helpers no-op cleanly when handle is disabled', () => {
        process.env.TITAN_TRAJECTORY_RECORD = '0';
        const handle = startSpawnTrajectory({
            spawnId: 'spawn-disabled',
            model: 'stub/echo',
            task: 'no file should appear',
        });
        expect(handle.disabled).toBe(true);
        expect(handle.path).toBe('');
        // None of these should throw or create a file.
        recordRound(handle, { roundNum: 1, promptBytes: 0, response: '' });
        recordToolCall(handle, { roundNum: 1, callId: 'tc', toolName: 'x', args: '{}' });
        recordToolResult(handle, { callId: 'tc', content: 'ok' });
        recordNote(handle, 'a breadcrumb');
        finishSpawnTrajectory(handle, {
            status: 'done', content: 'd', totalRounds: 0, toolsUsed: [],
        });
        // Verify no JSONL file was created for this id.
        const p = trajectoryPathFor('spawn-disabled');
        expect(existsSync(p)).toBe(false);
    });
});

/* ───────────────────────── reader API ───────────────────────── */

describe('TrajectoryRecorder — reader API', () => {
    it('loadTrajectory returns null for unknown spawnId', () => {
        expect(loadTrajectory('nope-doesnt-exist')).toBeNull();
    });

    it('listTrajectories returns headers across days (filtered by goalId)', () => {
        // Two spawns with goal A, one with goal B.
        const h1 = startSpawnTrajectory({ spawnId: 'list-A1', model: 'stub/echo', task: 't', goalId: 'A' });
        finishSpawnTrajectory(h1, { status: 'done', content: '', totalRounds: 0, toolsUsed: [] });
        const h2 = startSpawnTrajectory({ spawnId: 'list-A2', model: 'stub/echo', task: 't', goalId: 'A' });
        finishSpawnTrajectory(h2, { status: 'done', content: '', totalRounds: 0, toolsUsed: [] });
        const h3 = startSpawnTrajectory({ spawnId: 'list-B1', model: 'stub/echo', task: 't', goalId: 'B' });
        finishSpawnTrajectory(h3, { status: 'done', content: '', totalRounds: 0, toolsUsed: [] });

        const onlyA = listTrajectories({ goalId: 'A' });
        const aSpawns = onlyA.map(t => t.spawnId).sort();
        expect(aSpawns).toContain('list-A1');
        expect(aSpawns).toContain('list-A2');
        expect(aSpawns).not.toContain('list-B1');

        const limited = listTrajectories({ limit: 1 });
        expect(limited).toHaveLength(1);
    });

    it('listTrajectories honors the since filter', () => {
        const cutoff = Date.now() + 60_000; // in the future
        const h = startSpawnTrajectory({ spawnId: 'list-since', model: 'stub/echo', task: 't' });
        finishSpawnTrajectory(h, { status: 'done', content: '', totalRounds: 0, toolsUsed: [] });
        const futureOnly = listTrajectories({ since: cutoff });
        expect(futureOnly.find(t => t.spawnId === 'list-since')).toBeUndefined();
    });
});

/* ───────────────────────── size caps ───────────────────────── */

describe('TrajectoryRecorder — payload caps', () => {
    it('truncates oversized tool_call args', () => {
        const handle = startSpawnTrajectory({ spawnId: 'cap-args', model: 'stub/echo', task: 't' });
        const big = 'A'.repeat(8 * 1024); // 8 KB — twice the 2 KB cap
        recordToolCall(handle, { roundNum: 1, callId: 'tc', toolName: 'x', args: big });
        finishSpawnTrajectory(handle, { status: 'done', content: '', totalRounds: 1, toolsUsed: ['x'] });
        const events = loadTrajectory('cap-args');
        const call = events!.find(e => e.kind === 'tool_call');
        if (!call || call.kind !== 'tool_call') throw new Error('expected tool_call');
        expect(Buffer.byteLength(call.data.args, 'utf-8')).toBeLessThan(8 * 1024);
        expect(call.data.args).toMatch(/truncated to 2048b/);
    });

    it('truncates oversized tool_result content', () => {
        const handle = startSpawnTrajectory({ spawnId: 'cap-result', model: 'stub/echo', task: 't' });
        const big = 'B'.repeat(16 * 1024); // 16 KB — quadruple the 4 KB cap
        recordToolResult(handle, { callId: 'tc', content: big });
        finishSpawnTrajectory(handle, { status: 'done', content: '', totalRounds: 0, toolsUsed: [] });
        const events = loadTrajectory('cap-result');
        const r = events!.find(e => e.kind === 'tool_result');
        if (!r || r.kind !== 'tool_result') throw new Error('expected tool_result');
        expect(Buffer.byteLength(r.data.content, 'utf-8')).toBeLessThan(16 * 1024);
        expect(r.data.content).toMatch(/truncated to 4096b/);
    });
});

/* ───────────────────────── on-disk format ───────────────────────── */

describe('TrajectoryRecorder — on-disk JSONL format', () => {
    it('each line is a single JSON event, newline-delimited', () => {
        const handle = startSpawnTrajectory({ spawnId: 'fmt-1', model: 'stub/echo', task: 't' });
        recordRound(handle, { roundNum: 1, promptBytes: 0, response: 'r' });
        recordNote(handle, 'hi');
        finishSpawnTrajectory(handle, { status: 'done', content: '', totalRounds: 1, toolsUsed: [] });
        const path = trajectoryPathFor('fmt-1');
        const raw = readFileSync(path, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        expect(lines).toHaveLength(4);
        for (const line of lines) {
            // Every line must be standalone parseable JSON.
            expect(() => JSON.parse(line)).not.toThrow();
        }
    });
});

/* ───────────────────── path traversal safety (security) ───────────────────── */

describe('TrajectoryRecorder — path traversal safety (security)', () => {
    const root = () => resolve(join(TMP_HOME, 'trajectories'));

    it('trajectoryPathFor sanitizes a malicious spawnId so the resolved path stays under the trajectories root', () => {
        // Mirrors the real attack: spawnId is `${modelSuppliedName}-${Date.now()}`
        // (subAgent.ts), so a crafted spawn_agent `name` like this reaches
        // trajectoryPathFor verbatim.
        const malicious = '../../../etc/cron.d/x-1699999999999';
        const when = new Date('2026-01-01T00:00:00.000Z');
        const path = trajectoryPathFor(malicious, when);
        const resolved = resolve(path);
        expect(resolved === root() || resolved.startsWith(root() + sep)).toBe(true);
        // The filename component must not smuggle any new path segment.
        const fileName = path.slice(path.lastIndexOf(sep) + 1);
        expect(fileName).not.toContain('/');
        expect(fileName).not.toContain('\\');
        expect(fileName.startsWith('.')).toBe(false);
    });

    it('startSpawnTrajectory cannot be made to write outside the trajectories root via a malicious spawnId', () => {
        const malicious = '../../../../../../../../tmp/titan-traversal-pwned';
        const handle = startSpawnTrajectory({ spawnId: malicious, model: 'stub/echo', task: 'pwn' });
        finishSpawnTrajectory(handle, { status: 'done', content: '', totalRounds: 0, toolsUsed: [] });

        // Recording must still have succeeded (degrades to disabled only on
        // an unverified path, which sanitization should never produce).
        expect(handle.disabled).toBe(false);
        const resolved = resolve(handle.path);
        expect(resolved === root() || resolved.startsWith(root() + sep)).toBe(true);
        expect(existsSync(handle.path)).toBe(true);

        // Confirm nothing landed at the naive (unsanitized) traversal target.
        expect(existsSync(join('/tmp', 'titan-traversal-pwned.jsonl'))).toBe(false);
        expect(existsSync(join('/tmp', 'titan-traversal-pwned'))).toBe(false);
    });

    it('sanitization round-trips: loadTrajectory finds a trajectory recorded under a traversal-laden spawnId', () => {
        const malicious = '../../../root/.ssh/authorized_keys';
        const handle = startSpawnTrajectory({ spawnId: malicious, model: 'stub/echo', task: 't' });
        finishSpawnTrajectory(handle, { status: 'done', content: 'ok', totalRounds: 0, toolsUsed: [] });
        const events = loadTrajectory(malicious);
        expect(events).not.toBeNull();
        expect(events!.map(e => e.kind)).toEqual(['start', 'finish']);
    });

    it('falls back to a safe name when sanitization would otherwise empty the spawnId', () => {
        // Allowed chars are [a-zA-Z0-9._-]; dots survive the allowlist pass
        // unchanged, so a spawnId of pure dots is the case that actually
        // collapses to empty once leading dots are stripped (a mixed id like
        // "../../.." still leaves "_.._.." behind — non-empty, just harmless).
        const allDots = '...';
        const handle = startSpawnTrajectory({ spawnId: allDots, model: 'stub/echo', task: 't' });
        expect(handle.disabled).toBe(false);
        const resolved = resolve(handle.path);
        expect(resolved === root() || resolved.startsWith(root() + sep)).toBe(true);
        const fileName = handle.path.slice(handle.path.lastIndexOf(sep) + 1);
        expect(fileName).toBe('unknown-spawn.jsonl');
    });

    it('neutralizes a pure "../../.." spawnId without ever needing the fallback (still stays within root)', () => {
        const allTraversal = '../../..';
        const handle = startSpawnTrajectory({ spawnId: allTraversal, model: 'stub/echo', task: 't' });
        expect(handle.disabled).toBe(false);
        const resolved = resolve(handle.path);
        expect(resolved === root() || resolved.startsWith(root() + sep)).toBe(true);
        const fileName = handle.path.slice(handle.path.lastIndexOf(sep) + 1);
        expect(fileName).not.toContain('/');
        expect(fileName).not.toContain('\\');
        expect(fileName.startsWith('.')).toBe(false);
    });
});

/* ───────────────────── malformed JSONL resilience ───────────────────── */

describe('TrajectoryRecorder — malformed JSONL resilience', () => {
    it('readJsonl skips a corrupt line instead of discarding the whole trajectory', () => {
        const handle = startSpawnTrajectory({ spawnId: 'malformed-line', model: 'stub/echo', task: 't' });
        recordNote(handle, 'first note');
        // Inject a non-JSON line directly onto disk, simulating a partial
        // write / disk corruption between two well-formed events.
        appendFileSync(handle.path, 'THIS IS NOT VALID JSON {{{\n', 'utf-8');
        recordNote(handle, 'second note');
        finishSpawnTrajectory(handle, { status: 'done', content: '', totalRounds: 0, toolsUsed: [] });

        // Sanity: the corrupt line really is on disk, between the two notes.
        const raw = readFileSync(handle.path, 'utf-8');
        expect(raw).toContain('THIS IS NOT VALID JSON');

        const events = loadTrajectory('malformed-line');
        expect(events).not.toBeNull();
        // The 4 well-formed events survive; only the corrupt line is dropped —
        // a single bad line must not zero out the entire file (old behavior:
        // one JSON.parse throw inside the shared map() call discarded everything).
        expect(events!.map(e => e.kind)).toEqual(['start', 'note', 'note', 'finish']);
        const notes = events!.filter((e): e is Extract<typeof e, { kind: 'note' }> => e.kind === 'note');
        expect(notes.map(n => n.data.text)).toEqual(['first note', 'second note']);
    });

    it('returns an empty (not null) event list rather than throwing when every line is malformed', () => {
        // Use startSpawnTrajectory only to create the day-bucket dir + get a
        // real on-disk path, then blow away its contents with pure garbage —
        // isolates the "every line fails to parse" case from the "some lines
        // fail" case above.
        const handle = startSpawnTrajectory({ spawnId: 'all-malformed', model: 'stub/echo', task: 't' });
        writeFileSync(handle.path, 'not json at all\nalso not json\n{{{broken\n', 'utf-8');
        expect(() => loadTrajectory('all-malformed')).not.toThrow();
        const events = loadTrajectory('all-malformed');
        expect(events).not.toBeNull();
        expect(events).toEqual([]);
    });
});

/* ───────────────────────── tmp cleanup ───────────────────────── */

afterEach(() => {
    // Tests share TMP_HOME; we intentionally do NOT rm it between
    // tests because listTrajectories tests rely on accumulated state.
});

// Final cleanup: remove the temp home at the very end.
// (vitest runs afterAll at module scope.)
import { afterAll } from 'vitest';
afterAll(() => {
    if (TMP_HOME && existsSync(TMP_HOME)) {
        rmSync(TMP_HOME, { recursive: true, force: true });
    }
});
