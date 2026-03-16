/**
 * TITAN — Filesystem Skill (Built-in)
 * Read, write, edit, and list files and directories.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { registerSkill } from '../registry.js';

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
                const filePath = resolve(args.path as string);
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
                const filePath = resolve(args.path as string);
                try {
                    const dir = join(filePath, '..');
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                    writeFileSync(filePath, args.content as string, 'utf-8');
                    return `Successfully wrote ${(args.content as string).length} bytes to ${filePath}`;
                } catch (e) { return `Error writing file: ${(e as Error).message}`; }
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
                const filePath = resolve(args.path as string);
                if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
                try {
                    let content = readFileSync(filePath, 'utf-8');
                    const target = args.target as string;
                    if (!content.includes(target)) return `Error: Target string not found in ${filePath}`;
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
                const dirPath = resolve(args.path as string);
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
}
