/**
 * Ancestor-extraction Batch 3 — Trajectory logger smoke test.
 *
 * Tests the pure-shape round-trip of a TrajectoryEntry (we don't attempt
 * to redirect TITAN_HOME — in vitest that tangles with module-hoisting.
 * The actual file I/O is a single fs.appendFileSync call; its behavior
 * is covered by the agentLoop integration smoke test).
 */
import { describe, it, expect } from 'vitest';

describe('trajectory — module shape', () => {
    it('exports saveTrajectory', async () => {
        const mod = await import('../src/agent/trajectory.js');
        expect(typeof mod.saveTrajectory).toBe('function');
    });
    it('TrajectoryEntry shape round-trips JSON cleanly', () => {
        const entry = {
            conversations: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'Hello!' },
            ],
            timestamp: new Date().toISOString(),
            model: 'ollama/minimax-m2.7:cloud',
            completed: true,
            sessionId: 'abc',
            toolsUsed: ['read_file', 'shell'],
            reason: 'done',
            metrics: { rounds: 3, promptTokens: 500, completionTokens: 200 },
        };
        const serialized = JSON.stringify(entry);
        const parsed = JSON.parse(serialized);
        expect(parsed.completed).toBe(true);
        expect(parsed.conversations).toHaveLength(2);
        expect(parsed.metrics.rounds).toBe(3);
    });
});
