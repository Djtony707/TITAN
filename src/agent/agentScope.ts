/**
 * TITAN — Named Agents (per-agent config resolution)
 *
 * Ported from OpenClaw `src/agents/agent-scope.ts` + `agent-scope-config.ts`.
 *
 * Before: the 5 specialists (scout, builder, writer, analyst, sage) were
 * hardcoded in `src/agent/specialists.ts`. Adding a 6th ("coder-rust",
 * "video-producer", "ops-runbook") required editing the TS + rebuilding.
 * Overriding one specialist's skills filter meant forking the file.
 *
 * After: agents can be declared in `titan.json` under `agents.entries.*`.
 * Each entry pulls in default behavior from `agents.defaults` and overrides
 * only what it needs. The 5 hardcoded specialists remain as fallbacks when
 * no config-defined agent is found — no behavior regression.
 *
 * This is additive: specialists.ts still compiles, still works. The new
 * path is a lookup helper that CONFIG overrides can opt into.
 */
import logger from '../utils/logger.js';
import { loadConfig } from '../config/config.js';

const COMPONENT = 'AgentScope';

export interface AgentEntryConfig {
    /** Display name (e.g. "Rust Coder") */
    name?: string;
    /** One-line description for UI */
    description?: string;
    /** Primary model. Falls back to defaults.model, then agent.model. */
    model?: string;
    /** Ordered fallback chain. Falls back to defaults.modelFallbacks. */
    modelFallbacks?: string[];
    /**
     * Skill-name allowlist. When set, only these skills are enabled for
     * this agent. Supports wildcards ("github_*").
     */
    skillsFilter?: string[];
    /**
     * Persona to apply (from assets/personas/). Defaults to defaults.persona
     * or 'default'.
     */
    persona?: string;
    /** System prompt override. Appended to core — not a replacement. */
    systemPromptOverride?: string;
    /** Template this agent is based on — matches a built-in specialist. */
    template?: string;
    /** Max tool rounds per spawn. Falls back to defaults.maxRounds, then 15. */
    maxRounds?: number;
    /** Max tokens per spawn. Falls back to defaults.maxTokens. */
    maxTokens?: number;
    /** Working directory scope (agent only sees files under this path). */
    workspaceDir?: string;
    /** Tags — free-form labels for UI filtering. */
    tags?: string[];
    /** Enabled flag. Disabled entries are skipped in listings / spawn. */
    enabled?: boolean;
}

export interface AgentDefaultsConfig {
    model?: string;
    modelFallbacks?: string[];
    skillsFilter?: string[];
    persona?: string;
    maxRounds?: number;
    maxTokens?: number;
    systemPromptOverride?: string;
}

export interface AgentsBlock {
    defaults?: AgentDefaultsConfig;
    entries?: Record<string, AgentEntryConfig>;
}

/**
 * Resolved config — merge of defaults + entry-specific overrides.
 * Every field is non-optional; use this as the canonical runtime shape.
 */
export interface ResolvedAgentConfig {
    id: string;
    name: string;
    description: string;
    model: string;
    modelFallbacks: string[];
    skillsFilter: string[] | null;
    persona: string;
    systemPromptOverride: string;
    template: string;
    maxRounds: number;
    maxTokens: number;
    workspaceDir: string | null;
    tags: string[];
    enabled: boolean;
}

function readAgentsBlock(): AgentsBlock {
    try {
        const cfg = loadConfig() as unknown as { agents?: AgentsBlock };
        return cfg.agents ?? {};
    } catch {
        return {};
    }
}

/**
 * List all enabled agent IDs declared in config (does NOT include
 * hardcoded specialists — those come from specialists.ts).
 */
export function listConfiguredAgentIds(): string[] {
    const block = readAgentsBlock();
    if (!block.entries) return [];
    return Object.entries(block.entries)
        .filter(([, entry]) => entry.enabled !== false)
        .map(([id]) => id);
}

/**
 * Return the raw config entry for an agent id, or null if not declared in
 * `titan.json`. Does NOT merge defaults — use `resolveAgentConfig` for the
 * runtime-ready shape.
 */
export function getAgentEntry(agentId: string): AgentEntryConfig | null {
    const block = readAgentsBlock();
    if (!block.entries) return null;
    return block.entries[agentId] ?? null;
}

/**
 * Fully resolve an agent's effective config: defaults + entry-specific
 * overrides + sensible fallbacks. Returns null when the agent is not
 * declared in config (caller should fall back to specialists.ts).
 */
export function resolveAgentConfig(agentId: string): ResolvedAgentConfig | null {
    const block = readAgentsBlock();
    const entry = block.entries?.[agentId];
    if (!entry) return null;
    if (entry.enabled === false) return null;

    const defaults = block.defaults ?? {};

    const model = entry.model ?? defaults.model ?? '';
    if (!model) {
        logger.warn(COMPONENT, `Agent "${agentId}" has no model configured (neither entry.model nor defaults.model)`);
        // Still resolve — caller may inject a model at spawn time.
    }

    const skillsFilter =
        entry.skillsFilter && entry.skillsFilter.length > 0
            ? entry.skillsFilter
            : defaults.skillsFilter && defaults.skillsFilter.length > 0
                ? defaults.skillsFilter
                : null;

    return {
        id: agentId,
        name: entry.name ?? agentId,
        description: entry.description ?? '',
        model,
        modelFallbacks: entry.modelFallbacks ?? defaults.modelFallbacks ?? [],
        skillsFilter,
        persona: entry.persona ?? defaults.persona ?? 'default',
        systemPromptOverride: entry.systemPromptOverride ?? defaults.systemPromptOverride ?? '',
        template: entry.template ?? 'default',
        maxRounds: entry.maxRounds ?? defaults.maxRounds ?? 15,
        maxTokens: entry.maxTokens ?? defaults.maxTokens ?? 4000,
        workspaceDir: entry.workspaceDir ?? null,
        tags: entry.tags ?? [],
        enabled: entry.enabled ?? true,
    };
}

/**
 * Does this agent's skills-filter include the given skill name?
 * Supports `*` wildcard at the end (e.g. "github_*").
 * When skillsFilter is null (no filter), every skill passes.
 */
export function agentAllowsSkill(resolvedAgent: ResolvedAgentConfig, skillName: string): boolean {
    const filter = resolvedAgent.skillsFilter;
    if (!filter) return true;
    for (const pattern of filter) {
        if (pattern === skillName) return true;
        if (pattern.endsWith('*')) {
            const prefix = pattern.slice(0, -1);
            if (skillName.startsWith(prefix)) return true;
        }
    }
    return false;
}

/**
 * Convenience: a full list of resolved configs for all enabled config
 * entries. Ordered by insertion order in titan.json.
 */
export function listResolvedAgents(): ResolvedAgentConfig[] {
    const ids = listConfiguredAgentIds();
    return ids.map(id => resolveAgentConfig(id)).filter((x): x is ResolvedAgentConfig => x != null);
}
