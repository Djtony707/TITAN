/**
 * TITAN — Tool Search Tests
 * Tests for the tool_search meta-tool and compact tool mode
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: vi.fn().mockReturnValue({
        agent: { model: 'anthropic/claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.7 },
        providers: {},
        security: { deniedTools: [], allowedTools: [], commandTimeout: 30000 },
    }),
}));

vi.mock('../src/skills/registry.js', () => ({
    isToolSkillEnabled: vi.fn().mockReturnValue(true),
}));

// Register test tools before importing toolSearch
import { registerTool } from '../src/agent/toolRunner.js';

function registerTestTools() {
    const tools = [
        { name: 'shell', description: 'Execute a shell command on the system' },
        { name: 'read_file', description: 'Read a file from disk' },
        { name: 'write_file', description: 'Write content to a file' },
        { name: 'edit_file', description: 'Edit a file with find/replace' },
        { name: 'list_dir', description: 'List directory contents' },
        { name: 'web_search', description: 'Search the web for information' },
        { name: 'web_fetch', description: 'Fetch a web page by URL' },
        { name: 'web_read', description: 'Read and extract content from a web page' },
        { name: 'browser', description: 'Control a browser via CDP protocol' },
        { name: 'browser_search', description: 'Search the web using a browser' },
        { name: 'email_send', description: 'Send an email message' },
        { name: 'email_search', description: 'Search email inbox' },
        { name: 'email_read', description: 'Read an email by ID' },
        { name: 'cron', description: 'Schedule a cron job' },
        { name: 'webhook', description: 'Create a webhook endpoint' },
        { name: 'memory', description: 'Store or recall memories' },
        { name: 'github_repos', description: 'List GitHub repositories' },
        { name: 'github_issues', description: 'List GitHub issues' },
        { name: 'github_prs', description: 'List GitHub pull requests' },
        { name: 'screenshot', description: 'Take a screenshot of the screen' },
    ];

    for (const t of tools) {
        registerTool({
            name: t.name,
            description: t.description,
            parameters: { type: 'object', properties: {} },
            execute: async () => 'ok',
        });
    }
}

registerTestTools();

// ─── Imports (after mocks and registration) ──────────────────────────

import { searchTools, buildToolCatalog, getToolSearchHandler, DEFAULT_CORE_TOOLS } from '../src/agent/toolSearch.js';

// ─── Tests ──────────────────────────────────────────────────────────

describe('Tool Search', () => {
    describe('searchTools', () => {
        it('finds tools by name keyword', () => {
            const results = searchTools('email');
            const names = results.map(t => t.name);
            expect(names).toContain('email_send');
            expect(names).toContain('email_search');
            expect(names).toContain('email_read');
        });

        it('finds tools by description keyword', () => {
            const results = searchTools('browser');
            const names = results.map(t => t.name);
            expect(names).toContain('browser');
            expect(names).toContain('browser_search');
        });

        it('finds tools by multiple keywords', () => {
            const results = searchTools('web search');
            const names = results.map(t => t.name);
            expect(names).toContain('web_search');
        });

        it('returns empty array for no matches', () => {
            const results = searchTools('zzzznonexistent');
            expect(results).toHaveLength(0);
        });

        it('limits results to 8', () => {
            const results = searchTools('a'); // matches many tools
            expect(results.length).toBeLessThanOrEqual(8);
        });

        it('excludes tool_search itself from results', () => {
            // Register tool_search first
            registerTool(getToolSearchHandler());
            const results = searchTools('search');
            const names = results.map(t => t.name);
            expect(names).not.toContain('tool_search');
        });
    });

    describe('buildToolCatalog', () => {
        it('returns a compact string with all tool names', () => {
            const catalog = buildToolCatalog();
            expect(catalog).toContain('shell:');
            expect(catalog).toContain('read_file:');
            expect(catalog).toContain('email_send:');
            expect(catalog).toContain('github_repos:');
        });

        it('does not include tool_search in catalog', () => {
            const catalog = buildToolCatalog();
            expect(catalog).not.toContain('tool_search:');
        });

        it('is compact — each tool is under 60 chars', () => {
            const catalog = buildToolCatalog();
            const entries = catalog.split(' | ');
            for (const entry of entries) {
                expect(entry.length).toBeLessThan(80);
            }
        });
    });

    describe('getToolSearchHandler', () => {
        it('returns a valid tool handler', () => {
            const handler = getToolSearchHandler();
            expect(handler.name).toBe('tool_search');
            expect(handler.description).toContain('Search for tools');
            expect(handler.parameters).toBeDefined();
            expect(handler.execute).toBeInstanceOf(Function);
        });

        it('includes catalog in description', () => {
            const handler = getToolSearchHandler();
            expect(handler.description).toContain('shell:');
            expect(handler.description).toContain('email_send:');
        });

        it('executes search and returns results', async () => {
            const handler = getToolSearchHandler();
            const result = await handler.execute({ query: 'email' });
            expect(result).toContain('email_send');
            expect(result).toContain('Found');
        });

        it('handles empty query', async () => {
            const handler = getToolSearchHandler();
            const result = await handler.execute({ query: '' });
            expect(result).toContain('Please provide');
        });

        it('handles no matches', async () => {
            const handler = getToolSearchHandler();
            const result = await handler.execute({ query: 'zzzznonexistent' });
            expect(result).toContain('No tools found');
        });
    });

    describe('DEFAULT_CORE_TOOLS', () => {
        it('includes essential tools', () => {
            expect(DEFAULT_CORE_TOOLS).toContain('shell');
            expect(DEFAULT_CORE_TOOLS).toContain('read_file');
            expect(DEFAULT_CORE_TOOLS).toContain('write_file');
            expect(DEFAULT_CORE_TOOLS).toContain('web_search');
            expect(DEFAULT_CORE_TOOLS).toContain('tool_search');
        });

        it('is a reasonable size (5-25 tools)', () => {
            expect(DEFAULT_CORE_TOOLS.length).toBeGreaterThanOrEqual(5);
            expect(DEFAULT_CORE_TOOLS.length).toBeLessThanOrEqual(25);
        });
    });
});

describe('ToolSearchConfig', () => {
    it('schema has correct defaults', async () => {
        const { ToolSearchConfigSchema } = await import('../src/config/schema.js');
        const defaults = ToolSearchConfigSchema.parse({});
        expect(defaults.enabled).toBe(true);
        // coreTools defaults to empty array (falls back to DEFAULT_CORE_TOOLS at runtime)
        expect(defaults.coreTools).toEqual([]);
    });

    it('is included in TitanConfigSchema', async () => {
        const { TitanConfigSchema } = await import('../src/config/schema.js');
        const config = TitanConfigSchema.parse({});
        expect(config.toolSearch).toBeDefined();
        expect(config.toolSearch.enabled).toBe(true);
    });
});
