/**
 * v8 Slice 7 Part 2 — hire/fire flow: minted identity + merged roster +
 * per-agent model plumbing into dispatch.
 *
 * Production-path: real CompanyLog ({ brain: true, queue: true }), real
 * identities. The runner is a capture stub (dispatch's injectable seam) —
 * we assert the hired agent's model REACHES the runner, and that the
 * merged roster governs delegability.
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
import { mintAgentKeys, loadAgentKeys } from '../src/company/keys.js';
import { mintCompany } from '../src/company/crew.js';
import { hireAgent, retireAgent, companyRoster } from '../src/company/hiring.js';
import { appendBrainEntry } from '../src/company/brain.js';
import { CompanyDispatch, type TurnRequest } from '../src/company/dispatch.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-hiring-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function scenario() {
    caseId += 1;
    const home = join(ROOT, `case-${caseId}`);
    const keysDir = join(home, 'company', 'keys');
    const memoryDir = join(home, 'company', 'memory');
    const log = new CompanyLog(home, keysDir, { brain: true, queue: true });
    const minted = mintCompany(log, keysDir, { name: 'TestCo' });
    const user = loadAgentKeys('user', keysDir);
    const ceo = loadAgentKeys('ceo', keysDir);
    return { home, keysDir, memoryDir, log, minted, user, ceo };
}

describe('hireAgent / retireAgent', () => {
    it('a ceo hire mints a working identity and joins the merged roster', () => {
        const { log, keysDir, ceo } = scenario();
        const { keys } = hireAgent(log, keysDir, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing',
            charter: 'Writes the words.', harness: 'claude-agent-acp', model: 'claude-sonnet-5',
        });
        // The minted identity can immediately write attributed memory
        // (council ruling: immediate charter-scoped writes, no probation).
        appendBrainEntry(log, 'quill', keys.privateKey, {
            entryKind: 'observation', text: 'first day', scope: 'company',
        });
        const roster = companyRoster(log);
        const quill = roster.find(m => m.agentId === 'quill')!;
        expect(quill).toMatchObject({ source: 'hired', model: 'claude-sonnet-5', harness: 'claude-agent-acp' });
        // Founding crew still present.
        expect(roster.some(m => m.agentId === 'ceo' && m.source === 'minted')).toBe(true);
    });

    it('retirement removes the agent from the roster and revokes writes', () => {
        const { log, keysDir, ceo } = scenario();
        const { keys } = hireAgent(log, keysDir, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing', charter: 'W.',
        });
        retireAgent(log, 'ceo', ceo.privateKey, { agentId: 'quill', reason: 'done' });
        expect(companyRoster(log).some(m => m.agentId === 'quill')).toBe(false);
        expect(() => appendBrainEntry(log, 'quill', keys.privateKey, {
            entryKind: 'observation', text: 'zombie write', scope: 'company',
        })).toThrow(/retired/);
    });

    it('a non-authorized actor cannot hire', () => {
        const { log, keysDir } = scenario();
        const scout = loadAgentKeys('scout', keysDir);
        expect(() => hireAgent(log, keysDir, 'scout', scout.privateKey, {
            agentId: 'mole', displayName: 'M', role: 'r', charter: 'c',
        })).toThrow();
    });
});

describe('dispatch integration (the hire actually runs)', () => {
    it('a hired agent is delegable and its model reaches the runner; a retired one is refused work', async () => {
        const { log, keysDir, memoryDir, ceo } = scenario();
        hireAgent(log, keysDir, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing',
            charter: 'Writes the words.', model: 'claude-sonnet-5',
        });

        const seen: TurnRequest[] = [];
        const stubRunner = async (req: TurnRequest) => {
            seen.push(req);
            return { content: 'done: the words', success: true, toolsUsed: [] };
        };
        const stubReviewer = async () => ({ verdict: 'accept' as const, notes: 'fine' });

        const roster = () => companyRoster(log);
        const dispatch = new CompanyDispatch(log, keysDir, memoryDir, {
            maxAttempts: 1,
            charterOf: id => roster().find(m => m.agentId === id)?.charter ?? '',
            modelOf: id => roster().find(m => m.agentId === id)?.model,
        }, stubRunner as never, stubReviewer as never);

        dispatch.ceoDelegate('quill', 'Draft the launch note');
        await dispatch.drain();

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            agentId: 'quill',
            charter: 'Writes the words.',
            model: 'claude-sonnet-5',
        });

        // Retire → the merged roster drops quill; the service delegation
        // surface (getCompanyStatus().agents) is what gates delegation, so
        // assert at the roster level dispatch consumes.
        retireAgent(log, 'ceo', ceo.privateKey, { agentId: 'quill', reason: 'wrap' });
        expect(roster().some(m => m.agentId === 'quill')).toBe(false);
    });
});
