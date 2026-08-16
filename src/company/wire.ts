/**
 * TITAN — Company wire contract (v8 Slice 1)
 *
 * THE single source of truth for the JSON shapes that cross the
 * gateway ↔ UI boundary. The service layer builds these shapes, the UI
 * types mirror them, and tests/company-wire assert the service output
 * keys match these constants exactly — a schema drift fails CI instead
 * of silently breaking the room (review event 6dfd487c, finding 1).
 *
 * Server-side input limits also live here: UI input attributes are not a
 * security boundary; the service enforces these BEFORE persisting signed
 * events.
 */

export const WIRE_AGENT_FIELDS = ['agentId', 'displayName', 'role', 'charter'] as const;

export interface WireCompanyAgent {
    agentId: string;
    displayName: string;
    role: string;
    charter: string;
}

export const WIRE_EVENT_FIELDS = ['seq', 'id', 'prevHash', 'kind', 'ts', 'actor', 'sig', 'payload'] as const;

export const WIRE_STATUS_FIELDS = ['exists', 'name', 'mission', 'agents', 'eventCount'] as const;

/** The two task.checked verdicts — the ONLY values either side may use. */
export const VERDICTS = ['accepted', 'needs-work'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Server-side input limits (characters), enforced in the service layer. */
export const LIMITS = {
    companyName: 120,
    mission: 2000,
    roomText: 8000,
    replyTo: 64,
    taskSpec: 4000,
} as const;

/** Full-string non-negative safe-integer parse: '12junk' and '' are rejected (null). */
export function parseSafeInt(raw: unknown, fallback: number): number | null {
    if (raw === undefined || raw === null) return fallback;
    const str = String(raw);
    if (!/^\d{1,15}$/.test(str)) return null;
    const n = Number(str);
    return Number.isSafeInteger(n) ? n : null;
}

export function assertLen(value: string, max: number, field: string): void {
    if (value.length > max) {
        throw new Error(`${field} exceeds the ${max}-character limit`);
    }
}
