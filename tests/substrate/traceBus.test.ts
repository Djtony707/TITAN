/**
 * Trace bus tests — thin but complete.
 * Verifies the typed facade over titanEvents publishes + subscribes correctly,
 * and that subscriber errors don't crash the emitter.
 */
import { describe, it, expect, vi } from 'vitest';
import EventEmitter from 'events';

vi.mock('../../src/agent/daemon.js', () => {
    const ee = new EventEmitter();
    ee.setMaxListeners(100);
    return { titanEvents: ee };
});

import { emit, on, once, listenerCount } from '../../src/substrate/traceBus.js';

describe('traceBus', () => {
    it('round-trips a turn:pre event', () => {
        const received: string[] = [];
        const off = on('turn:pre', (p) => received.push(p.sessionId));
        emit('turn:pre', {
            agentId: 'default', sessionId: 's1', channel: 'cli', userId: 'u',
            message: 'hi', timestamp: new Date().toISOString(),
        });
        off();
        expect(received).toEqual(['s1']);
    });

    it('no-ops cleanly when there are no subscribers', () => {
        // Should not throw. Nothing to assert beyond absence of errors.
        expect(() => emit('drive:tick', {
            timestamp: 't', drives: [],
        })).not.toThrow();
    });

    it('once() auto-unsubscribes', () => {
        let hits = 0;
        once('tool:call', () => hits++);
        emit('tool:call', { agentId: 'a', sessionId: 's', tool: 'x', argsPreview: '', timestamp: 't' });
        emit('tool:call', { agentId: 'a', sessionId: 's', tool: 'x', argsPreview: '', timestamp: 't' });
        expect(hits).toBe(1);
    });

    it('off() unsubscribes the exact handler', () => {
        let hits = 0;
        const off = on('soma:proposal', () => hits++);
        emit('soma:proposal', { timestamp: 't', approvalId: 'a1', proposedBy: 'x', title: '', dominantDrives: [] });
        off();
        emit('soma:proposal', { timestamp: 't', approvalId: 'a2', proposedBy: 'x', title: '', dominantDrives: [] });
        expect(hits).toBe(1);
    });

    it('subscriber errors do not crash the emitter', () => {
        const off1 = on('hormone:update', () => { throw new Error('boom'); });
        let reachedSecond = false;
        const off2 = on('hormone:update', () => { reachedSecond = true; });
        expect(() => emit('hormone:update', {
            timestamp: 't', dominant: null, levels: {},
        })).not.toThrow();
        expect(reachedSecond).toBe(true);
        off1(); off2();
    });

    it('listenerCount reflects attached handlers', () => {
        const off = on('pressure:threshold', () => {});
        expect(listenerCount('pressure:threshold')).toBeGreaterThanOrEqual(1);
        off();
    });
});
