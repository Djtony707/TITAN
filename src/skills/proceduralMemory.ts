/**
 * TITAN — Procedural Memory (F3: Hermes-inspired skill learning)
 *
 * Lets agents save reusable approaches as .md skill files with frontmatter metadata.
 * Skills are auto-recalled by keyword matching and injected into the system prompt.
 *
 * Storage: ~/.titan/procedural-skills/*.md
 * Format: YAML frontmatter (name, tags, created, useCount) + markdown body
 *
 * Tools: save_skill, recall_skill
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ProceduralMemory';
const SKILLS_DIR = join(TITAN_HOME, 'procedural-skills');

/** Skill metadata parsed from frontmatter */
export interface ProceduralSkill {
    name: string;
    tags: string[];
    created: string;
    useCount: number;
    filePath: string;
    content: string;
}

// In-memory cache, loaded once on first access
let skillCache: ProceduralSkill[] | null = null;

/** Ensure the procedural skills directory exists */
function ensureSkillsDir(): void {
    if (!existsSync(SKILLS_DIR)) {
        mkdirSync(SKILLS_DIR, { recursive: true });
    }
}

/** Parse YAML frontmatter from a skill file */
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return { meta: {}, body: raw };

    const meta: Record<string, unknown> = {};
    for (const line of fmMatch[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();
        // Parse arrays: [tag1, tag2]
        if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
            value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        }
        // Parse numbers
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            value = parseInt(value, 10);
        }
        meta[key] = value;
    }

    return { meta, body: fmMatch[2].trim() };
}

/** Generate frontmatter string from metadata */
function generateFrontmatter(skill: ProceduralSkill): string {
    const tags = skill.tags.map(t => `"${t}"`).join(', ');
    return [
        '---',
        `name: ${skill.name}`,
        `tags: [${tags}]`,
        `created: ${skill.created}`,
        `useCount: ${skill.useCount}`,
        '---',
        '',
        skill.content,
    ].join('\n');
}

/** Load all procedural skills from disk */
export function loadSkills(): ProceduralSkill[] {
    if (skillCache !== null) return skillCache;

    ensureSkillsDir();
    const skills: ProceduralSkill[] = [];

    try {
        const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
        for (const file of files) {
            try {
                const filePath = join(SKILLS_DIR, file);
                const raw = readFileSync(filePath, 'utf-8');
                const { meta, body } = parseFrontmatter(raw);

                skills.push({
                    name: (meta.name as string) || file.replace('.md', ''),
                    tags: Array.isArray(meta.tags) ? meta.tags as string[] : [],
                    created: (meta.created as string) || new Date().toISOString(),
                    useCount: (meta.useCount as number) || 0,
                    filePath,
                    content: body,
                });
            } catch {
                logger.warn(COMPONENT, `Failed to parse skill file: ${file}`);
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to read skills directory: ${(err as Error).message}`);
    }

    skillCache = skills;
    logger.debug(COMPONENT, `Loaded ${skills.length} procedural skill(s)`);
    return skills;
}

/** Invalidate the cache (call after saving a new skill) */
function invalidateCache(): void {
    skillCache = null;
}

/** Save a new procedural skill */
export function saveSkill(name: string, tags: string[], content: string): ProceduralSkill {
    ensureSkillsDir();

    // Sanitize filename
    const safeName = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').slice(0, 60);
    const filePath = join(SKILLS_DIR, `${safeName}.md`);

    const skill: ProceduralSkill = {
        name,
        tags: tags.map(t => t.toLowerCase().trim()),
        created: new Date().toISOString(),
        useCount: 0,
        filePath,
        content,
    };

    writeFileSync(filePath, generateFrontmatter(skill), 'utf-8');
    invalidateCache();
    logger.info(COMPONENT, `Saved skill: "${name}" (tags: ${tags.join(', ')})`);
    return skill;
}

/** Search skills by keyword/tag matching. Returns top N matches. */
export function searchSkills(query: string, maxResults = 3): ProceduralSkill[] {
    const skills = loadSkills();
    if (skills.length === 0) return [];

    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (queryWords.length === 0) return [];

    // Score each skill by keyword overlap
    const scored = skills.map(skill => {
        let score = 0;
        const haystack = `${skill.name} ${skill.tags.join(' ')} ${skill.content}`.toLowerCase();

        for (const word of queryWords) {
            // Tag match = highest weight
            if (skill.tags.some(t => t.includes(word) || word.includes(t))) score += 3;
            // Name match
            if (skill.name.toLowerCase().includes(word)) score += 2;
            // Content match
            if (haystack.includes(word)) score += 1;
        }

        // Boost frequently-used skills slightly
        score += Math.min(skill.useCount * 0.1, 1);

        return { skill, score };
    });

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(s => s.skill);
}

/** Increment use count for a skill (called when injected into prompt) */
export function recordSkillUse(skill: ProceduralSkill): void {
    skill.useCount++;
    try {
        writeFileSync(skill.filePath, generateFrontmatter(skill), 'utf-8');
    } catch {
        // Non-critical — use count update failed, continue
    }
}

/**
 * Build a [PROCEDURAL MEMORY] injection for the system prompt.
 * Searches skills by the user's message keywords, returns top 2 matches.
 */
export function getProceduralContext(userMessage: string): string | null {
    const matches = searchSkills(userMessage, 2);
    if (matches.length === 0) return null;

    const sections = matches.map(skill => {
        recordSkillUse(skill);
        return `### ${skill.name}\nTags: ${skill.tags.join(', ')}\n${skill.content.slice(0, 500)}`;
    });

    return `[PROCEDURAL MEMORY — reusable approaches from prior tasks]\n${sections.join('\n\n')}`;
}
