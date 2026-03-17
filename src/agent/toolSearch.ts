/**
 * TITAN — Tool Search
 *
 * Meta-tool that lets the LLM discover tools on demand instead of seeing
 * all 80+ tool schemas on every request. Reduces input tokens by 60-80%.
 *
 * How it works:
 *   1. Only core tools + tool_search are sent to the LLM (5-8 tools, ~600 tokens)
 *   2. tool_search description includes a compact catalog of ALL available tools
 *   3. When the LLM calls tool_search, matching tools are returned
 *   4. Agent loop adds discovered tools to activeTools for subsequent rounds
 *
 * Inspired by Anthropic's tool search pattern (2025) but works with ALL providers.
 */
import { getRegisteredTools, type ToolHandler } from './toolRunner.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ToolSearch';

/** Default core tools — always sent to the LLM without needing search */
export const DEFAULT_CORE_TOOLS = [
    'shell',
    'read_file',
    'write_file',
    'edit_file',
    'list_dir',
    'web_search',
    'web_fetch',
    'web_act',
    'smart_form_fill',
    'weather',
    'memory',
    'system_info',
    'goal_list',
    'spawn_agent',
    'tool_search',
    'self_doctor',
    'ha_control',
    'ha_devices',
    'ha_status',
];

/** Build a compact one-line catalog of all tools for the tool_search description */
export function buildToolCatalog(): string {
    const tools = getRegisteredTools();
    return tools
        .filter(t => t.name !== 'tool_search')
        .map(t => `${t.name}: ${t.description.slice(0, 50)}`)
        .join(' | ');
}

/** Search registered tools by keyword query */
export function searchTools(query: string): ToolHandler[] {
    const tools = getRegisteredTools();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored = tools
        .filter(t => t.name !== 'tool_search')
        .map(t => {
            const text = `${t.name} ${t.description}`.toLowerCase();
            const score = terms.reduce((s, term) => s + (text.includes(term) ? 1 : 0), 0);
            return { tool: t, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

    return scored.map(({ tool }) => tool);
}

/** Get the tool_search tool handler */
export function getToolSearchHandler(): ToolHandler {
    const catalog = buildToolCatalog();

    return {
        name: 'tool_search',
        description: `Search for tools by keyword to discover capabilities. Call this FIRST when you need a tool not in your current list. Available tools: ${catalog}`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query — keywords describing what you need (e.g. "email send", "browser screenshot", "github pr", "cron schedule")',
                },
            },
            required: ['query'],
        },
        execute: async (args: Record<string, unknown>) => {
            const query = (args.query as string) || '';
            if (!query.trim()) {
                return 'Please provide a search query. Example: tool_search({query: "email"})';
            }

            const results = searchTools(query);

            if (results.length === 0) {
                return `No tools found matching "${query}". Try broader keywords.`;
            }

            logger.info(COMPONENT, `Search "${query}" → ${results.length} tools: [${results.map(t => t.name).join(', ')}]`);

            const formatted = results.map(t => {
                const params = t.parameters as Record<string, unknown>;
                const props = (params.properties || {}) as Record<string, unknown>;
                const paramNames = Object.keys(props).join(', ');
                return `**${t.name}**(${paramNames}): ${t.description}`;
            }).join('\n');

            return `Found ${results.length} tools:\n${formatted}\n\nYou can now call these tools directly.`;
        },
    };
}
