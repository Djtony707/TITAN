/**
 * H1 boot-line fix — Auth-token TTL is now configurable and defaults to 30 days.
 *
 * Pre-v5.7.2 the gateway hardcoded a 24-hour TTL on session tokens in two
 * places: at load time (filtering tokens from disk) and in the periodic
 * cleanup (every 10 minutes, dropping expired tokens AND persisting the
 * filtered Map back to disk). For self-hosted single-user TITANs this
 * caused `~/.titan/auth-tokens.json` to silently become `[]` overnight
 * because Tony's only session was older than 24 hours by morning.
 *
 * This test pins the config-driven TTL so that future refactors can't
 * silently reintroduce the hardcoded 24h cap.
 */
import { describe, it, expect } from 'vitest';
import { GatewayConfigSchema } from '../../src/config/schema.js';

describe('H1 — gateway.auth.tokenTtlMs is configurable + 30d default', () => {
    it('tokenTtlMs defaults to 30 days when omitted', () => {
        const cfg = GatewayConfigSchema.parse({});
        const expected = 30 * 24 * 60 * 60 * 1000;
        expect(cfg.auth.tokenTtlMs).toBe(expected);
    });

    it('tokenTtlMs can be overridden by the user config', () => {
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        const cfg = GatewayConfigSchema.parse({ auth: { tokenTtlMs: sevenDays } });
        expect(cfg.auth.tokenTtlMs).toBe(sevenDays);
    });

    it('rejects non-positive TTLs (silent zero would lock everyone out)', () => {
        expect(() => GatewayConfigSchema.parse({ auth: { tokenTtlMs: 0 } })).toThrow();
        expect(() => GatewayConfigSchema.parse({ auth: { tokenTtlMs: -100 } })).toThrow();
    });

    it('rejects non-integer TTLs', () => {
        expect(() => GatewayConfigSchema.parse({ auth: { tokenTtlMs: 3.14 } })).toThrow();
    });

    it('preserves the existing auth fields (mode / token / password) alongside tokenTtlMs', () => {
        const cfg = GatewayConfigSchema.parse({
            auth: { mode: 'password', password: 'hunter2', tokenTtlMs: 86400_000 },
        });
        expect(cfg.auth.mode).toBe('password');
        expect(cfg.auth.password).toBe('hunter2');
        expect(cfg.auth.tokenTtlMs).toBe(86400_000);
    });
});
