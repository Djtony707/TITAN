/**
 * TITAN — Native Temporal Knowledge Graph
 * Pure TypeScript graph memory: no Docker, no Python, no extra API keys.
 * Uses TITAN's own LLM for entity extraction.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuid } from 'uuid';
import { loadConfig } from '../config/config.js';
import { recordTokenUsage } from '../agent/costOptimizer.js';
import logger from '../utils/logger.js';
import { isVectorSearchAvailable, addVector, searchVectors } from './vectors.js';

const COMPONENT = 'Graph';
const TITAN_HOME = join(homedir(), '.titan');
const GRAPH_PATH = join(TITAN_HOME, 'graph.json');

// ── Data Model ────────────────────────────────────────────────────

export interface Episode {
    id: string;
    content: string;
    source: string;
    createdAt: string;
    entities: string[]; // Entity IDs referenced
}

export interface Entity {
    id: string;
    name: string;
    aliases: string[];
    type: string; // 'person' | 'topic' | 'project' | 'place' | 'fact'
    summary: string;
    firstSeen: string;
    lastSeen: string;
    facts: string[];
}

export interface Edge {
    id: string;
    from: string;
    to: string;
    relation: string;
    createdAt: string;
}

export interface TitanGraph {
    episodes: Episode[];
    entities: Entity[];
    edges: Edge[];
}

export interface GraphNode {
    id: string;
    label: string;
    type: string;
    size: number;
    facts: string[];
}

export interface GraphEdge {
    from: string;
    to: string;
    label: string;
}

// ── In-memory graph ───────────────────────────────────────────────
let graph: TitanGraph = { episodes: [], entities: [], edges: [] };
let initialized = false;

// ── Persistence ───────────────────────────────────────────────────
function loadGraph(): void {
    mkdirSync(TITAN_HOME, { recursive: true });
    if (existsSync(GRAPH_PATH)) {
        try {
            const raw = readFileSync(GRAPH_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : [];
            // Normalize edges that use source/target/label (legacy) to from/to/relation
            const edges: Edge[] = rawEdges.map((e: Record<string, unknown>) => ({
                id: (e.id as string) || uuid(),
                from: (e.from as string) || (e.source as string) || '',
                to: (e.to as string) || (e.target as string) || '',
                relation: (e.relation as string) || (e.label as string) || 'related',
                createdAt: (e.createdAt as string) || new Date().toISOString(),
            }));
            // Normalize entities to ensure all required fields exist
            const entities = (Array.isArray(parsed.entities) ? parsed.entities : []).map(
                (e: Record<string, unknown>) => ({
                    ...e,
                    aliases: Array.isArray(e.aliases) ? e.aliases : [],
                    summary: (e.summary as string) || '',
                })
            );
            graph = {
                episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
                entities,
                edges,
            };
        } catch (e) {
            logger.warn(COMPONENT, `Failed to parse graph.json, starting fresh: ${(e as Error).message}`);
            graph = { episodes: [], entities: [], edges: [] };
        }
    }
}

let graphSaveTimeout: ReturnType<typeof setTimeout> | null = null;

function saveGraph(): void {
    if (graphSaveTimeout) clearTimeout(graphSaveTimeout);
    graphSaveTimeout = setTimeout(() => {
        writeFile(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf-8').catch((e) => {
            logger.error(COMPONENT, `Failed to save graph.json: ${(e as Error).message}`);
        });
    }, 1000);
    graphSaveTimeout.unref();
}

/** Flush graph to disk immediately (for shutdown) */
export function flushGraph(): void {
    if (graphSaveTimeout) { clearTimeout(graphSaveTimeout); graphSaveTimeout = null; }
    try {
        writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to flush graph.json: ${(e as Error).message}`);
    }
}

// ── Init ─────────────────────────────────────────────────────────
export function initGraph(): void {
    if (initialized) return;
    loadGraph();
    initialized = true;
    logger.info(COMPONENT, `Graph loaded: ${graph.episodes.length} episodes, ${graph.entities.length} entities`);
}

// ── Entity extraction via any configured LLM ────────────────────
async function extractEntities(content: string): Promise<Array<{ name: string; type: string; facts: string[] }>> {
    try {
        // Dynamic import to avoid circular dependency (router → config → graph)
        const { chat: routerChat } = await import('../providers/router.js');
        const config = loadConfig();
        const model = config.agent.model.toLowerCase();

        // Skip entity extraction for very small models that can't produce valid JSON
        const SKIP_MODELS = ['llama3.2:1b', 'tinyllama', 'phi-2'];
        if (SKIP_MODELS.some(m => model.includes(m))) return [];

        logger.info(COMPONENT, `Extracting entities from ${content.length} char episode via ${config.agent.model}`);

        const prompt = `Extract entities from this text as a JSON array. Each item: {"name":"...","type":"person|topic|project|place|fact","facts":["fact1","fact2"]}. Return ONLY the JSON array, no other text.\n\nText: ${content.slice(0, 500)}`;

        const response = await routerChat({
            model: config.agent.model,
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 1024,
            temperature: 0.1,
            thinking: false,
        });

        // Track LLM costs for entity extraction so cost optimizer sees them
        if (response.usage) {
            recordTokenUsage(
                'graph:extractEntities',
                config.agent.model,
                response.usage.promptTokens ?? 0,
                response.usage.completionTokens ?? 0,
            );
        }

        const text = response.content || '';
        logger.info(COMPONENT, `Extraction response: ${text.length} chars`);
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) {
            logger.warn(COMPONENT, `No JSON array found in extraction response: ${text.slice(0, 200)}`);
            return [];
        }

        // Try to repair common JSON issues from small models
        const jsonStr = match[0]
            .replace(/,\s*]/g, ']')        // trailing commas in arrays
            .replace(/,\s*}/g, '}')         // trailing commas in objects
            .replace(/'/g, '"');            // single quotes to double

        // Attempt parse, with truncated JSON recovery on failure
        const tryParse = (str: string): unknown[] | null => {
            try {
                const parsed = JSON.parse(str);
                return Array.isArray(parsed) ? parsed : null;
            } catch { return null; }
        };

        let parsed = tryParse(jsonStr);

        // If parse failed, try closing truncated brackets (LLM output cut off mid-JSON)
        if (!parsed) {
            // Remove any trailing incomplete object (after last complete }, or ,)
            let recovered = jsonStr.replace(/,\s*\{[^}]*$/, '');
            // Close any unclosed brackets
            const opens = (recovered.match(/\[/g) || []).length;
            const openBraces = (recovered.match(/\{/g) || []).length;
            const closeBraces = (recovered.match(/\}/g) || []).length;
            recovered += '}'.repeat(Math.max(0, openBraces - closeBraces));
            // Clean trailing commas before closing
            recovered = recovered.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            recovered += ']'.repeat(Math.max(0, opens - (recovered.match(/\]/g) || []).length));
            parsed = tryParse(recovered);
            if (parsed) {
                logger.info(COMPONENT, `Recovered truncated JSON (${jsonStr.length} → ${recovered.length} chars)`);
            }
        }

        if (!parsed) {
            logger.warn(COMPONENT, `Entity extraction JSON parse failed, raw: ${jsonStr.slice(0, 200)}`);
            return [];
        }
        const filtered = parsed.filter((e: unknown): e is { name: string; type: string; facts: string[] } =>
            e != null && typeof e === 'object' && 'name' in (e as object) && 'type' in (e as object));
        logger.info(COMPONENT, `Extraction parsed ${parsed.length} items, ${filtered.length} valid entities`);
        return filtered;
    } catch (err) {
        logger.warn(COMPONENT, `Entity extraction failed: ${(err as Error).message}`);
        return [];
    }
}

// ── Find or create an entity by name ────────────────────────────
function findOrCreateEntity(name: string, type: string, facts: string[]): Entity {
    const nameLower = name.toLowerCase().trim();

    // Search by exact name and aliases
    let existing = graph.entities.find((e) => {
        if (e.name.toLowerCase() === nameLower) return true;
        if (Array.isArray(e.aliases) && e.aliases.some((a) => a.toLowerCase() === nameLower)) return true;
        return false;
    });

    // Fuzzy match: if "Tony" and "Tony Elliott" refer to the same entity, merge them
    if (!existing) {
        existing = graph.entities.find((e) => {
            if (e.type !== type && type !== 'topic') return false; // only merge same-type entities
            const eLower = e.name.toLowerCase();
            // Check if one name contains the other (partial name match)
            if (eLower.includes(nameLower) || nameLower.includes(eLower)) return true;
            // Check aliases too
            if (Array.isArray(e.aliases) && e.aliases.some((a) => {
                const aLower = a.toLowerCase();
                return aLower.includes(nameLower) || nameLower.includes(aLower);
            })) return true;
            return false;
        });
        if (existing) {
            // Add the shorter name as an alias if not already present
            const shorter = nameLower.length < existing.name.toLowerCase().length ? name : existing.name;
            const longer = nameLower.length >= existing.name.toLowerCase().length ? name : existing.name;
            existing.name = longer; // prefer the longer, more specific name
            if (!existing.aliases.some((a) => a.toLowerCase() === shorter.toLowerCase())) {
                existing.aliases.push(shorter);
            }
            logger.debug(COMPONENT, `Fuzzy-merged "${name}" into entity "${existing.name}"`);
        }
    }

    if (existing) {
        // Merge new facts
        const newFacts = facts.filter((f) => !existing!.facts.includes(f));
        if (newFacts.length > 0) existing.facts.push(...newFacts);
        existing.lastSeen = new Date().toISOString();
        return existing;
    }

    // Create new entity
    const entity: Entity = {
        id: uuid(),
        name,
        aliases: [],
        type,
        summary: facts[0] || '',
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        facts,
    };
    graph.entities.push(entity);
    return entity;
}

// ── Add Episode ──────────────────────────────────────────────────
export async function addEpisode(content: string, source: string): Promise<Episode> {
    if (!initialized) initGraph();

    const episode: Episode = {
        id: uuid(),
        content,
        source,
        createdAt: new Date().toISOString(),
        entities: [],
    };
    graph.episodes.push(episode);
    saveGraph();

    // Index to vector store for semantic search (fire-and-forget)
    if (isVectorSearchAvailable()) {
        addVector(`graph:${episode.id}`, content, 'graph', { source, episodeId: episode.id }).catch(() => {});
    }

    // Background entity extraction (non-blocking)
    extractEntities(content).then((extracted) => {
        if (!extracted || extracted.length === 0) return;

        // Ensure graph arrays exist (defensive against race conditions)
        if (!Array.isArray(graph.edges)) graph.edges = [];
        if (!Array.isArray(graph.entities)) graph.entities = [];
        if (!Array.isArray(graph.episodes)) graph.episodes = [];

        for (const e of extracted) {
            if (!e.name) continue;
            const entity = findOrCreateEntity(e.name, e.type || 'topic', e.facts || []);
            if (!episode.entities.includes(entity.id)) {
                episode.entities.push(entity.id);
            }
        }
        // Create edges between co-occurring entities in this episode
        if (episode.entities.length > 1) {
            for (let i = 0; i < episode.entities.length; i++) {
                for (let j = i + 1; j < episode.entities.length; j++) {
                    const fromId = episode.entities[i];
                    const toId = episode.entities[j];
                    const exists = graph.edges.some(
                        (edge) => (edge.from === fromId && edge.to === toId) || (edge.from === toId && edge.to === fromId)
                    );
                    if (!exists) {
                        graph.edges.push({
                            id: uuid(),
                            from: fromId,
                            to: toId,
                            relation: 'co_mentioned',
                            createdAt: new Date().toISOString(),
                        });
                    }
                }
            }
        }
        // Enforce size limits
        if (graph.episodes.length > 5000) {
            graph.episodes = graph.episodes.slice(-5000);
        }
        if (graph.entities.length > 1000) {
            graph.entities.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
            graph.entities = graph.entities.slice(0, 1000);
        }
        const MAX_EDGES = 10000;
        if (graph.edges.length > MAX_EDGES) {
            // Sort by timestamp ascending and keep only the newest
            graph.edges.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            graph.edges = graph.edges.slice(-MAX_EDGES);
        }
        saveGraph();
        logger.info(COMPONENT, `Episode ${episode.id.slice(0, 8)}: extracted ${extracted.length} entities, total ${graph.entities.length} entities, ${graph.edges.length} edges`);
    }).catch((err) => logger.warn(COMPONENT, `Background entity extraction failed: ${(err as Error).message}`));

    return episode;
}

// ── Search (hybrid keyword + vector) ─────────────────────────────
export function searchMemory(query: string, limit = 20): Episode[] {
    if (!initialized) initGraph();
    if (!query) return getRecentEpisodes(limit);

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = new Map<string, { ep: Episode; score: number }>();

    // Keyword search (BM25-style scoring)
    for (const ep of graph.episodes) {
        const text = ep.content.toLowerCase();
        let score = 0;
        for (const term of terms) {
            if (text.includes(term)) {
                score += 1;
                // Boost for term appearing in first 100 chars (title/summary area)
                if (text.slice(0, 100).includes(term)) score += 0.5;
            }
        }
        if (score > 0) {
            scored.set(ep.id, { ep, score });
        }
    }

    // Vector search augmentation (async, but we cache results for next call)
    if (isVectorSearchAvailable()) {
        searchVectors(query, limit * 2, 'graph', 0.35).then(vectorResults => {
            // Store in a module-level cache for getGraphContext to use
            lastVectorResults = vectorResults.map(vr => ({
                id: vr.id.replace('graph:', ''),
                score: vr.score,
            }));
        }).catch(() => {});
    }

    // Merge cached vector results if available
    if (lastVectorResults.length > 0) {
        for (const vr of lastVectorResults) {
            const ep = graph.episodes.find(e => e.id === vr.id);
            if (!ep) continue;
            const existing = scored.get(ep.id);
            if (existing) {
                existing.score += vr.score * 2; // Boost keyword matches with semantic similarity
            } else {
                scored.set(ep.id, { ep, score: vr.score * 1.5 });
            }
        }
    }

    return Array.from(scored.values())
        .sort((a, b) => {
            if (Math.abs(b.score - a.score) > 0.1) return b.score - a.score;
            return b.ep.createdAt.localeCompare(a.ep.createdAt);
        })
        .slice(0, limit)
        .map((s) => s.ep);
}

// Cache for async vector search results
let lastVectorResults: Array<{ id: string; score: number }> = [];

// ── Entity lookups ────────────────────────────────────────────────
export function getEntity(name: string): Entity | null {
    if (!initialized) initGraph();
    const nameLower = name.toLowerCase().trim();
    return graph.entities.find((e) =>
        e.name.toLowerCase() === nameLower ||
        (Array.isArray(e.aliases) && e.aliases.some((a) => a.toLowerCase() === nameLower))
    ) || null;
}

export function listEntities(type?: string): Entity[] {
    if (!initialized) initGraph();
    const all = type ? graph.entities.filter((e) => e.type === type) : graph.entities;
    return all.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function getEntityEpisodes(entityId: string, limit = 10): Episode[] {
    if (!initialized) initGraph();
    return graph.episodes
        .filter((ep) => ep.entities.includes(entityId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
}

export function getRecentEpisodes(limit = 20): Episode[] {
    if (!initialized) initGraph();
    return graph.episodes
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
}

// ── Graph data for Mission Control ────────────────────────────────
export function getGraphData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    if (!initialized) initGraph();
    const nodes: GraphNode[] = graph.entities.map((e) => ({
        id: e.id,
        label: e.name,
        type: e.type,
        size: Math.max(12, Math.min(30, 12 + e.facts.length * 3)),
        facts: e.facts,
    }));
    const edges: GraphEdge[] = graph.edges.map((e) => ({
        from: e.from,
        to: e.to,
        label: e.relation,
    }));
    return { nodes, edges };
}

export function getGraphStats(): { episodeCount: number; entityCount: number; edgeCount: number } {
    if (!initialized) initGraph();
    return {
        episodeCount: graph.episodes.length,
        entityCount: graph.entities.length,
        edgeCount: graph.edges.length,
    };
}

/** Get relevant graph context for a user message (for system prompt injection) */
export function getGraphContext(query: string): string {
    if (!initialized) initGraph();
    if (graph.episodes.length === 0 && graph.entities.length === 0) return '';

    const parts: string[] = [];

    // Search for relevant episodes
    if (query) {
        const relevant = searchMemory(query, 5);
        if (relevant.length > 0) {
            parts.push('Relevant memories from knowledge graph:');
            for (const ep of relevant) {
                parts.push(`- [${ep.source}, ${ep.createdAt.slice(0, 10)}]: ${ep.content.slice(0, 150)}`);
            }
        }
    }

    // Include recently active entities (top 5)
    const recentEntities = graph.entities
        .slice()
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .slice(0, 5);

    if (recentEntities.length > 0) {
        parts.push('Known entities:');
        for (const e of recentEntities) {
            const factsStr = e.facts.length > 0 ? ` (${e.facts.slice(0, 2).join('; ')})` : '';
            parts.push(`- ${e.name} [${e.type}]${factsStr}`);
        }
    }

    return parts.length > 0 ? parts.join('\n') : '';
}

/**
 * Flush important facts from conversation context into graph memory before compaction.
 * Prevents memory loss when context is trimmed during long sessions.
 */
export async function flushMemoryBeforeCompaction(messages: Array<{ role: string; content?: string }>): Promise<number> {
    if (!initialized) initGraph();

    // Collect user and assistant messages that are about to be compacted
    const contentParts: string[] = [];
    for (const msg of messages) {
        if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
            contentParts.push(msg.content.slice(0, 500));
        }
    }

    if (contentParts.length === 0) return 0;

    const combined = contentParts.join('\n---\n').slice(0, 3000);

    try {
        const episode = await addEpisode(combined, 'context-flush');
        logger.info(COMPONENT, `Memory flush: saved ${contentParts.length} messages as episode ${episode.id.slice(0, 8)}`);
        return contentParts.length;
    } catch (err) {
        logger.warn(COMPONENT, `Memory flush failed: ${(err as Error).message}`);
        return 0;
    }
}

/** Clear all graph data */
export function clearGraph(): void {
    graph = { episodes: [], entities: [], edges: [] };
    saveGraph();
    logger.info(COMPONENT, 'Graph cleared');
}
