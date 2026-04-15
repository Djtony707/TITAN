/**
 * TITAN — Filesystem Skill (Built-in)
 * Read, write, edit, and list files and directories.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { registerSkill } from '../registry.js';

/** S4: Block access to sensitive system paths */
const BLOCKED_PATHS = ['/etc', '/root', '/sys', '/proc', '/dev', '/boot', '/var/log', '/var/run'];
const BLOCKED_PATTERNS = ['.ssh', '.gnupg', '.aws', '.env', 'id_rsa', 'id_ed25519', '.netrc', '.npmrc'];

/** Expand ~ and resolve to absolute path */
function expandPath(filePath: string): string {
    const expanded = filePath.startsWith('~/') ? join(homedir(), filePath.slice(2)) : filePath;
    return resolve(expanded);
}

/**
 * Hunt Finding #32 (2026-04-14): helper to check if `child` is the same as
 * or contained within `parent` on the filesystem, WITHOUT the `startsWith`
 * trap. A naive `child.startsWith(parent)` returns true for siblings that
 * share a prefix (e.g. `/tmpfoo` starts with `/tmp`, `/home/djacob` starts
 * with `/home/dj`). We require either exact match or a path-separator
 * boundary after `parent`.
 */
export function isWithinDir(child: string, parent: string): boolean {
    if (child === parent) return true;
    // Ensure trailing separator on parent so /tmpfoo doesn't match /tmp
    const parentWithSep = parent.endsWith('/') ? parent : parent + '/';
    return child.startsWith(parentWithSep);
}

export function validatePath(filePath: string): string | null {
    const resolved = expandPath(filePath);
    const home = homedir();
    // Allow access within home directory and /tmp only.
    // Hunt Finding #32: must check path-separator boundary, not raw startsWith.
    if (!isWithinDir(resolved, home) && !isWithinDir(resolved, '/tmp')) {
        return `Access denied: path must be within home directory or /tmp`;
    }
    // Block sensitive paths even within home
    for (const pattern of BLOCKED_PATTERNS) {
        if (resolved.includes(pattern)) {
            return `Access denied: cannot access ${pattern} files`;
        }
    }
    // Block system directories
    for (const blocked of BLOCKED_PATHS) {
        if (isWithinDir(resolved, blocked)) {
            return `Access denied: cannot access system directory ${blocked}`;
        }
    }
    return null; // valid
}

export function registerFilesystemSkill(): void {
    // Read File
    registerSkill(
        { name: 'read_file', description: 'Read file contents', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'read_file',
            description: 'Read the contents of a file and return it with line numbers.\n\nUSE THIS WHEN Tony says: "read X" / "show me X file" / "what\'s in X" / "open X" / "check X file" / "look at X"\n\nRULES:\n- ALWAYS call read_file before editing — never edit blind\n- Use startLine/endLine for large files to read specific sections\n- Returns line numbers — use these when calling edit_file',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or relative path to the file' },
                    startLine: { type: 'number', description: 'Start line (1-indexed, optional)' },
                    endLine: { type: 'number', description: 'End line (1-indexed, optional)' },
                },
                required: ['path'],
            },
            execute: async (args) => {
                const filePath = expandPath(args.path as string);
                const pathErr = validatePath(filePath);
                if (pathErr) return pathErr;
                if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
                try {
                    const content = readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    const start = (args.startLine as number) || 1;
                    const end = (args.endLine as number) || lines.length;
                    const selected = lines.slice(start - 1, end);
                    return `File: ${filePath} (${lines.length} lines)\n---\n${selected.map((l, i) => `${start + i}: ${l}`).join('\n')}`;
                } catch (e) { return `Error reading file: ${(e as Error).message}`; }
            },
        },
    );

    // Write File
    registerSkill(
        { name: 'write_file', description: 'Write/create a file', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'write_file',
            description: 'Write content to a file, creating it (and any parent directories) if needed. Overwrites existing content.\n\nUSE THIS WHEN Tony says: "create file X" / "write X to a file" / "save this to X" / "make a file called X" / "create X with this content"\n\nRULES:\n- NEVER output file content as plain text when Tony asks to write a file — call write_file instead\n- For modifying an existing file, prefer read_file first then edit_file\n- Use write_file for new files or full rewrites',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the file' },
                    content: { type: 'string', description: 'Content to write' },
                },
                required: ['path', 'content'],
            },
            execute: async (args) => {
                const filePath = expandPath(args.path as string);
                const pathErr = validatePath(filePath);
                if (pathErr) return pathErr;
                try {
                    const dir = join(filePath, '..');
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                    const newContent = args.content as string;
                    // Guard: prevent destructive overwrites of existing files
                    if (existsSync(filePath)) {
                        const existing = readFileSync(filePath, 'utf-8');
                        const existingLines = existing.split('\n').length;
                        const newLines = newContent.split('\n').length;
                        // If file exists and new content is <40% of original size, block it
                        if (existingLines > 20 && newLines < existingLines * 0.4) {
                            return `Error: write_file would replace ${existingLines} lines with only ${newLines} lines (${Math.round(newLines / existingLines * 100)}% of original). This looks destructive. Use edit_file to make surgical changes instead of rewriting the entire file.`;
                        }
                        if (existingLines > 20 && newLines > existingLines * 3) {
                            return `Error: write_file would expand ${existingLines} lines to ${newLines} lines (${Math.round(newLines / existingLines * 100)}% of original). This looks like accidental file duplication. Use edit_file to make targeted changes instead of rewriting the entire file.`;
                        }
                    }
                    writeFileSync(filePath, newContent, 'utf-8');
                    return `Successfully wrote ${newContent.length} bytes to ${filePath}`;
                } catch (e) { return `Error writing file: ${(e as Error).message}`; }
            },
        },
    );

    // Append to File
    registerSkill(
        { name: 'append_file', description: 'Append content to end of a file', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'append_file',
            description: 'Append content to the end of an existing file (or create if it does not exist).\n\nUSE THIS WHEN: You need to add content to a file without overwriting it. Perfect for building files incrementally — add sections one at a time instead of writing the entire file at once.\n\nRULES:\n- Use this for large files: write the initial structure with write_file, then append_file for each section\n- Great for HTML: write_file the head/opening tags, then append_file each section, then append_file the closing tags',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the file' },
                    content: { type: 'string', description: 'Content to append' },
                },
                required: ['path', 'content'],
            },
            execute: async (args) => {
                const filePath = expandPath(args.path as string);
                const pathErr = validatePath(filePath);
                if (pathErr) return pathErr;
                try {
                    const { appendFileSync } = await import('fs');
                    const dir = join(filePath, '..');
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                    appendFileSync(filePath, args.content as string, 'utf-8');
                    return `Successfully appended ${(args.content as string).length} bytes to ${filePath}`;
                } catch (e) { return `Error appending to file: ${(e as Error).message}`; }
            },
        },
    );

    // Edit File
    registerSkill(
        { name: 'edit_file', description: 'Search and replace in a file', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'edit_file',
            description: 'Edit a file by replacing an exact string with new content (search-and-replace).\n\nUSE THIS WHEN Tony says: "edit X" / "change X in the file" / "update X to Y" / "fix X in the file" / "modify X"\n\nWORKFLOW:\n1. ALWAYS call read_file first to see the current content\n2. Copy the exact string to replace as the "target" (must match exactly)\n3. Provide the replacement content\n\nRULES:\n- Target string must match exactly — copy from read_file output\n- For full rewrites, use write_file instead',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the file' },
                    target: { type: 'string', description: 'Exact string to find and replace' },
                    replacement: { type: 'string', description: 'Replacement content' },
                },
                required: ['path', 'target', 'replacement'],
            },
            execute: async (args) => {
                const filePath = expandPath(args.path as string);
                const pathErr2 = validatePath(filePath);
                if (pathErr2) return pathErr2;
                if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
                try {
                    let content = readFileSync(filePath, 'utf-8');
                    const target = args.target as string;
                    if (!content.includes(target)) {
                        // Fuzzy matching: try to find the closest matching block
                        const _targetLines = target.split('\n').map((l: string) => l.trim()).filter(Boolean);
                        const contentLines = content.split('\n');

                        // Try normalized whitespace match first
                        const normalizedTarget = target.replace(/\s+/g, ' ').trim();
                        const normalizedContent = content.replace(/\s+/g, ' ').trim();
                        if (normalizedContent.includes(normalizedTarget)) {
                            // Whitespace-only difference — find and replace with original whitespace context
                            const targetChunks = target.split('\n');
                            const firstLine = targetChunks[0].trim();
                            const lastLine = targetChunks[targetChunks.length - 1].trim();
                            let startIdx = -1, endIdx = -1;
                            for (let i = 0; i < contentLines.length; i++) {
                                if (contentLines[i].trim() === firstLine) { startIdx = i; break; }
                            }
                            if (startIdx >= 0) {
                                for (let i = startIdx; i < contentLines.length; i++) {
                                    if (contentLines[i].trim() === lastLine) { endIdx = i; break; }
                                }
                            }
                            if (startIdx >= 0 && endIdx >= 0) {
                                const before = contentLines.slice(0, startIdx).join('\n');
                                const after = contentLines.slice(endIdx + 1).join('\n');
                                content = before + (before ? '\n' : '') + (args.replacement as string) + (after ? '\n' : '') + after;
                                writeFileSync(filePath, content, 'utf-8');
                                return `Successfully edited ${filePath} (fuzzy whitespace match applied)`;
                            }
                        }

                        // Line-by-line similarity: find best matching region
                        const targetWords = target.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
                        let bestLine = -1, bestScore = 0;
                        for (let i = 0; i < contentLines.length; i++) {
                            const score = targetWords.filter((w: string) => contentLines[i].toLowerCase().includes(w)).length;
                            if (score > bestScore) { bestScore = score; bestLine = i; }
                        }
                        const nearby = bestLine >= 0
                            ? contentLines.slice(Math.max(0, bestLine - 3), bestLine + 4).map((l: string, i: number) => `  ${Math.max(1, bestLine - 2) + i}: ${l}`).join('\n')
                            : contentLines.slice(0, 10).map((l: string, i: number) => `  ${i + 1}: ${l}`).join('\n');
                        return `Error: Target string not found in ${filePath}. The target must match EXACTLY (including whitespace/indentation). Closest match area:\n${nearby}\n\nTIP: Use read_file with startLine/endLine to get the exact text, then copy it precisely as the target.`;
                    }
                    content = content.split(target).join(args.replacement as string);
                    writeFileSync(filePath, content, 'utf-8');
                    return `Successfully edited ${filePath}`;
                } catch (e) { return `Error editing file: ${(e as Error).message}`; }
            },
        },
    );

    // List Directory
    registerSkill(
        { name: 'list_dir', description: 'List directory contents', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'list_dir',
            description: 'List the contents of a directory, showing files and subdirectories with file sizes.\n\nUSE THIS WHEN Tony says: "list files in X" / "what\'s in the X folder" / "show me X directory" / "ls X" / "what files are in X"\n\nNOTE: Set recursive:true to list subdirectories too (use with care on large directories).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the directory' },
                    recursive: { type: 'boolean', description: 'List recursively (default: false)' },
                },
                required: ['path'],
            },
            execute: async (args) => {
                const dirPath = expandPath(args.path as string);
                const dirErr = validatePath(dirPath);
                if (dirErr) return dirErr;
                if (!existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;
                try {
                    const entries = readdirSync(dirPath, { withFileTypes: true });
                    const lines = entries.map((entry) => {
                        const fullPath = join(dirPath, entry.name);
                        if (entry.isDirectory()) {
                            return `📁 ${entry.name}/`;
                        }
                        const stat = statSync(fullPath);
                        const size = stat.size < 1024 ? `${stat.size}B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)}KB` : `${(stat.size / 1048576).toFixed(1)}MB`;
                        return `📄 ${entry.name} (${size})`;
                    });
                    return `Directory: ${dirPath}\n${lines.join('\n')}`;
                } catch (e) { return `Error listing directory: ${(e as Error).message}`; }
            },
        },
    );

    // List Uploaded Files
    registerSkill(
        { name: 'list_uploads', description: 'List uploaded files for a session', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'list_uploads',
            description: 'List files uploaded by the user in the current session.\n\nUSE THIS WHEN user mentions "my file", "the file I uploaded", "uploaded document", or wants to work with an attachment.',
            parameters: {
                type: 'object',
                properties: {
                    session: { type: 'string', description: 'Session ID (defaults to "default")' },
                },
            },
            execute: async (args) => {
                const uploadsDir = join(homedir(), '.titan', 'uploads', (args.session as string) || 'default');
                if (!existsSync(uploadsDir)) return 'No files uploaded yet in this session.';
                try {
                    const entries = readdirSync(uploadsDir);
                    if (entries.length === 0) return 'No files uploaded yet in this session.';
                    const lines = entries.map(name => {
                        const stat = statSync(join(uploadsDir, name));
                        const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
                        return `📎 ${name} (${size})`;
                    });
                    return `Uploaded files:\n${lines.join('\n')}`;
                } catch (e) { return `Error: ${(e as Error).message}`; }
            },
        },
    );

    // Read Uploaded File
    registerSkill(
        { name: 'read_upload', description: 'Read an uploaded file', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'read_upload',
            description: 'Read the contents of a file uploaded by the user.\n\nUSE THIS WHEN user asks about the contents of a file they uploaded, or says "read my file", "what does the file say", "analyze this document".\n\nSupports: text, CSV, JSON, and other text-based formats. For binary files (PDF, images), returns metadata.',
            parameters: {
                type: 'object',
                properties: {
                    filename: { type: 'string', description: 'Name of the uploaded file' },
                    session: { type: 'string', description: 'Session ID (defaults to "default")' },
                },
                required: ['filename'],
            },
            execute: async (args) => {
                const uploadsDir = join(homedir(), '.titan', 'uploads', (args.session as string) || 'default');
                const filePath = join(uploadsDir, (args.filename as string).replace(/[^a-zA-Z0-9._-]/g, '_'));

                if (!filePath.startsWith(uploadsDir)) return 'Access denied';
                if (!existsSync(filePath)) return `File not found: ${args.filename}`;

                const stat = statSync(filePath);
                const ext = (args.filename as string).split('.').pop()?.toLowerCase() || '';
                const textExts = ['txt', 'md', 'csv', 'json', 'xml', 'html', 'js', 'ts', 'py', 'yaml', 'yml', 'toml', 'ini', 'log', 'sql', 'sh', 'env'];

                if (textExts.includes(ext) || stat.size < 100000) {
                    try {
                        const content = readFileSync(filePath, 'utf-8');
                        if (content.length > 50000) {
                            return `File: ${args.filename} (${(stat.size / 1024).toFixed(1)}KB)\n---\n${content.slice(0, 50000)}\n\n... [truncated, ${content.length} chars total]`;
                        }
                        return `File: ${args.filename} (${(stat.size / 1024).toFixed(1)}KB)\n---\n${content}`;
                    } catch {
                        return `Binary file: ${args.filename} (${(stat.size / 1024).toFixed(1)}KB, .${ext}). Cannot display as text.`;
                    }
                }
                return `Binary file: ${args.filename} (${(stat.size / 1024).toFixed(1)}KB, .${ext}). Use a specialized tool to process this file type.`;
            },
        },
    );
}
