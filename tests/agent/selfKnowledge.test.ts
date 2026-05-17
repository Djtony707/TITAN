import { describe, expect, it } from 'vitest';
import { getSelfKnowledge } from '../../src/agent/selfKnowledge.js';

describe('getSelfKnowledge', () => {
    it('returns the self-knowledge shape without throwing', async () => {
        const snapshot = await getSelfKnowledge();

        expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
        expect(typeof snapshot.npmDownloads).toBe('number');
        expect(typeof snapshot.skillCount).toBe('number');
        expect(typeof snapshot.toolCount).toBe('number');
        expect(Array.isArray(snapshot.recentCommitMessages)).toBe(true);
        expect(Array.isArray(snapshot.recentReleaseNotes)).toBe(true);
        expect(snapshot.activityLast24h).toEqual(expect.objectContaining({
            toolCalls: expect.any(Number),
            missionsCompleted: expect.any(Number),
            postsToFb: expect.any(Number),
            ssePushes: expect.any(Number),
        }));
        expect(snapshot.drives === null || typeof snapshot.drives === 'object').toBe(true);
        expect(typeof snapshot.errorsLast24h).toBe('number');
        expect(typeof snapshot.currentModel).toBe('string');
        expect(snapshot.hostMetrics).toEqual(expect.objectContaining({
            cpuPercent: expect.any(Number),
            memPercent: expect.any(Number),
            diskPercent: expect.any(Number),
        }));
    });
});
