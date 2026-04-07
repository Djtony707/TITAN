/**
 * TITAN — Knowledge Base Skill Tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ─── Helpers under test (exported from skill) ────────────────────
import { chunkText, tfidfSearch } from '../src/skills/builtin/knowledge_base.js';

// ─── Mock TITAN internals so we can test tool execute functions ──
const mockTools: Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }> = new Map();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, handler: { name: string; execute: (args: Record<string, unknown>) => Promise<string> }) => {
        mockTools.set(handler.name, handler);
    },
}));

vi.mock('../src/utils/constants.js', () => {
    const testDir = join(tmpdir(), `titan-kb-test-${process.pid}`);
    return {
        TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: testDir,
        TITAN_VERSION: '0.0.0-test',
        TITAN_NAME: 'TITAN',
        TITAN_FULL_NAME: 'Test',
        TITAN_SKILLS_DIR: join(testDir, 'skills'),
        DEFAULT_GATEWAY_PORT: 48420,
        DEFAULT_MODEL: 'test/model',
    };
});

vi.mock('../src/utils/logger.js', () => ({
    default: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// ─── Setup / Teardown ────────────────────────────────────────────

let KB_ROOT: string;

beforeEach(async () => {
    mockTools.clear();
    const { TITAN_HOME } = await import('../src/utils/constants.js');
    KB_ROOT = join(TITAN_HOME, 'knowledge');
    if (existsSync(TITAN_HOME)) rmSync(TITAN_HOME, { recursive: true, force: true });
    mkdirSync(TITAN_HOME, { recursive: true });

    // Register the skill (populates mockTools)
    const { registerKnowledgeBaseSkill } = await import('../src/skills/builtin/knowledge_base.js');
    registerKnowledgeBaseSkill();
});

afterEach(async () => {
    const { TITAN_HOME } = await import('../src/utils/constants.js');
    if (existsSync(TITAN_HOME)) rmSync(TITAN_HOME, { recursive: true, force: true });
});

function exec(toolName: string, args: Record<string, unknown>): Promise<string> {
    const tool = mockTools.get(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not registered`);
    return tool.execute(args);
}

// ─── Tests ───────────────────────────────────────────────────────

describe('Knowledge Base — chunkText', () => {
    it('should return a single chunk for short text', () => {
        const chunks = chunkText('Hello world');
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe('Hello world');
    });

    it('should split long text into multiple chunks', () => {
        const words = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ');
        const chunks = chunkText(words, 500);
        expect(chunks.length).toBe(3);
        // Each chunk should have roughly 500 words (last may be shorter)
        expect(chunks[0].split(/\s+/).length).toBe(500);
        expect(chunks[1].split(/\s+/).length).toBe(500);
        expect(chunks[2].split(/\s+/).length).toBe(200);
    });

    it('should handle empty text', () => {
        const chunks = chunkText('');
        expect(chunks).toHaveLength(1);
    });
});

describe('Knowledge Base — tfidfSearch', () => {
    it('should return relevant documents', () => {
        const docs = [
            { id: '1', content: 'TypeScript is a programming language' },
            { id: '2', content: 'Python is great for machine learning' },
            { id: '3', content: 'TypeScript and JavaScript share syntax' },
        ];
        const results = tfidfSearch('TypeScript programming', docs, 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].id).toBe('1');
    });

    it('should respect the limit parameter', () => {
        const docs = Array.from({ length: 10 }, (_, i) => ({
            id: `${i}`,
            content: `document about topic ${i} with keyword search`,
        }));
        const results = tfidfSearch('keyword search', docs, 3);
        expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should return empty array for no matches', () => {
        const docs = [
            { id: '1', content: 'apples and oranges' },
        ];
        const results = tfidfSearch('xyzzyspoon', docs, 5);
        expect(results).toHaveLength(0);
    });

    it('should score exact matches higher', () => {
        const docs = [
            { id: '1', content: 'machine learning artificial intelligence' },
            { id: '2', content: 'machine learning deep learning neural networks machine learning' },
        ];
        const results = tfidfSearch('machine learning', docs, 5);
        expect(results.length).toBe(2);
        // Doc 2 has higher TF for "machine" and "learning"
        expect(results[0].id).toBe('2');
    });
});

describe('Knowledge Base — kb_ingest', () => {
    it('should ingest text content into a collection', async () => {
        const result = await exec('kb_ingest', {
            collection: 'test-docs',
            content: 'This is a test document about TITAN.',
        });
        expect(result).toContain('Ingested 1 chunk(s)');
        expect(result).toContain('test-docs');

        // Verify file exists on disk
        const files = readdirSync(join(KB_ROOT, 'test-docs'));
        expect(files.length).toBe(1);
        expect(files[0]).toMatch(/\.json$/);
    });

    it('should store metadata and source', async () => {
        await exec('kb_ingest', {
            collection: 'test-docs',
            content: 'Some content',
            source: 'https://example.com',
            metadata: { author: 'Tony', tags: ['test'] },
        });
        const files = readdirSync(join(KB_ROOT, 'test-docs'));
        const doc = JSON.parse(readFileSync(join(KB_ROOT, 'test-docs', files[0]), 'utf-8'));
        expect(doc.source).toBe('https://example.com');
        expect(doc.metadata.author).toBe('Tony');
        expect(doc.metadata.tags).toEqual(['test']);
    });

    it('should reject invalid collection names', async () => {
        const result = await exec('kb_ingest', {
            collection: 'bad name!',
            content: 'test',
        });
        expect(result).toContain('Error');
    });

    it('should chunk large content', async () => {
        const words = Array.from({ length: 1100 }, (_, i) => `word${i}`).join(' ');
        const result = await exec('kb_ingest', {
            collection: 'chunked',
            content: words,
        });
        expect(result).toContain('3 chunk(s)');
        const files = readdirSync(join(KB_ROOT, 'chunked'));
        expect(files.length).toBe(3);
    });
});

describe('Knowledge Base — kb_search', () => {
    it('should find ingested documents by keyword', async () => {
        await exec('kb_ingest', { collection: 'search-test', content: 'TITAN is an autonomous AI agent framework built in TypeScript' });
        await exec('kb_ingest', { collection: 'search-test', content: 'The weather today is sunny and warm' });

        const result = await exec('kb_search', { query: 'AI agent framework' });
        expect(result).toContain('TITAN');
        expect(result).toContain('score');
    });

    it('should filter by collection', async () => {
        await exec('kb_ingest', { collection: 'col-a', content: 'alpha content about spacecraft rockets propulsion' });
        await exec('kb_ingest', { collection: 'col-b', content: 'beta content about spacecraft rockets propulsion' });

        const result = await exec('kb_search', { query: 'spacecraft rockets propulsion', collection: 'col-a' });
        expect(result).toContain('col-a');
        expect(result).not.toContain('col-b');
    });

    it('should return no results message when empty', async () => {
        const result = await exec('kb_search', { query: 'anything' });
        expect(result).toContain('No knowledge base collections found');
    });
});

describe('Knowledge Base — kb_ingest_file', () => {
    it('should ingest a local file', async () => {
        const { TITAN_HOME } = await import('../src/utils/constants.js');
        const testFile = join(TITAN_HOME, 'test-input.txt');
        writeFileSync(testFile, 'This file contains information about distributed systems and consensus algorithms.', 'utf-8');

        const result = await exec('kb_ingest_file', { path: testFile, collection: 'file-test' });
        expect(result).toContain('Ingested file');
        expect(result).toContain('file-test');

        const files = readdirSync(join(KB_ROOT, 'file-test'));
        expect(files.length).toBeGreaterThan(0);
    });

    it('should error on missing file', async () => {
        const { TITAN_HOME } = await import('../src/utils/constants.js');
        const result = await exec('kb_ingest_file', { path: join(TITAN_HOME, 'nonexistent-file.txt'), collection: 'test' });
        expect(result).toContain('Error');
        expect(result).toContain('not found');
    });

    it('should error on empty file', async () => {
        const { TITAN_HOME } = await import('../src/utils/constants.js');
        const emptyFile = join(TITAN_HOME, 'empty.txt');
        writeFileSync(emptyFile, '', 'utf-8');
        const result = await exec('kb_ingest_file', { path: emptyFile, collection: 'test' });
        expect(result).toContain('Error');
        expect(result).toContain('empty');
    });
});

describe('Knowledge Base — kb_ingest_url', () => {
    it('should ingest content from a URL (mocked fetch)', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            text: async () => '<html><body><p>This is a test page about knowledge management systems.</p></body></html>',
        }) as unknown as typeof fetch;

        try {
            const result = await exec('kb_ingest_url', { url: 'https://example.com/test', collection: 'url-test' });
            expect(result).toContain('Ingested URL');
            expect(result).toContain('url-test');

            const files = readdirSync(join(KB_ROOT, 'url-test'));
            expect(files.length).toBeGreaterThan(0);
            const doc = JSON.parse(readFileSync(join(KB_ROOT, 'url-test', files[0]), 'utf-8'));
            expect(doc.source).toBe('https://example.com/test');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('should handle HTTP errors', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
        }) as unknown as typeof fetch;

        try {
            const result = await exec('kb_ingest_url', { url: 'https://example.com/missing', collection: 'url-test' });
            expect(result).toContain('Error');
            expect(result).toContain('404');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('Knowledge Base — kb_list', () => {
    it('should list collections with counts', async () => {
        await exec('kb_ingest', { collection: 'docs', content: 'doc content here' });
        await exec('kb_ingest', { collection: 'notes', content: 'note content here' });

        const result = await exec('kb_list', {});
        expect(result).toContain('docs');
        expect(result).toContain('notes');
        expect(result).toContain('1 document(s)');
    });

    it('should show empty message when no collections', async () => {
        const result = await exec('kb_list', {});
        expect(result).toContain('No knowledge base collections found');
    });
});

describe('Knowledge Base — kb_delete', () => {
    it('should delete an entire collection', async () => {
        await exec('kb_ingest', { collection: 'to-delete', content: 'deletable content' });
        expect(existsSync(join(KB_ROOT, 'to-delete'))).toBe(true);

        const result = await exec('kb_delete', { collection: 'to-delete' });
        expect(result).toContain('Deleted collection');
        expect(existsSync(join(KB_ROOT, 'to-delete'))).toBe(false);
    });

    it('should delete a specific document by ID', async () => {
        const ingestResult = await exec('kb_ingest', { collection: 'partial-del', content: 'first document' });
        await exec('kb_ingest', { collection: 'partial-del', content: 'second document' });

        // Extract doc ID from result
        const docId = ingestResult.match(/Document ID: ([\w-]+)/)?.[1];
        expect(docId).toBeTruthy();

        const result = await exec('kb_delete', { collection: 'partial-del', documentId: docId });
        expect(result).toContain('Deleted');

        // One doc should remain
        const remaining = readdirSync(join(KB_ROOT, 'partial-del')).filter(f => f.endsWith('.json'));
        expect(remaining.length).toBe(1);
    });

    it('should error on non-existent collection', async () => {
        const result = await exec('kb_delete', { collection: 'ghost' });
        expect(result).toContain('Error');
        expect(result).toContain('not found');
    });

    it('should error on non-existent document ID', async () => {
        await exec('kb_ingest', { collection: 'exists', content: 'content' });
        const result = await exec('kb_delete', { collection: 'exists', documentId: 'nonexistent-id' });
        expect(result).toContain('Error');
        expect(result).toContain('not found');
    });
});
