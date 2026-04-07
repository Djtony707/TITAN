/**
 * TITAN — Tool Categories
 * Category-based tool resolution for sub-agents.
 * Instead of hardcoding tool names, sub-agents specify categories.
 */

export type ToolCategory = 'readonly' | 'write' | 'network' | 'system' | 'memory' | 'browser' | 'code';

export const TOOL_CATEGORIES: Record<ToolCategory, string[]> = {
    readonly: [
        'read_file', 'list_dir', 'web_search', 'web_fetch', 'web_read',
        'memory', 'graph_search', 'tool_search', 'system_info', 'self_doctor',
        'goal_list', 'weather', 'ha_status', 'ha_devices',
    ],
    write: [
        'write_file', 'edit_file', 'memory',
    ],
    network: [
        'web_search', 'web_fetch', 'web_read', 'web_act',
        'browse_url', 'browser_auto_nav', 'smart_form_fill',
    ],
    system: [
        'shell', 'code_exec',
    ],
    memory: [
        'memory', 'graph_search',
    ],
    browser: [
        'browse_url', 'browser_auto_nav', 'browser_search',
        'web_read', 'web_act', 'browser_screenshot', 'smart_form_fill',
    ],
    code: [
        'shell', 'read_file', 'write_file', 'edit_file', 'list_dir', 'code_exec',
    ],
};

/** Resolve tool names from categories, with optional additions/exclusions */
export function resolveToolsFromCategories(
    categories: ToolCategory[],
    extraTools?: string[],
    excludeTools?: string[],
): string[] {
    const toolSet = new Set<string>();
    for (const cat of categories) {
        const tools = TOOL_CATEGORIES[cat];
        if (tools) tools.forEach(t => toolSet.add(t));
    }
    if (extraTools) extraTools.forEach(t => toolSet.add(t));
    if (excludeTools) excludeTools.forEach(t => toolSet.delete(t));
    return [...toolSet];
}
