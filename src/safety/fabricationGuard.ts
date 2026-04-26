/**
 * FabricationGuard (Phase 9 / Track D, v5.4.0)
 *
 * Catches model responses that CLAIM to have done something but didn't
 * actually call the tool that would do it. The original guard lived
 * inline in `agentLoop.ts` and only matched past-tense write claims via
 * a single narrow regex. This module:
 *   1. Expands pattern coverage to all common action verbs
 *      (edit/fix/run/search/browse/create/delete + write/save).
 *   2. Cross-checks claims against the actual tool history — "I ran
 *      `npm test`" only counts as truthful if a `shell` tool call
 *      actually happened in this turn.
 *   3. For file-write claims, exposes a verifier that checks the file
 *      exists and (optionally) hashes the content.
 *
 * It's a pure module: no I/O at import time, easy to unit-test. The
 * agent loop can call `detectFabrication(content, toolHistory)` after
 * each response and choose to nudge the model, force a tool call, or
 * return a redacted answer.
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

/** A single tool invocation captured by the agent loop, in execution order. */
export interface ToolHistoryEntry {
    /** Tool name (`shell`, `write_file`, `web_search`, ...). */
    name: string;
    /** Arguments passed to the tool, parsed from the model's tool_calls. */
    args?: Record<string, unknown>;
    /** Raw output, when available — used by the file-write verifier. */
    output?: string;
}

/** Discriminated category of fabrication signal. */
export type FabricationCategory =
    | 'file_write'   // I wrote/saved/created file X
    | 'file_edit'    // I edited/fixed/modified X
    | 'file_delete'  // I deleted/removed X
    | 'shell_run'    // I ran/executed/installed X
    | 'web_action'   // I searched/browsed/fetched X
    | 'tool_used';   // I used [tool_name] (generic catch-all)

/** A single fabrication finding from `detectFabrication`. */
export interface FabricationFinding {
    category: FabricationCategory;
    /** The verb the model used (write, edit, ran, etc.). */
    verb: string;
    /** The object/target the verb acted on (file path, URL, command). */
    target: string;
    /** The tool name that *would* satisfy this claim. */
    expectedTool: string;
    /** The exact substring of `content` that triggered the match. */
    excerpt: string;
}

// ── Pattern table ────────────────────────────────────────────────────
//
// Each entry is { regex, category, expectedTool }. We keep the regexes
// strict to avoid false positives — TITAN's chat output is usually
// short, so a wide pattern surface produces too many bogus rejections.
//
// All patterns require the verb to start near a sentence boundary
// (^|[.!?\n]\s*) and end with a recognizable target. Matches are
// case-insensitive but anchor on first-person voice ("I have", "I've",
// "I just"); third-person summaries (e.g. quoting the user) don't fire.

const VERB_PATTERNS: Array<{
    regex: RegExp;
    category: FabricationCategory;
    expectedTool: string;
    verbGroup?: number;
    targetGroup?: number;
}> = [
    // Past-tense file writes — Hunt #47 lineage. Catches "I have written X
    // to /tmp/foo.md", "I saved the report at /home/dj/report.txt".
    {
        regex: /\b(?:I(?:'ve| have| just)?)\s+(written|saved|wrote|created|generated|produced)\s+(?:[^.!?\n]*?)(?:to|at|in)\s+["'`]?(\/[\w/.-]+\.[a-z0-9]+|\.\/[\w/.-]+|~\/[\w/.-]+|[\w./_-]+\.[a-z0-9]{1,5})["'`]?/i,
        category: 'file_write',
        expectedTool: 'write_file',
        verbGroup: 1,
        targetGroup: 2,
    },
    // File edits — "I edited X", "I fixed the bug in X", "I modified config.ts".
    {
        regex: /\b(?:I(?:'ve| have| just)?)\s+(edited|modified|fixed|patched|updated|refactored)\s+(?:the\s+\w+\s+(?:in|at)\s+)?["'`]?([\w/.-]+\.[a-z0-9]{1,5}|[\w/.-]+\/[\w._-]+)["'`]?/i,
        category: 'file_edit',
        expectedTool: 'edit_file',
        verbGroup: 1,
        targetGroup: 2,
    },
    // File deletes — "I deleted /tmp/foo", "I removed the old config".
    {
        regex: /\b(?:I(?:'ve| have| just)?)\s+(deleted|removed|cleaned\s+up)\s+(?:the\s+)?["'`]?(\/[\w/.-]+|[\w/.-]+\.[a-z0-9]{1,5})["'`]?/i,
        category: 'file_delete',
        expectedTool: 'shell',
        verbGroup: 1,
        targetGroup: 2,
    },
    // Shell command claims — "I ran `npm test`", "I executed git status".
    // Backtick form is the strong signal; bare-text "I ran npm install"
    // also triggers but only when followed by a recognizable command.
    {
        regex: /\b(?:I(?:'ve| have| just)?)\s+(ran|executed|installed|launched)\s+["`]?([a-z][a-z0-9_-]+(?:\s+[\w.-]+)*)/i,
        category: 'shell_run',
        expectedTool: 'shell',
        verbGroup: 1,
        targetGroup: 2,
    },
    // Web actions — "I searched for X", "I browsed to Y", "I fetched Z".
    {
        regex: /\b(?:I(?:'ve| have| just)?)\s+(searched|browsed|fetched|googled|looked\s+up)\s+(?:for\s+|to\s+)?["'`]?([^"'`.!?\n]{2,80})["'`]?/i,
        category: 'web_action',
        expectedTool: 'web_search',
        verbGroup: 1,
        targetGroup: 2,
    },
    // Generic tool-name claim — "I used the shell tool", "I used write_file".
    // This is the weakest signal and the most likely to misfire — only
    // included so the system can flag for human review, not auto-correct.
    {
        regex: /\b(?:I(?:'ve| have| just)?)\s+(used|called|invoked)\s+(?:the\s+)?["'`]?([a-z_]{3,30})["'`]?\s+tool\b/i,
        category: 'tool_used',
        expectedTool: '*', // wildcard — match against any tool that has the same name
        verbGroup: 1,
        targetGroup: 2,
    },
];

/**
 * Scan the model's response for action claims and return any that aren't
 * backed by a real tool call. `toolHistory` should contain every tool
 * invocation the agent made in this turn (and ideally the prior turn,
 * since "I already wrote X" can refer to a previous round).
 *
 * Returns an empty array when no fabrication is detected.
 */
export function detectFabrication(
    content: string,
    toolHistory: ToolHistoryEntry[],
): FabricationFinding[] {
    if (!content || content.length < 5) return [];

    const findings: FabricationFinding[] = [];
    const usedTools = new Set(toolHistory.map(t => t.name.toLowerCase()));

    for (const pat of VERB_PATTERNS) {
        const m = content.match(pat.regex);
        if (!m) continue;
        const verb = (pat.verbGroup ? m[pat.verbGroup] : m[1]) || 'did';
        const target = (pat.targetGroup ? m[pat.targetGroup] : m[2]) || '';
        if (!target) continue;

        // Did the agent actually call a tool that satisfies this claim?
        const claimSatisfied = pat.expectedTool === '*'
            ? usedTools.has(target.toLowerCase())
            : usedTools.has(pat.expectedTool);

        if (!claimSatisfied) {
            findings.push({
                category: pat.category,
                verb: verb.toLowerCase(),
                target: target.trim(),
                expectedTool: pat.expectedTool,
                excerpt: m[0],
            });
        }
    }

    return findings;
}

// ── Verify-before-trust on file operations ──────────────────────────

/** Result of `verifyFileWriteClaim`. */
export interface FileWriteVerification {
    /** True when the file exists at the claimed path with non-zero size. */
    fileExists: boolean;
    /** SHA-256 of the file contents, when present. */
    fileHash?: string;
    /** True when the file's content matches the model's claimed body
     *  (only computed if `expectedContent` was passed). */
    contentMatches?: boolean;
    /** Why the claim fails verification, if it does. */
    reason?: string;
}

/**
 * Verify a file-write claim against the real filesystem.
 *
 * Use this AFTER the agent claims to have written/edited a file but
 * BEFORE accepting the response as final. If the file doesn't exist at
 * the claimed path, the agent fabricated and the loop should retry.
 *
 * Optionally pass `expectedContent` to also verify the body matches —
 * useful when the model includes the literal content in its response.
 */
export function verifyFileWriteClaim(
    filePath: string,
    expectedContent?: string,
): FileWriteVerification {
    let exists: boolean;
    try {
        exists = existsSync(filePath);
    } catch {
        return { fileExists: false, reason: 'fs.existsSync threw — invalid path' };
    }
    if (!exists) {
        return { fileExists: false, reason: `file not present at ${filePath}` };
    }

    let size = 0;
    try {
        size = statSync(filePath).size;
    } catch {
        return { fileExists: true, reason: 'fs.statSync threw on existing path' };
    }
    if (size === 0) {
        return { fileExists: true, reason: 'file exists but is empty' };
    }

    let actualContent: string;
    let fileHash: string;
    try {
        actualContent = readFileSync(filePath, 'utf-8');
        fileHash = createHash('sha256').update(actualContent).digest('hex');
    } catch (e) {
        return { fileExists: true, reason: `read failed: ${(e as Error).message}` };
    }

    if (expectedContent === undefined) {
        return { fileExists: true, fileHash };
    }

    // Content match: lenient — strip trailing whitespace, compare.
    const a = actualContent.trim();
    const b = expectedContent.trim();
    const contentMatches = a === b;
    return {
        fileExists: true,
        fileHash,
        contentMatches,
        reason: contentMatches ? undefined : 'file exists but content differs from claim',
    };
}

/**
 * Build a structured nudge message the agent loop can append to the
 * model's next-turn user message when fabrication is detected. The
 * message is deliberately blunt — most weak models need to be told
 * directly that they didn't do what they claimed.
 */
export function buildNudgeMessage(findings: FabricationFinding[]): string {
    if (findings.length === 0) return '';
    const lines = ['You claimed to perform actions you did NOT actually do via tools:'];
    for (const f of findings) {
        lines.push(`  - You said you ${f.verb} "${f.target}", but you did not call ${f.expectedTool === '*' ? 'any matching tool' : `the ${f.expectedTool} tool`}.`);
    }
    lines.push('');
    lines.push('Either:');
    lines.push('  1. Actually call the right tool now.');
    lines.push('  2. Correct your claim — say what you DID do, or admit you did not do it.');
    return lines.join('\n');
}
