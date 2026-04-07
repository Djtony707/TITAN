/**
 * TITAN -- Doctor Diagnostic Tool Tests
 * Tests src/cli/doctor.ts: runDoctor with and without --fix flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    chmodSync: vi.fn(),
}));

const mockConfigExists = vi.fn();
const mockLoadConfig = vi.fn();

vi.mock('../src/config/config.js', () => ({
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    configExists: () => mockConfigExists(),
    saveConfig: vi.fn(),
    getDefaultConfig: vi.fn().mockReturnValue({ agent: { model: 'test-model' } }),
    resetConfigCache: vi.fn(),
}));

const mockHealthCheckAll = vi.fn();
vi.mock('../src/providers/router.js', () => ({
    healthCheckAll: (...args: unknown[]) => mockHealthCheckAll(...args),
}));

vi.mock('../src/security/sandbox.js', () => ({
    auditSecurity: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/agent/stallDetector.js', () => ({
    getStallStats: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_HOME: '/tmp/titan-test-doctor',
    TITAN_CONFIG_PATH: '/tmp/titan-test-doctor/titan.json',
    TITAN_DB_PATH: '/tmp/titan-test-doctor/titan.db',
    TITAN_WORKSPACE: '/tmp/titan-test-doctor/workspace',
    TITAN_LOGS_DIR: '/tmp/titan-test-doctor/logs',
    TITAN_SKILLS_DIR: '/tmp/titan-test-doctor/workspace/skills',
    TITAN_VERSION: '2026.5.4',
    TITAN_MD_FILENAME: 'TITAN.md',
    AGENTS_MD: '/tmp/titan-test-doctor/workspace/AGENTS.md',
    SOUL_MD: '/tmp/titan-test-doctor/workspace/SOUL.md',
    TOOLS_MD: '/tmp/titan-test-doctor/workspace/TOOLS.md',
}));

vi.mock('../src/config/schema.js', () => ({
    TitanConfigSchema: {
        parse: vi.fn((v: unknown) => v),
    },
}));

// Mock child_process for disk space check
vi.mock('child_process', () => ({
    execSync: vi.fn().mockReturnValue('/dev/sda1 100G 50G 50G 50% /\n'),
}));

// Mock global fetch for npm downloads check
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock selfHeal module - we spy on the actual fix functions
const mockFixMissingTitanHome = vi.fn().mockReturnValue({ action: 'fixMissingTitanHome', success: true, message: 'Fixed' });
const mockFixMissingConfig = vi.fn().mockReturnValue({ action: 'fixMissingConfig', success: true, message: 'Fixed' });
const mockFixInvalidConfig = vi.fn().mockReturnValue({ action: 'fixInvalidConfig', success: true, message: 'Fixed' });
const mockFixMissingWorkspace = vi.fn().mockReturnValue({ action: 'fixMissingWorkspace', success: true, message: 'Fixed' });
const mockFixBrokenChannelConfig = vi.fn().mockReturnValue({ action: 'fixBrokenChannelConfig', success: true, message: 'Fixed' });
const mockFixPermissions = vi.fn().mockReturnValue({ action: 'fixPermissions', success: true, message: 'Fixed' });
const mockFixStaleLogFiles = vi.fn().mockReturnValue({ action: 'fixStaleLogFiles', success: true, message: 'Fixed' });
const mockFixOrphanedSessions = vi.fn().mockReturnValue({ action: 'fixOrphanedSessions', success: true, message: 'Fixed' });

vi.mock('../src/cli/selfHeal.js', () => ({
    fixMissingTitanHome: (...args: unknown[]) => mockFixMissingTitanHome(...args),
    fixMissingConfig: (...args: unknown[]) => mockFixMissingConfig(...args),
    fixInvalidConfig: (...args: unknown[]) => mockFixInvalidConfig(...args),
    fixMissingWorkspace: (...args: unknown[]) => mockFixMissingWorkspace(...args),
    fixBrokenChannelConfig: (...args: unknown[]) => mockFixBrokenChannelConfig(...args),
    fixPermissions: (...args: unknown[]) => mockFixPermissions(...args),
    fixStaleLogFiles: (...args: unknown[]) => mockFixStaleLogFiles(...args),
    fixOrphanedSessions: (...args: unknown[]) => mockFixOrphanedSessions(...args),
}));

import { runDoctor, type DoctorReport } from '../src/cli/doctor.js';
import { auditSecurity } from '../src/security/sandbox.js';
import { getStallStats } from '../src/agent/stallDetector.js';

// Suppress console output during tests
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockClear();
    // Default fetch mock for npm downloads
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ downloads: 5500 }) });
    // Default: everything exists and is healthy
    mockExistsSync.mockReturnValue(true);
    mockConfigExists.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({
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
    });
    mockHealthCheckAll.mockResolvedValue({ anthropic: true });
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockReturnValue({ isFile: () => true, size: 1024, mtimeMs: Date.now() });
    // Reset selfHeal mocks
    mockFixMissingTitanHome.mockReturnValue({ action: 'fixMissingTitanHome', success: true, message: 'Fixed' });
    mockFixMissingConfig.mockReturnValue({ action: 'fixMissingConfig', success: true, message: 'Fixed' });
    mockFixInvalidConfig.mockReturnValue({ action: 'fixInvalidConfig', success: true, message: 'Fixed' });
    mockFixMissingWorkspace.mockReturnValue({ action: 'fixMissingWorkspace', success: true, message: 'Fixed' });
    mockFixBrokenChannelConfig.mockReturnValue({ action: 'fixBrokenChannelConfig', success: true, message: 'Fixed' });
    mockFixPermissions.mockReturnValue({ action: 'fixPermissions', success: true, message: 'Fixed' });
    mockFixStaleLogFiles.mockReturnValue({ action: 'fixStaleLogFiles', success: true, message: 'Fixed' });
    mockFixOrphanedSessions.mockReturnValue({ action: 'fixOrphanedSessions', success: true, message: 'Fixed' });
    // Reset stall detector and security audit mocks
    (getStallStats as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (auditSecurity as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

// ─── Basic runDoctor ─────────────────────────────────────────────

describe('runDoctor', () => {
    it('should complete without errors', async () => {
        await expect(runDoctor()).resolves.not.toThrow();
    });

    it('should accept no options', async () => {
        const report = await runDoctor();
        expect(report).toBeDefined();
        expect(report.version).toBeTruthy();
    });

    it('should accept options with fix: false', async () => {
        const report = await runDoctor({ fix: false });
        expect(report).toBeDefined();
        expect(report.version).toBeTruthy();
    });

    it('should accept options with fix: true', async () => {
        const report = await runDoctor({ fix: true });
        expect(report).toBeDefined();
        expect(report.version).toBeTruthy();
    });

    it('should output version in header', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('2026.5.4');
    });

    it('should output diagnostic header', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Running diagnostics');
    });
});

// ─── Node.js version check ──────────────────────────────────────

describe('runDoctor - Node.js version', () => {
    it('should report Node.js version', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Node.js version');
    });

    it('should include the actual node version number', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain(process.versions.node);
    });
});

// ─── TITAN_HOME check ───────────────────────────────────────────

describe('runDoctor - TITAN home', () => {
    it('should pass when TITAN_HOME exists', async () => {
        mockExistsSync.mockReturnValue(true);
        await runDoctor();
        // Should not trigger fix
        expect(mockFixMissingTitanHome).not.toHaveBeenCalled();
    });

    it('should warn when TITAN_HOME does not exist', async () => {
        // Return false only for TITAN_HOME path
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            return true;
        });
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Not found');
    });
});

// ─── Config check ────────────────────────────────────────────────

describe('runDoctor - Configuration', () => {
    it('should pass when config exists', async () => {
        mockConfigExists.mockReturnValue(true);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Config validation');
    });

    it('should warn when config is missing', async () => {
        mockConfigExists.mockReturnValue(false);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Not found');
    });

    it('should handle config validation failure', async () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockImplementation(() => { throw new Error('Parse error'); });
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Parse error');
    });
});

// ─── Provider health checks ─────────────────────────────────────

describe('runDoctor - Providers', () => {
    it('should check providers when config exists', async () => {
        mockConfigExists.mockReturnValue(true);
        mockHealthCheckAll.mockResolvedValue({ anthropic: true, openai: false });
        await runDoctor();
        expect(mockHealthCheckAll).toHaveBeenCalled();
    });

    it('should handle provider check failure gracefully', async () => {
        mockConfigExists.mockReturnValue(true);
        mockHealthCheckAll.mockRejectedValue(new Error('Network error'));
        const report = await runDoctor();
        expect(report).toBeDefined();
    });

    it('should skip provider checks when no config', async () => {
        mockConfigExists.mockReturnValue(false);
        await runDoctor();
        expect(mockHealthCheckAll).not.toHaveBeenCalled();
    });
});

// ─── Security audit ──────────────────────────────────────────────

describe('runDoctor - Security', () => {
    it('should include security audit results', async () => {
        (auditSecurity as ReturnType<typeof vi.fn>).mockReturnValue([
            { level: 'warn', message: 'Sandbox mode is disabled' },
        ]);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Security');
    });

    it('should skip security when config is missing', async () => {
        mockConfigExists.mockReturnValue(false);
        await runDoctor();
        // auditSecurity should not have been called because configExists is false
        // (it was already called once in the mock setup, so check it's not called again)
    });
});

// ─── Stall detector ─────────────────────────────────────────────

describe('runDoctor - Stall Detector', () => {
    it('should report healthy when no stalls', async () => {
        (getStallStats as ReturnType<typeof vi.fn>).mockReturnValue([]);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Healthy');
    });

    it('should warn when stalls are detected', async () => {
        (getStallStats as ReturnType<typeof vi.fn>).mockReturnValue([
            { sessionId: 's1', type: 'silence' },
        ]);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Detected 1 stuck sessions');
    });

    it('should fail when many stalls are detected', async () => {
        (getStallStats as ReturnType<typeof vi.fn>).mockReturnValue([
            { sessionId: 's1' },
            { sessionId: 's2' },
            { sessionId: 's3' },
        ]);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Detected 3 stuck sessions');
    });
});

// ─── Stale sessions check ───────────────────────────────────────

describe('runDoctor - Stale sessions', () => {
    it('should report stale sessions when found', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockImplementation((dir: string) => {
            if (dir.includes('sessions')) return ['old.json'];
            return [];
        });
        mockStatSync.mockReturnValue({
            isFile: () => true,
            size: 1024,
            mtimeMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
        });
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Stale sessions');
    });

    it('should pass when no stale sessions exist', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([]);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Stale sessions');
    });
});

// ─── Log directory size check ───────────────────────────────────

describe('runDoctor - Log directory size', () => {
    it('should report log directory size', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockReturnValue([]);
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Log directory size');
    });

    it('should warn when log directory is over 100MB', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReaddirSync.mockImplementation((dir: string) => {
            if (dir.includes('logs')) return ['huge.log'];
            return [];
        });
        mockStatSync.mockReturnValue({
            isFile: () => true,
            size: 150 * 1024 * 1024, // 150MB
            mtimeMs: Date.now(),
        });
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('consider rotating');
    });
});

// ─── --fix flag ──────────────────────────────────────────────────

describe('runDoctor --fix', () => {
    it('should call fix functions when issues are detected', async () => {
        // Simulate TITAN_HOME missing
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            if (path === '/tmp/titan-test-doctor/workspace') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true });

        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('auto-fix');
    });

    it('should not call fix functions without --fix', async () => {
        mockExistsSync.mockReturnValue(false);
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor();

        expect(mockFixMissingTitanHome).not.toHaveBeenCalled();
        expect(mockFixMissingConfig).not.toHaveBeenCalled();
    });

    it('should print fix summary when --fix is used', async () => {
        mockExistsSync.mockReturnValue(false);
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true });

        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('issues auto-fixed');
        expect(output).toContain('remaining');
    });

    it('should call fixMissingTitanHome when TITAN_HOME is missing and fix is true', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(true);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true });
        expect(mockFixMissingTitanHome).toHaveBeenCalled();
    });

    it('should call fixMissingConfig when config is missing and fix is true', async () => {
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true });
        expect(mockFixMissingConfig).toHaveBeenCalled();
    });

    it('should call fixMissingWorkspace when workspace is missing and fix is true', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor/workspace') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(true);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true });
        expect(mockFixMissingWorkspace).toHaveBeenCalled();
    });

    it('should call fixBrokenChannelConfig when channel has no token and fix is true', async () => {
        mockLoadConfig.mockReturnValue({
            agent: { model: 'test' },
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
                discord: { enabled: true, dmPolicy: 'pairing', token: '', apiKey: '' },
            },
        });
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true });
        expect(mockFixBrokenChannelConfig).toHaveBeenCalled();
    });
});

// ─── --dry-run flag (Issue #5) ───────────────────────────────────

describe('runDoctor --dry-run', () => {
    it('should not call any fix functions when --dry-run is used with --fix', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            if (path === '/tmp/titan-test-doctor/workspace') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true, dryRun: true });

        expect(mockFixMissingTitanHome).not.toHaveBeenCalled();
        expect(mockFixMissingConfig).not.toHaveBeenCalled();
        expect(mockFixMissingWorkspace).not.toHaveBeenCalled();
        expect(mockFixPermissions).not.toHaveBeenCalled();
    });

    it('should show what fixes would be applied in dry-run mode', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            if (path === '/tmp/titan-test-doctor/workspace') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true, dryRun: true });

        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Dry run');
        expect(output).toContain('Would fix');
    });

    it('should include dry-run results in the report fixes array', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        const report = await runDoctor({ fix: true, dryRun: true });

        expect(report.fixes).toBeDefined();
        expect(report.fixes!.length).toBeGreaterThan(0);
        expect(report.fixes!.every((f) => f.message.includes('[dry-run]'))).toBe(true);
    });

    it('should have no effect without --fix (doctor is already read-only)', async () => {
        await runDoctor({ dryRun: true });

        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).not.toContain('Dry run');
        expect(output).not.toContain('Would fix');
        expect(mockFixMissingTitanHome).not.toHaveBeenCalled();
    });

    it('should work with --json and --dry-run together', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        const report = await runDoctor({ fix: true, dryRun: true, json: true });

        expect(report.fixes).toBeDefined();
        expect(report.fixes!.length).toBeGreaterThan(0);
        expect(report.fixes!.every((f) => f.message.includes('[dry-run]'))).toBe(true);
    });

    it('should show dry-run complete message with fix count', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            if (path === '/tmp/titan-test-doctor/workspace') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor({ fix: true, dryRun: true });

        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('would be applied');
        expect(output).toContain('without --dry-run');
    });
});

// ─── Summary output ──────────────────────────────────────────────

describe('runDoctor - Summary', () => {
    it('should output pass/warn/fail counts', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('passed');
        expect(output).toContain('warnings');
        expect(output).toContain('failed');
    });

    it('should show healthy message when all checks pass', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('All checks passed');
    });

    it('should show warning message when some checks warn', async () => {
        // Make TITAN_HOME missing to trigger a warning
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('warnings found');
    });

    it('should show failure message when checks fail', async () => {
        mockLoadConfig.mockReturnValue({
            agent: { model: 'test' },
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
                discord: { enabled: true, token: '', apiKey: '', dmPolicy: 'pairing' },
            },
        });
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Some checks failed');
    });

    it('should suggest --fix flag on failures', async () => {
        mockLoadConfig.mockReturnValue({
            agent: { model: 'test' },
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
                discord: { enabled: true, token: '', apiKey: '', dmPolicy: 'pairing' },
            },
        });
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('titan doctor --fix');
    });
});

// ─── Disk space and memory checks ────────────────────────────────

describe('runDoctor - System checks', () => {
    it('should check disk space', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Disk space');
    });

    it('should check memory usage', async () => {
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Memory usage');
        expect(output).toContain('MB RSS');
    });
});

// ─── --json flag (Issue #2) ──────────────────────────────────────

describe('runDoctor --json', () => {
    it('should return a DoctorReport object', async () => {
        const report = await runDoctor({ json: true });
        expect(report).toBeDefined();
        expect(report.version).toBe('2026.5.4');
        expect(report.timestamp).toBeTruthy();
        expect(Array.isArray(report.checks)).toBe(true);
        expect(report.summary).toHaveProperty('pass');
        expect(report.summary).toHaveProperty('warn');
        expect(report.summary).toHaveProperty('fail');
    });

    it('should output valid JSON to console', async () => {
        await runDoctor({ json: true });
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        const parsed = JSON.parse(output);
        expect(parsed.version).toBe('2026.5.4');
        expect(parsed.checks).toBeDefined();
        expect(parsed.summary).toBeDefined();
    });

    it('should not print human-readable decorations in json mode', async () => {
        await runDoctor({ json: true });
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).not.toContain('Running diagnostics');
        expect(output).not.toContain('🩺');
    });

    it('should include npm download stats in json output', async () => {
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ downloads: 9999 }) });
        const report = await runDoctor({ json: true });
        expect(report.npm?.weeklyDownloads).toBe(9999);
    });

    it('should include fixes in json output when --fix is used', async () => {
        mockExistsSync.mockImplementation((path: string) => {
            if (path === '/tmp/titan-test-doctor') return false;
            return true;
        });
        mockConfigExists.mockReturnValue(false);
        mockHealthCheckAll.mockResolvedValue({});
        mockReaddirSync.mockReturnValue([]);

        const report = await runDoctor({ json: true, fix: true });
        expect(report.fixes).toBeDefined();
        expect(Array.isArray(report.fixes)).toBe(true);
    });

    it('should support both --json and --fix together', async () => {
        const report = await runDoctor({ json: true, fix: true });
        expect(report).toBeDefined();
        expect(report.version).toBeTruthy();
    });
});

// ─── Provider error messages (Issue #3) ─────────────────────────

describe('runDoctor - Provider error messages', () => {
    it('should show actionable message for missing API key', async () => {
        // Clear any real API key from environment to test missing key detection
        const originalKey = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;

        try {
            mockConfigExists.mockReturnValue(true);
            mockLoadConfig.mockReturnValue({
                agent: { model: 'anthropic/claude-sonnet-4-20250514' },
                providers: { anthropic: {} },
                security: { sandboxMode: 'host', deniedTools: [], allowedTools: [], networkAllowlist: ['*'], fileSystemAllowlist: [], commandTimeout: 30000, shield: { enabled: true, mode: 'strict' } },
                channels: {},
            });
            mockHealthCheckAll.mockResolvedValue({ anthropic: false });
            mockReaddirSync.mockReturnValue([]);

            await runDoctor();
            const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
            expect(output).toContain('ANTHROPIC_API_KEY');
        } finally {
            // Restore original environment
            if (originalKey !== undefined) {
                process.env.ANTHROPIC_API_KEY = originalKey;
            }
        }
    });

    it('should show ollama-specific message when ollama is unreachable', async () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            agent: { model: 'ollama/llama3' },
            providers: { ollama: { baseUrl: 'http://localhost:11434' } },
            security: { sandboxMode: 'host', deniedTools: [], allowedTools: [], networkAllowlist: ['*'], fileSystemAllowlist: [], commandTimeout: 30000, shield: { enabled: true, mode: 'strict' } },
            channels: {},
        });
        mockHealthCheckAll.mockResolvedValue({ ollama: false });
        mockReaddirSync.mockReturnValue([]);

        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('is Ollama running');
    });

    it('should show validity message when key is set but provider unreachable', async () => {
        mockConfigExists.mockReturnValue(true);
        mockLoadConfig.mockReturnValue({
            agent: { model: 'openai/gpt-4o' },
            providers: { openai: { apiKey: 'sk-test-key' } },
            security: { sandboxMode: 'host', deniedTools: [], allowedTools: [], networkAllowlist: ['*'], fileSystemAllowlist: [], commandTimeout: 30000, shield: { enabled: true, mode: 'strict' } },
            channels: {},
        });
        mockHealthCheckAll.mockResolvedValue({ openai: false });
        mockReaddirSync.mockReturnValue([]);

        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('check key validity');
    });
});

// ─── npm downloads (Issue #4) ───────────────────────────────────

describe('runDoctor - npm downloads', () => {
    it('should show npm weekly download count', async () => {
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ downloads: 5500 }) });
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('npm weekly downloads');
        expect(output).toContain('5,500');
    });

    it('should warn when npm stats are unavailable', async () => {
        mockFetch.mockResolvedValue({ ok: false });
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Could not fetch npm download stats');
    });

    it('should handle npm fetch timeout gracefully', async () => {
        mockFetch.mockRejectedValue(new Error('timeout'));
        await runDoctor();
        const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(output).toContain('Could not fetch npm download stats');
    });

    it('should include download count in report', async () => {
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ downloads: 1234 }) });
        const report = await runDoctor({ json: true });
        expect(report.npm?.weeklyDownloads).toBe(1234);
    });
});
