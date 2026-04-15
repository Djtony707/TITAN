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
    // Finding #45 — mesh reconnect backoff cap tightened
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #45 — mesh reconnect backoff cap', () => {
        const TRANSPORT = readFileSync(
            resolve(__dirname, '../src/mesh/transport.ts'),
            'utf-8',
        );

        it('RECONNECT_MAX_DELAY capped at <= 30s for README-compliant recovery', () => {
            // README promises "reconnect automatically on restart". A 60s cap
            // meant attempts 5-6 slept ~54s each, leaving the mesh degraded for
            // 2+ minutes. Cap tightened to 30s.
            const match = TRANSPORT.match(/RECONNECT_MAX_DELAY\s*=\s*(\d+)/);
            expect(match).not.toBeNull();
            const delay = parseInt(match![1], 10);
            expect(delay).toBeLessThanOrEqual(30000);
        });

        it('references Hunt #45', () => {
            expect(TRANSPORT).toMatch(/Hunt (Finding )?#45/);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #44 — SPA catch-all must not swallow /mcp
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #44 — /mcp route passes SPA catch-all', () => {
        const SERVER = readFileSync(
            resolve(__dirname, '../src/gateway/server.ts'),
            'utf-8',
        );

        it('SPA catch-all exempts /mcp paths', () => {
            // README:683 promises MCP HTTP transport at http://localhost:48420/mcp.
            // The SPA catch-all was swallowing GETs and returning the dashboard
            // HTML instead of routing to mountMcpHttpEndpoints.
            const catchAll = SERVER.split("app.get('*'")[1]?.split('});')[0] || '';
            expect(catchAll).toContain("startsWith('/mcp')");
        });

        it('references Hunt #44', () => {
            expect(SERVER).toMatch(/Hunt (Finding )?#44/);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #43 — default user profile path is the README path
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #43 — default profile lives at README-promised path', () => {
        const RELATIONSHIP = readFileSync(
            resolve(__dirname, '../src/memory/relationship.ts'),
            'utf-8',
        );

        it('default user profile path is ~/.titan/profile.json (README:924)', () => {
            // README table lists: Relationship -> ~/.titan/profile.json
            // A previous refactor moved the file to ~/.titan/profiles/default.json
            // and deleted the legacy. Finding #43 restores the canonical path.
            expect(RELATIONSHIP).toMatch(/userId === 'default'/);
            expect(RELATIONSHIP).toMatch(/join\(TITAN_HOME, 'profile\.json'\)/);
        });

        it('no longer unlinkSyncs the legacy path', () => {
            // Previously loadProfile would unlinkSync the canonical
            // profile.json after migrating. That was the root cause of the
            // README gap. Check we removed that destructive behavior.
            expect(RELATIONSHIP).not.toMatch(/unlinkSync\(legacy/);
        });

        it('references Hunt #43', () => {
            expect(RELATIONSHIP).toMatch(/Hunt (Finding )?#43/);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #42 — modelAliases floor guarantees README-promised names
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #42 — modelAliases must include README-promised built-ins', () => {
        it('parsed config always has fast/smart/cheap/reasoning/local as a floor', async () => {
            // README:552 "Built-in aliases: fast, smart, cheap, reasoning, local"
            // Previously, any user override would REPLACE the defaults so the
            // user could lose 'cheap' by setting only {fast, cloud}. The schema
            // now uses .transform() to merge user aliases on top of the floor.
            const mod = await import('../src/config/schema.js');
            const schema = mod.AgentConfigSchema;

            // User override that intentionally omits cheap/reasoning/local
            const parsed = schema.parse({
                model: 'ollama/foo',
                modelAliases: {
                    fast: 'my/custom-fast',
                    cloud: 'my/custom-cloud',
                },
            });
            const aliases = parsed.modelAliases as Record<string, string>;
            expect(aliases.fast).toBe('my/custom-fast');
            expect(aliases.cloud).toBe('my/custom-cloud');
            expect(aliases.smart).toBeDefined();
            expect(aliases.cheap).toBeDefined();
            expect(aliases.reasoning).toBeDefined();
            expect(aliases.local).toBeDefined();
        });

    });

    // ─────────────────────────────────────────────────────────────────
    // Finding #41 — `data_analysis` tool must exist (README claim)
    // ─────────────────────────────────────────────────────────────────
    describe('Finding #41 — data_analysis tool exists', () => {
        const DATA_ANALYSIS = readFileSync(
            resolve(__dirname, '../src/skills/builtin/data_analysis.ts'),
            'utf-8',
        );

        it('registers a tool named data_analysis (not just a skill)', () => {
            // The README Tools table at README.md:747 lists data_analysis
            // as the top-level tool. Previously only csv_parse/csv_stats/csv_query
            // were registered, leaving data_analysis as a skill name with no
            // matching tool. Added a high-level wrapper so the README claim holds.
            const toolDecls = DATA_ANALYSIS.match(/name:\s*'data_analysis'/g) || [];
            // At least one skill registration + the new tool registration.
            // (Old file had 3 "data_analysis" skill names referring to the skill;
            // with the new tool, the count is 4+).
            expect(toolDecls.length).toBeGreaterThanOrEqual(4);
        });

        it('data_analysis tool supports summary/preview/stats/query operations', () => {
            expect(DATA_ANALYSIS).toContain("operation === 'preview'");
            expect(DATA_ANALYSIS).toContain("operation === 'stats'");
            expect(DATA_ANALYSIS).toContain("operation === 'query'");
        });

        it('references Hunt #41', () => {
            expect(DATA_ANALYSIS).toMatch(/Hunt (Finding )?#41/);
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
