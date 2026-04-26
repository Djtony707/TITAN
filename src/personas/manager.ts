/**
 * TITAN — Persona Manager
 * File-based persona system. Reads persona definitions from assets/personas/
 * and provides runtime persona selection.
 *
 * Persona definitions adapted from agency-agents (MIT License)
 * Copyright (c) 2025 AgentLand Contributors
 * https://github.com/msitarzewski/agency-agents
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const COMPONENT = 'Personas';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Bundled personas ship in assets/personas/ relative to project root
const PERSONAS_DIR = join(__dirname, '../../assets/personas');

export interface PersonaMeta {
    id: string;
    name: string;
    description: string;
    division: string;
    source: string;
}

export interface Persona extends PersonaMeta {
    content: string;
}

let personaCache: Map<string, Persona> | null = null;

function parseFrontmatter(raw: string): { meta: Record<string, string>; content: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { meta: {}, content: raw };

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (kv) meta[kv[1]] = kv[2].trim();
    }
    return { meta, content: match[2].trim() };
}

export function loadPersonas(): Map<string, Persona> {
    if (personaCache) return personaCache;

    personaCache = new Map();

    if (!existsSync(PERSONAS_DIR)) {
        logger.warn(COMPONENT, `Personas directory not found: ${PERSONAS_DIR}`);
        return personaCache;
    }

    const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md'));

    for (const file of files) {
        const id = file.replace('.md', '');
        const raw = readFileSync(join(PERSONAS_DIR, file), 'utf-8');
        const { meta, content } = parseFrontmatter(raw);

        personaCache.set(id, {
            id,
            name: meta.name || id,
            description: meta.description || '',
            division: meta.division || 'general',
            source: meta.source || 'bundled',
            content,
        });
    }

    logger.info(COMPONENT, `Loaded ${personaCache.size} personas`);
    return personaCache;
}

export function getPersona(id: string): Persona | undefined {
    return loadPersonas().get(id);
}

export function listPersonas(): PersonaMeta[] {
    return Array.from(loadPersonas().values()).map(({ content: _c, ...meta }) => meta);
}

// Cap persona content injected into system prompts. Many personas are 10–14KB
// (~2.5–3.5K tokens) which inflates every turn's input and hurts smaller
// models. We keep the head of the file (role definition + first sections) up
// to PERSONA_INJECTION_CAP and drop the rest. Override via env
// TITAN_PERSONA_CAP (bytes) or set to 0 to disable.
const PERSONA_INJECTION_CAP_DEFAULT = 4096;

function personaInjectionCap(): number {
    const raw = process.env.TITAN_PERSONA_CAP;
    if (raw === undefined) return PERSONA_INJECTION_CAP_DEFAULT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return PERSONA_INJECTION_CAP_DEFAULT;
    return n; // 0 disables truncation
}

/**
 * Truncate persona content at the cap, preferring section boundaries.
 * If a markdown header (`^#+ `) appears within the last 25% of the cap,
 * cut there instead of mid-line. Always appends a "[truncated]" marker
 * when truncation occurs.
 */
function truncatePersona(content: string, cap: number): string {
    if (cap === 0 || content.length <= cap) return content;
    const slice = content.slice(0, cap);
    // search for last header in the final quarter of the slice for a cleaner break
    const lookback = Math.floor(cap * 0.75);
    const tail = slice.slice(lookback);
    const headerMatch = tail.match(/\n(#{1,6} [^\n]+)\n[\s\S]*$/);
    let cut: string;
    if (headerMatch && headerMatch.index !== undefined) {
        // cut right BEFORE the matched header so the truncated section starts cleanly
        cut = slice.slice(0, lookback + headerMatch.index);
    } else {
        // fall back to last paragraph break
        const lastBreak = slice.lastIndexOf('\n\n');
        cut = lastBreak > cap * 0.5 ? slice.slice(0, lastBreak) : slice;
    }
    return cut.trimEnd() + `\n\n[persona truncated at ${cap} bytes — full ${content.length} bytes available via get_persona tool]`;
}

export function getActivePersonaContent(personaId: string): string {
    if (personaId === 'default') return '';
    const persona = getPersona(personaId);
    if (!persona) {
        logger.warn(COMPONENT, `Persona "${personaId}" not found, falling back to default`);
        return '';
    }
    return truncatePersona(persona.content, personaInjectionCap());
}

/** Returns the FULL persona content with no truncation — for tool callers
 * that explicitly need the whole document (e.g. `persona_get` skill). */
export function getFullPersonaContent(personaId: string): string {
    if (personaId === 'default') return '';
    const persona = getPersona(personaId);
    return persona?.content ?? '';
}

export function invalidatePersonaCache(): void {
    personaCache = null;
}
