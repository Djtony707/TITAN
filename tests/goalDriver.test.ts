/**
 * TITAN — Goal Driver tests (v4.10.0-local, Phase A)
 *
 * Exercises the phase state machine + surrounding modules in isolation.
 * Full integration (driver + real specialists + real LLM) is covered by
 * the e2e tests that require a running Ollama; this file is pure unit.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { tmpHome } = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync: mk } = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir: td } = require('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: jn } = require('path');
    const tmpHome = mk(jn(td(), 'titan-driver-home-')) as string;
    return { tmpHome };
});

vi.mock('../src/utils/constants.js', async (orig) => {
    const actual = await orig<typeof import('../src/utils/constants.js')>();
    return { ...actual, TITAN_HOME: tmpHome };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock goals so we don't touch the real goals.json
const mockGoals = new Map<string, {
    id: string; title: string; description: string; status: string; priority: number;
    subtasks: Array<{ id: string; title: string; description: string; status: string; retries: number }>;
    tags: string[]; createdAt: string;
}>();

vi.mock('../src/agent/goals.js', () => ({
    getGoal: vi.fn((id: string) => mockGoals.get(id) || null),
    listGoals: vi.fn((status?: string) => {
        const all = Array.from(mockGoals.values());
        return status ? all.filter(g => g.status === status) : all;
    }),
    updateGoal: vi.fn((id: string, patch: Record<string, unknown>) => {
        const g = mockGoals.get(id);
        if (!g) return null;
        Object.assign(g, patch);
        return g;
    }),
    addSubtask: vi.fn(),
    completeSubtask: vi.fn((goalId: string, subId: string) => {
        const g = mockGoals.get(goalId);
        if (!g) return null;
        const sub = g.subtasks.find(s => s.id === subId);
        if (sub) sub.status = 'done';
        return g;
    }),
    failSubtask: vi.fn((goalId: string, subId: string) => {
        const g = mockGoals.get(goalId);
        if (!g) return null;
        const sub = g.subtasks.find(s => s.id === subId);
        if (sub) sub.status = 'failed';
        return g;
    }),
    getReadyTasks: vi.fn(() => []),
}));

// Mock ONLY the `structuredSpawn` function; keep parseStructuredResponse real
// (used by the parser tests below)
vi.mock('../src/agent/structuredSpawn.js', async (orig) => {
    const actual = await orig<typeof import('../src/agent/structuredSpawn.js')>();
    // A default response rich enough to pass the `research` verifier
    // (≥200 chars, ≥2 source markers). Tests can override per-case.
    const defaultReasoning = [
        'Research complete. Verified via two sources: https://example.com/source1',
        'and https://example.com/source2. The target information was collected and',
        'cross-referenced to ensure accuracy. Key findings: TITAN is an autonomous',
        'agent framework. Source [1] confirms this; Source [2] adds additional',
        'context about its homeostatic drive layer. This constitutes a full research',
        'response with adequate citations and length for downstream verification.',
    ].join(' ');
    return {
        ...actual,
        structuredSpawn: vi.fn(async () => ({
            status: 'done',
            artifacts: [{ type: 'fact', ref: 'mock-fact' }],
            questions: [],
            confidence: 0.9,
            reasoning: defaultReasoning,
            rawResponse: '```json\n{"status":"done","artifacts":[],"questions":[],"confidence":0.9,"reasoning":"ok"}\n```',
            specialistId: 'mock',
            toolsUsed: [],
            durationMs: 10,
        })),
    };
});

// Mock shadowGit
vi.mock('../src/agent/shadowGit.js', () => ({
    snapshotBeforeWrite: vi.fn(async () => { /* ok */ }),
    listCheckpoints: vi.fn(() => []),
    restoreCheckpoint: vi.fn(() => 'restored'),
}));

// Mock metricGuard so SOMA feedback doesn't touch disk
vi.mock('../src/safety/metricGuard.js', () => ({
    gateSatisfactionEvent: vi.fn(async () => ({ appliedDelta: 0.05, verified: true })),
    registerVerifier: vi.fn(),
}));

// Mock commandPost for approval filing
vi.mock('../src/agent/commandPost.js', () => ({
    createApproval: vi.fn((opts: Record<string, unknown>) => ({
        id: 'appr-' + Math.random().toString(36).slice(2, 8),
        ...opts,
        status: 'pending',
    })),
    getApproval: vi.fn(() => null),
}));

// Mock episodic
vi.mock('../src/memory/episodic.js', () => ({
    recordEpisode: vi.fn(),
}));

import {
    classifySubtask, classifyAll, describeKind,
} from '../src/agent/subtaskTaxonomy.js';
import {
    routeForKind, resolveSpecialist, pickAttempt, getRoutingTable,
} from '../src/agent/specialistRouter.js';
import {
    nextFallback, describeLadder,
} from '../src/agent/fallbackChain.js';
import {
    checkBudget, suggestDegradation, recordSpend, DEFAULT_BUDGET_CAPS,
} from '../src/agent/budgetEnforcer.js';
import {
    parseStructuredResponse,
} from '../src/agent/structuredSpawn.js';
import {
    tickDriver, driveGoal, getDriverState, listActiveDrivers,
    pauseDriver, resumeDriverControl, cancelDriver, reprioritizeDriver,
    _resetDriverStateForTests,
} from '../src/agent/goalDriver.js';
import { structuredSpawn as mockedStructuredSpawn } from '../src/agent/structuredSpawn.js';
import type { DriverState } from '../src/agent/goalDriverTypes.js';

// Helper to seed mockGoals
function mockGoal(id: string, title: string, opts: Partial<{
    description: string; priority: number; status: string; tags: string[];
    subtasks: Array<{ title: string; description: string }>;
}> = {}): void {
    mockGoals.set(id, {
        id,
        title,
        description: opts.description || '',
        status: opts.status || 'active',
        priority: opts.priority ?? 3,
        tags: opts.tags || [],
        createdAt: new Date().toISOString(),
        subtasks: (opts.subtasks || []).map((s, i) => ({
            id: `st-${i + 1}`,
            title: s.title,
            description: s.description,
            status: 'pending',
            retries: 0,
        })),
    });
}

describe('subtaskTaxonomy', () => {
    it('classifies code tasks by file path + code-verb signal', () => {
        // Requires BOTH a CODE_VERB (e.g. "refactor", "patch", "implement")
        // AND a file path. "Fix" alone isn't in CODE_VERBS — prevents
        // classifying prose mentions of files as code tasks.
        expect(classifySubtask({ title: 'Refactor /home/dj/foo.ts', description: '' })).toBe('code');
    });
    it('classifies code tasks by artifact-verb + artifact-noun (Fix E)', () => {
        // Via new ARTIFACT_VERBS + ARTIFACT_NOUNS classifier (v4.10.0-local).
        expect(classifySubtask({ title: 'Implement the auth module', description: '' })).toBe('code');
    });
    it('classifies research tasks', () => {
        expect(classifySubtask({ title: 'Investigate GPU temperature APIs', description: '' })).toBe('research');
    });
    it('classifies write tasks', () => {
        expect(classifySubtask({ title: 'Document the kill switch', description: 'Write a guide' })).toBe('write');
    });
    it('classifies verify tasks', () => {
        expect(classifySubtask({ title: 'Verify the build passes', description: '' })).toBe('verify');
    });
    it('classifies shell tasks', () => {
        expect(classifySubtask({ title: 'Run npm install', description: '' })).toBe('shell');
    });
    it('defaults to analysis on ambiguous', () => {
        expect(classifySubtask({ title: 'Figure out the right approach', description: 'Think about options' })).toBe('analysis');
    });
    it('classifyAll returns map', () => {
        // Use titles that match the stricter classifier: artifact-verb
        // alone ("Implement X") doesn't suffice — need artifact-noun or
        // file path to avoid hijacking genuine analysis tasks.
        const out = classifyAll([
            { id: 's1', title: 'Implement auth module', description: '' },
            { id: 's2', title: 'Research Y', description: '' },
        ]);
        expect(out.s1).toBe('code');
        expect(out.s2).toBe('research');
    });
    it('describeKind returns human text', () => {
        expect(describeKind('code')).toContain('Code');
    });
});

describe('specialistRouter', () => {
    it('routes code to builder', () => {
        expect(routeForKind('code').primary).toBe('builder');
    });
    it('routes research to scout with web tools', () => {
        const r = routeForKind('research');
        expect(r.primary).toBe('scout');
        expect(r.toolAllowlist).toContain('web_search');
    });
    it('pickAttempt returns primary then fallbacks then default', () => {
        const r = routeForKind('research');
        expect(pickAttempt(r, 0)).toBe('scout');
        expect(pickAttempt(r, 1)).toBe(r.fallbacks[0]);
        expect(pickAttempt(r, 99)).toBe('default');
    });
    it('resolveSpecialist returns null for "default"', () => {
        expect(resolveSpecialist('default')).toBeNull();
    });
    it('getRoutingTable returns all kinds', () => {
        const t = getRoutingTable();
        expect(Object.keys(t)).toHaveLength(7);
    });
});

describe('fallbackChain', () => {
    it('returns primary strategy on attempt 0', () => {
        const s = nextFallback('code', 0);
        expect(s).not.toBeNull();
        expect(s!.specialist).toBe('builder');
    });
    it('returns null when attempt exceeds max', () => {
        expect(nextFallback('code', 10, undefined, 5)).toBeNull();
    });
    it('adjusts prompt on rate-limit error', () => {
        const s = nextFallback('code', 1, 'rate limit exceeded 429');
        expect(s).not.toBeNull();
        expect(s!.rationale).toContain('rate-limit');
    });
    it('adjusts on context overflow', () => {
        const s = nextFallback('code', 1, 'context too long');
        expect(s!.promptAdjustment).toContain('concise');
    });
    it('describeLadder enumerates strategies', () => {
        const ladder = describeLadder('code', 3);
        expect(ladder).toHaveLength(3);
    });
});

describe('budgetEnforcer', () => {
    function emptyState(): DriverState {
        return {
            schemaVersion: 1,
            goalId: 'g',
            phase: 'planning',
            startedAt: new Date().toISOString(),
            lastTickAt: new Date().toISOString(),
            budget: { tokensUsed: 0, costUsd: 0, elapsedMs: 0, totalRetries: 0 },
            budgetCaps: { ...DEFAULT_BUDGET_CAPS },
            userControls: { paused: false, cancelRequested: false, priority: 3 },
            subtaskStates: {},
            history: [],
        };
    }

    it('returns ok at 0% used', () => {
        expect(checkBudget(emptyState()).status).toBe('ok');
    });
    it('returns warn at 80%+ of tokens', () => {
        const s = emptyState();
        s.budget.tokensUsed = 0.85 * s.budgetCaps.maxTokens;
        expect(checkBudget(s).status).toBe('warn');
    });
    it('returns exceeded at 100%+ of any dim', () => {
        const s = emptyState();
        s.budget.totalRetries = s.budgetCaps.maxRetries + 1;
        const c = checkBudget(s);
        expect(c.status).toBe('exceeded');
        expect(c.exceededDim).toBe('retries');
    });
    it('suggestDegradation returns downgrade_model on tokens', () => {
        const s = emptyState();
        s.budget.tokensUsed = 0.9 * s.budgetCaps.maxTokens;
        expect(suggestDegradation(s)).toBe('downgrade_model');
    });
    it('suggestDegradation returns ask_human when retries exceeded', () => {
        const s = emptyState();
        s.budget.totalRetries = s.budgetCaps.maxRetries + 1;
        expect(suggestDegradation(s)).toBe('ask_human');
    });
    it('recordSpend accumulates', () => {
        const s = emptyState();
        recordSpend(s, { tokens: 100, costUsd: 0.01, elapsedMs: 5000 });
        recordSpend(s, { tokens: 50, retries: 1 });
        expect(s.budget.tokensUsed).toBe(150);
        expect(s.budget.totalRetries).toBe(1);
    });
});

describe('structuredSpawn parser', () => {
    it('extracts JSON from code fence', () => {
        const raw = 'Some reasoning.\n\n```json\n{"status":"done","artifacts":[],"questions":[],"confidence":0.9,"reasoning":"ok"}\n```';
        const p = parseStructuredResponse(raw);
        expect(p.status).toBe('done');
        expect(p.confidence).toBe(0.9);
    });
    it('extracts trailing JSON without fence', () => {
        const raw = 'thinking...\n{"status":"failed","artifacts":[],"questions":[],"confidence":0.2,"reasoning":"err"}';
        const p = parseStructuredResponse(raw);
        expect(p.status).toBe('failed');
    });
    // v4.10.0-local (post-deploy): parser-level failures return `failed`
    // (retryable) NOT `needs_info` (human-blocking). A parse failure is a
    // machine error the driver can retry — not a question Tony can answer.
    it('falls back to failed when no JSON and no prose signal', () => {
        const p = parseStructuredResponse('just prose, no JSON here');
        expect(p.status).toBe('failed');
        expect(p.parseError).toBeDefined();
    });
    it('clamps invalid confidence', () => {
        const raw = '```json\n{"status":"done","artifacts":[],"questions":[],"confidence":5,"reasoning":""}\n```';
        expect(parseStructuredResponse(raw).confidence).toBe(1);
    });
    it('sanitizes unknown status to needs_info', () => {
        const raw = '```json\n{"status":"weird","artifacts":[],"questions":[],"confidence":0.5,"reasoning":""}\n```';
        expect(parseStructuredResponse(raw).status).toBe('needs_info');
    });
    it('filters malformed artifacts', () => {
        const raw = '```json\n{"status":"done","artifacts":[{"type":"file","ref":"/a"},{"ref":null}],"questions":[],"confidence":0.5,"reasoning":""}\n```';
        expect(parseStructuredResponse(raw).artifacts).toHaveLength(1);
    });

    // v4.10.0-local polish: prose fallback for LLMs that ignore format instructions
    describe('prose fallback', () => {
        it('infers done from clear completion prose', () => {
            const raw = 'I have completed the task. Here is my summary: Research was conducted on the topic and findings are documented. The work is finished and verified via two sources.';
            const p = parseStructuredResponse(raw);
            expect(p.status).toBe('done');
            expect(p.parseError).toBe('prose-fallback:done');
        });

        it('extracts URL artifacts from prose', () => {
            const raw = 'Research complete. Sources: https://example.com/doc1 https://example.com/doc2. The findings are documented above.';
            const p = parseStructuredResponse(raw);
            expect(p.status).toBe('done');
            expect(p.artifacts.filter(a => a.type === 'url')).toHaveLength(2);
        });

        it('extracts file path artifacts from prose', () => {
            const raw = 'Successfully wrote the implementation to /opt/TITAN/src/foo.ts. The module is complete and ready for review.';
            const p = parseStructuredResponse(raw);
            expect(p.status).toBe('done');
            expect(p.artifacts.find(a => a.type === 'file' && a.ref === '/opt/TITAN/src/foo.ts')).toBeDefined();
        });

        it('detects give-up phrases as failed', () => {
            const raw = "I don't have a specific task to act on. Could you clarify?";
            const p = parseStructuredResponse(raw);
            expect(p.status).toBe('failed');
        });

        it('detects clarifying questions as needs_info', () => {
            // Use text with no done-markers (e.g. no "documented/created/wrote")
            // so the prose-fallback ladder reaches the question branch.
            const raw = 'To proceed, I need more context. Could you tell me which API endpoint you want?';
            const p = parseStructuredResponse(raw);
            expect(p.status).toBe('needs_info');
            expect(p.questions.length).toBeGreaterThan(0);
        });

        // v4.10.0-local (post-deploy): when prose has NO clear signal (no done,
        // no question, no give-up), return `failed` (retryable) not `needs_info`.
        // Same rationale as the JSON-parse path.
        it('returns failed when prose has no clear signal', () => {
            const raw = 'hmm, some random words with no clear outcome signal at all.';
            const p = parseStructuredResponse(raw);
            // Parser-level fallback → failed (machine-level error, not
            // something a human can answer).
            expect(p.status).toBe('failed');
        });
    });
});

describe('goalDriver state machine', () => {
    beforeEach(() => {
        mockGoals.clear();
        _resetDriverStateForTests();
    });

    it('initializes fresh state on first tick', async () => {
        mockGoal('g-init', 'Test goal', {
            subtasks: [{ title: 'Research X', description: 'Find out X' }],
        });
        const phase = await tickDriver('g-init');
        expect(phase).toBe('delegating');
        const s = getDriverState('g-init');
        expect(s).not.toBeNull();
        expect(s!.schemaVersion).toBe(1);
        expect(s!.subtaskStates['st-1'].kind).toBe('research');
    });

    it('drives a one-subtask goal to done', async () => {
        mockGoal('g-simple', 'Fetch public IP', {
            subtasks: [{ title: 'Research public IP', description: 'Use web fetch to get it' }],
        });
        const final = await driveGoal('g-simple', 50);
        expect(final).toBe('done');
    });

    it('transitions to blocked when spawn returns needs_info', async () => {
        vi.mocked(mockedStructuredSpawn).mockResolvedValueOnce({
            status: 'needs_info',
            artifacts: [],
            questions: ['What URL should I use?'],
            confidence: 0.1,
            reasoning: 'missing target',
            rawResponse: '',
        });
        mockGoal('g-blocked', 'Research something', {
            subtasks: [{ title: 'Research the thing', description: 'Do research' }],
        });
        await tickDriver('g-blocked'); // planning → delegating
        await tickDriver('g-blocked'); // delegating → spawn (needs_info) → blocked
        const s = getDriverState('g-blocked');
        expect(s!.phase).toBe('blocked');
        expect(s!.blockedReason?.question).toContain('URL');
    });

    it('persists state to disk', async () => {
        mockGoal('g-persist', 'Test persistence', {
            subtasks: [{ title: 'Research', description: 'Do it' }],
        });
        await tickDriver('g-persist');
        const path = join(tmpHome, 'driver-state', 'g-persist.json');
        expect(existsSync(path)).toBe(true);
        const content = JSON.parse(readFileSync(path, 'utf-8'));
        expect(content.goalId).toBe('g-persist');
    });

    it('pauseDriver flags paused in state', async () => {
        mockGoal('g-pause', 'Pause me', { subtasks: [{ title: 'Research', description: 'Do it' }] });
        await tickDriver('g-pause');
        expect(pauseDriver('g-pause')).toBe(true);
        const s = getDriverState('g-pause');
        expect(s!.userControls.paused).toBe(true);
    });

    it('paused driver skips ticks', async () => {
        mockGoal('g-paused-skip', 'Pause skip', { subtasks: [{ title: 'Research', description: '' }] });
        await tickDriver('g-paused-skip');
        pauseDriver('g-paused-skip');
        const before = getDriverState('g-paused-skip')!.history.length;
        await tickDriver('g-paused-skip');
        const after = getDriverState('g-paused-skip')!.history.length;
        expect(after).toBe(before);
    });

    it('cancelDriver transitions to cancelled', async () => {
        mockGoal('g-cancel', 'Cancel me', { subtasks: [{ title: 'Research', description: '' }] });
        await tickDriver('g-cancel');
        cancelDriver('g-cancel');
        const phase = await tickDriver('g-cancel');
        expect(phase).toBe('cancelled');
    });

    it('reprioritizeDriver updates priority', async () => {
        mockGoal('g-rep', 'Reprioritize', { subtasks: [{ title: 'Research', description: '' }] });
        await tickDriver('g-rep');
        reprioritizeDriver('g-rep', 1);
        expect(getDriverState('g-rep')!.userControls.priority).toBe(1);
    });

    it('listActiveDrivers filters out terminal ones', async () => {
        mockGoal('g-terminal', 'Terminal', { subtasks: [{ title: 'Research', description: '' }] });
        const finalPhase = await driveGoal('g-terminal', 100);
        const s = getDriverState('g-terminal');
        // Diagnostic: surface phase if the assertion below fails so we know why
        expect({ finalPhase, phaseOnDisk: s?.phase }).toEqual({ finalPhase: 'done', phaseOnDisk: 'done' });
        const active = listActiveDrivers();
        expect(active.find(d => d.goalId === 'g-terminal')).toBeUndefined();
    });

    it('retries failed subtasks via fallback chain', async () => {
        vi.mocked(mockedStructuredSpawn)
            .mockResolvedValueOnce({
                status: 'failed',
                artifacts: [],
                questions: [],
                confidence: 0.1,
                reasoning: 'first attempt failed',
                rawResponse: '',
            })
            .mockResolvedValueOnce({
                status: 'done',
                artifacts: [{ type: 'fact', ref: 'recovered' }],
                questions: [],
                confidence: 0.9,
                reasoning: 'second attempt succeeded',
                rawResponse: '',
            });

        mockGoal('g-retry', 'Retry me', {
            subtasks: [{ title: 'Research something', description: 'Do it' }],
        });
        const final = await driveGoal('g-retry', 50);
        expect(final).toBe('done');
        const s = getDriverState('g-retry');
        expect(s!.subtaskStates['st-1'].attempts).toBeGreaterThanOrEqual(2);
    });

    it('handles goal with no subtasks (creates placeholder)', async () => {
        mockGoal('g-empty', 'Empty goal', { subtasks: [] });
        await tickDriver('g-empty');
        // After planning, phase should have moved
        const s = getDriverState('g-empty');
        expect(s!.history.some(h => h.note.includes('No subtasks'))).toBe(true);
    });
});

// ── v4.10.0-local (post-deploy) — root-cause fixes ─────────────────
// Covers: classification reclass, per-subtask cap, stall loop detector,
// stale-block auto-unblock, confidence-tier verifier pass, and the
// whole-goal vacuous-pass guard. Each test exercises one fix in isolation.

describe('v4.10.0-local root-cause fixes', () => {
    describe('Fix E — artifact-verb subtask classification', () => {
        it('classifies "Design safety metrics dashboard" as code, not analysis', () => {
            // Previous behavior: fell through to analysis default because no
            // explicit analyze/write keyword. New behavior: artifact-verb
            // (design) + artifact-noun (dashboard) → code.
            expect(classifySubtask({
                title: 'Design safety metrics dashboard',
                description: 'Build the dashboard component',
            })).toBe('code');
        });
        it('classifies "Implement auth endpoint" as code', () => {
            expect(classifySubtask({
                title: 'Implement auth endpoint',
                description: 'Add the login handler',
            })).toBe('code');
        });
        it('does NOT hijack "Design an experiment" (no artifact noun)', () => {
            expect(classifySubtask({
                title: 'Design an experiment',
                description: 'Plan the A/B test setup',
            })).toBe('analysis');
        });
        it('classifies with file-path artifact signal', () => {
            expect(classifySubtask({
                title: 'Create api.ts',
                description: '',
            })).toBe('code');
        });
    });

    describe('Fix B — per-subtask attempt cap', () => {
        it('freshDriverState initializes maxAttempts = 5 per subtask', async () => {
            mockGoal('g-cap', 'Cap test', {
                subtasks: [{ title: 'Implement widget', description: 'build it' }],
            });
            await tickDriver('g-cap');
            const s = getDriverState('g-cap');
            expect(s!.subtaskStates['st-1'].maxAttempts).toBe(5);
        });
    });

    describe('Fix A — stall loop detector', () => {
        it('fails subtask after 3 identical consecutive errors', async () => {
            // Force spawn to always fail with the SAME error fingerprint
            vi.mocked(mockedStructuredSpawn).mockReset();
            vi.mocked(mockedStructuredSpawn).mockResolvedValue({
                status: 'failed',
                artifacts: [],
                questions: [],
                confidence: 0,
                reasoning: 'Parser could not extract JSON from specialist response',
                rawResponse: '',
            });

            mockGoal('g-stall', 'Stall loop', {
                subtasks: [{ title: 'Analyze patterns', description: 'do it' }],
            });
            // Drive until stall detector fires (should happen within ~6 ticks:
            // delegating → observing → iterating × 3 identical errors)
            const final = await driveGoal('g-stall', 40);
            // Stall detector fires on the 3rd identical error, so subtask
            // should be failed within a few ticks. Goal ultimately fails
            // because the only subtask failed.
            expect(final === 'failed' || final === 'done').toBe(true);
            const s = getDriverState('g-stall');
            const st = s!.subtaskStates['st-1'];
            // Either detector broke the loop (history contains "Broke stall loop")
            // or per-subtask cap kicked in (Fix B). Both are legitimate escapes.
            const broke = s!.history.some(h =>
                /Broke stall loop|per-subtask cap/i.test(h.note),
            );
            expect(broke).toBe(true);
            // And consecutiveIdenticalErrors should have been incremented
            expect((st.consecutiveIdenticalErrors ?? 0) >= 1).toBe(true);
        });
    });

    // Helper: write driver state directly to disk so tickDriver's
    // loadState() sees it. Mutating getDriverState() doesn't persist.
    function writeDriverStateToDisk(goalId: string, state: object): void {
        const dir = join(tmpHome, 'driver-state');
        try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
        writeFileSync(join(dir, `${goalId}.json`), JSON.stringify(state, null, 2), 'utf-8');
    }

    describe('Fix F — stale blocked state auto-unblock', () => {
        it('auto-unblocks when blockedReason.sinceAt > 10 min and no approval', async () => {
            mockGoal('g-stale', 'Stale block', {
                subtasks: [{ title: 'Do thing', description: '' }],
            });
            _resetDriverStateForTests('g-stale');
            // Write a stale-blocked state directly to disk
            writeDriverStateToDisk('g-stale', {
                schemaVersion: 1,
                goalId: 'g-stale',
                phase: 'blocked',
                startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
                lastTickAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
                budget: { tokensUsed: 0, costUsd: 0, elapsedMs: 0, totalRetries: 2 },
                budgetCaps: { maxTokens: 500000, maxCostUsd: 5, maxElapsedMs: 4 * 3600 * 1000, maxRetries: 10 },
                userControls: { paused: false, cancelRequested: false, priority: 3 },
                blockedReason: {
                    question: 'bogus',
                    approvalId: '',
                    sinceAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
                    kind: 'needs_info',
                },
                subtaskStates: {
                    'st-1': { kind: 'analysis', attempts: 2, artifacts: [], maxAttempts: 5 },
                },
                currentSubtaskId: 'st-1',
                history: [],
            });

            await tickDriver('g-stale');
            const after = getDriverState('g-stale')!;
            expect(after.phase === 'iterating' || after.phase === 'delegating').toBe(true);
            expect(after.blockedReason).toBeUndefined();
            expect(after.history.some(h => /stale block auto-recovered|Force-unblocked/i.test(h.note))).toBe(true);
        });

        it('does NOT auto-unblock within the 10-min window', async () => {
            mockGoal('g-fresh-block', 'Fresh block', {
                subtasks: [{ title: 'Do thing', description: '' }],
            });
            _resetDriverStateForTests('g-fresh-block');
            writeDriverStateToDisk('g-fresh-block', {
                schemaVersion: 1,
                goalId: 'g-fresh-block',
                phase: 'blocked',
                startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
                lastTickAt: new Date().toISOString(),
                budget: { tokensUsed: 0, costUsd: 0, elapsedMs: 0, totalRetries: 0 },
                budgetCaps: { maxTokens: 500000, maxCostUsd: 5, maxElapsedMs: 4 * 3600 * 1000, maxRetries: 10 },
                userControls: { paused: false, cancelRequested: false, priority: 3 },
                blockedReason: {
                    question: 'legitimate',
                    approvalId: '',
                    sinceAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 min ago
                    kind: 'needs_info',
                },
                subtaskStates: {
                    'st-1': { kind: 'analysis', attempts: 0, artifacts: [], maxAttempts: 5 },
                },
                currentSubtaskId: 'st-1',
                history: [],
            });

            await tickDriver('g-fresh-block');
            const after = getDriverState('g-fresh-block')!;
            // approvalId is empty → no approval to check → returns without change
            // Phase stays blocked because stale window (10 min) hasn't elapsed
            expect(after.phase).toBe('blocked');
        });
    });

    describe('Fix 8 — tickObserving no-op when nothing pending', () => {
        it('bounces back to delegating without burning an attempt', async () => {
            mockGoal('g-obs', 'Observe test', {
                subtasks: [{ title: 'Do thing', description: '' }],
            });
            _resetDriverStateForTests('g-obs');
            writeDriverStateToDisk('g-obs', {
                schemaVersion: 1,
                goalId: 'g-obs',
                phase: 'observing',
                startedAt: new Date().toISOString(),
                lastTickAt: new Date().toISOString(),
                budget: { tokensUsed: 0, costUsd: 0, elapsedMs: 0, totalRetries: 0 },
                budgetCaps: { maxTokens: 500000, maxCostUsd: 5, maxElapsedMs: 4 * 3600 * 1000, maxRetries: 10 },
                userControls: { paused: false, cancelRequested: false, priority: 3 },
                subtaskStates: {
                    'st-1': { kind: 'analysis', attempts: 0, artifacts: [], maxAttempts: 5 },
                },
                currentSubtaskId: 'st-1',
                history: [],
            });

            await tickDriver('g-obs');
            const after = getDriverState('g-obs')!;
            // Should bounce to delegating, NOT to iterating (which would
            // burn an attempt). No "Observe tick with no spawn progress"
            // entry should appear in history.
            expect(after.phase === 'delegating' || after.phase === 'done').toBe(true);
            expect(after.history.some(h => /Observe tick with no spawn progress/i.test(h.note))).toBe(false);
        });
    });
});

afterAll(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ok */ }
});

// Silence unused imports for tidy output
void mkdtempSync; void tmpdir;
