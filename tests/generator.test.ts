/**
 * TITAN — Skill Auto-Generation Engine Tests
 * Tests generateAndInstallSkill: LLM code generation, safety checks,
 * compilation, skill registry reload, and all error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

const {
    mockChat, mockLoadConfig, mockLoadAutoSkills, mockGetSkill,
    mockExistsSync, mockWriteFileSync, mockMkdirSync,
    mockExecFileSync,
} = vi.hoisted(() => ({
    mockChat: vi.fn(),
    mockLoadConfig: vi.fn(),
    mockLoadAutoSkills: vi.fn(),
    mockGetSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockExecFileSync: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-generator',
    TITAN_VERSION: '2026.5.2',
}));

vi.mock('../src/providers/router.js', () => ({
    chat: mockChat,
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: mockLoadConfig,
}));

vi.mock('../src/skills/registry.js', () => ({
    loadAutoSkills: mockLoadAutoSkills,
    getSkill: mockGetSkill,
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: (...args: any[]) => mockExistsSync(...args),
        writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
        mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    };
});

vi.mock('child_process', () => ({
    execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

import { generateAndInstallSkill } from '../src/agent/generator.js';
import logger from '../src/utils/logger.js';

// ── Test Suite ────────────────────────────────────────────────────────────

describe('Skill Auto-Generation Engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset all hoisted mocks to clear implementations from previous tests
        mockChat.mockReset();
        mockLoadConfig.mockReset();
        mockLoadAutoSkills.mockReset();
        mockGetSkill.mockReset();
        mockExistsSync.mockReset();
        mockWriteFileSync.mockReset();
        mockMkdirSync.mockReset();
        mockExecFileSync.mockReset();
        mockLoadConfig.mockReturnValue({
            agent: { model: 'anthropic/claude-sonnet-4-20250514' },
        });
        // By default, getSkill returns a truthy object (skill registered successfully)
        mockGetSkill.mockReturnValue({ name: 'mock_skill', execute: vi.fn() });
    });

    describe('generateAndInstallSkill — successful generation', () => {
        it('should generate, compile, and install a skill successfully', async () => {
            const generatedCode = `
import fs from 'fs';

export default {
    name: "count_lines",
    description: "Counts lines in a file",
    parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
    execute: async (args, config) => {
        const content = fs.readFileSync(args.filePath, 'utf-8');
        return \`File has \${content.split('\\n').length} lines.\`;
    }
};`;

            mockChat.mockResolvedValueOnce({ content: generatedCode });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('auto')) return true; // auto dir exists
                if (p.endsWith('.js')) return true;  // compiled JS exists
                return false;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            const result = await generateAndInstallSkill('Count lines in a file', 'count_lines');

            expect(result.success).toBe(true);
            expect(result.skillName).toBe('count_lines');
            expect(result.filePath).toContain('count_lines.ts');
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('count_lines.ts'),
                expect.stringContaining('count_lines'),
                'utf-8'
            );
            expect(mockExecFileSync).toHaveBeenCalledWith(
                'npx',
                expect.arrayContaining(['tsc']),
                expect.any(Object)
            );
            expect(mockLoadAutoSkills).toHaveBeenCalled();
        });

        it('should create auto skills directory if it does not exist', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "test_skill", description: "test", parameters: {}, execute: async () => "ok" };' });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('auto')) return false;
                if (p.endsWith('.js')) return true;
                return false;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            await generateAndInstallSkill('A test skill', 'test_skill');

            expect(mockMkdirSync).toHaveBeenCalledWith(
                expect.stringContaining('auto'),
                { recursive: true }
            );
        });

        it('should strip markdown typescript code blocks from LLM response', async () => {
            const codeWithBlocks = '```typescript\nexport default { name: "clean_skill", description: "test", parameters: {}, execute: async () => "ok" };\n```';

            mockChat.mockResolvedValueOnce({ content: codeWithBlocks });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('.js')) return true;
                return true;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            const result = await generateAndInstallSkill('A clean skill', 'clean_skill');

            expect(result.success).toBe(true);
            // Should have stripped the code block markers
            const writtenCode = mockWriteFileSync.mock.calls[0][1];
            expect(writtenCode).not.toContain('```typescript');
            expect(writtenCode).not.toContain('```');
        });

        it('should strip generic markdown code blocks from LLM response', async () => {
            const codeWithBlocks = '```\nexport default { name: "generic_skill", description: "test", parameters: {}, execute: async () => "ok" };\n```';

            mockChat.mockResolvedValueOnce({ content: codeWithBlocks });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('.js')) return true;
                return true;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            const result = await generateAndInstallSkill('A generic skill', 'generic_skill');

            expect(result.success).toBe(true);
            const writtenCode = mockWriteFileSync.mock.calls[0][1];
            expect(writtenCode).not.toContain('```');
        });

        it('should extract skill name from generated code', async () => {
            const code = 'export default { name: "extracted_name", description: "test", parameters: {}, execute: async () => "ok" };';
            mockChat.mockResolvedValueOnce({ content: code });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('.js')) return true;
                return true;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            const result = await generateAndInstallSkill('Extract name test', 'fallback_name');

            expect(result.skillName).toBe('extracted_name');
        });

        it('should fall back to sanitized requestedName when code has no name match', async () => {
            const code = 'export default { description: "test", parameters: {}, execute: async () => "ok" };';
            mockChat.mockResolvedValueOnce({ content: code });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('.js')) return true;
                return true;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            const result = await generateAndInstallSkill('Test', 'my-special-skill!');

            expect(result.skillName).toBe('my_special_skill_');
        });
    });

    describe('generateAndInstallSkill — safety checks', () => {
        it('should reject code containing process.exit', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "evil", execute: async () => { process.exit(1); } };' });
            mockExistsSync.mockReturnValue(true);

            const result = await generateAndInstallSkill('Evil skill', 'evil');

            expect(result.success).toBe(false);
            expect(result.error).toContain('safety static analysis');
        });

        it('should reject code containing rm -rf /*', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "nuke", execute: async () => { exec("rm -rf /*"); } };' });
            mockExistsSync.mockReturnValue(true);

            const result = await generateAndInstallSkill('Nuke', 'nuke');

            expect(result.success).toBe(false);
            expect(result.error).toContain('safety static analysis');
        });

        it('should reject code containing fs.rmSync root', async () => {
            mockChat.mockResolvedValueOnce({ content: "export default { name: \"del\", execute: async () => { fs.rmSync('/'); } };" });
            mockExistsSync.mockReturnValue(true);

            const result = await generateAndInstallSkill('Delete root', 'del');

            expect(result.success).toBe(false);
            expect(result.error).toContain('safety static analysis');
        });
    });

    describe('generateAndInstallSkill — error paths', () => {
        it('should handle LLM chat failure', async () => {
            mockChat.mockRejectedValueOnce(new Error('API rate limit exceeded'));
            mockExistsSync.mockReturnValue(true);

            const result = await generateAndInstallSkill('Fail skill', 'fail_skill');

            expect(result.success).toBe(false);
            expect(result.error).toContain('API rate limit exceeded');
            expect(logger.error).toHaveBeenCalledWith('SkillGenerator', expect.stringContaining('Auto-generation failed'));
        });

        it('should handle compilation failure', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "bad_syntax", execute: async () => "ok" };' });
            mockExistsSync.mockReturnValue(true);
            mockExecFileSync.mockImplementation(() => { throw new Error('TS2345: Argument of type...'); });

            const result = await generateAndInstallSkill('Bad syntax', 'bad_syntax');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Compilation failed');
        });

        it('should handle compilation that does not produce .js file', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "no_js", execute: async () => "ok" };' });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('auto')) return true;
                if (p.endsWith('.js')) return false; // No .js output
                return false;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));

            const result = await generateAndInstallSkill('No JS output', 'no_js');

            expect(result.success).toBe(false);
            expect(result.error).toContain('did not produce a .js file');
        });

        it('should handle loadAutoSkills failure', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "reg_fail", execute: async () => "ok" };' });
            mockExistsSync.mockImplementation((p: string) => {
                if (p.endsWith('.js')) return true;
                return true;
            });
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockRejectedValueOnce(new Error('Registry error'));

            const result = await generateAndInstallSkill('Registry fail', 'reg_fail');

            // The error is caught at the outer try/catch
            expect(result.success).toBe(false);
            expect(result.error).toContain('Registry error');
        });

        it('should handle writeFileSync failure', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "write_fail", execute: async () => "ok" };' });
            mockExistsSync.mockReturnValue(true);
            mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

            const result = await generateAndInstallSkill('Write fail', 'write_fail');

            expect(result.success).toBe(false);
            expect(result.error).toContain('EACCES');
        });

        it('should handle non-Error thrown by chat', async () => {
            mockChat.mockRejectedValueOnce('string error');
            mockExistsSync.mockReturnValue(true);

            const result = await generateAndInstallSkill('String error', 'string_err');

            expect(result.success).toBe(false);
            expect(result.error).toBe('string error');
        });
    });

    describe('generateAndInstallSkill — logging', () => {
        it('should log skill generation start', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "log_test", execute: async () => "ok" };' });
            mockExistsSync.mockImplementation((p: string) => p.endsWith('.js') || p.endsWith('auto'));
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            await generateAndInstallSkill('Log test', 'log_test');

            expect(logger.info).toHaveBeenCalledWith(
                'SkillGenerator',
                expect.stringContaining('Initiating auto-generation for skill: "log_test"')
            );
        });

        it('should log successful installation', async () => {
            mockChat.mockResolvedValueOnce({ content: 'export default { name: "success_log", execute: async () => "ok" };' });
            mockExistsSync.mockImplementation((p: string) => p.endsWith('.js') || p.endsWith('auto'));
            mockExecFileSync.mockReturnValue(Buffer.from(''));
            mockLoadAutoSkills.mockResolvedValue(undefined);

            const result = await generateAndInstallSkill('Success log', 'success_log');

            expect(result.success).toBe(true);
            // On success, logger.info is called multiple times
            // Check that the success message was logged somewhere in all info calls
            const infoCalls = (logger.info as any).mock.calls.map((c: any[]) => c.join(' '));
            expect(infoCalls.some((c: string) => c.includes('Successfully generated'))).toBe(true);
        });
    });
});
