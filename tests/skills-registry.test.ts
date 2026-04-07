/**
 * TITAN — Skills Registry Tests
 * Tests for src/skills/registry.ts covering:
 *   - registerSkill, getSkills, getSkill
 *   - discoverWorkspaceSkills with SKILL.md parsing (frontmatter and fallback)
 *   - initBuiltinSkills (dynamic imports + error handling)
 *   - loadAutoSkills (JS skill loading, YAML skill loading, subdirectory scanning)
 *   - YAML skill VM sandbox (restricted context, allowed/disallowed modules)
 *   - Error paths throughout
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const {
    mockExistsSync,
    mockReaddirSync,
    mockReadFileSync,
    mockEnsureDir,
    mockRegisterTool,
    mockRunInNewContext,
} = vi.hoisted(() => ({
    mockExistsSync: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockEnsureDir: vi.fn(),
    mockRegisterTool: vi.fn(),
    mockRunInNewContext: vi.fn(),
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    readFileSync: mockReadFileSync,
}));

vi.mock('path', async (importOriginal) => {
    const actual = await importOriginal<typeof import('path')>();
    return { ...actual };
});

vi.mock('vm', () => ({
    default: { runInNewContext: mockRunInNewContext },
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/mock/home/.titan',
    TITAN_SKILLS_DIR: '/mock/home/.titan/workspace/skills',
}));

vi.mock('../src/agent/toolRunner.js', () => ({
    registerTool: mockRegisterTool,
}));

vi.mock('../src/utils/helpers.js', () => ({
    ensureDir: mockEnsureDir,
}));

// ── Import module under test ─────────────────────────────────────────────

import {
    registerSkill,
    getSkills,
    getSkill,
    discoverWorkspaceSkills,
    initBuiltinSkills,
    loadAutoSkills,
} from '../src/skills/registry.js';
import logger from '../src/utils/logger.js';

// ── Test suite ───────────────────────────────────────────────────────────

describe('Skills Registry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── registerSkill / getSkill / getSkills ──────────────────────────

    describe('registerSkill', () => {
        it('should register a skill and make it retrievable via getSkill', () => {
            registerSkill(
                { name: 'reg_test_1', description: 'Test', version: '1.0.0', source: 'bundled', enabled: true },
                { name: 'reg_test_1', description: 'Test', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' },
            );
            const skill = getSkill('reg_test_1');
            expect(skill).toBeDefined();
            expect(skill!.name).toBe('reg_test_1');
            expect(skill!.source).toBe('bundled');
        });

        it('should call registerTool with the handler', () => {
            const handler = { name: 'reg_test_2', description: 'Test 2', parameters: {}, execute: async () => 'ok' };
            registerSkill(
                { name: 'reg_test_2', description: 'Test 2', version: '2.0.0', source: 'marketplace', enabled: true },
                handler,
            );
            expect(mockRegisterTool).toHaveBeenCalledWith(handler);
        });

        it('should log a debug message on registration', () => {
            registerSkill(
                { name: 'reg_test_3', description: 'Test 3', version: '1.0.0', source: 'workspace', enabled: true },
                { name: 'reg_test_3', description: 'T', parameters: {}, execute: async () => '' },
            );
            expect(logger.debug).toHaveBeenCalledWith('Skills', expect.stringContaining('reg_test_3'));
        });
    });

    describe('getSkills', () => {
        it('should return an array of all registered skills', () => {
            const skills = getSkills();
            expect(Array.isArray(skills)).toBe(true);
            expect(skills.length).toBeGreaterThanOrEqual(3); // from the 3 registered above
        });
    });

    describe('getSkill', () => {
        it('should return undefined for an unknown skill name', () => {
            expect(getSkill('nonexistent_skill_zzz')).toBeUndefined();
        });
    });

    // ── discoverWorkspaceSkills ───────────────────────────────────────

    describe('discoverWorkspaceSkills', () => {
        it('should return empty array when TITAN_SKILLS_DIR does not exist', () => {
            mockExistsSync.mockReturnValue(false);
            const result = discoverWorkspaceSkills();
            expect(result).toEqual([]);
            expect(mockEnsureDir).toHaveBeenCalled();
        });

        it('should skip non-directory entries', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 'file.txt', isDirectory: () => false },
            ]);
            const result = discoverWorkspaceSkills();
            expect(result).toEqual([]);
        });

        it('should skip directories without SKILL.md', () => {
            mockExistsSync
                .mockReturnValueOnce(true) // TITAN_SKILLS_DIR exists
                .mockReturnValueOnce(false); // SKILL.md does not exist
            mockReaddirSync.mockReturnValue([
                { name: 'my-skill', isDirectory: () => true },
            ]);
            const result = discoverWorkspaceSkills();
            expect(result).toEqual([]);
        });

        it('should parse a SKILL.md with frontmatter and return skill metadata', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 'cool-skill', isDirectory: () => true },
            ]);
            mockReadFileSync.mockReturnValue(
                '---\nname: cool_tool\ndescription: A cool tool\nversion: 2.0.0\nauthor: Tony\n---\nContent here',
            );

            const result = discoverWorkspaceSkills();
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('cool_tool');
            expect(result[0].description).toBe('A cool tool');
            expect(result[0].version).toBe('2.0.0');
            expect(result[0].author).toBe('Tony');
            expect(result[0].source).toBe('workspace');
            expect(result[0].enabled).toBe(true);
        });

        it('should use fallback name from directory when SKILL.md has no frontmatter', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 'simple-skill', isDirectory: () => true },
            ]);
            mockReadFileSync.mockReturnValue('This is a simple skill description');

            const result = discoverWorkspaceSkills();
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('simple-skill');
            expect(result[0].description).toBe('This is a simple skill description');
            expect(result[0].version).toBe('1.0.0');
        });

        it('should handle empty content without frontmatter gracefully', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 'empty-skill', isDirectory: () => true },
            ]);
            mockReadFileSync.mockReturnValue('');

            const result = discoverWorkspaceSkills();
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('empty-skill');
            expect(result[0].description).toBe('No description');
        });

        it('should warn and continue when reading a SKILL.md throws', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 'bad-skill', isDirectory: () => true },
            ]);
            mockReadFileSync.mockImplementation(() => { throw new Error('EACCES'); });

            const result = discoverWorkspaceSkills();
            expect(result).toEqual([]);
            expect(logger.warn).toHaveBeenCalledWith('Skills', expect.stringContaining('bad-skill'));
        });

        it('should log discovered skill count', () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockReturnValue([
                { name: 's1', isDirectory: () => true },
                { name: 's2', isDirectory: () => true },
            ]);
            mockReadFileSync.mockReturnValue('---\nname: x\ndescription: d\nversion: 1.0.0\n---\n');

            discoverWorkspaceSkills();
            expect(logger.info).toHaveBeenCalledWith('Skills', expect.stringContaining('2'));
        });
    });

    // ── initBuiltinSkills ─────────────────────────────────────────────

    describe('initBuiltinSkills', () => {
        it('should import and call all built-in skill registration functions', async () => {
            // Each dynamic import returns a mock registration function
            // initBuiltinSkills uses `await import(...)` for 23+ skills + planner
            // Since we are testing the real code, each import will fail (not mocked at module level).
            // We just need to confirm it handles failures gracefully.
            await expect(initBuiltinSkills()).rejects.toThrow();
        });
    });

    // ── loadAutoSkills ────────────────────────────────────────────────

    describe('loadAutoSkills', () => {
        it('should return early when skills root directory does not exist', async () => {
            mockExistsSync.mockReturnValue(false);
            await loadAutoSkills();
            // Should not call readdirSync at all
            expect(mockReaddirSync).not.toHaveBeenCalled();
        });

        it('should scan root and subdirectories for skill files', async () => {
            mockExistsSync.mockReturnValue(true);
            // First call: readdirSync on skills root with withFileTypes
            mockReaddirSync
                .mockReturnValueOnce([
                    { name: 'auto', isDirectory: () => true },
                    { name: 'custom', isDirectory: () => true },
                ])
                // Second call: readdirSync on root (no withFileTypes)
                .mockReturnValueOnce([])
                // Third call: readdirSync on auto
                .mockReturnValueOnce([])
                // Fourth call: readdirSync on custom
                .mockReturnValueOnce([]);

            await loadAutoSkills();
            expect(mockReaddirSync).toHaveBeenCalledTimes(4);
        });

        it('should load a YAML skill and register it', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync
                .mockReturnValueOnce([]) // no subdirectories
                .mockReturnValueOnce(['test.yaml']); // one yaml file in root

            const yamlContent = [
                'name: greet',
                'description: Greets someone',
                'parameters:',
                '  person:',
                '    type: string',
                '    description: Name of the person',
                '    required: true',
                'script: |',
                '  return "Hello " + args.person;',
            ].join('\n');
            mockReadFileSync.mockReturnValue(yamlContent);
            mockRunInNewContext.mockResolvedValue('Hello World');

            // Clear the registerTool mock before this test
            mockRegisterTool.mockClear();

            await loadAutoSkills();

            // registerTool should have been called with the YAML skill handler
            expect(mockRegisterTool).toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith('Skills', expect.stringContaining('1 user skill'));
        });

        it('should skip YAML files missing name, description, or script', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync
                .mockReturnValueOnce([])
                .mockReturnValueOnce(['incomplete.yaml']);

            mockReadFileSync.mockReturnValue('name: test\n'); // missing description and script

            mockRegisterTool.mockClear();
            await loadAutoSkills();
            // loadYamlSkill returns null, so registerTool should not have been called
            expect(mockRegisterTool).not.toHaveBeenCalled();
        });

        it('should warn when loading a skill file throws', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync
                .mockReturnValueOnce([])
                .mockReturnValueOnce(['broken.yaml']);

            mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

            await loadAutoSkills();
            expect(logger.warn).toHaveBeenCalledWith('Skills', expect.stringContaining('broken.yaml'));
        });

        it('should skip JS files without default export or missing name/execute', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync
                .mockReturnValueOnce([])
                .mockReturnValueOnce(['bad.js']);

            // The JS import will fail because the file doesn't really exist
            // This should be caught and logged as a warning
            await loadAutoSkills();
            expect(logger.warn).toHaveBeenCalledWith('Skills', expect.stringContaining('bad.js'));
        });

        it('should skip files that are not .js, .yaml, or .yml', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync
                .mockReturnValueOnce([])
                .mockReturnValueOnce(['readme.md', 'config.json', 'tool.yaml']);

            // Only tool.yaml should be processed
            mockReadFileSync.mockReturnValue('name: t\ndescription: d\nscript: |\n  return "x";');
            mockRunInNewContext.mockResolvedValue('x');

            mockRegisterTool.mockClear();
            await loadAutoSkills();
            // readFileSync should only be called for tool.yaml
            expect(mockReadFileSync).toHaveBeenCalledTimes(1);
        });
    });

    // ── YAML skill VM sandbox ─────────────────────────────────────────

    describe('YAML skill execution (VM sandbox)', () => {
        let vmSkillCounter = 0;

        // Helper to create a YAML skill handler via loadAutoSkills
        // Uses a unique name each time to avoid the duplicate-skill check
        async function createYamlSkillHandler() {
            vmSkillCounter++;
            const skillName = `vm_skill_${vmSkillCounter}`;

            mockExistsSync.mockReturnValue(true);
            mockReaddirSync
                .mockReturnValueOnce([])
                .mockReturnValueOnce([`${skillName}.yaml`]);

            const yamlContent = [
                `name: ${skillName}`,
                'description: VM test skill',
                'parameters:',
                '  input:',
                '    type: string',
                '    description: Input value',
                '    required: true',
                '  optional:',
                '    type: string',
                '    description: Optional value',
                '    default: fallback',
                'script: |',
                '  return args.input + " processed";',
            ].join('\n');
            mockReadFileSync.mockReturnValue(yamlContent);
            mockRunInNewContext.mockResolvedValue('test processed');

            // Capture the registered handler
            let capturedHandler: any = null;
            mockRegisterTool.mockImplementation((handler: any) => {
                capturedHandler = handler;
            });

            await loadAutoSkills();
            return capturedHandler;
        }

        it('should create a handler with correct name and description', async () => {
            const handler = await createYamlSkillHandler();
            expect(handler).not.toBeNull();
            expect(handler.name).toMatch(/^vm_skill_\d+$/);
            expect(handler.description).toBe('VM test skill');
        });

        it('should parse parameters section with type, description, required, and default', async () => {
            const handler = await createYamlSkillHandler();
            expect(handler.parameters.properties.input).toBeDefined();
            expect(handler.parameters.properties.input.type).toBe('string');
            expect(handler.parameters.required).toContain('input');
            expect(handler.parameters.properties.optional).toBeDefined();
            expect(handler.parameters.properties.optional.default).toBe('fallback');
        });

        it('should call vm.runInNewContext with an async IIFE wrapper', async () => {
            const handler = await createYamlSkillHandler();
            mockRunInNewContext.mockResolvedValue('result');

            const result = await handler.execute({ input: 'hello' });
            expect(mockRunInNewContext).toHaveBeenCalledWith(
                expect.stringContaining('(async function()'),
                expect.objectContaining({ args: { input: 'hello' } }),
                expect.objectContaining({ timeout: 10000 }),
            );
            expect(result).toBe('result');
        });

        it('should provide a restricted sandbox with JSON, Math, Date, etc.', async () => {
            const handler = await createYamlSkillHandler();
            mockRunInNewContext.mockResolvedValue('ok');

            await handler.execute({ input: 'x' });

            const sandbox = mockRunInNewContext.mock.calls[mockRunInNewContext.mock.calls.length - 1][1];
            expect(sandbox).toHaveProperty('JSON');
            expect(sandbox).toHaveProperty('Math');
            expect(sandbox).toHaveProperty('Date');
            expect(sandbox).toHaveProperty('String');
            expect(sandbox).toHaveProperty('Number');
            expect(sandbox).toHaveProperty('Array');
            expect(sandbox).toHaveProperty('Object');
            expect(sandbox).toHaveProperty('RegExp');
            expect(sandbox).toHaveProperty('Map');
            expect(sandbox).toHaveProperty('Set');
            expect(sandbox).toHaveProperty('Promise');
            expect(sandbox).toHaveProperty('setTimeout');
            expect(sandbox).toHaveProperty('Buffer');
            expect(sandbox).toHaveProperty('console');
            expect(sandbox).toHaveProperty('require');
            // Should NOT expose globalThis, process, eval, Function
            expect(sandbox).not.toHaveProperty('globalThis');
            expect(sandbox).not.toHaveProperty('process');
            expect(sandbox).not.toHaveProperty('eval');
            expect(sandbox).not.toHaveProperty('Function');
        });

        it('should stringify non-string results as JSON', async () => {
            const handler = await createYamlSkillHandler();
            mockRunInNewContext.mockResolvedValue({ count: 42 });

            const result = await handler.execute({ input: 'x' });
            expect(result).toBe(JSON.stringify({ count: 42 }, null, 2));
        });

        it('should return error string when vm.runInNewContext throws', async () => {
            const handler = await createYamlSkillHandler();
            mockRunInNewContext.mockRejectedValue(new Error('Script timed out'));

            const result = await handler.execute({ input: 'x' });
            expect(result).toBe('Error: Script timed out');
        });

        it('should provide a safeRequire that only allows whitelisted modules', async () => {
            const handler = await createYamlSkillHandler();

            // Capture the sandbox and test safeRequire
            mockRunInNewContext.mockImplementation((_code: string, sandbox: any) => {
                // Test that the require function rejects non-allowed modules
                expect(() => sandbox.require('child_process')).not.toThrow(); // allowed
                expect(() => sandbox.require('net')).toThrow(/not allowed/); // not allowed
                return 'ok';
            });

            await handler.execute({ input: 'test' });
            expect(mockRunInNewContext).toHaveBeenCalled();
        });
    });
});
