import { describe, it, expect } from 'vitest';
import {
    MEMORY_TAXONOMY, summarizeMemoryTaxonomy, renderMemoryTaxonomy,
} from '../src/memory/taxonomy.js';

describe('memory taxonomy — definition', () => {
    it('declares at least 9 named types (≥ the field\'s 8)', () => {
        expect(MEMORY_TAXONOMY.length).toBeGreaterThanOrEqual(9);
    });

    it('every type maps to a real in-repo module and has unique keys', () => {
        const keys = MEMORY_TAXONOMY.map((t) => t.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const t of MEMORY_TAXONOMY) {
            expect(t.module).toMatch(/src\/|cron/);
            expect(t.captures.length).toBeGreaterThan(0);
            expect(t.recall.length).toBeGreaterThan(0);
        }
    });

    it('exactly one type is flagged as the unique differentiator — the drive-backed emotional type', () => {
        const diff = MEMORY_TAXONOMY.filter((t) => t.differentiator);
        expect(diff).toHaveLength(1);
        expect(diff[0].key).toBe('emotional');
    });
});

describe('memory taxonomy — availability probe', () => {
    it('always-on types are active even with empty config; opt-in types are inactive', () => {
        const s = summarizeMemoryTaxonomy({});
        expect(s.total).toBe(MEMORY_TAXONOMY.length);
        // Soma off + mesh off + no hindsight → emotional & shared inactive.
        const emotional = s.types.find((t) => t.key === 'emotional')!;
        const shared = s.types.find((t) => t.key === 'shared')!;
        expect(emotional.availability).toBe('unavailable');
        expect(shared.availability).toBe('unavailable');
        // Working/episodic/etc. are always-on.
        expect(s.types.find((t) => t.key === 'working')!.availability).toBe('always-on');
        expect(s.active).toBe(MEMORY_TAXONOMY.length - 2);
    });

    it('enabling Soma activates the emotional/drive type', () => {
        const s = summarizeMemoryTaxonomy({ organism: { enabled: true } });
        expect(s.types.find((t) => t.key === 'emotional')!.availability).toBe('opt-in');
    });

    it('mesh OR a hindsight connection activates the shared type', () => {
        expect(summarizeMemoryTaxonomy({ mesh: { enabled: true } }).types.find((t) => t.key === 'shared')!.availability).toBe('connected');
        expect(summarizeMemoryTaxonomy({}, { hindsightConnected: true }).types.find((t) => t.key === 'shared')!.availability).toBe('connected');
    });

    it('fully-enabled config marks every type active', () => {
        const s = summarizeMemoryTaxonomy({ organism: { enabled: true }, mesh: { enabled: true } });
        expect(s.active).toBe(s.total);
    });
});

describe('memory taxonomy — render', () => {
    it('renders the differentiator star and a header with counts', () => {
        const out = renderMemoryTaxonomy(summarizeMemoryTaxonomy({ organism: { enabled: true } }));
        expect(out).toMatch(/memory taxonomy — \d+ types \(\d+ active\)/);
        expect(out).toContain('⭐ (unique to TITAN)');
        expect(out).toContain('Emotional / Drive');
    });
});
