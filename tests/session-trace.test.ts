import { describe, it, expect, beforeEach } from 'vitest';
import {
    shouldEmit, resetDedupe, emitToolCall, emitToolResult, DEDUPE_TTL_MS,
} from '../src/watch/sessionTrace.js';
import { on, type ToolResultEvent } from '../src/substrate/traceBus.js';

describe('sessionTrace — TTL dedupe primitive', () => {
    beforeEach(() => resetDedupe());

    it('emits a key once, suppresses repeats within the TTL window', () => {
        expect(shouldEmit('k', 1000)).toBe(true);
        expect(shouldEmit('k', 1000)).toBe(false);
        expect(shouldEmit('k', 1000 + DEDUPE_TTL_MS - 1)).toBe(false);
    });

    it('re-emits after the TTL elapses', () => {
        expect(shouldEmit('k', 1000)).toBe(true);
        expect(shouldEmit('k', 1000 + DEDUPE_TTL_MS + 1)).toBe(true);
    });

    it('keys are independent', () => {
        expect(shouldEmit('a', 1000)).toBe(true);
        expect(shouldEmit('b', 1000)).toBe(true);
    });
});

describe('sessionTrace — tool emitters', () => {
    beforeEach(() => resetDedupe());

    it('dedupes the same actionId (rich + fallback collapse to one)', () => {
        expect(emitToolCall({ tool: 'edit_file', argsPreview: '…', actionId: 'aid-1' }, 1000)).toBe(true);
        expect(emitToolCall({ tool: 'edit_file', argsPreview: '…', actionId: 'aid-1' }, 1000)).toBe(false);
        // after TTL it may emit again
        expect(emitToolCall({ tool: 'edit_file', argsPreview: '…', actionId: 'aid-1' }, 1000 + DEDUPE_TTL_MS + 1)).toBe(true);
    });

    it('always emits when no actionId is present (never silently drop)', () => {
        expect(emitToolCall({ tool: 'shell', argsPreview: 'ls' }, 1000)).toBe(true);
        expect(emitToolCall({ tool: 'shell', argsPreview: 'ls' }, 1000)).toBe(true);
    });

    it('stamps sessionId/agentId/timestamp and forwards spine fields on the bus', () => {
        const got: ToolResultEvent[] = [];
        const off = on('tool:result', (p) => got.push(p));
        try {
            emitToolResult({
                tool: 'edit_file', success: true, durationMs: 12,
                actionId: 'aid-9', filePath: 'a.ts', checkpointId: 'cp-1', round: 2,
            }, 1700000000000);
        } finally { off(); }
        expect(got).toHaveLength(1);
        const e = got[0];
        expect(e.actionId).toBe('aid-9');
        expect(e.filePath).toBe('a.ts');
        expect(e.checkpointId).toBe('cp-1');
        expect(e.round).toBe(2);
        expect(e.agentId).toBe('main');          // default applied
        expect(typeof e.sessionId).toBe('string'); // resolved (env/ambient/unknown)
        expect(e.timestamp).toBe(new Date(1700000000000).toISOString());
    });
});
