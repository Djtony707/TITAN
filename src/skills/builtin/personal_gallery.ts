/**
 * TITAN — Personal widget gallery skill (v6.0 step 6)
 *
 * Wraps `src/storage/personalGallery.ts` as 3 agent tools so TITAN can save
 * widgets it builds and look them up later. This is half of what makes
 * "your TITAN becomes more YOUR TITAN over time" actually true — the other
 * half is the pattern engine (v6.0 step 12).
 *
 * Tools:
 *   - gallery_save_personal   — save a widget to the user's personal library
 *   - gallery_personal_search — fuzzy search the personal library
 *   - gallery_personal_list   — list everything, newest-used first
 */
import { registerSkill } from '../registry.js';
import {
    saveToPersonalGallery,
    searchPersonalGallery,
    readPersonalGallery,
    removeFromPersonalGallery,
} from '../../storage/personalGallery.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'PersonalGallerySkill';
const DEFAULT_USER = 'default-user';

const saveHandler = {
    name: 'gallery_save_personal',
    description: [
        'Save a widget to the user\'s personal gallery so it can be instantly re-pinned later. Use this AFTER `create_widget` succeeds for something the user might want again — a custom tracker, a tuned dashboard, a unique automation.',
        '',
        'USE CASE: user says "this is useful", "save this for later", or you can tell from context that this widget will be re-used.',
        'ANTI-PATTERN: do NOT save every widget — only ones with re-use value. Trivial one-shot panels don\'t belong here.',
        '',
        'PARAMETERS:',
        '  • name         — REQUIRED. Display name (will be deduped on name + source).',
        '  • source       — REQUIRED. Widget source code (same shape as create_widget).',
        '  • format       — Default "react".',
        '  • w / h        — Default 4 / 4.',
        '  • description  — Optional short reason ("Tony\'s freelance income tracker").',
        '  • tags         — Optional array of search tags ("freelance", "income", "money").',
        '  • origin       — "generated" (default) | "template" | "imported".',
        '',
        'RETURNS: "Saved \'<name>\' to personal gallery (id: <id>). useCount: N." Idempotent — saving a duplicate bumps useCount rather than creating another row.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Display name.' },
            source: { type: 'string', description: 'Widget source code.' },
            format: { type: 'string', enum: ['react', 'vanilla', 'html', 'iframe', 'system'], description: 'Widget format (default "react").' },
            w: { type: 'number', description: 'Default width (default 4).' },
            h: { type: 'number', description: 'Default height (default 4).' },
            description: { type: 'string', description: 'Short description for fuzzy search.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Search tags.' },
            origin: { type: 'string', enum: ['generated', 'template', 'imported'], description: 'Where this widget came from (default "generated").' },
        },
        required: ['name', 'source'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const source = typeof args.source === 'string' ? args.source : '';
        if (!name) return 'Error: "name" is required.';
        if (!source) return 'Error: "source" is required.';
        try {
            const saved = saveToPersonalGallery(DEFAULT_USER, {
                name,
                source,
                description: typeof args.description === 'string' ? args.description : undefined,
                format: ((args.format as string) || 'react') as 'react' | 'vanilla' | 'html' | 'iframe' | 'system',
                w: typeof args.w === 'number' ? args.w : 4,
                h: typeof args.h === 'number' ? args.h : 4,
                tags: Array.isArray(args.tags) ? args.tags.filter(t => typeof t === 'string') as string[] : [],
                origin: ((args.origin as string) || 'generated') as 'generated' | 'template' | 'imported',
            });
            return `Saved "${saved.name}" to personal gallery (id: ${saved.id}). useCount: ${saved.useCount}.`;
        } catch (err) {
            return `Error: gallery_save_personal failed — ${(err as Error).message}`;
        }
    },
};

const searchHandler = {
    name: 'gallery_personal_search',
    description: [
        'Fuzzy-search the user\'s personal gallery. Use this BEFORE generating a fresh widget when the user asks for something they might have asked for before — "my BPM widget", "freelance tracker again", "the dashboard from yesterday".',
        '',
        'USE CASE: user references something they\'ve had before; the agent can re-pin it instantly instead of regenerating.',
        '',
        'PARAMETERS:',
        '  • query  — REQUIRED. Free-text search across name + description + tags.',
        '  • limit  — Optional cap (default 5).',
        '',
        'RETURNS: A table of matching widgets with id / name / useCount / tags. Empty-state message when nothing matches.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query.' },
            limit: { type: 'number', description: 'Max hits (default 5).' },
        },
        required: ['query'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return 'Error: "query" is required.';
        const limit = Math.max(1, Math.min(20, (args.limit as number) ?? 5));
        const hits = searchPersonalGallery(DEFAULT_USER, query, limit);
        if (hits.length === 0) {
            return `No personal-gallery matches for "${query}". Generate the widget fresh and consider \`gallery_save_personal\` if the user likes it.`;
        }
        const lines = [
            `${hits.length} match(es) for "${query}":`,
            '',
            '| id | name | useCount | tags |',
            '|----|------|----------|------|',
        ];
        for (const w of hits) {
            lines.push(`| \`${w.id}\` | ${w.name} | ${w.useCount} | ${w.tags.join(', ') || '—'} |`);
        }
        return lines.join('\n');
    },
};

const listHandler = {
    name: 'gallery_personal_list',
    description: [
        'List the user\'s personal gallery (everything they\'ve saved), newest-used first. Cheap, returns no source — pair with `gallery_personal_get` if/when implemented.',
        '',
        'PARAMETERS:',
        '  • limit  — Default 20.',
        '',
        'RETURNS: Markdown table of widgets.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max entries (default 20).' } },
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const limit = Math.max(1, Math.min(100, (args.limit as number) ?? 20));
        const file = readPersonalGallery(DEFAULT_USER);
        if (file.widgets.length === 0) {
            return 'Your personal gallery is empty. Once you build widgets you want to keep, use `gallery_save_personal`.';
        }
        const all = [...file.widgets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
        const lines = [
            `${all.length} widget(s) in your personal gallery:`,
            '',
            '| id | name | uses | format | tags |',
            '|----|------|------|--------|------|',
        ];
        for (const w of all) {
            lines.push(`| \`${w.id}\` | ${w.name} | ${w.useCount} | ${w.format} | ${w.tags.join(', ') || '—'} |`);
        }
        return lines.join('\n');
    },
};

export function registerPersonalGallerySkill(): void {
    const meta = {
        name: 'personal-gallery',
        description: 'Per-user widget library. Save widgets TITAN builds for the user; search + re-pin them later. The longer used, the smarter TITAN becomes about this specific user.',
        version: '1.0.0',
        source: 'bundled' as const,
        enabled: true,
    };
    registerSkill(meta, saveHandler);
    registerSkill(meta, searchHandler);
    registerSkill(meta, listHandler);
}

// Re-export the removal primitive for completeness — there's no agent tool
// for it yet (would normally route through the SPA's gallery UI).
export { removeFromPersonalGallery };

// Acknowledge unused import for strict-mode TS
void logger;
