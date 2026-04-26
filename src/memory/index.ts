/**
 * Inverted-Index Keyword Search (Phase 9 / Track B2)
 *
 * `searchMemory()` in graph.ts used to scan every episode linearly with a
 * BM25-ish score per term per episode — at 5000 episodes and 5 terms,
 * that's 25 000 substring searches per query. This module trades a bit of
 * memory for a constant-time-per-query lookup: token → posting-list of
 * episode IDs + per-doc term frequency.
 *
 * Sized for TITAN's typical workload:
 *   - ~5000 episodes max (MAX_EPISODES bound)
 *   - ~50 tokens per episode after tokenisation
 *   - Index footprint ≈ 250 000 (token, episodeId, tf) tuples — single-digit MB.
 *
 * Not a full-text engine. Tokens are lowercased, punctuation stripped,
 * stop-words filtered (same set as the legacy linear scan). No stemming
 * or fuzzy match — that's what vectors.ts is for. The contract is:
 * "what the linear scan returned, faster".
 *
 * Usage:
 *   const index = new MemoryIndex();
 *   for (const ep of episodes) index.addEpisode(ep.id, ep.content);
 *   const matches = index.search('weather forecast', 20);
 *   // → [{ episodeId, score }, ...] sorted by score desc
 *
 * Indexes can be rebuilt from the underlying graph at any time
 * (`MemoryIndex.fromEpisodes(eps)`), so we don't bother with persistence.
 * Memory cost is small enough that recomputing on startup is cheap.
 */

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'of', 'do', 'you', 'we', 'i',
    'me', 'my', 'that', 'this', 'was', 'are', 'be', 'been', 'have', 'has', 'had', 'and',
    'or', 'but', 'if', 'so', 'not', 'no', 'yes', 'can', 'how', 'what', 'about', 'from',
    'with', 'for', 'up', 'out', 'its', 'our', 'your', 'they', 'them', 'he', 'she', 'his',
    'her', 'will', 'would', 'could', 'should', 'did', 'does', 'just', 'now', 'some', 'any',
    'all', 'very', 'too', 'also', 'than', 'then', 'when', 'where', 'who', 'which', 'there',
    'here', 'again', 'today', 'earlier', 'remember',
]);

/** Tokenise a string for indexing/search. Lowercase, strip non-alphanum
 *  except hyphens (kept for words like "self-improve"), drop stop words,
 *  drop tokens shorter than 2 chars. */
export function tokenize(text: string): string[] {
    if (!text) return [];
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\- ]+/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/** A single posting-list entry for a (token, episode) pair. */
interface Posting {
    episodeId: string;
    /** Term frequency within this episode. */
    tf: number;
    /** True if the term appears in the first 100 chars of the episode
     *  content — used for the "title boost" the legacy scan applied. */
    inHead: boolean;
}

/** Search hit, sorted by score in `search()`. */
export interface IndexMatch {
    episodeId: string;
    /** TF-IDF-ish score. Higher = more relevant. */
    score: number;
    /** Which query terms matched this episode (debug aid). */
    matchedTerms: string[];
}

export class MemoryIndex {
    /** token → array of postings */
    private postings = new Map<string, Posting[]>();
    /** episode count, used to compute IDF */
    private docCount = 0;
    /** episode IDs we've indexed, used for `removeEpisode` and `has` */
    private indexed = new Set<string>();

    /** Add (or re-add) an episode to the index. Idempotent — calling twice
     *  with the same id replaces the previous entry. */
    addEpisode(episodeId: string, content: string): void {
        if (this.indexed.has(episodeId)) {
            this.removeEpisode(episodeId);
        }
        const tokens = tokenize(content);
        if (tokens.length === 0) {
            // Still mark as indexed so subsequent re-adds don't double-count.
            this.indexed.add(episodeId);
            this.docCount += 1;
            return;
        }

        // Compute term frequencies + head-presence
        const tf = new Map<string, number>();
        const headTokens = new Set(tokenize(content.slice(0, 100)));
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

        for (const [token, count] of tf) {
            const list = this.postings.get(token) ?? [];
            list.push({ episodeId, tf: count, inHead: headTokens.has(token) });
            this.postings.set(token, list);
        }
        this.indexed.add(episodeId);
        this.docCount += 1;
    }

    /** Remove an episode from the index. Used when pruning. */
    removeEpisode(episodeId: string): void {
        if (!this.indexed.has(episodeId)) return;
        for (const [token, list] of this.postings) {
            const filtered = list.filter(p => p.episodeId !== episodeId);
            if (filtered.length === 0) this.postings.delete(token);
            else if (filtered.length !== list.length) this.postings.set(token, filtered);
        }
        this.indexed.delete(episodeId);
        this.docCount = Math.max(0, this.docCount - 1);
    }

    /** True if the episode is currently indexed. */
    has(episodeId: string): boolean {
        return this.indexed.has(episodeId);
    }

    /** Number of episodes in the index. */
    size(): number {
        return this.docCount;
    }

    /** Number of unique tokens (vocabulary size). */
    vocabularySize(): number {
        return this.postings.size;
    }

    /** Search the index. Returns up to `limit` matches sorted by score.
     *  Score is BM25-lite: sum over query terms of (tf × idf) + headBoost.
     *  Empty query returns empty array. */
    search(query: string, limit = 20): IndexMatch[] {
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];

        // Per-episode score accumulator
        const scoreById = new Map<string, { score: number; matched: Set<string> }>();

        for (const term of queryTokens) {
            const postings = this.postings.get(term);
            if (!postings || postings.length === 0) continue;

            // IDF — log smoothing to dampen common terms.
            // 1 + log((docCount+1)/(df+1)) keeps it positive even when df==docCount.
            const df = postings.length;
            const idf = 1 + Math.log((this.docCount + 1) / (df + 1));

            for (const p of postings) {
                // tf × idf, with a flat bonus when the term is in the
                // first 100 chars (cheap "title boost" the legacy scan had)
                const termScore = p.tf * idf + (p.inHead ? 0.5 : 0);
                const acc = scoreById.get(p.episodeId) ?? { score: 0, matched: new Set<string>() };
                acc.score += termScore;
                acc.matched.add(term);
                scoreById.set(p.episodeId, acc);
            }
        }

        const matches: IndexMatch[] = [];
        for (const [episodeId, { score, matched }] of scoreById) {
            matches.push({ episodeId, score, matchedTerms: Array.from(matched) });
        }
        matches.sort((a, b) => b.score - a.score);
        return matches.slice(0, limit);
    }

    /** Drop all entries — used for tests + full rebuilds. */
    clear(): void {
        this.postings.clear();
        this.indexed.clear();
        this.docCount = 0;
    }

    /** Build a fresh index from a list of episodes. */
    static fromEpisodes(episodes: Array<{ id: string; content: string }>): MemoryIndex {
        const idx = new MemoryIndex();
        for (const ep of episodes) idx.addEpisode(ep.id, ep.content);
        return idx;
    }
}

/** Module-level singleton used by graph.ts. Cleared + rebuilt by tests. */
let _instance: MemoryIndex | null = null;

export function getMemoryIndex(): MemoryIndex {
    if (!_instance) _instance = new MemoryIndex();
    return _instance;
}

/** Test-only: reset the singleton between scenarios. */
export function _resetMemoryIndexForTests(): void {
    _instance = new MemoryIndex();
}
