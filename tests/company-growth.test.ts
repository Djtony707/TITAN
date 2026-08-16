/**
 * v8 Slice 8 — growth moments + huddle digest.
 *
 * Production-path: real CompanyLog ({ brain: true, queue: true }), real
 * identities, real delegated/checked task events (queue-mode payload rules
 * honored). Determinism: same log → same feed and same digest.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { bus } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require('events');
    return { bus: new EventEmitter() };
});
vi.mock('../src/agent/daemon.js', () => ({ titanEvents: bus }));

import { CompanyLog } from '../src/company/log.js';
import { loadAgentKeys } from '../src/company/keys.js';
import { mintCompany } from '../src/company/crew.js';
import { hireAgent, retireAgent } from '../src/company/hiring.js';
import { appendBrainEntry } from '../src/company/brain.js';
import { growthMoments, huddleDigest } from '../src/company/growth.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-growth-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function scenario() {
    caseId += 1;
    const home = join(ROOT, `case-${caseId}`);
    const keysDir = join(home, 'company', 'keys');
    const log = new CompanyLog(home, keysDir, { brain: true, queue: true });
    mintCompany(log, keysDir, { name: 'GrowthCo' });
    const user = loadAgentKeys('user', keysDir);
    const ceo = loadAgentKeys('ceo', keysDir);
    const scout = loadAgentKeys('scout', keysDir);
    return { home, keysDir, log, user, ceo, scout };
}

/** Delegate + accept one task for `owner` through the real queue kinds.
 *  Returns the taskRef (= the delegation event's id, per queue contract). */
function acceptTask(s: ReturnType<typeof scenario>, owner: string, label: string): string {
    const del = s.log.append({ kind: 'task.delegated', actor: 'ceo', payload: { from: 'ceo', to: owner, spec: `do ${label}`, queueMode: true } }, s.ceo.privateKey);
    const ref = del.id;
    s.log.append({ kind: 'task.started', actor: owner, payload: { taskRef: ref, attempt: 1 } }, loadAgentKeys(owner, s.keysDir).privateKey);
    s.log.append({ kind: 'task.result', actor: owner, payload: { taskRef: ref, attempt: 1, content: 'done' } }, loadAgentKeys(owner, s.keysDir).privateKey);
    s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: ref, attempt: 1, verdict: 'accepted' } }, s.ceo.privateKey);
    return ref;
}

describe('growthMoments', () => {
    it('derives hire, first-accept, lesson, streak, and farewell moments', () => {
        const s = scenario();
        hireAgent(s.log, s.keysDir, 'ceo', s.ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing', charter: 'Writes.',
        });
        acceptTask(s, 'scout', 't1');
        acceptTask(s, 'scout', 't2');
        acceptTask(s, 'scout', 't3');
        appendBrainEntry(s.log, 'scout', s.scout.privateKey, {
            entryKind: 'lesson', text: 'PDF exports need the print stylesheet', scope: 'company',
        });
        retireAgent(s.log, 'ceo', s.ceo.privateKey, { agentId: 'quill', reason: 'season wrap' });

        const kinds = growthMoments(s.log).map(m => m.kind).sort();
        expect(kinds).toEqual(['first-accept', 'hired', 'lesson', 'retired', 'streak'].sort());
        const texts = growthMoments(s.log).map(m => m.text).join('\n');
        expect(texts).toContain('Quill joined the company as writing');
        expect(texts).toContain('shipped their first accepted task');
        expect(texts).toContain('on a roll — 3 accepted in a row');
        expect(texts).toContain('learned a pattern: PDF exports need the print stylesheet');
        expect(texts).toContain('wrapped up — season wrap');
    });

    it('a needs-work verdict breaks the streak; private lessons are not broadcast', () => {
        const s = scenario();
        acceptTask(s, 'scout', 'a1');
        acceptTask(s, 'scout', 'a2');
        // needs-work resets the streak before the third accept
        const del3 = s.log.append({ kind: 'task.delegated', actor: 'ceo', payload: { from: 'ceo', to: 'scout', spec: 'x', queueMode: true } }, s.ceo.privateKey);
        s.log.append({ kind: 'task.started', actor: 'scout', payload: { taskRef: del3.id, attempt: 1 } }, s.scout.privateKey);
        s.log.append({ kind: 'task.result', actor: 'scout', payload: { taskRef: del3.id, attempt: 1, content: 'meh' } }, s.scout.privateKey);
        s.log.append({ kind: 'task.checked', actor: 'ceo', payload: { taskRef: del3.id, attempt: 1, verdict: 'needs-work' } }, s.ceo.privateKey);
        acceptTask(s, 'scout', 'a4');
        appendBrainEntry(s.log, 'scout', s.scout.privateKey, {
            entryKind: 'lesson', text: 'my secret technique', scope: 'private',
        });

        const moments = growthMoments(s.log);
        expect(moments.some(m => m.kind === 'streak')).toBe(false);
        expect(moments.some(m => m.text.includes('secret technique'))).toBe(false);
    });

    it('is deterministic', () => {
        const s = scenario();
        acceptTask(s, 'scout', 'd1');
        expect(JSON.stringify(growthMoments(s.log))).toBe(JSON.stringify(growthMoments(s.log)));
    });
});

describe('huddleDigest', () => {
    it('summarizes accepted/open/lessons per agent with fresh lessons and roster changes', () => {
        const s = scenario();
        hireAgent(s.log, s.keysDir, 'ceo', s.ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing', charter: 'W.',
        });
        acceptTask(s, 'scout', 'h1');
        // open (unchecked) task for builder
        s.log.append({ kind: 'task.delegated', actor: 'ceo', payload: { from: 'ceo', to: 'builder', spec: 'build it', queueMode: true } }, s.ceo.privateKey);
        appendBrainEntry(s.log, 'scout', s.scout.privateKey, {
            entryKind: 'lesson', text: 'retry storms come from gateway timeouts', scope: 'company',
        });

        const d = huddleDigest(s.log);
        const scoutLine = d.agents.find(a => a.agentId === 'scout')!;
        expect(scoutLine).toMatchObject({ accepted: 1, lessons: 1 });
        expect(d.agents.find(a => a.agentId === 'builder')).toMatchObject({ open: 1 });
        expect(d.freshLessons.some(l => l.text.includes('retry storms'))).toBe(true);
        expect(d.rosterChanges.join(' ')).toContain('+ Quill');
        expect(d.rendered).toContain('## Huddle');
        expect(d.rendered).toContain('**Scout**');
    });

    it('an empty window renders the quiet-day line', () => {
        const s = scenario();
        acceptTask(s, 'scout', 'old1');
        // Window that excludes everything (starts in the future).
        const d = huddleDigest(s.log, { now: Date.now() + 10 * 60_000, windowMs: 1 });
        expect(d.rendered).toContain('Quiet day');
        // Open-task count still reflects the whole log (none open here).
        expect(d.agents).toHaveLength(0);
    });
});
