/**
 * Tests for src/agent/personaProfiles.ts (Dad Mode plumbing v5.5.24).
 *
 * Pin the resolution-priority contract (forceId > channel pin > schedule
 * > default) and the wind-down + tool-filter behaviors. The downstream
 * features (#5 Beat-Match, #7 Stage Mode, #8 Dad Mode) all depend on this
 * resolver returning the right thing for a given (channel, time, force).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadConfig = vi.hoisted(() => vi.fn());
vi.mock('../../src/config/config.js', () => ({
    loadConfig: mockLoadConfig,
}));

const WORKER = {
    id: 'worker', name: 'Worker', voiceId: '', allowedTools: [], deniedTools: [],
    systemPromptAppendix: '', windDown: false, description: 'default',
};
const DAD = {
    id: 'dad', name: 'Dad', voiceId: '', allowedTools: ['memory', 'weather'],
    deniedTools: ['shell', 'fb_post'],
    systemPromptAppendix: '\n── DAD ──\nOff the clock.',
    schedule: { from: '18:00', to: '21:00' },
    windDown: true,
    description: 'evening family-safe',
};
const STAGEHOST = {
    id: 'stagehost', name: 'Stagehost', voiceId: 'voice123',
    allowedTools: [], deniedTools: ['shell'],
    systemPromptAppendix: '\n── STAGE ──\nLivestream co-host.',
    windDown: false,
    description: 'stream',
};

function configWith(overrides: Record<string, unknown> = {}) {
    return {
        agent: { model: 'mock' },
        personas: {
            enabled: true,
            defaultPersona: 'worker',
            channelPins: {},
            profiles: [WORKER, DAD, STAGEHOST],
            ...overrides,
        },
    };
}

describe('personaProfiles', () => {
    beforeEach(() => {
        vi.resetModules();
        mockLoadConfig.mockReset();
    });

    describe('resolveActivePersona', () => {
        it('returns null when personas.enabled=false', async () => {
            mockLoadConfig.mockReturnValue({ personas: { enabled: false, profiles: [] } });
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            expect(resolveActivePersona()).toBeNull();
        });

        it('returns null when profiles list is empty', async () => {
            mockLoadConfig.mockReturnValue({ personas: { enabled: true, profiles: [] } });
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            expect(resolveActivePersona()).toBeNull();
        });

        it('returns default persona when no rule matches', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            // 10am — outside dad schedule, no channel pin, no force
            const morning = new Date('2026-05-07T10:00:00');
            expect(resolveActivePersona({ now: morning })?.id).toBe('worker');
        });

        it('forceId beats schedule and channel pin', async () => {
            mockLoadConfig.mockReturnValue(configWith({ channelPins: { telegram: 'dad' } }));
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            // Even at 7pm on a pinned channel, forceId wins
            const evening = new Date('2026-05-07T19:00:00');
            expect(resolveActivePersona({ channel: 'telegram', now: evening, forceId: 'stagehost' })?.id).toBe('stagehost');
        });

        it('unknown forceId falls through to channel/schedule resolution', async () => {
            mockLoadConfig.mockReturnValue(configWith({ channelPins: { telegram: 'dad' } }));
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            const evening = new Date('2026-05-07T19:00:00');
            expect(resolveActivePersona({ channel: 'telegram', now: evening, forceId: 'nonexistent' })?.id).toBe('dad');
        });

        it('channel pin beats schedule', async () => {
            mockLoadConfig.mockReturnValue(configWith({ channelPins: { telegram: 'stagehost' } }));
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            // 7pm — dad schedule would normally win, but telegram is pinned
            const evening = new Date('2026-05-07T19:00:00');
            expect(resolveActivePersona({ channel: 'telegram', now: evening })?.id).toBe('stagehost');
        });

        it('schedule wins inside its window', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            const evening = new Date('2026-05-07T19:30:00');
            expect(resolveActivePersona({ now: evening })?.id).toBe('dad');
        });

        it('schedule does NOT match outside window', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            // 21:00 sharp = end exclusive
            expect(resolveActivePersona({ now: new Date('2026-05-07T21:00:00') })?.id).toBe('worker');
            // 17:59 = before start
            expect(resolveActivePersona({ now: new Date('2026-05-07T17:59:00') })?.id).toBe('worker');
        });

        it('handles midnight-crossing schedule (22:00 → 06:00)', async () => {
            const NIGHTOWL = { ...WORKER, id: 'nightowl', name: 'Night Owl', schedule: { from: '22:00', to: '06:00' } };
            mockLoadConfig.mockReturnValue({
                personas: { enabled: true, defaultPersona: 'worker', channelPins: {}, profiles: [WORKER, NIGHTOWL] },
            });
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            // 23:00 = inside crossover window
            expect(resolveActivePersona({ now: new Date('2026-05-07T23:00:00') })?.id).toBe('nightowl');
            // 03:00 = inside crossover window
            expect(resolveActivePersona({ now: new Date('2026-05-07T03:00:00') })?.id).toBe('nightowl');
            // 12:00 = outside
            expect(resolveActivePersona({ now: new Date('2026-05-07T12:00:00') })?.id).toBe('worker');
        });

        it('returns default when defaultPersona id is missing — falls to first profile', async () => {
            mockLoadConfig.mockReturnValue({
                personas: { enabled: true, defaultPersona: 'ghost', channelPins: {}, profiles: [WORKER] },
            });
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            expect(resolveActivePersona({ now: new Date('2026-05-07T10:00:00') })?.id).toBe('worker');
        });

        it('returns null when loadConfig throws', async () => {
            mockLoadConfig.mockImplementation(() => { throw new Error('disk error'); });
            const { resolveActivePersona } = await import('../../src/agent/personaProfiles.js');
            expect(resolveActivePersona()).toBeNull();
        });
    });

    describe('applyPersonaToolFilter', () => {
        it('returns tools unchanged when no persona', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { applyPersonaToolFilter } = await import('../../src/agent/personaProfiles.js');
            const tools = [{ name: 'shell' }, { name: 'memory' }];
            expect(applyPersonaToolFilter(tools, null)).toEqual(tools);
        });

        it('removes denied tools', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { applyPersonaToolFilter } = await import('../../src/agent/personaProfiles.js');
            const tools = [{ name: 'shell' }, { name: 'memory' }, { name: 'fb_post' }];
            const out = applyPersonaToolFilter(tools, DAD);
            expect(out.map(t => t.name)).toEqual(['memory']); // shell + fb_post denied; only 'memory' is in allowedTools
        });

        it('with empty allowedTools, applies only deniedTools (no extra restriction)', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { applyPersonaToolFilter } = await import('../../src/agent/personaProfiles.js');
            const tools = [{ name: 'shell' }, { name: 'memory' }, { name: 'edit_file' }];
            const out = applyPersonaToolFilter(tools, STAGEHOST);
            // STAGEHOST has allowedTools=[] (empty = no allowlist) + denies shell
            expect(out.map(t => t.name)).toEqual(['memory', 'edit_file']);
        });

        it('handles tool definitions with .function.name shape', async () => {
            const { applyPersonaToolFilter } = await import('../../src/agent/personaProfiles.js');
            const tools = [
                { type: 'function' as const, function: { name: 'shell', description: '', parameters: {} } },
                { type: 'function' as const, function: { name: 'memory', description: '', parameters: {} } },
            ];
            const out = applyPersonaToolFilter(tools, DAD);
            expect(out.length).toBe(1);
            expect(out[0].function.name).toBe('memory');
        });

        it('denial wins when a tool is in both allowedTools and deniedTools', async () => {
            const { applyPersonaToolFilter } = await import('../../src/agent/personaProfiles.js');
            const conflicting = { ...DAD, allowedTools: ['shell', 'memory'], deniedTools: ['shell'] };
            const tools = [{ name: 'shell' }, { name: 'memory' }];
            const out = applyPersonaToolFilter(tools, conflicting);
            expect(out.map(t => t.name)).toEqual(['memory']);
        });
    });

    describe('isWindDownActive', () => {
        it('returns true when active persona has windDown=true', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { isWindDownActive } = await import('../../src/agent/personaProfiles.js');
            expect(isWindDownActive(new Date('2026-05-07T19:30:00'))).toBe(true);
        });

        it('returns false when default persona has windDown=false', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { isWindDownActive } = await import('../../src/agent/personaProfiles.js');
            expect(isWindDownActive(new Date('2026-05-07T10:00:00'))).toBe(false);
        });

        it('returns false when personas disabled even if a wind-down persona exists', async () => {
            mockLoadConfig.mockReturnValue({ personas: { enabled: false, profiles: [DAD] } });
            const { isWindDownActive } = await import('../../src/agent/personaProfiles.js');
            expect(isWindDownActive(new Date('2026-05-07T19:30:00'))).toBe(false);
        });
    });

    describe('describeActivePersona', () => {
        it('returns disabled shape when personas.enabled=false', async () => {
            mockLoadConfig.mockReturnValue({ personas: { enabled: false, profiles: [] } });
            const { describeActivePersona } = await import('../../src/agent/personaProfiles.js');
            const out = describeActivePersona();
            expect(out.enabled).toBe(false);
            expect(out.activeId).toBeNull();
            expect(out.reason).toMatch(/false/);
        });

        it('explains channel-pin resolution', async () => {
            mockLoadConfig.mockReturnValue(configWith({ channelPins: { telegram: 'dad' } }));
            const { describeActivePersona } = await import('../../src/agent/personaProfiles.js');
            const out = describeActivePersona({ channel: 'telegram', now: new Date('2026-05-07T10:00:00') });
            expect(out.activeId).toBe('dad');
            expect(out.reason).toMatch(/channel pin: telegram → dad/);
        });

        it('explains schedule-window resolution', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { describeActivePersona } = await import('../../src/agent/personaProfiles.js');
            const out = describeActivePersona({ now: new Date('2026-05-07T19:30:00') });
            expect(out.activeId).toBe('dad');
            expect(out.reason).toMatch(/time window 18:00–21:00/);
            expect(out.windDown).toBe(true);
        });

        it('explains forceId resolution', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { describeActivePersona } = await import('../../src/agent/personaProfiles.js');
            const out = describeActivePersona({ forceId: 'stagehost', now: new Date('2026-05-07T10:00:00') });
            expect(out.activeId).toBe('stagehost');
            expect(out.reason).toMatch(/forced via forceId=stagehost/);
            expect(out.voiceId).toBe('voice123');
        });

        it('explains default-persona fallback', async () => {
            mockLoadConfig.mockReturnValue(configWith());
            const { describeActivePersona } = await import('../../src/agent/personaProfiles.js');
            const out = describeActivePersona({ now: new Date('2026-05-07T10:00:00') });
            expect(out.activeId).toBe('worker');
            expect(out.reason).toMatch(/default persona/);
        });
    });
});
