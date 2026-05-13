/**
 * TITAN — v6.1.0-alpha.9 anti-rationalization scaffolding tests
 *
 * Borrowed from addyosmani/agent-skills: each skill carries an
 * "anti-rationalization table" (common excuses to skip steps + their
 * rebuttals) plus a "red flag" line marking dangerous shortcuts. We
 * folded the same idea into each TITAN specialist's `systemPromptSuffix`
 * with role-specific content (Scout cites sources, Builder runs the
 * code, Writer checks tone, Analyst shows math, Sage names risks).
 *
 * These tests pin the structure so a future prompt refactor can't
 * silently drop the scaffolding.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SPECIALISTS } from '../src/agent/specialists.js';

describe('v6.1.0-alpha.9 — anti-rationalization scaffolding', () => {
    it('every specialist has a "Before you …" anti-rationalization header', () => {
        for (const sp of SPECIALISTS) {
            expect(
                sp.systemPromptSuffix,
                `${sp.name} missing anti-rationalization header`,
            ).toMatch(/── BEFORE YOU/);
        }
    });

    it('every specialist has at least one "Red flag" line', () => {
        for (const sp of SPECIALISTS) {
            expect(
                sp.systemPromptSuffix,
                `${sp.name} missing a "Red flag" line`,
            ).toMatch(/Red flag:/);
        }
    });

    it('every specialist has at least 3 excuse → rebuttal pairs (• "..." → ...)', () => {
        for (const sp of SPECIALISTS) {
            const arrowLines = sp.systemPromptSuffix.match(/•\s+"[^"]+"\s+→/g) ?? [];
            expect(
                arrowLines.length,
                `${sp.name} has ${arrowLines.length} excuse→rebuttal pairs, want >= 3`,
            ).toBeGreaterThanOrEqual(3);
        }
    });

    // Role-specific anchors — verify the scaffolding actually addresses
    // each specialist's failure mode, not just copy-pasted boilerplate.
    it('Scout\'s scaffolding emphasizes citing sources', () => {
        const scout = SPECIALISTS.find(s => s.id === 'scout')!;
        expect(scout.systemPromptSuffix).toMatch(/cite/i);
        expect(scout.systemPromptSuffix).toMatch(/web_fetch|web_search/);
    });

    it('Builder\'s scaffolding emphasizes running the code, not just compiling', () => {
        const builder = SPECIALISTS.find(s => s.id === 'builder')!;
        expect(builder.systemPromptSuffix).toMatch(/run it|stdout|stderr/i);
        expect(builder.systemPromptSuffix).toMatch(/compile|TypeScript/i);
    });

    it('Writer\'s scaffolding emphasizes voice/tone matching (not the writer\'s default)', () => {
        const writer = SPECIALISTS.find(s => s.id === 'writer')!;
        expect(writer.systemPromptSuffix).toMatch(/voice|tone/i);
        expect(writer.systemPromptSuffix).toMatch(/their|recipient/i);
    });

    it('Analyst\'s scaffolding emphasizes showing math + naming thresholds', () => {
        const analyst = SPECIALISTS.find(s => s.id === 'analyst')!;
        expect(analyst.systemPromptSuffix).toMatch(/show your math|arithmetic/i);
        expect(analyst.systemPromptSuffix).toMatch(/threshold|baseline|p-value/i);
    });

    it('Sage\'s scaffolding emphasizes naming the specific risk + worst-case', () => {
        const sage = SPECIALISTS.find(s => s.id === 'sage')!;
        expect(sage.systemPromptSuffix).toMatch(/specific risk|worst-case/i);
        expect(sage.systemPromptSuffix).toMatch(/irreversible|revert|deleted|deployed|published/i);
    });

    it('scaffolding sits at the END of the suffix (so role intro stays prominent at the start)', () => {
        for (const sp of SPECIALISTS) {
            const beforeIdx = sp.systemPromptSuffix.indexOf('── BEFORE YOU');
            const specialistIdx = sp.systemPromptSuffix.indexOf('── SPECIALIST:');
            expect(beforeIdx, `${sp.name}: anti-rat header missing`).toBeGreaterThan(0);
            expect(specialistIdx, `${sp.name}: specialist header missing`).toBeGreaterThanOrEqual(0);
            expect(
                beforeIdx,
                `${sp.name}: anti-rationalization should come AFTER the role intro`,
            ).toBeGreaterThan(specialistIdx);
        }
    });
});
