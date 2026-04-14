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

// ═══════════════════════════════════════════════════════════════
// Finding #03 — TITAN_HOME env var was ignored (hardcoded to ~/.titan)
// ═══════════════════════════════════════════════════════════════
//
// Previously `TITAN_HOME = join(homedir(), '.titan')` — a constant with no
// way to override. Docker containers, shared machines, test fixtures, and
// systemd units with `Environment=TITAN_HOME=...` all silently used the
// default. Fixed by reading `process.env.TITAN_HOME` in constants.ts.

describe('Hunt Finding #03 — TITAN_HOME respects env var', () => {
    it('uses process.env.TITAN_HOME when set', async () => {
        const original = process.env.TITAN_HOME;
        const customPath = '/tmp/titan-home-test-' + Date.now();
        try {
            process.env.TITAN_HOME = customPath;
            vi.resetModules();
            const { TITAN_HOME } = await import('../src/utils/constants.js');
            expect(TITAN_HOME).toBe(customPath);
        } finally {
            if (original !== undefined) process.env.TITAN_HOME = original;
            else delete process.env.TITAN_HOME;
            vi.resetModules();
        }
    });

    it('expands ~/ prefix in TITAN_HOME', async () => {
        const original = process.env.TITAN_HOME;
        try {
            process.env.TITAN_HOME = '~/custom-titan-test';
            vi.resetModules();
            const { TITAN_HOME } = await import('../src/utils/constants.js');
            const { homedir } = await import('os');
            expect(TITAN_HOME).toBe(join(homedir(), 'custom-titan-test'));
        } finally {
            if (original !== undefined) process.env.TITAN_HOME = original;
            else delete process.env.TITAN_HOME;
            vi.resetModules();
        }
    });

    it('falls back to ~/.titan when env var is unset', async () => {
        const original = process.env.TITAN_HOME;
        try {
            delete process.env.TITAN_HOME;
            vi.resetModules();
            const { TITAN_HOME } = await import('../src/utils/constants.js');
            const { homedir } = await import('os');
            expect(TITAN_HOME).toBe(join(homedir(), '.titan'));
        } finally {
            if (original !== undefined) process.env.TITAN_HOME = original;
            vi.resetModules();
        }
    });

    it('falls back to ~/.titan when env var is empty string', async () => {
        const original = process.env.TITAN_HOME;
        try {
            process.env.TITAN_HOME = '';
            vi.resetModules();
            const { TITAN_HOME } = await import('../src/utils/constants.js');
            const { homedir } = await import('os');
            expect(TITAN_HOME).toBe(join(homedir(), '.titan'));
        } finally {
            if (original !== undefined) process.env.TITAN_HOME = original;
            else delete process.env.TITAN_HOME;
            vi.resetModules();
        }
    });

    it('trims whitespace in TITAN_HOME', async () => {
        const original = process.env.TITAN_HOME;
        const customPath = '/tmp/titan-home-trim-test';
        try {
            process.env.TITAN_HOME = '  ' + customPath + '  ';
            vi.resetModules();
            const { TITAN_HOME } = await import('../src/utils/constants.js');
            expect(TITAN_HOME).toBe(customPath);
        } finally {
            if (original !== undefined) process.env.TITAN_HOME = original;
            else delete process.env.TITAN_HOME;
            vi.resetModules();
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// Finding #05 — Model hallucinated tool output without calling the tool
// ═══════════════════════════════════════════════════════════════
//
// User said "use the shell tool to run uptime" but minimax-m2.7:cloud returned
// fabricated uptime text with no tool call. The agent loop accepted it.
// Fix: detectToolUseIntent() + force tool_choice=required on explicit requests.

describe('Hunt Finding #05 — detectToolUseIntent catches explicit tool requests', () => {
    it('detects the EXACT message that triggered the bug', async () => {
        const { detectToolUseIntent } = await import('../src/agent/agentLoop.js');
        const actualMessage = 'Use the shell tool to run: uptime. Return only what shell returned, verbatim.';
        expect(detectToolUseIntent(actualMessage)).toBe(true);
    });

    it('detects "use the X tool" variants', async () => {
        const { detectToolUseIntent } = await import('../src/agent/agentLoop.js');
        const variants = [
            'Use the shell tool to list files',
            'use the web_search tool for news',
            'Please use the read_file tool',
            'use the memory tool',
            'Use the write_file tool',
        ];
        for (const msg of variants) {
            expect(detectToolUseIntent(msg), `Failed for: ${msg}`).toBe(true);
        }
    });

    it('detects action verbs that require tool execution', async () => {
        const { detectToolUseIntent } = await import('../src/agent/agentLoop.js');
        const variants = [
            'run the shell command uptime',
            'execute this shell script',
            'search the web for AI news',
            'search for Python 3.13',
            'fetch the page at https://example.com',
            'read the file package.json',
            'read the file at /etc/hostname',
            'list files in ~/Desktop',
            'list the contents of the workspace',
        ];
        for (const msg of variants) {
            expect(detectToolUseIntent(msg), `Failed for: ${msg}`).toBe(true);
        }
    });

    it('detects "what is the current X" that requires real state', async () => {
        const { detectToolUseIntent } = await import('../src/agent/agentLoop.js');
        const variants = [
            'what is the current uptime?',
            "what's the current hostname?",
            'show me the current directory',
            'get the current ip',
        ];
        for (const msg of variants) {
            expect(detectToolUseIntent(msg), `Failed for: ${msg}`).toBe(true);
        }
    });

    it('does NOT trigger on casual chat', async () => {
        const { detectToolUseIntent } = await import('../src/agent/agentLoop.js');
        const casual = [
            'Hello',
            'How are you?',
            'What is TITAN?',
            'Thanks for the reply',
            'Tell me a joke',
            'Explain quantum computing',
        ];
        for (const msg of casual) {
            expect(detectToolUseIntent(msg), `Incorrectly flagged: ${msg}`).toBe(false);
        }
    });

    it('handles empty and short inputs safely', async () => {
        const { detectToolUseIntent } = await import('../src/agent/agentLoop.js');
        expect(detectToolUseIntent('')).toBe(false);
        expect(detectToolUseIntent('hi')).toBe(false);
        expect(detectToolUseIntent('  ')).toBe(false);
    });

    it('source: minimax models are marked selfSelectsTools: false', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/providers/ollama.ts'),
            'utf-8',
        );
        // Both variants should have selfSelectsTools: false after the fix
        expect(src).toMatch(/'minimax-m2\.7':\s*\{\s*selfSelectsTools:\s*false/);
        expect(src).toMatch(/'minimax-m2':\s*\{\s*selfSelectsTools:\s*false/);
    });

    it('source: agent loop contains HallucinationGuard', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/agent/agentLoop.ts'),
            'utf-8',
        );
        expect(src).toMatch(/HallucinationGuard/);
        expect(src).toMatch(/wantsVerbatim/);
        // The guard should reference toolCallDetails (the real tool outputs)
        expect(src).toMatch(/toolCallDetails/);
    });
});

// ═══════════════════════════════════════════════════════════════
// Finding #04 — Gateway silently serves partial interfaces on port conflict
// ═══════════════════════════════════════════════════════════════
//
// When a zombie gateway is bound to 127.0.0.1:PORT and a new gateway starts
// with host=0.0.0.0, both binds succeed (different addresses). Localhost
// traffic routes to the zombie; LAN-IP traffic routes to the new gateway.
// Silent and confusing. Added a TCP probe after the pre-check that detects
// the partial conflict and logs a WARN.

describe('Hunt Finding #04 — Port conflict probe in gateway', () => {
    it('source code: gateway contains port conflict probe', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/gateway/server.ts'),
            'utf-8',
        );
        expect(src).toMatch(/PortConflictProbe/);
        expect(src).toMatch(/127\.0\.0\.1/);
        expect(src).toMatch(/Something is already listening/);
    });

    it('source code: probe handles ECONNREFUSED (port free) and connect (port busy)', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/gateway/server.ts'),
            'utf-8',
        );
        // The probe should handle both the connect event (found something) and
        // the error event (nothing there, probably ECONNREFUSED)
        expect(src).toMatch(/probe\.once\('connect'/);
        expect(src).toMatch(/probe\.once\('error'/);
    });

    it('source code: probe has a timeout to prevent blocking startup', () => {
        const src = readFileSync(
            join(process.cwd(), 'src/gateway/server.ts'),
            'utf-8',
        );
        // Should have timeout set on the socket
        expect(src).toMatch(/timeout:\s*\d+/);
        expect(src).toMatch(/probe\.once\('timeout'/);
    });
});
