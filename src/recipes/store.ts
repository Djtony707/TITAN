/**
 * TITAN — Recipe Store
 * Saves and loads personal recipes from ~/.titan/recipes/
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import type { Recipe, RecipeStep } from './types.js';

const RECIPES_DIR = join(TITAN_HOME, 'recipes');

function ensureRecipesDir(): void {
    if (!existsSync(RECIPES_DIR)) mkdirSync(RECIPES_DIR, { recursive: true });
}

/** Load all saved recipes */
export function listRecipes(): Recipe[] {
    ensureRecipesDir();
    return readdirSync(RECIPES_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            try {
                return JSON.parse(readFileSync(join(RECIPES_DIR, f), 'utf-8')) as Recipe;
            } catch {
                return null;
            }
        })
        .filter((r): r is Recipe => r !== null);
}

/** Get a recipe by ID or slash command */
export function getRecipe(idOrSlash: string): Recipe | null {
    const recipes = listRecipes();
    return recipes.find(
        (r) => r.id === idOrSlash || r.slashCommand === idOrSlash
    ) || null;
}

/** Save or update a recipe */
export function saveRecipe(recipe: Recipe): void {
    ensureRecipesDir();
    writeFileSync(join(RECIPES_DIR, `${recipe.id}.json`), JSON.stringify(recipe, null, 2), 'utf-8');
}

/** Delete a recipe by ID */
export function deleteRecipe(id: string): void {
    const path = join(RECIPES_DIR, `${id}.json`);
    if (existsSync(path)) unlinkSync(path);
}

/** Get a recipe by slash command (e.g. "code-review") */
export function findBySlashCommand(command: string): Recipe | null {
    // Normalize: compare slash-less on both sides so a stored '/foo' (any
    // future source) still resolves against parseSlashCommand's bare 'foo'.
    const bare = command.replace(/^\/+/, '');
    return listRecipes().find((r) => (r.slashCommand || '').replace(/^\/+/, '') === bare) || null;
}

/** Return built-in starter recipes */
export function getBuiltinRecipes(): Recipe[] {
    const now = new Date().toISOString();
    return [
        {
            id: 'code-review',
            name: 'Code Review',
            description: 'Review a file or snippet for bugs, issues, and improvements',
            slashCommand: 'code-review',
            parameters: {
                file: { description: 'Path to the file to review', required: false },
            },
            steps: [
                { prompt: 'Please do a thorough code review of {{file}}. Look for bugs, security issues, performance problems, and suggest improvements. Be direct and specific.' },
            ],
            author: 'Tony Elliott',
            tags: ['coding', 'review'],
            createdAt: now,
        },
        {
            id: 'daily-standup',
            name: 'Daily Standup',
            description: 'Summarise what you did yesterday and plan for today',
            slashCommand: 'standup',
            steps: [
                { prompt: 'Help me prepare my daily standup. Ask me what I worked on yesterday, what I\'m working on today, and whether I have any blockers. Then format it as a clean standup message I can copy.' },
            ],
            author: 'Tony Elliott',
            tags: ['productivity', 'work'],
            createdAt: now,
        },
        {
            id: 'explain-code',
            name: 'Explain Code',
            description: 'Explain what a piece of code does in plain English',
            slashCommand: 'explain',
            parameters: {
                file: { description: 'File or code snippet to explain', required: false },
            },
            steps: [
                { prompt: 'Please explain {{file}} in plain English. Break down what it does, how it works, and any important patterns or concepts. Assume I\'m a smart person but may not know this codebase.' },
            ],
            author: 'Tony Elliott',
            tags: ['coding', 'learning'],
            createdAt: now,
        },
        {
            id: 'brainstorm',
            name: 'Brainstorm',
            description: 'Brainstorm ideas on any topic',
            slashCommand: 'brainstorm',
            parameters: {
                topic: { description: 'Topic to brainstorm about', required: true },
            },
            steps: [
                { prompt: 'Let\'s brainstorm ideas about {{topic}}. Give me at least 10 creative, diverse ideas. Think outside the box and include some unconventional options. Then help me evaluate the best ones.' },
            ],
            author: 'Tony Elliott',
            tags: ['creativity', 'productivity'],
            createdAt: now,
        },
        {
            id: 'debug',
            name: 'Debug Issue',
            description: 'Help debug an error or unexpected behavior',
            slashCommand: 'debug',
            parameters: {
                error: { description: 'The error message or description of the problem', required: false },
            },
            steps: [
                { prompt: 'Help me debug this issue: {{error}}. Walk me through potential root causes, how to diagnose each one, and then provide a fix.' },
            ],
            author: 'Tony Elliott',
            tags: ['coding', 'debugging'],
            createdAt: now,
        },
        {
            id: 'morning-briefing',
            name: 'Morning Briefing',
            description: 'Get a personalised daily briefing — active projects, goals, monitors, and suggested tasks',
            slashCommand: 'briefing',
            steps: [
                {
                    prompt: 'Give me my morning briefing. Summarise: (1) my active projects and any recent progress, (2) my current goals and which are highest priority, (3) any active monitors that are watching for events, (4) suggested tasks I could work on today based on what I\'ve been doing, and (5) one motivational thought to start the day. Be concise and actionable.',
                },
            ],
            author: 'Tony Elliott',
            tags: ['productivity', 'daily', 'briefing'],
            createdAt: now,
        },
        // ── Research Pipeline Recipes (DeerFlow-inspired) ──────────
        {
            id: 'research',
            name: 'Deep Research',
            description: 'Research any topic with parallel agents and get a structured report',
            slashCommand: 'research',
            parameters: {
                topic: { description: 'The topic or question to research', required: true },
            },
            steps: [
                { prompt: 'Use the deep_research_pipeline tool to research: {{topic}}. Use standard depth with full report output.', tool: 'deep_research_pipeline' },
            ],
            author: 'Tony Elliott',
            tags: ['research', 'ai'],
            createdAt: now,
        },
        {
            id: 'market-analysis',
            name: 'Market Analysis',
            description: 'Analyze a market with competitive landscape and trends',
            slashCommand: 'market-analysis',
            parameters: {
                market: { description: 'The market or industry to analyze', required: true },
            },
            steps: [
                { prompt: 'Use the deep_research_pipeline tool to research: "Comprehensive market analysis of {{market}}: market size, growth trends, key players, competitive landscape, opportunities, and challenges in 2026". Use 4 sub-questions for thorough coverage.', tool: 'deep_research_pipeline' },
            ],
            author: 'Tony Elliott',
            tags: ['research', 'business'],
            createdAt: now,
        },
        {
            id: 'competitor-intel',
            name: 'Competitor Intelligence',
            description: 'Research a competitor with detailed analysis',
            slashCommand: 'competitor-intel',
            parameters: {
                company: { description: 'The company to research', required: true },
            },
            steps: [
                { prompt: 'Use the deep_research_pipeline tool to research: "Competitive intelligence report on {{company}}: products, pricing, market position, strengths, weaknesses, recent news, and strategic direction". Use 4 sub-questions.', tool: 'deep_research_pipeline' },
            ],
            author: 'Tony Elliott',
            tags: ['research', 'business'],
            createdAt: now,
        },
        {
            id: 'tech-report',
            name: 'Tech Deep Dive',
            description: 'Technical deep-dive report on a technology',
            slashCommand: 'tech-report',
            parameters: {
                technology: { description: 'The technology to research', required: true },
            },
            steps: [
                { prompt: 'Use the deep_research_pipeline tool to research: "Technical deep-dive on {{technology}}: architecture, capabilities, ecosystem, adoption, pros/cons, comparisons, and future outlook". Use deep depth.', tool: 'deep_research_pipeline' },
            ],
            author: 'Tony Elliott',
            tags: ['research', 'technology'],
            createdAt: now,
        },
        // ── Experiment Recipes (Autoresearch-inspired) ──────────────
        {
            id: 'experiment',
            name: 'Experiment Loop',
            description: 'Start an autonomous experiment loop to optimize something',
            slashCommand: 'experiment',
            parameters: {
                goal: { description: 'What to optimize', required: true },
            },
            steps: [
                { prompt: 'Help me set up an experiment loop. My goal is: {{goal}}. Ask me what file to modify, what command to run for evaluation, and what metric to measure. Then use the experiment_loop tool to start.', tool: 'experiment_loop' },
            ],
            author: 'Tony Elliott',
            tags: ['experimentation', 'optimization'],
            createdAt: now,
        },
        {
            id: 'optimize',
            name: 'Optimize',
            description: 'Iteratively optimize a file or configuration',
            slashCommand: 'optimize',
            parameters: {
                description: { description: 'What to optimize and how', required: true },
            },
            steps: [
                { prompt: 'I want to optimize: {{description}}. Identify the target file, determine an appropriate eval command and metric, then use the experiment_loop tool to run iterative optimization experiments.' },
            ],
            author: 'Tony Elliott',
            tags: ['experimentation', 'optimization'],
            createdAt: now,
        },
        {
            id: 'ab-test',
            name: 'A/B Test',
            description: 'A/B test different approaches with measured results',
            slashCommand: 'ab-test',
            parameters: {
                variants: { description: 'Description of the variants to test', required: true },
            },
            steps: [
                { prompt: 'I want to A/B test: {{variants}}. Help me set up a controlled experiment using the experiment_loop tool. Define clear metrics and run each variant systematically.' },
            ],
            author: 'Tony Elliott',
            tags: ['experimentation', 'testing'],
            createdAt: now,
        },
        // ── Web Automation Recipes ──────────────────────────────
        {
            id: 'fill-form',
            name: 'Fill Web Form',
            description: 'Fill a web form with your data — reads fields, fills, verifies, handles CAPTCHA',
            slashCommand: 'fill-form',
            parameters: {
                url: { description: 'URL of the form to fill', required: true },
                data: { description: 'JSON mapping field labels to values', required: true },
            },
            steps: [
                {
                    prompt: 'Use the smart_form_fill tool to fill the form at {{url}} with data: {{data}}. Set submit=true. If CAPTCHA is detected, tell me to complete it manually.',
                    tool: 'smart_form_fill',
                },
            ],
            author: 'Tony Elliott',
            tags: ['web', 'forms', 'automation'],
            createdAt: now,
        },
    ];
}

/** Seed builtin recipes if user has none */
export function seedBuiltinRecipes(): void {
    ensureRecipesDir();
    const existing = listRecipes();
    if (existing.length === 0) {
        for (const r of getBuiltinRecipes()) {
            saveRecipe(r);
        }
    }
}

/** Export a recipe to YAML format */
export function exportRecipeYaml(recipe: Recipe): string {
    const lines: string[] = [];
    lines.push(`# TITAN Workflow: ${recipe.name}`);
    lines.push(`id: ${recipe.id}`);
    lines.push(`name: "${recipe.name}"`);
    lines.push(`description: "${recipe.description}"`);
    if (recipe.slashCommand) lines.push(`slashCommand: ${recipe.slashCommand}`);
    if (recipe.author) lines.push(`author: "${recipe.author}"`);
    if (recipe.tags?.length) lines.push(`tags: [${recipe.tags.join(', ')}]`);

    if (recipe.parameters && Object.keys(recipe.parameters).length > 0) {
        lines.push('parameters:');
        for (const [key, param] of Object.entries(recipe.parameters)) {
            lines.push(`  ${key}:`);
            lines.push(`    description: "${param.description}"`);
            lines.push(`    required: ${param.required}`);
            if (param.default) lines.push(`    default: "${param.default}"`);
        }
    }

    lines.push('steps:');
    for (const step of recipe.steps) {
        lines.push(`  - prompt: "${step.prompt.replace(/"/g, '\\"')}"`);
        if (step.tool) lines.push(`    tool: ${step.tool}`);
        if (step.awaitConfirm) lines.push(`    awaitConfirm: true`);
    }

    return lines.join('\n') + '\n';
}

/** Import a recipe from simple YAML-like format */
export function importRecipeYaml(yaml: string): Recipe {
    const lines = yaml.split('\n').filter(l => !l.startsWith('#') && l.trim());
    const recipe: Partial<Recipe> = { steps: [], createdAt: new Date().toISOString() };

    let inSteps = false;
    let inParams = false;
    let currentStep: Partial<RecipeStep> = {};
    let currentParamKey = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('steps:')) { inSteps = true; inParams = false; continue; }
        if (trimmed.startsWith('parameters:')) { inParams = true; inSteps = false; recipe.parameters = {}; continue; }

        if (!inSteps && !inParams) {
            const [key, ...rest] = trimmed.split(':');
            const val = rest.join(':').trim().replace(/^["']|["']$/g, '');
            if (key === 'id') recipe.id = val;
            else if (key === 'name') recipe.name = val;
            else if (key === 'description') recipe.description = val;
            else if (key === 'slashCommand') recipe.slashCommand = val;
            else if (key === 'author') recipe.author = val;
            else if (key === 'tags') recipe.tags = val.replace(/[[\]]/g, '').split(',').map(t => t.trim());
        } else if (inParams) {
            if (line.match(/^\s{2}\w+:$/)) {
                currentParamKey = trimmed.replace(':', '');
                if (recipe.parameters) recipe.parameters[currentParamKey] = { description: '', required: false };
            } else if (currentParamKey && recipe.parameters) {
                const [k, ...v] = trimmed.split(':');
                const val = v.join(':').trim().replace(/^["']|["']$/g, '');
                if (k.trim() === 'description') recipe.parameters[currentParamKey].description = val;
                else if (k.trim() === 'required') recipe.parameters[currentParamKey].required = val === 'true';
                else if (k.trim() === 'default') recipe.parameters[currentParamKey].default = val;
            }
        } else if (inSteps) {
            if (trimmed.startsWith('- prompt:')) {
                if (currentStep.prompt) recipe.steps!.push(currentStep as RecipeStep);
                currentStep = { prompt: trimmed.replace(/^- prompt:\s*["']?/, '').replace(/["']$/, '') };
            } else if (trimmed.startsWith('tool:')) {
                currentStep.tool = trimmed.replace('tool:', '').trim();
            } else if (trimmed.startsWith('awaitConfirm:')) {
                currentStep.awaitConfirm = trimmed.includes('true');
            }
        }
    }
    if (currentStep.prompt) recipe.steps!.push(currentStep as RecipeStep);

    if (!recipe.id || !recipe.name || !recipe.steps?.length) {
        throw new Error('Invalid YAML: id, name, and at least one step are required');
    }

    return recipe as Recipe;
}
