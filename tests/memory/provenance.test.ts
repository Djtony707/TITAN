/**
 * TITAN — Provenance tests (v4.9.0+, local hard-takeoff)
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
    return { tmpHome: mkdtempSync(join(tmpdir(), 'titan-provenance-')) as string };
});

vi.mock('../../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    recordProvenance,
    getProvenance,
    getTrust,
    quarantine,
    getProvenanceStats,
    SOURCE_TRUST,
    _resetProvenanceCacheForTests,
} from '../../src/memory/provenance.js';

describe('provenance', () => {
    beforeEach(() => {
        try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
        _resetProvenanceCacheForTests();
    });

    it('records a write with the expected trust level per source', () => {
        const id = recordProvenance({ memoryType: 'graph_entity', source: 'human', content: 'Tony' });
        expect(getTrust(id)).toBe('high');

        const webId = recordProvenance({ memoryType: 'graph_fact', source: 'web', content: 'scraped' });
        expect(getTrust(webId)).toBe('low');
    });

    it('inference propagates the minimum trust of its parents', () => {
        const humanId = recordProvenance({ memoryType: 'graph_fact', source: 'human', content: 'fact A' });
        const webId = recordProvenance({ memoryType: 'graph_fact', source: 'web', content: 'fact B' });
        const inferenceId = recordProvenance({
            memoryType: 'graph_fact',
            source: 'inference',
            content: 'derived from A + B',
            parentEventIds: [humanId, webId],
        });
        // inference starts medium-trust by default; parent min is web=low → clamp down
        const rec = getProvenance(inferenceId)!;
        expect(rec.confidence).toBeLessThanOrEqual(0.5);
    });

    it('quarantine marks a record as untrusted', () => {
        const id = recordProvenance({ memoryType: 'graph_fact', source: 'agent', content: 'claim' });
        expect(getTrust(id)).toBe('medium');
        quarantine(id, 'hallucinated claim');
        expect(getTrust(id)).toBe('untrusted');
    });

    it('quarantine cascades to descendants', () => {
        const rootId = recordProvenance({ memoryType: 'graph_fact', source: 'web', content: 'root claim' });
        const childId = recordProvenance({
            memoryType: 'graph_fact',
            source: 'inference',
            content: 'derived from root',
            parentEventIds: [rootId],
        });
        const grandchildId = recordProvenance({
            memoryType: 'graph_fact',
            source: 'inference',
            content: 'derived from child',
            parentEventIds: [childId],
        });
        const count = quarantine(rootId, 'poisoned web source');
        expect(count).toBeGreaterThanOrEqual(2);
        expect(getTrust(childId)).toBe('untrusted');
        expect(getTrust(grandchildId)).toBe('untrusted');
    });

    it('unknown memoryIds get untrusted', () => {
        expect(getTrust('nonexistent-id')).toBe('untrusted');
    });

    it('stats return counts by source + trust level', () => {
        recordProvenance({ memoryType: 'graph_entity', source: 'human' });
        recordProvenance({ memoryType: 'graph_entity', source: 'human' });
        recordProvenance({ memoryType: 'graph_entity', source: 'web' });
        const s = getProvenanceStats();
        expect(s.total).toBe(3);
        expect(s.bySource.human).toBe(2);
        expect(s.bySource.web).toBe(1);
        expect(s.byTrust.high).toBe(2);
        expect(s.byTrust.low).toBe(1);
    });

    it('SOURCE_TRUST covers every ProvenanceSource', () => {
        const sources = ['human', 'human_indirect', 'tool_output', 'agent', 'web', 'recalled', 'self_mod', 'inference'];
        for (const s of sources) {
            expect(SOURCE_TRUST[s as keyof typeof SOURCE_TRUST]).toBeDefined();
        }
    });
});
