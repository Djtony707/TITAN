/**
 * TITAN — Skill Frontmatter Loader
 *
 * Discovers SKILL.md files with YAML frontmatter + markdown body
 * and registers them as dynamic context-injection skills.
 *
 * Inspired by space-agent's skill system and Hermes Agent's skill library.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'FrontmatterSkills';

// Package root, resolved relative to THIS module (works for both `tsx src/` in
// dev and a global npm install) — not process.cwd(), which is the user's shell
// dir. dist/skills/ and src/skills/ are both two levels under the package root.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface FrontmatterSkill {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags: string[];
  content: string;
  sourcePath: string;
  /**
   * v6.0.5 — Space Agent parity. When `auto: true` is set in the
   * frontmatter (or `placement: system`), the skill's body is injected
   * directly into the agent's system prompt every turn instead of
   * waiting to be invoked as a tool. Use for behavior overlays + standing
   * preferences. Inspired by Space Agent's auto-loaded memory skill.
   */
  auto: boolean;
}

const SKILL_DIRS = [
  join(process.cwd(), 'src', 'skills', 'frontmatter'),
  // Bundled skill library shipped in the npm package (includes the
  // ECC-attributed software-craft skills) — package-relative so it resolves
  // for installed users, not just an in-repo run.
  join(PKG_ROOT, 'assets', 'agent-skills'),
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

        const auto =
          frontmatter.auto === true ||
          String(frontmatter.auto).toLowerCase() === 'true' ||
          String(frontmatter.placement || '').toLowerCase() === 'system';

        skills.push({
          name,
          version: String(frontmatter.version || '1.0.0'),
          description: String(frontmatter.description || ''),
          author: String(frontmatter.author || ''),
          tags,
          content: body,
          sourcePath: path,
          auto,
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

/**
 * v6.0.5 — Render the auto-injected skills + a one-line catalog of the
 * lazy-loaded ones for the agent's system prompt.
 *
 * Auto skills get their FULL body injected. Lazy skills get one-line
 * name + description so the agent knows what's available without bloating
 * the prompt — it can call them as tools if it needs the body.
 *
 * Empty string when no SKILL.md files exist. Capped at ~6KB total so a
 * runaway skills directory can't blow the prompt budget.
 */
const SKILL_PROMPT_CAP = 6000;

export function renderSkillsForPrompt(): string {
  const skills = loadFrontmatterSkills();
  if (skills.length === 0) return '';

  const auto = skills.filter(s => s.auto);
  const lazy = skills.filter(s => !s.auto);
  const parts: string[] = [];

  if (auto.length > 0) {
    parts.push('## Skills you\'ve authored (auto-injected)');
    let used = 0;
    for (const s of auto) {
      const section = `### ${s.name}\n${s.content.trim()}\n`;
      if (used + section.length > SKILL_PROMPT_CAP) {
        parts.push(`(${auto.length - parts.length + 1} more auto skills truncated to fit prompt budget)`);
        break;
      }
      parts.push(section);
      used += section.length;
    }
  }

  if (lazy.length > 0) {
    parts.push('## Skills available on demand');
    parts.push('Call them like any other tool. Each runs its body as a markdown reference (helpers + examples).');
    for (const s of lazy.slice(0, 30)) {
      const desc = s.description ? `: ${s.description.slice(0, 120)}` : '';
      parts.push(`- \`${s.name}\`${desc}`);
    }
  }

  parts.push('');
  parts.push('You can author a new skill at any time by writing `~/.titan/skills/<name>.skill.md` with `--- name: <id>\\ndescription: <text>\\nauto: true|false\\n--- <body>`. Auto skills inject every turn; lazy skills are tool-callable.');

  return '\n' + parts.join('\n') + '\n';
}
