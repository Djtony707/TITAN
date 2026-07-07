/**
 * Self-Critique (Organ 5) tests — the pure gate/prompt/parse/format helpers.
 */
import { describe, it, expect } from 'vitest';
import {
    shouldCritique, buildCritiquePrompt, parseCritique, formatReflection,
    resolveSelfCritique, DEFAULT_SELF_CRITIQUE, type SelfCritiqueConfig,
} from '../src/agent/selfCritique.js';

const on: SelfCritiqueConfig = { ...DEFAULT_SELF_CRITIQUE, enabled: true };

describe('shouldCritique', () => {
    it('off by default config never fires', () => {
        expect(shouldCritique(DEFAULT_SELF_CRITIQUE, 'x'.repeat(500), ['shell'])).toBe(false);
    });
    it('fires on a substantive turn when enabled', () => {
        expect(shouldCritique(on, 'x'.repeat(500), ['shell'])).toBe(true);
    });
    it('skips trivial (short) drafts', () => {
        expect(shouldCritique(on, 'ok', ['shell'])).toBe(false);
    });
    it('skips turns with too few tool calls', () => {
        expect(shouldCritique({ ...on, minToolCalls: 2 }, 'x'.repeat(500), ['shell'])).toBe(false);
    });
    it('never re-critiques an already-caveated reply (no loops)', () => {
        expect(shouldCritique(on, 'x'.repeat(500) + '\n\n_On reflection: foo_', ['shell'])).toBe(false);
        expect(shouldCritique(on, 'x'.repeat(500) + '\n\n⚠️ Correction: bar', ['shell'])).toBe(false);
    });
});

describe('buildCritiquePrompt', () => {
    it('includes the task, the tools that ran, and the draft', () => {
        const p = buildCritiquePrompt('fix the build', 'I fixed it.', ['shell', 'edit_file']);
        expect(p).toContain('fix the build');
        expect(p).toContain('shell, edit_file');
        expect(p).toContain('I fixed it.');
        expect(p).toContain('CLAIMED-BUT-UNVERIFIED');
    });
    it('marks no-tools turns explicitly', () => {
        expect(buildCritiquePrompt('t', 'd', [])).toContain('(none)');
    });
});

describe('parseCritique', () => {
    it('SOLID → no issues', () => {
        expect(parseCritique('SOLID')).toEqual({ solid: true, issues: [] });
        expect(parseCritique('  solid  ')).toEqual({ solid: true, issues: [] });
    });
    it('bullets → issues (capped at 3)', () => {
        const v = parseCritique('- claimed deploy but no deploy tool ran\n- the port number is wrong\n- missing rollback caveat\n- extra');
        expect(v.solid).toBe(false);
        expect(v.issues).toHaveLength(3);
        expect(v.issues[0]).toContain('claimed deploy');
    });
    it('malformed / no-bullet response is treated as solid (no noise)', () => {
        expect(parseCritique('Looks fine to me overall.')).toEqual({ solid: true, issues: [] });
        expect(parseCritique('')).toEqual({ solid: true, issues: [] });
    });
});

describe('formatReflection', () => {
    it('empty → empty', () => {
        expect(formatReflection([])).toBe('');
    });
    it('one issue → single italic line', () => {
        expect(formatReflection(['the port is wrong'])).toContain('_On reflection: the port is wrong_');
    });
    it('multiple → bulleted block', () => {
        const out = formatReflection(['a', 'b']);
        expect(out).toContain('caveats');
        expect((out.match(/^- /gm) || []).length).toBe(2);
    });
});

describe('resolveSelfCritique — the one-switch Reliability Mode', () => {
    it('reliabilityMode ON flips self-critique on when not explicitly set', () => {
        expect(resolveSelfCritique(undefined, true).enabled).toBe(true);
        expect(resolveSelfCritique({}, true).enabled).toBe(true);
    });
    it('reliabilityMode OFF leaves the default (off)', () => {
        expect(resolveSelfCritique(undefined, false).enabled).toBe(false);
    });
    it('an explicit selfCritique.enabled=false wins over reliabilityMode', () => {
        expect(resolveSelfCritique({ enabled: false }, true).enabled).toBe(false);
    });
    it('an explicit selfCritique.enabled=true is honored without reliabilityMode', () => {
        expect(resolveSelfCritique({ enabled: true }, false).enabled).toBe(true);
    });
    it('preserves other tuning fields', () => {
        expect(resolveSelfCritique({ minToolCalls: 3 }, true)).toMatchObject({ enabled: true, minToolCalls: 3 });
    });
});
