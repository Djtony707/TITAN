/**
 * TITAN v8 Slice 5 — Recipe Registry / Promotion State Machine
 *
 * Holds compiled recipes (from RECOGNIZE clusters) and runs them through
 * candidate → shadow → active → demoted/retired. Every stage is gated by
 * selfCompiling.enabled AND its own sub-flag.
 *
 * Seams:
 *   - src/agent/recipeCompiler.ts produces candidate recipes
 *   - src/recipes/store.ts persists active tier-2 recipes as real slash commands
 *   - src/skills/registry.ts registers tier-1 advice skills for context injection
 *   - src/agent/muscleMemory.ts replay exam + eval harness supplies shadow verdicts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { TITAN_HOME } from '../utils/constants.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { listRecordSpans } from '../telemetry/traceStore.js';
import type { Recipe } from '../recipes/types.js';

const COMPONENT = 'RecipeRegistry';
const REGISTRY_PATH = join(TITAN_HOME, 'compiled-recipes.json');

/** Promotion stages for a compiled recipe. */
export type PromotionState = 'candidate' | 'shadow' | 'active' | 'demoted' | 'retired';

/** Tier-1 = advice skill injected into system prompt; tier-2 = executable recipe. */
export type RecipeTier = 1 | 2;

/** A compiled recipe carries the promotion ledger on top of Recipe. */
export interface CompiledRecipe extends Recipe {
    /** Task-signature this recipe was compiled from. */
    signature: string;
    /** Source trace IDs used to compile it. */
    sourceTraceIds: string[];
    /** 1 = advice skill, 2 = executable recipe. */
    tier: RecipeTier;
    /** Promotion state machine state. */
    state: PromotionState;
    /** Runtime statistics. */
    stats: {
        invocations: number;
        successes: number;
        /** Measured tokens saved vs source-trace baseline. */
        tokensSaved: number;
        /** Number of shadow comparisons performed. */
        shadowComparisons: number;
        /** Number of shadow comparisons that passed semantic equivalence. */
        shadowSuccesses: number;
    };
}

/** Internal registry entry with measured baseline and transition history. */
export interface RegistryEntry {
    recipe: CompiledRecipe;
    /** Measured token baseline from source traces at registration time. */
    baselineTokens: number;
    /** Transition audit trail. */
    transitions: Array<{ from: PromotionState | null; to: PromotionState; at: string; reason?: string }>;
    /** Convenience copy of the most recent transition. */
    lastTransition: { from: PromotionState | null; to: PromotionState; at: string; reason?: string };
}

/** Gating flags under config.selfCompiling. */
export interface SelfCompilingConfig {
    enabled: boolean;
    /** Master compile gate. */
    compile: boolean;
    /** Promotion gate. */
    promote: boolean;
    /** Runtime invocation recording gate. */
    record: boolean;
    /** Route active recipes into the agent loop. */
    route: boolean;
}

/** Minimum shadow comparisons before activation. */
export const SHADOW_MIN_COMPARISONS = 3;
/** Shadow success rate must be exactly 1.0 (zero false positives). */
export const SHADOW_MIN_SUCCESS_RATE = 1.0;

function defaultSelfCompiling(): SelfCompilingConfig {
    return { enabled: false, compile: false, promote: false, record: false, route: false };
}

/** Read the selfCompiling config block. Missing sections return defaults (off). */
export function getSelfCompilingConfig(): SelfCompilingConfig {
    try {
        const cfg = loadConfig() as { selfCompiling?: Partial<SelfCompilingConfig> };
        return { ...defaultSelfCompiling(), ...(cfg.selfCompiling || {}) };
    } catch {
        return defaultSelfCompiling();
    }
}

/** Pure gate: master switch enabled AND the named sub-flag is true. */
export function selfCompilingFlag(flag: keyof Omit<SelfCompilingConfig, 'enabled'>): boolean {
    const cfg = getSelfCompilingConfig();
    return !!(cfg.enabled && cfg[flag]);
}

/** Pure gate used by compile/promote/record/route entry points. */
export function gateOn(flag: keyof Omit<SelfCompilingConfig, 'enabled'>): boolean {
    return selfCompilingFlag(flag);
}

function readRegistry(): Record<string, RegistryEntry> {
    try {
        if (existsSync(REGISTRY_PATH)) {
            const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as Record<string, RegistryEntry>;
            // Normalize entries in case stored before a shape change
            for (const e of Object.values(parsed)) {
                e.lastTransition = e.lastTransition || e.transitions[e.transitions.length - 1] || { from: null, to: e.recipe.state, at: e.recipe.createdAt };
                e.transitions = e.transitions || [e.lastTransition];
            }
            return parsed;
        }
    } catch (e) {
        logger.warn(COMPONENT, `Registry unreadable, starting fresh: ${(e as Error).message}`);
    }
    return {};
}

function writeRegistry(registry: Record<string, RegistryEntry>): void {
    mkdirSync(TITAN_HOME, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

/** Compute measured baseline tokens from source traces. Returns 0 if gate/record off or no traces. */
function measureBaselineTokens(traceIds: string[]): number {
    if (!selfCompilingFlag('record')) return 0;
    try {
        const spans = listRecordSpans();
        const matched = spans.filter(s => traceIds.includes(s.id));
        if (matched.length === 0) return 0;
        return matched.reduce((sum, s) => sum + (s.promptTokens || 0) + (s.completionTokens || 0), 0) / matched.length;
    } catch {
        return 0;
    }
}

function recordTransition(
    entry: RegistryEntry,
    from: PromotionState | null,
    to: PromotionState,
    reason?: string,
): void {
    const tx = { from, to, at: new Date().toISOString(), reason };
    entry.transitions.push(tx);
    entry.lastTransition = tx;
    entry.recipe.state = to;
}

function freshId(): string {
    return `cr-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** Register a compiled recipe. Requires selfCompiling.enabled && compile, otherwise returns null. */
export function registerRecipe(recipe: Omit<CompiledRecipe, 'id'> & { id?: string }): RegistryEntry {
    if (!selfCompilingFlag('compile')) {
        throw new Error('selfCompiling compile gate is closed');
    }
    const registry = readRegistry();
    const id = recipe.id || freshId();
    if (registry[id]) {
        throw new Error(`Compiled recipe ${id} already registered`);
    }
    const full: CompiledRecipe = {
        id,
        name: recipe.name,
        description: recipe.description,
        slashCommand: recipe.slashCommand,
        parameters: recipe.parameters || {},
        steps: recipe.steps,
        author: recipe.author || 'compiler',
        tags: recipe.tags || ['compiled'],
        createdAt: recipe.createdAt || new Date().toISOString(),
        signature: recipe.signature,
        sourceTraceIds: recipe.sourceTraceIds || [],
        tier: recipe.tier,
        state: 'candidate',
        stats: { invocations: 0, successes: 0, tokensSaved: 0, shadowComparisons: 0, shadowSuccesses: 0 },
    };
    const entry: RegistryEntry = {
        recipe: full,
        baselineTokens: measureBaselineTokens(full.sourceTraceIds),
        transitions: [],
        lastTransition: { from: null, to: 'candidate', at: full.createdAt, reason: 'registered' },
    };
    recordTransition(entry, null, 'candidate', 'registered');
    registry[id] = entry;
    writeRegistry(registry);
    logger.info(COMPONENT, `Registered ${full.tier === 1 ? 'tier-1 advice' : 'tier-2 recipe'} ${id} (${full.signature})`);
    return entry;
}

/** Promote candidate → shadow or demoted → shadow. Requires selfCompiling.enabled && promote. */
export function promoteToShadow(id: string, reason = 'promotion'): RegistryEntry {
    if (!selfCompilingFlag('promote')) {
        throw new Error('selfCompiling promote gate is closed');
    }
    const registry = readRegistry();
    const entry = registry[id];
    if (!entry) throw new Error(`No compiled recipe ${id}`);
    if (entry.recipe.state !== 'candidate' && entry.recipe.state !== 'demoted') {
        throw new Error(`Illegal transition: ${entry.recipe.state} → shadow`);
    }
    recordTransition(entry, entry.recipe.state, 'shadow', reason);
    writeRegistry(registry);
    logger.info(COMPONENT, `Promoted ${id} to shadow`);
    return entry;
}

/** Record one shadow comparison verdict (true = semantically equivalent). */
export function recordShadowComparison(id: string, equivalent: boolean): RegistryEntry {
    if (!selfCompilingFlag('promote')) {
        throw new Error('selfCompiling promote gate is closed');
    }
    const registry = readRegistry();
    const entry = registry[id];
    if (!entry) throw new Error(`No compiled recipe ${id}`);
    if (entry.recipe.state !== 'shadow') {
        throw new Error(`Shadow comparison only valid in shadow state, got ${entry.recipe.state}`);
    }
    entry.recipe.stats.shadowComparisons++;
    if (equivalent) entry.recipe.stats.shadowSuccesses++;
    writeRegistry(registry);
    logger.debug(COMPONENT, `Shadow comparison for ${id}: ${equivalent ? 'equivalent' : 'different'}`);
    return entry;
}

/** Activate shadow → active. Requires min comparisons and 100% success rate. */
export function activate(id: string): RegistryEntry {
    if (!selfCompilingFlag('promote')) {
        throw new Error('selfCompiling promote gate is closed');
    }
    const registry = readRegistry();
    const entry = registry[id];
    if (!entry) throw new Error(`No compiled recipe ${id}`);
    if (entry.recipe.state !== 'shadow') {
        throw new Error(`Illegal transition: ${entry.recipe.state} → active`);
    }
    const comps = entry.recipe.stats.shadowComparisons;
    if (comps < SHADOW_MIN_COMPARISONS) {
        throw new Error(`promotion gate refused: ${comps}/${SHADOW_MIN_COMPARISONS} shadow comparisons`);
    }
    const rate = comps === 0 ? 0 : entry.recipe.stats.shadowSuccesses / comps;
    if (rate < SHADOW_MIN_SUCCESS_RATE) {
        throw new Error(`promotion gate refused: shadow success rate ${rate.toFixed(2)} < ${SHADOW_MIN_SUCCESS_RATE}`);
    }
    recordTransition(entry, 'shadow', 'active', 'shadow comparisons passed');
    writeRegistry(registry);
    logger.info(COMPONENT, `Activated ${id}`);
    return entry;
}

/** Demote active → demoted. Demoted recipes can re-enter shadow, never active. */
export function demote(id: string, reason: string): RegistryEntry {
    if (!selfCompilingFlag('promote')) {
        throw new Error('selfCompiling promote gate is closed');
    }
    const registry = readRegistry();
    const entry = registry[id];
    if (!entry) throw new Error(`No compiled recipe ${id}`);
    if (entry.recipe.state !== 'active' && entry.recipe.state !== 'shadow') {
        throw new Error(`Illegal transition: ${entry.recipe.state} → demoted`);
    }
    recordTransition(entry, entry.recipe.state, 'demoted', reason);
    writeRegistry(registry);
    logger.info(COMPONENT, `Demoted ${id}: ${reason}`);
    return entry;
}

/** Auto-demote helper: active recipe fails an active-run replay equivalence check. */
export function autoDemoteOnFailure(id: string, detail: string): RegistryEntry {
    return demote(id, `auto-demote: active replay failed (${detail})`);
}

/** Retire any non-retired recipe. Retired is terminal. */
export function retire(id: string, reason: string): RegistryEntry {
    if (!selfCompilingFlag('promote')) {
        throw new Error('selfCompiling promote gate is closed');
    }
    const registry = readRegistry();
    const entry = registry[id];
    if (!entry) throw new Error(`No compiled recipe ${id}`);
    if (entry.recipe.state === 'retired') {
        throw new Error(`Recipe ${id} is already retired`);
    }
    recordTransition(entry, entry.recipe.state, 'retired', reason);
    writeRegistry(registry);
    logger.info(COMPONENT, `Retired ${id}: ${reason}`);
    return entry;
}

/** Record an active invocation result. Success credits tokensSaved; failure auto-demotes. */
export function recordInvocation(id: string, success: boolean): RegistryEntry {
    if (!selfCompilingFlag('record')) {
        throw new Error('selfCompiling record gate is closed');
    }
    const registry = readRegistry();
    const entry = registry[id];
    if (!entry) throw new Error(`No compiled recipe ${id}`);
    if (entry.recipe.state !== 'active') {
        throw new Error(`recordInvocation only valid in active state, got ${entry.recipe.state}`);
    }
    entry.recipe.stats.invocations++;
    if (success) {
        entry.recipe.stats.successes++;
        entry.recipe.stats.tokensSaved += entry.baselineTokens;
    } else {
        recordTransition(entry, 'active', 'demoted', 'auto-demote: active invocation failed');
    }
    writeRegistry(registry);
    logger.info(COMPONENT, `Recorded invocation ${id}: ${success ? 'success' : 'demoted'}`);
    return entry;
}

/** Get a registry entry by ID. */
export function getEntry(id: string): RegistryEntry | undefined {
    return readRegistry()[id];
}

/** List all entries. */
export function listEntries(): RegistryEntry[] {
    return Object.values(readRegistry());
}

/** Only active tier-2 recipes should be exposed as slash commands. */
export function getActiveRecipes(): CompiledRecipe[] {
    return listEntries()
        .filter(e => e.recipe.state === 'active' && e.recipe.tier === 2)
        .map(e => e.recipe);
}

/** Tier-1 advice skills in active state. */
export function getActiveAdviceSkills(): CompiledRecipe[] {
    return listEntries()
        .filter(e => e.recipe.state === 'active' && e.recipe.tier === 1)
        .map(e => e.recipe);
}

/** Aggregate measured compiler stats. */
export function compilerStats(): {
    totalRecipes: number;
    activeRecipes: number;
    shadowRecipes: number;
    demotedRecipes: number;
    totalTokensSaved: number;
    totalInvocations: number;
    totalSuccesses: number;
} {
    const entries = listEntries();
    return {
        totalRecipes: entries.length,
        activeRecipes: entries.filter(e => e.recipe.state === 'active').length,
        shadowRecipes: entries.filter(e => e.recipe.state === 'shadow').length,
        demotedRecipes: entries.filter(e => e.recipe.state === 'demoted').length,
        totalTokensSaved: entries.reduce((sum, e) => sum + e.recipe.stats.tokensSaved, 0),
        totalInvocations: entries.reduce((sum, e) => sum + e.recipe.stats.invocations, 0),
        totalSuccesses: entries.reduce((sum, e) => sum + e.recipe.stats.successes, 0),
    };
}
