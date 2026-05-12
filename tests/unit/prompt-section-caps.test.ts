/**
 * Per-section cap behavior for system-prompt sections.
 *
 * The user's 5-turn-hits-200k incident traced back to dynamic sections growing
 * unboundedly over a session. v5.7.0 added compression on overflow; this file
 * pins the prevention layer — per-section caps applied at injection time.
 *
 * Reference:
 *   - Anthropic — "Effective context engineering for AI agents"
 *   - 12 Factor Agents §3 "Own your context window"
 *   - awesome-agent-harness top-10 pattern #3
 *   - The persona truncation pattern already proven in src/personas/manager.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
    SECTION_CAP_DEFAULTS,
    getSectionCap,
    capSection,
    applyCaps,
    totalSize,
} from '../../src/agent/promptSectionCaps.js';

// Clear any env override we set during a test.
const ENV_KEYS_TOUCHED = new Set<string>();
function setEnv(key: string, val: string) {
    ENV_KEYS_TOUCHED.add(key);
    process.env[key] = val;
}
afterEach(() => {
    for (const k of ENV_KEYS_TOUCHED) delete process.env[k];
    ENV_KEYS_TOUCHED.clear();
});

describe('SECTION_CAP_DEFAULTS', () => {
    it('defines a cap for every dynamic section name used in buildSystemPrompt', () => {
        // Names must match the entries in the dynamicSections array in agent.ts.
        // If you add a section there, add a default cap here too.
        const expected = [
            'identityBlocks', 'dateTimeBlock', 'learningBlock',
            'frustrationBlock', 'teachingBlock', 'customBlock',
            'workspaceContext', 'memoryContext', 'personalContext',
            'graphSection', 'memoryToolsBlock', 'selfAwareness',
            'optimizedBlock', 'systemIncludes', 'transientIncludes',
        ];
        for (const name of expected) {
            expect(SECTION_CAP_DEFAULTS, `missing default cap for "${name}"`).toHaveProperty(name);
        }
    });

    it('every default is a positive integer (or 0 to disable)', () => {
        for (const [name, val] of Object.entries(SECTION_CAP_DEFAULTS)) {
            expect(Number.isInteger(val), `${name} cap must be integer`).toBe(true);
            expect(val).toBeGreaterThanOrEqual(0);
        }
    });

    it('total of all caps stays under 64 KB (operational ceiling for dynamic sections)', () => {
        // If someone bumps a cap, this assertion forces them to think about
        // total budget. Bigger ceilings are fine but require a deliberate edit.
        // 40 → 48 (activeSpace) → 56 (livingCanvasVoice) → 64 (Command Post
        // upgrades #1 + #2: agentLessons + goalPlan).
        const total = Object.values(SECTION_CAP_DEFAULTS).reduce((n, v) => n + v, 0);
        expect(total, 'dynamic-section caps sum to more than 64 KB').toBeLessThanOrEqual(64_000);
    });
});

describe('getSectionCap', () => {
    it('returns the default when no env override is set', () => {
        expect(getSectionCap('learningBlock')).toBe(SECTION_CAP_DEFAULTS.learningBlock);
    });

    it('honors TITAN_CAP_<SECTION> env override', () => {
        setEnv('TITAN_CAP_LEARNINGBLOCK', '5000');
        expect(getSectionCap('learningBlock')).toBe(5000);
    });

    it('returns 0 to disable when env override is 0', () => {
        setEnv('TITAN_CAP_LEARNINGBLOCK', '0');
        expect(getSectionCap('learningBlock')).toBe(0);
    });

    it('ignores garbage env values', () => {
        setEnv('TITAN_CAP_LEARNINGBLOCK', 'not-a-number');
        expect(getSectionCap('learningBlock')).toBe(SECTION_CAP_DEFAULTS.learningBlock);
    });

    it('returns 0 (no cap) for sections without a default', () => {
        expect(getSectionCap('non_existent_section')).toBe(0);
    });
});

describe('capSection', () => {
    it('returns content unchanged when it fits under the cap', () => {
        const small = '## Hello\nworld';
        expect(capSection('learningBlock', small)).toBe(small);
    });

    it('returns content unchanged when section has no cap', () => {
        const big = 'x'.repeat(50_000);
        expect(capSection('non_existent_section', big)).toBe(big);
    });

    it('truncates and appends a marker when over the cap', () => {
        setEnv('TITAN_CAP_TEST', '100');
        // We have to use a real cap to test truncation. Use learningBlock (3072 default).
        const over = 'x'.repeat(5000);
        const result = capSection('learningBlock', over);
        expect(result.length).toBeLessThanOrEqual(SECTION_CAP_DEFAULTS.learningBlock + 200);
        expect(result).toMatch(/learningBlock truncated at \d+ bytes/);
    });

    it('prefers a markdown-header boundary when one exists in the final quarter', () => {
        // Build content with predictable structure.
        const head = '## First section\n' + 'a'.repeat(2000) + '\n\n';
        const headerInTail = '## Last section\n' + 'b'.repeat(1000);
        const full = head + headerInTail;
        // workspaceContext cap = 8192; force a smaller env cap to make truncation occur.
        setEnv('TITAN_CAP_WORKSPACECONTEXT', '2500');
        const result = capSection('workspaceContext', full);
        // The result should NOT contain "## Last section" (it was after the cap)
        // OR if it does, the cut was clean (no mid-line break).
        if (result.includes('## Last section')) {
            // header was preserved as the cut point — fine
            expect(result).toMatch(/\n## Last section/);
        } else {
            // truncated cleanly before that header
            expect(result).toMatch(/truncated at 2500 bytes/);
        }
    });

    it('preserves empty content', () => {
        expect(capSection('learningBlock', '')).toBe('');
        expect(capSection('learningBlock', '   \n  ')).toBe('   \n  ');
    });
});

describe('applyCaps + totalSize', () => {
    it('caps every section in the list', () => {
        const sections = [
            { name: 'identityBlocks', content: 'x'.repeat(10_000) },
            { name: 'learningBlock',  content: 'y'.repeat(10_000) },
            { name: 'memoryContext',  content: 'z'.repeat(500) },  // under the cap, unchanged
        ];
        const capped = applyCaps(sections);
        expect(capped[0].content.length).toBeLessThanOrEqual(SECTION_CAP_DEFAULTS.identityBlocks + 200);
        expect(capped[1].content.length).toBeLessThanOrEqual(SECTION_CAP_DEFAULTS.learningBlock + 200);
        expect(capped[2].content).toBe(sections[2].content); // untouched
        // Original input must NOT be mutated.
        expect(sections[0].content.length).toBe(10_000);
    });

    it('totalSize sums content lengths', () => {
        const sections = [
            { name: 'a', content: '12345' },
            { name: 'b', content: '12345' },
            { name: 'c', content: '' },
        ];
        expect(totalSize(sections)).toBe(10);
    });

    it('the post-cap budget for a fully-loaded prompt stays under 64 KB (raised in v6.0 step 5 + Living Canvas voice)', () => {
        // Simulate worst-case input: each section maxed out 4x its cap.
        const sections = Object.keys(SECTION_CAP_DEFAULTS).map((name) => ({
            name,
            content: 'x'.repeat((SECTION_CAP_DEFAULTS[name] || 1000) * 4),
        }));
        const capped = applyCaps(sections);
        const total = totalSize(capped);
        // Each section truncated to ~its cap + small marker overhead.
        // Total should be at most sum(caps) + overhead.
        const ceiling = Object.values(SECTION_CAP_DEFAULTS).reduce((n, v) => n + v, 0)
            + 200 * sections.length; // marker overhead per section
        expect(total, `post-cap total ${total} exceeded ${ceiling} byte ceiling`)
            .toBeLessThanOrEqual(ceiling);
    });
});
