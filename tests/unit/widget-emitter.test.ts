/**
 * Widget side-channel emitter — unit tests.
 *
 * The canvas-widget tools (`create_widget` / `update_widget` /
 * `remove_widget`) fire envelopes onto a per-session in-process bus.
 * The gateway's `/api/message` SSE handler subscribes for the duration
 * of a stream and forwards events as `event: widget` SSE frames.
 *
 * These tests pin the bus's three invariants:
 *
 *   1. Events are session-scoped — a listener for session A must NOT
 *      receive events for session B (privacy / scope bug surface).
 *   2. Unsubscribe actually unsubscribes — no listener leak after the
 *      SSE stream closes.
 *   3. The emitter never throws on malformed input, and refuses to
 *      route widgets without a `source` (except for `remove`, which
 *      only needs `id`).
 *
 * Reference: src/agent/widgetEmitter.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    subscribe,
    emitWidget,
    __resetWidgetBusForTests,
    type WidgetEvent,
} from '../../src/agent/widgetEmitter.js';

beforeEach(() => {
    __resetWidgetBusForTests();
});

describe('widgetEmitter — session scoping', () => {
    it('delivers an event to the matching session subscriber', () => {
        const received: WidgetEvent[] = [];
        subscribe('sess-A', (e) => received.push(e));
        emitWidget('sess-A', { name: 'Clock', source: 'export default () => <div>tick</div>' });
        expect(received).toHaveLength(1);
        expect(received[0].mode).toBe('create');
        expect(received[0].widget.name).toBe('Clock');
        expect(received[0].sessionId).toBe('sess-A');
    });

    it('does NOT deliver across sessions', () => {
        const a: WidgetEvent[] = [];
        const b: WidgetEvent[] = [];
        subscribe('sess-A', (e) => a.push(e));
        subscribe('sess-B', (e) => b.push(e));
        emitWidget('sess-A', { name: 'X', source: 'x' });
        emitWidget('sess-B', { name: 'Y', source: 'y' });
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        expect(a[0].widget.name).toBe('X');
        expect(b[0].widget.name).toBe('Y');
    });

    it('routes multiple subscribers on the same session', () => {
        const a1: WidgetEvent[] = [];
        const a2: WidgetEvent[] = [];
        subscribe('sess-A', (e) => a1.push(e));
        subscribe('sess-A', (e) => a2.push(e));
        emitWidget('sess-A', { name: 'X', source: 'x' });
        expect(a1).toHaveLength(1);
        expect(a2).toHaveLength(1);
    });
});

describe('widgetEmitter — unsubscribe', () => {
    it('stops delivery after unsubscribe is called', () => {
        const events: WidgetEvent[] = [];
        const off = subscribe('sess-A', (e) => events.push(e));
        emitWidget('sess-A', { name: 'X', source: 'x' });
        off();
        emitWidget('sess-A', { name: 'Y', source: 'y' });
        expect(events).toHaveLength(1);
        expect(events[0].widget.name).toBe('X');
    });

    it('subscribe with empty sessionId returns a no-op handle', () => {
        const off = subscribe('', () => { throw new Error('should not fire'); });
        // Calling the no-op must not throw, and emitting to any session must
        // not invoke the handler.
        expect(() => off()).not.toThrow();
        expect(() => emitWidget('sess-A', { name: 'X', source: 'x' })).not.toThrow();
    });
});

describe('widgetEmitter — input validation', () => {
    it('returns false when sessionId is empty', () => {
        expect(emitWidget('', { name: 'X', source: 'x' })).toBe(false);
    });

    it('returns false for non-object widget envelopes', () => {
        // @ts-expect-error — intentional bad input
        expect(emitWidget('sess-A', null)).toBe(false);
        // @ts-expect-error — intentional bad input
        expect(emitWidget('sess-A', undefined)).toBe(false);
    });

    it('returns false for create events with no source', () => {
        // @ts-expect-error — intentional: missing required source
        expect(emitWidget('sess-A', { name: 'X' })).toBe(false);
    });

    it('allows remove events without source (only id required)', () => {
        const events: WidgetEvent[] = [];
        subscribe('sess-A', (e) => events.push(e));
        // Per the WidgetEnvelope type, source is technically required, but
        // for `remove` the frontend only reads `id`. We pass empty source.
        const delivered = emitWidget('sess-A', { id: 'w-123', name: '', source: '' }, 'remove');
        expect(delivered).toBe(true);
        expect(events[0].mode).toBe('remove');
        expect(events[0].widget.id).toBe('w-123');
    });

    it('returns false when no listeners are attached to the session', () => {
        // No subscribe call for sess-Z.
        expect(emitWidget('sess-Z', { name: 'X', source: 'x' })).toBe(false);
    });
});

describe('widgetEmitter — resilience', () => {
    it('a throwing handler does not break delivery to other subscribers', () => {
        const survivor: WidgetEvent[] = [];
        subscribe('sess-A', () => { throw new Error('handler boom'); });
        subscribe('sess-A', (e) => survivor.push(e));
        const delivered = emitWidget('sess-A', { name: 'X', source: 'x' });
        // The bus's emit() return reflects "any listener attached" — both
        // were attached, so delivered=true. The survivor still got the event.
        expect(delivered).toBe(true);
        expect(survivor).toHaveLength(1);
    });

    it('event timestamp is monotonic non-decreasing', () => {
        const events: WidgetEvent[] = [];
        subscribe('sess-A', (e) => events.push(e));
        emitWidget('sess-A', { name: 'A', source: 'a' });
        emitWidget('sess-A', { name: 'B', source: 'b' });
        expect(events[1].timestamp).toBeGreaterThanOrEqual(events[0].timestamp);
    });
});
