/**
 * TITAN — Auto-Mode Classifier unit tests (v6.1.0-beta.16, Phase D.4)
 *
 * Covers:
 *   - The riskLevel → decision mapping for each policy (standard,
 *     paranoid, permissive, yolo).
 *   - Unknown-tool defaults (no contract → 'gate').
 *   - The shouldGate helper.
 *   - The formatBreadcrumb output.
 *   - The yolo-warning fires exactly once per process.
 *
 * Doesn't exercise the toolRunner wire-in itself — that's covered
 * indirectly by the existing tool-runner tests + the mission-e2e
 * suite, which now run with the classifier active.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { z } from 'zod';

// Mock loadConfig so the policy field is controllable per-test. We
// hoist the config object so each test can mutate it before the
// classifier reads it.
const { configHolder } = vi.hoisted(() => ({
    configHolder: { current: {} as Record<string, unknown> },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => configHolder.current,
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    classifyToolCall,
    getAutoModePolicy,
    shouldGate,
    formatBreadcrumb,
    _resetYoloWarning,
} from '../src/agent/autoModeClassifier.js';
import {
    registerToolContract,
    clearToolContracts,
    type ToolContract,
} from '../src/agent/toolContract.js';

/* ──────────────────────────  Fixtures  ────────────────────────── */

function setPolicy(policy?: string): void {
    configHolder.current = policy
        ? { security: { autoMode: { policy } } }
        : {};
}

function makeContract(name: string, riskLevel: 'safe' | 'moderate' | 'high'): ToolContract {
    return {
        name,
        summary: `test contract for ${name}`,
        input: z.object({}),
        sideEffects: ['read'],
        riskLevel,
        exampleCalls: [{ description: 'ex', args: {} }],
    };
}

// beta.21 — vitest.config.ts sets TITAN_AUTOMODE_POLICY=yolo globally so
// pre-classifier toolRunner tests can run without rewiring approval. The
// classifier's own tests need to control policy via the mocked config,
// so capture the global env override here and clear it for the duration
// of this file. Restored in afterEach.
const ORIGINAL_AUTOMODE_ENV = process.env.TITAN_AUTOMODE_POLICY;

beforeEach(() => {
    clearToolContracts();
    setPolicy(undefined);
    delete process.env.TITAN_AUTOMODE_POLICY;
    _resetYoloWarning();
});

afterEach(() => {
    setPolicy(undefined);
    if (ORIGINAL_AUTOMODE_ENV === undefined) {
        delete process.env.TITAN_AUTOMODE_POLICY;
    } else {
        process.env.TITAN_AUTOMODE_POLICY = ORIGINAL_AUTOMODE_ENV;
    }
});

/* ──────────────────────────  Policy resolution  ────────────────────────── */

describe('getAutoModePolicy', () => {
    it('defaults to "standard" when no config is set', () => {
        expect(getAutoModePolicy()).toBe('standard');
    });

    it.each(['standard', 'paranoid', 'permissive', 'yolo'])(
        'resolves a valid policy: %s',
        (policy) => {
            setPolicy(policy);
            expect(getAutoModePolicy()).toBe(policy);
        },
    );

    it('falls back to standard for an unrecognised policy string', () => {
        setPolicy('crazy-mode');
        expect(getAutoModePolicy()).toBe('standard');
    });
});

/* ──────────────────────────  Standard policy  ────────────────────────── */

describe('classifyToolCall — standard policy', () => {
    it('returns "auto" for a safe contract', () => {
        registerToolContract(makeContract('safe-tool', 'safe'));
        const r = classifyToolCall('safe-tool');
        expect(r.decision).toBe('auto');
        expect(r.riskLevel).toBe('safe');
        expect(r.policy).toBe('standard');
    });

    it('returns "notify" for a moderate contract', () => {
        registerToolContract(makeContract('moderate-tool', 'moderate'));
        const r = classifyToolCall('moderate-tool');
        expect(r.decision).toBe('notify');
        expect(r.riskLevel).toBe('moderate');
    });

    it('returns "gate" for a high-risk contract', () => {
        registerToolContract(makeContract('high-tool', 'high'));
        const r = classifyToolCall('high-tool');
        expect(r.decision).toBe('gate');
        expect(r.riskLevel).toBe('high');
    });

    it('returns "gate" for an unknown tool (no contract registered)', () => {
        const r = classifyToolCall('mystery-tool');
        expect(r.decision).toBe('gate');
        expect(r.reason).toMatch(/no contract/);
        expect(r.riskLevel).toBeUndefined();
    });
});

/* ──────────────────────────  Paranoid policy  ────────────────────────── */

describe('classifyToolCall — paranoid policy', () => {
    beforeEach(() => setPolicy('paranoid'));

    it.each(['safe', 'moderate', 'high'] as const)(
        'gates a %s tool regardless of riskLevel',
        (level) => {
            registerToolContract(makeContract('any', level));
            expect(classifyToolCall('any').decision).toBe('gate');
        },
    );

    it('gates an unknown tool too', () => {
        expect(classifyToolCall('nobody-home').decision).toBe('gate');
    });

    it('reason names the policy explicitly', () => {
        registerToolContract(makeContract('safe-tool', 'safe'));
        const r = classifyToolCall('safe-tool');
        expect(r.reason).toMatch(/paranoid policy/);
    });
});

/* ──────────────────────────  Permissive policy  ────────────────────────── */

describe('classifyToolCall — permissive policy', () => {
    beforeEach(() => setPolicy('permissive'));

    it('keeps safe as "auto"', () => {
        registerToolContract(makeContract('safe-tool', 'safe'));
        expect(classifyToolCall('safe-tool').decision).toBe('auto');
    });

    it('promotes moderate to "auto"', () => {
        registerToolContract(makeContract('moderate-tool', 'moderate'));
        const r = classifyToolCall('moderate-tool');
        expect(r.decision).toBe('auto');
        expect(r.reason).toMatch(/permissive policy/);
    });

    it('still gates high', () => {
        registerToolContract(makeContract('high-tool', 'high'));
        expect(classifyToolCall('high-tool').decision).toBe('gate');
    });

    it('still gates unknown tools (no contract = conservative)', () => {
        expect(classifyToolCall('nobody-home').decision).toBe('gate');
    });
});

/* ──────────────────────────  Yolo policy  ────────────────────────── */

describe('classifyToolCall — yolo policy', () => {
    beforeEach(() => setPolicy('yolo'));

    it.each(['safe', 'moderate', 'high'] as const)(
        'auto-runs a %s tool',
        (level) => {
            registerToolContract(makeContract('any', level));
            expect(classifyToolCall('any').decision).toBe('auto');
        },
    );

    it('auto-runs an unknown tool too (this is what makes yolo dangerous)', () => {
        expect(classifyToolCall('nobody-home').decision).toBe('auto');
    });

    it('only emits the loud warning ONCE per process even across many calls', async () => {
        const { default: logger } = await import('../src/utils/logger.js') as { default: { warn: ReturnType<typeof vi.fn> } };
        const warnSpy = logger.warn;
        warnSpy.mockClear();
        registerToolContract(makeContract('a', 'safe'));
        classifyToolCall('a');
        classifyToolCall('a');
        classifyToolCall('a');
        // Filter to warnings from the autoMode component
        const yoloWarns = warnSpy.mock.calls.filter(
            (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('autoMode'),
        );
        expect(yoloWarns.length).toBe(1);
    });
});

/* ──────────────────────────  Helpers  ────────────────────────── */

describe('shouldGate', () => {
    it('returns true for gate, false otherwise', () => {
        expect(shouldGate({ decision: 'gate', reason: '', policy: 'standard' })).toBe(true);
        expect(shouldGate({ decision: 'auto', reason: '', policy: 'standard' })).toBe(false);
        expect(shouldGate({ decision: 'notify', reason: '', policy: 'standard' })).toBe(false);
    });
});

describe('formatBreadcrumb', () => {
    it('produces a single-line breadcrumb naming the tool + decision + risk + policy', () => {
        const line = formatBreadcrumb('write_file', {
            decision: 'auto',
            reason: 'contract riskLevel=safe',
            policy: 'standard',
            riskLevel: 'safe',
        });
        expect(line).toMatch(/automode:auto/);
        expect(line).toMatch(/tool=write_file/);
        expect(line).toMatch(/risk=safe/);
        expect(line).toMatch(/policy=standard/);
        expect(line).toMatch(/contract riskLevel=safe/);
    });

    it('renders risk=unknown when the contract is missing', () => {
        const line = formatBreadcrumb('mystery', {
            decision: 'gate',
            reason: 'no contract',
            policy: 'standard',
        });
        expect(line).toMatch(/risk=unknown/);
    });
});

/* ──────────────────────────  Integration with canonical contracts  ────────────────────────── */

describe('classifyToolCall — canonical skill contracts', () => {
    beforeEach(async () => {
        // Pull in the actual canonical contracts so the classifier runs
        // against real production data, not test fixtures.
        const { registerCanonicalContracts } = await import('../src/skills/builtin/contracts.js');
        registerCanonicalContracts();
    });

    it('read_file → auto (read-only)', () => {
        expect(classifyToolCall('read_file').decision).toBe('auto');
    });

    it('list_dir → auto (read-only)', () => {
        expect(classifyToolCall('list_dir').decision).toBe('auto');
    });

    // beta.17 fix (Codex P1 #2 + #4): writes are moderate, not safe.
    // Auto-mode treats moderate as `notify` — the call runs but logs
    // a breadcrumb instead of fully silent auto. Path-aware
    // classification (allowing /tmp/* writes to fully auto-run) is a
    // follow-up; until then writes notify so an autonomous overwrite
    // is at least visible in the log/trajectory.
    it('write_file → notify (moderate — was safe; bumped in beta.17)', () => {
        expect(classifyToolCall('write_file').decision).toBe('notify');
    });

    it('edit_file → notify (moderate — was safe; bumped in beta.17)', () => {
        expect(classifyToolCall('edit_file').decision).toBe('notify');
    });

    it('append_file → notify (moderate — was safe; bumped in beta.17)', () => {
        expect(classifyToolCall('append_file').decision).toBe('notify');
    });

    it('web_search → notify (moderate, network)', () => {
        expect(classifyToolCall('web_search').decision).toBe('notify');
    });

    it('web_fetch → notify (moderate, network)', () => {
        expect(classifyToolCall('web_fetch').decision).toBe('notify');
    });

    it('download_image → notify (moderate, network + write)', () => {
        expect(classifyToolCall('download_image').decision).toBe('notify');
    });

    it('shell → gate (high risk, destructive)', () => {
        expect(classifyToolCall('shell').decision).toBe('gate');
    });
});
