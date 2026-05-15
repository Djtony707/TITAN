/**
 * TITAN — Model Recommendation Engine
 *
 * Scores every discovered model for each specialist role so the UI can
 * surface "Recommended", "Fast", "Reasoning", etc. badges next to the
 * model dropdown.
 *
 * The recommender is **stateless** — it consumes live discovery results
 * (provider health + model catalogue) and static capability profiles, so
 * recommendations adapt immediately when a provider key is added or an
 * Ollama model is pulled.
 */
import type { DiscoveredModel } from './router.js';
import { getModelCapabilities, type ModelCapabilities } from './modelCapabilities.js';
import logger from '../utils/logger.js';
import { SPECIALISTS, type Specialist } from '../agent/specialists.js';

const COMPONENT = 'ModelRecommender';

/** Score breakdown returned for diagnostics / tooltips */
export interface ScoreBreakdown {
    capabilityScore: number; // 0‑40 (context + output + thinking)
    specialistFit: number;   // 0‑40 (role‑heuristic match)
    availability: number;      // 0‑20 (provider healthy + key configured)
}

export interface ModelRecommendation {
    /** Full model id e.g. "ollama/deepseek-v4-pro:cloud" */
    id: string;
    /** Human label (same as id, kept for consumers that pass it to the API) */
    label: string;
    /** Total score 0‑100 */
    score: number;
    /** Detailed score breakdown */
    breakdown: ScoreBreakdown;
    /** Capability snapshot */
    capabilities: ModelCapabilities;
    /** True if this model is the current default for this specialist */
    isDefault: boolean;
    /** True if this model is the currently active override */
    isActive: boolean;
    /** Tags for UI badges — e.g. ["Recommended", "Fast", "Reasoning"] */
    badges: string[];
    /** One‑line rationale for the score */
    rationale: string;
}

/** Per‑specialist scoring weights (capability + fit + availability) */
interface Weights {
    capability: number;
    fit: number;
    availability: number;
}

/** How important is each capability axis for a specialist role */
interface CapabilityPrefs {
    minContext: number;          // minimum context window to avoid penalty
    contextWeight: number;       // 0‑1
    outputWeight: number;        // 0‑1
    thinkingWeight: number;      // 0‑1
}

const WEIGHTS: Record<string, Weights> = {
    scout:    { capability: 30, fit: 40, availability: 30 },
    builder:  { capability: 35, fit: 35, availability: 30 },
    writer:   { capability: 30, fit: 40, availability: 30 },
    analyst:  { capability: 40, fit: 30, availability: 30 },
    sage:     { capability: 35, fit: 35, availability: 30 },
};

const CAP_PREFS: Record<string, CapabilityPrefs> = {
    scout:    { minContext: 32_768,  contextWeight: 0.3, outputWeight: 0.2, thinkingWeight: 0.0 },
    builder:  { minContext: 32_768,  contextWeight: 0.2, outputWeight: 0.4, thinkingWeight: 0.3 },
    writer:   { minContext: 16_384,  contextWeight: 0.2, outputWeight: 0.5, thinkingWeight: 0.0 },
    analyst:  { minContext: 128_000, contextWeight: 0.4, outputWeight: 0.2, thinkingWeight: 0.3 },
    sage:     { minContext: 64_000,  contextWeight: 0.3, outputWeight: 0.2, thinkingWeight: 0.4 },
};

const DEFAULT_WEIGHTS: Weights = { capability: 33, fit: 34, availability: 33 };
const DEFAULT_PREFS: CapabilityPrefs = { minContext: 32_768, contextWeight: 0.3, outputWeight: 0.4, thinkingWeight: 0.2 };

/** Keyword maps used to compute specialistFit */
const FIT_KEYWORDS: Record<string, { good: string[]; bad: string[] }> = {
    scout: {
        good: ['flash', 'lightning', 'fast', 'turbo', 'mini', 'haiku', 'search'],
        bad:  ['opus', 'pro:cloud', 'v3.2', '671b', '70b', 'large', 'ultra', 'thinking'],
    },
    builder: {
        good: ['pro', 'opus', 'coder', 'code', 'thinking', 'reasoning', 'claude', 'sonnet', 'gemini-2.5'],
        bad:  ['mini', 'nano', 'haiku', 'flash', 'lightning', '0.5b', '0.6b'],
    },
    writer: {
        good: ['writer', 'creative', 'turbo', 'minimax', 'm2.7', 'claude', 'sonnet', 'gpt-4o'],
        bad:  ['mini', 'nano', 'flash', '0.6b', '1b', '2b'],
    },
    analyst: {
        good: ['pro', 'opus', 'thinking', 'reasoning', 'o1', 'o3', 'kimi-k2.6', 'gemini-2.5', 'deepseek-v4-pro', 'qwen3.6'],
        bad:  ['mini', 'nano', 'flash', 'haiku', '0.6b', '1b', '2b'],
    },
    sage: {
        good: ['pro', 'opus', 'thinking', 'reasoning', 'kimi', 'claude', 'sonnet', 'deepseek-v4-pro'],
        bad:  ['mini', 'nano', 'flash', '0.6b', '1b'],
    },
};

/** Get a specialist entry by id (includes custom config agents) */
function getSpecialistById(id: string): Specialist | null {
    return SPECIALISTS.find(s => s.id === id) ?? null;
}

/** ── Scoring helpers ───────────────────────────────────────────── */

function scoreCapability(model: string, caps: ModelCapabilities, prefs: CapabilityPrefs): number {
    const id = model.toLowerCase();

    // Context window (normalized to a 0‑12 scale)
    let contextScore = 0;
    if (caps.contextWindow >= 1_000_000) contextScore = 12;
    else if (caps.contextWindow >= 500_000) contextScore = 10;
    else if (caps.contextWindow >= 262_144) contextScore = 9;
    else if (caps.contextWindow >= 200_000) contextScore = 8;
    else if (caps.contextWindow >= 128_000) contextScore = 7;
    else if (caps.contextWindow >= 64_000) contextScore = 5;
    else if (caps.contextWindow >= 32_768) contextScore = 3;
    else contextScore = 1;

    // If below minimum expected, heavy penalty
    if (caps.contextWindow < prefs.minContext) {
        contextScore = Math.max(0, contextScore - 6);
    }

    // Output ceiling (0‑10)
    let outputScore = 0;
    if (caps.maxOutput >= 128_000) outputScore = 10;
    else if (caps.maxOutput >= 64_000) outputScore = 8;
    else if (caps.maxOutput >= 32_768) outputScore = 6;
    else if (caps.maxOutput >= 16_384) outputScore = 4;
    else if (caps.maxOutput >= 8_192) outputScore = 2;
    else outputScore = 1;

    // Thinking support (0‑10)
    const thinkingScore = caps.supportsThinking ? 10 : 0;

    const raw =
        contextScore * prefs.contextWeight +
        outputScore   * prefs.outputWeight +
        thinkingScore * prefs.thinkingWeight;

    // Renormalise to 0‑40
    const maxRaw = 12 * prefs.contextWeight + 10 * prefs.outputWeight + 10 * prefs.thinkingWeight;
    return maxRaw > 0 ? Math.round((raw / maxRaw) * 40) : 20;
}

function scoreFit(model: string, specialistId: string): number {
    const id = model.toLowerCase();
    const kw = FIT_KEYWORDS[specialistId] ?? { good: [], bad: [] };

    let score = 20; // neutral midpoint
    for (const g of kw.good) {
        if (id.includes(g.toLowerCase())) score += 4;
    }
    for (const b of kw.bad) {
        if (id.includes(b.toLowerCase())) score -= 4;
    }
    return Math.max(0, Math.min(40, score));
}

function scoreAvailability(dm: DiscoveredModel): number {
    let score = 10; // base
    if (dm.keyConfigured) score += 6;
    // If the provider is *not* healthy we can't tell from DiscoveredModel alone,
    // but the caller should filter un‑healthy providers before passing the list.
    return Math.min(20, score);
}

function computeBadges(
    dm: DiscoveredModel,
    caps: ModelCapabilities,
    score: number,
    isTop: boolean,
): string[] {
    const badges: string[] = [];
    const id = dm.id.toLowerCase();

    if (isTop) badges.push('Recommended');

    if (caps.supportsThinking) badges.push('Reasoning');

    if (id.includes('flash') || id.includes('lightning') || id.includes('fast') || id.includes('turbo')) {
        badges.push('Fast');
    }
    if (id.includes('mini') || id.includes('nano') || id.includes('haiku')) {
        badges.push('Light');
    }
    if (caps.contextWindow >= 128_000) badges.push('Long Context');
    if (caps.maxOutput >= 32_768) badges.push('High Output');
    if (!dm.keyConfigured) badges.push('Needs Key');

    return badges;
}

function buildRationale(score: number, breakdown: ScoreBreakdown, dm: DiscoveredModel): string {
    if (!dm.keyConfigured) return 'Model discovered but provider API key is not configured.';
    if (score >= 80) return 'Excellent match — high capability + strong specialist fit + available.';
    if (score >= 65) return 'Good fit — solid capability profile for this role.';
    if (score >= 50) return 'Acceptable — works but may not be optimal for this specialist.';
    if (breakdown.availability < 10) return 'Provider unavailable or key missing.';
    return 'Weak match — consider a different model for this specialist.';
}

/** ── Public API ────────────────────────────────────────────────── */

/**
 * Score every available model for a given specialist.
 *
 * @param specialistId  e.g. "scout", "builder", "writer", "analyst", "sage"
 * @param models        output of discoverAllModels() (already filtered to healthy providers)
 * @param activeModel   the currently active model override (if any)
 */
export function recommendModelsForSpecialist(
    specialistId: string,
    models: DiscoveredModel[],
    activeModel?: string | null,
): ModelRecommendation[] {
    const specialist = getSpecialistById(specialistId);
    const defaultModel = specialist?.model ?? '';

    const weights = WEIGHTS[specialistId] ?? DEFAULT_WEIGHTS;
    const prefs = CAP_PREFS[specialistId] ?? DEFAULT_PREFS;

    const scored = models.map(dm => {
        const caps = getModelCapabilities(dm.id);
        const capability = scoreCapability(dm.id, caps, prefs);
        const fit = scoreFit(dm.id, specialistId);
        const availability = scoreAvailability(dm);

        const total = Math.round(
            capability * (weights.capability / 100) +
            fit      * (weights.fit       / 100) +
            availability * (weights.availability / 100),
        );

        return {
            id: dm.id,
            label: dm.id,
            score: total,
            breakdown: { capabilityScore: capability, specialistFit: fit, availability },
            capabilities: caps,
            isDefault: dm.id === defaultModel,
            isActive: dm.id === activeModel,
            badges: [] as string[], // filled after sorting
            rationale: '',             // filled after sorting
        };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // Fill badges/rationale in rank order so "Recommended" is only the top pick
    for (let i = 0; i < scored.length; i++) {
        const r = scored[i];
        const dm = models.find(m => m.id === r.id);
        if (!dm) continue;
        r.badges = computeBadges(dm, r.capabilities, r.score, i === 0);
        r.rationale = buildRationale(r.score, r.breakdown, dm);
    }

    return scored;
}

/**
 * Convenience: score models for *all* built‑in specialists at once.
 * Used by the settings page to pre‑fetch every recommendation table.
 */
export interface AllRecommendations {
    [specialistId: string]: ModelRecommendation[];
}

export function recommendModelsForAllSpecialists(
    models: DiscoveredModel[],
    overrides: Record<string, string | null | undefined>,
): AllRecommendations {
    const out: AllRecommendations = {};
    for (const sp of SPECIALISTS) {
        out[sp.id] = recommendModelsForSpecialist(sp.id, models, overrides[sp.id] ?? null);
    }
    return out;
}

/** Quick health validation — are the provider caches reachable? */
export async function validateRecommendations(): Promise<{ ok: boolean; detail?: string }> {
    try {
        const { discoverAllModels } = await import('./router.js');
        const models = await discoverAllModels(true);
        if (!models.length) {
            logger.warn(COMPONENT, 'No models discovered — user may have no provider keys configured');
        }
        return { ok: true };
    } catch (e) {
        const msg = (e as Error).message;
        logger.error(COMPONENT, `Discovery failed: ${msg}`);
        return { ok: false, detail: msg };
    }
}
