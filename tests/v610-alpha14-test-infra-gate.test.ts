/**
 * TITAN — v6.1.0-alpha.14 test-infrastructure runaway gate
 *
 * Tony hit a runaway autonomous-goal loop where the dreaming /
 * Soma proposer kept generating "Bootstrap test infrastructure" /
 * "Diagnose test infrastructure failure" goals. 7 goals in 1.5h,
 * tests/smoke.test.js written 6× in 24h. The v6.0.3 gate that was
 * supposed to stop this only caught explicit self-mod / self-repair
 * tags + "TITAN's own framework" text — these new goal titles slipped
 * through with tags like ['testing', 'infrastructure', 'blocking']
 * which the gate didn't list.
 *
 * alpha.14 widens both the trigger regex set and the tag set in
 * `normalizeProposal` to catch the whole self-referential category
 * (test-infra, diagnostics, self-improve, regression-prevention,
 * health-check, etc.).
 *
 * These tests pin every wild-caught runaway title so a future
 * refactor can't accidentally narrow the gate again.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => ({
        autonomy: {
            selfMod: {
                target: '/opt/TITAN',
                autoCreateGoals: false, // gate ON (default in v6.0.3+)
            },
        },
    }),
}));

describe('v6.1.0-alpha.14 — self-referential autonomy gate widened', () => {
    // These six are the actual wild-caught runaway-goal titles from
    // Tony's box (15:00-15:05 audit). Each one slipped past the
    // v6.0.3 gate. Each one MUST be dropped by alpha.14.
    const WILD_CAUGHT = [
        {
            title: 'Bootstrap actual test infrastructure from scratch',
            tags: ['infrastructure', 'testing', 'blocking'],
            description: 'Create tests/smoke.test.js and run it.',
        },
        {
            title: 'Diagnose test infrastructure failure root cause',
            tags: ['diagnostic', 'test-infrastructure', 'root-cause'],
            description: 'Identify why test infrastructure bootstrapping repeatedly fails.',
        },
        {
            title: 'Diagnose test infrastructure by actually running tests',
            tags: ['infrastructure', 'diagnostics', 'testing'],
            description: 'Navigate to project directory, locate test files, run the test suite directly.',
        },
        {
            title: 'Map test infrastructure state and document failures',
            tags: ['test-infra', 'diagnostic', 'documentation'],
            description: 'Systematically examine the test infrastructure.',
        },
        {
            title: 'Create minimal test harness to validate test infrastructure',
            tags: ['testing', 'infrastructure', 'blocking'],
            description: 'Create a minimal runnable test.',
        },
        {
            title: 'Add smoke tests for core agent functionality',
            tags: ['testing', 'quality', 'regression-prevention'],
            description: 'Identify core agent behaviors needing test coverage.',
        },
    ];

    for (const sample of WILD_CAUGHT) {
        it(`drops runaway proposal: "${sample.title}"`, async () => {
            const { normalizeProposal } = await import('../src/agent/goalProposer.js');
            const out = normalizeProposal({
                title: sample.title,
                description: sample.description,
                rationale: 'Soma curiosity drive elevated.',
                tags: sample.tags,
            });
            expect(out, `Expected "${sample.title}" to be dropped by the alpha.14 widened gate`).toBeNull();
        });
    }

    // Sanity: non-self-referential proposals still pass through.
    // We do NOT want to over-gate user-style goals.
    it('legitimate (non-self-referential) proposals still pass through', async () => {
        const { normalizeProposal } = await import('../src/agent/goalProposer.js');
        const proposals = [
            {
                title: 'Write a thank-you note to my landlord',
                tags: ['communication', 'personal'],
                description: 'A short warm note.',
            },
            {
                title: 'Plan a birthday party for my mom',
                tags: ['planning', 'event'],
                description: 'Guest list, venue, food.',
            },
            {
                title: 'Research best laptops under $1500',
                tags: ['research', 'shopping'],
                description: 'Compare 2025 ultrabooks.',
            },
            {
                title: 'Summarize this 50-page PDF',
                tags: ['summarization', 'content'],
                description: 'Pull the key takeaways into 5 bullets.',
            },
        ];
        for (const p of proposals) {
            const out = normalizeProposal({
                ...p,
                rationale: 'user wants this',
            });
            expect(out, `"${p.title}" should NOT be gated (it's a legitimate user-style goal)`).not.toBeNull();
        }
    });

    // Regression: confirm the v6.0.3 self-mod gate still works.
    it('still gates the original v6.0.3 self-mod patterns', async () => {
        const { normalizeProposal } = await import('../src/agent/goalProposer.js');
        const v603Samples = [
            { title: 'Rewrite the core framework', tags: ['self-mod', 'framework'] },
            { title: 'Self-heal the broken autonomy daemon', tags: ['self-healing'] },
            { title: "Improve TITAN's own runtime", tags: ['core'] },
        ];
        for (const s of v603Samples) {
            const out = normalizeProposal({
                ...s,
                description: 'Autonomous improvement.',
                rationale: 'Pressure cycle.',
            });
            expect(out).toBeNull();
        }
    });

    // Negative: gate is regex-driven, so the boundaries matter. A
    // proposal whose title casually mentions "testing" without
    // self-referential context should still be gated under the
    // current wide policy — and that's INTENTIONAL. The proposer is
    // exclusively the autonomous path; user-initiated goals go
    // through startMissionWork which bypasses this gate entirely.
    // This test pins that policy so future refactors don't loosen
    // it accidentally.
    it('gate intentionally errs WIDE — autonomous proposer is gated for any "testing" / "diagnostic" tag', async () => {
        const { normalizeProposal } = await import('../src/agent/goalProposer.js');
        const out = normalizeProposal({
            title: 'Casual ambient testing thing',
            description: 'whatever',
            rationale: 'autonomous',
            tags: ['testing'],
        });
        expect(out).toBeNull();
    });
});
