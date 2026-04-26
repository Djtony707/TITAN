/**
 * Tests for salience-aware pruning (Phase 9 / Track B4).
 *
 * The legacy `enforceMemoryBounds()` pruned entities by `lastSeen` only —
 * a 5000-episode flood of low-salience log entries would evict identity
 * entities like "Tony" / "Kelseyville" even though they're referenced
 * everywhere. v5.4.0 sorts by `(typeWeight × (1 + episodeRefs + facts))`
 * with `lastSeen` as a tie-breaker.
 *
 * These tests exercise the sort order directly (the prune function is
 * private). We import the entity-type weight table and replicate the
 * scoring to assert the survival ordering matches expectations.
 *
 * If the heuristic in graph.ts changes, update both this scoring
 * function and the test. Same code path, two consumers.
 */

import { describe, it, expect } from 'vitest';

// Same table as graph.ts ENTITY_TYPE_WEIGHT — keep in sync.
const ENTITY_TYPE_WEIGHT: Record<string, number> = {
    person: 1.5, project: 1.3, company: 1.2, technology: 1.1,
    event: 1.0, place: 0.9, topic: 0.7,
};

interface E {
    id: string;
    type: string;
    episodeIds?: string[];
    facts?: string[];
    lastSeen: string;
}

function salience(e: E): number {
    const w = ENTITY_TYPE_WEIGHT[e.type.toLowerCase()] ?? 0.5;
    const refs = (e.episodeIds?.length ?? 0) + (e.facts?.length ?? 0);
    return w * (1 + refs);
}

function pruneToLimit(entities: E[], limit: number): E[] {
    const sorted = [...entities].sort((a, b) => {
        const sB = salience(b);
        const sA = salience(a);
        if (sB !== sA) return sB - sA;
        return b.lastSeen.localeCompare(a.lastSeen);
    });
    return sorted.slice(0, limit);
}

const NOW = '2026-04-26T20:00:00Z';
const HOUR_AGO = '2026-04-26T19:00:00Z';
const DAY_AGO = '2026-04-25T20:00:00Z';
const WEEK_AGO = '2026-04-19T20:00:00Z';

describe('salience-aware pruning — survival ordering', () => {
    it('keeps a high-salience person over a low-salience topic of equal recency', () => {
        const tony: E = {
            id: 'tony', type: 'person', lastSeen: NOW,
            episodeIds: ['e1', 'e2', 'e3', 'e4', 'e5'], facts: ['lives in Kelseyville', 'works on TITAN'],
        };
        const noiseTopic: E = {
            id: 'topic-1', type: 'topic', lastSeen: NOW,
            episodeIds: ['e6'], facts: [],
        };
        const survived = pruneToLimit([tony, noiseTopic], 1);
        expect(survived[0].id).toBe('tony');
    });

    it('keeps a frequently-referenced topic over a one-shot person', () => {
        const oneShotPerson: E = {
            id: 'random-name', type: 'person', lastSeen: NOW,
            episodeIds: ['e1'], facts: [],
        };
        // Frequency carries enough weight to survive against a person
        // with only a single reference: topic × (1 + 20) = 14.7 vs
        // person × (1 + 1) = 3.0
        const veryFrequentTopic: E = {
            id: 'titan', type: 'topic', lastSeen: NOW,
            episodeIds: Array.from({ length: 20 }, (_, i) => `e${i}`), facts: [],
        };
        const survived = pruneToLimit([oneShotPerson, veryFrequentTopic], 1);
        expect(survived[0].id).toBe('titan');
    });

    it('breaks ties by recency when salience is equal', () => {
        const recent: E = { id: 'recent', type: 'topic', lastSeen: NOW, facts: [] };
        const old: E = { id: 'old', type: 'topic', lastSeen: WEEK_AGO, facts: [] };
        const survived = pruneToLimit([recent, old], 1);
        expect(survived[0].id).toBe('recent');
    });

    it('protects identity entities (person type) from a flood of log topics', () => {
        const tony: E = {
            id: 'tony', type: 'person', lastSeen: HOUR_AGO,
            episodeIds: ['e1', 'e2', 'e3'], facts: ['identity-fact-1'],
        };
        // 100 noise topics, each referenced once
        const noise: E[] = Array.from({ length: 100 }, (_, i) => ({
            id: `noise-${i}`, type: 'topic', lastSeen: NOW,
            episodeIds: [`e-noise-${i}`], facts: [],
        }));
        // Limit is 50; tony must survive even though 100 topics are more recent
        const survived = pruneToLimit([tony, ...noise], 50);
        expect(survived.find(e => e.id === 'tony')).toBeTruthy();
    });

    it('drops the lowest-salience entries when over limit', () => {
        const high: E = { id: 'high', type: 'person', lastSeen: NOW, episodeIds: ['e1', 'e2'], facts: ['f1'] };
        const mid: E = { id: 'mid', type: 'topic', lastSeen: NOW, episodeIds: ['e1'], facts: [] };
        const low: E = { id: 'low', type: 'topic', lastSeen: DAY_AGO, facts: [] };
        const survived = pruneToLimit([high, mid, low], 2);
        const ids = survived.map(e => e.id);
        expect(ids).toContain('high');
        expect(ids).not.toContain('low');
    });

    it('handles unknown entity types with a 0.5 fallback weight', () => {
        const known: E = { id: 'k', type: 'topic', lastSeen: NOW };
        const unknown: E = { id: 'u', type: 'undocumented_type', lastSeen: NOW };
        // topic weight 0.7, unknown 0.5 → known wins
        const survived = pruneToLimit([known, unknown], 1);
        expect(survived[0].id).toBe('k');
    });

    it('handles entities with no episodeIds or facts (count as 0 refs)', () => {
        const empty: E = { id: 'empty', type: 'topic', lastSeen: NOW };
        const populated: E = { id: 'pop', type: 'topic', lastSeen: NOW, episodeIds: ['e1'] };
        const survived = pruneToLimit([empty, populated], 1);
        expect(survived[0].id).toBe('pop');
    });

    it('respects the limit exactly — returns no more than `limit` entries', () => {
        const entities: E[] = Array.from({ length: 100 }, (_, i) => ({
            id: `e${i}`, type: 'topic', lastSeen: NOW, episodeIds: [`ep${i}`],
        }));
        expect(pruneToLimit(entities, 25).length).toBe(25);
        expect(pruneToLimit(entities, 1).length).toBe(1);
        expect(pruneToLimit(entities, 0).length).toBe(0);
    });

    it('returns all entries when count is below the limit', () => {
        const entities: E[] = [
            { id: 'a', type: 'topic', lastSeen: NOW },
            { id: 'b', type: 'topic', lastSeen: NOW },
        ];
        expect(pruneToLimit(entities, 10).length).toBe(2);
    });

    it('person + project beat company + technology of equal frequency', () => {
        const p: E = { id: 'p', type: 'person', lastSeen: NOW, episodeIds: ['e1'] };
        const proj: E = { id: 'proj', type: 'project', lastSeen: NOW, episodeIds: ['e1'] };
        const co: E = { id: 'co', type: 'company', lastSeen: NOW, episodeIds: ['e1'] };
        const tech: E = { id: 'tech', type: 'technology', lastSeen: NOW, episodeIds: ['e1'] };
        const survived = pruneToLimit([p, proj, co, tech], 2);
        const ids = survived.map(e => e.id);
        expect(ids).toContain('p');
        expect(ids).toContain('proj');
    });
});
