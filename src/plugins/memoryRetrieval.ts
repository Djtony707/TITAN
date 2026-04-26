/**
 * TITAN — Memory Retrieval Plugin (v4.13+)
 *
 * On every user turn, semantically searches TITAN's full memory (graph,
 * episodic, memory_skill) for content relevant to the user's message and
 * injects the top hits as a system message. Without this, only pre-
 * ingested RAG documents were being searched — the 500 graph entries,
 * the episodic log, and the memory-tool entries were all invisible to
 * the agent during normal chat.
 *
 * Sources searched (besides the existing rag-documents path which is
 * handled by injectRagContext):
 *   - graph     — knowledge graph entities + relationships
 *   - episodic  — past events / corrections / learnings
 *   - memory    — explicit memory-tool entries
 *
 * Injection shape: one system message titled 'Relevant memories' with up
 * to N bullet points, each `[source/score] text`. Injected right before
 * the user message so the LLM sees it as immediate context.
 */
import type { ContextEnginePlugin } from './contextEngine.js';
import type { ChatMessage } from '../providers/base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'MemoryRetrieval';

// Tunables — override via bootstrap opts
const DEFAULT_TOP_K_PER_SOURCE = 3;
const DEFAULT_MIN_SCORE = 0.45;
const DEFAULT_MAX_HITS = 8;
const DEFAULT_MAX_TEXT_LEN = 400;
const SEARCH_SOURCES = ['graph', 'episodic', 'memory'] as const;

export class MemoryRetrievalPlugin implements ContextEnginePlugin {
    readonly name = 'memoryRetrieval';
    readonly version = '1.0.0';

    private topKPerSource = DEFAULT_TOP_K_PER_SOURCE;
    private minScore = DEFAULT_MIN_SCORE;
    private maxHits = DEFAULT_MAX_HITS;
    private maxTextLen = DEFAULT_MAX_TEXT_LEN;

    async bootstrap(config: Record<string, unknown>): Promise<void> {
        if (typeof config.topKPerSource === 'number') this.topKPerSource = config.topKPerSource;
        if (typeof config.minScore === 'number') this.minScore = config.minScore;
        if (typeof config.maxHits === 'number') this.maxHits = config.maxHits;
        if (typeof config.maxTextLen === 'number') this.maxTextLen = config.maxTextLen;
        logger.info(COMPONENT, `Bootstrapped: topKPerSource=${this.topKPerSource}, minScore=${this.minScore}, maxHits=${this.maxHits}`);
    }

    async assemble(context: ChatMessage[], userMessage: string): Promise<ChatMessage[]> {
        logger.info(COMPONENT, `assemble called for query: "${(userMessage||'').slice(0,80)}"`);
        const query = (userMessage || '').trim();
        if (!query || query.length < 6) return context;

        try {
            const { searchVectors, isVectorSearchAvailable } = await import('../memory/vectors.js');
            if (!isVectorSearchAvailable()) {
                logger.info(COMPONENT, 'vector search unavailable — skipping');
                return context;
            }
            logger.info(COMPONENT, `searching ${SEARCH_SOURCES.length} sources for query (minScore=${this.minScore}, topK=${this.topKPerSource})`);

            // Fan out across sources in parallel
            const perSource = await Promise.all(
                SEARCH_SOURCES.map(async (src) => {
                    try {
                        const hits = await searchVectors(query, this.topKPerSource, src, this.minScore);
                        return hits.map(h => ({ ...h, source: src }));
                    } catch (e) {
                        logger.debug(COMPONENT, `source ${src} search failed: ${(e as Error).message}`);
                        return [];
                    }
                }),
            );

            // Merge, sort by score, cap
            const merged = perSource.flat().sort((a, b) => b.score - a.score).slice(0, this.maxHits);
            logger.info(COMPONENT, `search produced ${merged.length} merged hits (perSource: ${perSource.map(p=>p.length).join(",")})`);
            if (merged.length === 0) return context;

            const lines = merged.map(h => {
                const text = (h.text || '').slice(0, this.maxTextLen);
                return `- [${h.source} / ${h.score.toFixed(2)}] ${text}`;
            });
            const injected: ChatMessage = {
                role: 'system',
                content: `[Relevant memories — top ${merged.length} from semantic search]\n${lines.join('\n')}`,
            };

            // Insert right before the last user message
            const result = [...context];
            let lastUserIdx = -1;
            for (let i = result.length - 1; i >= 0; i--) {
                if (result[i].role === 'user') { lastUserIdx = i; break; }
            }
            if (lastUserIdx >= 0) {
                result.splice(lastUserIdx, 0, injected);
            } else {
                result.push(injected);
            }
            logger.info(COMPONENT, `[HIT] Injected ${merged.length} hit(s) for query: \"${query.slice(0, 60)}\"`);
            return result;
        } catch (e) {
            logger.warn(COMPONENT, `assemble failed: ${(e as Error).message}`);
            return context;
        }
    }
}

/** Factory — keeps the registration pattern consistent with topFacts. */
export function createMemoryRetrievalPlugin(): ContextEnginePlugin {
    return new MemoryRetrievalPlugin();
}
