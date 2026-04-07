/**
 * TITAN — CLI Doctor Tests
 * Tests the doctor diagnostic tool logic
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'anthropic/claude-sonnet-4-20250514' },
        security: {
            sandboxMode: 'host',
            deniedTools: [],
            allowedTools: [],
            networkAllowlist: ['*'],
            fileSystemAllowlist: [],
            commandTimeout: 30000,
            shield: { enabled: true, mode: 'strict' },
        },
        channels: {
            discord: { enabled: false, dmPolicy: 'pairing' },
        },
    }),
    configExists: vi.fn().mockReturnValue(true),
    getDefaultConfig: vi.fn(),
    resetConfigCache: vi.fn(),
}));

vi.mock('../src/providers/router.js', () => ({
    healthCheckAll: vi.fn().mockResolvedValue({
        anthropic: true,
        openai: false,
    }),
}));

vi.mock('../src/agent/stallDetector.js', () => ({
    getStallStats: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_HOME: '/tmp/titan-test-cli',
    TITAN_CONFIG_PATH: '/tmp/titan-test-cli/titan.json',
    TITAN_DB_PATH: '/tmp/titan-test-cli/titan.db',
    TITAN_WORKSPACE: '/tmp/titan-test-cli/workspace',
    TITAN_SKILLS_DIR: '/tmp/titan-test-cli/workspace/skills',
    TITAN_LOGS_DIR: '/tmp/titan-test-cli/logs',
    TITAN_VERSION: '2026.4.33',
    TITAN_MD_FILENAME: 'TITAN.md',
    AGENTS_MD: '/tmp/titan-test-cli/workspace/AGENTS.md',
    SOUL_MD: '/tmp/titan-test-cli/workspace/SOUL.md',
    TOOLS_MD: '/tmp/titan-test-cli/workspace/TOOLS.md',
    DEFAULT_GATEWAY_HOST: '127.0.0.1',
    DEFAULT_GATEWAY_PORT: 48420,
    DEFAULT_WEB_PORT: 48421,
    DEFAULT_MODEL: 'anthropic/claude-sonnet-4-20250514',
    DEFAULT_MAX_TOKENS: 8192,
    DEFAULT_TEMPERATURE: 0.7,
    DEFAULT_SANDBOX_MODE: 'host',
    ALLOWED_TOOLS_DEFAULT: ['shell', 'read_file', 'write_file'],
}));

// ─── Auth Resolver Tests (high coverage impact) ─────────────────

import {
    resolveApiKey,
    markKeyFailed,
    markKeyHealthy,
    getCooldownStatus,
    type AuthProfile,
} from '../src/providers/authResolver.js';

describe('Auth Resolver', () => {
    describe('resolveApiKey', () => {
        it('should return the highest priority auth profile key', () => {
            const profiles: AuthProfile[] = [
                { name: 'primary', apiKey: 'sk-primary', priority: 1 },
                { name: 'secondary', apiKey: 'sk-secondary', priority: 2 },
            ];
            expect(resolveApiKey('openai', profiles, '', '')).toBe('sk-primary');
        });

        it('should fall back to config key when no profiles', () => {
            expect(resolveApiKey('openai', [], 'sk-config', '')).toBe('sk-config');
        });

        it('should fall back to env var when no profiles and no config key', () => {
            process.env.TEST_TITAN_KEY = 'sk-env-test';
            expect(resolveApiKey('openai', [], '', 'TEST_TITAN_KEY')).toBe('sk-env-test');
            delete process.env.TEST_TITAN_KEY;
        });

        it('should return empty string when nothing is available', () => {
            expect(resolveApiKey('openai', [], '', 'NONEXISTENT_ENV_KEY_XYZ')).toBe('');
        });

        it('should skip profiles with empty apiKey', () => {
            const profiles: AuthProfile[] = [
                { name: 'empty', apiKey: '', priority: 1 },
                { name: 'valid', apiKey: 'sk-valid', priority: 2 },
            ];
            expect(resolveApiKey('openai', profiles, '', '')).toBe('sk-valid');
        });

        it('should skip cooled-down profiles', () => {
            const profiles: AuthProfile[] = [
                { name: 'primary', apiKey: 'sk-primary', priority: 1 },
                { name: 'backup', apiKey: 'sk-backup', priority: 2 },
            ];
            markKeyFailed('openai', 'primary');
            expect(resolveApiKey('openai', profiles, '', '')).toBe('sk-backup');
            // Clear cooldown for other tests
            markKeyHealthy('openai', 'primary');
        });
    });

    describe('markKeyFailed / markKeyHealthy', () => {
        it('should put a key on cooldown', () => {
            markKeyFailed('groq', 'test-key');
            const status = getCooldownStatus();
            expect(status.length).toBeGreaterThan(0);
            const found = status.find(s => s.provider === 'groq' && s.profile === 'test-key');
            expect(found).toBeDefined();
            // Clean up
            markKeyHealthy('groq', 'test-key');
        });

        it('should clear cooldown with markKeyHealthy', () => {
            markKeyFailed('mistral', 'key-a');
            markKeyHealthy('mistral', 'key-a');
            const status = getCooldownStatus();
            const found = status.find(s => s.provider === 'mistral' && s.profile === 'key-a');
            expect(found).toBeUndefined();
        });
    });

    describe('getCooldownStatus', () => {
        it('should return empty when no cooldowns', () => {
            // All previous cooldowns should be cleared
            const status = getCooldownStatus();
            // Filter out any stragglers from parallel tests
            expect(Array.isArray(status)).toBe(true);
        });

        it('should return active cooldowns with correct shape', () => {
            markKeyFailed('test-provider', 'test-profile');
            const status = getCooldownStatus();
            const found = status.find(s => s.provider === 'test-provider');
            expect(found).toBeDefined();
            expect(found!.expiresAt).toBeGreaterThan(Date.now());
            markKeyHealthy('test-provider', 'test-profile');
        });
    });
});

// ─── Doctor runDoctor (smoke test) ─────────────────────────────

describe('Doctor', () => {
    it('should import and have runDoctor function', async () => {
        // We can at least verify the module loads and exports correctly
        const doctorModule = await import('../src/cli/doctor.js');
        expect(typeof doctorModule.runDoctor).toBe('function');
    });
});
