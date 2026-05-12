/**
 * TITAN — Memory Skill (Built-in)
 * Persistent fact/preference storage for the agent.
 */
import { registerSkill } from '../registry.js';
import { rememberFact, recallFact, searchMemories } from '../../memory/memory.js';

export function registerMemorySkill(): void {
    registerSkill(
        { name: 'memory', description: 'Persistent memory management', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'memory',
            description: `Store and recall persistent key/value facts that survive across conversations. Auto-saving is encouraged — when the user shares a preference, project detail, or decision worth remembering, call memory remember without being explicitly asked.

USE WHEN: "remember X" / "don't forget X" / "save that" / "what do you know about X" / "do you remember X" / "forget X" — anything where the answer depends on something the user said in an earlier session. Also use proactively when the user shares a stable fact (their preferred editor, a recurring project path, an IP they always reach).

DO NOT USE FOR:
- Multi-fact semantic recall ("what did we discuss about X?") → use graph_search (vector + relationship store).
- Cross-session episodic recall ("last week we agreed Y") → use hindsight hints (long-term retention layer).
- Temporary state during one chat → keep it in context, don't pollute the memory store.

Parameters:
- action (string, required) — one of: "remember", "recall", "search", "list".
- key (string, required for remember/recall) — descriptive snake_case identifier (e.g., "preferred_editor", "homelab_titan_ip").
- value (string, required for remember) — the fact to store.
- query (string, required for search) — free-text, matched semantically.
- category (string, optional) — bucket like "preference" / "fact" / "project" for filtering.

Returns:
- remember → "Saved: <key> = <value>"
- recall → the stored value, or "Not found: <key>"
- search → list of matching { key, value, score }
- list → all stored memories grouped by category

Errors:
- "Key not found" (recall) — try search to discover the right key, or list to see everything.
- "Vector store unavailable" (search) — Ollama embed not ready; fall back to list and manual scan.

Use descriptive keys. "user_likes_coffee" recalls cleanly. "fact1" doesn't.`,
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['remember', 'recall', 'search', 'list'], description: 'Action' },
                    category: { type: 'string', description: 'Memory category (e.g., "preference", "fact", "project")' },
                    key: { type: 'string', description: 'Memory key/name' },
                    value: { type: 'string', description: 'Value to remember' },
                    query: { type: 'string', description: 'Search query (for search action)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;
                const category = (args.category as string) || 'general';

                switch (action) {
                    case 'remember': {
                        const key = args.key as string;
                        const value = args.value as string;
                        if (!key || !value) return 'Error: key and value are required';
                        rememberFact(category, key, value);
                        return `Remembered: [${category}] ${key} = ${value}`;
                    }
                    case 'recall': {
                        const rKey = args.key as string;
                        if (!rKey) return 'Error: key is required';
                        const value = recallFact(category, rKey);
                        return value ? `[${category}] ${rKey} = ${value}` : `No memory found for [${category}] ${rKey}`;
                    }
                    case 'search': {
                        const query = args.query as string;
                        const results = await searchMemories(category !== 'general' ? category : undefined, query);
                        if (results.length === 0) return 'No matching memories found.';
                        return results.map((m) => `• [${m.category}] ${m.key}: ${m.value}`).join('\n');
                    }
                    case 'list': {
                        const all = await searchMemories(category !== 'general' ? category : undefined);
                        if (all.length === 0) return 'No memories stored yet.';
                        return all.map((m) => `• [${m.category}] ${m.key}: ${m.value}`).join('\n');
                    }
                    default:
                        return `Unknown action: ${action}`;
                }
            },
        },
    );
}
