/**
 * Ancestor-extraction Batches 2/3 — smoke tests for new modules.
 *
 * Covers: isSimpleTurn, rateLimitTracker, scopedPause, agentScope,
 * trajectory, systemPromptParts bootstrap/per-turn split.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── isSimpleTurn ───────────────────────────────────────────────
import { isSimpleTurn } from '../src/agent/costOptimizer.js';
describe('isSimpleTurn (Hermes simple-turn detector)', () => {
    it('flags trivial greetings as simple', () => {
        expect(isSimpleTurn('hi')).toBe(true);
        expect(isSimpleTurn('what time is it?')).toBe(true);
        expect(isSimpleTurn('who made you?')).toBe(true);
    });
    it('rejects messages with code fences', () => {
        expect(isSimpleTurn('hey `thing`')).toBe(false);
    });
    it('rejects messages with URLs', () => {
        expect(isSimpleTurn('visit https://example.com')).toBe(false);
    });
    it('rejects messages with complex keywords', () => {
        expect(isSimpleTurn('debug this error')).toBe(false);
        expect(isSimpleTurn('implement a new feature')).toBe(false);
        expect(isSimpleTurn('analyze the logs')).toBe(false);
    });
    it('rejects long messages', () => {
        expect(isSimpleTurn('hi '.repeat(100))).toBe(false);
    });
});

// ── Rate limit tracker ─────────────────────────────────────────
import {
    parseRateLimitHeaders,
    recordHeaders,
    getProviderState,
    shouldBackOff,
    __resetRateLimitTrackerForTests,
} from '../src/providers/rateLimitTracker.js';

describe('rateLimitTracker', () => {
    beforeEach(() => __resetRateLimitTrackerForTests());
    it('returns null when no x-ratelimit-* headers present', () => {
        expect(parseRateLimitHeaders({ 'content-type': 'application/json' }, 'openai')).toBeNull();
    });
    it('parses a typical header set', () => {
        const state = parseRateLimitHeaders({
            'x-ratelimit-limit-requests': '60',
            'x-ratelimit-remaining-requests': '10',
            'x-ratelimit-reset-requests': '30',
            'x-ratelimit-limit-tokens': '10000',
            'x-ratelimit-remaining-tokens': '500',
            'x-ratelimit-reset-tokens': '30',
        }, 'openrouter');
        expect(state?.requestsMin.limit).toBe(60);
        expect(state?.requestsMin.remaining).toBe(10);
        expect(state?.tokensMin.remaining).toBe(500);
    });
    it('recordHeaders + getProviderState round-trip', () => {
        recordHeaders('nous', {
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-remaining-requests': '100',
            'x-ratelimit-reset-requests': '60',
        });
        const s = getProviderState('nous');
        expect(s?.requestsMin.limit).toBe(100);
    });
    it('shouldBackOff fires when requests-per-minute ≤ 2', () => {
        recordHeaders('some-provider', {
            'x-ratelimit-limit-requests': '60',
            'x-ratelimit-remaining-requests': '1',
            'x-ratelimit-reset-requests': '30',
        });
        const hint = shouldBackOff('some-provider');
        expect(hint).not.toBeNull();
        expect(hint!.reason).toContain('req/min');
    });
    it('shouldBackOff is null when plenty of headroom', () => {
        recordHeaders('healthy-provider', {
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-remaining-requests': '85',
            'x-ratelimit-reset-requests': '30',
        });
        expect(shouldBackOff('healthy-provider')).toBeNull();
    });
    it('shouldBackOff returns null for unknown providers', () => {
        expect(shouldBackOff('never-seen')).toBeNull();
    });
});

// ── Scoped pause ───────────────────────────────────────────────
import {
    pauseTarget,
    isTargetPaused,
    resumeTarget,
    listActivePauses,
    __resetScopedPausesForTests,
} from '../src/safety/scopedPause.js';

describe('scopedPause', () => {
    beforeEach(() => __resetScopedPausesForTests());
    it('pause + isTargetPaused round-trip', () => {
        pauseTarget('/opt/TITAN/src/a.ts', 'fix_oscillation');
        expect(isTargetPaused('/opt/TITAN/src/a.ts')).toBe(true);
        expect(isTargetPaused('/opt/TITAN/src/b.ts')).toBe(false);
    });
    it('cooldown expires and the target becomes unpaused', async () => {
        pauseTarget('/tmp/x', 'fix_oscillation', { cooldownMs: 50 });
        expect(isTargetPaused('/tmp/x')).toBe(true);
        await new Promise(r => setTimeout(r, 100));
        expect(isTargetPaused('/tmp/x')).toBe(false);
    });
    it('re-pausing extends the cooldown, never shortens', () => {
        const first = pauseTarget('/opt/TITAN/src/x.ts', 'fix_oscillation', { cooldownMs: 10_000 });
        // Try shortening — should NOT reduce
        pauseTarget('/opt/TITAN/src/x.ts', 'fix_oscillation', { cooldownMs: 1_000 });
        const active = listActivePauses();
        const entry = active.find(e => e.target === '/opt/TITAN/src/x.ts')!;
        expect(entry.until).toBeGreaterThanOrEqual(first.until);
    });
    it('resumeTarget lifts the pause early', () => {
        pauseTarget('/some/file', 'manual', { cooldownMs: 60_000 });
        expect(isTargetPaused('/some/file')).toBe(true);
        expect(resumeTarget('/some/file', 'tester')).toBe(true);
        expect(isTargetPaused('/some/file')).toBe(false);
    });
});

// ── Agent scope ────────────────────────────────────────────────
const mockLoadConfig = vi.fn();
vi.mock('../src/config/config.js', () => ({
    loadConfig: () => mockLoadConfig(),
}));
import {
    resolveAgentConfig,
    listConfiguredAgentIds,
    agentAllowsSkill,
} from '../src/agent/agentScope.js';

describe('agentScope', () => {
    beforeEach(() => mockLoadConfig.mockReset());
    it('returns null for agent not in config', () => {
        mockLoadConfig.mockReturnValue({ agents: {} });
        expect(resolveAgentConfig('ghost')).toBeNull();
    });
    it('resolves defaults + entry overrides', () => {
        mockLoadConfig.mockReturnValue({
            agents: {
                defaults: { model: 'ollama/minimax-m2.7:cloud', maxRounds: 10 },
                entries: {
                    'coder-rust': {
                        name: 'Rust Coder',
                        template: 'builder',
                        model: 'ollama/glm-5.1:cloud',
                        skillsFilter: ['shell', 'read_file', 'write_file'],
                        tags: ['code', 'rust'],
                    },
                },
            },
        });
        const r = resolveAgentConfig('coder-rust');
        expect(r).not.toBeNull();
        expect(r!.name).toBe('Rust Coder');
        expect(r!.model).toBe('ollama/glm-5.1:cloud');
        expect(r!.maxRounds).toBe(10);  // from defaults
        expect(r!.skillsFilter).toEqual(['shell', 'read_file', 'write_file']);
        expect(r!.tags).toEqual(['code', 'rust']);
    });
    it('listConfiguredAgentIds excludes disabled entries', () => {
        mockLoadConfig.mockReturnValue({
            agents: { entries: { a: { template: 'scout' }, b: { template: 'scout', enabled: false } } },
        });
        expect(listConfiguredAgentIds()).toEqual(['a']);
    });
    it('agentAllowsSkill with wildcard', () => {
        mockLoadConfig.mockReturnValue({
            agents: { entries: { gh: { skillsFilter: ['github_*', 'shell'] } } },
        });
        const r = resolveAgentConfig('gh')!;
        expect(agentAllowsSkill(r, 'github_issues')).toBe(true);
        expect(agentAllowsSkill(r, 'github_prs')).toBe(true);
        expect(agentAllowsSkill(r, 'shell')).toBe(true);
        expect(agentAllowsSkill(r, 'web_search')).toBe(false);
    });
    it('agentAllowsSkill returns true when no filter set', () => {
        mockLoadConfig.mockReturnValue({
            agents: { entries: { unrestricted: {} } },
        });
        const r = resolveAgentConfig('unrestricted')!;
        expect(agentAllowsSkill(r, 'anything')).toBe(true);
    });
});

// Trajectory logger tests live in tests/trajectory.test.ts — isolated there
// because vi.mock hoisting + the TITAN_HOME getter lexical-closure pattern
// only works cleanly when the mock is the first code in the file.

// ── Bootstrap / per-turn split ─────────────────────────────────
import { assembleBootstrapPrompt, assemblePerTurnPrompt } from '../src/agent/systemPromptParts.js';

describe('systemPromptParts — bootstrap/per-turn split', () => {
    it('bootstrap contains tool-use core + identity but not dynamic context', () => {
        const boot = assembleBootstrapPrompt({ modelId: 'ollama/minimax-m2.7:cloud', persona: 'default', mode: 'full' });
        expect(boot).toContain('Tool Use');
        expect(boot).toContain('TITAN');
        expect(boot).not.toContain('Local:');  // date/time would be perTurn
    });
    it('perTurn is just the dynamic context, nothing else', () => {
        const p = assemblePerTurnPrompt('## Date\n2026-04-20');
        expect(p).toBe('## Date\n2026-04-20');
    });
    it('bootstrap + perTurn ≈ full assembleSystemPrompt', async () => {
        const { assembleSystemPrompt } = await import('../src/agent/systemPromptParts.js');
        const boot = assembleBootstrapPrompt({ modelId: 'anthropic/claude-sonnet-4', persona: 'default', mode: 'full' });
        const full = assembleSystemPrompt({ modelId: 'anthropic/claude-sonnet-4', persona: 'default', mode: 'full', dynamicContext: '## Ctx\nhello' });
        expect(full).toContain(boot);
        expect(full).toContain('hello');
    });
});
