/**
 * TITAN -- Self-Healing System Tests
 * Tests src/cli/selfHeal.ts: all fix functions and runAllFixes orchestrator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockChmodSync = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    chmodSync: (...args: unknown[]) => mockChmodSync(...args),
}));

const mockConfigExists = vi.fn();
const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();
const mockGetDefaultConfig = vi.fn();

vi.mock('../src/config/config.js', () => ({
    configExists: () => mockConfigExists(),
    loadConfig: () => mockLoadConfig(),
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
    getDefaultConfig: () => mockGetDefaultConfig(),
}));

vi.mock('../src/config/schema.js', () => ({
    TitanConfigSchema: {
        parse: vi.fn((v: unknown) => v),
    },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_HOME: '/tmp/titan-test-heal',
    TITAN_WORKSPACE: '/tmp/titan-test-heal/workspace',
    TITAN_CONFIG_PATH: '/tmp/titan-test-heal/titan.json',
    TITAN_LOGS_DIR: '/tmp/titan-test-heal/logs',
    TITAN_SKILLS_DIR: '/tmp/titan-test-heal/workspace/skills',
    TITAN_MD_FILENAME: 'TITAN.md',
    AGENTS_MD: '/tmp/titan-test-heal/workspace/AGENTS.md',
    SOUL_MD: '/tmp/titan-test-heal/workspace/SOUL.md',
    TOOLS_MD: '/tmp/titan-test-heal/workspace/TOOLS.md',
}));

import {
    fixMissingTitanHome,
    fixMissingConfig,
    fixInvalidConfig,
    fixMissingWorkspace,
    fixBrokenChannelConfig,
    fixPermissions,
    fixStaleLogFiles,
    fixOrphanedSessions,
    runAllFixes,
} from '../src/cli/selfHeal.js';
import { TitanConfigSchema } from '../src/config/schema.js';

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── fixMissingTitanHome ─────────────────────────────────────────

describe('fixMissingTitanHome', () => {
    it('should create directories when they do not exist', () => {
        mockExistsSync.mockReturnValue(false);
        const result = fixMissingTitanHome();
        expect(result.success).toBe(true);
        expect(result.action).toBe('fixMissingTitanHome');
        expect(result.message).toContain('Created');
        expect(mockMkdirSync).toHaveBeenCalled();
    });

    it('should report how many directories were created', () => {
        mockExistsSync.mockReturnValue(false);
        const result = fixMissingTitanHome();
        // 5 directories: TITAN_HOME, TITAN_LOGS_DIR, memory, TITAN_WORKSPACE, TITAN_SKILLS_DIR
        expect(result.message).toBe('Created 5 directories');
        expect(mockMkdirSync).toHaveBeenCalledTimes(5);
    });

    it('should be a noop when all directories exist', () => {
        mockExistsSync.mockReturnValue(true);
        const result = fixMissingTitanHome();
        expect(result.success).toBe(true);
        expect(result.message).toBe('All directories exist');
        expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should create only missing directories', () => {
        let callCount = 0;
        mockExistsSync.mockImplementation(() => {
            callCount++;
            // First two exist, rest don't
            return callCount <= 2;
        });
        const result = fixMissingTitanHome();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Created 3 directories');
    });

    it('should use recursive: true for mkdirSync', () => {
        mockExistsSync.mockReturnValue(false);
        fixMissingTitanHome();
        for (const call of mockMkdirSync.mock.calls) {
            expect(call[1]).toEqual({ recursive: true });
        }
    });
});

// ─── fixMissingConfig ────────────────────────────────────────────

describe('fixMissingConfig', () => {
    it('should create config when missing', () => {
        mockConfigExists.mockReturnValue(false);
        const defaultConfig = { agent: { model: 'test' } };
        mockGetDefaultConfig.mockReturnValue(defaultConfig);
        const result = fixMissingConfig();
        expect(result.success).toBe(true);
        expect(result.message).toContain('Default config written');
        expect(mockSaveConfig).toHaveBeenCalledWith(defaultConfig);
    });

    it('should noop when config exists', () => {
        mockConfigExists.mockReturnValue(true);
        const result = fixMissingConfig();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Config already exists');
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('should return action name fixMissingConfig', () => {
        mockConfigExists.mockReturnValue(true);
        const result = fixMissingConfig();
        expect(result.action).toBe('fixMissingConfig');
    });
});

// ─── fixInvalidConfig ────────────────────────────────────────────

describe('fixInvalidConfig', () => {
    it('should keep valid config', () => {
        mockConfigExists.mockReturnValue(true);
        const config = { agent: { model: 'test' } };
        mockLoadConfig.mockReturnValue(config);
        const result = fixInvalidConfig();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Config is valid');
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('should replace invalid config with defaults', () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({ broken: true });
        (TitanConfigSchema.parse as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
            throw new Error('Invalid config');
        });
        const defaultConfig = { agent: { model: 'default' } };
        mockGetDefaultConfig.mockReturnValue(defaultConfig);

        const result = fixInvalidConfig();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Config was invalid, replaced with defaults');
        expect(mockSaveConfig).toHaveBeenCalledWith(defaultConfig);
    });

    it('should return failure when no config file exists', () => {
        mockConfigExists.mockReturnValue(false);
        const result = fixInvalidConfig();
        expect(result.success).toBe(false);
        expect(result.message).toBe('No config file found');
    });

    it('should return action name fixInvalidConfig', () => {
        mockConfigExists.mockReturnValue(false);
        const result = fixInvalidConfig();
        expect(result.action).toBe('fixInvalidConfig');
    });
});

// ─── fixMissingWorkspace ─────────────────────────────────────────

describe('fixMissingWorkspace', () => {
    it('should create workspace files when missing', () => {
        mockExistsSync.mockReturnValue(false);
        const result = fixMissingWorkspace();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Created 3 workspace files');
        expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
    });

    it('should create workspace directory if it does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        fixMissingWorkspace();
        expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/titan-test-heal/workspace', { recursive: true });
    });

    it('should noop when all workspace files exist', () => {
        mockExistsSync.mockReturnValue(true);
        const result = fixMissingWorkspace();
        expect(result.success).toBe(true);
        expect(result.message).toBe('All workspace files exist');
        expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('should write correct content for AGENTS.md', () => {
        mockExistsSync.mockReturnValue(false);
        fixMissingWorkspace();
        const agentsCall = mockWriteFileSync.mock.calls.find(
            (c: unknown[]) => (c[0] as string).endsWith('AGENTS.md'),
        );
        expect(agentsCall).toBeDefined();
        expect(agentsCall![1]).toContain('# TITAN Agents');
    });

    it('should write correct content for SOUL.md', () => {
        mockExistsSync.mockReturnValue(false);
        fixMissingWorkspace();
        const soulCall = mockWriteFileSync.mock.calls.find(
            (c: unknown[]) => (c[0] as string).endsWith('SOUL.md'),
        );
        expect(soulCall).toBeDefined();
        expect(soulCall![1]).toContain('# TITAN Soul');
    });

    it('should write correct content for TOOLS.md', () => {
        mockExistsSync.mockReturnValue(false);
        fixMissingWorkspace();
        const toolsCall = mockWriteFileSync.mock.calls.find(
            (c: unknown[]) => (c[0] as string).endsWith('TOOLS.md'),
        );
        expect(toolsCall).toBeDefined();
        expect(toolsCall![1]).toContain('# TITAN Tools');
    });
});

// ─── fixBrokenChannelConfig ──────────────────────────────────────

describe('fixBrokenChannelConfig', () => {
    it('should disable channels enabled without tokens', () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            channels: {
                discord: { enabled: true, token: '', apiKey: '' },
                telegram: { enabled: true, token: 'bot123' },
                slack: { enabled: false },
            },
        });
        const result = fixBrokenChannelConfig();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Disabled 1 channels without tokens');
        expect(mockSaveConfig).toHaveBeenCalled();
    });

    it('should noop when all enabled channels have tokens', () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            channels: {
                discord: { enabled: true, token: 'abc123' },
                telegram: { enabled: false },
            },
        });
        const result = fixBrokenChannelConfig();
        expect(result.success).toBe(true);
        expect(result.message).toBe('All enabled channels have tokens');
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('should recognize apiKey as a valid token', () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            channels: {
                slack: { enabled: true, apiKey: 'xoxb-key' },
            },
        });
        const result = fixBrokenChannelConfig();
        expect(result.success).toBe(true);
        expect(result.message).toBe('All enabled channels have tokens');
    });

    it('should return failure when no config file exists', () => {
        mockConfigExists.mockReturnValue(false);
        const result = fixBrokenChannelConfig();
        expect(result.success).toBe(false);
        expect(result.message).toBe('No config file');
    });

    it('should return failure when loadConfig throws', () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockImplementation(() => { throw new Error('corrupt'); });
        const result = fixBrokenChannelConfig();
        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to read config');
    });

    it('should disable multiple channels without tokens', () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            channels: {
                discord: { enabled: true, token: '', apiKey: '' },
                telegram: { enabled: true, token: '' },
                slack: { enabled: true, apiKey: 'valid' },
            },
        });
        const result = fixBrokenChannelConfig();
        expect(result.message).toBe('Disabled 2 channels without tokens');
    });
});

// ─── fixPermissions ──────────────────────────────────────────────

describe('fixPermissions', () => {
    it('should set permissions to 700', () => {
        mockExistsSync.mockReturnValue(true);
        const result = fixPermissions();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Permissions set to 700');
        expect(mockChmodSync).toHaveBeenCalledWith('/tmp/titan-test-heal', 0o700);
    });

    it('should return failure when TITAN_HOME does not exist', () => {
        mockExistsSync.mockReturnValue(false);
        const result = fixPermissions();
        expect(result.success).toBe(false);
        expect(result.message).toBe('TITAN_HOME does not exist');
        expect(mockChmodSync).not.toHaveBeenCalled();
    });

    it('should return failure when chmodSync throws', () => {
        mockExistsSync.mockReturnValue(true);
        mockChmodSync.mockImplementation(() => { throw new Error('EPERM'); });
        const result = fixPermissions();
        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed:');
        expect(result.message).toContain('EPERM');
    });

    it('should return action name fixPermissions', () => {
        mockExistsSync.mockReturnValue(true);
        const result = fixPermissions();
        expect(result.action).toBe('fixPermissions');
    });
});

// ─── fixStaleLogFiles ────────────────────────────────────────────

describe('fixStaleLogFiles', () => {
    it('should remove files older than 30 days', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['old.log', 'recent.log']);

        const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
        const recent = Date.now() - 1000;
        let callIdx = 0;
        mockStatSync.mockImplementation(() => {
            callIdx++;
            return {
                isFile: () => true,
                mtimeMs: callIdx === 1 ? thirtyOneDaysAgo : recent,
            };
        });

        const result = fixStaleLogFiles();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Removed 1 stale log files');
        expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('should noop when no stale logs exist', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['recent.log']);
        mockStatSync.mockReturnValue({
            isFile: () => true,
            mtimeMs: Date.now() - 1000,
        });

        const result = fixStaleLogFiles();
        expect(result.success).toBe(true);
        expect(result.message).toBe('No stale logs');
        expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('should return success with message when no logs directory', () => {
        mockExistsSync.mockReturnValue(false);
        const result = fixStaleLogFiles();
        expect(result.success).toBe(true);
        expect(result.message).toBe('No logs directory');
    });

    it('should skip non-file entries (directories)', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['subdir']);
        mockStatSync.mockReturnValue({
            isFile: () => false,
            mtimeMs: Date.now() - 31 * 24 * 60 * 60 * 1000,
        });

        const result = fixStaleLogFiles();
        expect(result.message).toBe('No stale logs');
        expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('should return failure when readdirSync throws', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockImplementation(() => { throw new Error('EACCES'); });
        const result = fixStaleLogFiles();
        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed:');
    });
});

// ─── fixOrphanedSessions ─────────────────────────────────────────

describe('fixOrphanedSessions', () => {
    it('should clean up sessions older than 24 hours', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['old-session.json', 'new-session.json']);

        const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
        const recent = Date.now() - 1000;
        let callIdx = 0;
        mockStatSync.mockImplementation(() => {
            callIdx++;
            return {
                isFile: () => true,
                mtimeMs: callIdx === 1 ? twoDaysAgo : recent,
            };
        });

        const result = fixOrphanedSessions();
        expect(result.success).toBe(true);
        expect(result.message).toBe('Cleaned 1 orphaned sessions');
        expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('should noop when no orphaned sessions exist', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['recent.json']);
        mockStatSync.mockReturnValue({
            isFile: () => true,
            mtimeMs: Date.now() - 1000,
        });

        const result = fixOrphanedSessions();
        expect(result.success).toBe(true);
        expect(result.message).toBe('No orphaned sessions');
    });

    it('should return success when no sessions directory exists', () => {
        mockExistsSync.mockReturnValue(false);
        const result = fixOrphanedSessions();
        expect(result.success).toBe(true);
        expect(result.message).toBe('No sessions directory');
    });

    it('should return failure when readdirSync throws', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockImplementation(() => { throw new Error('EACCES'); });
        const result = fixOrphanedSessions();
        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed:');
    });

    it('should skip non-file entries', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['subdir']);
        mockStatSync.mockReturnValue({
            isFile: () => false,
            mtimeMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
        });
        const result = fixOrphanedSessions();
        expect(result.message).toBe('No orphaned sessions');
        expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('should clean multiple orphaned sessions', () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue(['s1.json', 's2.json', 's3.json']);
        mockStatSync.mockReturnValue({
            isFile: () => true,
            mtimeMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
        });
        const result = fixOrphanedSessions();
        expect(result.message).toBe('Cleaned 3 orphaned sessions');
        expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    });
});

// ─── runAllFixes ─────────────────────────────────────────────────

describe('runAllFixes', () => {
    it('should return an array of 8 results', () => {
        // Set up mocks for all functions to succeed
        mockExistsSync.mockReturnValue(true);
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            channels: { discord: { enabled: false } },
        });
        mockReaddirSync.mockReturnValue([]);

        const results = runAllFixes();
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(8);
    });

    it('should include results from all fix functions', () => {
        mockExistsSync.mockReturnValue(true);
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            channels: { discord: { enabled: false } },
        });
        mockReaddirSync.mockReturnValue([]);

        const results = runAllFixes();
        const actions = results.map((r) => r.action);
        expect(actions).toContain('fixMissingTitanHome');
        expect(actions).toContain('fixMissingConfig');
        expect(actions).toContain('fixInvalidConfig');
        expect(actions).toContain('fixMissingWorkspace');
        expect(actions).toContain('fixBrokenChannelConfig');
        expect(actions).toContain('fixPermissions');
        expect(actions).toContain('fixStaleLogFiles');
        expect(actions).toContain('fixOrphanedSessions');
    });

    it('should have HealResult shape for each result', () => {
        mockExistsSync.mockReturnValue(true);
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            channels: {},
        });
        mockReaddirSync.mockReturnValue([]);

        const results = runAllFixes();
        for (const r of results) {
            expect(r).toHaveProperty('action');
            expect(r).toHaveProperty('success');
            expect(r).toHaveProperty('message');
            expect(typeof r.action).toBe('string');
            expect(typeof r.success).toBe('boolean');
            expect(typeof r.message).toBe('string');
        }
    });

    it('should report mixed success/failure correctly', () => {
        // Make some things fail
        mockExistsSync.mockReturnValue(false);
        mockConfigExists.mockReturnValue(false);
        mockReaddirSync.mockReturnValue([]);

        const results = runAllFixes();
        const successes = results.filter((r) => r.success);
        const failures = results.filter((r) => !r.success);
        // At minimum fixMissingTitanHome and fixMissingWorkspace should succeed
        expect(successes.length).toBeGreaterThan(0);
        // fixInvalidConfig should fail (no config file), fixBrokenChannelConfig should fail
        expect(failures.length).toBeGreaterThan(0);
    });
});
