/**
 * TITAN — Canonical Skill Contracts (v6.1.0-beta.15, Phase D.3)
 *
 * Zod-validated input contracts for the 10 most-used built-in skills.
 * Registered into the global contract registry at module load; the
 * tool runner looks them up by name and validates incoming args
 * BEFORE the skill's execute() runs.
 *
 * COVERAGE in this beta:
 *
 *   - write_file       (write, safe)
 *   - read_file        (read, safe)
 *   - edit_file        (write, safe)
 *   - append_file      (write, safe)
 *   - list_dir         (read, safe)
 *   - web_search       (network/read, moderate)
 *   - web_fetch        (network/read, moderate)
 *   - download_image   (network/write, moderate)
 *   - shell            (destructive, high)
 *
 * Not yet covered (~239 other tools): they continue to use the legacy
 * raw JSON-schema validation in toolRunner.ts. Migration is opt-in
 * per skill; this file adds new entries as more skills are upgraded.
 *
 * EACH CONTRACT also declares:
 *   - sideEffects: drives Phase D.4 auto-mode classifier
 *   - riskLevel:   drives Phase D.4 approval gating
 *   - exampleCalls: positive samples for tests + docs + classifier
 *
 * NAMING: contracts are named exactly as the skill name they
 * validate. The registry lookup in toolRunner.ts is keyed on name,
 * so a mismatch silently disables validation. The unit tests below
 * pin the exact names.
 */

import { z } from 'zod';
import { registerToolContract, type ToolContract } from '../../agent/toolContract.js';

/* ──────────────────────────  Filesystem  ────────────────────────── */

export const WRITE_FILE_CONTRACT: ToolContract<
    { path: string; content: string },
    string
> = {
    name: 'write_file',
    summary: 'Write content to a file. Overwrites if it exists. Path must be under home or /tmp.',
    input: z.object({
        path: z.string().min(1, 'path is required'),
        content: z.string(), // empty content is valid — touching a file
    }).passthrough(),
    sideEffects: ['write'],
    // beta.17 — writes are 'moderate' (was 'safe'). Codex P1 #2: writes
    // can overwrite files and mutate user state. The auto-mode classifier
    // maps 'moderate' to 'notify' under standard policy (runs but logs)
    // and 'gate' under 'paranoid'. Path-aware scoping (allowing /tmp/*
    // and ~/.titan/workspace/* writes to auto-run) is a follow-up — see
    // claude_notes in .ai_bridge.json.
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'write a small note',
            args: { path: '/tmp/note.txt', content: 'hello world\n' },
        },
        {
            description: 'write an HTML report in the home dir',
            args: { path: '~/reports/q4.html', content: '<html>...</html>' },
        },
    ],
};

export const READ_FILE_CONTRACT: ToolContract<
    { path: string; startLine?: number; endLine?: number },
    string
> = {
    name: 'read_file',
    summary: 'Read a file from disk. Optional startLine/endLine for partial reads.',
    // beta.17 (Codex P1): matched to the actual filesystem.ts skill
    // shape — read_file accepts {path, startLine, endLine}. The
    // byteOffset/byteLimit fields the original contract had don't
    // exist on the skill; Zod was silently stripping them.
    // .passthrough() preserves any extras so a future skill addition
    // doesn't silently drop before we catch up the contract.
    input: z.object({
        path: z.string().min(1),
        startLine: z.number().int().nonnegative().optional(),
        endLine: z.number().int().nonnegative().optional(),
    }).passthrough(),
    sideEffects: ['read'],
    riskLevel: 'safe',
    exampleCalls: [
        {
            description: 'read a whole file',
            args: { path: '/tmp/note.txt' },
        },
        {
            description: 'read lines 100-200 of a file',
            args: { path: '/var/log/titan.log', startLine: 100, endLine: 200 },
        },
    ],
};

export const EDIT_FILE_CONTRACT: ToolContract<
    { path: string; target: string; replacement: string },
    string
> = {
    name: 'edit_file',
    summary: 'Find-and-replace exactly one occurrence of target with replacement.',
    input: z.object({
        path: z.string().min(1),
        target: z.string().min(1, 'target must not be empty'),
        replacement: z.string(),
    }).passthrough(),
    sideEffects: ['write'],
    // beta.17 — see WRITE_FILE_CONTRACT comment. Writes are 'moderate'.
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'fix a typo',
            args: { path: '/tmp/note.txt', target: 'teh', replacement: 'the' },
        },
    ],
};

export const APPEND_FILE_CONTRACT: ToolContract<
    { path: string; content: string },
    string
> = {
    name: 'append_file',
    summary: 'Append content to the end of a file. Creates the file if missing.',
    input: z.object({
        path: z.string().min(1),
        content: z.string().min(1, 'content must not be empty'),
    }).passthrough(),
    sideEffects: ['write'],
    // beta.17 — see WRITE_FILE_CONTRACT comment. Writes are 'moderate'.
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'append a log line',
            args: { path: '/tmp/build.log', content: 'INFO: build started\n' },
        },
    ],
};

export const LIST_DIR_CONTRACT: ToolContract<
    { path: string; recursive?: boolean },
    string
> = {
    name: 'list_dir',
    summary: 'List the contents of a directory. Optionally recursive.',
    // beta.17 (Codex P1): matched to actual filesystem.ts skill shape.
    // The skill accepts {path, recursive}; the original contract added
    // a `pattern` field the skill doesn't read. Dropped.
    input: z.object({
        path: z.string().min(1),
        recursive: z.boolean().optional(),
    }).passthrough(),
    sideEffects: ['read'],
    riskLevel: 'safe',
    exampleCalls: [
        {
            description: 'list current directory contents',
            args: { path: '.' },
        },
        {
            description: 'list a tree recursively',
            args: { path: 'src', recursive: true },
        },
    ],
};

/* ──────────────────────────  Network  ────────────────────────── */

export const WEB_SEARCH_CONTRACT: ToolContract<
    { query: string; maxResults?: number },
    string
> = {
    name: 'web_search',
    summary: 'Search the public web. Returns ranked results with titles, URLs, and snippets.',
    // beta.17 (Codex P1): the actual web_search.ts skill uses `maxResults`,
    // not `numResults`. The original contract silently dropped the
    // caller's count preference because Zod stripped the unknown
    // `maxResults` and the skill only saw `query`. Field renamed to
    // match; .passthrough() guards against future skill additions.
    input: z.object({
        query: z.string().min(1, 'query must not be empty'),
        maxResults: z.number().int().min(1).max(50).optional(),
    }).passthrough(),
    sideEffects: ['network', 'read'],
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'a simple lookup',
            args: { query: 'TypeScript discriminated union' },
        },
        {
            description: 'a focused lookup with explicit count',
            args: { query: 'discriminated unions', maxResults: 5 },
        },
    ],
};

export const WEB_FETCH_CONTRACT: ToolContract<
    { url: string; extractMode?: 'markdown' | 'text'; maxChars?: number },
    string
> = {
    name: 'web_fetch',
    summary: 'Fetch a URL over HTTP(S) and return its content as markdown or text. Internal/private network addresses are blocked.',
    // beta.17 (Codex P1): the actual web_fetch.ts skill accepts
    // {url, extractMode: 'markdown'|'text', maxChars}, NOT
    // {url, method, headers, body}. The original contract advertised a
    // generic HTTP-call shape the skill never had; LLMs passing
    // method/headers/body were getting them silently stripped.
    // Schema now mirrors the actual skill. .passthrough() preserves
    // any future additions.
    input: z.object({
        url: z.string().url('url must be a valid http(s) URL'),
        extractMode: z.enum(['markdown', 'text']).optional(),
        maxChars: z.number().int().positive().max(200_000).optional(),
    }).passthrough(),
    sideEffects: ['network', 'read'],
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'fetch an article as markdown',
            args: { url: 'https://example.com/article' },
        },
        {
            description: 'fetch as plain text with a tighter cap',
            args: { url: 'https://example.com/long-page', extractMode: 'text', maxChars: 8000 },
        },
    ],
};

export const DOWNLOAD_IMAGE_CONTRACT: ToolContract<
    { url: string },
    string
> = {
    name: 'download_image',
    summary: 'Download an image and return a tdi:// reference token for embedding in HTML.',
    // beta.17 (Codex P1 audit): download_image.ts skill takes {url} only;
    // contract matches. .passthrough() added defensively in case the
    // skill grows options later.
    input: z.object({
        url: z.string().url('url must be a valid http(s) URL'),
    }).passthrough(),
    sideEffects: ['network', 'write'],
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'download a public image',
            args: { url: 'https://upload.wikimedia.org/wikipedia/commons/example.jpg' },
        },
    ],
};

/* ──────────────────────────  Shell (destructive)  ────────────────────────── */

export const SHELL_CONTRACT: ToolContract<
    {
        command: string;
        cwd?: string;
        timeout?: number;
        background?: boolean;
        verify_port?: number;
    },
    string
> = {
    name: 'shell',
    summary: 'Execute a shell command. Destructive — guarded by the sandbox + approval gate.',
    // beta.17 (Codex P1): matched to actual shell.ts skill shape. The
    // skill uses `timeout` (not `timeoutMs`) and also accepts
    // `background` + `verify_port` for dev-server launches. The
    // original contract used the wrong name + missed the background
    // path entirely. Zod was silently stripping `background` /
    // `verify_port` whenever the LLM tried to launch a background
    // process — the agent would then complain that the dev server
    // "didn't start" because shell took the command synchronously.
    input: z.object({
        command: z.string().min(1, 'command must not be empty'),
        cwd: z.string().optional(),
        timeout: z.number().int().positive().max(600_000).optional(),
        background: z.boolean().optional(),
        verify_port: z.number().int().min(1).max(65535).optional(),
    }).passthrough(),
    sideEffects: ['destructive'],
    riskLevel: 'high',
    exampleCalls: [
        {
            description: 'list files',
            args: { command: 'ls -la' },
        },
        {
            description: 'check disk usage in a specific dir',
            args: { command: 'du -sh', cwd: '/var/log' },
        },
        {
            description: 'launch a dev server in the background, wait for port 3000',
            args: { command: 'npm run dev', background: true, verify_port: 3000 },
        },
    ],
};

/* ──────────────────────────  Registry init  ────────────────────────── */

const CANONICAL_CONTRACTS: ToolContract[] = [
    WRITE_FILE_CONTRACT,
    READ_FILE_CONTRACT,
    EDIT_FILE_CONTRACT,
    APPEND_FILE_CONTRACT,
    LIST_DIR_CONTRACT,
    WEB_SEARCH_CONTRACT,
    WEB_FETCH_CONTRACT,
    DOWNLOAD_IMAGE_CONTRACT,
    SHELL_CONTRACT,
];

/**
 * Idempotent registration of all canonical contracts. Called from the
 * skill registry's `initBuiltinSkills` so the contracts are loaded
 * before any tool dispatch happens.
 */
export function registerCanonicalContracts(): void {
    for (const c of CANONICAL_CONTRACTS) {
        registerToolContract(c);
    }
}

/** For tests + introspection. */
export function listCanonicalContracts(): ToolContract[] {
    return [...CANONICAL_CONTRACTS];
}
