import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync as realExecFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { transformSync } from 'esbuild';
import { confinedFileWorker, runConfinedFileOperation } from '../src/security/confinedFiles.js';

let fixture: string;
let root: string;
let outside: string;
const dataBase64 = Buffer.from('authorized data').toString('base64');
const anchorOf = (path: string) => {
    const stat = fs.statSync(path, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
};
beforeEach(() => {
    fixture = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'titan-anchored-files-')));
    root = join(fixture, 'root');outside = join(fixture, 'outside');
    fs.mkdirSync(root);fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'secret.txt'), 'outside sentinel');
});
afterEach(() => { vi.doUnmock('child_process');vi.resetModules();fs.rmSync(fixture, { recursive: true, force: true }); });

// Deterministic worker tests inject only filesystem scheduling, never network-selected code.
// They run synchronously and restore cwd before any assertion or async work.
function withWorker(operation: Parameters<typeof confinedFileWorker>[0], overrides: Partial<NonNullable<Parameters<typeof confinedFileWorker>[1]>> = {}) {
    const cwd = process.cwd();
    try {
        process.chdir(root);
        return confinedFileWorker(operation, { fs, platform: process.platform, chdir: path => process.chdir(path), ...overrides });
    } finally { process.chdir(cwd); }
}

describe('anchored Node file worker', () => {
    it('uses a real child with verified returned identity and preserves the parent cwd', () => {
        const cwd = process.cwd();
        expect(runConfinedFileOperation(root, { operation: 'write', path: 'nested/file.txt', dataBase64 })).toMatchObject({ ok: true, anchor: anchorOf(root) });
        const result = runConfinedFileOperation(root, { operation: 'read', path: 'nested/file.txt' });
        expect(result).toMatchObject({ ok: true, dataBase64, anchor: anchorOf(root), truncated: false });
        expect(process.cwd()).toBe(cwd);
        expect(runConfinedFileOperation(root, { operation: 'list', path: '' }).entries?.map(entry => entry.name)).toEqual(['nested']);
        expect(runConfinedFileOperation(root, { operation: 'rename', path: 'nested/file.txt', newPath: 'nested/renamed.txt' }).ok).toBe(true);
        expect(runConfinedFileOperation(root, { operation: 'rename', path: 'nested/renamed.txt', newPath: 'moved.txt' })).toMatchObject({ ok: false, status: 403, error: expect.stringContaining('Cross-directory') });
        expect(fs.readFileSync(join(root, 'nested', 'renamed.txt'), 'utf8')).toBe('authorized data');
        expect(runConfinedFileOperation(root, { operation: 'delete', path: 'nested' })).toMatchObject({ ok: false, status: 400 });
        expect(runConfinedFileOperation(root, { operation: 'delete', path: 'nested/renamed.txt' }).ok).toBe(true);
        expect(runConfinedFileOperation(root, { operation: 'delete', path: 'nested' }).ok).toBe(true);
        expect(runConfinedFileOperation(root, { operation: 'mkdir', path: 'a/b' }).ok).toBe(true);
    });

    it('executes the serialized worker from the production ESM/Node20 transpilation shape', () => {
        const source = fs.readFileSync(join(process.cwd(), 'src/security/confinedFiles.ts'), 'utf8');
        const compiled = transformSync(source, { loader: 'ts', format: 'esm', target: 'node20' }).code;
        const modulePath = join(fixture, 'compiled-worker.mjs');
        fs.writeFileSync(modulePath, compiled);
        fs.writeFileSync(join(root, 'file.txt'), 'compiled fixture');
        const program = `import { runConfinedFileOperation } from ${JSON.stringify(pathToFileURL(modulePath).href)}; process.stdout.write(JSON.stringify(runConfinedFileOperation(${JSON.stringify(root)}, {operation:'read',path:'file.txt'})));`;
        const result = JSON.parse(realExecFileSync(process.execPath, ['--input-type=module', '--eval', program], { env: {}, encoding: 'utf8', timeout: 10_000 }));
        expect(result).toMatchObject({ ok: true, anchor: anchorOf(root), dataBase64: Buffer.from('compiled fixture').toString('base64') });
    });

    it('rejects an ancestor swapped to an external symlink between lstat and chdir', () => {
        fs.mkdirSync(join(root, 'nested'));
        const result = withWorker({ operation: 'write', path: 'nested/secret.txt', dataBase64, anchor: anchorOf(root) }, {
            chdir: part => {
                fs.renameSync(part, part + '-old');
                fs.symlinkSync(outside, part, 'dir');
                process.chdir(part);
            },
        });
        expect(result).toMatchObject({ ok: false, status: 403, error: 'Directory changed during file access' });
        expect(fs.readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside sentinel');
        expect(fs.readdirSync(outside)).toEqual(['secret.txt']);
    });

    it('stays in the verified directory when its old pathname is replaced after chdir', () => {
        const nested = join(root, 'nested');
        const retained = join(root, 'retained');
        fs.mkdirSync(nested);fs.writeFileSync(join(nested, 'secret.txt'), 'authorized original');
        const result = withWorker({ operation: 'write', path: 'nested/secret.txt', dataBase64, anchor: anchorOf(root) }, {
            chdir: part => {
                process.chdir(part);
                fs.renameSync(nested, retained);
                fs.symlinkSync(outside, nested, 'dir');
            },
        });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(join(retained, 'secret.txt'), 'utf8')).toBe('authorized data');
        expect(fs.readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside sentinel');
    });

    it.each(['read', 'write'] as const)('rejects a leaf swapped to a symlink before %s open', operation => {
        fs.writeFileSync(join(root, 'file.txt'), 'authorized original');
        const wrappedFs = { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
            fs.unlinkSync('file.txt');fs.symlinkSync(join(outside, 'secret.txt'), 'file.txt');
            return fs.openSync(...args);
        } };
        const result = withWorker({ operation, path: 'file.txt', dataBase64, anchor: anchorOf(root) }, { fs: wrappedFs });
        expect(result).toMatchObject({ ok: false, status: 403 });
        expect(fs.readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside sentinel');
    });

    it('rejects a regular file swapped after lstat without truncating its replacement', () => {
        fs.writeFileSync(join(root, 'file.txt'), 'authorized original');
        const wrappedFs = { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
            fs.renameSync('file.txt', 'original.txt');fs.writeFileSync('file.txt', 'replacement retained');
            return fs.openSync(...args);
        } };
        expect(withWorker({ operation: 'write', path: 'file.txt', dataBase64, anchor: anchorOf(root) }, { fs: wrappedFs })).toMatchObject({ ok: false, status: 403 });
        expect(fs.readFileSync(join(root, 'file.txt'), 'utf8')).toBe('replacement retained');
        expect(fs.readFileSync(join(root, 'original.txt'), 'utf8')).toBe('authorized original');
    });

    it('rejects hardlinks for content reads and writes and leaves external content intact', () => {
        fs.linkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'));
        for (const operation of ['read', 'write'] as const) expect(runConfinedFileOperation(root, { operation, path: 'linked.txt', dataBase64 })).toMatchObject({ ok: false, status: 403 });
        expect(fs.readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside sentinel');
    });

    it('rejects malformed write data before creating parents or files', () => {
        expect(runConfinedFileOperation(root, { operation: 'write', path: 'new/file.txt', dataBase64: 'not base64!' })).toMatchObject({ ok: false, status: 413 });
        expect(fs.readdirSync(root)).toEqual([]);
    });

    it('bounds reads to 1MiB and rejects unsupported platforms and relative paths', () => {
        fs.writeFileSync(join(root, 'big.txt'), Buffer.alloc(1024 * 1024 + 9, 'x'));
        const result = runConfinedFileOperation(root, { operation: 'read', path: 'big.txt' });
        expect(result).toMatchObject({ ok: true, size: 1024 * 1024 + 9, truncated: true });
        expect(Buffer.from(result.dataBase64!, 'base64').length).toBe(1024 * 1024);
        expect(withWorker({ operation: 'read', path: 'big.txt', anchor: anchorOf(root) }, { platform: 'win32' })).toMatchObject({ ok: false, status: 403 });
        for (const path of ['../outside/secret.txt', '/outside', 'a//b', 'a\\b', 'a/./b']) expect(runConfinedFileOperation(root, { operation: 'write', path, dataBase64 })).toMatchObject({ ok: false, status: 400 });
    });

    it('refuses a root exchanged between the parent identity capture and the real child start', async () => {
        const priorRoot = join(fixture, 'prior-root');
        vi.doMock('child_process', () => ({ execFileSync: (...args: Parameters<typeof realExecFileSync>) => {
            fs.renameSync(root, priorRoot);fs.symlinkSync(outside, root, 'dir');
            return realExecFileSync(...args);
        } }));
        vi.resetModules();
        const { runConfinedFileOperation: actualChildOperation } = await import('../src/security/confinedFiles.js');
        const result = actualChildOperation(root, { operation: 'write', path: 'secret.txt', dataBase64 });
        expect(result).toMatchObject({ ok: false, status: 403, error: 'Configured file root changed' });
        expect(fs.readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside sentinel');
    });

    it('refuses mismatched child identity and excludes inherited child options/environment', async () => {
        const calls: unknown[][] = [];
        vi.doMock('child_process', () => ({ execFileSync: (...args: unknown[]) => { calls.push(args);return JSON.stringify({ ok: true, anchor: { dev: 'wrong', ino: 'wrong' } }); } }));
        vi.resetModules();
        const { runConfinedFileOperation: operation } = await import('../src/security/confinedFiles.js');
        expect(operation(root, { operation: 'read', path: 'file.txt' })).toMatchObject({ ok: false, status: 403 });
        expect(calls[0][0]).toBe(process.execPath);
        expect(calls[0][2]).toMatchObject({ cwd: root, env: {}, timeout: 10_000 });
        expect((calls[0][1] as string[]).slice(0, 2)).toEqual(['--input-type=commonjs', '--eval']);
    });
});
