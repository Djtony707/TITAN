/**
 * TITAN — Knowledge Base Skill (Built-in)
 * Persistent, searchable knowledge collections with chunking and TF-IDF search.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join, resolve, normalize } from 'path';
import { randomUUID } from 'crypto';
import { homedir, tmpdir } from 'os';
import { registerSkill } from '../registry.js';
import { TITAN_HOME } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'KnowledgeBase';
const KB_ROOT = join(TITAN_HOME, 'knowledge');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB max ingest

/** Validate a collection name is safe (no path traversal) */
function isValidCollectionName(name: string): boolean {
    return /^[\w-]+$/.test(name) && !name.includes('..');
}

/** Block SSRF: reject internal/metadata URLs */
function isBlockedUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        // Block cloud metadata endpoints
        if (hostname === '169.254.169.254') return true;
        if (hostname === 'metadata.google.internal') return true;
        // Block loopback unless explicitly allowed
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
        // Block file:// protocol
        if (parsed.protocol === 'file:') return true;
        return false;
    } catch {
        return true; // Invalid URL = blocked
    }
}

/** Validate that a resolved file path is safe to read */
function isAllowedFilePath(filePath: string): boolean {
    const normalized = normalize(filePath);
    const home = homedir();
    const tmp = tmpdir();
    // Must be under home directory, /tmp, or OS temp directory
    if (!normalized.startsWith(home) && !normalized.startsWith('/tmp') && !normalized.startsWith(tmp)) return false;
    // Block sensitive directories
    const lowerPath = normalized.toLowerCase();
    const blocked = ['.ssh', '.gnupg', '.env', 'credentials', '.aws', '.gcloud', '.azure', '.kube', '.docker/config'];
    for (const b of blocked) {
        if (lowerPath.includes(`/${b}`) || lowerPath.includes(`${b}/`) || lowerPath.endsWith(`/${b}`)) return false;
    }
    return true;
}

// ─── Types ───────────────────────────────────────────────────────

export interface KBDocument {
    id: string;
    content: string;
    source?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    chunkIndex: number;
    totalChunks: number;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Ensure the knowledge base root and collection directory exist */
function ensureCollection(collection: string): string {
    const dir = join(KB_ROOT, collection);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

/** Split text into chunks of roughly `maxWords` words each */
export function chunkText(text: string, maxWords = 500): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return [text.trim()];

    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += maxWords) {
        chunks.push(words.slice(i, i + maxWords).join(' '));
    }
    return chunks;
}

/** Tokenize text into lowercase terms */
function tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}

/** Compute term frequency for a list of tokens */
function termFrequency(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
    }
    // Normalize by total count
    for (const [k, v] of tf) {
        tf.set(k, v / tokens.length);
    }
    return tf;
}

/** Compute IDF from a set of documents (smoothed to avoid zero for universal terms) */
function inverseDocFrequency(docs: string[][], term: string): number {
    const containing = docs.filter(d => d.includes(term)).length;
    if (containing === 0) return 0;
    return Math.log(1 + docs.length / containing);
}

/** Score documents against a query using TF-IDF */
export function tfidfSearch(
    query: string,
    documents: { id: string; content: string }[],
    limit: number,
): { id: string; score: number }[] {
    const queryTokens = tokenize(query);
    const docTokenLists = documents.map(d => tokenize(d.content));

    const scored = documents.map((doc, i) => {
        const tf = termFrequency(docTokenLists[i]);
        let score = 0;
        for (const qt of queryTokens) {
            const tfVal = tf.get(qt) || 0;
            const idfVal = inverseDocFrequency(docTokenLists, qt);
            score += tfVal * idfVal;
        }
        return { id: doc.id, score };
    });

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

/** Load all documents from a collection directory */
function loadCollection(collectionDir: string): KBDocument[] {
    if (!existsSync(collectionDir)) return [];
    const files = readdirSync(collectionDir).filter(f => f.endsWith('.json'));
    const docs: KBDocument[] = [];
    for (const file of files) {
        try {
            const raw = readFileSync(join(collectionDir, file), 'utf-8');
            docs.push(JSON.parse(raw) as KBDocument);
        } catch {
            // Skip corrupt files
        }
    }
    return docs;
}

/** Get all collection names */
function listCollections(): string[] {
    if (!existsSync(KB_ROOT)) return [];
    return readdirSync(KB_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
}

/** Convert HTML to plain text (simple) */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── Registration ────────────────────────────────────────────────

export function registerKnowledgeBaseSkill(): void {
    // 1. kb_ingest — Add content to a knowledge base
    registerSkill(
        { name: 'kb_ingest', description: 'Add content to a knowledge base', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'kb_ingest',
            description: 'Add text content to a named knowledge base collection. Content is automatically chunked for better search.\n\nUSE THIS WHEN:\n- User wants to save information for later retrieval\n- Building a knowledge base from text content\n- Storing notes, docs, or reference material',
            parameters: {
                type: 'object',
                properties: {
                    collection: { type: 'string', description: 'Knowledge base name (e.g., "project-docs", "meeting-notes")' },
                    content: { type: 'string', description: 'The text content to ingest' },
                    source: { type: 'string', description: 'Where the content came from (URL, file path, etc.)' },
                    metadata: { type: 'object', description: 'Additional metadata (tags, date, author, etc.)' },
                },
                required: ['collection', 'content'],
            },
            execute: async (args) => {
                const collection = args.collection as string;
                const content = args.content as string;
                const source = args.source as string | undefined;
                const metadata = args.metadata as Record<string, unknown> | undefined;

                if (!collection || !content) return 'Error: collection and content are required';
                if (!/^[\w-]+$/.test(collection)) return 'Error: collection name must be alphanumeric with hyphens/underscores only';

                try {
                    const dir = ensureCollection(collection);
                    const chunks = chunkText(content);
                    const docId = randomUUID();
                    const now = new Date().toISOString();
                    const ids: string[] = [];

                    for (let i = 0; i < chunks.length; i++) {
                        const doc: KBDocument = {
                            id: `${docId}-${i}`,
                            content: chunks[i],
                            source,
                            metadata,
                            createdAt: now,
                            chunkIndex: i,
                            totalChunks: chunks.length,
                        };
                        writeFileSync(join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 2), 'utf-8');
                        ids.push(doc.id);
                    }

                    logger.info(COMPONENT, `Ingested ${chunks.length} chunk(s) into "${collection}"`);
                    return `Ingested ${chunks.length} chunk(s) into collection "${collection}". Document ID: ${docId}`;
                } catch (e) {
                    return `Error ingesting content: ${(e as Error).message}`;
                }
            },
        },
    );

    // 2. kb_search — Search across knowledge bases
    registerSkill(
        { name: 'kb_search', description: 'Search knowledge bases', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'kb_search',
            description: 'Search across knowledge base collections using TF-IDF keyword matching.\n\nUSE THIS WHEN:\n- User asks about previously stored knowledge\n- Looking up information from ingested documents\n- Searching for specific topics across collections',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    collection: { type: 'string', description: 'Search specific collection (omit to search all)' },
                    limit: { type: 'number', description: 'Max results to return (default: 5)' },
                },
                required: ['query'],
            },
            execute: async (args) => {
                const query = args.query as string;
                const collection = args.collection as string | undefined;
                const limit = (args.limit as number) || 5;

                if (!query) return 'Error: query is required';
                if (collection && !isValidCollectionName(collection)) {
                    return 'Error: collection name must be alphanumeric with hyphens/underscores only';
                }

                try {
                    // Gather documents
                    const collections = collection ? [collection] : listCollections();
                    const allDocs: (KBDocument & { collection: string })[] = [];

                    for (const col of collections) {
                        const dir = join(KB_ROOT, col);
                        const docs = loadCollection(dir);
                        for (const doc of docs) {
                            allDocs.push({ ...doc, collection: col });
                        }
                    }

                    if (allDocs.length === 0) {
                        return collection
                            ? `No documents found in collection "${collection}".`
                            : 'No knowledge base collections found.';
                    }

                    // Run TF-IDF search
                    const results = tfidfSearch(
                        query,
                        allDocs.map(d => ({ id: d.id, content: d.content })),
                        limit,
                    );

                    if (results.length === 0) {
                        return `No matching results for "${query}".`;
                    }

                    // Format results
                    const lines = results.map((r, i) => {
                        const doc = allDocs.find(d => d.id === r.id)!;
                        const sourceLine = doc.source ? `\nSource: ${doc.source}` : '';
                        const metaLine = doc.metadata ? `\nMetadata: ${JSON.stringify(doc.metadata)}` : '';
                        return `### Result ${i + 1} (score: ${r.score.toFixed(4)}, collection: ${doc.collection})${sourceLine}${metaLine}\n${doc.content.slice(0, 500)}${doc.content.length > 500 ? '...' : ''}`;
                    });

                    return `Found ${results.length} result(s) for "${query}":\n\n${lines.join('\n\n')}`;
                } catch (e) {
                    return `Error searching: ${(e as Error).message}`;
                }
            },
        },
    );

    // 3. kb_ingest_url — Fetch and ingest a URL
    registerSkill(
        { name: 'kb_ingest_url', description: 'Fetch URL and add to knowledge base', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'kb_ingest_url',
            description: 'Fetch a URL, extract its text content, and add it to a knowledge base collection.\n\nUSE THIS WHEN:\n- User wants to save a webpage to their knowledge base\n- Building a knowledge base from online sources',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch' },
                    collection: { type: 'string', description: 'Knowledge base collection name' },
                },
                required: ['url', 'collection'],
            },
            execute: async (args) => {
                const url = args.url as string;
                const collection = args.collection as string;

                if (!url || !collection) return 'Error: url and collection are required';
                if (!isValidCollectionName(collection)) return 'Error: collection name must be alphanumeric with hyphens/underscores only';

                // Security: block SSRF to internal/metadata endpoints
                if (isBlockedUrl(url)) {
                    return 'Error: URL targets a blocked address (internal network, metadata service, or file:// protocol)';
                }

                try {
                    const response = await fetch(url, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TITAN Knowledge Base)' },
                        signal: AbortSignal.timeout(20000),
                    });

                    if (!response.ok) return `Error: HTTP ${response.status} fetching ${url}`;

                    const html = await response.text();
                    const text = htmlToText(html);

                    if (!text.trim()) return `Error: No text content extracted from ${url}`;

                    const dir = ensureCollection(collection);
                    const chunks = chunkText(text);
                    const docId = randomUUID();
                    const now = new Date().toISOString();

                    for (let i = 0; i < chunks.length; i++) {
                        const doc: KBDocument = {
                            id: `${docId}-${i}`,
                            content: chunks[i],
                            source: url,
                            metadata: { type: 'url', fetchedAt: now },
                            createdAt: now,
                            chunkIndex: i,
                            totalChunks: chunks.length,
                        };
                        writeFileSync(join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 2), 'utf-8');
                    }

                    logger.info(COMPONENT, `Ingested URL ${url} into "${collection}" (${chunks.length} chunks)`);
                    return `Ingested URL into "${collection}": ${chunks.length} chunk(s). Document ID: ${docId}`;
                } catch (e) {
                    return `Error fetching URL: ${(e as Error).message}`;
                }
            },
        },
    );

    // 4. kb_ingest_file — Read and ingest a local file
    registerSkill(
        { name: 'kb_ingest_file', description: 'Read file and add to knowledge base', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'kb_ingest_file',
            description: 'Read a local file and add its content to a knowledge base collection.\n\nUSE THIS WHEN:\n- User wants to add a local file to their knowledge base\n- Ingesting documents, notes, or code files',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute or relative path to the file' },
                    collection: { type: 'string', description: 'Knowledge base collection name' },
                },
                required: ['path', 'collection'],
            },
            execute: async (args) => {
                const rawPath = args.path as string;
                if (!rawPath) return 'Error: path is required';
                const filePath = resolve(rawPath);

                // Security: validate file path is within allowed directories
                if (!isAllowedFilePath(filePath)) {
                    return 'Error: File path is outside allowed directories or references a sensitive location';
                }

                const collection = args.collection as string;

                if (!collection) return 'Error: collection is required';
                if (!isValidCollectionName(collection)) return 'Error: collection name must be alphanumeric with hyphens/underscores only';
                if (!existsSync(filePath)) return 'Error: File not found';

                // Security: check file size before reading
                try {
                    const stats = statSync(filePath);
                    if (stats.size > MAX_FILE_SIZE_BYTES) {
                        return `Error: File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Maximum is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`;
                    }
                    if (!stats.isFile()) return 'Error: Path is not a regular file';
                } catch {
                    return 'Error: Cannot read file metadata';
                }

                try {
                    const content = readFileSync(filePath, 'utf-8');
                    if (!content.trim()) return 'Error: File is empty';

                    const dir = ensureCollection(collection);
                    const chunks = chunkText(content);
                    const docId = randomUUID();
                    const now = new Date().toISOString();

                    for (let i = 0; i < chunks.length; i++) {
                        const doc: KBDocument = {
                            id: `${docId}-${i}`,
                            content: chunks[i],
                            source: filePath,
                            metadata: { type: 'file', originalPath: filePath },
                            createdAt: now,
                            chunkIndex: i,
                            totalChunks: chunks.length,
                        };
                        writeFileSync(join(dir, `${doc.id}.json`), JSON.stringify(doc, null, 2), 'utf-8');
                    }

                    logger.info(COMPONENT, `Ingested file ${filePath} into "${collection}" (${chunks.length} chunks)`);
                    return `Ingested file into "${collection}": ${chunks.length} chunk(s). Document ID: ${docId}`;
                } catch (e) {
                    return `Error reading file: ${(e as Error).message}`;
                }
            },
        },
    );

    // 5. kb_list — List all collections
    registerSkill(
        { name: 'kb_list', description: 'List knowledge base collections', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'kb_list',
            description: 'List all knowledge base collections with document count and total size.\n\nUSE THIS WHEN:\n- User wants to see what knowledge bases exist\n- Checking available collections before searching',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                try {
                    const collections = listCollections();
                    if (collections.length === 0) {
                        return 'No knowledge base collections found. Use kb_ingest to create one.';
                    }

                    const lines = collections.map(col => {
                        const dir = join(KB_ROOT, col);
                        const files = readdirSync(dir).filter(f => f.endsWith('.json'));
                        let totalSize = 0;
                        for (const f of files) {
                            try {
                                totalSize += statSync(join(dir, f)).size;
                            } catch { /* skip */ }
                        }
                        const sizeStr = totalSize < 1024
                            ? `${totalSize}B`
                            : totalSize < 1048576
                                ? `${(totalSize / 1024).toFixed(1)}KB`
                                : `${(totalSize / 1048576).toFixed(1)}MB`;
                        return `- **${col}**: ${files.length} document(s), ${sizeStr}`;
                    });

                    return `Knowledge Base Collections:\n\n${lines.join('\n')}`;
                } catch (e) {
                    return `Error listing collections: ${(e as Error).message}`;
                }
            },
        },
    );

    // 6. kb_delete — Delete a collection or specific document
    registerSkill(
        { name: 'kb_delete', description: 'Delete knowledge base collection or document', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'kb_delete',
            description: 'Delete an entire knowledge base collection or a specific document within one.\n\nUSE THIS WHEN:\n- User wants to remove a collection\n- Cleaning up old or unwanted knowledge',
            parameters: {
                type: 'object',
                properties: {
                    collection: { type: 'string', description: 'Collection to delete (or delete from)' },
                    documentId: { type: 'string', description: 'Specific document ID to delete (omit to delete entire collection)' },
                },
                required: ['collection'],
            },
            execute: async (args) => {
                const collection = args.collection as string;
                const documentId = args.documentId as string | undefined;

                if (!collection || !isValidCollectionName(collection)) {
                    return 'Error: collection name must be alphanumeric with hyphens/underscores only';
                }

                // Security: validate documentId has no path traversal
                if (documentId && !/^[\w-]+$/.test(documentId)) {
                    return 'Error: documentId contains invalid characters';
                }

                const dir = join(KB_ROOT, collection);

                if (!existsSync(dir)) return `Error: Collection "${collection}" not found.`;

                try {
                    if (documentId) {
                        // Delete specific document (match by prefix for chunked docs)
                        const files = readdirSync(dir).filter(f =>
                            f.startsWith(documentId) && f.endsWith('.json'),
                        );
                        if (files.length === 0) {
                            return `Error: Document "${documentId}" not found in "${collection}".`;
                        }
                        for (const f of files) {
                            rmSync(join(dir, f));
                        }
                        logger.info(COMPONENT, `Deleted ${files.length} chunk(s) of document "${documentId}" from "${collection}"`);
                        return `Deleted ${files.length} chunk(s) of document "${documentId}" from "${collection}".`;
                    } else {
                        // Delete entire collection
                        rmSync(dir, { recursive: true, force: true });
                        logger.info(COMPONENT, `Deleted collection "${collection}"`);
                        return `Deleted collection "${collection}" and all its documents.`;
                    }
                } catch (e) {
                    return `Error deleting: ${(e as Error).message}`;
                }
            },
        },
    );

    logger.info(COMPONENT, 'Knowledge base skills registered (6 tools)');
}
