/**
 * v6.0 — Widget-shortcut hijack regression tests.
 *
 * Pins the v6.0 tightened gate so the shortcut never silently hijacks
 * normal agent prompts again.
 *
 * History
 * -------
 * - v5.5.28 added `hasExplicitWidgetIntent` (must mention a "widget noun"
 *   like "widget" / "panel" / "dashboard"). Helped but still too loose:
 *   "tools" and "monitor" appear in normal English, and a single match
 *   in the prompt was enough to flip the gate and let any inner trigger
 *   like "backup" or "training" hijack the response.
 *
 * - v6.0 fix: gate requires an IMPERATIVE verb ("add", "open", "show",
 *   "pin", "create", etc.) AND a widget-noun together. Drops "tools" +
 *   "monitor" from the noun list. This pins both contracts.
 *
 * The shortcut LIVES at the top of POST /api/message in
 * src/gateway/server.ts. We replicate the gate logic here as a pure
 * function check (`shouldFireShortcut(content)`) and test it directly.
 * The full gateway integration is covered by tests/gateway*.test.ts.
 */
import { describe, it, expect } from 'vitest';

/**
 * Mirror of the v6.0 gate. Kept in sync by manual review — if either
 * production location changes its regex, this helper must update too.
 */
function shouldFireShortcut(content: string): { fires: boolean; widget?: string } {
    const imperativeRe = /\b(?:add|open|show|pin|create|launch|put|give\s+me|i\s+want|let'?s\s+see|i\s+need)\b/i;
    const widgetNounRe = /\b(?:widget|panel|dashboard|hub|gallery|kitchen|scheduler)\b/i;
    const hasExplicit = imperativeRe.test(content) && widgetNounRe.test(content);
    if (!hasExplicit) return { fires: false };

    const shortcuts: Array<{ pattern: RegExp; source: string }> = [
        { pattern: /\b(?:backups?|snapshots?|archives?)\b/i, source: 'system:backup' },
        { pattern: /\b(?:training|train|specialists?|models?)\b/i, source: 'system:training' },
        { pattern: /\b(?:recipes?|playbooks?|workflows?|jarvis)\b/i, source: 'system:recipes' },
        { pattern: /\b(?:vram|gpu|nvidia)\b/i, source: 'system:vram' },
        { pattern: /\b(?:teams?|members?|roles?|permissions?|rbac)\b/i, source: 'system:teams' },
        { pattern: /\b(?:cron|schedules?|jobs?|timers?)\b/i, source: 'system:cron' },
        { pattern: /\b(?:checkpoints?|restores?|save state)\b/i, source: 'system:checkpoints' },
        { pattern: /\b(?:organism|guardrails?)\b/i, source: 'system:organism' },
        { pattern: /\b(?:fleet|nodes?|routes?|mesh)\b/i, source: 'system:fleet' },
        { pattern: /\b(?:captcha|form fill|web automation)\b/i, source: 'system:browser' },
        { pattern: /\b(?:tests?|flaky|failing|coverage|eval)\b/i, source: 'system:eval' },
    ];
    const hit = shortcuts.find(s => s.pattern.test(content));
    return hit ? { fires: true, widget: hit.source } : { fires: false };
}

describe('v6.0 widget-shortcut hijack — fires correctly for explicit asks', () => {
    it('"add the backup widget" → fires, picks system:backup', () => {
        const r = shouldFireShortcut('Add the backup widget');
        expect(r.fires).toBe(true);
        expect(r.widget).toBe('system:backup');
    });

    it('"open the cron panel" → fires, picks system:cron', () => {
        const r = shouldFireShortcut('Open the cron panel');
        expect(r.fires).toBe(true);
        expect(r.widget).toBe('system:cron');
    });

    it('"pin the VRAM dashboard" → fires, picks system:vram', () => {
        const r = shouldFireShortcut('Pin the VRAM dashboard');
        expect(r.fires).toBe(true);
        expect(r.widget).toBe('system:vram');
    });

    it('"give me the training panel" → fires, picks system:training', () => {
        const r = shouldFireShortcut('Give me the training panel');
        expect(r.fires).toBe(true);
        expect(r.widget).toBe('system:training');
    });

    it('"i need the fleet hub" → fires, picks system:fleet', () => {
        const r = shouldFireShortcut('I need the fleet hub');
        expect(r.fires).toBe(true);
        expect(r.widget).toBe('system:fleet');
    });
});

describe('v6.0 widget-shortcut hijack — does NOT fire on agent task prompts', () => {
    // These are the patterns that broke during the v6.0 launch — agent
    // prompts that contained one inner trigger word + one common noun
    // were hijacked into emitting a system widget instead of running the
    // agent loop.

    it('FB correction prompt mentioning "fb_post tool" + "Backup" → does NOT fire', () => {
        const r = shouldFireShortcut(
            'Run the fb_post tool to publish a corrected v6.0 announcement. Drop the RevenueCat bullet and the Backup Manager reference.',
        );
        expect(r.fires).toBe(false);
    });

    it('"tell me about the models you support" → does NOT fire', () => {
        const r = shouldFireShortcut('tell me about the models you support');
        expect(r.fires).toBe(false);
    });

    it('"what backups exist on my system?" → does NOT fire (verb is question, not imperative)', () => {
        const r = shouldFireShortcut('what backups exist on my system?');
        expect(r.fires).toBe(false);
    });

    it('"check the training stats" → does NOT fire (no widget noun, just stats)', () => {
        const r = shouldFireShortcut('check the training stats');
        expect(r.fires).toBe(false);
    });

    it('"the control monitor flagged an issue" → does NOT fire ("monitor" dropped from noun list)', () => {
        const r = shouldFireShortcut('the control monitor flagged an issue');
        expect(r.fires).toBe(false);
    });

    it('"please use the tool_search tool to find fb_post" → does NOT fire ("tools" dropped from noun list)', () => {
        const r = shouldFireShortcut('please use the tool_search tool to find fb_post');
        expect(r.fires).toBe(false);
    });

    it('multi-paragraph agent task referencing many features → does NOT fire', () => {
        const content = [
            'Read the briefing file at /home/dj/.titan/announcements/v6-incoming.md.',
            'It describes a Facebook announcement you are to write and publish for v6.0.',
            'After reading, use the fb_post tool to publish, then report the post URL.',
            'Drop any reference to GEPA, A2A, or RevenueCat — those are not v6.0 banner features.',
        ].join('\n');
        const r = shouldFireShortcut(content);
        expect(r.fires).toBe(false);
    });
});

describe('v6.0 widget-shortcut hijack — Bucket C panels stay gone', () => {
    it('"open the paperclip panel" → does NOT fire (Bucket C / killed)', () => {
        const r = shouldFireShortcut('Open the paperclip panel');
        // imperative + noun match → fires gate, but no shortcut matches
        // because the paperclip row was removed in v6.0 step 1.
        expect(r.fires).toBe(false);
    });

    it('"add the daemon dashboard" → does NOT fire (Bucket C / killed)', () => {
        // Daemon was removed from the shortcut list too — overlapped with
        // Organism. Imperative + noun pass, but no pattern matches.
        const r = shouldFireShortcut('Add the daemon dashboard');
        expect(r.fires).toBe(false);
    });
});

describe('v6.0 widget-shortcut hijack — corner cases', () => {
    it('case insensitive', () => {
        expect(shouldFireShortcut('ADD THE BACKUP WIDGET').fires).toBe(true);
        expect(shouldFireShortcut('add the BACKUP WiDGet').fires).toBe(true);
    });

    it('empty string → does NOT fire', () => {
        expect(shouldFireShortcut('').fires).toBe(false);
    });

    it('imperative without widget noun → does NOT fire', () => {
        expect(shouldFireShortcut('add a backup').fires).toBe(false);
    });

    it('widget noun without imperative → does NOT fire', () => {
        expect(shouldFireShortcut('the backup widget is broken').fires).toBe(false);
    });
});
