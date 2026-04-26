/**
 * Session cleanup — stale session eviction + idle purge
 * Phase 9 operational hardening (v5.4.0)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDb } from '../../src/memory/memory.js';

// Must mock before importing session.ts so getDb() is intercepted
vi.mock('../../src/memory/memory.js', async () => {
    const actual = await vi.importActual('../../src/memory/memory.js');
    return {
        ...actual as Record<string, unknown>,
        debouncedSave: vi.fn(),
    };
});

import {
    getOrCreateSession,
    getOrCreateSessionById,
    cleanupStaleSessions,
    activeSessions,
    isEphemeralChannel,
    sweepSessions,
    EPHEMERAL_MAX_ACTIVE,
} from '../../src/agent/session.js';

const NOW = 1_000_000_000_000;
const THIRTY_ONE_MIN = 31 * 60 * 1000;
const SEVEN_DAYS_PLUS = 7 * 24 * 60 * 60 * 1000 + 1;

describe('session cleanup', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);

        // Clear in-memory cache
        activeSessions.clear();

        // Clear store
        const db = getDb();
        db.sessions.length = 0;
        db.conversations.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('marks active sessions idle after 30 min timeout', () => {
        const s = getOrCreateSession('webchat', 'u1');
        vi.setSystemTime(NOW + THIRTY_ONE_MIN);
        cleanupStaleSessions();
        const db = getDb();
        const rec = db.sessions.find((x: { id: string }) => x.id === s.id);
        expect(rec?.status).toBe('idle');
    });

    it('evicts timed-out sessions from activeSessions cache', () => {
        const s = getOrCreateSessionById('custom-1', 'api', 'u1');
        expect(activeSessions.has('id:custom-1')).toBe(true);
        vi.setSystemTime(NOW + THIRTY_ONE_MIN);
        cleanupStaleSessions();
        expect(activeSessions.has('id:custom-1')).toBe(false);
    });

    it('purges idle sessions older than 7 days from store', () => {
        const db = getDb();
        db.sessions.push({
            id: 'old-idle',
            channel: 'api',
            user_id: 'u1',
            agent_id: 'default',
            status: 'idle',
            message_count: 0,
            created_at: new Date(NOW - SEVEN_DAYS_PLUS).toISOString(),
            last_active: new Date(NOW - SEVEN_DAYS_PLUS).toISOString(),
        });
        cleanupStaleSessions();
        expect(db.sessions.some((x: { id: string }) => x.id === 'old-idle')).toBe(false);
    });

    it('keeps idle sessions younger than 7 days in store', () => {
        const db = getDb();
        db.sessions.push({
            id: 'recent-idle',
            channel: 'api',
            user_id: 'u1',
            agent_id: 'default',
            status: 'idle',
            message_count: 0,
            created_at: new Date(NOW - 1000).toISOString(),
            last_active: new Date(NOW - 1000).toISOString(),
        });
        cleanupStaleSessions();
        expect(db.sessions.some((x: { id: string }) => x.id === 'recent-idle')).toBe(true);
    });

    it('marks then purges ancient active sessions (>7d) in one pass', () => {
        const db = getDb();
        db.sessions.push({
            id: 'ancient-active',
            channel: 'api',
            user_id: 'u1',
            agent_id: 'default',
            status: 'active',
            message_count: 0,
            created_at: new Date(NOW - SEVEN_DAYS_PLUS).toISOString(),
            last_active: new Date(NOW - SEVEN_DAYS_PLUS).toISOString(),
        });
        cleanupStaleSessions();
        // Should be purged outright — no reason to keep 7+ day idle sessions
        expect(db.sessions.some((x: { id: string }) => x.id === 'ancient-active')).toBe(false);
    });
});

// ─── Ephemeral channel TTL split + LRU cap (Phase 9 leak fix) ──────────
// These test the per-channel TTL change introduced after Kimi observed
// 755 sessions / 29min on TITAN PC v5.3.2. The bug wasn't a literal
// cleanup miss — it was that one-shot agent invocations from internal
// triggers (autoresearch-*, initiative-*, twilio-*, monitor, mesh, eval,
// api) shared the same 30min TTL as user-facing webchat. At ~26
// sessions/min creation rate, the 30min window buffered 750+ entries.
const SIX_MIN = 6 * 60 * 1000;
const TWO_MIN = 2 * 60 * 1000;

describe('isEphemeralChannel — channel classification', () => {
    it('classifies persistent channels correctly', () => {
        expect(isEphemeralChannel('webchat')).toBe(false);
        expect(isEphemeralChannel('voice')).toBe(false);
        expect(isEphemeralChannel('discord')).toBe(false);
        expect(isEphemeralChannel('telegram')).toBe(false);
        expect(isEphemeralChannel('slack')).toBe(false);
        expect(isEphemeralChannel('whatsapp')).toBe(false);
    });

    it('classifies ephemeral channels correctly', () => {
        expect(isEphemeralChannel('api')).toBe(true);
        expect(isEphemeralChannel('cli')).toBe(true);
        expect(isEphemeralChannel('eval')).toBe(true);
        expect(isEphemeralChannel('monitor')).toBe(true);
        expect(isEphemeralChannel('mesh')).toBe(true);
        expect(isEphemeralChannel('deliberation')).toBe(true);
    });

    it('classifies templated internal channels as ephemeral', () => {
        // The whole reason this fix exists — these used to leak.
        expect(isEphemeralChannel('autoresearch-trigger-tool_router')).toBe(true);
        expect(isEphemeralChannel('autoresearch-gendata-agent')).toBe(true);
        expect(isEphemeralChannel('initiative-fix')).toBe(true);
        expect(isEphemeralChannel('initiative-verify')).toBe(true);
        expect(isEphemeralChannel('twilio-call-CA1234abcd')).toBe(true);
    });

    it('defaults unknown channels to ephemeral (safer failure mode)', () => {
        expect(isEphemeralChannel('some-future-channel')).toBe(true);
    });
});

describe('per-channel TTL — ephemeral 5min, persistent 30min', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        activeSessions.clear();
        const db = getDb();
        db.sessions.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('evicts an ephemeral (api) session at 6min idle', () => {
        const s = getOrCreateSessionById('api-1', 'api', 'api-user');
        expect(activeSessions.has('id:api-1')).toBe(true);
        vi.setSystemTime(NOW + SIX_MIN);
        cleanupStaleSessions();
        expect(activeSessions.has('id:api-1')).toBe(false);
        // DB row also marked idle
        const db = getDb();
        const rec = db.sessions.find((x: { id: string }) => x.id === s.id);
        expect(rec?.status).toBe('idle');
    });

    it('keeps a persistent (webchat) session at 6min idle', () => {
        const s = getOrCreateSession('webchat', 'u1');
        vi.setSystemTime(NOW + SIX_MIN);
        cleanupStaleSessions();
        // Still active — webchat keeps the full 30min TTL
        const db = getDb();
        const rec = db.sessions.find((x: { id: string }) => x.id === s.id);
        expect(rec?.status).toBe('active');
    });

    it('keeps an ephemeral session at 2min idle (within 5min window)', () => {
        const s = getOrCreateSessionById('eval-1', 'eval', 'eval-test-1');
        vi.setSystemTime(NOW + TWO_MIN);
        cleanupStaleSessions();
        expect(activeSessions.has('id:eval-1')).toBe(true);
        const db = getDb();
        const rec = db.sessions.find((x: { id: string }) => x.id === s.id);
        expect(rec?.status).toBe('active');
    });

    it('evicts a templated ephemeral channel (autoresearch-*) at 6min', () => {
        getOrCreateSession('autoresearch-trigger-tool_router', 'system');
        getOrCreateSession('initiative-fix', 'system');
        getOrCreateSession('twilio-call-CA999', 'twilio-user');
        expect(activeSessions.size).toBeGreaterThanOrEqual(3);
        vi.setSystemTime(NOW + SIX_MIN);
        cleanupStaleSessions();
        // All three ephemeral channels should have been evicted
        expect(activeSessions.size).toBe(0);
    });
});

describe('LRU cap on ephemeral cache', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        activeSessions.clear();
        const db = getDb();
        db.sessions.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('caps ephemeral entries at EPHEMERAL_MAX_ACTIVE (oldest-first eviction)', () => {
        // Create N+20 ephemeral sessions, each with a slightly later lastActive
        // by stepping the clock forward 1ms per session.
        const total = EPHEMERAL_MAX_ACTIVE + 20;
        const ids: string[] = [];
        for (let i = 0; i < total; i++) {
            vi.setSystemTime(NOW + i);
            const s = getOrCreateSessionById(`api-${i}`, 'api', `u-${i}`);
            ids.push(s.id);
        }
        // Run cleanup at "now" (no idle eviction yet — all within 5min)
        vi.setSystemTime(NOW + total + 1);
        cleanupStaleSessions();
        // The 20 oldest (api-0 through api-19) should have been LRU-evicted;
        // the 100 newest survive.
        for (let i = 0; i < 20; i++) {
            expect(activeSessions.has(`id:api-${i}`)).toBe(false);
        }
        for (let i = total - EPHEMERAL_MAX_ACTIVE; i < total; i++) {
            expect(activeSessions.has(`id:api-${i}`)).toBe(true);
        }
    });

    it('does not LRU-evict persistent sessions even past 100', () => {
        const total = EPHEMERAL_MAX_ACTIVE + 5;
        const persistentIds: string[] = [];
        for (let i = 0; i < total; i++) {
            vi.setSystemTime(NOW + i);
            const s = getOrCreateSessionById(`web-${i}`, 'webchat', `u-${i}`);
            persistentIds.push(s.id);
        }
        cleanupStaleSessions();
        // None of the webchat sessions should have been touched by LRU
        for (let i = 0; i < total; i++) {
            expect(activeSessions.has(`id:web-${i}`)).toBe(true);
        }
    });
});

describe('sweepSessions — bulk operational drain', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        activeSessions.clear();
        const db = getDb();
        db.sessions.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('closes all ephemeral sessions when called with no filters', () => {
        getOrCreateSessionById('api-1', 'api', 'u1');
        getOrCreateSessionById('api-2', 'api', 'u2');
        getOrCreateSessionById('eval-1', 'eval', 'u3');
        getOrCreateSession('webchat', 'web-user');
        const result = sweepSessions();
        expect(result.closed).toBe(3);
        // Webchat survives — persistent
        expect([...activeSessions.values()].some(s => s.channel === 'webchat')).toBe(true);
        expect([...activeSessions.values()].some(s => s.channel === 'api')).toBe(false);
    });

    it('respects the channel filter', () => {
        getOrCreateSessionById('api-1', 'api', 'u1');
        getOrCreateSessionById('eval-1', 'eval', 'u2');
        const result = sweepSessions({ channel: 'api' });
        expect(result.closed).toBe(1);
        expect([...activeSessions.values()].some(s => s.channel === 'eval')).toBe(true);
        expect([...activeSessions.values()].some(s => s.channel === 'api')).toBe(false);
    });

    it('respects the channelPrefix filter (templated channels)', () => {
        getOrCreateSession('autoresearch-trigger-tool_router', 'system');
        getOrCreateSession('autoresearch-gendata-agent', 'system');
        getOrCreateSession('initiative-fix', 'system');
        const result = sweepSessions({ channelPrefix: 'autoresearch-' });
        expect(result.closed).toBe(2);
        expect([...activeSessions.values()].some(s => s.channel === 'initiative-fix')).toBe(true);
    });

    it('respects the idleMs filter', () => {
        getOrCreateSessionById('old-1', 'api', 'u1');
        vi.setSystemTime(NOW + 60_000); // 1min later
        getOrCreateSessionById('new-1', 'api', 'u2');
        // Sweep with idleMs=30s — only the older session is past threshold
        const result = sweepSessions({ idleMs: 30_000 });
        expect(result.closed).toBe(1);
        expect(activeSessions.has('id:old-1')).toBe(false);
        expect(activeSessions.has('id:new-1')).toBe(true);
    });

    it('protects persistent channels unless force=true', () => {
        getOrCreateSession('webchat', 'u1');
        getOrCreateSession('voice', 'u2');
        // Default sweep — neither closed
        expect(sweepSessions().closed).toBe(0);
        // Forced sweep — both closed
        expect(sweepSessions({ force: true }).closed).toBe(2);
    });

    it('returns zero closed when no sessions match', () => {
        getOrCreateSession('webchat', 'u1');
        const result = sweepSessions({ channel: 'api' });
        expect(result.closed).toBe(0);
    });
});
