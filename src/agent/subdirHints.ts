/**
 * TITAN — Subdirectory Hint Tracker
 *
 * Ported from Hermes `agent/subdirectory_hints.py` (which itself was adapted
 * from Block/Goose's SubdirectoryHintTracker).
 *
 * Problem it solves:
 *   The system prompt loads TITAN.md / AGENTS.md / SOUL.md / TOOLS.md from
 *   the CWD at session start. But agents working in a specific subdirectory
 *   don't see that subdirectory's local conventions — e.g. an agent editing
 *   `/opt/TITAN/src/safety/` doesn't automatically see `src/safety/AGENTS.md`
 *   saying "oscillation thresholds live in killSwitch.ts; never edit
 *   fixOscillation without reading plan-this-logical-ocean first."
 *
 * Approach:
 *   - As tool calls fire (read_file, write_file, edit_file, list_dir, shell
 *     with a path arg, etc.), inspect the path arguments.
 *   - For each unique directory seen, walk up to 5 parent levels looking
 *     for AGENTS.md / CLAUDE.md / .cursorrules.
 *   - First match per directory wins. Cap content at 8KB to prevent bloat.
 *   - Append the discovered hints to the TOOL RESULT (NOT the system prompt).
 *     This is critical for provider prompt caching: the static prompt prefix
 *     stays byte-identical; only the tool-result payload gains new content.
 *
 * Security: hints are scanned for prompt-injection patterns before inclusion.
 * This mirrors the check `prompt_builder.py:_scan_context_content` in Hermes,
 * extended with TITAN's outbound-sanitizer heuristics.
 *
 * Usage (from toolRunner.ts):
 *
 *   import { getSubdirTracker } from './subdirHints.js';
 *   const tracker = getSubdirTracker(sessionId);
 *   const hints = tracker.checkToolCall(toolName, toolArgs);
 *   if (hints) toolResult += '\n\n' + hints;
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve as resolvePath, dirname as pathDirname, join as pathJoin, extname } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'SubdirHints';

// Context files to look for in subdirectories, in priority order.
// Different subdirs may use different conventions; load the first match per dir.
const HINT_FILENAMES = [
    'AGENTS.md', 'agents.md',
    'CLAUDE.md', 'claude.md',
    'TITAN.md', 'titan.md',
    '.cursorrules',
];

// Cap per hint file to prevent context bloat
const MAX_HINT_CHARS = 8_000;

// How many parent directories to walk up when looking for hints.
const MAX_ANCESTOR_WALK = 5;

// Tool arg keys that typically contain file paths
const PATH_ARG_KEYS = new Set([
    'path', 'file_path', 'filepath', 'filename',
    'workdir', 'working_dir', 'cwd', 'dir', 'directory',
    'src', 'source', 'dst', 'destination',
    'target', 'location',
]);

// Tools that take shell commands where we scan for path-like tokens
const COMMAND_TOOLS = new Set([
    'shell', 'exec', 'bash', 'command', 'terminal',
    'run', 'run_command',
]);

// Prompt-injection patterns that disqualify a hint file from inclusion.
const THREAT_PATTERNS: Array<[RegExp, string]> = [
    [/ignore\s+(previous|all|above|prior)\s+instructions/i, 'prompt_injection'],
    [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
    [/system\s+prompt\s+override/i, 'sys_prompt_override'],
    [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, 'disregard_rules'],
    [/<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, 'html_comment_injection'],
    [/<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, 'hidden_div'],
    [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_curl'],
    [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, 'read_secrets'],
];

const INVISIBLE_UNICODE = new Set([
    '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
    '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

function scanContent(content: string, filename: string): string | null {
    // Invisible unicode
    for (const c of INVISIBLE_UNICODE) {
        if (content.includes(c)) {
            logger.warn(COMPONENT, `Blocked ${filename}: invisible unicode U+${c.charCodeAt(0).toString(16).toUpperCase()}`);
            return null;
        }
    }
    // Threat patterns
    for (const [rx, id] of THREAT_PATTERNS) {
        if (rx.test(content)) {
            logger.warn(COMPONENT, `Blocked ${filename}: matched pattern ${id}`);
            return null;
        }
    }
    return content;
}

function expandHome(p: string): string {
    if (p.startsWith('~/')) return pathJoin(homedir(), p.slice(2));
    if (p === '~') return homedir();
    return p;
}

export class SubdirectoryHintTracker {
    private readonly workingDir: string;
    private readonly loadedDirs = new Set<string>();

    constructor(workingDir: string = process.cwd()) {
        this.workingDir = resolvePath(workingDir);
        // Pre-mark working dir as loaded — startup system prompt already covers it.
        this.loadedDirs.add(this.workingDir);
    }

    /**
     * Inspect a tool call for new directories and load any hint files.
     * Returns a formatted hint block to append to the tool result, or null.
     */
    checkToolCall(toolName: string, toolArgs: Record<string, unknown>): string | null {
        const dirs = this.extractDirectories(toolName, toolArgs);
        if (dirs.length === 0) return null;

        const hints: string[] = [];
        for (const d of dirs) {
            const h = this.loadHintsForDirectory(d);
            if (h) hints.push(h);
        }
        if (hints.length === 0) return null;
        return hints.join('\n\n');
    }

    private extractDirectories(toolName: string, args: Record<string, unknown>): string[] {
        const candidates = new Set<string>();

        // Direct path args
        for (const key of Object.keys(args)) {
            if (PATH_ARG_KEYS.has(key.toLowerCase())) {
                const v = args[key];
                if (typeof v === 'string' && v.trim()) {
                    this.addPathCandidate(v, candidates);
                }
            }
        }

        // Shell commands — tokenize and scan for path-like tokens
        if (COMMAND_TOOLS.has(toolName.toLowerCase())) {
            const cmd = args.command ?? args.cmd ?? args.script;
            if (typeof cmd === 'string') {
                this.extractPathsFromCommand(cmd, candidates);
            }
        }

        return [...candidates];
    }

    private addPathCandidate(rawPath: string, candidates: Set<string>): void {
        try {
            let p = expandHome(rawPath);
            // Strip simple quoting
            p = p.replace(/^["']|["']$/g, '');
            if (!p) return;

            // Resolve to absolute
            if (!p.startsWith('/')) p = resolvePath(this.workingDir, p);
            p = resolvePath(p);

            // If it's a file path, use its directory
            const hasExt = extname(p).length > 0;
            if (hasExt) {
                p = pathDirname(p);
            } else {
                try {
                    if (existsSync(p) && statSync(p).isFile()) p = pathDirname(p);
                } catch { /* ignore */ }
            }

            // Walk up ancestors — stop at already-loaded or filesystem root
            let cursor = p;
            for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
                if (this.loadedDirs.has(cursor)) break;
                if (this.isValidSubdir(cursor)) candidates.add(cursor);
                const parent = pathDirname(cursor);
                if (parent === cursor) break; // filesystem root
                cursor = parent;
            }
        } catch {
            // swallow — bad path args shouldn't fail the tool result
        }
    }

    private extractPathsFromCommand(cmd: string, candidates: Set<string>): void {
        // Simple whitespace split — paths rarely contain shell metachars in TITAN's usage.
        const tokens = cmd.split(/\s+/);
        for (const tok of tokens) {
            if (!tok) continue;
            if (tok.startsWith('-')) continue;           // flags
            if (!tok.includes('/') && !tok.includes('.')) continue; // need a path-ish shape
            if (tok.startsWith('http://') || tok.startsWith('https://') || tok.startsWith('git@')) continue;
            this.addPathCandidate(tok, candidates);
        }
    }

    private isValidSubdir(p: string): boolean {
        try {
            if (!existsSync(p)) return false;
            if (!statSync(p).isDirectory()) return false;
        } catch {
            return false;
        }
        if (this.loadedDirs.has(p)) return false;
        return true;
    }

    private loadHintsForDirectory(dir: string): string | null {
        this.loadedDirs.add(dir);
        for (const filename of HINT_FILENAMES) {
            const hintPath = pathJoin(dir, filename);
            try {
                if (!existsSync(hintPath)) continue;
                if (!statSync(hintPath).isFile()) continue;
                let content = readFileSync(hintPath, 'utf-8').trim();
                if (!content) continue;
                const scanned = scanContent(content, filename);
                if (!scanned) continue;
                content = scanned;
                if (content.length > MAX_HINT_CHARS) {
                    content = content.slice(0, MAX_HINT_CHARS) + `\n\n[...truncated ${filename}: ${content.length.toLocaleString()} chars total]`;
                }
                // Build a relative path for display
                let relPath = hintPath;
                try {
                    if (hintPath.startsWith(this.workingDir + '/')) {
                        relPath = hintPath.slice(this.workingDir.length + 1);
                    } else if (hintPath.startsWith(homedir() + '/')) {
                        relPath = '~/' + hintPath.slice(homedir().length + 1);
                    }
                } catch { /* keep absolute */ }

                logger.debug(COMPONENT, `Loaded subdirectory hint: ${relPath} (${content.length} chars)`);
                return `[Subdirectory context discovered: ${relPath}]\n${content}`;
            } catch (err) {
                logger.debug(COMPONENT, `Could not read ${hintPath}: ${(err as Error).message}`);
            }
        }
        return null;
    }
}

// ── Per-session tracker registry ──────────────────────────────────
//
// Each session gets its own tracker so hints loaded during one conversation
// don't bleed into another. Bounded (LRU-ish) to prevent leaks on long-running
// deployments with many sessions.

const SESSION_TRACKER_CAP = 200;
const trackers = new Map<string, SubdirectoryHintTracker>();

export function getSubdirTracker(sessionId: string, workingDir?: string): SubdirectoryHintTracker {
    let t = trackers.get(sessionId);
    if (!t) {
        t = new SubdirectoryHintTracker(workingDir);
        trackers.set(sessionId, t);
        // Simple cap: if over, drop the oldest inserted (Map preserves insertion order).
        if (trackers.size > SESSION_TRACKER_CAP) {
            const firstKey = trackers.keys().next().value;
            if (firstKey) trackers.delete(firstKey);
        }
    }
    return t;
}

/** Drop a session's tracker when the session closes. */
export function clearSubdirTracker(sessionId: string): void {
    trackers.delete(sessionId);
}

/** Test helper: wipe everything. */
export function __resetSubdirTrackersForTests(): void {
    trackers.clear();
}
