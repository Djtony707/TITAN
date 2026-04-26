/**
 * Tests for FabricationGuard pattern detection (Phase 9 / Track D1).
 *
 * Verifies the guard catches the expanded verb set
 * (edit/fix/run/searched/browsed/created/deleted + write/save) and
 * doesn't fire on responses that ARE backed by a real tool call.
 */

import { describe, it, expect } from 'vitest';
import { detectFabrication, buildNudgeMessage, type ToolHistoryEntry } from '../../src/safety/fabricationGuard.js';

const NO_HISTORY: ToolHistoryEntry[] = [];

describe('FabricationGuard — file_write category', () => {
    it('catches "I have written X to /tmp/foo.md" without write_file in history', () => {
        const findings = detectFabrication("I've written the report to /tmp/report.md.", NO_HISTORY);
        expect(findings.length).toBe(1);
        expect(findings[0].category).toBe('file_write');
        expect(findings[0].target).toBe('/tmp/report.md');
        expect(findings[0].expectedTool).toBe('write_file');
    });

    it('catches "I saved the file at /home/dj/notes.txt" without write_file', () => {
        const findings = detectFabrication("I saved the file at /home/dj/notes.txt.", NO_HISTORY);
        expect(findings.length).toBe(1);
        expect(findings[0].category).toBe('file_write');
    });

    it('does NOT fire when write_file is in tool history', () => {
        const findings = detectFabrication(
            "I've written the report to /tmp/report.md.",
            [{ name: 'write_file', args: { path: '/tmp/report.md' } }],
        );
        expect(findings).toEqual([]);
    });

    it('does NOT fire on third-person prose', () => {
        // No first-person voice — this is the agent quoting the user.
        const findings = detectFabrication(
            "The user asked me to write a file at /tmp/foo.txt.",
            NO_HISTORY,
        );
        expect(findings).toEqual([]);
    });
});

describe('FabricationGuard — file_edit category', () => {
    it('catches "I edited config.ts"', () => {
        const findings = detectFabrication("I edited config.ts to add the new field.", NO_HISTORY);
        expect(findings.some(f => f.category === 'file_edit')).toBe(true);
    });

    it('catches "I fixed the bug in src/agent/loop.ts"', () => {
        const findings = detectFabrication(
            "I fixed the bug in src/agent/loop.ts.",
            NO_HISTORY,
        );
        expect(findings.length).toBeGreaterThan(0);
        expect(findings[0].verb).toMatch(/fix/);
    });

    it('catches "I refactored utils/helpers.ts"', () => {
        const findings = detectFabrication("I refactored utils/helpers.ts.", NO_HISTORY);
        expect(findings.some(f => f.category === 'file_edit')).toBe(true);
    });

    it('does NOT fire when edit_file is in tool history', () => {
        const findings = detectFabrication(
            "I edited config.ts.",
            [{ name: 'edit_file', args: { path: 'config.ts' } }],
        );
        expect(findings).toEqual([]);
    });
});

describe('FabricationGuard — file_delete category', () => {
    it('catches "I deleted the old config"', () => {
        const findings = detectFabrication(
            "I deleted /tmp/old-config.json.",
            NO_HISTORY,
        );
        expect(findings.length).toBeGreaterThan(0);
        expect(findings[0].category).toBe('file_delete');
    });

    it('does NOT fire when shell is in tool history', () => {
        const findings = detectFabrication(
            "I deleted /tmp/old-config.json.",
            [{ name: 'shell', args: { cmd: 'rm /tmp/old-config.json' } }],
        );
        expect(findings).toEqual([]);
    });
});

describe('FabricationGuard — shell_run category', () => {
    it('catches "I ran `npm test`" without shell history', () => {
        const findings = detectFabrication("I ran `npm test` and all 500 passed.", NO_HISTORY);
        expect(findings.some(f => f.category === 'shell_run')).toBe(true);
    });

    it('catches "I executed git status"', () => {
        const findings = detectFabrication("I executed git status to check.", NO_HISTORY);
        expect(findings.some(f => f.category === 'shell_run')).toBe(true);
    });

    it('catches "I installed lodash"', () => {
        const findings = detectFabrication("I installed lodash via npm.", NO_HISTORY);
        expect(findings.some(f => f.category === 'shell_run')).toBe(true);
    });

    it('does NOT fire when shell IS in tool history', () => {
        const findings = detectFabrication(
            "I ran `npm test` and all 500 passed.",
            [{ name: 'shell', args: { cmd: 'npm test' } }],
        );
        expect(findings).toEqual([]);
    });
});

describe('FabricationGuard — web_action category', () => {
    it('catches "I searched for Python tutorials"', () => {
        const findings = detectFabrication("I searched for Python tutorials.", NO_HISTORY);
        expect(findings.some(f => f.category === 'web_action')).toBe(true);
    });

    it('catches "I browsed to github.com"', () => {
        const findings = detectFabrication("I browsed to github.com to check.", NO_HISTORY);
        expect(findings.some(f => f.category === 'web_action')).toBe(true);
    });

    it('catches "I fetched the weather data"', () => {
        const findings = detectFabrication("I fetched the weather data.", NO_HISTORY);
        expect(findings.some(f => f.category === 'web_action')).toBe(true);
    });

    it('does NOT fire when web_search is in tool history', () => {
        const findings = detectFabrication(
            "I searched for Python tutorials.",
            [{ name: 'web_search', args: { query: 'Python tutorials' } }],
        );
        expect(findings).toEqual([]);
    });
});

describe('FabricationGuard — tool_used category (generic)', () => {
    it('catches "I used the shell tool" without shell call', () => {
        const findings = detectFabrication("I used the shell tool.", NO_HISTORY);
        expect(findings.some(f => f.category === 'tool_used')).toBe(true);
    });

    it('does NOT fire when the named tool was actually used', () => {
        const findings = detectFabrication(
            "I used the shell tool.",
            [{ name: 'shell', args: { cmd: 'ls' } }],
        );
        expect(findings).toEqual([]);
    });
});

describe('FabricationGuard — multi-finding responses', () => {
    it('returns ALL fabrications from a response that fakes several actions', () => {
        const content = "I edited config.ts. Then I ran npm test. Then I searched for the bug.";
        const findings = detectFabrication(content, NO_HISTORY);
        expect(findings.length).toBeGreaterThanOrEqual(2);
    });

    it('returns no findings on a clean tool-backed response', () => {
        const content = "I edited config.ts and ran npm test.";
        const findings = detectFabrication(content, [
            { name: 'edit_file', args: { path: 'config.ts' } },
            { name: 'shell', args: { cmd: 'npm test' } },
        ]);
        expect(findings).toEqual([]);
    });

    it('returns no findings on empty content', () => {
        expect(detectFabrication('', NO_HISTORY)).toEqual([]);
    });

    it('returns no findings on very short content', () => {
        expect(detectFabrication('ok', NO_HISTORY)).toEqual([]);
    });
});

describe('FabricationGuard — buildNudgeMessage', () => {
    it('returns empty string when no findings', () => {
        expect(buildNudgeMessage([])).toBe('');
    });

    it('mentions each finding with its expected tool', () => {
        const msg = buildNudgeMessage([
            {
                category: 'file_write',
                verb: 'wrote',
                target: '/tmp/foo.md',
                expectedTool: 'write_file',
                excerpt: 'I wrote the report to /tmp/foo.md',
            },
            {
                category: 'shell_run',
                verb: 'ran',
                target: 'npm test',
                expectedTool: 'shell',
                excerpt: 'I ran npm test',
            },
        ]);
        expect(msg).toContain('wrote');
        expect(msg).toContain('/tmp/foo.md');
        expect(msg).toContain('write_file');
        expect(msg).toContain('shell');
        expect(msg).toMatch(/Actually call|correct your claim/i);
    });
});
