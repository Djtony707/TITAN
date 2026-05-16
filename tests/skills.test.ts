/**
 * TITAN — Skills Module Tests
 * Tests skill registry and built-in skills
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: {
            model: 'anthropic/claude-sonnet-4-20250514',
            maxTokens: 8192,
            temperature: 0.7,
            modelAliases: {},
        },
        security: {
            shield: { enabled: true, mode: 'strict' },
            deniedTools: [],
            allowedTools: [],
            commandTimeout: 30000,
        },
        providers: {},
    }),
    updateConfig: vi.fn(),
    getDefaultConfig: vi.fn(),
    resetConfigCache: vi.fn(),
}));

// ─── Skills Registry Tests ─────────────────────────────────────────

import { registerSkill, getSkills, getSkill } from '../src/skills/registry.js';

describe('Skills Registry', () => {
    it('registerSkill should register a skill', () => {
        registerSkill(
            { name: 'test_skill_alpha', description: 'A test skill', version: '1.0.0', source: 'bundled', enabled: true },
            {
                name: 'test_skill_alpha',
                description: 'A test skill',
                parameters: { type: 'object', properties: {} },
                execute: async () => 'done',
            },
        );
        const skill = getSkill('test_skill_alpha');
        expect(skill).toBeDefined();
        expect(skill!.name).toBe('test_skill_alpha');
        expect(skill!.source).toBe('bundled');
    });

    it('getSkills should return all registered skills', () => {
        const skills = getSkills();
        expect(Array.isArray(skills)).toBe(true);
        expect(skills.length).toBeGreaterThan(0);
    });

    it('getSkill should return undefined for unknown skill', () => {
        expect(getSkill('unknown_skill_xyz')).toBeUndefined();
    });
});

// ─── Filesystem Skill Tests ─────────────────────────────────────────

describe('Filesystem Skill', () => {
    let fsSkillHandlers: Map<string, any>;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
            updateConfig: vi.fn(),
            getDefaultConfig: vi.fn(),
            resetConfigCache: vi.fn(),
        }));

        fsSkillHandlers = new Map();
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                fsSkillHandlers.set(handler.name, handler);
            }),
            getSkills: vi.fn().mockReturnValue([]),
            getSkill: vi.fn(),
        }));

        const { registerFilesystemSkill } = await import('../src/skills/builtin/filesystem.js');
        registerFilesystemSkill();
    });

    it('should register read_file, write_file, edit_file, and list_dir skills', () => {
        expect(fsSkillHandlers.has('read_file')).toBe(true);
        expect(fsSkillHandlers.has('write_file')).toBe(true);
        expect(fsSkillHandlers.has('edit_file')).toBe(true);
        expect(fsSkillHandlers.has('list_dir')).toBe(true);
    });

    it('read_file should return error for non-existent file', async () => {
        const handler = fsSkillHandlers.get('read_file');
        const result = await handler.execute({ path: '/tmp/titan-test-nonexistent-file-12345.txt' });
        expect(result).toContain('Error');
        expect(result).toContain('not found');
    });

    it('list_dir should return error for non-existent directory', async () => {
        const handler = fsSkillHandlers.get('list_dir');
        const result = await handler.execute({ path: '/tmp/titan-test-nonexistent-dir-12345' });
        expect(result).toContain('Error');
    });

    it('edit_file should return error for non-existent file', async () => {
        const handler = fsSkillHandlers.get('edit_file');
        const result = await handler.execute({
            path: '/tmp/titan-test-nonexistent-file-12345.txt',
            target: 'foo',
            replacement: 'bar',
        });
        expect(result).toContain('Error');
        expect(result).toContain('not found');
    });

    it('read_file should read an existing file', async () => {
        const { writeFileSync, existsSync, unlinkSync } = await import('fs');
        const testFile = '/tmp/titan-test-read-skill.txt';
        writeFileSync(testFile, 'Line 1\nLine 2\nLine 3\n', 'utf-8');
        try {
            const handler = fsSkillHandlers.get('read_file');
            const result = await handler.execute({ path: testFile });
            expect(result).toContain('Line 1');
            expect(result).toContain('Line 2');
            expect(result).toMatch(/[34] lines/);
        } finally {
            try { unlinkSync(testFile); } catch {}
        }
    });

    it('read_file should support startLine and endLine', async () => {
        const { writeFileSync, unlinkSync } = await import('fs');
        const testFile = '/tmp/titan-test-read-lines.txt';
        writeFileSync(testFile, 'A\nB\nC\nD\nE\n', 'utf-8');
        try {
            const handler = fsSkillHandlers.get('read_file');
            const result = await handler.execute({ path: testFile, startLine: 2, endLine: 4 });
            expect(result).toContain('B');
            expect(result).toContain('C');
            expect(result).toContain('D');
        } finally {
            try { unlinkSync(testFile); } catch {}
        }
    });

    it('write_file should create a file', async () => {
        const { existsSync, readFileSync, unlinkSync } = await import('fs');
        const testFile = '/tmp/titan-test-write-skill.txt';
        try {
            const handler = fsSkillHandlers.get('write_file');
            const result = await handler.execute({ path: testFile, content: 'Hello TITAN!' });
            expect(result).toContain('Successfully wrote');
            expect(readFileSync(testFile, 'utf-8')).toBe('Hello TITAN!');
        } finally {
            try { unlinkSync(testFile); } catch {}
        }
    });

    it('list_dir should list real directory contents', async () => {
        const handler = fsSkillHandlers.get('list_dir');
        const result = await handler.execute({ path: '/tmp' });
        expect(result).toContain('Directory: /tmp');
    });

    it('list_dir should recurse only when recursive is true', async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
        const { join } = await import('path');
        const testDir = mkdtempSync('/tmp/titan-list-dir-');
        const nestedDir = join(testDir, 'nested');
        mkdirSync(nestedDir);
        writeFileSync(join(testDir, 'root.txt'), 'root', 'utf-8');
        writeFileSync(join(nestedDir, 'child.txt'), 'child', 'utf-8');
        try {
            const handler = fsSkillHandlers.get('list_dir');
            const shallow = await handler.execute({ path: testDir });
            expect(shallow).toContain('root.txt');
            expect(shallow).toContain('nested/');
            expect(shallow).not.toContain('nested/child.txt');

            const recursive = await handler.execute({ path: testDir, recursive: true });
            expect(recursive).toContain('(recursive)');
            expect(recursive).toContain('nested/child.txt');
        } finally {
            try { rmSync(testDir, { recursive: true, force: true }); } catch {}
        }
    });
});

// ─── Model Switch Skill Tests ─────────────────────────────────────

describe('Model Switch Skill', () => {
    let switchHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192 },
            }),
            updateConfig: vi.fn(),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                switchHandler = handler;
            }),
        }));

        const { initModelSwitchTool } = await import('../src/skills/builtin/model_switch.js');
        initModelSwitchTool();
    });

    it('should register the switch_model handler', () => {
        expect(switchHandler).toBeDefined();
        expect(switchHandler.name).toBe('switch_model');
    });

    it('should switch model and return confirmation', async () => {
        const result = await switchHandler.execute({ model: 'openai/gpt-4o' });
        expect(result).toContain('openai/gpt-4o');
    });

    it('should include reason when provided', async () => {
        const result = await switchHandler.execute({
            model: 'openai/gpt-4o',
            reason: 'Need faster responses',
        });
        expect(result).toContain('openai/gpt-4o');
        expect(result).toContain('Need faster responses');
    });
});

// ─── Memory Skill Tests ────────────────────────────────────────────

describe('Memory Skill', () => {
    let memoryHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
            }),
        }));

        const memoriesStore: Array<{ category: string; key: string; value: string }> = [];

        vi.doMock('../src/memory/memory.js', () => ({
            rememberFact: vi.fn().mockImplementation((cat: string, key: string, value: string) => {
                const existing = memoriesStore.find(m => m.category === cat && m.key === key);
                if (existing) { existing.value = value; }
                else { memoriesStore.push({ category: cat, key, value }); }
            }),
            recallFact: vi.fn().mockImplementation((cat: string, key: string) => {
                const found = memoriesStore.find(m => m.category === cat && m.key === key);
                return found?.value || null;
            }),
            searchMemories: vi.fn().mockImplementation(async (cat?: string, query?: string) => {
                let results = [...memoriesStore];
                if (cat) results = results.filter(m => m.category === cat);
                if (query) {
                    const q = query.toLowerCase();
                    results = results.filter(m => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
                }
                return results;
            }),
        }));

        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                memoryHandler = handler;
            }),
        }));

        const { registerMemorySkill } = await import('../src/skills/builtin/memory_skill.js');
        registerMemorySkill();
    });

    it('should register the memory handler', () => {
        expect(memoryHandler).toBeDefined();
        expect(memoryHandler.name).toBe('memory');
    });

    it('should remember a fact and recall it', async () => {
        const remResult = await memoryHandler.execute({
            action: 'remember',
            category: 'preference',
            key: 'language',
            value: 'TypeScript',
        });
        expect(remResult).toContain('Remembered');

        const recResult = await memoryHandler.execute({
            action: 'recall',
            category: 'preference',
            key: 'language',
        });
        expect(recResult).toContain('TypeScript');
    });

    it('should return error when remember is missing key or value', async () => {
        const result = await memoryHandler.execute({ action: 'remember' });
        expect(result).toContain('Error');
    });

    it('should return error when recall is missing key', async () => {
        const result = await memoryHandler.execute({ action: 'recall' });
        expect(result).toContain('Error');
    });

    it('should handle no memory found on recall', async () => {
        const result = await memoryHandler.execute({
            action: 'recall',
            category: 'nonexistent',
            key: 'missing',
        });
        expect(result).toContain('No memory found');
    });

    it('should handle unknown action', async () => {
        const result = await memoryHandler.execute({ action: 'fly_to_moon' });
        expect(result).toContain('Unknown action');
    });

    it('should search memories', async () => {
        await memoryHandler.execute({ action: 'remember', key: 'lang', value: 'TypeScript' });
        const result = await memoryHandler.execute({ action: 'search', query: 'Type' });
        expect(result).toContain('TypeScript');
    });

    it('should list memories', async () => {
        await memoryHandler.execute({ action: 'remember', key: 'x', value: 'y' });
        const result = await memoryHandler.execute({ action: 'list' });
        expect(typeof result).toBe('string');
    });

    it('should handle list with no memories', async () => {
        vi.resetModules();
        vi.doMock('../src/memory/memory.js', () => ({
            rememberFact: vi.fn(),
            recallFact: vi.fn(),
            searchMemories: vi.fn().mockResolvedValue([]),
        }));
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        const { registerMemorySkill } = await import('../src/skills/builtin/memory_skill.js');
        registerMemorySkill();
        const result = await handler.execute({ action: 'list' });
        expect(result).toContain('No memories');
    });
});

// ─── Auto Generate Skill Tests ─────────────────────────────────────

describe('Auto Generate Skill', () => {
    let autoGenHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        vi.doMock('../src/agent/generator.js', () => ({
            generateAndInstallSkill: vi.fn().mockResolvedValue({ success: true, skillName: 'csv_parser' }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                autoGenHandler = handler;
            }),
        }));

        const { registerAutoGenerateSkill } = await import('../src/skills/builtin/auto_generate.js');
        registerAutoGenerateSkill();
    });

    it('should register the auto_generate_skill handler', () => {
        expect(autoGenHandler).toBeDefined();
        expect(autoGenHandler.name).toBe('auto_generate_skill');
    });

    it('should return success message on successful generation', async () => {
        const result = await autoGenHandler.execute({
            capability_description: 'Parse CSV files',
            suggested_name: 'csv_parser',
        });
        expect(result).toContain('SUCCESS');
        expect(result).toContain('csv_parser');
    });

    it('should return error when missing required args', async () => {
        const result = await autoGenHandler.execute({});
        expect(result).toContain('Error');
    });

    it('should handle generation failure', async () => {
        vi.resetModules();
        vi.doMock('../src/agent/generator.js', () => ({
            generateAndInstallSkill: vi.fn().mockResolvedValue({ success: false, error: 'Compilation failed' }),
        }));
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        let handler: any;
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_m: any, h: any) => { handler = h; }),
        }));
        const { registerAutoGenerateSkill } = await import('../src/skills/builtin/auto_generate.js');
        registerAutoGenerateSkill();
        const result = await handler.execute({
            capability_description: 'Do something impossible',
            suggested_name: 'impossible',
        });
        expect(result).toContain('Failed');
    });
});

// ─── Web Search Skill Tests ─────────────────────────────────────────

describe('Web Search Skill', () => {
    let webSearchHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({ security: { deniedTools: [], allowedTools: [] } }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                webSearchHandler = handler;
            }),
        }));

        const { registerWebSearchSkill } = await import('../src/skills/builtin/web_search.js');
        registerWebSearchSkill();
    });

    it('should register the web_search handler', () => {
        expect(webSearchHandler).toBeDefined();
        expect(webSearchHandler.name).toBe('web_search');
    });

    it('should have required parameters', () => {
        expect(webSearchHandler.parameters.properties.query).toBeDefined();
        expect(webSearchHandler.parameters.required).toContain('query');
    });
});
