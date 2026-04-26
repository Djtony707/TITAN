/**
 * TITAN — Memory Graph Skills (Built-in)
 * 4 tools to interact with the native temporal knowledge graph.
 */
import { registerSkill } from '../registry.js';
import {
    addEpisode,
    searchMemory,
    listEntities,
    getEntity,
    getEntityEpisodes,
} from '../../memory/graph.js';

export function registerMemoryGraphSkill(): void {
    // Tool 1: graph_remember — add context to graph memory
    registerSkill(
        {
            name: 'memory_graph',
            description: 'Native temporal knowledge graph — remember, search, and recall memories',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'graph_remember',
            description: 'Add a piece of information or context to the temporal knowledge graph memory.\n\nUSE THIS WHEN: Tony shares something important that should be remembered long-term, or at the end of a meaningful conversation to capture key context.\n\nAUTO-SAVE: Proactively call this when Tony shares project details, preferences, decisions, or facts — do not wait to be asked.\nVS memory tool: graph_remember stores richer episodic context with entity extraction; use it for narratives and facts. Use memory:remember for simple key-value preferences.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'The text or information to remember' },
                    source: { type: 'string', description: 'Source context (e.g., "webchat", "cli", "discord"). Defaults to "agent"' },
                },
                required: ['content'],
            },
            execute: async (args) => {
                const content = args.content as string;
                const source = (args.source as string) || 'agent';
                if (!content) return 'Error: content is required';
                const episode = await addEpisode(content, source);
                return `✅ Remembered in graph memory (episode ${episode.id.slice(0, 8)}). Entity extraction running in background.`;
            },
        },
    );

    // Tool 2: graph_search — search memories by keyword
    registerSkill(
        {
            name: 'memory_graph',
            description: 'Native temporal knowledge graph — remember, search, and recall memories',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'graph_search',
            description: 'Search the temporal knowledge graph memory by keyword — returns relevant episodes sorted by relevance and recency.\n\nUSE THIS WHEN Tony says: "what do you know about X" / "do you remember X" / "find memories about X" / "search your memory for X"\n\nWORKFLOW: Call graph_search first when asked to recall something, then use graph_recall for deeper info on a specific entity found in results.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query (space-separated keywords)' },
                    limit: { type: 'number', description: 'Maximum results to return (default 10)' },
                },
                required: ['query'],
            },
            execute: async (args) => {
                const query = args.query as string;
                const limit = (args.limit as number) || 10;
                const results = await searchMemory(query, limit);
                if (results.length === 0) return 'No matching memories found for: ' + query;
                return results.map((ep, i) =>
                    `[${i + 1}] (${ep.source}, ${ep.createdAt.slice(0, 10)}) ${ep.content.slice(0, 200)}${ep.content.length > 200 ? '…' : ''}`
                ).join('\n\n');
            },
        },
    );

    // Tool 3: graph_entities — list known entities by type
    registerSkill(
        {
            name: 'memory_graph',
            description: 'Native temporal knowledge graph — remember, search, and recall memories',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'graph_entities',
            description: 'List known entities in the knowledge graph — people, projects, topics, places, and facts TITAN has learned about.\n\nUSE THIS WHEN Tony says: "what people do you know about" / "what projects are in your memory" / "list all X in your memory" / "show me known entities"\n\nFilter by type: person, topic, project, place, or fact.',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['person', 'topic', 'project', 'place', 'fact'], description: 'Filter by entity type (optional)' },
                    limit: { type: 'number', description: 'Maximum results (default 20)' },
                },
                required: [],
            },
            execute: async (args) => {
                const type = args.type as string | undefined;
                const limit = (args.limit as number) || 20;
                const entities = listEntities(type).slice(0, limit);
                if (entities.length === 0) {
                    return type ? `No ${type} entities found in graph memory.` : 'No entities in graph memory yet.';
                }
                return entities.map((e) =>
                    `• **${e.name}** (${e.type}) — ${e.facts.slice(0, 2).join('; ') || 'no facts'}${e.facts.length > 2 ? ' +more' : ''}`
                ).join('\n');
            },
        },
    );

    // Tool 4: graph_recall — get all memories related to an entity
    registerSkill(
        {
            name: 'memory_graph',
            description: 'Native temporal knowledge graph — remember, search, and recall memories',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'graph_recall',
            description: 'Recall all graph memories related to a specific named entity — returns known facts and all related episodes.\n\nUSE THIS WHEN Tony says: "tell me everything you know about X" / "what do you remember about X" / "recall X" / "X history"\n\nWORKFLOW: Use graph_search first to find relevant entities, then call graph_recall on the specific entity name for full context.',
            parameters: {
                type: 'object',
                properties: {
                    entity: { type: 'string', description: 'Entity name to recall memories for' },
                    limit: { type: 'number', description: 'Maximum episodes to return (default 10)' },
                },
                required: ['entity'],
            },
            execute: async (args) => {
                const name = args.entity as string;
                const limit = (args.limit as number) || 10;
                if (!name) return 'Error: entity name is required';

                const entity = getEntity(name);
                if (!entity) {
                    // Fall back to text search
                    const results = await searchMemory(name, limit);
                    if (results.length === 0) return `No memories found related to: ${name}`;
                    return `No entity named "${name}" found, but found ${results.length} related episodes:\n\n` +
                        results.map((ep, i) =>
                            `[${i + 1}] (${ep.source}, ${ep.createdAt.slice(0, 10)}) ${ep.content.slice(0, 200)}`
                        ).join('\n\n');
                }

                const episodes = getEntityEpisodes(entity.id, limit);
                const factsStr = entity.facts.length > 0 ? entity.facts.map((f) => `  • ${f}`).join('\n') : '  (none recorded)';
                const episodesStr = episodes.length > 0
                    ? episodes.map((ep, i) =>
                        `[${i + 1}] (${ep.source}, ${ep.createdAt.slice(0, 10)}) ${ep.content.slice(0, 200)}`
                    ).join('\n\n')
                    : 'No episodes yet.';

                return `**${entity.name}** (${entity.type})\nFirst seen: ${entity.firstSeen.slice(0, 10)} | Last seen: ${entity.lastSeen.slice(0, 10)}\n\nKnown facts:\n${factsStr}\n\nRelated episodes:\n${episodesStr}`;
            },
        },
    );
}
