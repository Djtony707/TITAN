/**
 * TITAN — Widget Gallery Skill
 *
 * Loads the bundled widget template library at startup and exposes:
 *   - gallery_search(query): fuzzy match against triggers, tags, name, description
 *   - gallery_get(id): fetch a single template by id (with source code + placeholders)
 *   - gallery_list(category?): list templates (optionally filtered)
 *   - gallery_categories(): list of all category names with counts
 *
 * The canvas chat agent should ALWAYS call gallery_search FIRST when the user
 * asks for a widget. Only generate from scratch when nothing matches well.
 *
 * Templates live in assets/widget-templates/<category>/<id>.json with schema:
 *   {
 *     id, name, category, tags[], description, triggers[],
 *     defaultSize: { w, h },
 *     source: "function MyWidget() {...} render(<MyWidget/>);",
 *     placeholders: [{ name, description, default }]
 *   }
 *
 * `source` is the React component body for <WidgetSandbox> srcdoc — it's
 * wrapped in the iframe's React 18 UMD + Babel standalone runtime by the
 * canvas, so just author it as a self-contained component ending in
 * `render(<X/>);`. Inline tokens like REPLACE_WITH_SYMBOL are swapped at
 * runtime via gallery_get's `fill` argument.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'WidgetGallery';
const __dirname = dirname(fileURLToPath(import.meta.url));

// dist/skills/builtin → ../../../assets = project root / assets
// Fallback to CWD/assets/widget-templates when bundled or invoked from a
// non-standard layout (kimi review: defensive for single-file bundles).
const PRIMARY_TEMPLATES_DIR = join(__dirname, '../../../assets/widget-templates');
const TEMPLATES_DIR = existsSync(PRIMARY_TEMPLATES_DIR)
    ? PRIMARY_TEMPLATES_DIR
    : join(process.cwd(), 'assets/widget-templates');

export interface WidgetPlaceholder {
    name: string;
    description: string;
    default?: string;
}

export interface WidgetTemplate {
    id: string;
    name: string;
    category: string;
    tags: string[];
    description: string;
    triggers: string[];
    defaultSize?: { w: number; h: number };
    source: string;
    placeholders?: WidgetPlaceholder[];
}

let templateCache: Map<string, WidgetTemplate> | null = null;

function loadTemplates(): Map<string, WidgetTemplate> {
    if (templateCache) return templateCache;
    const map = new Map<string, WidgetTemplate>();
    if (!existsSync(TEMPLATES_DIR)) {
        logger.warn(COMPONENT, `Templates dir missing: ${TEMPLATES_DIR}`);
        templateCache = map;
        return map;
    }
    const walk = (dir: string): void => {
        let entries: string[] = [];
        try { entries = readdirSync(dir); } catch { return; }
        for (const name of entries) {
            const full = join(dir, name);
            let stat;
            try { stat = statSync(full); } catch { continue; }
            if (stat.isDirectory()) { walk(full); continue; }
            if (!name.endsWith('.json')) continue;
            try {
                const raw = readFileSync(full, 'utf-8');
                const t = JSON.parse(raw) as WidgetTemplate;
                if (!t.id || !t.source) {
                    logger.warn(COMPONENT, `Skipped malformed template: ${full}`);
                    continue;
                }
                if (map.has(t.id)) {
                    logger.warn(COMPONENT, `Duplicate template id "${t.id}" — keeping first.`);
                    continue;
                }
                // Fill defaults so search/list don't have to null-check
                t.tags = Array.isArray(t.tags) ? t.tags : [];
                t.triggers = Array.isArray(t.triggers) ? t.triggers : [];
                t.description = t.description || '';
                t.category = t.category || 'misc';
                map.set(t.id, t);
            } catch (e) {
                logger.warn(COMPONENT, `Failed to parse ${full}: ${(e as Error).message}`);
            }
        }
    };
    walk(TEMPLATES_DIR);
    templateCache = map;
    logger.info(COMPONENT, `Loaded ${map.size} widget templates from ${TEMPLATES_DIR}`);
    return map;
}

/** Drop the cache so the next call reloads from disk (useful for dev). */
export function reloadTemplates(): number {
    templateCache = null;
    return loadTemplates().size;
}

function tokenize(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);
}

interface ScoredTemplate {
    template: WidgetTemplate;
    score: number;
    matched: string[];
}

function scoreTemplate(t: WidgetTemplate, queryTokens: Set<string>): ScoredTemplate {
    let score = 0;
    const matched = new Set<string>();

    // Trigger phrases get the heaviest weight (they're hand-curated intents)
    for (const trigger of t.triggers) {
        const triggerLower = trigger.toLowerCase();
        // Whole-phrase match in original query
        const queryString = Array.from(queryTokens).join(' ');
        if (queryString.includes(triggerLower)) {
            score += 10;
            matched.add(trigger);
        } else {
            const triggerTokens = tokenize(trigger);
            for (const tk of triggerTokens) {
                if (queryTokens.has(tk)) { score += 3; matched.add(trigger); }
            }
        }
    }

    // Tags: medium weight
    for (const tag of t.tags) {
        if (queryTokens.has(tag.toLowerCase())) { score += 2; matched.add(tag); }
    }

    // Name tokens: weight 4 each (a name match is strong signal)
    for (const tk of tokenize(t.name)) {
        if (queryTokens.has(tk)) { score += 4; matched.add(t.name); }
    }

    // Description: weight 1 (last-resort match)
    for (const tk of tokenize(t.description)) {
        if (queryTokens.has(tk)) { score += 1; }
    }

    // Category: weight 1
    if (queryTokens.has(t.category.toLowerCase())) { score += 1; matched.add(`category:${t.category}`); }

    return { template: t, score, matched: Array.from(matched) };
}

export function searchGallery(query: string, limit = 5): ScoredTemplate[] {
    const map = loadTemplates();
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];
    const scored: ScoredTemplate[] = [];
    for (const t of map.values()) {
        const s = scoreTemplate(t, queryTokens);
        if (s.score > 0) scored.push(s);
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

export function getTemplate(id: string, fill?: Record<string, string>): WidgetTemplate | null {
    const t = loadTemplates().get(id);
    if (!t) return null;
    if (!fill || Object.keys(fill).length === 0) return t;
    let source = t.source;
    for (const [key, value] of Object.entries(fill)) {
        // Replace both REPLACE_WITH_X and {{X}} forms; agent may use either.
        // Escape backslash, single-quote, AND backtick (kimi review: backticks
        // could break out of template literals if a value contained one).
        const safe = String(value)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/`/g, '\\`');
        source = source.split(`REPLACE_WITH_${key}`).join(safe);
        source = source.split(`{{${key}}}`).join(safe);
    }
    return { ...t, source };
}

export function listTemplates(category?: string): Array<Omit<WidgetTemplate, 'source'>> {
    const map = loadTemplates();
    const out: Array<Omit<WidgetTemplate, 'source'>> = [];
    for (const t of map.values()) {
        if (category && t.category !== category) continue;
        // Strip `source` so list calls stay token-light. Agent calls gallery_get to fetch source.
        const { source: _omit, ...rest } = t;
        out.push(rest);
    }
    out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return out;
}

export function listCategories(): Array<{ category: string; count: number }> {
    const map = loadTemplates();
    const counts = new Map<string, number>();
    for (const t of map.values()) {
        counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => a.category.localeCompare(b.category));
}

export function registerWidgetGallerySkill(): void {
    // Eager-load so the count appears in startup logs.
    loadTemplates();

    registerSkill(
        {
            name: 'widget_gallery',
            description: 'Curated library of pre-built canvas widget templates (timers, trackers, dashboards, automations, smart-home controls, agent-employee panels, software-builder skeletons). The canvas chat agent should ALWAYS call gallery_search FIRST when the user asks for a widget. Only generate from scratch when no template matches.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'gallery_search',
            description: 'Search the widget template gallery for matches. Returns top scored templates with id, name, category, description, and matched signals. ALWAYS call this FIRST when the user wants a new widget — only generate from scratch when no result scores well.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'User intent — phrase, keyword, or full request. Example: "stock tracker for AAPL", "pomodoro", "control my smart lights".' },
                    limit: { type: 'number', description: 'Max results (default 5).' },
                },
                required: ['query'],
            },
            execute: async (args: Record<string, unknown>) => {
                const query = String(args.query ?? '');
                const limit = typeof args.limit === 'number' ? args.limit : undefined;
                const results = searchGallery(query, limit ?? 5);
                if (results.length === 0) {
                    return JSON.stringify({
                        query,
                        results: [],
                        hint: 'No matches. Generate a custom widget from scratch.',
                    });
                }
                return JSON.stringify({
                    query,
                    results: results.map(r => ({
                        id: r.template.id,
                        name: r.template.name,
                        category: r.template.category,
                        description: r.template.description,
                        defaultSize: r.template.defaultSize,
                        placeholders: r.template.placeholders ?? [],
                        score: r.score,
                        matched: r.matched,
                    })),
                    hint: 'Pick the best match, call gallery_get with its id and a `fill` map of placeholder values from the user request.',
                });
            },
        },
    );

    registerSkill(
        {
            name: 'widget_gallery_get',
            description: 'Fetch the full source of a gallery template, with placeholders replaced.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'gallery_get',
            description: 'Fetch a widget template by id with placeholder values filled in. Returns the full React component source ready to drop into the canvas.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Template id from gallery_search results.' },
                    fill: {
                        type: 'object',
                        description: 'Placeholder values (key = placeholder name without REPLACE_WITH_ prefix, value = string to insert). Example: {"SYMBOL": "AAPL"} → REPLACE_WITH_SYMBOL becomes "AAPL".',
                        additionalProperties: { type: 'string' },
                    },
                },
                required: ['id'],
            },
            execute: async (args: Record<string, unknown>) => {
                const id = String(args.id ?? '');
                const fill = (args.fill && typeof args.fill === 'object') ? args.fill as Record<string, string> : undefined;
                const t = getTemplate(id, fill);
                if (!t) return JSON.stringify({ error: `Template not found: ${id}` });
                return JSON.stringify({
                    id: t.id,
                    name: t.name,
                    category: t.category,
                    defaultSize: t.defaultSize,
                    source: t.source,
                    placeholders: t.placeholders ?? [],
                });
            },
        },
    );

    registerSkill(
        {
            name: 'widget_gallery_list',
            description: 'List all gallery templates (optionally filtered by category).',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'gallery_list',
            description: 'List all widget gallery templates. Filter by category. Returns metadata (id, name, category, description, tags, triggers) without source — call gallery_get to fetch source.',
            parameters: {
                type: 'object',
                properties: {
                    category: { type: 'string', description: 'Optional category filter (e.g. "finance", "productivity", "automation", "smart-home", "agents").' },
                },
            },
            execute: async (args: Record<string, unknown>) => {
                const category = typeof args.category === 'string' ? args.category : undefined;
                const items = listTemplates(category);
                return JSON.stringify({
                    count: items.length,
                    categories: listCategories(),
                    templates: items,
                });
            },
        },
    );
}
