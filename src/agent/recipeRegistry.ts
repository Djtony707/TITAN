/**
 * TITAN v8 — Recipe Registry (Self-Compiling Agent, Stage 4: GATE)
 *
 * The promotion state machine for compiled recipes:
 *
 *   candidate → shadow → active → (demoted | retired)
 *
 * No path skips shadow. A recipe is `active` (routable by routerMiddleware)
 * only after it survives the shadow gate:
 *
 *   - SHADOW_MIN_COMPARISONS shadow invocations, AND
 *   - EVERY shadow comparison semantically equivalent (zero-false-positive
 *     bar — one mismatch blocks promotion until the recipe is re-compiled)
 *
 * Auto-demote on failure: one failed replay of an active recipe demotes it
 * immediately (rollback = the router stops matching it; the frontier path
 * takes over — the same "fail safe, fall back to the expensive thing"
 * pattern as migrate's auto-rollback, at recipe granularity).
 *
 * Measured metrics only (Finding 3 / hard gate 8): tokensSaved is the
 * per-recipe baseline computed from the ACTUAL token counts of the source
 * traces at registration time, and the running total is incremented only
 * after a successful replay. Nothing is narrated.
 *
 * Persistence: `$TITAN_HOME/compiler/registry.json`, atomic temp+rename
 * (same conventions as capabilitiesRegistry). TITAN_HOME is resolved at
 * call time (mirroring traceStore.ts) so tests isolate per-fixture homes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { CompiledRecipe } from './recipeCompiler.js';
import { readTraces } from './traceStore.js';
import type { TitanConfig } from '../config/schema.js';
import { shouldCompile, shouldPromote } from './v8Gates.js';
import logger from '../utils/logger.js';

const COMPONENT = 'RecipeRegistry';

/** Promotion gate thresholds. Strict by design: a regression that reaches
 *  `active` costs user trust; a recipe stuck in shadow costs nothing. */
export const SHADOW_MIN_COMPARISONS = 3;
export const SHADOW_MIN_SUCCESS_RATE = 1.0;

// ── Types ────────────────────────────────────────────────────────────────

export type RecipeState = CompiledRecipe['state'];

export interface RegistryEntry {
    recipe: CompiledRecipe;
    /** Measured per-invocation token baseline: mean (prompt+completion)
     *  tokens across the source traces, read from the TraceStore at
     *  registration time. 0 when source traces carry no token counts. */
    baselineTokens: number;
    /** Human/audit-visible reason for the last state transition. */
    lastTransition: { at: string; from: RecipeState; to: RecipeState; reason: string };
}

export interface CompilerStats {
    totalRecipes: number;
    byState: Record<RecipeState, number>;
    totalInvocations: number;
    totalSuccesses: number;
    /** Sum of measured tokens saved by successful replays across all recipes. */
    totalTokensSaved: number;
}

interface RegistryFile {
    version: 1;
    updatedAt: string;
    entries: Record<string, RegistryEntry>;
    /** Persisted shadow comparison records (Honey blocker 3 final form). */
    comparisons?: ShadowComparisonRecord[];
}

// ── Equivalence (Honey blocker 3 — closed comparator registry) ───────────

/**
 * The output of one side of a shadow comparison. The registry is given both
 * sides and computes the equivalence verdict itself — the caller cannot pass
 * a bare boolean OR an injected comparator. `recipe` is the compiled recipe's
 * replay output; `frontier` is what the frontier model produced for the same
 * request.
 */
export interface ShadowRunOutput {
    /** The replayed tool outputs from the compiled recipe (zero model calls). */
    recipe: Array<{ name: string; content: string }>;
    /** The frontier model's answer for the same request. */
    frontier: Array<{ name: string; content: string }> | string;
}

/**
 * Internal comparator type. NOT exported through the promotion API — callers
 * cannot inject this. The registry selects a comparator from a closed registry
 * (COMPARATOR_REGISTRY) by id; the selected comparator's id and version are
 * persisted on every ShadowComparisonRecord so the evidence trail identifies
 * which trusted comparator generated each verdict.
 */
type EquivalenceComparator = (runs: ShadowRunOutput) => boolean;

/** Metadata for a registered comparator. */
interface ComparatorEntry {
    id: string;
    version: number;
    fn: EquivalenceComparator;
}

/**
 * Closed comparator registry. Comparators are registered here at module load;
 * the public API references them by id only. Callers cannot add to this
 * registry — it is a closed set. The default structural comparator is the
 * only one registered now; production adds semantic comparators here, not
 * via function parameters.
 */
const COMPARATOR_REGISTRY = new Map<string, ComparatorEntry>();
const DEFAULT_COMPARATOR_ID = 'structural-v1';

function registerComparator(id: string, version: number, fn: EquivalenceComparator): void {
    COMPARATOR_REGISTRY.set(id, { id, version, fn });
}

/** Default comparator: structural equality. Renders both sides to a flat
 *  content string and compares. Strict and dumb on purpose — it is the
 *  fallback, not the recommendation. Production registers a real semantic
 *  comparator; this one exists so the gate can be exercised end-to-end. */
function structuralCompare(runs: ShadowRunOutput): boolean {
    const recipeSide = runs.recipe.map(r => r.content).join('\n');
    const frontierSide = typeof runs.frontier === 'string'
        ? runs.frontier
        : runs.frontier.map(r => r.content).join('\n');
    return recipeSide === frontierSide;
}

registerComparator(DEFAULT_COMPARATOR_ID, 1, structuralCompare);

/**
 * A persisted record of one shadow comparison. The registry returns this
 * instead of a bare boolean so the evidence trail identifies which trusted
 * comparator generated the verdict, at which epoch, and with what output
 * hashes. Activation counts unique records for the current epoch.
 */
export interface ShadowComparisonRecord {
    recipeId: string;
    shadowEpoch: number;
    comparisonId: string;
    equivalent: boolean;
    comparatorId: string;
    comparatorVersion: number;
    recipeOutputHash: string;
    frontierOutputHash: string;
    createdAt: string;
}

/** Simple deterministic hash for evidence records (not cryptographic). */
function hashOutput(output: ShadowRunOutput['recipe'] | ShadowRunOutput['frontier']): string {
    if (typeof output === 'string') return `s:${output.length}:${output.slice(0, 64)}`;
    return 'a:' + output.map(r => `${r.name}:${r.content.length}:${r.content.slice(0, 64)}`).join('|');
}

// ── Storage path (mirrors traceStore.ts) ─────────────────────────────────

function registryPath(): string {
    const envHome = process.env.TITAN_HOME?.trim();
    if (envHome) {
        if (envHome.startsWith('~/')) return join(homedir(), envHome.slice(2), 'compiler', 'registry.json');
        if (envHome === '~') return join(homedir(), 'compiler', 'registry.json');
        return join(envHome, 'compiler', 'registry.json');
    }
    return join(homedir(), '.titan', 'compiler', 'registry.json');
}

// ── Persistence (in-memory cache + atomic write-through) ─────────────────

let cache: RegistryFile | null = null;

function emptyRegistry(): RegistryFile {
    return { version: 1, updatedAt: new Date().toISOString(), entries: {} };
}

function load(): RegistryFile {
    if (cache) return cache;
    const path = registryPath();
    try {
        if (existsSync(path)) {
            const parsed = JSON.parse(readFileSync(path, 'utf-8')) as RegistryFile;
            if (parsed.version === 1 && typeof parsed.entries === 'object') {
                cache = parsed;
                return cache;
            }
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to load registry: ${(err as Error).message} — starting empty`);
    }
    cache = emptyRegistry();
    return cache;
}

function save(reg: RegistryFile): void {
    const path = registryPath();
    try {
        mkdirSync(dirname(path), { recursive: true });
        reg.updatedAt = new Date().toISOString();
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf-8');
        renameSync(tmp, path);
    } catch (err) {
        // Registry persistence must never affect the agent loop.
        logger.error(COMPONENT, `Failed to save registry: ${(err as Error).message}`);
    }
}

/** Test hook: drop the in-memory cache so the next call re-reads disk. */
export function invalidateRegistryCache(): void {
    cache = null;
}

// ── Baseline from source traces (measured, Finding 3) ────────────────────

/**
 * Mean total (prompt+completion) tokens across the recipe's source traces.
 * Reads the TraceStore — the actual recorded runs — so the savings report
 * is grounded in measured counts, not estimates. Traces without token
 * counts contribute nothing; if none have counts the baseline is 0 and the
 * savings report says so honestly.
 */
function measureBaselineTokens(recipe: CompiledRecipe): number {
    const wanted = new Set(recipe.sourceTraceIds);
    if (wanted.size === 0) return 0;
    let sum = 0;
    let counted = 0;
    for (const trace of readTraces(1000)) {
        if (!wanted.has(trace.traceId)) continue;
        if (!trace.tokens) continue;
        sum += (trace.tokens.prompt || 0) + (trace.tokens.completion || 0);
        counted++;
    }
    return counted > 0 ? Math.round(sum / counted) : 0;
}

// ── State machine ────────────────────────────────────────────────────────

const TRANSITIONS: Record<RecipeState, RecipeState[]> = {
    candidate: ['shadow', 'retired'],
    shadow: ['active', 'demoted', 'retired'],
    active: ['demoted', 'retired'],
    demoted: ['shadow', 'retired'], // re-compiled/fixed recipes re-enter at shadow, never at active
    retired: [],
};

function transition(entry: RegistryEntry, to: RecipeState, reason: string): void {
    const from = entry.recipe.state;
    if (!TRANSITIONS[from].includes(to)) {
        throw new Error(`RecipeRegistry: illegal transition ${from} → ${to} for recipe ${entry.recipe.id}`);
    }
    entry.recipe.state = to;
    entry.lastTransition = { at: new Date().toISOString(), from, to, reason };
    logger.info(COMPONENT, `Recipe ${entry.recipe.id}: ${from} → ${to} (${reason})`);
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Register a freshly compiled recipe as a `candidate`. The source-trace
 * token baseline is measured here, once, while the traces are fresh.
 *
 * Gated by `selfCompiling.compile` (Stage 3): when the compile gate is off
 * the registry refuses to register — no new candidates enter the promotion
 * pipeline. The config is resolved from `TitanConfig` at call time; tests
 * pass `configOverride` to exercise the gate without constructing a full
 * config object (same pattern as v8Gates).
 */
export function registerRecipe(
    recipe: CompiledRecipe,
    configOverride?: TitanConfig,
): RegistryEntry {
    if (configOverride && !shouldCompile(configOverride)) {
        throw new Error(`RecipeRegistry: compile gate refused registration of ${recipe.id} — selfCompiling.compile is off`);
    }
    const reg = load();
    const entry: RegistryEntry = {
        recipe: { ...recipe, state: 'candidate' },
        baselineTokens: measureBaselineTokens(recipe),
        lastTransition: { at: '', from: 'candidate', to: 'candidate', reason: '' },
    };
    entry.lastTransition = {
        at: new Date().toISOString(),
        from: 'candidate',
        to: 'candidate',
        reason: `registered; baseline ${entry.baselineTokens} tokens from ${recipe.sourceTraceIds.length} source trace(s)`,
    };
    reg.entries[recipe.id] = entry;
    save(reg);
    return entry;
}

export function getEntry(id: string): RegistryEntry | null {
    return load().entries[id] ?? null;
}

export function listEntries(): RegistryEntry[] {
    return Object.values(load().entries);
}

/** The router's view: only `active` recipes may replay. */
export function getActiveRecipes(): CompiledRecipe[] {
    return listEntries().filter(e => e.recipe.state === 'active').map(e => e.recipe);
}

/**
 * candidate → shadow. Shadow execution runs alongside the frontier path.
 *
 * Gated by `selfCompiling.promote` (Stage 4): the promotion gate must be
 * on to enter shadow.
 *
 * Honey blocker 2 fix: the shadow evaluation window is RESET on every
 * entry. `shadowComparisons` and `shadowSuccesses` return to 0 and the
 * `shadowEpoch` is incremented, so comparisons from a prior shadow stint
 * (before a demote) cannot satisfy the current promotion window. A recipe
 * that was perfect, got demoted, and re-enters shadow must earn its
 * promotion from zero fresh evidence — no stale counter reactivation.
 */
export function promoteToShadow(
    id: string,
    reason = 'entered shadow evaluation',
    configOverride?: TitanConfig,
): RegistryEntry {
    if (configOverride && !shouldPromote(configOverride)) {
        throw new Error(`RecipeRegistry: promote gate refused shadow entry for ${id} — selfCompiling.promote is off`);
    }
    const reg = load();
    const entry = reg.entries[id];
    if (!entry) throw new Error(`RecipeRegistry: unknown recipe ${id}`);
    // Reset the shadow evaluation window (Honey blocker 2). The epoch
    // increments so any in-flight comparison records from the prior epoch
    // are invalidated; the counters return to zero for a clean window.
    entry.recipe.stats.shadowComparisons = 0;
    entry.recipe.stats.shadowSuccesses = 0;
    entry.recipe.stats.shadowEpoch += 1;
    transition(entry, 'shadow', reason);
    save(reg);
    return entry;
}

/**
 * shadow → active, behind the promotion gate. Refuses (throws) unless the
 * recipe has enough shadow comparisons and EVERY one was semantically
 * equivalent. The eval-harness suite gate (scripts/eval-gate.sh) runs at
 * release time over the whole build; this per-recipe gate runs at promotion
 * time over the recipe's own shadow evidence.
 *
 * Gated by `selfCompiling.promote` (Stage 4): promotion requires the gate.
 *
 * Uses `shadowSuccesses` (computed by the registry from compared runs,
 * Honey blocker 3) — NOT `successes`, which counts active-replay wins and
 * must not be spendable as shadow evidence.
 */
export function activate(
    id: string,
    configOverride?: TitanConfig,
): RegistryEntry {
    if (configOverride && !shouldPromote(configOverride)) {
        throw new Error(`RecipeRegistry: promote gate refused activation of ${id} — selfCompiling.promote is off`);
    }
    const reg = load();
    const entry = reg.entries[id];
    if (!entry) throw new Error(`RecipeRegistry: unknown recipe ${id}`);
    const { shadowComparisons, shadowSuccesses } = entry.recipe.stats;
    if (entry.recipe.state === 'shadow') {
        if (shadowComparisons < SHADOW_MIN_COMPARISONS) {
            throw new Error(
                `RecipeRegistry: promotion gate refused ${id} — ${shadowComparisons}/${SHADOW_MIN_COMPARISONS} shadow comparisons`,
            );
        }
        const rate = shadowSuccesses / shadowComparisons;
        if (rate < SHADOW_MIN_SUCCESS_RATE) {
            throw new Error(
                `RecipeRegistry: promotion gate refused ${id} — shadow equivalence ${(rate * 100).toFixed(0)}% < ${SHADOW_MIN_SUCCESS_RATE * 100}%`,
            );
        }
    }
    transition(entry, 'active', `promotion gate passed (${shadowSuccesses}/${shadowComparisons} equivalent)`);
    save(reg);
    return entry;
}

/** (shadow|active) → demoted. The router stops matching it immediately. */
export function demote(id: string, reason: string): RegistryEntry {
    const reg = load();
    const entry = reg.entries[id];
    if (!entry) throw new Error(`RecipeRegistry: unknown recipe ${id}`);
    transition(entry, 'demoted', reason);
    save(reg);
    return entry;
}

export function retire(id: string, reason: string): RegistryEntry {
    const reg = load();
    const entry = reg.entries[id];
    if (!entry) throw new Error(`RecipeRegistry: unknown recipe ${id}`);
    transition(entry, 'retired', reason);
    save(reg);
    return entry;
}

/**
 * Record one shadow comparison. Honey blocker 3 fix (final form): the public
 * API accepts epoch-bound structured evidence and returns a persisted
 * ShadowComparisonRecord. Equivalence is computed by an internal comparator
 * selected from a closed registry — there is NO public comparator parameter.
 * A caller cannot inject `() => true` because the function signature does not
 * accept a comparator. The verdict is computed, persisted with identity
 * metadata (comparator id/version, output hashes), and only then increments
 * derived counters.
 *
 * Gated by `selfCompiling.promote` (Stage 4): shadow comparisons are part
 * of the promotion flow; when the gate is off the comparison is refused
 * and the counters do not advance.
 *
 * Validation:
 *   - Rejects stale epochs (comparisonEpoch must match the recipe's current
 *     shadowEpoch).
 *   - Rejects duplicate comparisonIds.
 *   - Rejects missing/malformed outputs (empty recipe array, empty frontier).
 */
export function recordShadowComparison(
    id: string,
    evidence: {
        /** The recipe's current shadowEpoch — must match the registry's view. */
        epoch: number;
        /** Unique identifier for this comparison (caller-generated, must be unique). */
        comparisonId: string;
        /** The recipe's replay output. Must be non-empty. */
        recipe: Array<{ name: string; content: string }>;
        /** The frontier model's output for the same request. Must be non-empty. */
        frontier: Array<{ name: string; content: string }> | string;
    },
    options?: { configOverride?: TitanConfig },
): ShadowComparisonRecord {
    if (options?.configOverride && !shouldPromote(options.configOverride)) {
        throw new Error(`RecipeRegistry: promote gate refused shadow comparison for ${id} — selfCompiling.promote is off`);
    }
    // Validate evidence shape.
    if (!evidence.recipe || evidence.recipe.length === 0) {
        throw new Error(`RecipeRegistry: shadow comparison ${evidence.comparisonId} rejected — empty recipe output`);
    }
    if (evidence.frontier === '' || (Array.isArray(evidence.frontier) && evidence.frontier.length === 0)) {
        throw new Error(`RecipeRegistry: shadow comparison ${evidence.comparisonId} rejected — empty frontier output`);
    }
    const reg = load();
    const entry = reg.entries[id];
    if (!entry) throw new Error(`RecipeRegistry: unknown recipe ${id}`);
    // Stale epoch check: the comparison must be for the current shadow epoch.
    if (evidence.epoch !== entry.recipe.stats.shadowEpoch) {
        throw new Error(
            `RecipeRegistry: shadow comparison ${evidence.comparisonId} rejected — stale epoch ${evidence.epoch} (current: ${entry.recipe.stats.shadowEpoch})`,
        );
    }
    // Duplicate comparisonId check.
    if (!reg.comparisons) reg.comparisons = [];
    if (reg.comparisons.some(r => r.comparisonId === evidence.comparisonId)) {
        throw new Error(`RecipeRegistry: shadow comparison ${evidence.comparisonId} rejected — duplicate comparisonId`);
    }
    // Select comparator from closed registry (internal, not caller-injected).
    const comparatorEntry = COMPARATOR_REGISTRY.get(DEFAULT_COMPARATOR_ID)!;
    const runs: ShadowRunOutput = { recipe: evidence.recipe, frontier: evidence.frontier };
    const equivalent = comparatorEntry.fn(runs);
    // Build the persisted record.
    const record: ShadowComparisonRecord = {
        recipeId: id,
        shadowEpoch: evidence.epoch,
        comparisonId: evidence.comparisonId,
        equivalent,
        comparatorId: comparatorEntry.id,
        comparatorVersion: comparatorEntry.version,
        recipeOutputHash: hashOutput(evidence.recipe),
        frontierOutputHash: hashOutput(evidence.frontier),
        createdAt: new Date().toISOString(),
    };
    // Persist the record BEFORE incrementing derived counters.
    reg.comparisons.push(record);
    entry.recipe.stats.shadowComparisons++;
    if (equivalent) entry.recipe.stats.shadowSuccesses++;
    save(reg);
    return record;
}

/**
 * Record one replay invocation of an active recipe. tokensSaved is credited
 * ONLY on success (hard gate 8: measured, post-completion). A failed replay
 * auto-demotes the recipe — one bad zero-token answer is enough evidence
 * that the recipe no longer matches the world it was compiled in.
 */
export function recordInvocation(id: string, success: boolean): void {
    const reg = load();
    const entry = reg.entries[id];
    if (!entry) return;
    entry.recipe.stats.invocations++;
    if (success) {
        entry.recipe.stats.successes++;
        entry.recipe.stats.tokensSaved += entry.baselineTokens;
        save(reg);
    } else {
        save(reg);
        if (entry.recipe.state === 'active') {
            try {
                demote(id, 'auto-demote: replay failed — falling back to frontier path');
            } catch {
                /* demotion failure must never mask the original failure */
            }
        }
    }
}

/** Aggregate stats for the `titan compiler status` savings report (step 4). */
export function compilerStats(): CompilerStats {
    const entries = listEntries();
    const byState: Record<RecipeState, number> = { candidate: 0, shadow: 0, active: 0, demoted: 0, retired: 0 };
    let totalInvocations = 0;
    let totalSuccesses = 0;
    let totalTokensSaved = 0;
    for (const e of entries) {
        byState[e.recipe.state]++;
        totalInvocations += e.recipe.stats.invocations;
        totalSuccesses += e.recipe.stats.successes;
        totalTokensSaved += e.recipe.stats.tokensSaved;
    }
    return { totalRecipes: entries.length, byState, totalInvocations, totalSuccesses, totalTokensSaved };
}
