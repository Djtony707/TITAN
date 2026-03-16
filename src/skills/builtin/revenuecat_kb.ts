/**
 * TITAN — RevenueCat Knowledge Base Skill (Built-in)
 * Ingest and search RevenueCat documentation for RAG-style retrieval.
 *
 * Stores ingested chunks in ~/.titan/revenuecat-docs.json
 */
import { registerSkill } from '../registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../../utils/constants.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'RevenueCatKB';
const DOCS_PATH = join(TITAN_HOME, 'revenuecat-docs.json');

const DEFAULT_SOURCES = [
    'https://www.revenuecat.com/docs/getting-started/quickstart',
    'https://www.revenuecat.com/docs/api-v2',
    'https://www.revenuecat.com/docs/sdk-guides',
];

// ─── HTML-to-Text ────────────────────────────────────────────────

function htmlToText(html: string): string {
    return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

// ─── Chunking ────────────────────────────────────────────────────

function chunkText(text: string, size: number = 1000, overlap: number = 200): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size - overlap) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

// ─── Document Storage ────────────────────────────────────────────

interface DocChunk {
    id: string;
    text: string;
    source: string;
    url: string;
    title: string;
    ingestedAt: string;
}

function loadDocs(): DocChunk[] {
    if (!existsSync(DOCS_PATH)) return [];
    try {
        return JSON.parse(readFileSync(DOCS_PATH, 'utf-8')) as DocChunk[];
    } catch {
        return [];
    }
}

function saveDocs(docs: DocChunk[]): void {
    try {
        mkdirSync(dirname(DOCS_PATH), { recursive: true });
        writeFileSync(DOCS_PATH, JSON.stringify(docs, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save docs: ${(e as Error).message}`);
    }
}

// ─── Title Extraction ────────────────────────────────────────────

function extractTitle(html: string, url: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
    // Fallback: derive from URL path
    const path = new URL(url).pathname;
    return path.split('/').filter(Boolean).pop() || 'RevenueCat Docs';
}

// ─── Keyword Search Scoring ──────────────────────────────────────

function scoreChunk(chunk: string, queryWords: string[]): number {
    const lower = chunk.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
        const regex = new RegExp(word.toLowerCase(), 'g');
        const matches = lower.match(regex);
        if (matches) score += matches.length;
    }
    return score;
}

// ─── Skill Meta ──────────────────────────────────────────────────

const SKILL_META = {
    name: 'revenuecat_kb',
    description: 'Use this skill for ANY RevenueCat-related question — "how do subscriptions work?", "how do I set up in-app purchases?", "RevenueCat API question", "how does entitlements work?", "what\'s the RevenueCat SDK?", "how do I handle subscription events?", or "explain RevenueCat webhooks". This is the go-to knowledge base for RevenueCat documentation. Run rc_ingest first if the knowledge base is empty.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

// ─── Skill Registration ──────────────────────────────────────────

export function registerRevenueCatKBSkill(): void {
    // Tool 1: rc_ingest
    registerSkill(
        { ...SKILL_META },
        {
            name: 'rc_ingest',
            description: 'Fetch and ingest RevenueCat documentation into the local knowledge base. Use when Tony says "load the RevenueCat docs", "refresh the RevenueCat knowledge base", or when rc_search returns no results because the KB is empty. Scrapes official RevenueCat docs and stores them locally for fast retrieval.',
            parameters: {
                type: 'object',
                properties: {
                    sources: {
                        type: 'string',
                        description: 'Comma-separated URLs to ingest (optional — uses default RevenueCat doc URLs if omitted)',
                    },
                },
                required: [],
            },
            execute: async (args) => {
                const sourcesRaw = args.sources as string | undefined;
                const urls = sourcesRaw
                    ? sourcesRaw.split(',').map(s => s.trim()).filter(Boolean)
                    : DEFAULT_SOURCES;

                const existingDocs = loadDocs();
                let totalChunks = 0;
                let successCount = 0;
                const errors: string[] = [];

                for (const url of urls) {
                    try {
                        logger.info(COMPONENT, `Ingesting: ${url}`);
                        const response = await fetch(url, {
                            headers: {
                                'User-Agent': 'TITAN-Agent/1.0 (RevenueCat KB Ingester)',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            },
                        });

                        if (!response.ok) {
                            errors.push(`${url}: HTTP ${response.status}`);
                            continue;
                        }

                        const html = await response.text();
                        const title = extractTitle(html, url);
                        const text = htmlToText(html);

                        if (text.length < 50) {
                            errors.push(`${url}: Content too short (${text.length} chars)`);
                            continue;
                        }

                        // Remove old chunks from this URL before re-ingesting
                        const filtered = existingDocs.filter(d => d.url !== url);
                        existingDocs.length = 0;
                        existingDocs.push(...filtered);

                        const chunks = chunkText(text);
                        const now = new Date().toISOString();

                        for (const chunk of chunks) {
                            existingDocs.push({
                                id: uuid().slice(0, 12),
                                text: chunk,
                                source: 'revenuecat',
                                url,
                                title,
                                ingestedAt: now,
                            });
                        }

                        totalChunks += chunks.length;
                        successCount++;
                        logger.info(COMPONENT, `Ingested ${chunks.length} chunks from ${url}`);
                    } catch (e) {
                        errors.push(`${url}: ${(e as Error).message}`);
                    }
                }

                saveDocs(existingDocs);

                const lines: string[] = [
                    `Ingested ${totalChunks} chunks from ${successCount}/${urls.length} sources.`,
                    `Total knowledge base: ${existingDocs.length} chunks.`,
                ];
                if (errors.length > 0) {
                    lines.push('', 'Errors:');
                    for (const err of errors) {
                        lines.push(`  - ${err}`);
                    }
                }
                return lines.join('\n');
            },
        },
    );

    // Tool 2: rc_search
    registerSkill(
        { ...SKILL_META },
        {
            name: 'rc_search',
            description: 'Search the RevenueCat knowledge base to answer questions. Use for ANY RevenueCat-related query: "how do subscriptions work?", "how do I set up in-app purchases?", "RevenueCat API docs", "explain entitlements", "how do webhooks work in RevenueCat?", or "what SDK methods are available?". Returns the most relevant doc chunks ranked by keyword relevance.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (keywords or question about RevenueCat)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum results to return (default: 5)',
                    },
                },
                required: ['query'],
            },
            execute: async (args) => {
                const query = args.query as string;
                const limit = (args.limit as number) || 5;

                const docs = loadDocs();

                if (docs.length === 0) {
                    return 'RevenueCat knowledge base is empty. Run rc_ingest first to load documentation.';
                }

                const queryWords = query
                    .toLowerCase()
                    .split(/\s+/)
                    .filter(w => w.length > 2);

                if (queryWords.length === 0) {
                    return 'Query too short. Provide at least one keyword with 3+ characters.';
                }

                const scored = docs
                    .map(doc => ({ doc, score: scoreChunk(doc.text, queryWords) }))
                    .filter(s => s.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, limit);

                if (scored.length === 0) {
                    return `No results found for "${query}" in RevenueCat knowledge base (${docs.length} chunks indexed).`;
                }

                const lines: string[] = [
                    `RevenueCat KB search: "${query}" (${scored.length} results from ${docs.length} chunks)`,
                    '',
                ];

                for (let i = 0; i < scored.length; i++) {
                    const { doc, score } = scored[i];
                    lines.push(`--- Result ${i + 1} (score: ${score}) ---`);
                    lines.push(`Source: ${doc.url}`);
                    lines.push(`Title: ${doc.title}`);
                    lines.push(`Ingested: ${doc.ingestedAt}`);
                    lines.push(doc.text.slice(0, 600));
                    lines.push('');
                }

                return lines.join('\n');
            },
        },
    );
}
