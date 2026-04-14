/**
 * TITAN — Native Temporal Knowledge Graph
 * Pure TypeScript graph memory: no Docker, no Python, no extra API keys.
 * Uses TITAN's own LLM for entity extraction.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
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

// ── Memory Bounds (Hermes-inspired) ──────────────────────────────
const MAX_ENTITIES = 500;          // Prune oldest when exceeded
const MAX_FACTS_PER_ENTITY = 50;   // Cap facts per entity
const MAX_EPISODES = 5000;         // Prune oldest episodes
const MAX_FACT_CHARS = 500;        // Max chars per fact entry

// ── Injection Protection ─────────────────────────────────────────
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /you\s+are\s+now\s+a/i,
    /forget\s+(all\s+)?your\s+(instructions|rules)/i,
    /system\s*:\s*you\s+are/i,
    /\[INST\]/i,
    /<<SYS>>/i,
    /\bACT\s+AS\b/i,
    /new\s+instructions?\s*:/i,
    /override\s+(the\s+)?system/i,
];

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
    type: string; // person | project | topic | place | company | technology | event
    summary: string;
    firstSeen: string;
    lastSeen: string;
    facts: string[];
    episodeIds: string[];
}

// ── Allowed entity types ─────────────────────────────────────────
const ALLOWED_TYPES = new Set(['person', 'project', 'topic', 'place', 'company', 'technology', 'event']);

const TYPE_COERCION: Record<string, string> = {
    fact: 'topic',
    preference: 'topic',
    feature: 'technology',
    software: 'technology',
    system: 'technology',
    hardware: 'technology',
    component: 'technology',
    tool: 'technology',
    product: 'technology',
    file: '__skip__',
    directory: '__skip__',
    scenario: '__skip__',
    'person|organization': 'company',
};

/** Validate and coerce entity type to allowed set */
function coerceType(raw: string): string | null {
    const t = raw?.toLowerCase().trim();
    if (ALLOWED_TYPES.has(t)) return t;
    const coerced = TYPE_COERCION[t];
    if (coerced === '__skip__') return null; // filter out
    return coerced ?? 'topic'; // default fallback
}

// Well-known tech names that look like filenames but aren't
const NOT_NOISE = new Set(['node.js', 'vue.js', 'next.js', 'nuxt.js', 'three.js', 'p5.js', 'express.js', 'd3.js', 'socket.io']);

/** Check if a name is noise (file paths, URLs, numbers, tokens) */
function isNoiseEntity(name: string): boolean {
    const n = name.trim();
    if (n.length < 2) return true;
    if (/^\d+$/.test(n)) return true; // pure numbers
    if (/^[/~]/.test(n)) return true; // absolute/home paths
    if (n.includes('/') && n.includes('.') && !n.includes(' ')) return true; // file paths like src/foo.ts
    if (/^https?:\/\//i.test(n)) return true; // URLs
    if (!NOT_NOISE.has(n.toLowerCase()) && /^\w+\.\w{1,4}$/.test(n) && /\.(ts|js|json|md|py|sh|txt|log|html|css|yml|yaml|toml|cfg)$/i.test(n)) return true; // filenames
    if (/^(api\/|http:|localhost|127\.0\.|192\.168\.)/.test(n.toLowerCase())) return true; // API paths/IPs
    return false;
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
let dirty = false;

// ── Persistence ───────────────────────────────────────────────────
// NOTE: Sync I/O is intentional — runs only once at cold start, then cached in-memory.
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
    if (dirty) {
        // Bypass debounce if a previous write failed
        if (graphSaveTimeout) { clearTimeout(graphSaveTimeout); graphSaveTimeout = null; }
        doAsyncSave();
        return;
    }
    if (graphSaveTimeout) clearTimeout(graphSaveTimeout);
    graphSaveTimeout = setTimeout(doAsyncSave, 1000);
    graphSaveTimeout.unref();
}

let saveInProgress = false;

async function doAsyncSave(): Promise<void> {
    if (saveInProgress) {
        dirty = true;
        return;
    }
    saveInProgress = true;
    try {
        const tmpFile = GRAPH_PATH + '.tmp';
        await writeFile(tmpFile, JSON.stringify(graph, null, 2), 'utf-8');
        await rename(tmpFile, GRAPH_PATH);
        dirty = false;
    } catch (e) {
        dirty = true;
        logger.error(COMPONENT, `Failed to save graph.json: ${(e as Error).message}`);
    } finally {
        saveInProgress = false;
    }
}

/** Flush graph to disk immediately (for shutdown) */
export function flushGraph(): void {
    if (graphSaveTimeout) { clearTimeout(graphSaveTimeout); graphSaveTimeout = null; }
    try {
        const tmpFile = GRAPH_PATH + '.tmp';
        writeFileSync(tmpFile, JSON.stringify(graph, null, 2), 'utf-8');
        renameSync(tmpFile, GRAPH_PATH);
        dirty = false;
    } catch (e) {
        dirty = true;
        logger.error(COMPONENT, `Failed to flush graph.json: ${(e as Error).message}`);
    }
    if (dirty) {
        logger.error(COMPONENT, 'DATA MAY BE LOST — failed to flush graph on shutdown');
    }
}

// ── Init ─────────────────────────────────────────────────────────
export function initGraph(): void {
    if (initialized) return;
    loadGraph();
    initialized = true;

    // Self-healing: purge poisoned episodes on startup
    const beforeCount = graph.episodes.length;
    graph.episodes = graph.episodes.filter(ep => {
        const c = ep.content.toLowerCase();
        if (c.includes('[titan') && POISON_PHRASES.some(p => c.includes(p))) return false;
        return true;
    });
    const purged = beforeCount - graph.episodes.length;
    if (purged > 0) {
        logger.info(COMPONENT, `Self-heal: purged ${purged} poisoned episodes (negative recall responses)`);
        saveGraph();
    }

    logger.info(COMPONENT, `Graph loaded: ${graph.episodes.length} episodes, ${graph.entities.length} entities`);

    // Schedule periodic self-healing every 24 hours
    setInterval(() => {
        const before = graph.episodes.length;
        graph.episodes = graph.episodes.filter(ep => {
            const c = ep.content.toLowerCase();
            if (c.includes('[titan') && POISON_PHRASES.some(p => c.includes(p))) return false;
            return true;
        });
        const cleaned = before - graph.episodes.length;
        if (cleaned > 0) {
            logger.info(COMPONENT, `Self-heal (periodic): purged ${cleaned} poisoned episodes`);
            saveGraph();
        }
    }, 24 * 60 * 60 * 1000).unref();
}

// ── Entity extraction via any configured LLM ────────────────────
async function extractEntities(content: string): Promise<{ entities: Array<{ name: string; type: string; facts: string[] }>; relations: Array<{ from: string; to: string; relation: string }> }> {
    try {
        // Dynamic import to avoid circular dependency (router → config → graph)
        // Dynamic import breaks circular dependency: graph → router → agent → graph. This is intentional.
        const { chat: routerChat } = await import('../providers/router.js');
        const config = loadConfig();
        const model = config.agent.model.toLowerCase();

        // Skip entity extraction for very small models that can't produce valid JSON
        const SKIP_MODELS = ['llama3.2:1b', 'tinyllama', 'phi-2'];
        if (SKIP_MODELS.some(m => model.includes(m))) return { entities: [], relations: [] };

        logger.info(COMPONENT, `Extracting entities from ${content.length} char episode via ${config.agent.model}`);

        const prompt = `Extract named entities and their relationships from this text as JSON.

RULES:
- Extract MAX 3 entities (most important only)
- Types MUST be one of: person, project, topic, place, company, technology
- SKIP: file paths, URLs, API endpoints, code tokens, session IDs, config keys
- Keep facts short (under 10 words each, max 2 facts per entity)

Return format: {"entities":[{"name":"...","type":"...","facts":["..."]}],"relations":[]}

Return ONLY valid JSON, no markdown, no explanation.

Text: ${content.slice(0, 500)}`;

        const response = await routerChat({
            model: config.agent.model,
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 512,
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

        const rawText = response.content || '';
        logger.info(COMPONENT, `Extraction response: ${rawText.length} chars`);

        // Strip markdown code fences, leading/trailing noise before regex matching
        const text = rawText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();

        // Match JSON — try structured formats first, then fallback to any JSON
        // 1. {entities:[...], relations:[...]} format
        // 2. [{name:...},...] array format (legacy)
        // 3. Any JSON object with "name" key
        // 4. Any JSON array
        const match = text.match(/\{[\s\S]*"entities"\s*:\s*\[[\s\S]*\}/)
            ?? text.match(/\[[\s\S]*"name"\s*:[\s\S]*\]/)
            ?? text.match(/\{[\s\S]*"name"\s*:[\s\S]*\}/);
        if (!match) {
            logger.warn(COMPONENT, `No JSON found in extraction response: ${text.slice(0, 200)}`);
            return { entities: [], relations: [] };
        }

        // Try to repair common JSON issues from small models
        const jsonStr = match[0]
            .replace(/,\s*]/g, ']')        // trailing commas in arrays
            .replace(/,\s*}/g, '}')         // trailing commas in objects
            .replace(/'/g, '"');            // single quotes to double

        // Attempt parse, with truncated JSON recovery on failure
        const tryParse = (str: string): unknown => {
            try {
                return JSON.parse(str);
            } catch { return null; }
        };

        let parsed = tryParse(jsonStr);

        // If parse failed, try closing truncated brackets (LLM output cut off mid-JSON)
        if (!parsed) {
            let recovered = jsonStr.replace(/,\s*\{[^}]*$/, '');
            const opens = (recovered.match(/\[/g) || []).length;
            const openBraces = (recovered.match(/\{/g) || []).length;
            const closeBraces = (recovered.match(/\}/g) || []).length;
            recovered += '}'.repeat(Math.max(0, openBraces - closeBraces));
            recovered = recovered.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            recovered += ']'.repeat(Math.max(0, opens - (recovered.match(/\]/g) || []).length));
            parsed = tryParse(recovered);
            if (parsed) {
                logger.info(COMPONENT, `Recovered truncated JSON (${jsonStr.length} → ${recovered.length} chars)`);
            }
        }

        if (!parsed) {
            logger.warn(COMPONENT, `Entity extraction JSON parse failed, raw: ${jsonStr.slice(0, 200)}`);
            return { entities: [], relations: [] };
        }

        // Handle new format: {entities: [...], relations: [...]} or legacy array format
        let rawEntities: unknown[] = [];
        let rawRelations: Array<{ from: string; to: string; relation: string }> = [];

        if (Array.isArray(parsed)) {
            // Legacy array format — check if first element has 'entities' key (wrapped in array)
            if (parsed.length === 1 && parsed[0] && typeof parsed[0] === 'object' && 'entities' in (parsed[0] as object)) {
                const obj = parsed[0] as { entities?: unknown[]; relations?: unknown[] };
                rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
                rawRelations = Array.isArray(obj.relations) ? obj.relations as typeof rawRelations : [];
            } else {
                rawEntities = parsed;
            }
        } else if (typeof parsed === 'object' && parsed !== null) {
            // Direct object with entities/relations
            const obj = parsed as unknown as { entities?: unknown[]; relations?: unknown[] };
            rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
            rawRelations = Array.isArray(obj.relations) ? obj.relations as typeof rawRelations : [];
        }

        // Validate and filter entities
        const entities = rawEntities
            .filter((e: unknown): e is { name: string; type: string; facts: string[] } =>
                e != null && typeof e === 'object' && 'name' in (e as object) && 'type' in (e as object))
            .filter(e => !isNoiseEntity(e.name))
            .map(e => {
                const type = coerceType(e.type);
                if (!type) return null; // skipped type
                return { name: e.name, type, facts: Array.isArray(e.facts) ? e.facts : [] };
            })
            .filter((e): e is { name: string; type: string; facts: string[] } => e !== null);

        // Build validated relations to return alongside entities
        const validatedRelations = rawRelations
            .filter(r => r.from && r.to && r.relation && typeof r.relation === 'string')
            .map(r => ({ from: r.from, to: r.to, relation: r.relation.toLowerCase().replace(/\s+/g, '_') }));

        logger.info(COMPONENT, `Extraction: ${rawEntities.length} raw → ${entities.length} valid entities, ${rawRelations.length} relations`);
        return { entities, relations: validatedRelations };
    } catch (err) {
        logger.warn(COMPONENT, `Entity extraction failed: ${(err as Error).message}`);
        return { entities: [], relations: [] };
    }
}

/** Word-overlap fuzzy matching — requires >60% shared words or one name is a prefix of the other */
function fuzzyNameMatch(a: string, b: string): boolean {
    // Exact prefix/suffix match for compound names: "Tony" vs "Tony Elliott"
    const wordsA = a.split(/[\s\-_]+/).filter(w => w.length > 0);
    const wordsB = b.split(/[\s\-_]+/).filter(w => w.length > 0);

    // If one is a single word and the other is multi-word, the single word must be a full word in the other
    if (wordsA.length === 1 && wordsB.length > 1) {
        return wordsB.some(w => w === wordsA[0]);
    }
    if (wordsB.length === 1 && wordsA.length > 1) {
        return wordsA.some(w => w === wordsB[0]);
    }

    // Multi-word: require >60% word overlap
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    let overlap = 0;
    for (const w of setA) { if (setB.has(w)) overlap++; }
    const minLen = Math.min(setA.size, setB.size);
    return minLen > 0 && overlap / minLen >= 0.6;
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

    // Fuzzy match: word-overlap based (not substring) to avoid false merges
    if (!existing) {
        existing = graph.entities.find((e) => {
            if (e.type !== type && type !== 'topic') return false;
            if (nameLower.length < 4 || e.name.length < 4) return false; // skip short names
            if (fuzzyNameMatch(nameLower, e.name.toLowerCase())) return true;
            if (Array.isArray(e.aliases) && e.aliases.some((a) => a.length >= 4 && fuzzyNameMatch(nameLower, a.toLowerCase()))) return true;
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
        episodeIds: [],
    };
    graph.entities.push(entity);
    return entity;
}

// ── Memory Bounds Enforcement ────────────────────────────────────

function enforceMemoryBounds(): void {
    // Prune episodes if over limit (keep newest)
    if (graph.episodes.length > MAX_EPISODES) {
        const excess = graph.episodes.length - MAX_EPISODES;
        graph.episodes.splice(0, excess);
        logger.info(COMPONENT, `Pruned ${excess} oldest episodes (limit: ${MAX_EPISODES})`);
    }
    // Prune entities if over limit (keep most recently seen)
    if (graph.entities.length > MAX_ENTITIES) {
        graph.entities.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
        const excess = graph.entities.length - MAX_ENTITIES;
        const removed = graph.entities.splice(MAX_ENTITIES, excess);
        const removedIds = new Set(removed.map(e => e.id));
        graph.edges = graph.edges.filter(e => !removedIds.has(e.from) && !removedIds.has(e.to));
        logger.info(COMPONENT, `Pruned ${excess} oldest entities (limit: ${MAX_ENTITIES})`);
    }
    // Cap facts per entity
    for (const entity of graph.entities) {
        if (entity.facts.length > MAX_FACTS_PER_ENTITY) {
            entity.facts = entity.facts.slice(-MAX_FACTS_PER_ENTITY);
        }
        // Truncate individual facts
        entity.facts = entity.facts.map(f => f.length > MAX_FACT_CHARS ? f.slice(0, MAX_FACT_CHARS) + '…' : f);
    }
}

function containsInjection(text: string): boolean {
    return INJECTION_PATTERNS.some(p => p.test(text));
}

// ── Add Episode ──────────────────────────────────────────────────
// Phrases that indicate a failed/negative response — don't store these as memories
const POISON_PHRASES = [
    'i do not recall', 'i do not remember', 'i am not able to find',
    'i am not certain', 'was not retained', 'not stored', 'i did not retain',
    'my memory does not contain', 'i do not know that specific',
    'could not find it through search', 'does not appear in my knowledge',
];

export async function addEpisode(content: string, source: string): Promise<Episode> {
    if (!initialized) initGraph();

    // Guard: don't store injection attempts
    if (containsInjection(content)) {
        logger.warn(COMPONENT, `Blocked injection attempt in episode from ${source}`);
        return { id: '', content, source, createdAt: new Date().toISOString(), entities: [] };
    }

    // Guard: don't store TITAN's "I don't know" responses — they poison future recall
    const contentLower = content.toLowerCase();
    if (contentLower.includes('[titan') && POISON_PHRASES.some(p => contentLower.includes(p))) {
        return { id: '', content, source, createdAt: new Date().toISOString(), entities: [] };
    }

    const episode: Episode = {
        id: uuid(),
        content,
        source,
        createdAt: new Date().toISOString(),
        entities: [],
    };
    graph.episodes.push(episode);
    enforceMemoryBounds();
    saveGraph();

    // Index to vector store for semantic search (fire-and-forget)
    if (isVectorSearchAvailable()) {
        addVector(`graph:${episode.id}`, content, 'graph', { source, episodeId: episode.id }).catch(() => {});
    }

    // Background entity extraction (non-blocking)
    extractEntities(content).then((result) => {
        const { entities: extracted, relations } = result;
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
            // Reverse link: entity -> episode
            if (!entity.episodeIds) entity.episodeIds = [];
            if (!entity.episodeIds.includes(episode.id)) {
                entity.episodeIds.push(episode.id);
            }
        }
        // Create edges — use extracted relations when available, fall back to co_mentioned
        const entityNameToId = new Map<string, string>();
        for (const eid of episode.entities) {
            const ent = graph.entities.find(en => en.id === eid);
            if (ent) {
                entityNameToId.set(ent.name.toLowerCase(), eid);
                for (const alias of ent.aliases) entityNameToId.set(alias.toLowerCase(), eid);
            }
        }

        // Apply LLM-extracted semantic relations
        let newEdgeCount = 0;
        const MAX_NEW_EDGES = 5;
        const usedPairs = new Set<string>();
        if (relations.length > 0) {
            for (const rel of relations) {
                if (newEdgeCount >= MAX_NEW_EDGES) break;
                const fromId = entityNameToId.get(rel.from.toLowerCase());
                const toId = entityNameToId.get(rel.to.toLowerCase());
                if (!fromId || !toId || fromId === toId) continue;
                const pairKey = [fromId, toId].sort().join(':');
                if (usedPairs.has(pairKey)) continue;
                usedPairs.add(pairKey);
                const exists = graph.edges.some(
                    (edge) => (edge.from === fromId && edge.to === toId) || (edge.from === toId && edge.to === fromId)
                );
                if (!exists) {
                    graph.edges.push({
                        id: uuid(),
                        from: fromId,
                        to: toId,
                        relation: rel.relation || 'related_to',
                        createdAt: new Date().toISOString(),
                    });
                    newEdgeCount++;
                }
            }
        }

        // Fall back to co_mentioned for remaining entity pairs (limit to avoid edge explosion)
        const MAX_CO_EDGES = 5;
        let newCoEdgeCount = 0;
        if (episode.entities.length > 1 && episode.entities.length <= 8) {
            for (let i = 0; i < episode.entities.length; i++) {
                if (newCoEdgeCount >= MAX_CO_EDGES) break;
                for (let j = i + 1; j < episode.entities.length; j++) {
                    if (newCoEdgeCount >= MAX_CO_EDGES) break;
                    const fromId = episode.entities[i];
                    const toId = episode.entities[j];
                    const pairKey = [fromId, toId].sort().join(':');
                    if (usedPairs.has(pairKey)) continue;
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
                        newCoEdgeCount++;
                    }
                }
            }
        }
        enforceMemoryBounds();
        saveGraph();
        logger.info(COMPONENT, `Episode ${episode.id.slice(0, 8)}: extracted ${extracted.length} entities, total ${graph.entities.length} entities, ${graph.edges.length} edges`);
    }).catch((err) => logger.warn(COMPONENT, `Background entity extraction failed: ${(err as Error).message}`));

    return episode;
}

// ── Search (hybrid keyword + vector) ─────────────────────────────
export function searchMemory(query: string, limit = 20): Episode[] {
    if (!initialized) initGraph();
    if (!query) return getRecentEpisodes(limit);

    const STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'of', 'do', 'you', 'we', 'i', 'me', 'my', 'that', 'this', 'was', 'are', 'be', 'been', 'have', 'has', 'had', 'and', 'or', 'but', 'if', 'so', 'not', 'no', 'yes', 'can', 'how', 'what', 'about', 'from', 'with', 'for', 'up', 'out', 'its', 'our', 'your', 'they', 'them', 'he', 'she', 'his', 'her', 'will', 'would', 'could', 'should', 'did', 'does', 'just', 'now', 'some', 'any', 'all', 'very', 'too', 'also', 'than', 'then', 'when', 'where', 'who', 'which', 'there', 'here', 'again', 'today', 'earlier', 'remember']);
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1 && !STOP_WORDS.has(t));
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

    // Bridge vague queries to specific memories via entity matching
    // When user says "the joke" → find entity "two cannibals eating the Clown" → find episodes mentioning it
    for (const entity of graph.entities) {
        const entityText = `${entity.name} ${entity.summary || ''} ${entity.facts.join(' ')}`.toLowerCase();
        let entityMatch = false;
        for (const term of terms) {
            if (entityText.includes(term)) { entityMatch = true; break; }
        }
        if (entityMatch) {
            // Search episodes for this entity's name (since episodeIds aren't populated)
            const entityNameLower = entity.name.toLowerCase();
            for (const ep of graph.episodes) {
                if (!scored.has(ep.id) && ep.content.toLowerCase().includes(entityNameLower)) {
                    scored.set(ep.id, { ep, score: 0.8 });
                }
            }
            // Also search for key terms from entity facts in episodes
            const factTerms = entity.facts.slice(0, 3).join(' ').toLowerCase().split(/\s+/).filter(t => t.length > 4);
            for (const ep of graph.episodes) {
                if (!scored.has(ep.id)) {
                    let factScore = 0;
                    for (const ft of factTerms) {
                        if (ep.content.toLowerCase().includes(ft)) factScore += 0.3;
                    }
                    if (factScore > 0.5) scored.set(ep.id, { ep, score: factScore });
                }
            }
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
        lastVectorResults = [];
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

    // Search for relevant episodes — prioritize TITAN's informative responses over user questions and "I don't know" responses
    if (query) {
        const relevant = searchMemory(query, 15);
        // Filter: remove TITAN's "I don't recall/remember/know" responses — they poison the context
        // Also remove bare user questions (they don't contain useful info)
        // Keep: TITAN responses with actual content (answers, facts, jokes, etc.)
        const filtered = relevant.filter(ep => {
            const c = ep.content.toLowerCase();
            // Skip "I don't know" responses
            if (c.includes('i do not recall') || c.includes('i do not remember') || c.includes('i am not able to find') || c.includes('i am not certain') || c.includes('was not retained') || c.includes('not stored')) return false;
            // Skip bare user questions that are just the same query repeated
            if (c.startsWith('[voice/voice-user]') && c.includes('remember') && c.length < 100) return false;
            return true;
        }).slice(0, 5);

        if (filtered.length > 0) {
            parts.push('Relevant memories from past conversations:');
            for (const ep of filtered) {
                parts.push(`- [${ep.source}, ${ep.createdAt.slice(0, 10)}]: ${ep.content.slice(0, 300)}`);
            }
        }
    }

    // Search entities with quality scoring
    const STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'of', 'do', 'you', 'we', 'i', 'me', 'my', 'that', 'this', 'was', 'are', 'be', 'been', 'have', 'has', 'had', 'and', 'or', 'but', 'if', 'so', 'not', 'no', 'yes', 'can', 'how', 'what', 'about', 'from', 'with', 'for', 'up', 'out', 'its', 'our', 'your', 'they', 'them', 'he', 'she', 'his', 'her', 'will', 'would', 'could', 'should', 'did', 'does', 'just', 'now', 'some', 'any', 'all', 'very', 'too', 'also', 'than', 'then', 'when', 'where', 'who', 'which', 'there', 'here', 'again', 'today', 'earlier', 'remember']);
    const queryTerms = query ? query.toLowerCase().split(/\s+/).filter(t => t.length > 1 && !STOP_WORDS.has(t)) : [];
    const matchedEntities: Array<{ entity: typeof graph.entities[0]; score: number }> = [];

    // Type quality weights — persons and projects are more valuable context than generic topics
    const TYPE_WEIGHT: Record<string, number> = { person: 1.5, project: 1.3, company: 1.2, technology: 1.1, event: 1.0, place: 0.9, topic: 0.7 };

    for (const e of graph.entities) {
        // Skip noise entities that slipped through
        if (isNoiseEntity(e.name)) continue;
        // Skip entities with no facts at all
        if (e.facts.length === 0) continue;

        let score = 0;
        const searchText = `${e.name} ${e.summary || ''} ${e.facts.join(' ')}`.toLowerCase();
        for (const term of queryTerms) {
            if (searchText.includes(term)) score += 1;
            if (e.name.toLowerCase().includes(term)) score += 2;
        }
        if (score > 0) {
            // Apply type weight
            score *= (TYPE_WEIGHT[e.type?.toLowerCase()] ?? 0.8);
            // Boost entities with more facts (richer context)
            score *= 1 + Math.min(e.facts.length, 10) * 0.05;
            // Mild recency boost (within last 7 days)
            const ageMs = Date.now() - new Date(e.lastSeen).getTime();
            if (ageMs < 7 * 24 * 3600 * 1000) score *= 1.1;
            matchedEntities.push({ entity: e, score });
        }
    }

    matchedEntities.sort((a, b) => b.score - a.score);
    const topMatched = matchedEntities.slice(0, 5).map(m => m.entity);

    const matchedIds = new Set(topMatched.map(e => e.name));
    const recentEntities = graph.entities
        .slice()
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .filter(e => !matchedIds.has(e.name) && !isNoiseEntity(e.name) && e.facts.length > 0)
        .slice(0, 3);

    const allEntities = [...topMatched, ...recentEntities];

    // Build output with token budget (~600 tokens ≈ ~2400 chars)
    const TOKEN_BUDGET = 2400;
    let charCount = 0;

    if (allEntities.length > 0) {
        parts.push('Known entities and facts:');
        charCount += 30;
        for (const e of allEntities) {
            if (charCount > TOKEN_BUDGET) break;
            const isMatched = matchedIds.has(e.name);
            const maxFacts = isMatched ? 4 : 2;
            const factsStr = e.facts.length > 0 ? `\n    Facts: ${e.facts.slice(0, maxFacts).join('; ')}` : '';
            const summaryStr = e.summary ? ` — ${e.summary}` : '';
            const line = `- ${e.name} [${e.type}]${summaryStr}${factsStr}`;
            charCount += line.length;
            parts.push(line);
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

/** Clean up noisy entities and orphaned edges from the graph */
export function cleanupGraph(): { removedEntities: number; removedEdges: number; coercedTypes: number } {
    if (!initialized) initGraph();

    const beforeEntities = graph.entities.length;
    const beforeEdges = graph.edges.length;
    let coercedTypes = 0;

    // 1. Remove noise entities (file paths, URLs, numbers, short tokens)
    const removedIds = new Set<string>();
    graph.entities = graph.entities.filter(e => {
        if (isNoiseEntity(e.name)) {
            removedIds.add(e.id);
            return false;
        }
        return true;
    });

    // 2. Coerce entity types to allowed set
    for (const e of graph.entities) {
        const coerced = coerceType(e.type);
        if (coerced === null) {
            removedIds.add(e.id);
            continue;
        }
        if (coerced !== e.type) {
            e.type = coerced;
            coercedTypes++;
        }
    }
    graph.entities = graph.entities.filter(e => !removedIds.has(e.id));

    // 3. Remove orphaned edges
    const validIds = new Set(graph.entities.map(e => e.id));
    graph.edges = graph.edges.filter(e => validIds.has(e.from) && validIds.has(e.to));

    // 4. Remove entity references from episodes
    for (const ep of graph.episodes) {
        ep.entities = ep.entities.filter(id => validIds.has(id));
    }

    const removedEntities = beforeEntities - graph.entities.length;
    const removedEdges = beforeEdges - graph.edges.length;

    saveGraph();
    logger.info(COMPONENT, `Cleanup: removed ${removedEntities} entities, ${removedEdges} edges, coerced ${coercedTypes} types. Now ${graph.entities.length} entities, ${graph.edges.length} edges.`);
    return { removedEntities, removedEdges, coercedTypes };
}
