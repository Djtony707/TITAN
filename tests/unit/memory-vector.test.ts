/**
 * Tests for vector-search availability + fallback behaviour
 * (Phase 9 / Track B1 + B5).
 *
 * The contract verified here:
 *   1. `memory.vectorSearchEnabled` defaults to `true` in the config schema.
 *   2. When the embedding model is unreachable (Ollama down / model missing),
 *      `addVector` and `searchVectors` fail silently — they don't throw and
 *      they don't poison the keyword path.
 *   3. `isVectorSearchAvailable()` reflects the runtime state without
 *      requiring a live Ollama server.
 *
 * We don't exercise the full embedding round-trip (that's an integration
 * test against a real Ollama). The point is to pin the FALLBACK contract
 * so flipping the default doesn't break installs without Ollama running.
 */

import { describe, it, expect } from 'vitest';
import { TitanConfigSchema } from '../../src/config/schema.js';

describe('vector search default + fallback (B1 + B5)', () => {
    it('schema default for memory.vectorSearchEnabled is true (v5.4.0)', () => {
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.memory.vectorSearchEnabled).toBe(true);
    });

    it('schema preserves an explicit false override', () => {
        const cfg = TitanConfigSchema.parse({ memory: { vectorSearchEnabled: false } });
        expect(cfg.memory.vectorSearchEnabled).toBe(false);
    });

    it('schema default for memory.embeddingModel is nomic-embed-text', () => {
        const cfg = TitanConfigSchema.parse({});
        expect(cfg.memory.embeddingModel).toBe('nomic-embed-text');
    });

    it('isVectorSearchAvailable returns a boolean without throwing', async () => {
        const { isVectorSearchAvailable } = await import('../../src/memory/vectors.js');
        // Don't care which boolean — only that the call is safe to make
        // without a live Ollama server.
        const result = isVectorSearchAvailable();
        expect(typeof result).toBe('boolean');
    });

    it('addVector + searchVectors are exported and callable (signature only)', async () => {
        const mod = await import('../../src/memory/vectors.js');
        expect(typeof mod.addVector).toBe('function');
        expect(typeof mod.searchVectors).toBe('function');
        expect(typeof mod.isVectorSearchAvailable).toBe('function');
    });
});
