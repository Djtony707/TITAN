/**
 * TITAN — v6.1.0-beta.1 — PostHog EU/US auto-detection
 *
 * GDPR data-residency: EU users' telemetry should land in PostHog Cloud EU
 * (Frankfurt), not US. Detection is offline-safe (IANA timezone, no IP
 * lookup, no pre-consent network calls).
 *
 * Precedence:
 *   1. TITAN_POSTHOG_HOST env override
 *   2. config.telemetry.posthogHost explicit
 *   3. Timezone-based EU/US resolver
 *   4. US default
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolvePostHogHost } from '../src/analytics/posthog.js';

const origEnv = process.env.TITAN_POSTHOG_HOST;

describe('v6.1.0-beta.1 — PostHog host resolver', () => {
    beforeEach(() => { delete process.env.TITAN_POSTHOG_HOST; });
    afterEach(() => { if (origEnv) process.env.TITAN_POSTHOG_HOST = origEnv; else delete process.env.TITAN_POSTHOG_HOST; });

    describe('TITAN_POSTHOG_HOST env var wins everything', () => {
        it('returns the env value when set', () => {
            process.env.TITAN_POSTHOG_HOST = 'https://self.example.com';
            expect(resolvePostHogHost({ timeZone: 'Europe/Berlin' })).toBe('https://self.example.com');
        });
    });

    describe('Timezone → EU PostHog Cloud (Frankfurt)', () => {
        const euZones = [
            'Europe/Berlin', 'Europe/Paris', 'Europe/London', 'Europe/Madrid',
            'Europe/Rome', 'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Stockholm',
            'Europe/Helsinki', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Vienna',
            'Atlantic/Azores', 'Atlantic/Canary', 'Atlantic/Faroe',
            'Atlantic/Madeira', 'Atlantic/Reykjavik', 'Africa/Ceuta',
        ];
        for (const tz of euZones) {
            it(`routes ${tz} to eu.i.posthog.com`, () => {
                expect(resolvePostHogHost({ timeZone: tz })).toBe('https://eu.i.posthog.com');
            });
        }
    });

    describe('Timezone → US PostHog Cloud (default)', () => {
        const usOrOtherZones = [
            'America/Los_Angeles', 'America/New_York', 'America/Chicago',
            'America/Sao_Paulo', 'America/Mexico_City', 'America/Toronto',
            'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Dubai',
            'Australia/Sydney', 'Pacific/Auckland', 'Africa/Lagos',
            'Africa/Johannesburg', 'Africa/Cairo',
        ];
        for (const tz of usOrOtherZones) {
            it(`routes ${tz} to us.i.posthog.com`, () => {
                expect(resolvePostHogHost({ timeZone: tz })).toBe('https://us.i.posthog.com');
            });
        }
    });

    describe('Empty / unknown timezone → US default', () => {
        it('falls back to US for empty string', () => {
            expect(resolvePostHogHost({ timeZone: '' })).toBe('https://us.i.posthog.com');
        });
        it('falls back to US for an unrecognized zone', () => {
            expect(resolvePostHogHost({ timeZone: 'NotAReal/Zone' })).toBe('https://us.i.posthog.com');
        });
    });

    describe('No-arg call uses Intl.DateTimeFormat', () => {
        it('returns a valid PostHog host', () => {
            const host = resolvePostHogHost();
            expect(host === 'https://us.i.posthog.com' || host === 'https://eu.i.posthog.com').toBe(true);
        });
    });
});
