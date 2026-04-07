/**
 * TITAN — Skill Scaffolding Tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock TITAN_HOME to temp dir — use vi.hoisted() to avoid hoisting issues
const { testHome } = vi.hoisted(() => {
    const { join } = require('path');
    const { tmpdir } = require('os');
    return { testHome: join(tmpdir(), `titan-test-${Date.now()}`) };
});
vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: testHome,
    TITAN_VERSION: '2026.9.1',
    TITAN_NAME: 'TITAN',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { scaffoldSkill } from '../src/skills/scaffold.js';

beforeEach(() => {
    mkdirSync(testHome, { recursive: true });
});

afterEach(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── JavaScript Scaffolding ──────────────────────────────────────
describe('Skill Scaffold — JavaScript', () => {
    it('should create a JS skill with all files', () => {
        const result = scaffoldSkill({
            name: 'my_tool',
            description: 'A test tool',
            author: 'Test Author',
            format: 'js',
        });

        expect(result.success).toBe(true);
        expect(result.files.length).toBe(3);
        expect(existsSync(join(result.skillDir, 'my_tool.js'))).toBe(true);
        expect(existsSync(join(result.skillDir, 'SKILL.md'))).toBe(true);
        expect(existsSync(join(result.skillDir, 'my_tool.test.ts'))).toBe(true);
    });

    it('should generate valid JS skill content', () => {
        const result = scaffoldSkill({
            name: 'hello',
            description: 'Says hello',
            author: 'Dev',
            format: 'js',
            parameters: [
                { name: 'name', type: 'string', description: 'Who to greet', required: true },
            ],
        });

        const content = readFileSync(join(result.skillDir, 'hello.js'), 'utf-8');
        expect(content).toContain("name: 'hello'");
        expect(content).toContain("description: 'Says hello'");
        expect(content).toContain('export default');
        expect(content).toContain("required: ['name']");
    });

    it('should sanitize skill names', () => {
        const result = scaffoldSkill({
            name: 'My Cool Tool!!',
            description: 'Test',
            author: 'Dev',
            format: 'js',
        });

        expect(result.success).toBe(true);
        expect(existsSync(join(result.skillDir, 'my_cool_tool.js'))).toBe(true);
    });
});

// ─── TypeScript Scaffolding ──────────────────────────────────────
describe('Skill Scaffold — TypeScript', () => {
    it('should create a TS skill with type annotations', () => {
        const result = scaffoldSkill({
            name: 'ts_tool',
            description: 'A TypeScript tool',
            author: 'TS Dev',
            format: 'ts',
        });

        expect(result.success).toBe(true);
        const content = readFileSync(join(result.skillDir, 'ts_tool.ts'), 'utf-8');
        expect(content).toContain('interface ToolHandler');
        expect(content).toContain('Promise<string>');
        expect(content).toContain('Record<string, unknown>');
    });
});

// ─── YAML Scaffolding ────────────────────────────────────────────
describe('Skill Scaffold — YAML', () => {
    it('should create a YAML skill definition', () => {
        const result = scaffoldSkill({
            name: 'yaml_tool',
            description: 'A YAML tool',
            author: 'YAML Dev',
            format: 'yaml',
        });

        expect(result.success).toBe(true);
        const content = readFileSync(join(result.skillDir, 'yaml_tool.yaml'), 'utf-8');
        expect(content).toContain('name: yaml_tool');
        expect(content).toContain('script: |');
    });
});

// ─── SKILL.md Metadata ──────────────────────────────────────────
describe('Skill Scaffold — SKILL.md', () => {
    it('should generate valid SKILL.md with frontmatter', () => {
        const result = scaffoldSkill({
            name: 'meta_tool',
            description: 'Metadata test',
            author: 'Meta Dev',
            format: 'js',
            category: 'utilities',
        });

        const md = readFileSync(join(result.skillDir, 'SKILL.md'), 'utf-8');
        expect(md).toContain('---');
        expect(md).toContain('name: meta_tool');
        expect(md).toContain('version: 1.0.0');
        expect(md).toContain('author: Meta Dev');
        expect(md).toContain('category: utilities');
    });
});

// ─── Error Handling ──────────────────────────────────────────────
describe('Skill Scaffold — Errors', () => {
    it('should fail if skill directory already exists', () => {
        scaffoldSkill({ name: 'dup', description: 'First', author: 'Dev', format: 'js' });
        const result = scaffoldSkill({ name: 'dup', description: 'Second', author: 'Dev', format: 'js' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('already exists');
    });
});

// ─── Custom Parameters ──────────────────────────────────────────
describe('Skill Scaffold — Custom Parameters', () => {
    it('should include multiple parameters', () => {
        const result = scaffoldSkill({
            name: 'multi_param',
            description: 'Multi-param tool',
            author: 'Dev',
            format: 'js',
            parameters: [
                { name: 'url', type: 'string', description: 'Target URL', required: true },
                { name: 'timeout', type: 'number', description: 'Timeout in ms', required: false },
                { name: 'verbose', type: 'boolean', description: 'Enable verbose', required: false },
            ],
        });

        const content = readFileSync(join(result.skillDir, 'multi_param.js'), 'utf-8');
        expect(content).toContain("url: { type: 'string'");
        expect(content).toContain("timeout: { type: 'number'");
        expect(content).toContain("verbose: { type: 'boolean'");
        expect(content).toContain("required: ['url']");
    });
});
