/**
 * H2 — Pipeline integration tests for the v5.8.0 harness pack.
 *
 * Unit tests pin each module in isolation. This file pins the WIRING —
 * the verifier reports correctly for realistic tool shapes, the output
 * cap clips with tool-aware hints, the widget side-channel delivers
 * session-scoped, the delegation contract composes with proper section
 * order, the tool-intent registry classifies actual tool names.
 *
 * Two skills (`canvas_widgets`, `agent_handoff`) are registered DIRECTLY
 * here rather than through `initBuiltinSkills()` because the full skill
 * loader pulls in cron, voice, browser, mesh, etc. and blocks on network
 * I/O — too heavy for an integration test. The gateway-level "/api/skills
 * returns an array" assertion lives in `tests/gateway.test.ts`; that's
 * the right altitude for "everything actually registers."
 *
 * Reference:
 *   - docs/PIPELINES.md (lands as H5)
 *   - ~/.claude/projects/-Users-michaelelliott/memory/titan-v6-living-canvas.md
 *   - awesome-agent-harness top-10 pattern #5 (verification first-class)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { getRegisteredTools, executeTool, registerTool } from '../../src/agent/toolRunner.js';
import { verifyToolResult, buildVerifierFeedback } from '../../src/agent/toolResultVerifier.js';
import { capToolOutput, DEFAULT_OUTPUT_CAP } from '../../src/agent/toolOutputCap.js';
import { getToolKind, isRisky, isDestructive } from '../../src/agent/toolIntent.js';
import {
    applyCaps,
    totalSize,
    SECTION_CAP_DEFAULTS,
} from '../../src/agent/promptSectionCaps.js';
import {
    subscribe as subscribeWidgets,
    emitWidget,
    __resetWidgetBusForTests,
    type WidgetEvent,
} from '../../src/agent/widgetEmitter.js';
import {
    composeDelegationTask,
    registerAgentHandoffSkill,
} from '../../src/skills/builtin/agent_handoff.js';
import { registerCanvasWidgetsSkill } from '../../src/skills/builtin/canvas_widgets.js';

// ─── Targeted skill registration — only the new v5.8.0 skills ──────────

beforeAll(() => {
    // Register ONLY the skills under integration test. Bypasses the full
    // initBuiltinSkills() (which loads cron, voice, mesh, etc. and is too
    // heavy for an integration test). For "full registry loads cleanly"
    // see tests/gateway.test.ts.
    registerCanvasWidgetsSkill();
    registerAgentHandoffSkill();
});

afterAll(() => {
    __resetWidgetBusForTests();
});

// ─── H2.1 — Canvas widget skill registers its three lifecycle tools ─────

describe('H2.1 — canvas_widgets skill exposes the three lifecycle tools', () => {
    it('create_widget / update_widget / remove_widget all reach the registry', () => {
        const names = new Set(getRegisteredTools().map(t => t.name));
        expect(names.has('create_widget'), 'create_widget missing from registry').toBe(true);
        expect(names.has('update_widget'), 'update_widget missing from registry').toBe(true);
        expect(names.has('remove_widget'), 'remove_widget missing from registry').toBe(true);
    });

    it('create_widget description follows the Anthropic checklist (USE CASE / RETURNS / ERRORS)', () => {
        const handlers = new Map(getRegisteredTools().map(t => [t.name, t]));
        const cw = handlers.get('create_widget');
        expect(cw, 'create_widget not registered').toBeDefined();
        expect(cw!.description.length, 'description too thin for the checklist').toBeGreaterThan(400);
        const desc = cw!.description.toLowerCase();
        expect(desc).toMatch(/use case|use this when/);
        expect(desc).toMatch(/anti-pattern/);
        expect(desc).toMatch(/return/);
        expect(desc).toMatch(/error/);
    });
});

// ─── H2.2 — Prompt section caps actually trim oversized inputs ──────────

describe('H2.2 — prompt section caps protect the context window', () => {
    it('SECTION_CAP_DEFAULTS defines caps for the high-value prompt sections', () => {
        // The agent loop uses these named sections when assembling the
        // system prompt. If the defaults map is missing, agent.ts falls
        // back to a 4 KB generic cap — workable but blunter than intended.
        // We verify the SHIPPED keys (not invented names) so the test
        // tracks reality rather than aspirational naming.
        const keys = Object.keys(SECTION_CAP_DEFAULTS);
        expect(keys.length, 'SECTION_CAP_DEFAULTS is empty').toBeGreaterThan(5);
        // Spot-check the load-bearing ones the prompt-budget incident hit
        // (memory + workspace context, the two biggest sections in a long
        // session, must be capped or they runaway through compaction).
        expect(keys).toContain('memoryContext');
        expect(keys).toContain('workspaceContext');
        expect(keys).toContain('identityBlocks');
        // Each cap is a positive integer (catch typoed `0` or string caps)
        for (const k of keys) {
            const cap = SECTION_CAP_DEFAULTS[k as keyof typeof SECTION_CAP_DEFAULTS];
            expect(Number.isInteger(cap) && cap > 0, `cap for "${k}" is invalid: ${cap}`).toBe(true);
        }
    });

    it('applyCaps trims sections beyond their declared cap (with small marker slack)', () => {
        const keys = Object.keys(SECTION_CAP_DEFAULTS) as Array<keyof typeof SECTION_CAP_DEFAULTS>;
        expect(keys.length).toBeGreaterThan(0);

        // Make each section 4× its declared cap. After applyCaps each
        // returned section MUST be ≤ its cap + a small slack for the
        // truncation marker ("…[trimmed N bytes]" or similar).
        const SLACK = 256;
        const oversized = keys.map(name => {
            const cap = SECTION_CAP_DEFAULTS[name];
            return { name: name as string, content: 'x'.repeat(cap * 4) };
        });
        const capped = applyCaps(oversized);
        for (const s of capped) {
            const limit = SECTION_CAP_DEFAULTS[s.name as keyof typeof SECTION_CAP_DEFAULTS];
            expect(
                s.content.length,
                `section "${s.name}" wasn't trimmed near its cap (${limit}, got ${s.content.length})`,
            ).toBeLessThanOrEqual(limit + SLACK);
        }
        // Aggregate must be under sum-of-caps + per-section slack.
        const totalCap = Object.values(SECTION_CAP_DEFAULTS).reduce((a, b) => a + b, 0);
        expect(totalSize(capped)).toBeLessThanOrEqual(totalCap + SLACK * keys.length);
    });

    it('applyCaps passes through small sections unchanged', () => {
        const small = [{ name: 'persona', content: 'I am TITAN.' }];
        const r = applyCaps(small);
        expect(r[0].content).toBe('I am TITAN.');
    });
});

// ─── H2.3 — Verifier catches realistic failure shapes (silent-on-success) ────

describe('H2.3 — verifier catches the failures small models silently claim succeeded', () => {
    it('shell non-zero exit → ok=false + actionable reason', () => {
        const v = verifyToolResult({
            toolName: 'shell',
            args: { command: 'false' },
            result: 'exitCode: 1\nstderr: command failed',
        });
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/exit/i);
    });

    it('filesystem Error: prefix → ok=false', () => {
        const v = verifyToolResult({
            toolName: 'write_file',
            args: { path: '/forbidden', content: 'x' },
            result: 'Error: EACCES permission denied: /forbidden',
        });
        expect(v.ok).toBe(false);
    });

    it('web_fetch HTTP 5xx → ok=false with actionable hint', () => {
        const v = verifyToolResult({
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
            result: { status: 503 },
        });
        expect(v.ok).toBe(false);
        const msg = buildVerifierFeedback('web_fetch', v);
        expect(msg).toContain('web_fetch');
        expect(msg.toLowerCase()).toMatch(/retry|acknowledge|do not claim success/i);
    });

    it('silent-on-success — clean shell call returns no reason/severity', () => {
        const v = verifyToolResult({
            toolName: 'shell',
            args: { command: 'echo ok' },
            result: 'ok',
        });
        expect(v.ok).toBe(true);
        expect(v.reason).toBeUndefined();
        expect(v.severity).toBeUndefined();
    });
});

// ─── H2.4 — Tool intent registry covers the actual tool names ───────────

describe('H2.4 — tool intent classification is wired to the live tool set', () => {
    it('shell is destructive', () => {
        expect(getToolKind('shell')).toBe('destructive');
        expect(isDestructive('shell')).toBe(true);
    });

    it('write_file is risky-mutating, not destructive', () => {
        expect(getToolKind('write_file')).toBe('risky');
        expect(isRisky('write_file')).toBe(true);
        expect(isDestructive('write_file')).toBe(false);
    });

    it('read_file is plain sync', () => {
        expect(getToolKind('read_file')).toBe('sync');
        expect(isRisky('read_file')).toBe(false);
    });

    it('unknown tool defaults to sync (no false-risky panics)', () => {
        expect(getToolKind('this_tool_does_not_exist_anywhere')).toBe('sync');
    });
});

// ─── H2.5 — Output cap clips with tool-aware hints ──────────────────────

describe('H2.5 — tool output cap protects the context window with steering hints', () => {
    it('shell output over the cap gets truncated with a shell-specific hint', () => {
        const huge = 'a'.repeat(DEFAULT_OUTPUT_CAP * 1.5);
        const r = capToolOutput('shell', huge);
        expect(r.truncated).toBe(true);
        expect(r.content.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_CAP + 1000);
        expect(r.content.toLowerCase()).toMatch(/grep|head|pipe|filter|narrower/);
    });

    it('read_file hint mentions startLine/endLine — the right next action', () => {
        const huge = 'b'.repeat(DEFAULT_OUTPUT_CAP * 1.5);
        const r = capToolOutput('read_file', huge);
        expect(r.truncated).toBe(true);
        expect(r.content.toLowerCase()).toMatch(/startline|endline|specific section|range/);
    });

    it('small outputs pass through untouched (silent-on-success)', () => {
        const r = capToolOutput('shell', 'hi');
        expect(r.truncated).toBe(false);
        expect(r.content).toBe('hi');
    });
});

// ─── H2.6 — Widget side-channel: emitter → subscriber session-scoped ────

describe('H2.6 — widget side-channel delivers without an _____react fence', () => {
    it('subscribers see events for their session and nobody else', () => {
        const received: WidgetEvent[] = [];
        const off = subscribeWidgets('integration-sess-A', e => received.push(e));
        emitWidget('integration-sess-A', {
            name: 'Test Clock',
            source: 'export default () => <div>tick</div>',
            w: 4, h: 4,
        });
        emitWidget('integration-sess-B', {
            name: 'Other Session Widget',
            source: 'export default () => null',
        });
        off();
        expect(received).toHaveLength(1);
        expect(received[0].widget.name).toBe('Test Clock');
        expect(received[0].mode).toBe('create');
    });

    it('create_widget tool fires an event end-to-end through the registered handler', async () => {
        const { setCurrentSessionId } = await import('../../src/agent/agent.js');
        const received: WidgetEvent[] = [];
        setCurrentSessionId('integration-sess-create');
        const off = subscribeWidgets('integration-sess-create', e => received.push(e));
        try {
            const handlers = new Map(getRegisteredTools().map(t => [t.name, t]));
            const create = handlers.get('create_widget');
            expect(create, 'create_widget must be registered (registerCanvasWidgetsSkill in beforeAll)').toBeDefined();
            const result = await create!.execute({
                name: 'Pipeline Test Widget',
                source: 'export default () => null',
                w: 4, h: 4,
            });
            expect(typeof result).toBe('string');
            expect(result.toLowerCase()).toMatch(/created|prepared/);
            expect(received).toHaveLength(1);
            expect(received[0].widget.name).toBe('Pipeline Test Widget');
            expect(received[0].mode).toBe('create');
        } finally {
            off();
            setCurrentSessionId(null);
        }
    });
});

// ─── H2.7 — Delegation contract: registered tool + composer + 4 fields ──

describe('H2.7 — agent_delegate 4-field contract reaches subagents intact', () => {
    it('all four contract fields appear with their headers, in documented order', () => {
        const task = composeDelegationTask({
            objective: 'Compare top 3 vector DBs on cost and latency.',
            outputFormat: 'Markdown table: name | $/M-q | p99 ms | notes',
            toolGuidance: 'web_search first, then web_fetch on each vendor.',
            boundaries: 'Do not invent numbers. Say so when a price is private.',
            context: 'User is picking between Pinecone, Weaviate, and Qdrant.',
        });
        const idx = (h: string) => task.indexOf(h);
        expect(idx('## Objective')).toBeGreaterThanOrEqual(0);
        expect(idx('## Objective')).toBeLessThan(idx('## Output Format'));
        expect(idx('## Output Format')).toBeLessThan(idx('## Tool Guidance'));
        expect(idx('## Tool Guidance')).toBeLessThan(idx('## Boundaries (do NOT)'));
        expect(idx('## Boundaries (do NOT)')).toBeLessThan(idx('## Context'));
    });

    it('agent_delegate registered with effort-scaling ladder in its description', () => {
        const handlers = new Map(getRegisteredTools().map(t => [t.name, t]));
        const delegate = handlers.get('agent_delegate');
        expect(delegate, 'agent_delegate must be registered (registerAgentHandoffSkill in beforeAll)').toBeDefined();
        const desc = delegate!.description.toLowerCase();
        expect(desc).toMatch(/agent_team|2.4 alternatives|simple|broad survey/);
    });

    it('agent_delegate parameters expose the 4 new contract fields additively', () => {
        const handlers = new Map(getRegisteredTools().map(t => [t.name, t]));
        const delegate = handlers.get('agent_delegate');
        expect(delegate).toBeDefined();
        const p = delegate!.parameters as { properties: Record<string, unknown>; required: string[] };
        // Legacy fields preserved
        expect(p.properties.task).toBeDefined();
        expect(p.properties.context).toBeDefined();
        // New 4-field contract surfaces
        expect(p.properties.objective).toBeDefined();
        expect(p.properties.output_format).toBeDefined();
        expect(p.properties.tool_guidance).toBeDefined();
        expect(p.properties.boundaries).toBeDefined();
        // Only `role` is structurally required (handler enforces task XOR objective)
        expect(p.required).toContain('role');
        expect(p.required).not.toContain('task');
    });
});

// ─── H2.8 — Live tool execution through registry + executeTool wrapper ──

describe('H2.8 — executeTool runs registered tool through the full path', () => {
    it('create_widget via executeTool returns a confirmation when session is set', async () => {
        const { setCurrentSessionId } = await import('../../src/agent/agent.js');
        const received: WidgetEvent[] = [];
        setCurrentSessionId('integration-sess-h28');
        const off = subscribeWidgets('integration-sess-h28', e => received.push(e));
        try {
            const result = await executeTool({
                id: 'pipe-h28-create',
                type: 'function',
                function: {
                    name: 'create_widget',
                    arguments: JSON.stringify({
                        name: 'H2.8 Widget',
                        source: 'export default () => null',
                        w: 3, h: 3,
                    }),
                },
            });
            expect(result.success, `executeTool failed: ${result.content}`).not.toBe(false);
            expect(result.content.toLowerCase()).toMatch(/created|prepared/);
            // The side-channel event should have landed for our session.
            expect(received.length).toBeGreaterThanOrEqual(1);
        } finally {
            off();
            setCurrentSessionId(null);
        }
    });
});

// Tell tsc that registerTool import is intentional (used in describe.skip below
// in case we extend with more direct-injection cases). Tagged as `_` to satisfy
// strict-import rules without burning a comment.
const _registerTool = registerTool; void _registerTool;
