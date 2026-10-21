import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertSecureNodeRuntime, isSupportedNodeRuntime, NODE_RUNTIME_RANGE } from '../src/utils/nodeRuntime.js';

const require = createRequire(import.meta.url);
const satisfies = require('semver/functions/satisfies.js') as (version: string, range: string) => boolean;
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const allowed = ['22.23.4', '22.23.5', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0'];
const denied = ['18.20.8', '20.20.0', '22.0.0', '22.23.3', '23.0.0', '24.22.0', '25.0.0', '26.0.0', '26.12.0', '27.0.0', '28.0.0', '24.22.1-rc.1', '26.12.1-nightly.1'];

describe('security runtime release lines', () => {
    it.each(allowed)('accepts reviewed stable release %s', (version) => {
        expect(isSupportedNodeRuntime(version)).toBe(true);
        expect(() => assertSecureNodeRuntime(version)).not.toThrow();
    });
    it.each(denied)('rejects old, EOL, preview or unreviewed release %s', (version) => {
        expect(isSupportedNodeRuntime(version)).toBe(false);
        expect(() => assertSecureNodeRuntime(version)).toThrow(/Unsupported Node.js/);
    });
    it.each(['', '24', '24.22', '024.22.1', '24.022.1', ' 24.22.1', '24.22.1+unreviewed', '9007199254740992.0.0'])(
        'rejects malformed or unreviewed version %j', version => expect(isSupportedNodeRuntime(version)).toBe(false),
    );
    it('keeps all four manifest policies and npm lock metadata consistent with the startup policy', () => {
        for (const directory of ['.', 'ui', 'examples/mcp-server', 'titan-voice-ui']) {
            const manifest = JSON.parse(read(`${directory}/package.json`));
            expect(manifest.engines.node).toBe(NODE_RUNTIME_RANGE);
            for (const version of allowed) expect(satisfies(version, manifest.engines.node)).toBe(true);
            for (const version of denied) expect(satisfies(version, manifest.engines.node)).toBe(false);
            if (directory !== 'titan-voice-ui') expect(JSON.parse(read(`${directory}/package-lock.json`)).packages[''].engines.node).toBe(NODE_RUNTIME_RANGE);
        }
    });
    it('uses exact reviewed runtime versions in every committed Node Docker stage and CI selector', () => {
        for (const file of ['Dockerfile', 'Dockerfile.gpu', 'titan-voice-ui/Dockerfile']) {
            const docker = read(file);
            const images = [...docker.matchAll(/^FROM (node:\S+)/gm)].map(match => match[1]);
            expect(images.length).toBeGreaterThan(0);
            expect(images.every(image => /^node:22\.23\.4-(slim|alpine)$/.test(image))).toBe(true);
        }
        expect(read('Dockerfile.gpu')).toContain('nodejs=22.23.4-1nodesource1');
        for (const file of ['ci.yml', 'docker.yml', 'docker-cloud.yml', 'publish.yml', 'eval-gate.yml']) {
            const selectors = [...read(`.github/workflows/${file}`).matchAll(/node-version:\s*([^\n]+)/g)].map(match => match[1].trim());
            expect(selectors.length).toBeGreaterThan(0);
            expect(selectors.every(value => ["'22.23.4'", "['22.23.4']", '${{ matrix.node-version }}'].includes(value))).toBe(true);
        }
    });
});

describe('real CLI preflight boundary', () => {
    it.each(['20.20.0', '22.23.3', '26.12.0'])('refuses declared Node %s before updates, logging or command dispatch', (version) => {
        const home = mkdtempSync(join(tmpdir(), 'titan-runtime-preflight-'));
        try {
            const entry = join(root, 'src/cli/index.ts');
            const code = `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
globalThis.fetch = () => { console.error('UNEXPECTED_NETWORK_DISPATCH'); throw Error('Network disabled in fixture'); };
process.argv = [process.execPath, ${JSON.stringify(entry)}, '--version'];
await import(${JSON.stringify(entry)});`;
            const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
                cwd: root, encoding: 'utf8', timeout: 15000,
                env: { ...process.env, TITAN_HOME: home, TITAN_TELEMETRY_DISABLED: '1' },
            });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('Unsupported Node.js');
            expect(result.stderr).not.toContain('UNEXPECTED_NETWORK_DISPATCH');
            expect(readdirSync(home)).toEqual([]);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
