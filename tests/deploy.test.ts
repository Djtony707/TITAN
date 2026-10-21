/**
 * TITAN — Deploy Configuration Tests
 * Validates install script, Dockerfile, and deploy configs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

describe('Install Script', () => {
    const script = readFileSync(join(ROOT, 'install.sh'), 'utf-8');

    it('should exist and be non-empty', () => {
        expect(script.length).toBeGreaterThan(100);
    });

    it('should have bash shebang', () => {
        expect(script).toMatch(/^#!\/usr\/bin\/env bash/);
    });

    it('should use set -euo pipefail', () => {
        expect(script).toContain('set -euo pipefail');
    });

    it('should check for Node.js >= 20', () => {
        expect(script).toContain('REQUIRED_NODE_MAJOR=20');
    });

    it('should install titan-agent package', () => {
        expect(script).toContain('titan-agent');
        expect(script).toContain('npm install -g');
    });

    it('should support TITAN_SKIP_ONBOARD', () => {
        expect(script).toContain('TITAN_SKIP_ONBOARD');
    });

    it('should support TITAN_VERSION override', () => {
        expect(script).toContain('TITAN_VERSION');
    });

    it('should create ~/.titan directory', () => {
        expect(script).toContain('mkdir -p');
        expect(script).toContain('.titan');
    });

    it('should handle nvm installation', () => {
        expect(script).toContain('nvm');
    });
});

describe('Dockerfile', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf-8');

    it('should use multi-stage build', () => {
        expect(dockerfile).toContain('AS builder');
        expect(dockerfile.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(2);
    });

    it('should use alpine for production stage', () => {
        expect(dockerfile).toContain('node:22.23.4-alpine');
    });

    it('should expose port 48420', () => {
        expect(dockerfile).toContain('EXPOSE 48420');
    });

    it('should have a healthcheck', () => {
        expect(dockerfile).toContain('HEALTHCHECK');
        expect(dockerfile).toContain('/api/health');
    });

    it('should run as non-root user', () => {
        expect(dockerfile).toContain('USER titan');
    });

    it('should set NODE_ENV=production', () => {
        expect(dockerfile).toContain('NODE_ENV=production');
    });

    it('should bind to 0.0.0.0 for containers', () => {
        expect(dockerfile).toContain('TITAN_GATEWAY_HOST=0.0.0.0');
    });

    it('should use npm ci --omit=dev', () => {
        expect(dockerfile).toContain('npm ci --omit=dev');
    });
});

describe('Docker Compose', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf-8');

    it('should map port 48420', () => {
        expect(compose).toContain('48420:48420');
    });

    it('should use a named volume', () => {
        expect(compose).toContain('titan-data');
    });

    it('should have healthcheck', () => {
        expect(compose).toContain('healthcheck');
    });

    it('should restart unless stopped', () => {
        expect(compose).toContain('unless-stopped');
    });
});

describe('.dockerignore', () => {
    it('should exist', () => {
        expect(existsSync(join(ROOT, '.dockerignore'))).toBe(true);
    });

    it('should exclude node_modules and tests', () => {
        const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf-8');
        expect(ignore).toContain('node_modules');
        expect(ignore).toContain('tests');
    });
});

describe('Railway Config', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'railway.json'), 'utf-8'));

    it('should use Dockerfile builder', () => {
        expect(config.build.builder).toBe('DOCKERFILE');
    });

    it('should have healthcheck path', () => {
        expect(config.deploy.healthcheckPath).toBe('/api/health');
    });
});

describe('Render Blueprint', () => {
    const yaml = readFileSync(join(ROOT, 'render.yaml'), 'utf-8');

    it('should define a web service', () => {
        expect(yaml).toContain('type: web');
    });

    it('should use Docker runtime', () => {
        expect(yaml).toContain('runtime: docker');
    });

    it('should have a persistent disk', () => {
        expect(yaml).toContain('disk:');
        expect(yaml).toContain('titan-data');
    });

    it('should bind to 0.0.0.0', () => {
        expect(yaml).toContain('0.0.0.0');
    });
});

describe('Replit Config', () => {
    const replit = readFileSync(join(ROOT, '.replit'), 'utf-8');

    it('should run gateway', () => {
        expect(replit).toContain('gateway');
    });

    it('should use Node.js 22', () => {
        expect(replit).toContain('nodejs-22');
    });

    it('should map port 48420', () => {
        expect(replit).toContain('48420');
    });
});
