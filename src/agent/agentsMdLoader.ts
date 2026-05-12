/**
 * TITAN — Hierarchical AGENTS.md loader.
 *
 * Why this exists
 * ---------------
 * Project-local agent instructions live in AGENTS.md files distributed
 * through the source tree. The convention is shared with Claude Code,
 * Cursor, OpenCode, and Codex CLI — any project the user already has
 * AGENTS.md files for "just works" inside TITAN.
 *
 * The agents.md spec (https://agents.md) calls it "closest file wins":
 * the agent walks UP from the file it's working on, collecting every
 * AGENTS.md from the project root down to the nearest one. They concat
 * in root-first order so the most-specific one lands at the recency
 * position in the prompt (U-shaped attention).
 *
 * Space Agent's L0/L1/L2 framing is the same idea — L0 = project root,
 * L1 = subdirectory, L2 = file-local (TBD; this module handles L0 + L1
 * cleanly, file-frontmatter L2 is a future addition).
 *
 * The HumanLayer "Skill Issue: Harness Engineering for Coding Agents"
 * post warns that AGENTS.md files past ~60 lines hurt more than they
 * help. We enforce this cap defensively: long files get truncated at
 * load time with a marker so a long file can't crowd out everything
 * else in the system prompt budget.
 *
 * Reference:
 *   - https://agents.md (closest-file-wins spec)
 *   - https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents
 *   - awesome-agent-harness "AGENTS.md — repo-local agent directives"
 *   - Space Agent L0/L1/L2 hierarchical instructions
 *
 * Out of scope (this slice, per `incremental-implementation` skill):
 *   - Per-file frontmatter (L2) — would need YAML parsing inside source
 *     files; deferred until the L0/L1 path is proven in prod.
 *   - Hot reload — TITAN's existing `getCachedPromptFile` is per-process
 *     stable; that's the right scope here.
 */
import { existsSync, statSync, readFileSync, readdirSync } from 'fs';
import { resolve, dirname, join, relative, sep } from 'path';

/** One file loaded by the hierarchy walker. */
export interface AgentsFile {
    /** Absolute path of the loaded file. */
    path: string;
    /** Possibly-truncated content. */
    content: string;
    /** Depth relative to rootPath. 0 = project root, 1 = first subdir, ... */
    depth: number;
    /** True if the file was truncated (line cap, byte cap, or aggregate cap). */
    truncated: boolean;
}

/** Result of a hierarchy walk. */
export interface AgentsHierarchyResult {
    files: AgentsFile[];
    totalLines: number;
    /** True if ANY file or the aggregate budget was truncated. */
    truncated: boolean;
}

/** Options for {@link loadAgentsHierarchy}. */
export interface LoadAgentsOptions {
    /** Project root. Walk never goes above this directory. */
    rootPath: string;
    /**
     * Anchor for the closest-file walk. When set, we walk UP from this
     * path collecting every AGENTS.md from rootPath down to here.
     * When NOT set, we do a shallow scan: rootPath + immediate subdirs.
     */
    targetPath?: string;
    /** Per-file line cap. HumanLayer's recommendation is 60. 0 disables. */
    maxLinesPerFile?: number;
    /** Per-file byte cap before we skip a file entirely. Default 100 KB. */
    maxBytesPerFile?: number;
    /** Aggregate byte budget. Truncates additional files once hit. Default 32 KB. */
    maxTotalBytes?: number;
}

const DEFAULT_OPTIONS: Required<Omit<LoadAgentsOptions, 'rootPath' | 'targetPath'>> = {
    maxLinesPerFile: 60,
    maxBytesPerFile: 100_000,
    maxTotalBytes: 32_000,
};

const AGENTS_FILENAME = 'AGENTS.md';

/**
 * Resolve a path relative to root, returning a SAFE absolute path or null
 * if the input escapes the root (path-traversal guard).
 */
function safeWithinRoot(rootAbs: string, p: string): string | null {
    try {
        const resolved = resolve(p);
        if (resolved === rootAbs) return resolved;
        // Ensure resolved is a subpath of rootAbs by checking the path-segment boundary.
        const rel = relative(rootAbs, resolved);
        if (rel.startsWith('..') || resolve(rootAbs, rel) !== resolved) return null;
        return resolved;
    } catch {
        return null;
    }
}

/** Apply per-file line + byte caps. Returns the modified file plus a truncation flag. */
function capFile(path: string, raw: string, opts: Required<Omit<LoadAgentsOptions, 'rootPath' | 'targetPath'>>): { content: string; truncated: boolean } {
    if (raw.length > opts.maxBytesPerFile) {
        return {
            content: `[AGENTS.md at ${path} skipped — too large (${raw.length} bytes, cap ${opts.maxBytesPerFile})]`,
            truncated: true,
        };
    }
    if (opts.maxLinesPerFile === 0) return { content: raw, truncated: false };
    const lines = raw.split('\n');
    if (lines.length <= opts.maxLinesPerFile) return { content: raw, truncated: false };
    const cut = lines.slice(0, opts.maxLinesPerFile).join('\n');
    return {
        content: `${cut}\n\n[file truncated at ${opts.maxLinesPerFile} lines — full file is ${lines.length} lines]`,
        truncated: true,
    };
}

/**
 * Collect every AGENTS.md file along a path from rootPath UP to targetPath
 * (the closest-file walk), or shallow-scan rootPath + immediate subdirs.
 *
 * Apply per-file line and byte caps. If the aggregate budget is hit, stop
 * adding files and mark the result truncated.
 *
 * Pure-ish: only reads filesystem. Never executes content. Path-traversal
 * guarded — files outside rootPath are silently skipped.
 */
export function loadAgentsHierarchy(opts: LoadAgentsOptions): AgentsHierarchyResult {
    const o = { ...DEFAULT_OPTIONS, ...opts };
    const rootAbs = (() => { try { return resolve(opts.rootPath); } catch { return null; } })();
    if (!rootAbs || !existsSync(rootAbs)) {
        return { files: [], totalLines: 0, truncated: false };
    }

    // Collect candidate directories to check, in root-first order.
    const dirs: string[] = [];
    if (opts.targetPath) {
        const targetAbs = safeWithinRoot(rootAbs, opts.targetPath);
        if (targetAbs) {
            // Walk from root down to target's directory, depth by depth.
            const targetDir = (() => {
                try { return statSync(targetAbs).isDirectory() ? targetAbs : dirname(targetAbs); }
                catch { return dirname(targetAbs); }
            })();
            // Build the path stack from root → targetDir.
            const rel = relative(rootAbs, targetDir);
            const segments = rel === '' ? [] : rel.split(sep);
            let cursor = rootAbs;
            dirs.push(cursor);
            for (const seg of segments) {
                cursor = join(cursor, seg);
                dirs.push(cursor);
            }
        } else {
            // Target was outside root — fall back to root-only.
            dirs.push(rootAbs);
        }
    } else {
        // No target: shallow scan — root + one level of subdirs.
        dirs.push(rootAbs);
        try {
            for (const entry of readdirSync(rootAbs, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    dirs.push(join(rootAbs, entry.name));
                }
            }
        } catch { /* unreadable root — return root-only */ }
    }

    const files: AgentsFile[] = [];
    let totalBytes = 0;
    let totalTruncated = false;

    for (const dir of dirs) {
        const candidate = join(dir, AGENTS_FILENAME);
        if (!existsSync(candidate)) continue;
        try {
            const stat = statSync(candidate);
            if (!stat.isFile()) continue;
            // Aggregate-budget gate before reading.
            if (totalBytes >= o.maxTotalBytes) {
                totalTruncated = true;
                break;
            }
            const raw = readFileSync(candidate, 'utf-8');
            const capped = capFile(candidate, raw, o);
            // Per-aggregate budget check after capping but before adding.
            const room = o.maxTotalBytes - totalBytes;
            let finalContent = capped.content;
            let truncated = capped.truncated;
            if (finalContent.length > room) {
                // Reserve room for the marker so the final entry stays within budget.
                // Marker length is computed (not hard-coded 60) because em-dashes
                // and similar characters confuse manual counting — drop-an-off-by-5
                // bug fixed 2026-05-10.
                const marker = `\n\n[aggregate AGENTS.md budget exhausted — remaining files skipped]`;
                const sliceLen = Math.max(0, room - marker.length);
                finalContent = finalContent.slice(0, sliceLen) + marker;
                truncated = true;
                totalTruncated = true;
            }
            const rel = relative(rootAbs, dir);
            const depth = rel === '' ? 0 : rel.split(sep).length;
            files.push({ path: candidate, content: finalContent, depth, truncated });
            totalBytes += finalContent.length;
            if (totalTruncated) break;
        } catch { /* skip unreadable file */ }
    }

    const totalLines = files.reduce((n, f) => n + f.content.split('\n').length, 0);
    return { files, totalLines, truncated: totalTruncated || files.some(f => f.truncated) };
}

/**
 * Format the hierarchy result as a single system-prompt block with
 * provenance headers per file. Empty string when no files were loaded.
 */
export function formatAgentsHierarchyForPrompt(result: AgentsHierarchyResult, rootPath: string): string {
    if (result.files.length === 0) return '';
    const rootAbs = resolve(rootPath);
    const blocks = result.files.map((f) => {
        const rel = relative(rootAbs, f.path) || 'AGENTS.md';
        return `### AGENTS.md — ${rel}\n${f.content}`;
    });
    return `## Project-local Agent Instructions (hierarchical AGENTS.md)\n\n${blocks.join('\n\n')}`;
}
