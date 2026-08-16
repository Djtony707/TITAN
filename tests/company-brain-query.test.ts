/**
 * v8 Slice 7 Part 1 — brain projections + scoped retrieval.
 *
 * Production-path: real CompanyLog ({ brain: true }), real identities, real
 * FTS5 in brain.db. The security property under test: SCOPE — a principal
 * must never see another principal's private entries, on any read surface.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
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
import { mintAgentKeys } from '../src/company/keys.js';
import { appendBrainEntry, tombstoneBrainEntry } from '../src/company/brain.js';
import {
    queryBrain, brainTail, renderBrainForPrompt,
    rebuildBrainProjections, syncBrainProjections,
} from '../src/company/brainQuery.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-brain-query-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function scenario() {
    caseId += 1;
    const home = join(ROOT, `case-${caseId}`);
    const keysDir = join(home, 'company', 'keys');
    const user = mintAgentKeys('user', keysDir);
    const scout = mintAgentKeys('scout', keysDir);
    const builder = mintAgentKeys('builder', keysDir);
    const log = new CompanyLog(home, keysDir, { brain: true });
    return { home, user, scout, builder, log };
}

describe('scoped retrieval', () => {
    it('company entries are visible to everyone; private only to their author', () => {
        const { home, log, scout, builder } = scenario();
        appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'lesson', text: 'the relay requires wss for mobile clients', scope: 'company',
        });
        appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'observation', text: 'my private hunch about the relay bug', scope: 'private',
        });

        const asBuilder = queryBrain(home, log, { q: 'relay', principal: 'builder' });
        expect(asBuilder.map(h => h.scope)).toEqual(['company']);
        expect(asBuilder.some(h => h.text.includes('private hunch'))).toBe(false);

        const asScout = queryBrain(home, log, { q: 'relay', principal: 'scout' });
        expect(asScout.some(h => h.scope === 'private')).toBe(true);
        expect(asScout.some(h => h.scope === 'company')).toBe(true);
        void builder;
    });

    it('tombstoned entries disappear from search and tails', () => {
        const { home, log, scout } = scenario();
        const ev = appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'observation', text: 'retractable claim about quasars', scope: 'company',
        });
        expect(queryBrain(home, log, { q: 'quasars', principal: 'scout' })).toHaveLength(1);
        tombstoneBrainEntry(log, 'scout', scout.privateKey, { targetId: ev.id, reason: 'wrong' });
        expect(queryBrain(home, log, { q: 'quasars', principal: 'scout' })).toHaveLength(0);
        expect(brainTail(home, log, 'scout', 10)).toHaveLength(0);
    });

    it('FTS operator injection in the query string is neutralized', () => {
        const { home, log, scout } = scenario();
        appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'lesson', text: 'ordinary searchable text', scope: 'company',
        });
        // None of these may throw or over-match.
        expect(() => queryBrain(home, log, { q: 'text OR "', principal: 'scout' })).not.toThrow();
        expect(() => queryBrain(home, log, { q: 'a* NEAR( b', principal: 'scout' })).not.toThrow();
        expect(() => queryBrain(home, log, { q: '   ', principal: 'scout' })).not.toThrow();
    });

    it('rejects an invalid principal (containment gate)', () => {
        const { home, log } = scenario();
        expect(() => queryBrain(home, log, { q: 'x', principal: '../evil' })).toThrow(/invalid agentId/);
    });
});

describe('projections lifecycle', () => {
    it('rebuild from genesis equals incremental fold (events are truth)', () => {
        const { home, log, scout, builder } = scenario();
        appendBrainEntry(log, 'scout', scout.privateKey, { entryKind: 'lesson', text: 'alpha fact', scope: 'company' });
        appendBrainEntry(log, 'builder', builder.privateKey, { entryKind: 'decision', text: 'beta choice', scope: 'company' });
        const incremental = queryBrain(home, log, { q: 'alpha OR beta', principal: 'scout' })
            .map(h => h.eventId).sort();

        rebuildBrainProjections(home, log);
        const rebuilt = queryBrain(home, log, { q: 'alpha OR beta', principal: 'scout' })
            .map(h => h.eventId).sort();
        expect(rebuilt).toEqual(incremental);
        expect(rebuilt.length).toBe(2);
    });

    it('deleting brain.db loses nothing — reads self-heal from the log', () => {
        const { home, log, scout } = scenario();
        appendBrainEntry(log, 'scout', scout.privateKey, { entryKind: 'lesson', text: 'durable knowledge', scope: 'company' });
        syncBrainProjections(home, log);
        const dbPath = join(home, 'company', 'brain.db');
        expect(existsSync(dbPath)).toBe(true);
        rmSync(dbPath);
        const hits = queryBrain(home, log, { q: 'durable', principal: 'scout' });
        expect(hits).toHaveLength(1);
    });
});

describe('prompt rendering', () => {
    it('pools attributed company knowledge with the agent own stream', () => {
        const { home, log, scout, builder } = scenario();
        appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'lesson', text: 'deploys fail on Fridays because of the cron window', scope: 'company',
        });
        appendBrainEntry(log, 'builder', builder.privateKey, {
            entryKind: 'observation', text: 'I started the deploy checklist', scope: 'private',
        });
        const block = renderBrainForPrompt(home, log, 'builder', 'deploys');
        expect(block).toContain('scout learned: deploys fail on Fridays');
        expect(block).toContain('[observation] I started the deploy checklist');
        // Scout's name is attributed; builder's own entries are not re-attributed.
        expect(block).toContain('Company knowledge');
        expect(block).toContain('Your recent memory');
    });

    it('returns empty string when there is nothing to say', () => {
        const { home, log } = scenario();
        expect(renderBrainForPrompt(home, log, 'user')).toBe('');
    });
});
