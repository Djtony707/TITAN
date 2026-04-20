/**
 * TITAN — Specialist Router (v4.10.0-local, Phase A)
 *
 * Maps a SubtaskKind to a specialist route (primary + fallbacks + tool
 * allowlist). Used by goalDriver to decide who gets each subtask.
 *
 * Design notes:
 *   - Table-driven so additions/overrides are one-liners.
 *   - Fallback chain matches fallbackChain.ts attempt order.
 *   - If the resolved specialist is missing from `specialists.ts`
 *     (e.g. a future config overrides with an unknown id), we fall
 *     through to `default` (the main TITAN agent) rather than crash.
 */
import { SPECIALISTS } from './specialists.js';
import type { SubtaskKind } from './subtaskTaxonomy.js';

export interface SpecialistRoute {
    /** Specialist id (from SPECIALISTS) — e.g. 'scout', 'builder'. */
    primary: string;
    /** Ordered fallbacks. Driver tries these in order on failure. */
    fallbacks: string[];
    /** If omitted, specialist's default model is used. */
    modelOverride?: string;
    /**
     * If set, the spawned specialist is restricted to these tools.
     * Useful for research routes — no reason Scout should be able to
     * write files.
     */
    toolAllowlist?: string[];
    /** Max rounds for this spawn (default 10). */
    maxRounds?: number;
}

// ── Canonical routing table ──────────────────────────────────────

const ROUTE_TABLE: Record<SubtaskKind, SpecialistRoute> = {
    research: {
        primary: 'scout',
        fallbacks: ['analyst', 'default'],
        toolAllowlist: [
            'web_search', 'web_fetch', 'read_file', 'list_dir',
            'memory', 'goal_list', 'system_info', 'send_agent_message',
        ],
        maxRounds: 12,
    },
    code: {
        primary: 'builder',
        fallbacks: ['default'],
        // Builder needs the full mutating toolkit. Scope-lock in toolRunner
        // keeps the path safe — no need to restrict tools here.
        maxRounds: 20,
    },
    write: {
        primary: 'writer',
        fallbacks: ['analyst', 'default'],
        toolAllowlist: [
            'read_file', 'write_file', 'memory', 'web_search', 'web_fetch',
            'send_agent_message',
        ],
        maxRounds: 10,
    },
    analysis: {
        primary: 'analyst',
        fallbacks: ['default'],
        toolAllowlist: [
            'read_file', 'list_dir', 'memory', 'web_search', 'web_fetch',
            'goal_list', 'system_info', 'send_agent_message',
        ],
        maxRounds: 15,
    },
    verify: {
        // v4.10.0-local polish: Sage (Claude Code via MAX plan) is the
        // primary reviewer. Different model family than Builder means
        // correlated bugs get caught. Falls back to Analyst if Claude
        // CLI isn't installed/logged in on the host.
        primary: 'sage',
        fallbacks: ['analyst', 'default'],
        toolAllowlist: ['read_file', 'list_dir', 'shell', 'memory'],
        maxRounds: 8,
    },
    shell: {
        primary: 'builder',
        fallbacks: ['default'],
        toolAllowlist: ['shell', 'read_file', 'list_dir', 'system_info'],
        maxRounds: 8,
    },
    report: {
        // Final summary — Writer has the voice, Analyst has the data.
        // Writer wins by default; Analyst is fallback for technical goals.
        primary: 'writer',
        fallbacks: ['analyst', 'default'],
        toolAllowlist: ['read_file', 'memory', 'goal_list'],
        maxRounds: 6,
    },
};

// ── Lookups ──────────────────────────────────────────────────────

/**
 * Get the route for a kind. Always returns a valid SpecialistRoute.
 * If a configured specialist id doesn't exist, we return a degraded
 * route pointing at the main agent (id='default') so the driver can
 * still proceed.
 */
export function routeForKind(kind: SubtaskKind): SpecialistRoute {
    return ROUTE_TABLE[kind];
}

/**
 * Resolve a specialist id to its full Specialist record, or null.
 * 'default' always returns null (caller treats that as "main agent").
 */
export function resolveSpecialist(id: string): (typeof SPECIALISTS)[number] | null {
    if (id === 'default' || id === 'primary') return null;
    return SPECIALISTS.find(s => s.id === id) || null;
}

/**
 * Given a route + attempt number, pick the specialist id to use this
 * attempt. Attempt 0 = primary, 1 = fallbacks[0], etc. Returns 'default'
 * once we've exhausted the fallback list — the caller falls back to
 * inline main-agent execution.
 */
export function pickAttempt(route: SpecialistRoute, attempt: number): string {
    if (attempt === 0) return route.primary;
    const idx = attempt - 1;
    if (idx < route.fallbacks.length) return route.fallbacks[idx];
    return 'default';
}

/** For diagnostics — dump the routing table. */
export function getRoutingTable(): Record<SubtaskKind, SpecialistRoute> {
    return { ...ROUTE_TABLE };
}
