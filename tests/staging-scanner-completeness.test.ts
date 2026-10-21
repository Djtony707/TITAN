import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('fs', async (original) => {
    const actual = await original<typeof import('fs')>();
    return { ...actual, lstatSync: vi.fn(actual.lstatSync), readdirSync: vi.fn(actual.readdirSync), readSync: vi.fn(actual.readSync) };
});
vi.mock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { scanBundle } from '../src/agent/stagingScanners.js';
const roots: string[] = [];
function root() { const directory = fs.mkdtempSync(join(tmpdir(), 'titan-scanner-boundary-')); roots.push(directory); return directory; }
afterEach(() => { vi.clearAllMocks(); for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('mandatory staged scanner completeness', () => {
    it('rejects a missing bundle rather than reporting an empty clean scan', () => {
        expect(() => scanBundle(join(root(), 'missing'))).toThrow(/staged directory/);
    });
    it.each(['.mjs', '.cjs', '.mts', '.cts'])('scans %s source and redacts secret values in serialized findings', (extension) => {
        const directory = root();
        const synthetic = 'ghp_' + 'Z'.repeat(36);
        fs.writeFileSync(join(directory, `candidate${extension}`), `const fixture='${synthetic}'; // AGPL-3.0`);
        const result = scanBundle(directory);
        expect(result.shouldBlock).toBe(true);
        expect(result.scannedFiles).toBe(1);
        expect(result.findings.filter(item => item.kind === 'secret').every(item => item.match === '[REDACTED]')).toBe(true);
        expect(result.findings.some(item => item.kind === 'license' && item.match === 'AGPL-3.0')).toBe(true);
        expect(JSON.stringify(result).includes(synthetic)).toBe(false);
    });
    it('rejects oversized source before returning a clean scan', () => {
        const directory = root();
        fs.writeFileSync(join(directory, 'candidate.ts'), Buffer.alloc(5 * 1024 * 1024 + 1, 'x'));
        expect(() => scanBundle(directory)).toThrow(/size limit/);
    });
    it.each(['enumerate', 'stat', 'read'])('fails closed on injected %s access failure without relying on uid/mode', (failure) => {
        const directory = root();
        fs.writeFileSync(join(directory, 'candidate.ts'), 'const fixture = 1;');
        const fail = () => { throw new Error('synthetic filesystem refusal'); };
        if (failure === 'enumerate') vi.mocked(fs.readdirSync).mockImplementationOnce(fail);
        if (failure === 'stat') vi.mocked(fs.lstatSync).mockImplementationOnce(fail);
        if (failure === 'read') vi.mocked(fs.readSync).mockImplementationOnce(fail);
        expect(() => scanBundle(directory)).toThrow(/staged/);
    });
    it.skipIf(process.platform === 'win32')('rejects symlinks before reading their external targets', () => {
        const directory = root();
        const outside = join(root(), 'outside.ts');
        fs.writeFileSync(outside, 'private external fixture');
        fs.symlinkSync(outside, join(directory, 'candidate.ts'));
        expect(() => scanBundle(directory)).toThrow(/symlink|regular file/i);
        expect(fs.readSync).not.toHaveBeenCalled();
    });
    it('reports explicit binary-asset exclusions and rejects unknown source formats', () => {
        const directory = root();
        fs.writeFileSync(join(directory, 'asset.png'), Buffer.from([137, 80, 78, 71]));
        const result = scanBundle(directory);
        expect(result.scannedFiles).toBe(0);
        expect(result.excludedFiles).toEqual([join(directory, 'asset.png')]);
        fs.writeFileSync(join(directory, 'candidate.unreviewed'), 'fixture');
        expect(() => scanBundle(directory)).toThrow(/unsupported staged file/i);
    });
});
