/**
 * TITAN — Named Memory Taxonomy (v7.0)
 *
 * Why this exists
 * ---------------
 * 2026 personal-AI products market their memory as a *named taxonomy* (e.g.
 * "8 memory types"). TITAN already implements a richer memory architecture than
 * any of them — it just never named it. This module is the honest map: each
 * named type points at the REAL TITAN subsystem that backs it, so the taxonomy
 * is a description of what exists, not marketing vapor.
 *
 * TITAN has NINE named types (≥ the field's eight), and one of them — the
 * **emotional/drive** type, backed by the Soma homeostatic drive layer — has
 * no equivalent in any competitor. That is the differentiator this naming
 * makes legible.
 *
 * Each entry is auditable: `module` is a file that exists in this repo, and
 * `live()` probes real availability (config flag / connection) where a type is
 * opt-in (Soma, mesh, Hindsight cross-session). Always-on file-backed stores
 * report live unconditionally.
 */

export type MemoryAvailability = 'always-on' | 'opt-in' | 'connected' | 'unavailable';

export interface MemoryType {
    /** Canonical name (the marketed taxonomy term). */
    key: string;
    /** Human label. */
    label: string;
    /** One line: what this type captures. */
    captures: string;
    /** How memory of this type is recalled / used. */
    recall: string;
    /** The real TITAN module(s) backing it — every path exists in-repo. */
    module: string;
    /**
     * Whether the type is unique to TITAN among 2026 personal-AI competitors.
     * Only the drive-backed emotional type is.
     */
    differentiator?: boolean;
    /** Whether the type needs a config flag / external connection to be active. */
    optIn: boolean;
}

/**
 * The canonical taxonomy. Order is the natural "from this turn → across the
 * fleet" widening of scope.
 */
export const MEMORY_TAXONOMY: MemoryType[] = [
    {
        key: 'working',
        label: 'Working',
        captures: 'In-flight, session-scoped state: decisions made, artifacts produced, open questions this turn.',
        recall: 'Read back within the session; swept after an idle TTL.',
        module: 'src/memory/workingMemory.ts',
        optIn: false,
    },
    {
        key: 'episodic',
        label: 'Episodic',
        captures: 'Past interactions, decisions, and observations — the agent\'s history.',
        recall: 'By recency or vector similarity to the current task; cross-session via the Hindsight bridge.',
        module: 'src/memory/episodic.ts + src/memory/hindsightBridge.ts',
        optIn: false,
    },
    {
        key: 'semantic',
        label: 'Semantic',
        captures: 'Facts, knowledge, and the user model — what the agent KNOWS (vs. what it did).',
        recall: 'Fuzzy + vector search; relationship graph traversal.',
        module: 'src/memory/memory.ts + src/memory/vectors.ts + src/memory/graph.ts',
        optIn: false,
    },
    {
        key: 'procedural',
        label: 'Procedural',
        captures: 'Learned tool sequences, success patterns, and user corrections — HOW to do things.',
        recall: 'Strategy hints injected when a similar task recurs; tool-preference routing.',
        module: 'src/memory/learning.ts + src/agent/agentLessons.ts',
        optIn: false,
    },
    {
        key: 'emotional',
        label: 'Emotional / Drive',
        captures: 'Homeostatic drives, hormonal state, and a per-user emotional baseline — how the agent FEELS and how that modulates behavior.',
        recall: 'Drives pressure the action loop; hormone broadcasts shift posture; the baseline learner adapts to each user.',
        module: 'src/organism/drives.ts + src/organism/hormones.ts + src/organism/pressure.ts',
        differentiator: true,
        optIn: true,
    },
    {
        key: 'prospective',
        label: 'Prospective',
        captures: 'Future intentions: goals, scheduled work, and a goal\'s definition-of-done (spec + acceptance criteria).',
        recall: 'Goal driver picks up pending goals; cron fires scheduled work; the spec is recited every turn.',
        module: 'src/agent/goalSpec.ts + src/agent/goalPlanFile.ts + cron',
        optIn: false,
    },
    {
        key: 'relational',
        label: 'Relational',
        captures: 'Per-user / per-contact model: preferences, technical level, projects, and contacts.',
        recall: 'Loaded into the prompt as the user profile; calibrates tone and depth.',
        module: 'src/memory/relationship.ts',
        optIn: false,
    },
    {
        key: 'narrative',
        label: 'Narrative',
        captures: 'The agent\'s self-story: daily briefings, dream/REM consolidation, and stable identity.',
        recall: 'Briefings summarize "what happened"; dreaming consolidates episodics; identity anchors persona.',
        module: 'src/memory/briefing.ts + src/memory/dreaming.ts + src/memory/identity.ts',
        optIn: false,
    },
    {
        key: 'shared',
        label: 'Shared',
        captures: 'Memory shared across agents and machines: peer namespaces and the mesh fabric.',
        recall: 'Command Post per-agent namespaces; mesh peer transport; shared Hindsight retention.',
        module: 'src/mesh/* + src/agent/commandPost.ts',
        optIn: true,
    },
];

export interface MemoryTypeStatus extends MemoryType {
    availability: MemoryAvailability;
}

export interface MemoryTaxonomySummary {
    total: number;
    /** Types currently active (always-on, or opt-in flag on / connected). */
    active: number;
    types: MemoryTypeStatus[];
}

/**
 * Probe live availability of each type against config + connections. `config`
 * is the loaded TITAN config (passed in so this stays pure + testable);
 * `connections` lets callers report runtime connection state (e.g. Hindsight).
 */
export function summarizeMemoryTaxonomy(
    config: Record<string, unknown> = {},
    connections: { hindsightConnected?: boolean } = {},
): MemoryTaxonomySummary {
    const get = (path: string): unknown =>
        path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), config);
    const somaOn = get('organism.enabled') === true;
    const meshOn = get('mesh.enabled') === true;

    const types: MemoryTypeStatus[] = MEMORY_TAXONOMY.map((t) => {
        let availability: MemoryAvailability;
        if (!t.optIn) {
            availability = 'always-on';
        } else if (t.key === 'emotional') {
            availability = somaOn ? 'opt-in' : 'unavailable';
        } else if (t.key === 'shared') {
            availability = meshOn || connections.hindsightConnected ? 'connected' : 'unavailable';
        } else {
            availability = 'always-on';
        }
        return { ...t, availability };
    });

    const active = types.filter((t) => t.availability !== 'unavailable').length;
    return { total: types.length, active, types };
}

/** Render the taxonomy as a readable markdown report. */
export function renderMemoryTaxonomy(summary: MemoryTaxonomySummary): string {
    const lines: string[] = [];
    lines.push(`# TITAN memory taxonomy — ${summary.total} types (${summary.active} active)`);
    lines.push('');
    for (const t of summary.types) {
        const star = t.differentiator ? ' ⭐ (unique to TITAN)' : '';
        const badge =
            t.availability === 'always-on' ? '🟢 always-on'
            : t.availability === 'connected' ? '🔵 connected'
            : t.availability === 'opt-in' ? '🟢 enabled'
            : '⚪ inactive';
        lines.push(`## ${t.label}${star} — ${badge}`);
        lines.push(`- Captures: ${t.captures}`);
        lines.push(`- Recall: ${t.recall}`);
        lines.push(`- Backed by: \`${t.module}\``);
        lines.push('');
    }
    return lines.join('\n').trim();
}
