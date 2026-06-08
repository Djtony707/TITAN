/**
 * TITAN — Memory taxonomy skill (v7.0)
 *
 * Surfaces TITAN's named memory taxonomy (see src/memory/taxonomy.ts) with live
 * availability. Answers "what do you remember, and how?" with the honest map of
 * the nine real memory subsystems — including the emotional/drive type that no
 * competitor has. Backs the v7.0 Memory panel and counters the field's
 * "N memory types" marketing with a real, drive-backed taxonomy.
 */
import { registerSkill } from '../registry.js';
import { summarizeMemoryTaxonomy, renderMemoryTaxonomy } from '../../memory/taxonomy.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'MemoryMap';

export function registerMemoryMapSkill(): void {
    registerSkill(
        { name: 'memory_map', description: "Describe TITAN's named memory taxonomy and which types are active", version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'memory_map',
            description:
                "Describe TITAN's MEMORY TAXONOMY — the nine named memory types (working, episodic, semantic, procedural, emotional/drive, prospective, relational, narrative, shared), what each captures, the real subsystem backing it, and whether it's active right now.\n\n" +
                'USE THIS WHEN: "what do you remember?", "what kinds of memory do you have?", "what\'s your memory architecture?", or to explain how TITAN persists context across turns and sessions.',
            parameters: { type: 'object', properties: {}, required: [] },
            execute: async (): Promise<string> => {
                try {
                    const config = loadConfig() as unknown as Record<string, unknown>;
                    let hindsightConnected = false;
                    try {
                        const { memory } = await import('../../memory/facade.js');
                        hindsightConnected = Boolean(await memory.episodic.isCrossSessionConnected());
                    } catch { /* Hindsight optional */ }
                    const summary = summarizeMemoryTaxonomy(config, { hindsightConnected });
                    logger.info(COMPONENT, `Memory taxonomy: ${summary.active}/${summary.total} types active`);
                    return renderMemoryTaxonomy(summary);
                } catch (e) {
                    return `Failed to summarize memory taxonomy: ${(e as Error).message}`;
                }
            },
        },
    );
}
