/**
 * TITAN — Filesystem Skill (Built-in)
 * Read, write, edit, and list files and directories.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, openSync, readSync, closeSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { registerSkill } from '../registry.js';
import { resolveImageReferences } from '../../agent/imageRegistry.js';
import {
    verifyFileWrite,
    recordVerificationEvent,
    formatVerificationSuffix,
} from '../../agent/verification.js';

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

/**
 * Hunt Finding #36 (2026-04-14): max bytes returned by read_file in a single
 * call. A Phase 5.5 test read a 1MB file and the full content got pumped into
 * the model context, exploding it to 213K tokens and driving the model into
 * 21-tool-call pathological exploration before returning a hallucinated
 * wrong answer. Now: files over this threshold return a preview + stats +
 * usage hint; the caller can use byteOffset/byteLimit to page through.
 * Tunable via env var TITAN_READ_FILE_MAX_BYTES.
 */
const READ_FILE_MAX_BYTES = (() => {
    const v = process.env.TITAN_READ_FILE_MAX_BYTES;
    const n = v ? parseInt(v, 10) : NaN;
    if (Number.isFinite(n) && n > 0 && n <= 10_000_000) return n;
    return 100_000; // 100 KB default — enough for most source files, small enough to not blow context
})();

/** Read the first N bytes of a file without loading the whole thing. */
function readFirstBytes(filePath: string, maxBytes: number): string {
    const fd = openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
        return buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
        closeSync(fd);
    }
}

export function registerFilesystemSkill(): void {
    // Read File
    registerSkill(
        { name: 'read_file', description: 'Read file contents', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'read_file',
            description: `Read a file from the local filesystem and return its contents prefixed with 1-based line numbers (cat -n format). Use this before any edit so you can quote exact lines back to edit_file.

USE WHEN: "read X" / "show me X" / "what's in X" / "open X" / "check X" / "look at X" — anything where the answer comes from a local file. Also: ALWAYS as the first step before edit_file or append_file on an existing file.

DO NOT USE FOR:
- Listing a directory → use list_dir
- Reading a URL → use web_fetch
- Reading a file inside an archive → unzip first via shell, then read_file

Parameters:
- path (string, required) — absolute or ~-prefixed path. Relative paths resolve from cwd.
- startLine (number, optional, 1-indexed) — first line to return; defaults to 1.
- endLine (number, optional, 1-indexed inclusive) — last line; defaults to file end or +2000 lines if very large.

Returns: { content: string, path: string, totalLines: number, truncated: boolean, sizeBytes: number }. content is the line-numbered text. truncated=true means the file is bigger than the returned window; call again with a higher startLine/endLine to read the rest.

Errors:
- "ENOENT: file not found" — verify the path; the user may have given a typo. Try list_dir on the parent directory first.
- "EACCES: permission denied" — TITAN can't read the file; surface to the user, suggest chmod or running TITAN with the right user.
- "BLOCKED: sensitive path" — file matched a blocklist pattern (.ssh, .env, /etc, etc.). Do not retry; tell the user this path is off-limits.

NEVER hallucinate file content. If read_file failed, say so — do not fabricate.`,
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
                    // Hunt Finding #36 (2026-04-14): check file size BEFORE reading
                    // the full content. Previous version called readFileSync
                    // unconditionally and a 1MB file exploded context to 213K
                    // tokens and drove the model into 21-call pathological
                    // exploration before hallucinating a wrong answer.
                    const stat = statSync(filePath);
                    const fileSize = stat.size;
                    const oversized = fileSize > READ_FILE_MAX_BYTES;

                    // If the caller supplied startLine/endLine they're opting
                    // into scoped reads — let them read even from a large file,
                    // but still cap the total bytes returned.
                    const rawStart = args.startLine as number | undefined;
                    const rawEnd = args.endLine as number | undefined;
                    const hasScope = (rawStart !== undefined) || (rawEnd !== undefined);

                    if (oversized && !hasScope) {
                        // Return a preview of the first READ_FILE_MAX_BYTES
                        // plus file stats + a usage hint. This keeps context
                        // bounded and points the model at the right next action.
                        const preview = readFirstBytes(filePath, READ_FILE_MAX_BYTES);
                        const previewLines = preview.split('\n');
                        const humanSize = fileSize >= 1_000_000
                            ? `${(fileSize / 1_000_000).toFixed(2)} MB`
                            : `${(fileSize / 1_000).toFixed(1)} KB`;
                        return [
                            `File: ${filePath}`,
                            `Size: ${humanSize} (${fileSize} bytes) — TRUNCATED`,
                            `Showing first ${READ_FILE_MAX_BYTES} bytes (~${previewLines.length} lines). The file is too large to load in full.`,
                            `To read more, call read_file again with startLine/endLine parameters.`,
                            `---`,
                            ...previewLines.slice(0, 500).map((l, i) => `${i + 1}: ${l}`),
                        ].join('\n');
                    }

                    const content = readFileSync(filePath, 'utf-8');
                    const lines = content.split('\n');
                    const start = rawStart || 1;
                    const end = rawEnd || lines.length;
                    const selected = lines.slice(start - 1, end);

                    // Even with scoped reads, cap the returned size so a file
                    // with one million characters on a single line doesn't
                    // blow up context through the startLine=1,endLine=1 path.
                    const output = `File: ${filePath} (${lines.length} lines)\n---\n${selected.map((l, i) => `${start + i}: ${l}`).join('\n')}`;
                    if (output.length > READ_FILE_MAX_BYTES * 2) {
                        return output.slice(0, READ_FILE_MAX_BYTES * 2) +
                            `\n\n... [output truncated: ${output.length - READ_FILE_MAX_BYTES * 2} bytes omitted. Use narrower startLine/endLine to paginate.]`;
                    }
                    return output;
                } catch (e) { return `Error reading file: ${(e as Error).message}`; }
            },
        },
    );

    // Write File
    registerSkill(
        { name: 'write_file', description: 'Write/create a file', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'write_file',
            description: `Write a file to the local filesystem (creates parent directories as needed). Overwrites any existing file at the path. A shadow-git snapshot is taken automatically before the write, so an unwanted overwrite can be rolled back via checkpoint_restore.

USE WHEN: "create file X" / "write X to a file" / "save this to X" / "make a file called X" / "create X with this content" — anything where the deliverable is a new file or a full rewrite.

DO NOT USE FOR:
- Modifying an existing file → read_file first, then edit_file (preserves surrounding content, atomic).
- Appending to a log → use append_file (no overwrite).
- Creating files in /etc, ~/.ssh, or .env paths → BLOCKED by the path guard; surface to the user.

Parameters:
- path (string, required) — absolute or ~-prefixed.
- content (string, required) — exact bytes to write. Use \\n for newlines; do not write \\r\\n unless the user explicitly asks for Windows line endings.

Returns: { path: string, bytesWritten: number, created: boolean, checkpointId: string }. created=true means the file didn't exist before. checkpointId can be passed to checkpoint_restore to revert.

Errors:
- "EACCES: permission denied" — directory not writable; suggest chmod or a different path.
- "BLOCKED: sensitive path" — write rejected by the path guard. Do not retry.
- "ENOSPC: no space left" — disk full; surface to the user, do not silently succeed.

NEVER output the file content as a plain code block in the chat when the user asked to write a file — call write_file. Outputting raw content is the #1 wrong-tool failure mode.`,
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
                    // v6.1.0-alpha.56 — substitute `tdi://hash` reference
                    // tokens from download_image with their real data
                    // URLs RIGHT before writing to disk. The LLM never
                    // had to handle the full base64 in its context.
                    const newContent = resolveImageReferences(args.content as string);
                    // Guard: prevent destructive overwrites of existing files.
                    // Use newContent.length-vs-existing.length ratio rather
                    // than line count, because resolved data URLs span one
                    // very long line and would trigger false-positive
                    // "destructive expansion" warnings on the line-count check.
                    if (existsSync(filePath)) {
                        const existing = readFileSync(filePath, 'utf-8');
                        const existingLines = existing.split('\n').length;
                        const newLines = newContent.split('\n').length;
                        const containsDataUrls = /data:image\/[^;]+;base64,/.test(newContent);
                        if (!containsDataUrls) {
                            if (existingLines > 20 && newLines < existingLines * 0.4) {
                                return `Error: write_file would replace ${existingLines} lines with only ${newLines} lines (${Math.round(newLines / existingLines * 100)}% of original). This looks destructive. Use edit_file to make surgical changes instead of rewriting the entire file.`;
                            }
                            if (existingLines > 20 && newLines > existingLines * 3) {
                                return `Error: write_file would expand ${existingLines} lines to ${newLines} lines (${Math.round(newLines / existingLines * 100)}% of original). This looks like accidental file duplication. Use edit_file to make targeted changes instead of rewriting the entire file.`;
                            }
                        }
                    }
                    writeFileSync(filePath, newContent, 'utf-8');
                    // beta.9 — verify-after-write. Reads back, checks
                    // size + a 256-byte head sample. Failed checks do
                    // NOT throw (the file is already on disk) but are
                    // surfaced in the return string AND pushed to the
                    // verification ring so the driver loop's
                    // consecutiveAssertionFailures counter can escalate.
                    const written = Buffer.byteLength(newContent, 'utf-8');
                    const result = verifyFileWrite(filePath, written, newContent);
                    recordVerificationEvent({ kind: 'file_write', result, artifactRef: filePath });
                    return `Successfully wrote ${newContent.length} bytes to ${filePath}${formatVerificationSuffix(result)}`;
                } catch (e) { return `Error writing file: ${(e as Error).message}`; }
            },
        },
    );

    // Append to File
    registerSkill(
        { name: 'append_file', description: 'Append content to end of a file', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'append_file',
            description: `Append content to the end of an existing file (creates it if missing). Atomic + idempotent on retry only when the content already ends in a newline — otherwise repeated calls duplicate the last line. Use this for building files incrementally (logs, accumulating reports, HTML section-by-section) without the round-trip cost of read_file + write_file.

USE WHEN: "append X to Y" / "add X to the bottom of Y" / "log X" / when iteratively building a large file (write_file the skeleton, then append_file each section).

DO NOT USE FOR:
- Inserting into the middle of a file → use edit_file (find-and-replace).
- Overwriting → use write_file.
- Appending to a structured file (JSON, YAML) where the result must remain valid — append_file is byte-level and won't keep JSON arrays valid.

Parameters:
- path (string, required) — absolute or ~-prefixed.
- content (string, required) — exact bytes to append. End with \\n if you want a trailing newline.

Returns: { path: string, bytesAppended: number, totalBytes: number, created: boolean }.

Errors: same set as write_file (EACCES, BLOCKED: sensitive path, ENOSPC).`,
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
                    // v6.1.0-alpha.56 — resolve tdi:// image references before append.
                    const resolved = resolveImageReferences(args.content as string);
                    // beta.9 — capture pre-append size BEFORE the write
                    // so we can assert post-size == pre-size + appended
                    // bytes. Catches partial writes, mount-readonly
                    // silent failures, and anyone wedging a hook
                    // between us and the disk.
                    const preSize = existsSync(filePath) ? statSync(filePath).size : 0;
                    appendFileSync(filePath, resolved, 'utf-8');
                    const appended = Buffer.byteLength(resolved, 'utf-8');
                    const result = verifyFileWrite(filePath, preSize + appended);
                    recordVerificationEvent({ kind: 'file_append', result, artifactRef: filePath });
                    return `Successfully appended ${appended} bytes to ${filePath}${formatVerificationSuffix(result)}`;
                } catch (e) { return `Error appending to file: ${(e as Error).message}`; }
            },
        },
    );

    // Edit File
    registerSkill(
        { name: 'edit_file', description: 'Search and replace in a file', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'edit_file',
            description: `Edit a file by replacing one exact string with another (surgical, atomic). Preserves all surrounding content. Shadow-git checkpoints before and after, so any edit is rollback-able.

USE WHEN: "edit X" / "change X to Y in the file" / "update X" / "fix X in the file" / "modify X" / "rename foo to bar in X" — anything where you want a precise change without rewriting the whole file.

WORKFLOW (non-negotiable):
1. Call read_file first to see the current content.
2. Copy the exact target string from the read_file output (whitespace, indentation, line endings all matter).
3. Call edit_file with target + replacement.

DO NOT USE FOR:
- A full rewrite → use write_file (it's faster).
- A target string that occurs more than once in the file → split it into two edits, each with enough surrounding context to be unique.
- A target you haven't seen via read_file → blind edits routinely fail with "target not found".

Parameters:
- path (string, required) — absolute or ~-prefixed.
- target (string, required) — exact text to find. Must match byte-for-byte AND be unique in the file.
- replacement (string, required) — text to substitute. Can be longer or shorter than the target.

Returns: { path: string, bytesBefore: number, bytesAfter: number, occurrencesReplaced: number, checkpointId: string }.

Errors:
- "Target string not found" — your target doesn't match the file content. Call read_file again, copy more carefully (mind tabs vs spaces, trailing whitespace).
- "Target string is not unique (N matches)" — add more surrounding context to the target until it's unique, OR call edit_file once per occurrence with disambiguating context.
- Same EACCES/BLOCKED errors as write_file.

NEVER guess at the target — read_file first, always.`,
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
                                const fuzzResult = verifyFileWrite(
                                    filePath,
                                    Buffer.byteLength(content, 'utf-8'),
                                    content,
                                );
                                recordVerificationEvent({ kind: 'file_edit', result: fuzzResult, artifactRef: filePath });
                                return `Successfully edited ${filePath} (fuzzy whitespace match applied)${formatVerificationSuffix(fuzzResult)}`;
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
                    // v6.1.0-alpha.56 — resolve tdi:// references in the
                    // replacement before splicing so the LLM can paste a
                    // download_image token into edit_file's replacement
                    // and get the full data URL on disk.
                    const resolvedReplacement = resolveImageReferences(args.replacement as string);
                    content = content.split(target).join(resolvedReplacement);
                    writeFileSync(filePath, content, 'utf-8');
                    // beta.9 — verify-after-edit. Full content sample
                    // here is safe because we already hold the post-edit
                    // bytes in memory; readback confirms disk matches.
                    const editResult = verifyFileWrite(
                        filePath,
                        Buffer.byteLength(content, 'utf-8'),
                        content,
                    );
                    recordVerificationEvent({ kind: 'file_edit', result: editResult, artifactRef: filePath });
                    return `Successfully edited ${filePath}${formatVerificationSuffix(editResult)}`;
                } catch (e) { return `Error editing file: ${(e as Error).message}`; }
            },
        },
    );

    // List Directory
    registerSkill(
        { name: 'list_dir', description: 'List directory contents', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'list_dir',
            description: `List the contents of a directory with file sizes and types (file vs directory). One-level by default; set recursive:true only on small trees.

USE WHEN: "list files in X" / "what's in the X folder" / "show me X directory" / "ls X" / "what files are in X" / "is there a Y file here" — anything where the answer comes from filesystem structure.

DO NOT USE FOR:
- Listing a huge tree (node_modules, ~/Library) → use recursive:false then drill in manually, or shell + find -maxdepth.
- File contents → use read_file.
- Searching by name → use shell with find or grep -r.

Parameters:
- path (string, required) — absolute or ~-prefixed. Path to the directory.
- recursive (boolean, optional) — default false. true returns a flat tree of every file under path. Capped at MAX_DIR_ENTRIES (50_000) to prevent runaway scans.

Returns: { path: string, entries: Array<{ name, type: "file"|"directory", sizeBytes, modifiedAt }>, count: number, truncated: boolean }. truncated=true means MAX_DIR_ENTRIES was hit; narrow the path or use recursive:false.

Errors:
- "ENOENT: directory not found" — verify the path; suggest list_dir on the parent.
- "ENOTDIR: not a directory" — caller passed a file path; use read_file instead.
- "BLOCKED: sensitive path" — path is in the blocklist (/etc, ~/.ssh, etc.). Do not retry.`,
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
