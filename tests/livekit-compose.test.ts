import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const yaml = createRequire(import.meta.url)('js-yaml') as { load: (source: string) => any };
const root = process.cwd();
const composeFile = join(root, 'docker-compose.voice.yml');
const composeBin = '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose';
let fixture: string;
beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'titan-voice-compose-'));
    mkdirSync(join(fixture, 'empty-docker-config'));
    writeFileSync(join(fixture, 'synthetic.env'), '');
});
afterEach(() => { rmSync(fixture, { recursive: true, force: true }); });

function config(env: Record<string, string> = {}) {
    // Parser only. Empty config/env files prevent owner credential reads; the socket does not exist.
    return spawnSync(composeBin, ['--project-name', 'titan-voice-fixture', '--project-directory', root,
        '--env-file', join(fixture, 'synthetic.env'), '-f', composeFile, 'config', '--format', 'json'], {
        env: { PATH: process.env.PATH, DOCKER_CONFIG: join(fixture, 'empty-docker-config'), DOCKER_HOST: `unix://${fixture}/no-daemon.sock`, COMPOSE_DISABLE_ENV_FILE: '1', ...env },
        encoding: 'utf8', timeout: 10000,
    });
}

describe('LiveKit stack configuration contract', () => {
    it('builds the agent and preflight image from explicit public files without copying private env/config', () => {
        const dockerfile = readFileSync(join(root, 'titan-voice-agent/Dockerfile'), 'utf8');
        const copies = dockerfile.split('\n').filter(line => /^COPY\s/i.test(line)).map(line => line.trim().split(/\s+/).slice(1));
        expect(copies).toEqual([
            ['requirements.txt', '.'],
            ['agent.py', 'kokoro_tts.py', 'validate_livekit.py', './'],
        ]);
        expect(dockerfile).not.toMatch(/ENV\s+LIVEKIT_API_(KEY|SECRET)=/);
    });

    it('keeps the stdlib preflight isolated and gates model/server startup on its completion', () => {
        const services = yaml.load(readFileSync(composeFile, 'utf8')).services;
        const check = services['voice-credentials-check'];
        expect(check.network_mode).toBe('none');
        expect(check.read_only).toBe(true);
        expect(check.command).toEqual(['python', '-I', '-B', 'validate_livekit.py']);
        for (const name of ['livekit-server', 'faster-whisper', 'kokoro-tts']) {
            expect(services[name].depends_on['voice-credentials-check'].condition).toBe('service_completed_successfully');
        }
        expect(services['titan-voice-agent'].network_mode).toBe('host');
        expect(services['faster-whisper'].image).toBe('fedirz/faster-whisper-server:latest-cpu');
        expect(services['kokoro-tts'].image).toBe('ghcr.io/remsky/kokoro-fastapi-cpu:latest');
        expect(services['livekit-server'].image).toBe('livekit/livekit-server');
    });

    it.skipIf(!existsSync(composeBin))('actual offline Compose rejects missing operator credentials', () => {
        for (const env of [{}, { LIVEKIT_API_KEY: 'synthetic_operator_key' }, { LIVEKIT_API_SECRET: 'synthetic_operator_secret_0123456789abcdef' }]) {
            const result = config(env);
            expect(result.error).toBeUndefined();
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('required variable');
        }
    });

    it.skipIf(!existsSync(composeBin)).each([
        ['synthetic_operator_key', 'synthetic_operator_secret_0123456789abcdef'],
        ['12345678', '1'.repeat(32)],
    ])('actual offline Compose preserves typed private pairs, normal mode, local ports and media settings', (key, secret) => {
        const result = config({ LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        const services = JSON.parse(result.stdout).services;
        const server = services['livekit-server'];
        expect(server.command).not.toContain('--dev');
        expect(server.command.join(' ')).not.toContain(secret);
        expect(server.command).toEqual(['--bind', '0.0.0.0', '--udp-port', '7882', '--node-ip', '127.0.0.1']);
        expect(yaml.load(server.environment.LIVEKIT_KEYS)).toEqual({ [key]: secret });
        expect(yaml.load(server.environment.LIVEKIT_CONFIG)).toEqual({ rtc: { use_external_ip: false } });
        const ports = Object.values(services).flatMap((service: any) => service.ports || []);
        expect(ports).toHaveLength(5);
        for (const port of ports as any[]) expect(port.host_ip).toBe('127.0.0.1');
        expect(services['titan-voice-agent'].environment.LIVEKIT_API_SECRET).toBe(secret);
        expect(services['voice-credentials-check'].environment.LIVEKIT_API_KEY).toBe(key);
        for (const name of ['livekit-server', 'faster-whisper', 'kokoro-tts']) {
            expect(services[name].depends_on['voice-credentials-check'].condition).toBe('service_completed_successfully');
        }
    });
});
