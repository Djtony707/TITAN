/**
 * TITAN — Architecture map sanity tests
 */
import { describe, it, expect } from 'vitest';
import {
    TITAN_ARCHITECTURE, renderArchitectureBlock, relevantSubsystems,
} from '../src/memory/architecture.js';

describe('architecture map', () => {
    it('has at least 8 subsystems with files + integration points', () => {
        expect(TITAN_ARCHITECTURE.length).toBeGreaterThanOrEqual(8);
        for (const s of TITAN_ARCHITECTURE) {
            expect(s.files.length).toBeGreaterThan(0);
            expect(s.integrationPoints.length).toBeGreaterThan(0);
            // Each integration point must tell you what to do
            for (const ip of s.integrationPoints) {
                expect(ip.when).toBeTruthy();
                expect(ip.mustAlso.length).toBeGreaterThan(0);
            }
        }
    });

    it('renders a non-empty block for a goal-driver goal', () => {
        const block = renderArchitectureBlock({ title: 'Add a new driver phase', tags: ['driver', 'goal'] });
        expect(block).toContain('GOAL-DRIVER');
        expect(block).toContain('tickDriver');
    });

    it('renders a self-repair block for auto-heal goals', () => {
        const block = renderArchitectureBlock({ title: 'Wire auto-heal strategies', tags: ['self-repair', 'auto-heal'] });
        expect(block).toContain('SELF-REPAIR');
        expect(block).toContain('src/lib/auto-heal');
    });

    it('renders full map when no match — fallback', () => {
        const block = renderArchitectureBlock({ title: 'unrelated topic xyzzy', tags: [] });
        // Falls back to ALL subsystems
        expect(block).toContain('GOAL-DRIVER');
        expect(block).toContain('SOMA');
    });

    it('relevantSubsystems returns matching ids', () => {
        const ids = relevantSubsystems({ title: 'Add endpoint /api/drivers/stream', tags: ['api', 'sse'] });
        expect(ids).toContain('api');
    });

    it('rendered block reminds specialist to wire new modules', () => {
        const block = renderArchitectureBlock();
        expect(block.toLowerCase()).toContain('wire');
        expect(block).toContain('dead code');
    });
});
