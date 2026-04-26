/**
 * TITAN — Prompt-Include Memory System
 *
 * Auto-discovers and injects markdown files from ~/.titan/includes/
 * Inspired by space-agent's prompt-include pattern.
 *
 * File naming convention:
 *   *.system.include.md    → injected into system prompt (permanent memory, high primacy)
 *   *.transient.include.md → injected into context appendix (temporary, trimmed first)
 *   *.user.include.md      → user facts injected after identity block
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'PromptIncludes';
const INCLUDES_DIR = join(homedir(), '.titan', 'includes');

export type IncludeCategory = 'system' | 'transient' | 'user';

export interface PromptInclude {
  filename: string;
  category: IncludeCategory;
  content: string;
}

function discoverIncludes(): PromptInclude[] {
  if (!existsSync(INCLUDES_DIR)) {
    return [];
  }

  const files: PromptInclude[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(INCLUDES_DIR);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!name.endsWith('.include.md')) continue;

    let category: IncludeCategory | null = null;
    if (name.endsWith('.system.include.md')) category = 'system';
    else if (name.endsWith('.transient.include.md')) category = 'transient';
    else if (name.endsWith('.user.include.md')) category = 'user';

    if (!category) continue;

    const path = join(INCLUDES_DIR, name);
    try {
      const content = readFileSync(path, 'utf-8').trim();
      if (content.length > 0) {
        files.push({ filename: name, category, content });
      }
    } catch (e) {
      logger.warn(COMPONENT, `Failed to read ${path}: ${(e as Error).message}`);
    }
  }

  // Sort by filename for deterministic ordering
  files.sort((a, b) => a.filename.localeCompare(b.filename));
  return files;
}

function buildBlock(include: PromptInclude): string {
  return `<!-- include: ${include.filename} -->\n${include.content}`;
}

export function buildPromptIncludes(category: IncludeCategory): string {
  const includes = discoverIncludes().filter(i => i.category === category);
  if (includes.length === 0) return '';

  const blocks = includes.map(buildBlock);
  return blocks.join('\n\n');
}

export function getIncludeSummary(): string {
  const includes = discoverIncludes();
  if (includes.length === 0) return '';
  return includes.map(i => `- ${i.filename} (${i.category})`).join('\n');
}
