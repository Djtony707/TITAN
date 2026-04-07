/**
 * TITAN -- Config Loader Tests
 * Tests src/config/config.ts: loadConfig, saveConfig, updateConfig,
 * configExists, getDefaultConfig, resetConfigCache, applyEnvOverrides, setNested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockExistsSync = vi.fn();
vi.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

const mockReadJsonFile = vi.fn();
const mockWriteJsonFile = vi.fn();
const mockEnsureDir = vi.fn();
const mockDeepMerge = vi.fn();

vi.mock('../src/utils/helpers.js', () => ({
    readJsonFile: (...args: unknown[]) => mockReadJsonFile(...args),
    writeJsonFile: (...args: unknown[]) => mockWriteJsonFile(...args),
    ensureDir: (...args: unknown[]) => mockEnsureDir(...args),
    deepMerge: (...args: unknown[]) => mockDeepMerge(...args),
}));

vi.mock('../src/utils/constants.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-config',
        TITAN_CONFIG_PATH: '/tmp/titan-test-config/titan.json',
    };
});

// We need a real Zod schema for proper validation testing.
// Import the real schema so getDefaultConfig() produces a full default config.
// This gives us realistic coverage of the Zod integration.

import {
    loadConfig,
    saveConfig,
    updateConfig,
    resetConfigCache,
    configExists,
    getDefaultConfig,
} from '../src/config/config.js';
import logger from '../src/utils/logger.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Save and restore env vars touched during tests */
const ENV_KEYS = [
    'TITAN_MODEL',
    'TITAN_GATEWAY_PORT',
    'TITAN_GATEWAY_HOST',
    'TITAN_LOG_LEVEL',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'OLLAMA_BASE_URL',
    'DISCORD_TOKEN',
    'TELEGRAM_TOKEN',
    'SLACK_TOKEN',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    vi.clearAllMocks();
    resetConfigCache();
    // Save current env
    savedEnv = {};
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    // Restore env
    for (const key of ENV_KEYS) {
        if (savedEnv[key] !== undefined) {
            process.env[key] = savedEnv[key];
        } else {
            delete process.env[key];
        }
    }
});

// ─── getDefaultConfig ───────────────────────────────────────────

describe('getDefaultConfig', () => {
    it('should return a valid config object', () => {
        const config = getDefaultConfig();
        expect(config).toBeTruthy();
        expect(typeof config).toBe('object');
    });

    it('should contain agent section with model', () => {
        const config = getDefaultConfig();
        expect(config.agent).toBeDefined();
        expect(typeof config.agent.model).toBe('string');
        expect(config.agent.model.length).toBeGreaterThan(0);
    });

    it('should contain providers section', () => {
        const config = getDefaultConfig();
        expect(config.providers).toBeDefined();
        expect(config.providers.anthropic).toBeDefined();
        expect(config.providers.openai).toBeDefined();
    });

    it('should contain channels section', () => {
        const config = getDefaultConfig();
        expect(config.channels).toBeDefined();
        expect(config.channels.discord).toBeDefined();
        expect(config.channels.telegram).toBeDefined();
        expect(config.channels.slack).toBeDefined();
    });

    it('should contain gateway section with default port', () => {
        const config = getDefaultConfig();
        expect(config.gateway).toBeDefined();
        expect(typeof config.gateway.port).toBe('number');
    });

    it('should contain security section', () => {
        const config = getDefaultConfig();
        expect(config.security).toBeDefined();
        expect(config.security.sandboxMode).toBeDefined();
    });

    it('should contain logging section', () => {
        const config = getDefaultConfig();
        expect(config.logging).toBeDefined();
        expect(config.logging.level).toBeDefined();
    });

    it('should contain memory section', () => {
        const config = getDefaultConfig();
        expect(config.memory).toBeDefined();
        expect(typeof config.memory.enabled).toBe('boolean');
    });

    it('should contain skills section', () => {
        const config = getDefaultConfig();
        expect(config.skills).toBeDefined();
        expect(typeof config.skills.enabled).toBe('boolean');
    });

    it('should return fresh object each call', () => {
        const a = getDefaultConfig();
        const b = getDefaultConfig();
        expect(a).toEqual(b);
        // They should be different objects so mutations don't leak
        expect(a).not.toBe(b);
    });

    it('should have shield config nested in security', () => {
        const config = getDefaultConfig();
        expect(config.security.shield).toBeDefined();
        expect(typeof config.security.shield.enabled).toBe('boolean');
    });

    it('should have default agent temperature', () => {
        const config = getDefaultConfig();
        expect(typeof config.agent.temperature).toBe('number');
        expect(config.agent.temperature).toBeGreaterThanOrEqual(0);
        expect(config.agent.temperature).toBeLessThanOrEqual(2);
    });
});

// ─── loadConfig ─────────────────────────────────────────────────

describe('loadConfig', () => {
    it('should return defaults when no config file exists', () => {
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config).toBeTruthy();
        expect(config.agent).toBeDefined();
        expect(logger.info).toHaveBeenCalledWith('Config', 'No config file found, using defaults');
    });

    it('should call ensureDir with TITAN_HOME', () => {
        mockExistsSync.mockReturnValue(false);
        loadConfig();
        expect(mockEnsureDir).toHaveBeenCalledWith('/tmp/titan-test-config');
    });

    it('should load config from file when it exists', () => {
        const rawConfig = { agent: { model: 'openai/gpt-4o' } };
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue(rawConfig);
        const config = loadConfig();
        expect(config).toBeTruthy();
        expect(logger.debug).toHaveBeenCalledWith(
            'Config',
            expect.stringContaining('Loaded config from'),
        );
    });

    it('should use defaults when readJsonFile returns null (corrupt file)', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue(null);
        const config = loadConfig();
        expect(config).toBeTruthy();
        expect(logger.warn).toHaveBeenCalledWith(
            'Config',
            expect.stringContaining('Failed to parse config'),
        );
    });

    it('should cache config after first load', () => {
        mockExistsSync.mockReturnValue(false);
        const first = loadConfig();
        const second = loadConfig();
        expect(first).toBe(second); // same reference = cached
        // ensureDir should only have been called once
        expect(mockEnsureDir).toHaveBeenCalledTimes(1);
    });

    it('should return fresh config after resetConfigCache', () => {
        mockExistsSync.mockReturnValue(false);
        const first = loadConfig();
        resetConfigCache();
        const second = loadConfig();
        // After reset, a new config object is created
        expect(mockEnsureDir).toHaveBeenCalledTimes(2);
    });

    it('should warn on validation failure and use defaults', () => {
        // Provide invalid data that Zod will reject
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue({
            agent: { temperature: 999 }, // out of range 0-2
        });
        const config = loadConfig();
        expect(config).toBeTruthy();
        expect(logger.warn).toHaveBeenCalledWith(
            'Config',
            'Config validation issues, using defaults for invalid fields',
        );
    });

    it('should apply TITAN_MODEL env override', () => {
        process.env.TITAN_MODEL = 'openai/gpt-4o-mini';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.agent.model).toBe('openai/gpt-4o-mini');
    });

    it('should apply TITAN_GATEWAY_PORT env override', () => {
        process.env.TITAN_GATEWAY_PORT = '9999';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.gateway.port).toBe(9999);
    });

    it('should apply TITAN_GATEWAY_HOST env override', () => {
        process.env.TITAN_GATEWAY_HOST = '0.0.0.0';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.gateway.host).toBe('0.0.0.0');
    });

    it('should apply TITAN_LOG_LEVEL env override', () => {
        process.env.TITAN_LOG_LEVEL = 'debug';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.logging.level).toBe('debug');
    });

    it('should apply ANTHROPIC_API_KEY env override', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.providers.anthropic.apiKey).toBe('sk-ant-test123');
    });

    it('should apply OPENAI_API_KEY env override', () => {
        process.env.OPENAI_API_KEY = 'sk-openai-test';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.providers.openai.apiKey).toBe('sk-openai-test');
    });

    it('should apply GOOGLE_API_KEY env override', () => {
        process.env.GOOGLE_API_KEY = 'AIza-google-test';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.providers.google.apiKey).toBe('AIza-google-test');
    });

    it('should apply OLLAMA_BASE_URL env override', () => {
        process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.providers.ollama.baseUrl).toBe('http://localhost:11434');
    });

    it('should apply DISCORD_TOKEN env override', () => {
        process.env.DISCORD_TOKEN = 'discord-bot-token';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.channels.discord.token).toBe('discord-bot-token');
    });

    it('should apply TELEGRAM_TOKEN env override', () => {
        process.env.TELEGRAM_TOKEN = 'tg-bot-token';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.channels.telegram.token).toBe('tg-bot-token');
    });

    it('should apply SLACK_TOKEN env override', () => {
        process.env.SLACK_TOKEN = 'xoxb-slack-token';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.channels.slack.token).toBe('xoxb-slack-token');
    });

    it('should apply multiple env overrides simultaneously', () => {
        process.env.TITAN_MODEL = 'google/gemini-2.0-flash';
        process.env.ANTHROPIC_API_KEY = 'sk-multi';
        process.env.TITAN_LOG_LEVEL = 'warn';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.agent.model).toBe('google/gemini-2.0-flash');
        expect(config.providers.anthropic.apiKey).toBe('sk-multi');
        expect(config.logging.level).toBe('warn');
    });

    it('should not apply env overrides when env var is empty string', () => {
        process.env.TITAN_MODEL = '';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        // Empty string is falsy, so override should not apply
        const defaultConfig = getDefaultConfig();
        expect(config.agent.model).toBe(defaultConfig.agent.model);
    });

    it('should merge file config with env overrides', () => {
        process.env.TITAN_MODEL = 'openai/gpt-4o';
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue({
            logging: { level: 'error' },
        });
        const config = loadConfig();
        expect(config.agent.model).toBe('openai/gpt-4o');
        expect(config.logging.level).toBe('error');
    });
});

// ─── saveConfig ─────────────────────────────────────────────────

describe('saveConfig', () => {
    it('should call ensureDir with TITAN_HOME', () => {
        const config = getDefaultConfig();
        saveConfig(config);
        expect(mockEnsureDir).toHaveBeenCalledWith('/tmp/titan-test-config');
    });

    it('should call writeJsonFile with config path and data', () => {
        const config = getDefaultConfig();
        saveConfig(config);
        expect(mockWriteJsonFile).toHaveBeenCalledWith(
            '/tmp/titan-test-config/titan.json',
            config,
        );
    });

    it('should log after saving', () => {
        const config = getDefaultConfig();
        saveConfig(config);
        expect(logger.info).toHaveBeenCalledWith(
            'Config',
            expect.stringContaining('Config saved to'),
        );
    });

    it('should update the cache so loadConfig returns the saved config', () => {
        const config = getDefaultConfig();
        config.agent.model = 'custom/model-123';
        saveConfig(config);
        const loaded = loadConfig();
        expect(loaded).toBe(config); // same reference = was cached
    });

    it('should overwrite previously cached config', () => {
        mockExistsSync.mockReturnValue(false);
        const first = loadConfig();

        const custom = getDefaultConfig();
        custom.agent.model = 'different/model';
        saveConfig(custom);

        const loaded = loadConfig();
        expect(loaded).toBe(custom);
    });
});

// ─── updateConfig ───────────────────────────────────────────────

describe('updateConfig', () => {
    it('should call deepMerge with current config and partial update', () => {
        mockExistsSync.mockReturnValue(false);
        mockDeepMerge.mockImplementation((target: unknown, source: unknown) => ({
            ...(target as object),
            ...(source as object),
        }));

        const result = updateConfig({ agent: { model: 'new/model' } } as any);
        expect(mockDeepMerge).toHaveBeenCalled();
    });

    it('should save the merged config to disk', () => {
        mockExistsSync.mockReturnValue(false);
        mockDeepMerge.mockImplementation((target: unknown) => target);

        updateConfig({});
        expect(mockWriteJsonFile).toHaveBeenCalled();
    });

    it('should return the validated config', () => {
        mockExistsSync.mockReturnValue(false);
        mockDeepMerge.mockImplementation((target: unknown) => target);

        const result = updateConfig({});
        expect(result).toBeTruthy();
        expect(result.agent).toBeDefined();
    });

    it('should load current config first', () => {
        mockExistsSync.mockReturnValue(false);
        mockDeepMerge.mockImplementation((target: unknown) => target);

        updateConfig({});
        // loadConfig was called internally, so ensureDir should be called
        expect(mockEnsureDir).toHaveBeenCalledWith('/tmp/titan-test-config');
    });
});

// ─── configExists ───────────────────────────────────────────────

describe('configExists', () => {
    it('should return true when config file exists', () => {
        mockExistsSync.mockReturnValue(true);
        expect(configExists()).toBe(true);
    });

    it('should return false when config file does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        expect(configExists()).toBe(false);
    });

    it('should check the correct path', () => {
        mockExistsSync.mockReturnValue(false);
        configExists();
        expect(mockExistsSync).toHaveBeenCalledWith('/tmp/titan-test-config/titan.json');
    });
});

// ─── resetConfigCache ───────────────────────────────────────────

describe('resetConfigCache', () => {
    it('should clear the cached config', () => {
        mockExistsSync.mockReturnValue(false);
        const first = loadConfig();
        resetConfigCache();
        const second = loadConfig();
        // Both calls should hit ensureDir because cache was cleared
        expect(mockEnsureDir).toHaveBeenCalledTimes(2);
    });

    it('should not throw when called multiple times', () => {
        expect(() => {
            resetConfigCache();
            resetConfigCache();
            resetConfigCache();
        }).not.toThrow();
    });

    it('should not throw when called before loadConfig', () => {
        expect(() => resetConfigCache()).not.toThrow();
    });

    it('should force full reload on next loadConfig', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue({ agent: { model: 'first/model' } });
        const first = loadConfig();

        resetConfigCache();

        mockReadJsonFile.mockReturnValue({ agent: { model: 'second/model' } });
        const second = loadConfig();

        // second load should have re-read from disk
        expect(mockReadJsonFile).toHaveBeenCalledTimes(2);
    });
});

// ─── env override edge cases ────────────────────────────────────

describe('environment variable overrides (edge cases)', () => {
    it('should parse TITAN_GATEWAY_PORT as integer', () => {
        process.env.TITAN_GATEWAY_PORT = '12345';
        mockExistsSync.mockReturnValue(false);
        const config = loadConfig();
        expect(config.gateway.port).toBe(12345);
        expect(typeof config.gateway.port).toBe('number');
    });

    it('should log debug message for each applied env override', () => {
        process.env.ANTHROPIC_API_KEY = 'test-key';
        process.env.OPENAI_API_KEY = 'test-key-2';
        mockExistsSync.mockReturnValue(false);
        loadConfig();
        expect(logger.debug).toHaveBeenCalledWith('Config', 'Applied env override: ANTHROPIC_API_KEY');
        expect(logger.debug).toHaveBeenCalledWith('Config', 'Applied env override: OPENAI_API_KEY');
    });

    it('should create nested objects for env overrides when they do not exist', () => {
        // Raw config has no providers section at all
        process.env.ANTHROPIC_API_KEY = 'key-value';
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue({});
        const config = loadConfig();
        expect(config.providers.anthropic.apiKey).toBe('key-value');
    });

    it('should not overwrite existing nested values from file config', () => {
        process.env.ANTHROPIC_API_KEY = 'env-key';
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue({
            providers: {
                anthropic: {
                    baseUrl: 'https://custom.api.com',
                },
            },
        });
        const config = loadConfig();
        // Both the file config (baseUrl) and env override (apiKey) should be present
        expect(config.providers.anthropic.apiKey).toBe('env-key');
    });
});

// ─── integration-like scenarios ─────────────────────────────────

describe('config lifecycle scenarios', () => {
    it('should handle load -> update -> load cycle', () => {
        mockExistsSync.mockReturnValue(false);
        mockDeepMerge.mockImplementation((target: unknown) => target);

        const initial = loadConfig();
        expect(initial).toBeTruthy();

        updateConfig({});
        const reloaded = loadConfig();
        expect(reloaded).toBeTruthy();
    });

    it('should handle load -> save -> resetCache -> load cycle', () => {
        mockExistsSync.mockReturnValue(false);
        const initial = loadConfig();

        saveConfig(initial);
        expect(mockWriteJsonFile).toHaveBeenCalledTimes(1);

        resetConfigCache();

        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue({ agent: { model: 'roundtrip/model' } });
        const reloaded = loadConfig();
        expect(reloaded.agent.model).toBe('roundtrip/model');
    });

    it('should handle configExists -> loadConfig when file missing', () => {
        mockExistsSync.mockReturnValue(false);
        expect(configExists()).toBe(false);

        const config = loadConfig();
        expect(config).toBeTruthy();
        expect(config.agent).toBeDefined();
    });

    it('should handle configExists -> loadConfig when file present', () => {
        mockExistsSync.mockReturnValue(true);
        mockReadJsonFile.mockReturnValue({});
        expect(configExists()).toBe(true);

        const config = loadConfig();
        expect(config).toBeTruthy();
    });

    it('should handle multiple saveConfig calls', () => {
        const config1 = getDefaultConfig();
        const config2 = getDefaultConfig();
        config2.agent.model = 'model-2';

        saveConfig(config1);
        saveConfig(config2);

        expect(mockWriteJsonFile).toHaveBeenCalledTimes(2);
        const loaded = loadConfig();
        expect(loaded).toBe(config2);
    });
});
