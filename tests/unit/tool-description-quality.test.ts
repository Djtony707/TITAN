/**
 * Tool-description quality bar.
 *
 * The agent-harness research (Anthropic — "Writing effective tools for AI
 * agents") and the Picrew/awesome-agent-harness top-10 pattern #4 ("MCP /
 * tool protocol standardisation") both rank tool-description quality as a
 * leading driver of agent reliability. Small models follow well-described
 * tools dramatically better; vague ones are the #1 source of "agent picked
 * the wrong tool" bugs.
 *
 * This file pins the quality bar on TITAN's high-traffic primitives so a
 * future contributor can't silently degrade them. Every priority tool must
 * have all four sections (use-case, anti-pattern, parameters, Returns,
 * Errors) and a minimum length floor.
 *
 * Reference:
 *   https://www.anthropic.com/engineering/writing-tools-for-agents
 *   docs/HARNESS-PATTERNS.md (TITAN self-audit)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

/** Extract a tool's description string by name from a skill file. */
function extractToolDescription(filePath: string, toolName: string): string | null {
    const src = readFileSync(join(REPO_ROOT, filePath), 'utf-8');
    // The ToolHandler description (the LLM-facing one) is the SECOND occurrence
    // of `name: 'X'` in a registerSkill call. We scan for the pattern that
    // matches the handler — a `name:` followed by `description:` in the same
    // object literal. Handles backtick, single-quote-with-escapes, and array.join forms.

    // 1. Backtick form: name: 'X', description: `...`
    const bt = new RegExp(
        `name:\\s*['\"]${toolName}['\"]\\s*,\\s*description:\\s*\`([\\s\\S]*?)\``,
        'g',
    );
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = bt.exec(src)) !== null) lastMatch = m;
    if (lastMatch) return lastMatch[1];

    // 2. array.join form: description: ['...', '...'].join(...)
    const aj = new RegExp(
        `name:\\s*['\"]${toolName}['\"]\\s*,\\s*description:\\s*\\[([\\s\\S]*?)\\]\\.join`,
        'g',
    );
    while ((m = aj.exec(src)) !== null) lastMatch = m;
    if (lastMatch) return lastMatch[1];

    // 3. Single-quote form with possible escaped apostrophes.
    const sq = new RegExp(
        `name:\\s*['\"]${toolName}['\"]\\s*,\\s*description:\\s*'((?:[^'\\\\]|\\\\.)*)'`,
        'g',
    );
    while ((m = sq.exec(src)) !== null) lastMatch = m;
    if (lastMatch) return lastMatch[1];

    return null;
}

/** Anthropic-checklist gates a high-traffic tool must clear. */
function auditDescription(desc: string): { passed: boolean; gaps: string[] } {
    const gaps: string[] = [];
    if (desc.length < 400) gaps.push('TOO SHORT (<400 chars)');
    if (!/USE WHEN|USE THIS WHEN|YOU MUST CALL/i.test(desc)) gaps.push('missing use-case section');
    if (!/DO NOT USE|NEVER\b/i.test(desc)) gaps.push('missing anti-pattern section');
    if (!/\breturns?\b/i.test(desc)) gaps.push('missing Returns section');
    if (!/error/i.test(desc)) gaps.push('missing Errors section');
    return { passed: gaps.length === 0, gaps };
}

/**
 * The priority set — TITAN's high-traffic primitives + identity tools.
 * Each entry: tool name, source file, description floor.
 *
 * Floor values reflect what the tool actually needs:
 *   - shell, current_model: 1500+ (rich state, many error modes)
 *   - filesystem: 900+ (uniform structure, well-bounded)
 *   - everything else: 700+ minimum
 */
const PRIORITY_TOOLS: Array<{ name: string; file: string; floor: number }> = [
    { name: 'shell',           file: 'src/skills/builtin/shell.ts',          floor: 1500 },
    { name: 'read_file',       file: 'src/skills/builtin/filesystem.ts',     floor: 900  },
    { name: 'write_file',      file: 'src/skills/builtin/filesystem.ts',     floor: 900  },
    { name: 'edit_file',       file: 'src/skills/builtin/filesystem.ts',     floor: 900  },
    { name: 'append_file',     file: 'src/skills/builtin/filesystem.ts',     floor: 700  },
    { name: 'list_dir',        file: 'src/skills/builtin/filesystem.ts',     floor: 700  },
    { name: 'web_search',      file: 'src/skills/builtin/web_search.ts',     floor: 900  },
    { name: 'web_fetch',       file: 'src/skills/builtin/web_fetch.ts',      floor: 900  },
    { name: 'memory',          file: 'src/skills/builtin/memory_skill.ts',   floor: 900  },
    { name: 'current_model',   file: 'src/skills/builtin/current_model.ts',  floor: 1500 },
    { name: 'switch_model',    file: 'src/skills/builtin/model_switch.ts',   floor: 700  },
    { name: 'switch_persona',  file: 'src/skills/builtin/persona_manager.ts', floor: 700  },
    { name: 'list_personas',   file: 'src/skills/builtin/persona_manager.ts', floor: 600  },
    { name: 'get_persona',     file: 'src/skills/builtin/persona_manager.ts', floor: 500  },
    { name: 'cron',            file: 'src/skills/builtin/cron.ts',           floor: 1000 },
    { name: 'webhook',         file: 'src/skills/builtin/webhook.ts',        floor: 900  },
    { name: 'gallery_search',  file: 'src/skills/builtin/widget_gallery.ts', floor: 900  },
    { name: 'gallery_get',     file: 'src/skills/builtin/widget_gallery.ts', floor: 900  },
];

describe('tool description quality — Anthropic checklist', () => {
    for (const { name, file, floor } of PRIORITY_TOOLS) {
        it(`${name} meets the quality bar (>= ${floor} chars + all 4 sections)`, () => {
            const desc = extractToolDescription(file, name);
            expect(desc, `couldn't extract description for ${name} from ${file}`).not.toBeNull();
            const audit = auditDescription(desc!);
            const fail = [
                `Tool "${name}" failed the Anthropic-checklist audit.`,
                `  File:  ${file}`,
                `  Chars: ${desc!.length} (floor ${floor})`,
                `  Gaps:  ${audit.gaps.join('; ')}`,
                ``,
                `See docs/HARNESS-PATTERNS.md and https://www.anthropic.com/engineering/writing-tools-for-agents`,
                `for the rewrite playbook. Each description should have:`,
                `  - one-paragraph purpose statement`,
                `  - "USE WHEN" examples`,
                `  - "DO NOT USE FOR" anti-patterns`,
                `  - "Parameters" with types + constraints`,
                `  - "Returns" with the response shape`,
                `  - "Errors" with the common failure modes + remediation hints`,
            ].join('\n');
            expect(audit.passed, fail).toBe(true);
            expect(desc!.length).toBeGreaterThanOrEqual(floor);
        });
    }

    it('the priority set covers TITAN\'s most-called primitives', () => {
        // Sanity: the set isn't empty and includes the highest-traffic tool.
        expect(PRIORITY_TOOLS.length).toBeGreaterThanOrEqual(15);
        expect(PRIORITY_TOOLS.find(t => t.name === 'shell')).toBeDefined();
        expect(PRIORITY_TOOLS.find(t => t.name === 'read_file')).toBeDefined();
    });
});
