/**
 * Tests for the inverted-index keyword search (Phase 9 / Track B2).
 *
 * Pure-function module — no graph state, no fs. Tests pin the contract
 * documented in src/memory/index.ts: tokenization, posting list,
 * scoring, idempotent re-add, removal, fallback for empty query.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryIndex, tokenize, _resetMemoryIndexForTests, getMemoryIndex } from '../../src/memory/index.js';

describe('memory inverted index — tokenize()', () => {
    it('lowercases and strips punctuation', () => {
        expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
    });

    it('drops stop words', () => {
        expect(tokenize('the quick brown fox')).toEqual(['quick', 'brown', 'fox']);
    });

    it('keeps hyphenated words intact', () => {
        expect(tokenize('self-improve and self-heal')).toEqual(['self-improve', 'self-heal']);
    });

    it('drops single-character tokens', () => {
        expect(tokenize('a b cat')).toEqual(['cat']);
    });

    it('returns [] for empty / undefined input', () => {
        expect(tokenize('')).toEqual([]);
        expect(tokenize(undefined as unknown as string)).toEqual([]);
    });
});

describe('memory inverted index — search', () => {
    let idx: MemoryIndex;

    beforeEach(() => {
        idx = new MemoryIndex();
    });

    it('returns [] for an empty index', () => {
        expect(idx.search('anything', 10)).toEqual([]);
    });

    it('returns [] for an empty query', () => {
        idx.addEpisode('e1', 'Tony lives in Kelseyville');
        expect(idx.search('', 10)).toEqual([]);
    });

    it('finds the only matching episode', () => {
        idx.addEpisode('e1', 'Tony lives in Kelseyville');
        idx.addEpisode('e2', 'The weather is nice today');
        const results = idx.search('Tony', 10);
        expect(results.length).toBe(1);
        expect(results[0].episodeId).toBe('e1');
        expect(results[0].matchedTerms).toContain('tony');
    });

    it('ranks the higher-frequency episode first', () => {
        idx.addEpisode('e1', 'cats are nice cats are fluffy cats are great');
        idx.addEpisode('e2', 'cats are alright I guess');
        const results = idx.search('cats', 10);
        expect(results.length).toBe(2);
        expect(results[0].episodeId).toBe('e1');
    });

    it('boosts episodes where term appears in the first 100 chars', () => {
        idx.addEpisode('e1', 'X marks the spot. ' + 'filler '.repeat(50) + 'TITAN');
        idx.addEpisode('e2', 'TITAN is at the start');
        const results = idx.search('TITAN', 10);
        expect(results[0].episodeId).toBe('e2'); // head boost
    });

    it('handles multi-term queries (sums per-term scores)', () => {
        idx.addEpisode('e1', 'Tony lives in Kelseyville');
        idx.addEpisode('e2', 'Tony works on TITAN in California');
        const results = idx.search('Tony Kelseyville', 10);
        expect(results.length).toBe(2);
        expect(results[0].episodeId).toBe('e1'); // matches both terms
        expect(results[0].matchedTerms.length).toBeGreaterThanOrEqual(2);
    });

    it('limits results when more match than `limit`', () => {
        for (let i = 0; i < 50; i++) idx.addEpisode(`e${i}`, 'cats are nice');
        const results = idx.search('cats', 5);
        expect(results.length).toBe(5);
    });

    it('IDF dampens common terms — common term contributes less per-doc than rare term', () => {
        for (let i = 0; i < 100; i++) idx.addEpisode(`common-${i}`, 'cats are everywhere');
        idx.addEpisode('rare', 'platypus');
        idx.addEpisode('mixed', 'platypus and cats');
        const results = idx.search('platypus cats', 10);
        // 'platypus' is rare (high IDF), 'cats' is common (low IDF) — the
        // mixed doc should outrank a "cats only" doc by a margin driven by
        // the platypus IDF.
        expect(results[0].episodeId).toBe('mixed');
    });
});

describe('memory inverted index — addEpisode + removeEpisode', () => {
    let idx: MemoryIndex;
    beforeEach(() => { idx = new MemoryIndex(); });

    it('size() reflects added episodes', () => {
        expect(idx.size()).toBe(0);
        idx.addEpisode('e1', 'one');
        idx.addEpisode('e2', 'two');
        expect(idx.size()).toBe(2);
    });

    it('addEpisode is idempotent — re-adding the same id replaces, not duplicates', () => {
        idx.addEpisode('e1', 'cats are nice');
        idx.addEpisode('e1', 'dogs are nice');
        expect(idx.size()).toBe(1);
        // The new content should be searchable; the old shouldn't.
        expect(idx.search('cats', 10).length).toBe(0);
        expect(idx.search('dogs', 10).length).toBe(1);
    });

    it('removeEpisode drops the entry from all postings', () => {
        idx.addEpisode('e1', 'Tony in Kelseyville');
        idx.addEpisode('e2', 'Tony in California');
        expect(idx.search('Tony', 10).length).toBe(2);
        idx.removeEpisode('e1');
        expect(idx.size()).toBe(1);
        expect(idx.search('Tony', 10).length).toBe(1);
        expect(idx.search('Kelseyville', 10).length).toBe(0);
    });

    it('removeEpisode is a no-op for unknown ids', () => {
        idx.addEpisode('e1', 'present');
        idx.removeEpisode('nope');
        expect(idx.size()).toBe(1);
    });

    it('vocabularySize() shrinks when the last user of a token is removed', () => {
        idx.addEpisode('e1', 'unique-token-here regular');
        idx.addEpisode('e2', 'regular only');
        const beforeSize = idx.vocabularySize();
        idx.removeEpisode('e1');
        // 'unique-token-here' had only one posting; should be gone now.
        const afterSize = idx.vocabularySize();
        expect(afterSize).toBeLessThan(beforeSize);
    });

    it('clear() resets size and postings', () => {
        for (let i = 0; i < 10; i++) idx.addEpisode(`e${i}`, `content ${i}`);
        expect(idx.size()).toBe(10);
        idx.clear();
        expect(idx.size()).toBe(0);
        expect(idx.search('content', 10)).toEqual([]);
    });

    it('handles empty content episodes (still indexes them, search returns nothing)', () => {
        idx.addEpisode('blank', '');
        idx.addEpisode('e1', 'real content');
        expect(idx.size()).toBe(2);
        expect(idx.search('content', 10).map(r => r.episodeId)).toEqual(['e1']);
    });
});

describe('memory inverted index — fromEpisodes() bulk constructor', () => {
    it('builds an index from a list of episodes', () => {
        const idx = MemoryIndex.fromEpisodes([
            { id: 'a', content: 'Tony in Kelseyville' },
            { id: 'b', content: 'TITAN is in California' },
            { id: 'c', content: 'unrelated topic about pizza' },
        ]);
        expect(idx.size()).toBe(3);
        expect(idx.search('Tony', 10).map(r => r.episodeId)).toEqual(['a']);
        expect(idx.search('California', 10).map(r => r.episodeId)).toEqual(['b']);
    });
});

describe('memory inverted index — module-level singleton', () => {
    beforeEach(() => _resetMemoryIndexForTests());

    it('getMemoryIndex returns the same instance', () => {
        const a = getMemoryIndex();
        const b = getMemoryIndex();
        expect(a).toBe(b);
    });

    it('_resetMemoryIndexForTests gives a fresh instance', () => {
        const a = getMemoryIndex();
        a.addEpisode('e1', 'present');
        _resetMemoryIndexForTests();
        const b = getMemoryIndex();
        expect(b.size()).toBe(0);
    });
});

describe('memory inverted index — performance budget', () => {
    it('queries 5000 episodes in <50ms (Track B2 acceptance criteria)', () => {
        const idx = new MemoryIndex();
        for (let i = 0; i < 5000; i++) {
            idx.addEpisode(`e${i}`, `episode ${i} mentions Tony in Kelseyville on day ${i % 365}`);
        }
        const start = Date.now();
        idx.search('Tony Kelseyville day', 20);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(50);
    });
});
