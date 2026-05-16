/**
 * TITAN — Sub-agent date-context injection (v6.1.0)
 *
 * Background: sub-agents (the Writer specialist in particular) had no notion
 * of "now", so missions like "advances since end of March until now" failed
 * because the LLM interpreted "now" using its training cutoff rather than
 * real time. formatCurrentDateContext() is the pure helper that renders
 * the block we inject before the role template in subAgent.ts.
 */
import { describe, it, expect } from 'vitest';
import { formatCurrentDateContext } from '../src/agent/dateContext.js';

describe('formatCurrentDateContext', () => {
    it("returns a string containing \"Today's date is\"", () => {
        const out = formatCurrentDateContext();
        expect(typeof out).toBe('string');
        expect(out).toContain("Today's date is");
    });

    it('renders the Pacific-time date and 12:14 PM clock for 2026-05-15T19:14Z (PDT)', () => {
        const fixed = new Date('2026-05-15T19:14:00Z');
        const out = formatCurrentDateContext(fixed);
        // 2026-05-15 19:14 UTC == 2026-05-15 12:14 PDT (May is DST → UTC-7)
        expect(out).toContain('Friday, May 15, 2026');
        expect(out).toContain('12:14 PM');
        expect(out).toContain('Pacific');
    });

    it('mentions the IANA zone name America/Los_Angeles', () => {
        const out = formatCurrentDateContext(new Date('2026-05-15T19:14:00Z'));
        expect(out).toContain('America/Los_Angeles');
    });

    it('stays short enough to not blow context (< 400 chars)', () => {
        const out = formatCurrentDateContext(new Date('2026-05-15T19:14:00Z'));
        expect(out.length).toBeLessThan(400);
    });

    it('is deterministic across repeated calls with the same Date', () => {
        const fixed = new Date('2026-05-15T19:14:00Z');
        const a = formatCurrentDateContext(fixed);
        const b = formatCurrentDateContext(fixed);
        const c = formatCurrentDateContext(fixed);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });
});
