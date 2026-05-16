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
    }),
    sideEffects: ['write'],
    riskLevel: 'safe',
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
    { path: string; startLine?: number; endLine?: number; byteOffset?: number; byteLimit?: number },
    string
> = {
    name: 'read_file',
    summary: 'Read a file from disk. Optional startLine/endLine for partial reads.',
    input: z.object({
        path: z.string().min(1),
        startLine: z.number().int().nonnegative().optional(),
        endLine: z.number().int().nonnegative().optional(),
        byteOffset: z.number().int().nonnegative().optional(),
        byteLimit: z.number().int().positive().optional(),
    }),
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
    }),
    sideEffects: ['write'],
    riskLevel: 'safe',
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
    }),
    sideEffects: ['write'],
    riskLevel: 'safe',
    exampleCalls: [
        {
            description: 'append a log line',
            args: { path: '/tmp/build.log', content: 'INFO: build started\n' },
        },
    ],
};

export const LIST_DIR_CONTRACT: ToolContract<
    { path: string; recursive?: boolean; pattern?: string },
    string
> = {
    name: 'list_dir',
    summary: 'List the contents of a directory. Optionally recursive or filtered by glob pattern.',
    input: z.object({
        path: z.string().min(1),
        recursive: z.boolean().optional(),
        pattern: z.string().optional(),
    }),
    sideEffects: ['read'],
    riskLevel: 'safe',
    exampleCalls: [
        {
            description: 'list current directory contents',
            args: { path: '.' },
        },
        {
            description: 'find all TypeScript files in src/',
            args: { path: 'src', recursive: true, pattern: '*.ts' },
        },
    ],
};

/* ──────────────────────────  Network  ────────────────────────── */

export const WEB_SEARCH_CONTRACT: ToolContract<
    { query: string; numResults?: number },
    string
> = {
    name: 'web_search',
    summary: 'Search the public web. Returns ranked results with titles, URLs, and snippets.',
    input: z.object({
        query: z.string().min(1, 'query must not be empty'),
        numResults: z.number().int().min(1).max(50).optional(),
    }),
    sideEffects: ['network', 'read'],
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'a simple lookup',
            args: { query: 'TypeScript discriminated union' },
        },
        {
            description: 'a focused lookup with explicit count',
            args: { query: 'Anthropic harness engineering', numResults: 5 },
        },
    ],
};

export const WEB_FETCH_CONTRACT: ToolContract<
    { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
    string
> = {
    name: 'web_fetch',
    summary: 'Fetch a URL over HTTP(S). Internal/private network addresses are blocked.',
    input: z.object({
        url: z.string().url('url must be a valid http(s) URL'),
        method: z.enum(['GET', 'POST']).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
    }),
    sideEffects: ['network', 'read'],
    riskLevel: 'moderate',
    exampleCalls: [
        {
            description: 'fetch an article',
            args: { url: 'https://example.com/article' },
        },
    ],
};

export const DOWNLOAD_IMAGE_CONTRACT: ToolContract<
    { url: string },
    string
> = {
    name: 'download_image',
    summary: 'Download an image and return a tdi:// reference token for embedding in HTML.',
    input: z.object({
        url: z.string().url('url must be a valid http(s) URL'),
    }),
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
    { command: string; cwd?: string; timeoutMs?: number },
    string
> = {
    name: 'shell',
    summary: 'Execute a shell command. Destructive — guarded by the sandbox + approval gate.',
    input: z.object({
        command: z.string().min(1, 'command must not be empty'),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().max(300_000).optional(),
    }),
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
