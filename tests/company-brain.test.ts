/**
 * v8 Slice 7 Part 1 — Company brain store: validator rules, fold, revocation.
 *
 * Production-path: a REAL CompanyLog on a per-case TITAN_HOME with
 * { brain: true }, real minted ed25519 identities, no hand-set state.
 * Every rule in the spec's validator table gets a positive and a negative.
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
import { mintAgentKeys } from '../src/company/keys.js';
import {
    appendBrainEntry, tombstoneBrainEntry, appendAgentHired, appendAgentRetired,
    foldBrain, BRAIN_MAX_TEXT,
} from '../src/company/brain.js';

const ROOT = mkdtempSync(join(tmpdir(), 'titan-company-brain-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
function scenario() {
    caseId += 1;
    const home = join(ROOT, `case-${caseId}`);
    const keysDir = join(home, 'company', 'keys');
    const user = mintAgentKeys('user', keysDir);
    const ceo = mintAgentKeys('ceo', keysDir);
    const scout = mintAgentKeys('scout', keysDir);
    const log = new CompanyLog(home, keysDir, { brain: true });
    return { home, keysDir, user, ceo, scout, log };
}

describe('brain.entry', () => {
    it('any registered actor appends an attributed entry; fold sees it', () => {
        const { log, scout } = scenario();
        const ev = appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'lesson', text: 'The staging relay rejects ws:// from iOS.', scope: 'company', tags: ['relay'],
        });
        expect(ev.actor).toBe('scout');
        const fold = foldBrain(log.readAll());
        const row = fold.entries.get(ev.id)!;
        expect(row).toMatchObject({ actor: 'scout', entryKind: 'lesson', scope: 'company', tombstoned: false });
    });

    it('rejects bad entryKind, empty/oversize text, bad scope, bad tags', () => {
        const { log, scout } = scenario();
        const base = { entryKind: 'lesson', text: 'ok', scope: 'company' } as const;
        expect(() => appendBrainEntry(log, 'scout', scout.privateKey, { ...base, entryKind: 'vibe' as never }))
            .toThrow(/entryKind/);
        expect(() => appendBrainEntry(log, 'scout', scout.privateKey, { ...base, text: '   ' }))
            .toThrow(/non-empty text/);
        expect(() => appendBrainEntry(log, 'scout', scout.privateKey, { ...base, text: 'x'.repeat(BRAIN_MAX_TEXT + 1) }))
            .toThrow(/exceeds/);
        expect(() => appendBrainEntry(log, 'scout', scout.privateKey, { ...base, scope: 'team' as never }))
            .toThrow(/scope/);
        expect(() => appendBrainEntry(log, 'scout', scout.privateKey, { ...base, tags: [''] }))
            .toThrow(/tags/);
    });

    it('an actor cannot sign as another actor (log actor binding)', () => {
        const { log, scout } = scenario();
        expect(() => appendBrainEntry(log, 'ceo', scout.privateKey, {
            entryKind: 'decision', text: 'impersonation attempt', scope: 'company',
        })).toThrow();
    });
});

describe('brain.tombstone', () => {
    it('author retracts own entry; fold flags it; double-tombstone refused', () => {
        const { log, scout } = scenario();
        const ev = appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'observation', text: 'wrong fact', scope: 'company',
        });
        tombstoneBrainEntry(log, 'scout', scout.privateKey, { targetId: ev.id, reason: 'incorrect' });
        expect(foldBrain(log.readAll()).entries.get(ev.id)!.tombstoned).toBe(true);
        expect(() => tombstoneBrainEntry(log, 'scout', scout.privateKey, { targetId: ev.id, reason: 'again' }))
            .toThrow(/already tombstoned/);
    });

    it('a third party cannot retract; ceo and user can', () => {
        const { log, keysDir, scout, ceo } = scenario();
        const other = mintAgentKeys('builder', keysDir);
        const ev = appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'observation', text: 'target', scope: 'company',
        });
        expect(() => tombstoneBrainEntry(log, 'builder', other.privateKey, { targetId: ev.id, reason: 'nope' }))
            .toThrow(/only "scout"/);
        tombstoneBrainEntry(log, 'ceo', ceo.privateKey, { targetId: ev.id, reason: 'ceo cleanup' });
    });

    it('tombstoning a nonexistent target is refused', () => {
        const { log, user } = scenario();
        expect(() => tombstoneBrainEntry(log, 'user', user.privateKey, { targetId: 'nope', reason: 'r' }))
            .toThrow(/no brain.entry/);
    });
});

describe('agent.hired / agent.retired', () => {
    it('ceo hires; double-hire refused; scout (non-ceo) cannot hire', () => {
        const { log, ceo, scout } = scenario();
        appendAgentHired(log, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing', charter: 'Writes the words.',
            harness: 'claude-agent-acp', model: 'claude-sonnet-5',
        });
        const roster = foldBrain(log.readAll()).roster.get('quill')!;
        expect(roster).toMatchObject({ status: 'hired', harness: 'claude-agent-acp' });
        expect(() => appendAgentHired(log, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill II', role: 'writing', charter: 'dup',
        })).toThrow(/already hired/);
        expect(() => appendAgentHired(log, 'scout', scout.privateKey, {
            agentId: 'newbie', displayName: 'N', role: 'r', charter: 'c',
        })).toThrow();
    });

    it('founding principals are not hireable or retirable', () => {
        const { log, ceo, user } = scenario();
        expect(() => appendAgentHired(log, 'ceo', ceo.privateKey, {
            agentId: 'user', displayName: 'U', role: 'r', charter: 'c',
        })).toThrow(/founding principal/);
        expect(() => appendAgentRetired(log, 'user', user.privateKey, { agentId: 'ceo', reason: 'coup' }))
            .toThrow(/cannot be retired/);
    });

    it('retire revokes the agent brain writes (revocation), re-hire restores', () => {
        const { log, keysDir, ceo } = scenario();
        const quill = mintAgentKeys('quill', keysDir);
        appendAgentHired(log, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing', charter: 'Writes.',
        });
        appendBrainEntry(log, 'quill', quill.privateKey, {
            entryKind: 'observation', text: 'hired and working', scope: 'company',
        });
        appendAgentRetired(log, 'ceo', ceo.privateKey, { agentId: 'quill', reason: 'project over' });
        // Revoked: the retired agent's key can no longer append brain kinds.
        expect(() => appendBrainEntry(log, 'quill', quill.privateKey, {
            entryKind: 'observation', text: 'still here?', scope: 'company',
        })).toThrow(/retired/);
        // Retiring a non-hired agent is refused.
        expect(() => appendAgentRetired(log, 'ceo', ceo.privateKey, { agentId: 'quill', reason: 'again' }))
            .toThrow(/not currently hired/);
        // Re-hire restores write rights.
        appendAgentHired(log, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing', charter: 'Back again.',
        });
        appendBrainEntry(log, 'quill', quill.privateKey, {
            entryKind: 'observation', text: 'rehired', scope: 'company',
        });
    });
});

describe('fold determinism + chain integrity', () => {
    it('replaying the log yields identical fold state, and the chain verifies', () => {
        const { log, ceo, scout } = scenario();
        appendAgentHired(log, 'ceo', ceo.privateKey, {
            agentId: 'quill', displayName: 'Quill', role: 'writing', charter: 'W.',
        });
        const e1 = appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'lesson', text: 'one', scope: 'private',
        });
        appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'decision', text: 'two', scope: 'company', tags: ['t'],
        });
        tombstoneBrainEntry(log, 'scout', scout.privateKey, { targetId: e1.id, reason: 'r' });

        const a = foldBrain(log.readAll());
        const b = foldBrain(log.readAll());
        expect(JSON.stringify([...a.entries.values()])).toBe(JSON.stringify([...b.entries.values()]));
        expect(JSON.stringify([...a.roster.values()])).toBe(JSON.stringify([...b.roster.values()]));
        expect(a.entries.get(e1.id)!.tombstoned).toBe(true);
        expect(log.verifyChain().ok).toBe(true);
    });

    it('brain kinds are refused on a log opened WITHOUT brain mode', () => {
        caseId += 1;
        const home = join(ROOT, `case-${caseId}`);
        const keysDir = join(home, 'company', 'keys');
        const scout = mintAgentKeys('scout', keysDir);
        mintAgentKeys('user', keysDir);
        const log = new CompanyLog(home, keysDir); // no brain mode
        expect(() => appendBrainEntry(log, 'scout', scout.privateKey, {
            entryKind: 'lesson', text: 'x', scope: 'company',
        })).toThrow();
    });
});
