/**
 * TITAN — Visual Workflow Builder Tests
 * Tests recipe YAML export/import and workflow API validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const { testHome } = vi.hoisted(() => {
    const { join } = require('path');
    const { tmpdir } = require('os');
    return { testHome: join(tmpdir(), `titan-test-wf-${Date.now()}`) };
});

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: testHome,
    TITAN_VERSION: '2026.9.4',
    TITAN_NAME: 'TITAN',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
    listRecipes, getRecipe, saveRecipe, deleteRecipe, getBuiltinRecipes,
    seedBuiltinRecipes, exportRecipeYaml, importRecipeYaml,
} from '../src/recipes/store.js';
import type { Recipe } from '../src/recipes/types.js';

beforeEach(() => {
    mkdirSync(join(testHome, 'recipes'), { recursive: true });
});

afterEach(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── YAML Export ─────────────────────────────────────────────
describe('Recipe YAML Export', () => {
    it('should export a simple recipe to YAML', () => {
        const recipe: Recipe = {
            id: 'test-export',
            name: 'Test Export',
            description: 'A test recipe',
            slashCommand: 'test',
            author: 'Dev',
            tags: ['test', 'ci'],
            steps: [{ prompt: 'Do something' }],
            createdAt: '2026-01-01T00:00:00Z',
        };

        const yaml = exportRecipeYaml(recipe);
        expect(yaml).toContain('id: test-export');
        expect(yaml).toContain('name: "Test Export"');
        expect(yaml).toContain('description: "A test recipe"');
        expect(yaml).toContain('slashCommand: test');
        expect(yaml).toContain('author: "Dev"');
        expect(yaml).toContain('tags: [test, ci]');
        expect(yaml).toContain('steps:');
        expect(yaml).toContain('- prompt: "Do something"');
    });

    it('should export parameters', () => {
        const recipe: Recipe = {
            id: 'param-test',
            name: 'Param Test',
            description: 'Has params',
            parameters: {
                file: { description: 'File path', required: true },
                verbose: { description: 'Enable verbose', required: false, default: 'false' },
            },
            steps: [{ prompt: 'Review {{file}}' }],
            createdAt: '2026-01-01T00:00:00Z',
        };

        const yaml = exportRecipeYaml(recipe);
        expect(yaml).toContain('parameters:');
        expect(yaml).toContain('  file:');
        expect(yaml).toContain('    description: "File path"');
        expect(yaml).toContain('    required: true');
        expect(yaml).toContain('  verbose:');
        expect(yaml).toContain('    default: "false"');
    });

    it('should export multi-step recipes', () => {
        const recipe: Recipe = {
            id: 'multi',
            name: 'Multi Step',
            description: 'Multiple steps',
            steps: [
                { prompt: 'Step 1' },
                { prompt: 'Step 2', tool: 'shell' },
                { prompt: 'Step 3', awaitConfirm: true },
            ],
            createdAt: '2026-01-01T00:00:00Z',
        };

        const yaml = exportRecipeYaml(recipe);
        expect(yaml).toContain('- prompt: "Step 1"');
        expect(yaml).toContain('- prompt: "Step 2"');
        expect(yaml).toContain('    tool: shell');
        expect(yaml).toContain('    awaitConfirm: true');
    });
});

// ─── YAML Import ─────────────────────────────────────────────
describe('Recipe YAML Import', () => {
    it('should import a simple YAML recipe', () => {
        const yaml = `# TITAN Workflow
id: imported
name: "Imported Recipe"
description: "From YAML"
slashCommand: imported
steps:
  - prompt: "Hello world"
  - prompt: "Second step"
`;
        const recipe = importRecipeYaml(yaml);
        expect(recipe.id).toBe('imported');
        expect(recipe.name).toBe('Imported Recipe');
        expect(recipe.description).toBe('From YAML');
        expect(recipe.slashCommand).toBe('imported');
        expect(recipe.steps).toHaveLength(2);
        expect(recipe.steps[0].prompt).toBe('Hello world');
        expect(recipe.steps[1].prompt).toBe('Second step');
    });

    it('should import with parameters', () => {
        const yaml = `id: param-import
name: "Param Import"
description: "Has params"
parameters:
  url:
    description: "Target URL"
    required: true
  timeout:
    description: "Timeout in ms"
    required: false
    default: "5000"
steps:
  - prompt: "Fetch {{url}}"
`;
        const recipe = importRecipeYaml(yaml);
        expect(recipe.parameters).toBeDefined();
        expect(recipe.parameters!.url.description).toBe('Target URL');
        expect(recipe.parameters!.url.required).toBe(true);
        expect(recipe.parameters!.timeout.default).toBe('5000');
    });

    it('should import with tags', () => {
        const yaml = `id: tags-test
name: "Tags Test"
description: "Has tags"
tags: [coding, review, test]
steps:
  - prompt: "Do it"
`;
        const recipe = importRecipeYaml(yaml);
        expect(recipe.tags).toEqual(['coding', 'review', 'test']);
    });

    it('should reject invalid YAML (missing required fields)', () => {
        expect(() => importRecipeYaml('name: "No ID"')).toThrow('Invalid YAML');
        expect(() => importRecipeYaml('id: no-steps\nname: "No Steps"')).toThrow('Invalid YAML');
    });

    it('should roundtrip export → import', () => {
        const original: Recipe = {
            id: 'roundtrip',
            name: 'Roundtrip Test',
            description: 'Test roundtrip',
            slashCommand: 'rt',
            author: 'Dev',
            tags: ['test'],
            steps: [
                { prompt: 'Step one' },
                { prompt: 'Step two' },
            ],
            createdAt: '2026-01-01T00:00:00Z',
        };

        const yaml = exportRecipeYaml(original);
        const imported = importRecipeYaml(yaml);

        expect(imported.id).toBe(original.id);
        expect(imported.name).toBe(original.name);
        expect(imported.description).toBe(original.description);
        expect(imported.slashCommand).toBe(original.slashCommand);
        expect(imported.steps).toHaveLength(2);
        expect(imported.steps[0].prompt).toBe('Step one');
    });
});

// ─── Workflow Store Integration ──────────────────────────────
describe('Workflow Store', () => {
    it('should save and retrieve a workflow', () => {
        const recipe: Recipe = {
            id: 'wf-test',
            name: 'Workflow Test',
            description: 'Test',
            steps: [{ prompt: 'Hello' }],
            createdAt: new Date().toISOString(),
        };
        saveRecipe(recipe);
        expect(getRecipe('wf-test')).not.toBeNull();
        expect(getRecipe('wf-test')!.name).toBe('Workflow Test');
    });

    it('should list all workflows', () => {
        saveRecipe({ id: 'wf-a', name: 'A', description: '', steps: [{ prompt: 'a' }], createdAt: '' });
        saveRecipe({ id: 'wf-b', name: 'B', description: '', steps: [{ prompt: 'b' }], createdAt: '' });
        expect(listRecipes().length).toBe(2);
    });

    it('should delete a workflow', () => {
        saveRecipe({ id: 'wf-del', name: 'Del', description: '', steps: [{ prompt: 'x' }], createdAt: '' });
        deleteRecipe('wf-del');
        expect(getRecipe('wf-del')).toBeNull();
    });

    it('should seed builtin recipes', () => {
        seedBuiltinRecipes();
        const builtins = getBuiltinRecipes();
        const stored = listRecipes();
        expect(stored.length).toBe(builtins.length);
    });
});
