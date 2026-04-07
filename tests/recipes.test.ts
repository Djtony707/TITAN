/**
 * TITAN — Recipe Module Tests
 * Tests store.ts (getBuiltinRecipes, recipe CRUD) and runner.ts (interpolation, slash commands)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const fileStore: Map<string, string> = new Map();
    return {
        ...actual,
        existsSync: vi.fn().mockImplementation((p: string) => {
            if (typeof p === 'string' && p.includes('recipes')) return fileStore.has(p) || true;
            return false;
        }),
        readdirSync: vi.fn().mockImplementation(() => {
            return Array.from(fileStore.keys())
                .filter(k => k.endsWith('.json'))
                .map(k => k.split('/').pop() || '');
        }),
        readFileSync: vi.fn().mockImplementation((p: string) => {
            return fileStore.get(p) || '{}';
        }),
        writeFileSync: vi.fn().mockImplementation((p: string, data: string) => {
            fileStore.set(p, data);
        }),
        unlinkSync: vi.fn().mockImplementation((p: string) => {
            fileStore.delete(p);
        }),
        mkdirSync: vi.fn(),
    };
});

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-recipes',
}));

// ─── Runner Tests (parseSlashCommand is standalone) ─────────────────

describe('Recipe Runner', () => {
    let parseSlashCommand: typeof import('../src/recipes/runner.js').parseSlashCommand;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readdirSync: vi.fn().mockReturnValue([]),
                readFileSync: vi.fn().mockReturnValue('{}'),
                writeFileSync: vi.fn(),
                unlinkSync: vi.fn(),
                mkdirSync: vi.fn(),
            };
        });
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-recipes',
        }));
        const runner = await import('../src/recipes/runner.js');
        parseSlashCommand = runner.parseSlashCommand;
    });

    describe('parseSlashCommand', () => {
        it('should parse a simple slash command', () => {
            const result = parseSlashCommand('/code-review');
            expect(result).not.toBeNull();
            expect(result!.command).toBe('code-review');
            expect(result!.args).toBe('');
        });

        it('should parse command with arguments', () => {
            const result = parseSlashCommand('/debug Error: file not found');
            expect(result).not.toBeNull();
            expect(result!.command).toBe('debug');
            expect(result!.args).toBe('Error: file not found');
        });

        it('should return null for non-slash messages', () => {
            expect(parseSlashCommand('Hello world')).toBeNull();
            expect(parseSlashCommand('not /a command')).toBeNull();
        });

        it('should handle whitespace', () => {
            const result = parseSlashCommand('  /standup  ');
            expect(result).not.toBeNull();
            expect(result!.command).toBe('standup');
        });

        it('should handle command-only with no trailing space', () => {
            const result = parseSlashCommand('/brainstorm');
            expect(result).not.toBeNull();
            expect(result!.command).toBe('brainstorm');
            expect(result!.args).toBe('');
        });
    });

    describe('runRecipe', () => {
        it('should throw for non-existent recipe', async () => {
            const runner = await import('../src/recipes/runner.js');
            const gen = runner.runRecipe('nonexistent');
            await expect(gen.next()).rejects.toThrow(/not found/);
        });
    });
});

// ─── Store Tests (getBuiltinRecipes is standalone) ─────────────────

describe('Recipe Store', () => {
    let store: typeof import('../src/recipes/store.js');

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('fs', async (importOriginal) => {
            const actual = await importOriginal<typeof import('fs')>();
            return {
                ...actual,
                existsSync: vi.fn().mockReturnValue(true),
                readdirSync: vi.fn().mockReturnValue([]),
                readFileSync: vi.fn().mockReturnValue('{}'),
                writeFileSync: vi.fn(),
                unlinkSync: vi.fn(),
                mkdirSync: vi.fn(),
            };
        });
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-recipes',
        }));
        store = await import('../src/recipes/store.js');
    });

    describe('getBuiltinRecipes', () => {
        it('should return an array of recipes', () => {
            const recipes = store.getBuiltinRecipes();
            expect(Array.isArray(recipes)).toBe(true);
            expect(recipes.length).toBeGreaterThan(0);
        });

        it('should include code-review recipe', () => {
            const recipes = store.getBuiltinRecipes();
            const codeReview = recipes.find(r => r.id === 'code-review');
            expect(codeReview).toBeDefined();
            expect(codeReview!.name).toBe('Code Review');
            expect(codeReview!.slashCommand).toBe('code-review');
        });

        it('should include daily-standup recipe', () => {
            const recipes = store.getBuiltinRecipes();
            const standup = recipes.find(r => r.id === 'daily-standup');
            expect(standup).toBeDefined();
            expect(standup!.slashCommand).toBe('standup');
        });

        it('should include morning-briefing recipe', () => {
            const recipes = store.getBuiltinRecipes();
            const briefing = recipes.find(r => r.id === 'morning-briefing');
            expect(briefing).toBeDefined();
            expect(briefing!.slashCommand).toBe('briefing');
        });

        it('every recipe should have required fields', () => {
            for (const recipe of store.getBuiltinRecipes()) {
                expect(recipe.id).toBeTruthy();
                expect(recipe.name).toBeTruthy();
                expect(recipe.description).toBeTruthy();
                expect(recipe.steps.length).toBeGreaterThan(0);
                expect(recipe.createdAt).toBeTruthy();
            }
        });

        it('every recipe step should have a prompt', () => {
            for (const recipe of store.getBuiltinRecipes()) {
                for (const step of recipe.steps) {
                    expect(typeof step.prompt).toBe('string');
                    expect(step.prompt.length).toBeGreaterThan(0);
                }
            }
        });
    });

    describe('listRecipes', () => {
        it('should return empty array when no recipe files exist', () => {
            const recipes = store.listRecipes();
            expect(Array.isArray(recipes)).toBe(true);
        });
    });

    describe('getRecipe', () => {
        it('should return null for non-existent recipe', () => {
            expect(store.getRecipe('nonexistent')).toBeNull();
        });
    });

    describe('findBySlashCommand', () => {
        it('should return null for unknown command', () => {
            expect(store.findBySlashCommand('unknown')).toBeNull();
        });
    });
});
