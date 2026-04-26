/**
 * TITAN — Unit Tests: detectToolUseIntent
 *
 * Determines whether a user message explicitly requests tool usage.
 */
import { describe, it, expect } from 'vitest';
import { detectToolUseIntent } from '../../src/agent/agentLoop.js';

describe('detectToolUseIntent', () => {
    // ── Explicit "use X tool" ──
    const explicitCases = [
        { msg: 'use the shell tool', expected: true },
        { msg: 'use shell tool to list files', expected: true },
        { msg: 'use the web_search tool', expected: true },
        { msg: 'use read_file tool', expected: true },
        { msg: 'use write_file tool to save this', expected: true },
        { msg: 'use memory tool', expected: true },
    ];

    for (const c of explicitCases) {
        it(`explicit: "${c.msg}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── "run / execute / call" ──
    const actionCases = [
        { msg: 'run the shell command', expected: true },
        { msg: 'execute this script', expected: true },
        { msg: 'call the weather tool', expected: true },
        { msg: 'invoke web_search', expected: true },
        { msg: 'run npm install', expected: true },
        { msg: 'execute the build command', expected: false },
        { msg: 'run ls', expected: true },
        { msg: 'run: ls -la', expected: true },
    ];

    for (const c of actionCases) {
        it(`action: "${c.msg}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── Web actions ──
    const webCases = [
        { msg: 'search the web for cats', expected: true },
        { msg: 'web search for latest news', expected: true },
        { msg: 'fetch the URL https://example.com', expected: true },
        { msg: 'fetch https://api.example.com/data', expected: true },
    ];

    for (const c of webCases) {
        it(`web: "${c.msg}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── File operations ──
    const fileCases = [
        { msg: 'read the file /tmp/test.txt', expected: true },
        { msg: 'read contents of /etc/passwd', expected: true },
        { msg: 'write this to file', expected: true },
        { msg: 'list files in /tmp', expected: true },
    ];

    for (const c of fileCases) {
        it(`file: "${c.msg}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── System state queries ──
    const systemCases = [
        { msg: 'what is the current uptime?', expected: true },
        { msg: 'show me the actual disk usage', expected: true },
        { msg: 'get the current memory usage', expected: true },
        { msg: 'what\'s the hostname?', expected: false },
        { msg: 'show me the current path', expected: true },
    ];

    for (const c of systemCases) {
        it(`system: "${c.msg}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── Widget / Gallery ──
    const widgetCases = [
        { msg: 'call gallery_search for templates', expected: true },
        { msg: 'use gallery_get to fetch widget', expected: true },
        { msg: 'create a widget for weather', expected: true },
        { msg: 'add a panel to the canvas', expected: true },
        { msg: 'search for a gallery template', expected: true },
    ];

    for (const c of widgetCases) {
        it(`widget: "${c.msg}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── System widget intents ──
    const systemWidgetCases = [
        { msg: 'create a backup', expected: true },
        { msg: 'train a new specialist', expected: true },
        { msg: 'run a recipe', expected: true },
        { msg: 'check vram usage', expected: true },
        { msg: 'add a team member', expected: true },
        { msg: 'schedule a cron job', expected: true },
        { msg: 'save a checkpoint', expected: true },
        { msg: 'check the organism drive', expected: true },
        { msg: 'route to a fleet node', expected: true },
        { msg: 'solve this captcha', expected: true },
        { msg: 'use paperclip helper', expected: true },
        { msg: 'run tests for this file', expected: false },
    ];

    for (const c of systemWidgetCases) {
        it(`system-widget: "${c.msg}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── Negative cases ──
    const negativeCases = [
        { msg: 'hello', expected: false },
        { msg: 'how are you?', expected: false },
        { msg: 'tell me a joke', expected: false },
        { msg: 'what is your name?', expected: false },
        { msg: 'thanks', expected: false },
        { msg: 'goodbye', expected: false },
        { msg: 'explain quantum computing', expected: false },
        { msg: 'recommend a movie', expected: false },
        { msg: 'what should I eat?', expected: false },
        { msg: '', expected: false },
        { msg: 'hi', expected: false },
    ];

    for (const c of negativeCases) {
        it(`negative: "${c.msg || '(empty)'}"`, () => {
            expect(detectToolUseIntent(c.msg)).toBe(c.expected);
        });
    }

    // ── Edge cases ──
    it('returns false for very short messages', () => {
        expect(detectToolUseIntent('a')).toBe(false);
        expect(detectToolUseIntent('run')).toBe(false);
    });

    it('returns false for null/undefined', () => {
        expect(detectToolUseIntent(null as unknown as string)).toBe(false);
        expect(detectToolUseIntent(undefined as unknown as string)).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(detectToolUseIntent('USE THE SHELL TOOL')).toBe(true);
        expect(detectToolUseIntent('Run LS')).toBe(true);
    });
});
