/**
 * TITAN — Unit Tests: extractToolCallFromUserMessage
 *
 * Last-resort tool-call extraction from user messages.
 */
import { describe, it, expect } from 'vitest';
import { extractToolCallFromUserMessage } from '../../src/agent/agentLoop.js';
import type { ToolDefinition } from '../../src/providers/base.js';

function makeTools(names: string[]): ToolDefinition[] {
    return names.map(n => ({
        type: 'function' as const,
        function: { name: n, description: n, parameters: { type: 'object', properties: {} } },
    }));
}

describe('extractToolCallFromUserMessage', () => {
    // ── Shell extraction ──
    it('extracts "run ls -la"', () => {
        const result = extractToolCallFromUserMessage('run ls -la', makeTools(['shell']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('shell');
        expect(JSON.parse(result!.function.arguments).command).toBe('ls -la');
    });

    it('extracts "execute cat /etc/passwd"', () => {
        const result = extractToolCallFromUserMessage('execute cat /etc/passwd', makeTools(['shell']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('shell');
    });

    it('extracts "please run echo hello"', () => {
        const result = extractToolCallFromUserMessage('please run echo hello world', makeTools(['shell']));
        expect(result).not.toBeNull();
        expect(JSON.parse(result!.function.arguments).command).toBe('echo hello world');
    });

    it('extracts "run: npm install"', () => {
        const result = extractToolCallFromUserMessage('run: npm install', makeTools(['shell']));
        expect(result).not.toBeNull();
    });

    it('extracts bare "run: git status"', () => {
        const result = extractToolCallFromUserMessage('run: git status', makeTools(['shell']));
        expect(result).not.toBeNull();
    });

    it('does not extract shell if shell tool unavailable', () => {
        const result = extractToolCallFromUserMessage('run ls', makeTools(['read_file']));
        expect(result).toBeNull();
    });

    // ── read_file extraction ──
    it('extracts "read /tmp/test.txt"', () => {
        const result = extractToolCallFromUserMessage('read /tmp/test.txt', makeTools(['read_file']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('read_file');
        expect(JSON.parse(result!.function.arguments).path).toBe('/tmp/test.txt');
    });

    it('extracts "show me the file /etc/hosts"', () => {
        const result = extractToolCallFromUserMessage('show me the file /etc/hosts', makeTools(['read_file']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('read_file');
    });

    it('extracts "display /var/log/syslog"', () => {
        const result = extractToolCallFromUserMessage('display /var/log/syslog', makeTools(['read_file']));
        expect(result).not.toBeNull();
    });

    it('does not extract read_file if unavailable', () => {
        const result = extractToolCallFromUserMessage('read /tmp/test.txt', makeTools(['shell']));
        expect(result).toBeNull();
    });

    // ── list_dir extraction ──
    it('extracts "list files in /tmp"', () => {
        const result = extractToolCallFromUserMessage('list files in /tmp', makeTools(['list_dir']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('list_dir');
        expect(JSON.parse(result!.function.arguments).path).toBe('/tmp');
    });

    it('extracts "show the contents of /home"', () => {
        const result = extractToolCallFromUserMessage('show the contents of /home', makeTools(['list_dir']));
        expect(result).not.toBeNull();
    });

    // ── web_search extraction ──
    it('extracts "search the web for cats"', () => {
        const result = extractToolCallFromUserMessage('search the web for cats', makeTools(['web_search']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('web_search');
        expect(JSON.parse(result!.function.arguments).query).toBe('cats');
    });

    it('extracts "google quantum computing"', () => {
        const result = extractToolCallFromUserMessage('google quantum computing news', makeTools(['web_search']));
        expect(result).not.toBeNull();
        expect(JSON.parse(result!.function.arguments).query).toBe('quantum computing news');
    });

    it('extracts "search for TypeScript tips"', () => {
        const result = extractToolCallFromUserMessage('search for TypeScript tips', makeTools(['web_search']));
        expect(result).not.toBeNull();
    });

    // ── web_fetch extraction ──
    it('extracts "fetch https://example.com"', () => {
        const result = extractToolCallFromUserMessage('fetch https://example.com/page', makeTools(['web_fetch']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('web_fetch');
        expect(JSON.parse(result!.function.arguments).url).toBe('https://example.com/page');
    });

    it('extracts "open http://localhost:3000"', () => {
        const result = extractToolCallFromUserMessage('open http://localhost:3000', makeTools(['web_fetch']));
        expect(result).not.toBeNull();
    });

    // ── weather extraction ──
    it('extracts "weather in Kelseyville"', () => {
        const result = extractToolCallFromUserMessage('weather in Kelseyville', makeTools(['weather']));
        expect(result).not.toBeNull();
        expect(result!.function.name).toBe('weather');
        expect(JSON.parse(result!.function.arguments).location).toBe('kelseyville');
    });

    it('extracts "what\'s the weather for San Francisco?"', () => {
        const result = extractToolCallFromUserMessage("what's the weather for San Francisco?", makeTools(['weather']));
        expect(result).not.toBeNull();
        expect(JSON.parse(result!.function.arguments).location).toBe('san francisco');
    });

    // ── No match cases ──
    it('returns null for no clear intent', () => {
        const result = extractToolCallFromUserMessage('hello there', makeTools(['shell', 'read_file']));
        expect(result).toBeNull();
    });

    it('returns null for short message', () => {
        const result = extractToolCallFromUserMessage('hi', makeTools(['shell']));
        expect(result).toBeNull();
    });

    it('returns null for empty tools', () => {
        const result = extractToolCallFromUserMessage('run ls', []);
        expect(result).toBeNull();
    });

    it('returns null when no tools match pattern', () => {
        const result = extractToolCallFromUserMessage('run ls', makeTools(['weather', 'memory']));
        expect(result).toBeNull();
    });

    // ── Edge cases ──
    it('returns null for empty string', () => {
        expect(extractToolCallFromUserMessage('', makeTools(['shell']))).toBeNull();
    });

    it('handles backticks in shell commands', () => {
        const result = extractToolCallFromUserMessage('run `ls -la`', makeTools(['shell']));
        // Backticks are excluded by the regex, so this may or may not match
        // Just ensure it doesn't throw
        expect(result === null || result.function.name === 'shell').toBe(true);
    });

    it('handles quotes in shell commands', () => {
        const result = extractToolCallFromUserMessage('run "echo hello"', makeTools(['shell']));
        expect(result === null || result.function.name === 'shell').toBe(true);
    });
});
