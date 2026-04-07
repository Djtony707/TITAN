/**
 * TITAN — Web Fetch Skill Tests
 * Tests htmlToText, htmlToMarkdown, isInternalUrl helper functions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-webfetch',
    TITAN_VERSION: '2026.4.33',
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        security: { deniedTools: [], allowedTools: [] },
    }),
}));

describe('Web Fetch Skill', () => {
    let webFetchHandler: any;

    beforeEach(async () => {
        vi.resetModules();
        vi.doMock('../src/utils/logger.js', () => ({
            default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        }));
        vi.doMock('../src/utils/constants.js', () => ({
            TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-webfetch',
            TITAN_VERSION: '2026.4.33',
        }));
        vi.doMock('../src/config/config.js', () => ({
            loadConfig: vi.fn().mockReturnValue({
                security: { deniedTools: [], allowedTools: [] },
            }),
        }));
        vi.doMock('../src/skills/registry.js', () => ({
            registerSkill: vi.fn().mockImplementation((_meta: any, handler: any) => {
                webFetchHandler = handler;
            }),
        }));

        const { registerWebFetchSkill } = await import('../src/skills/builtin/web_fetch.js');
        registerWebFetchSkill();
    });

    it('should register the web_fetch handler', () => {
        expect(webFetchHandler).toBeDefined();
        expect(webFetchHandler.name).toBe('web_fetch');
    });

    it('should block localhost URLs (SSRF protection)', async () => {
        const result = await webFetchHandler.execute({ url: 'http://localhost:8080/secret' });
        expect(result).toContain('not permitted');
    });

    it('should block 127.0.0.1 URLs', async () => {
        const result = await webFetchHandler.execute({ url: 'http://127.0.0.1/admin' });
        expect(result).toContain('not permitted');
    });

    it('should block 10.x.x.x private IPs', async () => {
        const result = await webFetchHandler.execute({ url: 'http://10.0.0.1/api' });
        expect(result).toContain('not permitted');
    });

    it('should block 192.168.x.x private IPs', async () => {
        const result = await webFetchHandler.execute({ url: 'http://192.168.1.1/admin' });
        expect(result).toContain('not permitted');
    });

    it('should block 172.16.x.x private IPs', async () => {
        const result = await webFetchHandler.execute({ url: 'http://172.16.0.1/internal' });
        expect(result).toContain('not permitted');
    });

    it('should block 169.254.x.x link-local IPs', async () => {
        const result = await webFetchHandler.execute({ url: 'http://169.254.169.254/metadata' });
        expect(result).toContain('not permitted');
    });

    it('should block IPv6 loopback', async () => {
        const result = await webFetchHandler.execute({ url: 'http://[::1]/admin' });
        expect(result).toContain('not permitted');
    });

    it('should block unparseable URLs', async () => {
        const result = await webFetchHandler.execute({ url: 'not-a-valid-url' });
        // Either treated as internal or will fail with an error
        expect(result).toMatch(/not permitted|Error/);
    });

    it('should have required parameters', () => {
        expect(webFetchHandler.parameters.properties.url).toBeDefined();
        expect(webFetchHandler.parameters.required).toContain('url');
    });
});
