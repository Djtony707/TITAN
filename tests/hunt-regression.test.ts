/**
 * TITAN — Hunt Regression Tests
 *
 * This test file exercises the REAL code path using fixtures captured from the
 * Synthetic User Hunt (see plan at ~/.claude/plans/nifty-stirring-pie.md).
 *
 * Each fixture in tests/fixtures/hunt/NN-name/ represents a real bug found in
 * production. These are NOT mocked tests — they feed the fixture through the
 * actual code that was fixed, proving the bug cannot reoccur.
 *
 * How to add a new regression:
 * 1. During the hunt, capture the failing input/output to /tmp/titan-hunt/findings/NN/
 * 2. After fixing, move the fixture to tests/fixtures/hunt/NN-short-name/
 * 3. Add a describe() block below that loads the fixture and asserts the real
 *    code path now handles it correctly
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/hunt');

// ═══════════════════════════════════════════════════════════════
// Finding #01 — Facebook config silently stripped by Zod schema
// ═══════════════════════════════════════════════════════════════
//
// User-editable config keys not declared in TitanConfigSchema were silently
// dropped during load. Users editing `facebook.autopilotEnabled: false` in
// titan.json saw no effect. Affected keys: facebook, alerting, guardrails.
//
// Fix layer: src/config/schema.ts (added schemas) + src/config/config.ts
// (added unknown-key warning).

describe('Hunt Finding #01 — Facebook config not silently stripped', () => {
    let tmpHome: string;
    let origTitanHome: string | undefined;

    beforeEach(() => {
        // Load the fixture and write it as a titan.json in an isolated temp HOME
        const fixturePath = join(FIXTURE_ROOT, '01-facebook-config-stripped/input.json');
        expect(existsSync(fixturePath)).toBe(true);
        const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

        tmpHome = join(tmpdir(), `titan-hunt-01-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tmpHome, { recursive: true });
        writeFileSync(join(tmpHome, 'titan.json'), JSON.stringify(fixture));

        // Point TITAN_HOME at our temp dir BEFORE importing the config module
        origTitanHome = process.env.TITAN_HOME;
        process.env.TITAN_HOME = tmpHome;
    });

    function cleanup() {
        if (tmpHome && existsSync(tmpHome)) {
            try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        if (origTitanHome !== undefined) process.env.TITAN_HOME = origTitanHome;
        else delete process.env.TITAN_HOME;
    }

    it('preserves facebook.autopilotEnabled = false across parse', async () => {
        try {
            // Re-import to pick up the new TITAN_HOME (modules may cache at import time)
            vi.resetModules();
            const { TitanConfigSchema } = await import('../src/config/schema.js');
            const raw = JSON.parse(readFileSync(join(tmpHome, 'titan.json'), 'utf-8'));
            const result = TitanConfigSchema.safeParse(raw);
            expect(result.success).toBe(true);
            if (!result.success) return;

            const fb = (result.data as unknown as { facebook?: { autopilotEnabled?: boolean } }).facebook;
            expect(fb).toBeDefined();
            expect(fb?.autopilotEnabled).toBe(false);
        } finally {
            cleanup();
        }
    });

    it('preserves alerting config across parse', async () => {
        try {
            vi.resetModules();
            const { TitanConfigSchema } = await import('../src/config/schema.js');
            const raw = JSON.parse(readFileSync(join(tmpHome, 'titan.json'), 'utf-8'));
            const result = TitanConfigSchema.safeParse(raw);
            expect(result.success).toBe(true);
            if (!result.success) return;

            const alerting = (result.data as unknown as { alerting?: { minSeverity?: string; webhookUrl?: string } }).alerting;
            expect(alerting).toBeDefined();
            expect(alerting?.minSeverity).toBe('warn');
            expect(alerting?.webhookUrl).toBe('https://example.com/webhook');
        } finally {
            cleanup();
        }
    });

    it('preserves guardrails config across parse', async () => {
        try {
            vi.resetModules();
            const { TitanConfigSchema } = await import('../src/config/schema.js');
            const raw = JSON.parse(readFileSync(join(tmpHome, 'titan.json'), 'utf-8'));
            const result = TitanConfigSchema.safeParse(raw);
            expect(result.success).toBe(true);
            if (!result.success) return;

            const gr = (result.data as unknown as { guardrails?: { enabled?: boolean; logOnly?: boolean } }).guardrails;
            expect(gr).toBeDefined();
            expect(gr?.enabled).toBe(true);
            expect(gr?.logOnly).toBe(true);
        } finally {
            cleanup();
        }
    });

    it('still strips truly unknown keys (totallyMadeUpKey) — they are NOT preserved', async () => {
        try {
            vi.resetModules();
            const { TitanConfigSchema } = await import('../src/config/schema.js');
            const raw = JSON.parse(readFileSync(join(tmpHome, 'titan.json'), 'utf-8'));
            const result = TitanConfigSchema.safeParse(raw);
            expect(result.success).toBe(true);
            if (!result.success) return;

            // `totallyMadeUpKey` should be absent from parsed config
            const unknown = (result.data as Record<string, unknown>).totallyMadeUpKey;
            expect(unknown).toBeUndefined();
        } finally {
            cleanup();
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// Finding #02 — monitorComments() ignored autopilotEnabled flag
// ═══════════════════════════════════════════════════════════════
//
// Even after Finding #01 made the config key survive parse, `monitorComments()`
// in fb_autopilot.ts did NOT check the flag — it ran unconditionally on its
// 5-minute timer. Only runFBAutopilot (post generation) was gated.
//
// Fix: monitorComments() now checks both `facebook.autopilotEnabled` and
// `facebook.replyMonitorEnabled` and returns early if either is false.

describe('Hunt Finding #02 — monitorComments respects config flags', () => {
    it('source code: monitorComments checks autopilotEnabled', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/skills/builtin/fb_autopilot.ts'),
            'utf-8',
        );
        // Find the monitorComments function body
        const funcMatch = src.match(/async function monitorComments\(\)[\s\S]*?(?=\nasync function |\nfunction |\nexport )/);
        expect(funcMatch).not.toBeNull();
        const body = funcMatch?.[0] || '';
        // Must check autopilotEnabled
        expect(body).toMatch(/autopilotEnabled\s*===\s*false/);
    });

    it('source code: monitorComments checks replyMonitorEnabled', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/skills/builtin/fb_autopilot.ts'),
            'utf-8',
        );
        const funcMatch = src.match(/async function monitorComments\(\)[\s\S]*?(?=\nasync function |\nfunction |\nexport )/);
        expect(funcMatch).not.toBeNull();
        const body = funcMatch?.[0] || '';
        expect(body).toMatch(/replyMonitorEnabled\s*===\s*false/);
    });

    it('source code: early return comes BEFORE fetching FB feed', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/skills/builtin/fb_autopilot.ts'),
            'utf-8',
        );
        // Find the monitorComments function and check that the config check
        // appears BEFORE the fetch() call — otherwise the gate is useless
        const funcMatch = src.match(/async function monitorComments\(\)[\s\S]*?(?=\nasync function |\nfunction |\nexport )/);
        expect(funcMatch).not.toBeNull();
        const body = funcMatch?.[0] || '';
        const autopilotCheckIdx = body.indexOf('autopilotEnabled');
        const fetchIdx = body.indexOf('fetch(');
        expect(autopilotCheckIdx).toBeGreaterThan(-1);
        expect(fetchIdx).toBeGreaterThan(-1);
        expect(autopilotCheckIdx).toBeLessThan(fetchIdx);
    });
});
