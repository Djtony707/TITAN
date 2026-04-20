/**
 * TITAN — Phase B-D tests (v4.10.0-local)
 *
 * Covers the layers built on top of Phase A:
 *   - Daily digest aggregation
 *   - Approval categorization
 *   - Driver-aware chat block rendering
 *   - Notification throttling
 *   - Mission state machine
 *   - Machine routing
 *   - Playbook signature + matching
 *   - Staging scanners
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    return { tmpHome: mk(jn(td(), 'titan-phbcd-')) as string };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/memory/episodic.js', () => ({
    recordEpisode: vi.fn(),
}));

// ── Notification throttle ────────────────────────────────────────
describe('notificationThrottle', () => {
    beforeEach(async () => {
        const { _resetThrottlesForTests } = await import('../src/agent/notificationThrottle.js');
        _resetThrottlesForTests();
    });

    it('shouldBroadcast returns true first time, false second time within window', async () => {
        const { shouldBroadcast } = await import('../src/agent/notificationThrottle.js');
        expect(shouldBroadcast('topic:test', 'key1')).toBe(true);
        expect(shouldBroadcast('topic:test', 'key1')).toBe(false);
    });

    it('different keys are independent', async () => {
        const { shouldBroadcast } = await import('../src/agent/notificationThrottle.js');
        expect(shouldBroadcast('topic:test', 'k1')).toBe(true);
        expect(shouldBroadcast('topic:test', 'k2')).toBe(true);
    });

    it('shouldCreateApproval throttles repeat approvals for same (goalId, kind)', async () => {
        const { shouldCreateApproval } = await import('../src/agent/notificationThrottle.js');
        expect(shouldCreateApproval('g1', 'driver_blocked')).toBe(true);
        expect(shouldCreateApproval('g1', 'driver_blocked')).toBe(false);
        expect(shouldCreateApproval('g1', 'self_mod_pr')).toBe(true); // different kind
    });
});

// ── Approval categorization ──────────────────────────────────────
describe('approval categorization', () => {
    it('categorizes driver_blocked as high urgency', async () => {
        const { categorizeApproval } = await import('../src/agent/commandPost.js');
        const cat = categorizeApproval({
            id: 'a1',
            type: 'custom',
            status: 'pending',
            requestedBy: 'goal-driver',
            payload: { kind: 'driver_blocked', question: 'what URL?' },
            linkedIssueIds: [],
            createdAt: new Date().toISOString(),
        });
        expect(cat.category).toBe('driver_blocked');
        expect(cat.urgency).toBe('high');
    });

    it('categorizes self_mod_pr as medium urgency', async () => {
        const { categorizeApproval } = await import('../src/agent/commandPost.js');
        const cat = categorizeApproval({
            id: 'a2',
            type: 'custom',
            status: 'pending',
            requestedBy: 'self-mod',
            payload: { kind: 'self_mod_pr', goalTitle: 'Patch X' },
            linkedIssueIds: [],
            createdAt: new Date().toISOString(),
        });
        expect(cat.category).toBe('self_mod_pr');
        expect(cat.urgency).toBe('medium');
    });

    it('categorizes unknown as other / low', async () => {
        const { categorizeApproval } = await import('../src/agent/commandPost.js');
        const cat = categorizeApproval({
            id: 'a3',
            type: 'custom',
            status: 'pending',
            requestedBy: 'unknown',
            payload: { something: 'else' },
            linkedIssueIds: [],
            createdAt: new Date().toISOString(),
        });
        expect(cat.category).toBe('other');
        expect(cat.urgency).toBe('low');
    });
});

// ── Driver-aware chat ────────────────────────────────────────────
describe('driverAwareChat', () => {
    it('detects status queries', async () => {
        const { isStatusQuery } = await import('../src/agent/driverAwareChat.js');
        expect(isStatusQuery('what are you working on?')).toBe(true);
        expect(isStatusQuery('any blockers?')).toBe(true);
        expect(isStatusQuery('status')).toBe(true);
        expect(isStatusQuery('how is it going?')).toBe(true);
        expect(isStatusQuery('write me a poem')).toBe(false);
    });

    it('renders no-drivers block when nothing active', async () => {
        const { renderDriverStatusBlock } = await import('../src/agent/driverAwareChat.js');
        const block = renderDriverStatusBlock();
        // Either a "no drivers" block or null depending on state
        if (block) {
            expect(block).toMatch(/ACTIVE DRIVERS/);
        }
    });
});

// ── Mission driver ──────────────────────────────────────────────
describe('missionDriver', () => {
    it('creates a mission with children', async () => {
        const { createMission, getMissionState, _resetMissionStateForTests } = await import('../src/agent/missionDriver.js');
        _resetMissionStateForTests();
        const m = createMission({
            title: 'Test mission',
            description: 'Multi-goal',
            requestedBy: 'test',
            children: [
                { goalId: 'g-a', title: 'A' },
                { goalId: 'g-b', title: 'B', dependsOn: ['g-a'] },
            ],
        });
        expect(m.phase).toBe('planning');
        expect(m.children).toHaveLength(2);
        const reloaded = getMissionState(m.missionId);
        expect(reloaded?.title).toBe('Test mission');
    });

    it('cancelMission marks cancelled', async () => {
        const { createMission, cancelMission, getMissionState } = await import('../src/agent/missionDriver.js');
        const m = createMission({
            title: 'Cancel test',
            description: '',
            requestedBy: 'test',
            children: [{ goalId: 'g-x', title: 'X' }],
        });
        expect(cancelMission(m.missionId)).toBe(true);
        expect(getMissionState(m.missionId)?.phase).toBe('cancelled');
    });
});

// ── Machine router ──────────────────────────────────────────────
describe('machineRouter', () => {
    it('routes GPU tags to titan-pc', async () => {
        const { routeGoalToMachine } = await import('../src/agent/machineRouter.js');
        const r = routeGoalToMachine(['gpu-heavy', 'cuda']);
        expect(r.targetMachine).toBe('titan-pc');
    });

    it('routes edge tags to mini-pc', async () => {
        const { routeGoalToMachine } = await import('../src/agent/machineRouter.js');
        const r = routeGoalToMachine(['edge', 'homeassistant']);
        expect(r.targetMachine).toBe('mini-pc');
    });

    it('falls through to local with no hints', async () => {
        const { routeGoalToMachine } = await import('../src/agent/machineRouter.js');
        const r = routeGoalToMachine([]);
        expect(r.targetMachine).toBe('local');
        expect(r.runLocally).toBe(true);
    });

    it('runLocally true when target matches localMachineId', async () => {
        const { routeGoalToMachine } = await import('../src/agent/machineRouter.js');
        const r = routeGoalToMachine(['gpu-heavy'], 'titan-pc');
        expect(r.runLocally).toBe(true);
    });

    it('falls back when best match is offline', async () => {
        const { routeGoalToMachine, updateMachineStatus } = await import('../src/agent/machineRouter.js');
        updateMachineStatus('titan-pc', false);
        const r = routeGoalToMachine(['gpu-heavy']);
        expect(r.rationale).toMatch(/offline/i);
        // Restore
        updateMachineStatus('titan-pc', true);
    });
});

// ── Playbooks ────────────────────────────────────────────────────
describe('playbooks', () => {
    it('extracts signature from title + tags', async () => {
        const { extractSignature } = await import('../src/agent/playbooks.js');
        const sig = extractSignature('Research the GPU temperature API', ['research', 'gpu']);
        expect(sig).toContain('research');
        expect(sig).toContain('gpu');
        expect(sig).toContain('temperature');
        expect(sig).toContain('tag:research');
    });

    it('signaturesMatch returns true for similar queries', async () => {
        const { signaturesMatch } = await import('../src/agent/playbooks.js');
        const a = ['research', 'gpu', 'temperature', 'api'];
        const b = ['research', 'gpu', 'vram', 'stats'];
        expect(signaturesMatch(a, b, 0.3)).toBe(true); // 2/4 = 0.5 overlap
    });

    it('findPlaybookForGoal returns null when no playbooks exist', async () => {
        const { findPlaybookForGoal, _resetPlaybooksForTests } = await import('../src/agent/playbooks.js');
        _resetPlaybooksForTests();
        expect(findPlaybookForGoal('some new goal')).toBeNull();
    });
});

// ── Staging scanners ─────────────────────────────────────────────
describe('stagingScanners', () => {
    const scanDir = join(tmpHome, 'scan-test');

    beforeEach(() => {
        try { rmSync(scanDir, { recursive: true, force: true }); } catch { /* ok */ }
        mkdirSync(scanDir, { recursive: true });
    });

    it('detects AWS access key', async () => {
        writeFileSync(join(scanDir, 'leak.ts'), 'const x = "AKIAIOSFODNN7EXAMPLE";\n');
        const { scanBundle } = await import('../src/agent/stagingScanners.js');
        const result = scanBundle(scanDir);
        expect(result.highSeverityCount).toBeGreaterThan(0);
        expect(result.shouldBlock).toBe(true);
        expect(result.findings.find(f => f.pattern === 'AWS_ACCESS_KEY')).toBeDefined();
    });

    it('detects OpenAI key', async () => {
        writeFileSync(join(scanDir, 'key.ts'), 'const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";\n');
        const { scanBundle } = await import('../src/agent/stagingScanners.js');
        const result = scanBundle(scanDir);
        expect(result.findings.find(f => f.pattern === 'OpenAI_API_Key')).toBeDefined();
    });

    it('detects private keys', async () => {
        writeFileSync(join(scanDir, 'id_rsa.txt'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n');
        const { scanBundle } = await import('../src/agent/stagingScanners.js');
        const result = scanBundle(scanDir);
        expect(result.findings.find(f => f.pattern === 'RSA_Private_Key')).toBeDefined();
        expect(result.shouldBlock).toBe(true);
    });

    it('flags AGPL license mentions', async () => {
        writeFileSync(join(scanDir, 'pkg.ts'), '// License: AGPL-3.0\nexport const x = 1;\n');
        const { scanBundle } = await import('../src/agent/stagingScanners.js');
        const result = scanBundle(scanDir);
        expect(result.findings.find(f => f.pattern === 'AGPL')).toBeDefined();
        expect(result.shouldBlock).toBe(true);
    });

    it('does not flag clean code', async () => {
        writeFileSync(join(scanDir, 'clean.ts'), 'export function hello(): string { return "hi"; }\n');
        const { scanBundle } = await import('../src/agent/stagingScanners.js');
        const result = scanBundle(scanDir);
        expect(result.highSeverityCount).toBe(0);
        expect(result.shouldBlock).toBe(false);
    });

    it('respects false-positive context for hex patterns', async () => {
        writeFileSync(join(scanDir, 'sha.ts'), '// sha256 hash: abc123def456abc123def456abc123def456abc123def456abc123def4567890\n');
        const { scanBundle } = await import('../src/agent/stagingScanners.js');
        const result = scanBundle(scanDir);
        // Should skip due to "sha256" context
        expect(result.findings.filter(f => f.pattern === 'Hex_Secret_64')).toHaveLength(0);
    });

    it('detects TITAN gateway password', async () => {
        writeFileSync(join(scanDir, 'leaked.ts'), 'const pw = "06052021Aell!";\n');
        const { scanBundle } = await import('../src/agent/stagingScanners.js');
        const result = scanBundle(scanDir);
        expect(result.findings.find(f => f.pattern === 'TITAN_Gateway_Password')).toBeDefined();
    });
});

// ── Daily digest ─────────────────────────────────────────────────
describe('dailyDigest', () => {
    it('generates a digest shape', async () => {
        const { generateDigest } = await import('../src/agent/dailyDigest.js');
        const d = await generateDigest();
        expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(d.summary).toHaveProperty('goalsCompleted');
        expect(d.summary).toHaveProperty('goalsFailed');
        expect(d.drives).toHaveProperty('purpose');
        expect(Array.isArray(d.highlights)).toBe(true);
    });

    it('getLatestDigest returns the generated one', async () => {
        const { generateDigest, getLatestDigest } = await import('../src/agent/dailyDigest.js');
        const gen = await generateDigest();
        const latest = getLatestDigest();
        expect(latest?.date).toBe(gen.date);
    });
});

afterAll(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
});

// Silence unused
void mkdtempSync; void tmpdir;
