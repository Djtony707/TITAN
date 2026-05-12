/**
 * TITAN — Spaces persistence (v6.0 step 4)
 *
 * Why this exists
 * ---------------
 * v5.x stored Spaces only in the browser (localStorage + Yjs). v6.0 makes
 * Spaces a first-class concept the agent can read + write via tools, so
 * the source of truth has to live server-side at `~/.titan/spaces.json`.
 * The React SPA continues to use Yjs for live multi-tab CRDT behaviour,
 * but it syncs to this file on every space mutation so:
 *
 *   - Switching browsers / devices doesn't lose Spaces
 *   - The agent can create / list / switch / rename / archive Spaces
 *     without the SPA having to be open
 *   - Migration 002 seeds a Default Space here, not in localStorage
 *
 * Shape mirrors the frontend `Space` type in `ui/src/titan2/types.ts`
 * with optional fields surfaced explicitly. Widgets are stored as opaque
 * JSON (the frontend WidgetDef shape) because the server doesn't render
 * them — only the SPA does.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

const COMPONENT = 'SpacesStorage';

/** Lazy path resolution — mirrors src/storage/backup.ts so tests can swap HOME. */
function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function spacesPath(): string { return join(titanHome(), 'spaces.json'); }
function archivePath(): string { return join(titanHome(), 'spaces-archive.json'); }

/** Single Space record. Mirrors `ui/src/titan2/types.ts` Space. */
export interface PersistedSpace {
    id: string;
    name: string;
    icon?: string;
    color?: string;
    /** Opaque widget defs — the frontend owns the inner shape. */
    widgets: unknown[];
    /** Intent string injected into the agent's system prompt when this
     *  Space is active. The agent posture changes per-Space because of
     *  this field. */
    agentInstructions?: string;
    createdAt: string;
    updatedAt: string;
}

/** Top-level file shape. */
export interface SpacesFile {
    schema: 1;
    spaces: PersistedSpace[];
    /** id of the Space that's currently active for the default user. */
    activeSpaceId?: string;
}

/** Read spaces.json. Returns the empty-default shape when missing/malformed. */
export function readSpaces(): SpacesFile {
    try {
        const p = spacesPath();
        if (!existsSync(p)) return emptyFile();
        const raw = JSON.parse(readFileSync(p, 'utf-8'));
        if (raw && raw.schema === 1 && Array.isArray(raw.spaces)) {
            return raw as SpacesFile;
        }
        logger.warn(COMPONENT, `spaces.json shape unexpected — returning empty default.`);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to read spaces.json (${(err as Error).message}) — returning empty default.`);
    }
    return emptyFile();
}

/** Atomically write spaces.json. Creates parent dir if needed. */
export function writeSpaces(file: SpacesFile): void {
    try { mkdirSync(titanHome(), { recursive: true }); } catch { /* exists */ }
    writeFileSync(spacesPath(), JSON.stringify(file, null, 2));
}

function emptyFile(): SpacesFile {
    return { schema: 1, spaces: [] };
}

// ─── CRUD helpers ────────────────────────────────────────────────────

/**
 * Create a new Space. Returns the new Space (with id, timestamps populated).
 * `name` is the only required field; everything else has a sensible default.
 */
export function createSpace(input: {
    name: string;
    icon?: string;
    color?: string;
    agentInstructions?: string;
    starterWidgets?: unknown[];
    makeActive?: boolean;
}): PersistedSpace {
    const file = readSpaces();
    const now = new Date().toISOString();
    const space: PersistedSpace = {
        id: `s-${randomUUID().slice(0, 8)}`,
        name: input.name.trim() || 'Untitled Space',
        icon: input.icon,
        color: input.color,
        agentInstructions: input.agentInstructions,
        widgets: input.starterWidgets ?? [],
        createdAt: now,
        updatedAt: now,
    };
    file.spaces.push(space);
    if (input.makeActive || !file.activeSpaceId) {
        file.activeSpaceId = space.id;
    }
    writeSpaces(file);
    logger.info(COMPONENT, `Created Space "${space.name}" (id=${space.id}, active=${file.activeSpaceId === space.id})`);
    return space;
}

/** Switch the active Space. Returns the new active Space or null if id not found. */
export function switchSpace(id: string): PersistedSpace | null {
    const file = readSpaces();
    const target = file.spaces.find(s => s.id === id);
    if (!target) return null;
    file.activeSpaceId = id;
    writeSpaces(file);
    return target;
}

/** List Spaces (newest first). Excludes archived. */
export function listSpaces(): PersistedSpace[] {
    return [...readSpaces().spaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Get the active Space. Falls back to the first Space if `activeSpaceId` is
 *  unset or stale. Returns null only when zero Spaces exist. */
export function getActiveSpace(): PersistedSpace | null {
    const file = readSpaces();
    if (file.spaces.length === 0) return null;
    if (file.activeSpaceId) {
        const hit = file.spaces.find(s => s.id === file.activeSpaceId);
        if (hit) return hit;
    }
    return file.spaces[0];
}

/** Rename a Space. Returns the updated Space or null if not found. */
export function renameSpace(id: string, name: string): PersistedSpace | null {
    const file = readSpaces();
    const target = file.spaces.find(s => s.id === id);
    if (!target) return null;
    target.name = name.trim() || target.name;
    target.updatedAt = new Date().toISOString();
    writeSpaces(file);
    return target;
}

/** Update arbitrary Space fields (icon, color, agentInstructions). Used by
 *  the gateway's PATCH /api/spaces/:id endpoint and the SPA's settings UI. */
export function updateSpace(
    id: string,
    patch: Partial<Pick<PersistedSpace, 'name' | 'icon' | 'color' | 'agentInstructions' | 'widgets'>>,
): PersistedSpace | null {
    const file = readSpaces();
    const target = file.spaces.find(s => s.id === id);
    if (!target) return null;
    if (typeof patch.name === 'string') target.name = patch.name.trim() || target.name;
    if (typeof patch.icon === 'string') target.icon = patch.icon;
    if (typeof patch.color === 'string') target.color = patch.color;
    if (typeof patch.agentInstructions === 'string') target.agentInstructions = patch.agentInstructions;
    if (Array.isArray(patch.widgets)) target.widgets = patch.widgets;
    target.updatedAt = new Date().toISOString();
    writeSpaces(file);
    return target;
}

/**
 * Archive a Space — moves it from spaces.json to spaces-archive.json.
 * Soft delete: recoverable via `unarchiveSpace`. We never hard-delete user
 * data from a Space mutation API.
 */
export function archiveSpace(id: string): { archived: PersistedSpace; remaining: number } | null {
    const file = readSpaces();
    const idx = file.spaces.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const [archived] = file.spaces.splice(idx, 1);
    archived.updatedAt = new Date().toISOString();

    // If we just archived the active Space, fall back to the first remaining
    // Space (the SPA does the same).
    if (file.activeSpaceId === id) {
        file.activeSpaceId = file.spaces[0]?.id;
    }
    writeSpaces(file);

    // Append to the archive file (read-modify-write to preserve previous archives).
    let archiveFile: SpacesFile = { schema: 1, spaces: [] };
    try {
        if (existsSync(archivePath())) {
            const raw = JSON.parse(readFileSync(archivePath(), 'utf-8'));
            if (raw && raw.schema === 1 && Array.isArray(raw.spaces)) archiveFile = raw;
        }
    } catch { /* fresh archive file */ }
    archiveFile.spaces.push(archived);
    writeFileSync(archivePath(), JSON.stringify(archiveFile, null, 2));

    logger.info(COMPONENT, `Archived Space "${archived.name}" (id=${archived.id}, ${file.spaces.length} remaining)`);
    return { archived, remaining: file.spaces.length };
}

/** Restore an archived Space back into spaces.json. */
export function unarchiveSpace(id: string): PersistedSpace | null {
    if (!existsSync(archivePath())) return null;
    let archiveFile: SpacesFile;
    try {
        const raw = JSON.parse(readFileSync(archivePath(), 'utf-8'));
        if (raw && raw.schema === 1 && Array.isArray(raw.spaces)) archiveFile = raw;
        else return null;
    } catch { return null; }
    const idx = archiveFile.spaces.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const [restored] = archiveFile.spaces.splice(idx, 1);
    restored.updatedAt = new Date().toISOString();
    writeFileSync(archivePath(), JSON.stringify(archiveFile, null, 2));

    const file = readSpaces();
    file.spaces.push(restored);
    writeSpaces(file);
    return restored;
}
