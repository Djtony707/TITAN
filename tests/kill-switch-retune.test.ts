/**
 * Ancestor-extraction Batch 1 — Kill switch retune tests.
 *
 * Verifies:
 *  - Paths under self-mod-staging/ / /tmp/titan- are exempt from counting
 *  - New threshold (8 per-target in 1h) replaces the old (2 per-target in 24h)
 *  - Non-exempt paths still count and still fire kill when the threshold
 *    is reached (we don't want to LOWER real oscillation safety)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/security/auditLog.js', () => ({
    logAudit: vi.fn(),
}));

// Set TITAN_HOME to a temp dir so each test gets an isolated state file
let testHome: string;
vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return {
        ...actual,
        get TITAN_HOME() { return testHome; },
    };
});

// Defer importing the module until after the mock is in place
let recordFixOscillation: typeof import('../src/safety/killSwitch.js').recordFixOscillation;
let getState: typeof import('../src/safety/killSwitch.js').getState;
let resume: typeof import('../src/safety/killSwitch.js').resume;

beforeEach(async () => {
    testHome = mkdtempSync(join(tmpdir(), 'titan-killswitch-retune-'));
    // Reload the module for a clean cache
    vi.resetModules();
    const mod = await import('../src/safety/killSwitch.js');
    recordFixOscillation = mod.recordFixOscillation;
    getState = mod.getState;
    resume = mod.resume;
});

afterEach(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('killSwitch — path exemption', () => {
    it('does NOT fire kill for self-mod-staging paths even at 10× writes', () => {
        for (let i = 0; i < 10; i++) {
            recordFixOscillation('file:/home/dj/.titan/self-mod-staging/75ed1d45/lib/recovery/cleanup.ts');
        }
        expect(getState().status).toBe('armed');
    });

    it('does NOT fire for /opt/TITAN/self-mod-staging paths', () => {
        for (let i = 0; i < 10; i++) {
            recordFixOscillation('file:/opt/TITAN/self-mod-staging/abc/defer.ts');
        }
        expect(getState().status).toBe('armed');
    });

    it('does NOT fire for /tmp/titan-* scratch paths', () => {
        for (let i = 0; i < 10; i++) {
            recordFixOscillation('write:/tmp/titan-probe-output.json');
        }
        expect(getState().status).toBe('armed');
    });
});

describe('killSwitch — non-exempt paths still trigger', () => {
    it('fires kill when a production file hits the new 8× threshold', async () => {
        // 7 events → still armed
        for (let i = 0; i < 7; i++) {
            recordFixOscillation('file:/home/user/project/src/agent/agent.ts');
        }
        expect(getState().status).toBe('armed');

        // 8th event → kill
        recordFixOscillation('file:/home/user/project/src/agent/agent.ts');
        // Kill is async (disableAutopilot, etc.) — poll briefly
        for (let i = 0; i < 10; i++) {
            if (getState().status === 'killed') break;
            await new Promise(r => setTimeout(r, 20));
        }
        expect(getState().status).toBe('killed');
        expect(getState().lastEvent?.trigger).toBe('fix_oscillation');

        // Resume so afterEach can clean state
        await resume('test', 'test cleanup');
    });

    it('does NOT fire at the OLD 2× threshold on non-exempt paths', () => {
        recordFixOscillation('file:/home/user/project/src/skills/foo.ts');
        recordFixOscillation('file:/home/user/project/src/skills/foo.ts');
        expect(getState().status).toBe('armed');
    });
});

describe('killSwitch — different targets counted separately', () => {
    it('4 writes spread across 4 files do not trigger even though total ≥5', () => {
        recordFixOscillation('file:/opt/TITAN/src/a.ts');
        recordFixOscillation('file:/opt/TITAN/src/b.ts');
        recordFixOscillation('file:/opt/TITAN/src/c.ts');
        recordFixOscillation('file:/opt/TITAN/src/d.ts');
        expect(getState().status).toBe('armed');
    });
});
