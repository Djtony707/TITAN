/**
 * TITAN v5.0 — Prompt Includes (Space Agent parity)
 *
 * Auto-discovers *.system.include.md and *.transient.include.md files
 * in ~/.titan/prompts/ and injects them into agent context.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'PromptIncludes';
const PROMPTS_DIR = `${homedir()}/.titan/prompts`;

export interface PromptInclude {
    name: string;
    type: 'system' | 'transient';
    content: string;
    path: string;
}

/** Discover all prompt include files */
export function discoverPromptIncludes(): PromptInclude[] {
    if (!existsSync(PROMPTS_DIR)) return [];

    const results: PromptInclude[] = [];
    const files = readdirSync(PROMPTS_DIR);

    for (const file of files) {
        if (file.endsWith('.system.include.md')) {
            const path = join(PROMPTS_DIR, file);
            try {
                const content = readFileSync(path, 'utf-8');
                results.push({ name: file.replace('.system.include.md', ''), type: 'system', content, path });
            } catch (err) {
                logger.debug(COMPONENT, `Failed to read ${file}: ${(err as Error).message}`);
            }
        } else if (file.endsWith('.transient.include.md')) {
            const path = join(PROMPTS_DIR, file);
            try {
                const content = readFileSync(path, 'utf-8');
                results.push({ name: file.replace('.transient.include.md', ''), type: 'transient', content, path });
            } catch (err) {
                logger.debug(COMPONENT, `Failed to read ${file}: ${(err as Error).message}`);
            }
        }
    }

    return results;
}

/** Get system includes as a combined string */
export function getSystemIncludes(): string {
    const includes = discoverPromptIncludes().filter(i => i.type === 'system');
    if (includes.length === 0) return '';
    return includes.map(i => `## ${i.name}\n${i.content}`).join('\n\n');
}

/** Get transient includes as a combined string */
export function getTransientIncludes(): string {
    const includes = discoverPromptIncludes().filter(i => i.type === 'transient');
    if (includes.length === 0) return '';
    return includes.map(i => `## ${i.name}\n${i.content}`).join('\n\n');
}
