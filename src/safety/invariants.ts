/**
 * TITAN — Swarm Invariants (Hard Safety Rules)
 * Fail-closed checks that run before every tool invocation.
 */

import { existsSync } from 'fs';

export interface InvariantResult {
    pass: boolean;
    reason?: string;
}

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'apply_patch']);

/** Extract command-like strings from tool arguments */
function extractCommandLike(args: Record<string, unknown>): string | null {
    for (const key of ['command', 'code', 'script', 'cmd', 'shell']) {
        const val = args[key];
        if (typeof val === 'string') return val;
    }
    // Fallback: scan any string value for dangerous command keywords
    for (const val of Object.values(args)) {
        if (typeof val === 'string' && (val.includes('rm ') || val.includes('sudo') || val.includes('chmod'))) {
            return val;
        }
    }
    return null;
}

/** Extract file path from tool arguments */
function extractFilePath(args: Record<string, unknown>): string | undefined {
    for (const key of ['path', 'file_path', 'filePath', 'filename', 'file']) {
        const val = args[key];
        if (typeof val === 'string') return val;
    }
    return undefined;
}

/** Extract content body from tool arguments */
function extractContent(args: Record<string, unknown>): string | undefined {
    for (const key of ['content', 'new_text', 'data', 'text', 'patch', 'body']) {
        const val = args[key];
        if (typeof val === 'string') return val;
    }
    return undefined;
}

/**
 * Check hard safety invariants for a tool call.
 * @param toolName - Name of the tool being invoked
 * @param args - Tool arguments
 * @param _context - Optional execution context (reserved for future use)
 * @returns InvariantResult — pass=true means execution may proceed
 */
export function checkInvariants(
    toolName: string,
    args: Record<string, unknown>,
    _context?: Record<string, unknown>,
): InvariantResult {
    // Command-line invariants
    const commandLike = extractCommandLike(args);
    if (commandLike) {
        const rmPattern = /\brm\s+(?:-[a-zA-Z]*[rfRF][a-zA-Z]*\s+)*\/(?![a-zA-Z0-9_])/;
        const rmEndPattern = /\brm\s+(?:-[a-zA-Z]*[rfRF][a-zA-Z]*\s+)*\/\s*$/;
        if (rmPattern.test(commandLike) || rmEndPattern.test(commandLike)) {
            return { pass: false, reason: 'Blocked destructive command: rm -rf /' };
        }

        if (/\bsudo\b/.test(commandLike)) {
            return { pass: false, reason: 'Blocked privileged command: sudo' };
        }

        if (/\bchmod\s+777\b/.test(commandLike)) {
            return { pass: false, reason: 'Blocked overly permissive command: chmod 777' };
        }
    }

    // Filesystem invariants
    const filePath = extractFilePath(args);

    // Block empty writes to existing files
    if (filePath && MUTATING_TOOLS.has(toolName)) {
        const content = extractContent(args);
        if (content !== undefined && content.trim() === '' && existsSync(filePath)) {
            return { pass: false, reason: `Blocked empty write to existing file: ${filePath}` };
        }
    }

    // Block reading .env files
    if (filePath && /\.env(\.|\b|$)/.test(filePath)) {
        return { pass: false, reason: `Blocked access to sensitive file: ${filePath}` };
    }

    return { pass: true };
}
