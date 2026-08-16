/**
 * TITAN — Action Compiler
 * Converts natural language action plans into tool calls.
 * 
 * Models like gemma4 are unreliable at generating tool_calls JSON.
 * Instead, we tell them to output simple ACTION: directives,
 * and TITAN compiles these into actual tool executions.
 *
 * Format:
 *   ACTION: read_file /path/to/file
 *   ACTION: write_file /path/to/file
 *   CONTENT:
 *   <content>
 *   END_CONTENT
 *   ACTION: edit_file /path/to/file
 *   FIND:
 *   <text to find>
 *   REPLACE:
 *   <replacement>
 *   END_EDIT
 *   ACTION: shell <command>
 *   ACTION: append_file /path/to/file
 *   CONTENT:
 *   <content to append>
 *   END_CONTENT
 */
import logger from '../utils/logger.js';

const COMPONENT = 'ActionCompiler';

export interface CompiledAction {
    tool: string;
    args: Record<string, unknown>;
}

/** Check if text contains ACTION: directives */
export function hasActionDirectives(text: string): boolean {
    return /^ACTION:\s/m.test(text);
}

/** Compile ACTION: directives from text into tool calls */
export function compileActions(text: string): CompiledAction[] {
    const actions: CompiledAction[] = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();

        // ACTION: read_file /path
        const readMatch = line.match(/^ACTION:\s*read_file\s+(.+)/i);
        if (readMatch) {
            actions.push({ tool: 'read_file', args: { path: readMatch[1].trim() } });
            i++;
            continue;
        }

        // ACTION: shell <command>
        const shellMatch = line.match(/^ACTION:\s*shell\s+(.+)/i);
        if (shellMatch) {
            actions.push({ tool: 'shell', args: { command: shellMatch[1].trim() } });
            i++;
            continue;
        }

        // ACTION: write_file /path followed by CONTENT: ... END_CONTENT
        // Capture the verb token itself (group 1) rather than testing the whole
        // line for 'append' — otherwise a write_file directive whose PATH contains
        // 'append' (e.g. "ACTION: write_file /logs/appendix.txt") would be
        // misdiscriminated as append_file.
        const writeMatch = line.match(/^ACTION:\s*(write_file|append_file)\s+(.+)/i);
        if (writeMatch) {
            const toolName = writeMatch[1].toLowerCase() === 'append_file' ? 'append_file' : 'write_file';
            const path = writeMatch[2].trim();
            i++;
            // Look for CONTENT: block
            if (i < lines.length && lines[i].trim().startsWith('CONTENT:')) {
                i++;
                const contentLines: string[] = [];
                while (i < lines.length && !lines[i].trim().startsWith('END_CONTENT')) {
                    contentLines.push(lines[i]);
                    i++;
                }
                actions.push({ tool: toolName, args: { path, content: contentLines.join('\n') } });
                i++; // skip END_CONTENT
            }
            continue;
        }

        // ACTION: edit_file /path followed by FIND: ... REPLACE: ... END_EDIT
        const editMatch = line.match(/^ACTION:\s*edit_file\s+(.+)/i);
        if (editMatch) {
            const path = editMatch[1].trim();
            i++;
            let target = '';
            let replacement = '';
            // Whether the REPLACE: block was explicitly present in the directive.
            // We track this as its own boolean instead of inferring "was REPLACE
            // seen?" from `replacement === ''`, because an explicit empty
            // REPLACE: block (REPLACE: immediately followed by END_EDIT) is a
            // legitimate directive — it means "delete this text" — and must stay
            // distinguishable from a REPLACE: block that never appeared at all
            // (a truncated/malformed directive), which we reject below instead of
            // silently compiling into an unintended deletion.
            let sawReplaceBlock = false;
            // FIND: block
            if (i < lines.length && lines[i].trim().startsWith('FIND:')) {
                i++;
                const findLines: string[] = [];
                while (i < lines.length && !lines[i].trim().startsWith('REPLACE:')) {
                    findLines.push(lines[i]);
                    i++;
                }
                target = findLines.join('\n');
            }
            // REPLACE: block
            if (i < lines.length && lines[i].trim().startsWith('REPLACE:')) {
                sawReplaceBlock = true;
                i++;
                const replaceLines: string[] = [];
                while (i < lines.length && !lines[i].trim().startsWith('END_EDIT')) {
                    replaceLines.push(lines[i]);
                    i++;
                }
                replacement = replaceLines.join('\n');
                i++; // skip END_EDIT
            }
            if (target && sawReplaceBlock) {
                actions.push({ tool: 'edit_file', args: { path, target, replacement } });
            } else {
                logger.warn(COMPONENT, `Rejected malformed edit_file directive for ${path}: ${!target ? 'missing FIND block' : 'missing REPLACE block'}`);
            }
            continue;
        }

        // ACTION: list_dir /path
        const listMatch = line.match(/^ACTION:\s*list_dir\s+(.+)/i);
        if (listMatch) {
            actions.push({ tool: 'list_dir', args: { path: listMatch[1].trim() } });
            i++;
            continue;
        }

        // ACTION: spawn_agent name task
        const spawnMatch = line.match(/^ACTION:\s*spawn_agent\s+(\w+)\s+(.+)/i);
        if (spawnMatch) {
            actions.push({ tool: 'spawn_agent', args: { name: spawnMatch[1], task: spawnMatch[2], template: spawnMatch[1].toLowerCase() } });
            i++;
            continue;
        }

        i++;
    }

    if (actions.length > 0) {
        logger.info(COMPONENT, `Compiled ${actions.length} actions from text`);
    }

    return actions;
}
