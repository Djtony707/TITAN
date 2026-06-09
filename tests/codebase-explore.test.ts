import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exploreCodebase, formatCodebaseMap } from '../src/skills/builtin/codebase_explore.js';

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'titan-explore-'));
    // A fake project: TS entrypoint, a Python file, README, manifest, plus a
    // node_modules dir that MUST be skipped.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', main: 'dist/index.js', scripts: { start: 'node dist/cli.js' } }));
    writeFileSync(join(root, 'README.md'), '# Demo');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(root, 'src', 'util.ts'), 'export const y = 2;');
    writeFileSync(join(root, 'src', 'script.py'), 'print(1)');
    mkdirSync(join(root, 'node_modules', 'leftpad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 0;');
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* fine */ } });

describe('exploreCodebase', () => {
    it('counts source files but SKIPS node_modules', () => {
        const m = exploreCodebase(root);
        // package.json, README.md, tsconfig.json, src/index.ts, src/util.ts, src/script.py = 6
        expect(m.fileCount).toBe(6);
        // the node_modules/leftpad/index.js must NOT be counted
        expect(m.fileCount).toBeLessThan(7);
    });

    it('classifies languages by extension', () => {
        const m = exploreCodebase(root);
        expect(m.languages.TypeScript).toBe(2);
        expect(m.languages.Python).toBe(1);
        expect(m.languages.Markdown).toBe(1);
    });

    it('resolves entrypoints from package.json main/start + conventions', () => {
        const m = exploreCodebase(root);
        expect(m.entrypoints).toContain('dist/index.js'); // from main
        expect(m.entrypoints).toContain('dist/cli.js');   // from start script
        expect(m.entrypoints).toContain('src/index.ts');  // conventional
    });

    it('flags key project-shape files', () => {
        const m = exploreCodebase(root);
        const kinds = m.keyFiles.map((k) => k.kind);
        expect(kinds).toContain('Node manifest');
        expect(kinds).toContain('README');
        expect(kinds).toContain('TS config');
    });

    it('ranks top source dirs', () => {
        const m = exploreCodebase(root);
        expect(m.topDirs[0]).toMatchObject({ dir: 'src', files: 3 });
    });

    it('respects maxDepth (deeply nested files excluded)', () => {
        const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
        mkdirSync(deep, { recursive: true });
        writeFileSync(join(deep, 'deep.ts'), 'export const z = 3;');
        const shallow = exploreCodebase(root, { maxDepth: 2 });
        const full = exploreCodebase(root, { maxDepth: 10 });
        expect(full.fileCount).toBeGreaterThan(shallow.fileCount);
    });
});

describe('formatCodebaseMap', () => {
    it('renders a readable report', () => {
        const out = formatCodebaseMap(exploreCodebase(root));
        expect(out).toMatch(/# Codebase map/);
        expect(out).toContain('Languages:');
        expect(out).toContain('Entrypoints:');
        expect(out).toContain('Key files:');
    });
});
