import { describe, it, expect, beforeEach } from 'vitest';
import {
    recordStudioEvent, getStudioSession, listStudioSessions, resetStudioBuffer,
    MAX_PER_SESSION, MAX_SESSIONS,
} from '../src/watch/studioBuffer.js';

describe('studioBuffer', () => {
    beforeEach(() => resetStudioBuffer());

    it('ignores events with no sessionId (session-scoped only)', () => {
        recordStudioEvent('tool:call', { tool: 'shell' }, 1);
        expect(listStudioSessions()).toHaveLength(0);
    });

    it('records into a per-session ring', () => {
        recordStudioEvent('tool:call', { sessionId: 's1', tool: 'edit_file' }, 10);
        recordStudioEvent('tool:result', { sessionId: 's1', tool: 'edit_file', success: true }, 20);
        const ring = getStudioSession('s1');
        expect(ring).toHaveLength(2);
        expect(ring[0].topic).toBe('tool:call');
        expect(ring[1].payload.success).toBe(true);
    });

    it('caps a session ring at MAX_PER_SESSION (drops oldest)', () => {
        for (let i = 0; i < MAX_PER_SESSION + 5; i++) {
            recordStudioEvent('tool:call', { sessionId: 's1', n: i }, i);
        }
        const ring = getStudioSession('s1');
        expect(ring).toHaveLength(MAX_PER_SESSION);
        expect(ring[0].payload.n).toBe(5);                       // first 5 dropped
        expect(ring[ring.length - 1].payload.n).toBe(MAX_PER_SESSION + 4);
    });

    it('evicts the least-recently-written session past MAX_SESSIONS', () => {
        for (let i = 0; i < MAX_SESSIONS + 1; i++) {
            recordStudioEvent('tool:call', { sessionId: `s${i}`, n: i }, i);
        }
        expect(getStudioSession('s0')).toHaveLength(0);          // oldest evicted
        expect(getStudioSession(`s${MAX_SESSIONS}`)).toHaveLength(1);
        expect(listStudioSessions()).toHaveLength(MAX_SESSIONS);
    });

    it('writing to a session refreshes its LRU position (not evicted)', () => {
        for (let i = 0; i < MAX_SESSIONS; i++) recordStudioEvent('tool:call', { sessionId: `s${i}` }, i);
        recordStudioEvent('tool:call', { sessionId: 's0' }, 1000); // touch the oldest
        recordStudioEvent('tool:call', { sessionId: 'sNew' }, 1001); // forces one eviction
        expect(getStudioSession('s0').length).toBeGreaterThan(0);  // s0 survived (refreshed)
        expect(getStudioSession('s1')).toHaveLength(0);            // s1 is now oldest → evicted
    });

    it('lists sessions most-recently-active first', () => {
        recordStudioEvent('tool:call', { sessionId: 'a' }, 100);
        recordStudioEvent('tool:call', { sessionId: 'b' }, 200);
        expect(listStudioSessions().map(s => s.sessionId)).toEqual(['b', 'a']);
    });
});
