/**
 * TITAN — Recipe Runner
 * Executes a recipe against the current session, filling in parameters
 * and running each step as an agent conversation message.
 */
import { saveRecipe, getRecipe } from './store.js';
import logger from '../utils/logger.js';

const COMPONENT = 'RecipeRunner';

/** Interpolate {{parameter}} placeholders in a prompt */
function interpolate(template: string, params: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        if (params[key] === undefined) {
            logger.warn(COMPONENT, `Missing recipe parameter: {{${key}}}`);
        }
        return params[key] ?? `<${key}>`;
    });
}

/** Run a recipe and yield each step's prompt as a string */
export async function* runRecipe(
    recipeId: string,
    userParams: Record<string, string> = {},
): AsyncGenerator<{ stepIndex: number; prompt: string; total: number }> {
    const recipe = getRecipe(recipeId);
    if (!recipe) throw new Error(`Recipe "${recipeId}" not found`);

    logger.info(COMPONENT, `Running recipe: ${recipe.name} (${recipe.steps.length} steps)`);

    // v7.0: declared parameter defaults fill anything the caller didn't supply,
    // so adopted/learned recipes never run with literal <param> placeholders.
    const effectiveParams: Record<string, string> = {};
    for (const [key, spec] of Object.entries(recipe.parameters || {})) {
        if (spec?.default !== undefined) effectiveParams[key] = spec.default;
    }
    for (const [key, val] of Object.entries(userParams)) {
        if (val !== undefined) effectiveParams[key] = val; // '' is a legitimate value
    }

    for (let i = 0; i < recipe.steps.length; i++) {
        const step = recipe.steps[i];
        const prompt = interpolate(step.prompt, effectiveParams);
        yield { stepIndex: i, prompt, total: recipe.steps.length };
    }

    // Update last run timestamp
    recipe.lastRunAt = new Date().toISOString();
    saveRecipe(recipe);
}

/** Detect if a message is a slash command and return the recipe + raw command */
export function parseSlashCommand(message: string): { command: string; args: string } | null {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    const command = spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
    const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

    return { command, args };
}
