import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { atomicWriteJsonFile } from '../src/utils/helpers.js';

describe.skipIf(process.platform === 'win32')('private credential stores on POSIX', () => {
    it.each(['titan.json', 'auth-tokens.json'])('creates and atomically replaces %s with private file/home modes', (name) => {
        const root = mkdtempSync(join(tmpdir(), 'titan-private-files-'));
        const home = join(root, '.titan');
        const file = join(home, name);
        try {
            atomicWriteJsonFile(file, { fixture: 1 }, { mode: 0o600, directoryMode: 0o700 });
            expect(statSync(home).mode & 0o777).toBe(0o700);
            expect(statSync(file).mode & 0o777).toBe(0o600);
            chmodSync(home, 0o775);
            chmodSync(file, 0o664);
            atomicWriteJsonFile(file, { fixture: 2 }, { mode: 0o600, directoryMode: 0o700 });
            expect(statSync(home).mode & 0o777).toBe(0o700);
            expect(statSync(file).mode & 0o777).toBe(0o600);
            expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fixture: 2 });
            expect(readdirSync(home)).toEqual([name]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('saveConfig repairs broad modes without chmodding unrelated files or ancestors', () => {
        const root = mkdtempSync(join(tmpdir(), 'titan-config-mode-'));
        const home = join(root, '.titan');
        mkdirSync(home, { mode: 0o775 });
        chmodSync(root, 0o755);
        chmodSync(home, 0o775);
        const unrelated = join(home, 'ordinary.txt');
        writeFileSync(unrelated, 'fixture', { mode: 0o644 });
        const file = join(home, 'titan.json');
        writeFileSync(file, '{}', { mode: 0o664 });
        try {
            const script = `const { saveConfig } = await import('./src/config/config.ts'); saveConfig({ fixture: 'synthetic' });`;
            const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
                cwd: process.cwd(), env: { ...process.env, TITAN_HOME: home }, encoding: 'utf8', timeout: 15000,
            });
            expect(result.status).toBe(0);
            expect(statSync(home).mode & 0o777).toBe(0o700);
            expect(statSync(file).mode & 0o777).toBe(0o600);
            expect(statSync(root).mode & 0o777).toBe(0o755);
            expect(statSync(unrelated).mode & 0o777).toBe(0o644);
            expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fixture: 'synthetic' });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
