/**
 * TITAN — Fix Oscillation Detector tests (v4.9.0+)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rmSync } from 'fs';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path');
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-fixosc-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub the kill-switch pass-through so tests don't need to thread state.
const killSpies = vi.hoisted(() => ({ recordFixOscillation: vi.fn() }));
vi.mock('../../src/safety/killSwitch.js', () => ({
    recordFixOscillation: killSpies.recordFixOscillation,
}));

import {
    recordFixEvent,
    normalizeTarget,
    getRecentEventsOn,
    getAllRecentEvents,
    _resetFixEventsForTests,
} from '../../src/safety/fixOscillation.js';

describe('fix oscillation detector', () => {
    beforeEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
        _resetFixEventsForTests();
        killSpies.recordFixOscillation.mockClear();
    });

    it('single event is not an oscillation', () => {
        const r = recordFixEvent({ target: '/opt/TITAN/src/foo.ts', kind: 'file', detail: 'edit' });
        expect(r.oscillation).toBe(false);
        expect(killSpies.recordFixOscillation).not.toHaveBeenCalled();
    });

    it('second event on the same target within 24h IS an oscillation', () => {
        recordFixEvent({ target: '/opt/TITAN/src/foo.ts', kind: 'file', detail: 'edit 1' });
        const second = recordFixEvent({ target: '/opt/TITAN/src/foo.ts', kind: 'file', detail: 'edit 2' });
        expect(second.oscillation).toBe(true);
        expect(second.priorCount).toBe(1);
        expect(killSpies.recordFixOscillation).toHaveBeenCalledTimes(1);
    });

    it('different kinds with same string are tracked separately', () => {
        recordFixEvent({ target: 'curiosity', kind: 'drive', detail: 'setpoint tuned' });
        const r = recordFixEvent({ target: 'curiosity', kind: 'goal', detail: 'goal renamed' });
        expect(r.oscillation).toBe(false);
    });

    it('normalizeTarget strips trailing slash + lowercases files', () => {
        expect(normalizeTarget('file', '/opt/TITAN/SRC/foo.ts/')).toBe('/opt/titan/src/foo.ts');
    });

    it('normalizeTarget strips soma: prefix on drives', () => {
        expect(normalizeTarget('drive', 'soma:Curiosity')).toBe('curiosity');
    });

    it('getRecentEventsOn filters by kind + target', () => {
        recordFixEvent({ target: '/x', kind: 'file', detail: 'a' });
        recordFixEvent({ target: '/x', kind: 'file', detail: 'b' });
        recordFixEvent({ target: '/y', kind: 'file', detail: 'c' });
        const xs = getRecentEventsOn('file', '/x');
        expect(xs).toHaveLength(2);
    });

    it('getAllRecentEvents returns events sorted newest first', async () => {
        recordFixEvent({ target: '/1', kind: 'file', detail: 'first' });
        // Millisecond-resolution timestamps — wait one tick so the second
        // event strictly sorts after the first.
        await new Promise(r => setTimeout(r, 2));
        recordFixEvent({ target: '/2', kind: 'file', detail: 'second' });
        const all = getAllRecentEvents();
        expect(all[0].target).toBe('/2');
    });
});
