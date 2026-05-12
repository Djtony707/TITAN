/**
 * TITAN — Canvas Spaces skill (v6.0 step 3)
 *
 * Why this skill exists
 * ---------------------
 * v6.0's product thesis: "infinite workspaces that materialize around the
 * user's work." The agent must be able to create, switch, list, rename,
 * and archive Spaces in response to user requests. That's what this skill
 * exposes — 5 tools, one per lifecycle operation.
 *
 * Tools:
 *   - create_space    — make a new Space, optionally make it active
 *   - switch_space    — change which Space is active
 *   - list_spaces     — what workspaces does the user have?
 *   - rename_space    — change a Space's name (icon/color/intent via update)
 *   - archive_space   — soft-delete a Space (recoverable)
 *
 * Storage: `src/storage/spaces.ts` owns the on-disk format
 * (`~/.titan/spaces.json`). The SPA's `SpaceEngine` syncs to the same
 * file via the gateway's `/api/spaces` endpoints.
 *
 * Reference:
 *   - ~/.claude/projects/-Users-michaelelliott/memory/titan-v6-living-canvas.md
 *     (v6.0 step 3: 5 Space-lifecycle tools)
 *   - docs/PIPELINES.md (Pipeline 1 — chat message — explains how the
 *     active Space's intent flows into the system prompt)
 */
import { registerSkill } from '../registry.js';
import {
    createSpace as storageCreateSpace,
    switchSpace as storageSwitchSpace,
    listSpaces as storageListSpaces,
    renameSpace as storageRenameSpace,
    archiveSpace as storageArchiveSpace,
    getActiveSpace as storageGetActiveSpace,
} from '../../storage/spaces.js';
import { getStarterPreset, listStarterPresets } from '../../storage/starterSpaces.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'CanvasSpaces';

// ─── Tool: create_space ────────────────────────────────────────────

const createHandler = {
    name: 'create_space',
    description: [
        'Create a new workspace ("Space") for the user. A Space is a dedicated canvas with its own widgets, intent, and agent posture. Use this when the user expresses a new domain of work — "make me a place for tracking my freelance gigs", "set up a DJ workspace", "I want a Space for my homelab."',
        '',
        'USE CASE: user wants a dedicated environment for a new kind of work.',
        'ANTI-PATTERN: do NOT call this when the user wants a single widget added to their existing Space — use `create_widget` for that. Spaces are for distinct domains, not individual tools.',
        '',
        'PARAMETERS:',
        '  • name              — REQUIRED. Display name shown in the sidebar.',
        '  • icon              — Optional emoji or short string shown beside the name.',
        '  • color             — Optional hex color (e.g. "#3b82f6") for the sidebar accent.',
        '  • intent            — Optional one-sentence brief that tells TITAN what posture to take when this Space is active (e.g. "you are helping the user manage their freelance business — focus on income, time, invoices"). Saved as the Space\'s `agentInstructions` and injected into the system prompt every turn this Space is active.',
        '  • starterWidgets    — Optional array of widget specs to pre-pin: `[{name, source|template, format?, w?, h?}, ...]`. Use this to materialize a useful Space on creation rather than handing the user an empty canvas.',
        '  • preset            — Optional starter-preset id: `coder`, `dj`, `founder`, `homelab`, or `default`. When supplied, the preset\'s name/icon/color/intent are used as defaults (overridable by the other args). Use this when the user describes a domain that matches one of the presets — "set up my coding workspace" → `preset: "coder"`.',
        '  • makeActive        — Default true when this is the user\'s first space; otherwise default false. Pass true to switch to the new Space immediately.',
        '',
        'RETURNS: "Created Space \'<name>\' (id: <id>) — <N> widgets pre-pinned. <active|not active>." on success.',
        'ERRORS: "Error: ..." when name is missing or storage fails.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Display name for the new Space.' },
            icon: { type: 'string', description: 'Optional emoji / short string.' },
            color: { type: 'string', description: 'Optional hex accent color.' },
            intent: { type: 'string', description: 'Optional agent-posture brief injected into the system prompt when this Space is active.' },
            starterWidgets: {
                type: 'array',
                description: 'Optional widget specs to pre-pin. Same shape as create_widget arguments.',
                items: { type: 'object' },
            },
            preset: {
                type: 'string',
                enum: ['default', 'coder', 'dj', 'founder', 'homelab'],
                description: 'Optional starter-preset id. Supplies defaults for name/icon/color/intent.',
            },
            makeActive: { type: 'boolean', description: 'Switch to this Space immediately (default false; true when no other spaces).' },
        },
        required: ['name'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        // Resolve preset first so its values become DEFAULTS the explicit
        // args can override (caller intent wins over preset).
        const presetId = typeof args.preset === 'string' ? args.preset : undefined;
        const preset = presetId ? getStarterPreset(presetId as 'default' | 'coder' | 'dj' | 'founder' | 'homelab') : undefined;

        // name is required UNLESS a preset is supplied (preset.name is the default).
        const explicitName = typeof args.name === 'string' ? args.name.trim() : '';
        const name = explicitName || preset?.name || '';
        if (!name) return 'Error: "name" is required (or pass a "preset" id which supplies one).';

        const starter = Array.isArray(args.starterWidgets) ? args.starterWidgets : undefined;
        const makeActive = args.makeActive as boolean | undefined;
        try {
            const space = storageCreateSpace({
                name,
                icon: typeof args.icon === 'string' ? args.icon : preset?.icon,
                color: typeof args.color === 'string' ? args.color : preset?.color,
                agentInstructions: typeof args.intent === 'string'
                    ? args.intent
                    : preset?.agentInstructions,
                starterWidgets: starter,
                makeActive,
            });
            logger.info(COMPONENT, `create_space → ${space.id} "${space.name}" (widgets=${space.widgets.length})`);
            const active = makeActive ? 'now active' : 'not active (use switch_space to jump in)';
            const widgetCount = space.widgets.length;
            return `Created Space "${space.name}" (id: ${space.id}) — ${widgetCount} widget(s) pre-pinned. ${active}.`;
        } catch (err) {
            return `Error: create_space failed — ${(err as Error).message}`;
        }
    },
};

// ─── Tool: switch_space ────────────────────────────────────────────

const switchHandler = {
    name: 'switch_space',
    description: [
        'Switch which Space is currently active. The active Space\'s `intent` flows into the system prompt every turn, so switching changes the agent\'s posture for the rest of the conversation.',
        '',
        'USE CASE: user says "switch to my DJ Space", "let\'s work on freelance for a bit", "go to home".',
        'ANTI-PATTERN: do NOT switch silently when the user is in the middle of a task in another Space.',
        '',
        'PARAMETERS:',
        '  • id  — REQUIRED. Space id from `list_spaces`.',
        '',
        'RETURNS: "Switched to Space \'<name>\' (id: <id>). Active intent: <intent or \'none\'>." on success.',
        'ERRORS: "Error: Space \'<id>\' not found. ..." when the id doesn\'t exist.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Space id (run list_spaces to find it).' },
        },
        required: ['id'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return 'Error: "id" is required. Run list_spaces to find an id.';
        const space = storageSwitchSpace(id);
        if (!space) return `Error: Space "${id}" not found. Run list_spaces to see available Spaces.`;
        logger.info(COMPONENT, `switch_space → ${space.id} "${space.name}"`);
        const intent = space.agentInstructions
            ? space.agentInstructions.slice(0, 120) + (space.agentInstructions.length > 120 ? '…' : '')
            : 'none';
        return `Switched to Space "${space.name}" (id: ${space.id}). Active intent: ${intent}`;
    },
};

// ─── Tool: list_spaces ─────────────────────────────────────────────

const listHandler = {
    name: 'list_spaces',
    description: [
        'List the user\'s workspaces (Spaces), newest-updated first. Use before `switch_space` to find the id, or when the user asks "what workspaces do I have?".',
        '',
        'PARAMETERS:',
        '  • limit  — Optional cap on returned entries (default 20).',
        '',
        'RETURNS: A markdown table with id, name, widget count, active flag, last-updated. Empty-state message when no Spaces exist.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            limit: { type: 'number', description: 'Max entries to return (default 20).' },
        },
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const limit = Math.max(1, Math.min(100, (args.limit as number) ?? 20));
        const all = storageListSpaces().slice(0, limit);
        const active = storageGetActiveSpace();
        if (all.length === 0) {
            return 'No Spaces yet. Use `create_space` to make one — "what kind of work would you like a Space for?"';
        }
        const lines = [
            `${all.length} Space(s)${active ? ` (active: ${active.name})` : ''}:`,
            '',
            '| id | name | widgets | active | updated |',
            '|----|------|---------|--------|---------|',
        ];
        for (const s of all) {
            const isActive = active?.id === s.id ? '●' : '';
            lines.push(`| \`${s.id}\` | ${s.icon ? s.icon + ' ' : ''}${s.name} | ${s.widgets.length} | ${isActive} | ${s.updatedAt.slice(0, 16).replace('T', ' ')} |`);
        }
        return lines.join('\n');
    },
};

// ─── Tool: rename_space ────────────────────────────────────────────

const renameHandler = {
    name: 'rename_space',
    description: [
        'Rename a Space. Other Space attributes (icon, color, intent) are unchanged — use `update_space` for those.',
        '',
        'PARAMETERS:',
        '  • id    — REQUIRED.',
        '  • name  — REQUIRED. New display name.',
        '',
        'RETURNS: "Renamed Space <id> to \'<newName>\'." on success.',
        'ERRORS: "Error: Space \'<id>\' not found." when no match.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Space id.' },
            name: { type: 'string', description: 'New display name.' },
        },
        required: ['id', 'name'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!id) return 'Error: "id" is required.';
        if (!name) return 'Error: "name" is required.';
        const space = storageRenameSpace(id, name);
        if (!space) return `Error: Space "${id}" not found.`;
        logger.info(COMPONENT, `rename_space → ${id} "${name}"`);
        return `Renamed Space ${id} to "${space.name}".`;
    },
};

// ─── Tool: archive_space ───────────────────────────────────────────

const archiveHandler = {
    name: 'archive_space',
    description: [
        'Archive a Space (soft delete). The Space moves out of the active list but is recoverable via the admin UI or restore tools. Use this when the user is "done with" a Space rather than wanting it deleted forever.',
        '',
        'USE CASE: user says "I\'m done with the gigs Space", "remove my old DJ workspace".',
        'ANTI-PATTERN: do NOT archive without confirming — losing access to a Space\'s widgets is annoying even if recoverable.',
        '',
        'PARAMETERS:',
        '  • id  — REQUIRED. Space id.',
        '',
        'RETURNS: "Archived Space \'<name>\'. <N> Space(s) remain. <activeNote>" on success.',
        'ERRORS: "Error: Space \'<id>\' not found." when no match.',
    ].join('\n'),
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Space id to archive.' },
        },
        required: ['id'],
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return 'Error: "id" is required.';
        const r = storageArchiveSpace(id);
        if (!r) return `Error: Space "${id}" not found.`;
        logger.info(COMPONENT, `archive_space → ${id} "${r.archived.name}" (remaining=${r.remaining})`);
        const activeNote = r.remaining === 0
            ? 'No Spaces remain — propose creating a new one.'
            : `Active is now ${storageGetActiveSpace()?.name ?? 'unknown'}.`;
        return `Archived Space "${r.archived.name}". ${r.remaining} Space(s) remain. ${activeNote}`;
    },
};

// ─── Registration ─────────────────────────────────────────────────

export function registerCanvasSpacesSkill(): void {
    const meta = {
        name: 'canvas-spaces',
        description: 'Workspace (Space) lifecycle — create, switch, list, rename, archive. Each Space is a separate canvas with its own widgets + agent posture.',
        version: '1.0.0',
        source: 'bundled' as const,
        enabled: true,
    };
    registerSkill(meta, createHandler);
    registerSkill(meta, switchHandler);
    registerSkill(meta, listHandler);
    registerSkill(meta, renameHandler);
    registerSkill(meta, archiveHandler);
}
