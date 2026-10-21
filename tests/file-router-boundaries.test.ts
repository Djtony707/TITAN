import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

let home: string;
let workspace: string;
let outside: string;
let server: Server | undefined;
let baseUrl: string;

function createFixtureHome(): string {
    // /tmp is deliberately readable by the production preview policy. Linux's
    // os.tmpdir() therefore cannot represent a path outside that policy.
    const parent = realpathSync('/var/tmp');
    const uid = process.getuid?.();
    const parentStat = lstatSync(parent);
    if (uid === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()
        || (parentStat.uid !== 0 && parentStat.uid !== uid)
        || ((parentStat.mode & 0o022) !== 0 && (parentStat.mode & 0o1000) === 0)) {
        throw new Error('File boundary fixtures require a trusted POSIX scratch parent');
    }
    const readableRoots = ['/tmp', '/home/dj/titan-saas', '/home/dj/scripts']
        .flatMap(root => existsSync(root) ? [root, realpathSync(root)] : [root]);
    if (readableRoots.some(root => parent === root || parent.startsWith(root + '/'))) {
        throw new Error('File boundary fixture parent must be outside preview policy roots');
    }
    const directory = mkdtempSync(join(parent, 'titan-file-boundary-'));
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
        || (stat.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) {
        throw new Error('File boundary fixture must be a canonical private owned directory');
    }
    return directory;
}

beforeEach(async () => {
    server = undefined;
    home = '';
    vi.resetModules();
    home = createFixtureHome();
    workspace = join(home, 'workspace');
    outside = join(home, 'outside');
    for (const dir of [workspace, outside, join(home, '.titan', 'uploads')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(outside, 'sentinel.txt'), 'outside fixture');
    vi.doMock('os', async () => ({ ...await vi.importActual('os'), homedir: () => home }));
    vi.doMock('../src/config/config.js', () => ({ loadConfig: () => ({ fileManager: { roots: [workspace] }, autonomy: { selfMod: { target: workspace } } }) }));
    vi.doMock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
    vi.doMock('../src/utils/constants.js', () => ({ TITAN_HOME: join(home, '.titan') }));
    const { createFilesRouter } = await import('../src/gateway/routes/files.js');
    const app = express();
    app.use(express.json());
    app.use(express.raw({ type: 'application/octet-stream', limit: '2mb' }));
    app.use('/api/files', createFilesRouter());
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}/api/files`;
});
afterEach(async () => {
    const activeServer = server;
    if (activeServer?.listening) {
        activeServer.closeAllConnections();
        await new Promise<void>(resolve => activeServer.close(() => resolve()));
    }
    if (home) rmSync(home, { recursive: true, force: true });
});

function upload(session: string, name = 'fixture.txt') {
    return fetch(`${baseUrl}/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-session-id': session, 'x-filename': name }, body: 'owned fixture' });
}
function post(path: string, data: unknown) {
    return fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
}

describe('authenticated file router confines paths', () => {
    it.each(['../escaped', '..', '/absolute', 'a/b', 'a\\b', 'a'.repeat(129)])('rejects malformed upload session %s', async session => {
        const response = await upload(session);
        expect(response.status).toBe(400);
        expect(existsSync(join(home, '.titan', 'escaped', 'fixture.txt'))).toBe(false);
    });

    it('rejects sibling-prefix session deletion and traversal listing', async () => {
        const sibling = join(home, '.titan', 'uploads-sibling');
        mkdirSync(sibling);writeFileSync(join(sibling, 'sentinel.txt'), 'keep');
        const deletion = await fetch(`${baseUrl}/uploads/sentinel.txt?session=..%2Fuploads-sibling`, { method: 'DELETE' });
        expect(deletion.status).toBe(400);
        expect(readFileSync(join(sibling, 'sentinel.txt'), 'utf8')).toBe('keep');
        const listing = await fetch(`${baseUrl}/uploads?session=..%2Fuploads-sibling`);
        expect(listing.status).toBe(400);
    });

    it('rejects symlink directories for upload and ordinary file reads/writes', async () => {
        symlinkSync(outside, join(home, '.titan', 'uploads', 'linked'), 'dir');
        expect((await upload('linked', 'sentinel.txt')).status).toBe(403);
        symlinkSync(outside, join(workspace, 'linked'), 'dir');
        const reading = await fetch(`${baseUrl}/read?path=linked%2Fsentinel.txt`);
        expect(reading.status).toBe(403);
        expect((await post('/write', { path: 'linked/sentinel.txt', content: 'replacement' })).status).toBe(403);
        expect((await fetch(`${baseUrl}/uploads?session=linked`)).status).toBe(403);
        expect((await fetch(`${baseUrl}/uploads/sentinel.txt?session=linked`, { method: 'DELETE' })).status).toBe(403);
        expect((await post('/mkdir', { path: 'linked/new-directory' })).status).toBe(403);
        expect((await post('/rename', { oldPath: 'linked/sentinel.txt', newPath: 'linked/new.txt' })).status).toBe(403);
        expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside fixture');
    });

    it('rejects an uploads root symlink instead of trusting its canonical target', async () => {
        rmSync(join(home, '.titan', 'uploads'), { recursive: true });
        symlinkSync(outside, join(home, '.titan', 'uploads'), 'dir');
        expect((await upload('ordinary')).status).toBe(403);
        expect(existsSync(join(outside, 'ordinary'))).toBe(false);
    });

    it('preserves content preview policy while refusing symlink escapes and bounding content', async () => {
        writeFileSync(join(workspace, 'preview.txt'), 'preview fixture');
        const content = (path: string) => fetch(`${baseUrl}/content?path=${encodeURIComponent(path)}`);
        expect((await (await content(join(workspace, 'preview.txt'))).json()).content).toBe('preview fixture');
        symlinkSync(outside, join(workspace, 'linked'), 'dir');
        expect((await content(join(workspace, 'linked', 'sentinel.txt'))).status).toBe(404);
        expect((await content(join(outside, 'sentinel.txt'))).status).toBe(404);
        writeFileSync(join(home, '.titan', 'fix-events.jsonl'), JSON.stringify({ target: join(outside, 'sentinel.txt'), at: new Date().toISOString() }) + '\n');
        expect((await (await content(join(outside, 'sentinel.txt'))).json()).content).toBe('outside fixture');
        rmSync(join(outside, 'sentinel.txt'));
        symlinkSync(join(workspace, 'preview.txt'), join(outside, 'sentinel.txt'));
        expect((await content(join(outside, 'sentinel.txt'))).status).toBe(404);
        writeFileSync(join(workspace, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 'x'));
        const big = await (await content(join(workspace, 'big.txt'))).json();
        expect(big).toMatchObject({ truncated: true, sizeBytes: 1024 * 1024 + 1, encoding: 'utf-8' });
        expect(big.content.length).toBe(1024 * 1024);
        writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
        expect((await (await content(join(workspace, 'binary.bin'))).json()).encoding).toBe('binary');
    });

    it('preserves the existing /tmp preview allowance independently of the restricted fixture', async () => {
        // Keep the lexical /tmp prefix on macOS too: this exercises the same
        // policy path that made the original Linux fixture incorrectly return 200.
        const allowedScratch = mkdtempSync('/tmp/titan-preview-policy-');
        try {
            const allowedFile = join(allowedScratch, 'preview.txt');
            writeFileSync(allowedFile, 'allowed temporary fixture');
            const response = await fetch(`${baseUrl}/content?path=${encodeURIComponent(allowedFile)}`);
            expect(response.status).toBe(200);
            expect((await response.json()).content).toBe('allowed temporary fixture');
        } finally { rmSync(allowedScratch, { recursive: true, force: true }); }
    });

    it('rejects symlink leaves for file reads and writes', async () => {
        symlinkSync(join(outside, 'sentinel.txt'), join(workspace, 'linked.txt'));
        expect((await fetch(`${baseUrl}/read?path=linked.txt`)).status).toBe(403);
        expect((await post('/write', { path: 'linked.txt', content: 'replacement' })).status).toBe(403);
        expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside fixture');
    });

    it('preserves normal session uploads and authorized nested file editing', async () => {
        expect((await upload('session-123')).status).toBe(200);
        const listing = await fetch(`${baseUrl}/uploads?session=session-123`);
        expect((await listing.json()).files.map((file: { name: string }) => file.name)).toEqual(['fixture.txt']);
        expect((await fetch(`${baseUrl}/uploads/fixture.txt?session=session-123`, { method: 'DELETE' })).status).toBe(200);
        expect((await post('/write', { path: 'nested/note.txt', content: 'safe fixture' })).status).toBe(200);
        const reading = await fetch(`${baseUrl}/read?path=nested%2Fnote.txt`);
        expect((await reading.json()).content).toBe('safe fixture');
    });
});
