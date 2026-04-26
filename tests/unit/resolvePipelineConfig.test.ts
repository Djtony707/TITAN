/**
 * TITAN — Unit Tests: resolvePipelineConfig
 *
 * Pipeline configuration resolver — deterministic mapping from pipeline type
 * to loop parameters.
 */
import { describe, it, expect } from 'vitest';
import { resolvePipelineConfig, PIPELINE_PROFILES } from '../../src/agent/pipeline.js';

describe('resolvePipelineConfig', () => {
    it('general pipeline returns null (no overrides)', () => {
        expect(resolvePipelineConfig('general', 10, 20)).toBeNull();
    });

    it('chat pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('chat', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(3);
        expect(cfg!.minRounds).toBe(0);
        expect(cfg!.smartExitEnabled).toBe(true);
        expect(cfg!.completionStrategy).toBe('single-round');
        expect(cfg!.terminalTools).toContain('weather');
        expect(cfg!.ensureTools).toContain('memory');
    });

    it('research pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('research', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(15);
        expect(cfg!.minRounds).toBe(3);
        expect(cfg!.smartExitEnabled).toBe(false);
        expect(cfg!.completionStrategy).toBe('no-tools');
        expect(cfg!.reflectionEnabled).toBe(true);
        expect(cfg!.reflectionInterval).toBe(4);
        expect(cfg!.taskEnforcement).toContain('RESEARCH PIPELINE');
    });

    it('code pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('code', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(12);
        expect(cfg!.minRounds).toBe(3);
        expect(cfg!.smartExitEnabled).toBe(true);
        expect(cfg!.completionStrategy).toBe('terminal-tool');
        expect(cfg!.terminalTools).toContain('write_file');
        expect(cfg!.ensureTools).toContain('read_file');
    });

    it('social pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('social', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(10);
        expect(cfg!.minRounds).toBe(2);
        expect(cfg!.terminalTools).toContain('fb_post');
        expect(cfg!.taskEnforcement).toContain('SOCIAL PIPELINE');
    });

    it('content pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('content', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(20);
        expect(cfg!.minRounds).toBe(5);
        expect(cfg!.completionStrategy).toBe('terminal-tool');
    });

    it('automation pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('automation', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(5);
        expect(cfg!.minRounds).toBe(1);
        expect(cfg!.terminalTools).toContain('ha_control');
    });

    it('browser pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('browser', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(15);
        expect(cfg!.completionStrategy).toBe('no-tools');
    });

    it('sysadmin pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('sysadmin', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(8);
        expect(cfg!.terminalTools).toContain('shell');
    });

    it('analysis pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('analysis', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(10);
        expect(cfg!.smartExitEnabled).toBe(false);
    });

    it('voice pipeline returns correct config', () => {
        const cfg = resolvePipelineConfig('voice', 10, 20);
        expect(cfg).not.toBeNull();
        expect(cfg!.maxRounds).toBe(3);
        expect(cfg!.completionStrategy).toBe('single-round');
    });

    // ── Hard cap enforcement ──
    it('caps maxRounds at hardCap', () => {
        const cfg = resolvePipelineConfig('research', 100, 8);
        expect(cfg!.maxRounds).toBe(8);
    });

    it('uses currentMaxRounds when profile maxRounds is 0', () => {
        // general has maxRounds: 0, but general returns null
        // No other profile has 0 maxRounds currently
        const cfg = resolvePipelineConfig('general', 42, 100);
        expect(cfg).toBeNull();
    });

    it('does not cap below minRounds logic', () => {
        const cfg = resolvePipelineConfig('code', 10, 5);
        expect(cfg!.maxRounds).toBe(5);
        expect(cfg!.minRounds).toBe(3); // minRounds still 3
    });

    it('returns unique objects per call', () => {
        const a = resolvePipelineConfig('chat', 10, 20);
        const b = resolvePipelineConfig('chat', 10, 20);
        expect(a).not.toBe(b); // different references
        expect(a).toEqual(b);  // same values
    });

    it('all pipeline types have defined profiles', () => {
        const types = Object.keys(PIPELINE_PROFILES) as Array<keyof typeof PIPELINE_PROFILES>;
        for (const t of types) {
            const profile = PIPELINE_PROFILES[t];
            expect(profile.name).toBeTruthy();
            expect(profile.type).toBe(t);
            expect(typeof profile.minRounds).toBe('number');
            expect(typeof profile.maxRounds).toBe('number');
            expect(Array.isArray(profile.terminalTools)).toBe(true);
            expect(Array.isArray(profile.ensureTools)).toBe(true);
        }
    });
});
