/**
 * TITAN v8 Slice 7 — Promotion Layer: Semantic Equivalence Comparators
 */
import type { EquivalenceComparator, ShadowRunOutput } from './recipeRegistry.js';

function normalizeAnswer(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderRun(runs: ShadowRunOutput): { recipe: string; frontier: string } {
    const recipe = runs.recipe.map(r => r.content).join("\n");
    const frontier = typeof runs.frontier === 'string' ? runs.frontier : runs.frontier.map(r => r.content).join("\n");
    return { recipe, frontier };
}

export const structuralComparator: EquivalenceComparator = (runs) => {
    const { recipe, frontier } = renderRun(runs);
    return recipe === frontier;
};

export const normalizedTextComparator: EquivalenceComparator = (runs) => {
    const { recipe, frontier } = renderRun(runs);
    return normalizeAnswer(recipe) === normalizeAnswer(frontier);
};

export const lineSetComparator: EquivalenceComparator = (runs) => {
    const { recipe, frontier } = renderRun(runs);
    const recipeSet = new Set(recipe.split("\n").map(normalizeAnswer).filter(Boolean));
    const frontierSet = new Set(frontier.split("\n").map(normalizeAnswer).filter(Boolean));
    if (recipeSet.size !== frontierSet.size) return false;
    for (const line of recipeSet) if (!frontierSet.has(line)) return false;
    return true;
};

export function comparatorForIntent(intent: string): EquivalenceComparator {
    const normalized = intent.toLowerCase().trim();
    if (normalized.includes("list") || normalized.includes("search") || normalized.includes("find")) return lineSetComparator;
    return normalizedTextComparator;
}
