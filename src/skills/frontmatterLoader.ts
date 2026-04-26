/**
 * TITAN — Skill Frontmatter Loader
 *
 * Discovers SKILL.md files with YAML frontmatter + markdown body
 * and registers them as dynamic context-injection skills.
 *
 * Inspired by space-agent's skill system and Hermes Agent's skill library.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'FrontmatterSkills';

export interface FrontmatterSkill {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags: string[];
  content: string;
  sourcePath: string;
}

const SKILL_DIRS = [
  join(process.cwd(), 'src', 'skills', 'frontmatter'),
  join(TITAN_HOME, 'skills'),
];

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();

  // Simple YAML parser — only handles key: value and key: [a, b, c]
  const frontmatter: Record<string, unknown> = {};
  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    // Array: [a, b, c]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (typeof value === 'string') {
      value = value.replace(/^["']|["']$/g, '');
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

function scanSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const results: string[] = [];
  const walk = (d: string): void => {
    let entries: Dirent[] = [];
    try { entries = readdirSync(d, { withFileTypes: true }) as Dirent[]; } catch { return; }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.toLowerCase().endsWith('.skill.md')) {
        results.push(full);
      }
    }
  };

  walk(dir);
  return results;
}

export function loadFrontmatterSkills(): FrontmatterSkill[] {
  const skills: FrontmatterSkill[] = [];

  for (const dir of SKILL_DIRS) {
    const files = scanSkillFiles(dir);
    for (const path of files) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);

        const name = String(frontmatter.name || '');
        if (!name) {
          logger.warn(COMPONENT, `Skipped ${path}: missing 'name' in frontmatter`);
          continue;
        }

        const tags = Array.isArray(frontmatter.tags)
          ? frontmatter.tags.map(String)
          : String(frontmatter.tags || '').split(',').map(s => s.trim()).filter(Boolean);

        skills.push({
          name,
          version: String(frontmatter.version || '1.0.0'),
          description: String(frontmatter.description || ''),
          author: String(frontmatter.author || ''),
          tags,
          content: body,
          sourcePath: path,
        });
      } catch (e) {
        logger.warn(COMPONENT, `Failed to parse ${path}: ${(e as Error).message}`);
      }
    }
  }

  if (skills.length > 0) {
    logger.info(COMPONENT, `Loaded ${skills.length} frontmatter skill(s)`);
  }

  return skills;
}

/** Convert frontmatter skills into TITAN tool handlers ready for registration */
export function getFrontmatterToolHandlers(): Array<{ name: string; description: string; handler: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] }; execute: (args: Record<string, unknown>) => Promise<string> } }> {
  const skills = loadFrontmatterSkills();
  return skills.map(skill => ({
    name: skill.name,
    description: skill.description || `Frontmatter skill: ${skill.name}`,
    handler: {
      name: skill.name,
      description: `${skill.description}\n\nTags: ${skill.tags.join(', ') || 'none'}${skill.author ? ` | Author: ${skill.author}` : ''}\n\n${skill.content.slice(0, 400)}...`,
      parameters: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
      execute: async (_args: Record<string, unknown>) => {
        return `## ${skill.name} (v${skill.version})\n\n${skill.content}`;
      },
    },
  }));
}
