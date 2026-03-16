/**
 * TITAN — RAG Skill (Built-in)
 * Retrieval-Augmented Generation: ingest documents, search by semantic similarity,
 * list ingested documents, and delete them.
 */
import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { registerSkill } from '../registry.js';
import {
    isVectorSearchAvailable,
    ragIngest,
    ragSearch,
    ragListDocuments,
    ragDeleteDocument,
} from '../../memory/vectors.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'RAG';

/** Fetch URL content with timeout */
async function fetchUrl(url: string): Promise<string> {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'TITAN/1.0 (RAG Ingestion)' },
        signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
        const html = await response.text();
        // Strip HTML tags for plain text extraction
        return html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    return response.text();
}

export function registerRagSkill(): void {
    // ── rag_ingest ────────────────────────────────────────────────
    registerSkill(
        { name: 'rag_ingest', description: 'Use this when the user says "add this to your knowledge", "remember this document", "learn from this file", "save this to your knowledge base", or pastes text they want TITAN to be able to recall later.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'rag_ingest',
            description: 'Add a document, file, URL, or raw text to TITAN\'s knowledge base so it can be recalled later with semantic search. Use this when asked to "add this to your knowledge", "remember this document", "save this page", "learn from this file", or when the user pastes content they want TITAN to reference in future conversations. Supports text, markdown, code files, and web URLs.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'File path or URL to ingest' },
                    title: { type: 'string', description: 'Document title (optional, defaults to filename)' },
                    content: { type: 'string', description: 'Raw text content to ingest directly (use instead of source)' },
                    chunkSize: { type: 'number', description: 'Chunk size in characters (default: 1000)' },
                    chunkOverlap: { type: 'number', description: 'Overlap between chunks in characters (default: 200)' },
                },
            },
            execute: async (args) => {
                if (!isVectorSearchAvailable()) {
                    return 'RAG is unavailable. Enable vector search in config (memory.vectorSearchEnabled=true) and ensure Ollama is running with an embedding model.';
                }

                const source = args.source as string | undefined;
                const rawContent = args.content as string | undefined;
                const chunkSize = args.chunkSize as number | undefined;
                const chunkOverlap = args.chunkOverlap as number | undefined;

                if (!source && !rawContent) {
                    return 'Error: provide either "source" (file path or URL) or "content" (raw text).';
                }

                let content: string;
                let sourceType: 'file' | 'url' | 'text';
                let sourcePath: string;
                let title = args.title as string | undefined;

                if (rawContent) {
                    content = rawContent;
                    sourceType = 'text';
                    sourcePath = 'direct-input';
                    title = title || 'Direct Input';
                } else if (source!.startsWith('http://') || source!.startsWith('https://')) {
                    try {
                        logger.info(COMPONENT, `Fetching URL: ${source}`);
                        content = await fetchUrl(source!);
                    } catch (e) {
                        return `Error fetching URL: ${(e as Error).message}`;
                    }
                    sourceType = 'url';
                    sourcePath = source!;
                    title = title || source!;
                } else {
                    if (!existsSync(source!)) {
                        return `Error: file not found: ${source}`;
                    }
                    try {
                        content = readFileSync(source!, 'utf-8');
                    } catch (e) {
                        return `Error reading file: ${(e as Error).message}`;
                    }
                    sourceType = 'file';
                    sourcePath = source!;
                    title = title || basename(source!);
                }

                if (content.trim().length === 0) {
                    return 'Error: document content is empty.';
                }

                const result = await ragIngest(sourcePath, title!, content, sourceType, chunkSize, chunkOverlap);

                if (!result.success) {
                    return `Ingestion failed: ${result.error}`;
                }

                return `Ingested "${title}" successfully.\n- Document ID: ${result.docId}\n- Chunks: ${result.chunks}\n- Source: ${sourcePath}`;
            },
        },
    );

    // ── rag_search ────────────────────────────────────────────────
    registerSkill(
        { name: 'rag_search', description: 'Use this when the user says "search your knowledge base", "what do you know about X", "find in your documents", "look that up in your notes", or any question that might be answered by previously ingested content.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'rag_search',
            description: 'Search TITAN\'s knowledge base using semantic similarity. Use this when asked "what do you know about X?", "search your documents for Y", "look that up in your notes", "find in your knowledge base", or any question that could be answered by previously stored documents. Returns the most relevant chunks. Always try this before saying you don\'t know something.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to search for (natural language or keywords)' },
                    topK: { type: 'number', description: 'Number of results to return (default: 5)' },
                    minScore: { type: 'number', description: 'Minimum similarity score 0-1 (default: 0.3)' },
                },
                required: ['query'],
            },
            execute: async (args) => {
                if (!isVectorSearchAvailable()) {
                    return 'RAG is unavailable. Enable vector search in config and ensure Ollama is running.';
                }

                const query = args.query as string;
                const topK = (args.topK as number) || 5;
                const minScore = (args.minScore as number) || 0.3;

                const results = await ragSearch(query, topK, minScore);

                if (results.length === 0) {
                    return `No relevant documents found for: "${query}"`;
                }

                return results.map((r, i) =>
                    `**${i + 1}. ${r.title}** (score: ${r.score.toFixed(3)})\n${r.text.slice(0, 500)}${r.text.length > 500 ? '...' : ''}`
                ).join('\n\n---\n\n');
            },
        },
    );

    // ── rag_list ──────────────────────────────────────────────────
    registerSkill(
        { name: 'rag_list', description: 'Use this when asked "what\'s in your knowledge base?", "show me your documents", or "what have you learned?"', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'rag_list',
            description: 'Show all documents currently stored in TITAN\'s knowledge base. Use when asked "what\'s in your knowledge base?", "show me your documents", "what have you saved?", or "what do you know about?"',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                const docs = ragListDocuments();

                if (docs.length === 0) {
                    return 'No documents ingested yet. Use rag_ingest to add documents.';
                }

                const lines = docs.map((d, i) =>
                    `${i + 1}. **${d.title}**\n   ID: ${d.id}\n   Source: ${d.sourcePath} (${d.sourceType})\n   Chunks: ${d.chunkCount} | Size: ${(d.totalChars / 1024).toFixed(1)}KB\n   Ingested: ${d.ingestedAt}`
                );

                return `**RAG Documents (${docs.length})**\n\n${lines.join('\n\n')}`;
            },
        },
    );

    // ── rag_delete ────────────────────────────────────────────────
    registerSkill(
        { name: 'rag_delete', description: 'Use this when asked to "remove that document", "forget that file", or "delete from your knowledge base".', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'rag_delete',
            description: 'Remove a document from TITAN\'s knowledge base. Use when asked to "remove that document", "forget that file", "delete from your knowledge base", or "stop using that source".',
            parameters: {
                type: 'object',
                properties: {
                    docId: { type: 'string', description: 'The document ID to delete (get this from rag_list)' },
                },
                required: ['docId'],
            },
            execute: async (args) => {
                const docId = args.docId as string;
                if (!docId) return 'Error: docId is required.';

                const deleted = ragDeleteDocument(docId);
                if (!deleted) {
                    return `Document "${docId}" not found. Use rag_list to see available documents.`;
                }

                return `Document "${docId}" and all its chunks have been deleted.`;
            },
        },
    );
}
