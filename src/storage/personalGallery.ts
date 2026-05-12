/**
 * TITAN — Personal widget gallery per user (v6.0 step 6)
 *
 * Why this exists
 * ---------------
 * The v6.0 differentiator: "Six months in, your TITAN is irreplaceable because
 * nobody else's TITAN knows you the same way." This module is one of the
 * mechanisms — every successfully-built widget can be saved to the user's
 * personal gallery so:
 *
 *   - Next time they ask for "my freelance tracker", it's an instant re-pin.
 *   - After 3+ similar widgets, TITAN promotes a pattern into a template.
 *   - The user's library compounds — TITAN actively becomes more useful the
 *     longer they use it.
 *
 * Storage: `~/.titan/users/<userId>/gallery.json` (seeded as empty dir by
 * migration 004; this module owns the file itself).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

const COMPONENT = 'PersonalGallery';

function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function galleryPath(userId: string): string {
    return join(titanHome(), 'users', userId, 'gallery.json');
}

export interface PersonalWidget {
    /** Stable id (pwgt-XXXXXXXX). */
    id: string;
    /** Display name. */
    name: string;
    /** Short reason TITAN saved this — used for fuzzy search ("my BPM widget"). */
    description?: string;
    /** Widget format. Matches frontend WidgetFormat. */
    format: 'react' | 'vanilla' | 'html' | 'iframe' | 'system';
    /** Widget source (React/HTML/iframe URL/system:xxx ref). */
    source: string;
    /** Default size. */
    w: number;
    h: number;
    /** Tags TITAN inferred from the user's request. Used by `searchPersonalGallery`. */
    tags: string[];
    /** How many times the user has pinned this to a Space. Bumped on re-use. */
    useCount: number;
    createdAt: string;
    updatedAt: string;
    /** Origin: built fresh, derived from a gallery template, etc. */
    origin: 'generated' | 'template' | 'imported';
}

export interface PersonalGalleryFile {
    schema: 1;
    userId: string;
    widgets: PersonalWidget[];
    createdAt: string;
    updatedAt: string;
}

export function readPersonalGallery(userId = 'default-user'): PersonalGalleryFile {
    const path = galleryPath(userId);
    if (!existsSync(path)) return emptyGallery(userId);
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw && raw.schema === 1 && raw.userId === userId && Array.isArray(raw.widgets)) {
            return raw as PersonalGalleryFile;
        }
    } catch (err) {
        logger.warn(COMPONENT, `Gallery for ${userId} malformed (${(err as Error).message}) — returning empty.`);
    }
    return emptyGallery(userId);
}

export function writePersonalGallery(file: PersonalGalleryFile): void {
    const path = galleryPath(file.userId);
    try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
    file.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(file, null, 2));
}

function emptyGallery(userId: string): PersonalGalleryFile {
    const now = new Date().toISOString();
    return { schema: 1, userId, widgets: [], createdAt: now, updatedAt: now };
}

/** Save a widget to the user's personal gallery. Idempotent on duplicate
 *  (same name + source = bump useCount instead of inserting). */
export function saveToPersonalGallery(
    userId: string,
    widget: Omit<PersonalWidget, 'id' | 'useCount' | 'createdAt' | 'updatedAt'>,
): PersonalWidget {
    const file = readPersonalGallery(userId);
    // Dedup on name + source (canonical equivalence). If the user keeps
    // building "Clock" we don't end up with 50 Clocks.
    const existing = file.widgets.find(
        w => w.name === widget.name && w.source === widget.source,
    );
    const now = new Date().toISOString();
    if (existing) {
        existing.useCount++;
        existing.updatedAt = now;
        // Refresh tags + description in case they're better this time.
        if (widget.description) existing.description = widget.description;
        if (widget.tags.length > 0) existing.tags = Array.from(new Set([...existing.tags, ...widget.tags]));
        writePersonalGallery(file);
        return existing;
    }
    const saved: PersonalWidget = {
        id: 'pwgt-' + randomUUID().slice(0, 8),
        ...widget,
        useCount: 1,
        createdAt: now,
        updatedAt: now,
    };
    file.widgets.push(saved);
    writePersonalGallery(file);
    logger.info(COMPONENT, `Saved "${saved.name}" to gallery for ${userId} (${file.widgets.length} total).`);
    return saved;
}

/** Fuzzy search the personal gallery by query (name / description / tags).
 *  Returns up to `limit` hits, sorted by relevance then useCount. */
export function searchPersonalGallery(userId: string, query: string, limit = 5): PersonalWidget[] {
    const file = readPersonalGallery(userId);
    const q = query.toLowerCase().trim();
    if (!q || file.widgets.length === 0) return [];

    const scored = file.widgets.map(w => {
        let matchScore = 0;
        const hay = [
            w.name.toLowerCase(),
            (w.description || '').toLowerCase(),
            w.tags.join(' ').toLowerCase(),
        ].join(' ');
        // Exact word match worth more than substring match.
        for (const token of q.split(/\s+/).filter(Boolean)) {
            if (hay.includes(' ' + token + ' ') || hay.startsWith(token + ' ') || hay.endsWith(' ' + token) || hay === token) {
                matchScore += 3;
            } else if (hay.includes(token)) {
                matchScore += 1;
            }
        }
        // Useful tie-break — frequently-used widgets surface first. ONLY
        // applies when there's already a keyword match; otherwise useCount
        // would surface every popular widget for every query.
        const score = matchScore > 0 ? matchScore + Math.min(w.useCount, 10) * 0.1 : 0;
        return { w, score };
    });
    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.w);
}

/** Remove a widget from the personal gallery. */
export function removeFromPersonalGallery(userId: string, id: string): boolean {
    const file = readPersonalGallery(userId);
    const idx = file.widgets.findIndex(w => w.id === id);
    if (idx === -1) return false;
    file.widgets.splice(idx, 1);
    writePersonalGallery(file);
    return true;
}

export function __resetPersonalGalleryForTests(userId = 'default-user'): void {
    try { require('fs').unlinkSync(galleryPath(userId)); } catch { /* fine */ }
}
