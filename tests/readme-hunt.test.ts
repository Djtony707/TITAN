/**
 * TITAN — README Compliance Hunt regression tests (2026-04-15)
 *
 * These tests lock in the plumbing invariants that the README hunt
 * uncovered. They don't exercise the live agent loop (unit-testing
 * the whole loop is a separate, heavier effort) — instead they do
 * source-lint sanity checks that prove the fix is in place so no
 * future refactor can silently regress the fix.
 *
 * Each test below pins a specific hunt finding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENT_LOOP = readFileSync(
    resolve(__dirname, '../src/agent/agentLoop.ts'),
    'utf-8',
);

const AUTO_VERIFY = readFileSync(
    resolve(__dirname, '../src/agent/autoVerify.ts'),
    'utf-8',
);

describe('README Compliance Hunt — source-lint regression tests', () => {
    // ─────────────────────────────────────────────────────────────────
    // Finding #39 — respond phase must route tool calls back to act
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #39 — respond phase tool-call routing', () => {
        it('logs a RespondPhaseToolCall warning', () => {
            expect(AGENT_LOOP).toContain('[RespondPhaseToolCall]');
        });

        it('references Hunt #39', () => {
            expect(AGENT_LOOP).toMatch(/Hunt (Finding )?#39/);
        });

        it('routes back to act phase with seeded pendingToolCalls', () => {
            // The fix transitions phase='act' and seeds pendingToolCalls
            // with the tool calls the model emitted in the respond phase.
            const respondCase = AGENT_LOOP.split("case 'respond':")[1] || '';
            expect(respondCase).toContain('[RespondPhaseToolCall]');
            expect(respondCase).toMatch(/phase\s*=\s*'act'/);
            expect(respondCase).toMatch(/pendingToolCalls\s*=\s*response\.toolCalls/);
        });

        it('does not silently drop respond-phase tool calls (regression guard)', () => {
            // If this test fails, someone removed the Finding #39 fix.
            const respondCase = AGENT_LOOP.split("case 'respond':")[1] || '';
            // The respond phase must HANDLE response.toolCalls, not ignore.
            expect(respondCase).toMatch(/response\.toolCalls.*length.*>\s*0/);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #40 — AutoVerify must force retry on write failures
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #40 — AutoVerify forces retry on write failure', () => {
        it('tcSuccess is declared with let (mutable)', () => {
            // Must be `let` so the AutoVerify block can flip it to false
            // when the verify fails. If someone re-declares this as `const`,
            // SmartExit will read a stale true and transition to respond.
            expect(AGENT_LOOP).toMatch(/let tcSuccess\s*=/);
            expect(AGENT_LOOP).not.toMatch(/const tcSuccess\s*=\s*!tr\.content/);
        });

        it('AutoVerify failure path mutates tr.success = false', () => {
            expect(AGENT_LOOP).toMatch(/tr\.success\s*=\s*false/);
        });

        it('AutoVerify failure path mutates tcSuccess = false', () => {
            expect(AGENT_LOOP).toMatch(/tcSuccess\s*=\s*false/);
        });

        it('AutoVerify failure injects [AutoVerify FAILED] banner into tr.content', () => {
            expect(AGENT_LOOP).toContain('[AutoVerify FAILED]');
        });

        it('references Hunt #40', () => {
            expect(AGENT_LOOP).toMatch(/Hunt (Finding )?#40/);
        });

        it('verifyFileWrite rejects missing files', () => {
            // Downstream contract: AutoVerify must return passed:false with
            // a clear issue when the file doesn't exist after the write.
            expect(AUTO_VERIFY).toContain('does not exist after write');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #38b round 2 — narrator preamble stripping
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #38b round 2 — narrator preamble stripping', () => {
        it('exports stripNarratorPreamble', () => {
            expect(AGENT_LOOP).toMatch(/export function stripNarratorPreamble/);
        });

        it('detects "The user wants" narrator opener', () => {
            expect(AGENT_LOOP).toMatch(/The user (wants|is asking)/);
        });

        it('round 0 chat think disables streaming', () => {
            expect(AGENT_LOOP).toContain('isChatRound0Think');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #38a — httpPool/undici tsup external
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #38a — undici tsup external', () => {
        it('package.json lists undici as dependency', () => {
            const pkg = JSON.parse(
                readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
            );
            expect(pkg.dependencies.undici).toBeDefined();
        });

        it('package.json tsup external array includes undici', () => {
            const pkg = JSON.parse(
                readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
            );
            expect(pkg.tsup.external).toContain('undici');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #30 — deploy.sh syncs every file in the npm tarball
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #30 — deploy.sh file sync coverage', () => {
        const DEPLOY_SH = readFileSync(
            resolve(__dirname, '../scripts/deploy.sh'),
            'utf-8',
        );

        it('syncs scripts/ directory (postinstall.cjs lives here)', () => {
            expect(DEPLOY_SH).toMatch(/scripts\/.*REMOTE_PATH/);
        });

        it('syncs docs/ directory', () => {
            expect(DEPLOY_SH).toMatch(/docs\/.*REMOTE_PATH/);
        });

        it('syncs README.md', () => {
            expect(DEPLOY_SH).toContain('README.md');
        });

        it('syncs LICENSE and THIRD_PARTY_NOTICES.md', () => {
            expect(DEPLOY_SH).toContain('LICENSE');
            expect(DEPLOY_SH).toContain('THIRD_PARTY_NOTICES.md');
        });

        it('syncs .env.example (required by tarball)', () => {
            expect(DEPLOY_SH).toContain('.env.example');
        });
    });
});
