/**
 * TITAN — Local Vector Search
 * Semantic memory search using Ollama embeddings. Zero external dependencies.
 * Stores vectors in ~/.titan/vectors.json. Searches by cosine similarity.
 *
 * This is Tier 2 of the 3-tier memory architecture:
 *   Tier 1: Working memory (SOUL.md, profile, session history)
 *   Tier 2: Semantic vector search (this module) — long-term recall
 *   Tier 3: Deterministic storage (JSON key-value / structured data)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Vectors';
const TITAN_HOME = join(homedir(), '.titan');
const VECTORS_PATH = join(TITAN_HOME, 'vectors.json');
const MAX_VECTORS = 10000;
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

// ── Data Model ──────────────────────────────────────────────────────

interface VectorEntry {
    id: string;
    text: string;
    vector: number[];
    source: string;         // 'memory' | 'graph' | 'learning' | 'conversation'
    metadata?: string;       // JSON-encoded metadata
    createdAt: string;
}

interface VectorStore {
    entries: VectorEntry[];
    model: string;           // Embedding model used (if model changes, re-embed)
    dimensions: number;
}

interface SearchResult {
    id: string;
    text: string;
    source: string;
    score: number;           // Cosine similarity (0-1)
    metadata?: string;
}

// ── State ───────────────────────────────────────────────────────────

let store: VectorStore | null = null;
let available = false;
let embeddingBaseUrl = '';
let embeddingModel = DEFAULT_EMBEDDING_MODEL;

// ── Persistence ─────────────────────────────────────────────────────

function loadVectorStore(): VectorStore {
    if (store) return store;
    mkdirSync(TITAN_HOME, { recursive: true });

    if (existsSync(VECTORS_PATH)) {
        try {
            const raw = readFileSync(VECTORS_PATH, 'utf-8');
            store = JSON.parse(raw) as VectorStore;
            store.entries = store.entries || [];
        } catch {
            logger.warn(COMPONENT, 'Could not load vector store, creating fresh');
            store = { entries: [], model: embeddingModel, dimensions: 0 };
        }
    } else {
        store = { entries: [], model: embeddingModel, dimensions: 0 };
    }
    return store;
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(): void {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        if (!store) return;
        try {
            writeFileSync(VECTORS_PATH, JSON.stringify(store), 'utf-8');
        } catch (e) {
            logger.error(COMPONENT, `Failed to save vectors: ${(e as Error).message}`);
        }
    }, 2000);
}

// ── Ollama Embedding API ────────────────────────────────────────────

/** Generate embeddings via Ollama's /api/embed endpoint */
async function embed(text: string): Promise<number[] | null> {
    if (!available) return null;

    try {
        const response = await fetch(`${embeddingBaseUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: embeddingModel,
                input: text.slice(0, 8000), // Limit input size
            }),
        });

        if (!response.ok) {
            logger.warn(COMPONENT, `Embedding API returned ${response.status}`);
            return null;
        }

        const data = await response.json() as { embeddings?: number[][] };
        if (data.embeddings && data.embeddings[0]) {
            return data.embeddings[0];
        }
        return null;
    } catch (e) {
        logger.debug(COMPONENT, `Embedding failed: ${(e as Error).message}`);
        return null;
    }
}

// ── Cosine Similarity ───────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

// ── Public API ──────────────────────────────────────────────────────

/** Initialize the vector search system. Checks Ollama availability. */
export async function initVectors(): Promise<boolean> {
    const config = loadConfig();
    const memConfig = config.memory as { vectorSearchEnabled?: boolean; embeddingModel?: string };

    if (!memConfig.vectorSearchEnabled) {
        logger.info(COMPONENT, 'Vector search disabled in config');
        return false;
    }

    // Use Ollama provider's baseUrl
    embeddingBaseUrl = config.providers.ollama?.baseUrl || 'http://localhost:11434';
    embeddingModel = memConfig.embeddingModel || DEFAULT_EMBEDDING_MODEL;

    // Test connectivity
    try {
        const resp = await fetch(`${embeddingBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        // Check if embedding model is available
        const data = await resp.json() as { models?: Array<{ name: string }> };
        const models = data.models || [];
        const hasModel = models.some(m => m.name.startsWith(embeddingModel));

        if (!hasModel) {
            logger.warn(COMPONENT, `Embedding model "${embeddingModel}" not found on Ollama. Run: ollama pull ${embeddingModel}`);
            // Try to pull it
            logger.info(COMPONENT, `Attempting to pull ${embeddingModel}...`);
            try {
                await fetch(`${embeddingBaseUrl}/api/pull`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: embeddingModel, stream: false }),
                    signal: AbortSignal.timeout(120000),
                });
                logger.info(COMPONENT, `Pulled ${embeddingModel} successfully`);
            } catch {
                logger.warn(COMPONENT, `Could not auto-pull ${embeddingModel}. Vector search unavailable.`);
                return false;
            }
        }

        // Test embedding — call Ollama directly (cannot use embed() here since available=false)
        const testResp = await fetch(`${embeddingBaseUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: embeddingModel, input: 'test' }),
            signal: AbortSignal.timeout(10000),
        });
        if (!testResp.ok) {
            logger.warn(COMPONENT, `Embedding test failed (HTTP ${testResp.status})`);
            return false;
        }
        const testData = await testResp.json() as { embeddings?: number[][] };
        if (!testData.embeddings?.[0]) {
            logger.warn(COMPONENT, 'Embedding test failed (no vector returned)');
            return false;
        }

        available = true;
        loadVectorStore();

        // Check if model changed (need to re-embed)
        if (store && store.model !== embeddingModel && store.entries.length > 0) {
            logger.warn(COMPONENT, `Embedding model changed (${store.model} → ${embeddingModel}). Vector store will be rebuilt.`);
            store.entries = [];
            store.model = embeddingModel;
        }
        const dims = testData.embeddings![0].length;
        if (store) {
            store.model = embeddingModel;
            store.dimensions = dims;
        }

        logger.info(COMPONENT, `Vector search ready: ${store?.entries.length || 0} vectors, ${dims}d, model=${embeddingModel}`);
        return true;
    } catch (e) {
        logger.info(COMPONENT, `Ollama not available for vector search: ${(e as Error).message}`);
        return false;
    }
}

/** Check if vector search is available */
export function isVectorSearchAvailable(): boolean {
    return available;
}

/** Add text to the vector store */
export async function addVector(
    id: string,
    text: string,
    source: string,
    metadata?: Record<string, unknown>,
): Promise<boolean> {
    if (!available) return false;
    const s = loadVectorStore();

    // Skip if already exists with same text
    const existing = s.entries.find(e => e.id === id);
    if (existing && existing.text === text) return true;

    const vector = await embed(text);
    if (!vector) return false;

    // Update or insert
    if (existing) {
        existing.text = text;
        existing.vector = vector;
        existing.metadata = metadata ? JSON.stringify(metadata) : undefined;
    } else {
        s.entries.push({
            id,
            text,
            vector,
            source,
            metadata: metadata ? JSON.stringify(metadata) : undefined,
            createdAt: new Date().toISOString(),
        });
    }

    // Cap size
    if (s.entries.length > MAX_VECTORS) {
        s.entries = s.entries.slice(-MAX_VECTORS);
    }

    debouncedSave();
    return true;
}

/** Search vectors by semantic similarity */
export async function searchVectors(
    query: string,
    limit: number = 10,
    source?: string,
    minScore: number = 0.3,
): Promise<SearchResult[]> {
    if (!available) return [];
    const s = loadVectorStore();
    if (s.entries.length === 0) return [];

    const queryVec = await embed(query);
    if (!queryVec) return [];

    let candidates = s.entries;
    if (source) {
        candidates = candidates.filter(e => e.source === source);
    }

    const scored = candidates
        .map(entry => ({
            id: entry.id,
            text: entry.text,
            source: entry.source,
            score: cosineSimilarity(queryVec, entry.vector),
            metadata: entry.metadata,
        }))
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return scored;
}

/** Remove a vector by ID */
export function removeVector(id: string): boolean {
    if (!store) return false;
    const before = store.entries.length;
    store.entries = store.entries.filter(e => e.id !== id);
    if (store.entries.length < before) {
        debouncedSave();
        return true;
    }
    return false;
}

/** Get vector store stats */
export function getVectorStats(): {
    available: boolean;
    model: string;
    dimensions: number;
    vectorCount: number;
    bySource: Record<string, number>;
} {
    const s = store || { entries: [], model: embeddingModel, dimensions: 0 };
    const bySource: Record<string, number> = {};
    for (const e of s.entries) {
        bySource[e.source] = (bySource[e.source] || 0) + 1;
    }
    return {
        available,
        model: s.model,
        dimensions: s.dimensions,
        vectorCount: s.entries.length,
        bySource,
    };
}

/** Flush and save immediately */
export function flushVectors(): void {
    if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
    if (store) {
        try {
            writeFileSync(VECTORS_PATH, JSON.stringify(store), 'utf-8');
        } catch { /* ignore */ }
    }
}

// ── RAG Document Management ─────────────────────────────────────────

const RAG_DOCS_PATH = join(TITAN_HOME, 'rag-documents.json');
const RAG_SOURCE = 'rag';
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

export interface RAGDocument {
    id: string;
    title: string;
    sourceType: 'file' | 'url' | 'text';
    sourcePath: string;
    chunkCount: number;
    totalChars: number;
    ingestedAt: string;
}

interface RAGDocStore {
    documents: RAGDocument[];
}

let ragDocStore: RAGDocStore | null = null;

function loadRagDocStore(): RAGDocStore {
    if (ragDocStore) return ragDocStore;
    mkdirSync(TITAN_HOME, { recursive: true });
    if (existsSync(RAG_DOCS_PATH)) {
        try {
            ragDocStore = JSON.parse(readFileSync(RAG_DOCS_PATH, 'utf-8')) as RAGDocStore;
            ragDocStore.documents = ragDocStore.documents || [];
        } catch {
            ragDocStore = { documents: [] };
        }
    } else {
        ragDocStore = { documents: [] };
    }
    return ragDocStore;
}

function saveRagDocStore(): void {
    if (!ragDocStore) return;
    try {
        writeFileSync(RAG_DOCS_PATH, JSON.stringify(ragDocStore, null, 2), 'utf-8');
    } catch (e) {
        logger.error(COMPONENT, `Failed to save RAG doc store: ${(e as Error).message}`);
    }
}

/** Split text into overlapping chunks */
export function chunkText(
    text: string,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
    overlap: number = DEFAULT_CHUNK_OVERLAP,
): string[] {
    if (text.length <= chunkSize) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        let end = start + chunkSize;
        // Try to break at paragraph or sentence boundary
        if (end < text.length) {
            const paragraphBreak = text.lastIndexOf('\n\n', end);
            if (paragraphBreak > start + chunkSize / 2) {
                end = paragraphBreak + 2;
            } else {
                const sentenceBreak = text.lastIndexOf('. ', end);
                if (sentenceBreak > start + chunkSize / 2) {
                    end = sentenceBreak + 2;
                }
            }
        }
        chunks.push(text.slice(start, end).trim());
        start = end - overlap;
        if (start >= text.length) break;
    }
    return chunks.filter(c => c.length > 0);
}

/** Extract text content from various file types */
function extractText(content: string, filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
        case 'md':
        case 'markdown':
            // Strip markdown formatting for better embedding
            return content
                .replace(/^#{1,6}\s+/gm, '')
                .replace(/\*\*([^*]+)\*\*/g, '$1')
                .replace(/\*([^*]+)\*/g, '$1')
                .replace(/`{3}[\s\S]*?`{3}/g, (match) => match)  // keep code blocks
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .trim();
        case 'json':
            try {
                return JSON.stringify(JSON.parse(content), null, 2);
            } catch {
                return content;
            }
        default:
            return content;
    }
}

/** Ingest a document into the RAG vector store */
export async function ragIngest(
    sourcePath: string,
    title: string,
    content: string,
    sourceType: 'file' | 'url' | 'text' = 'file',
    chunkSize?: number,
    chunkOverlap?: number,
): Promise<{ success: boolean; docId: string; chunks: number; error?: string }> {
    if (!available) {
        return { success: false, docId: '', chunks: 0, error: 'Vector search not available. Enable it in config and ensure Ollama is running.' };
    }

    const docId = `rag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const processedText = extractText(content, sourcePath);
    const chunks = chunkText(processedText, chunkSize || DEFAULT_CHUNK_SIZE, chunkOverlap || DEFAULT_CHUNK_OVERLAP);

    logger.info(COMPONENT, `RAG ingest: "${title}" — ${chunks.length} chunks from ${sourcePath}`);

    let ingestedCount = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${docId}_chunk_${i}`;
        const metadata = { docId, title, sourcePath, sourceType, chunkIndex: i, totalChunks: chunks.length };
        const ok = await addVector(chunkId, chunks[i], RAG_SOURCE, metadata);
        if (ok) ingestedCount++;
    }

    if (ingestedCount === 0) {
        return { success: false, docId, chunks: 0, error: 'Failed to embed any chunks. Check Ollama connectivity.' };
    }

    // Record document metadata
    const docs = loadRagDocStore();
    docs.documents.push({
        id: docId,
        title,
        sourceType,
        sourcePath,
        chunkCount: ingestedCount,
        totalChars: processedText.length,
        ingestedAt: new Date().toISOString(),
    });
    saveRagDocStore();

    logger.info(COMPONENT, `RAG ingest complete: ${ingestedCount}/${chunks.length} chunks for "${title}"`);
    return { success: true, docId, chunks: ingestedCount };
}

/** Search RAG documents by semantic similarity */
export async function ragSearch(
    query: string,
    topK: number = 5,
    minScore: number = 0.3,
): Promise<Array<{ text: string; score: number; docId: string; title: string; chunkIndex: number }>> {
    const results = await searchVectors(query, topK, RAG_SOURCE, minScore);
    return results.map(r => {
        let meta = { docId: '', title: '', chunkIndex: 0 };
        try {
            if (r.metadata) meta = JSON.parse(r.metadata);
        } catch { /* ignore */ }
        return {
            text: r.text,
            score: r.score,
            docId: meta.docId || r.id,
            title: meta.title || 'Unknown',
            chunkIndex: meta.chunkIndex || 0,
        };
    });
}

/** List all ingested RAG documents */
export function ragListDocuments(): RAGDocument[] {
    return loadRagDocStore().documents;
}

/** Delete a RAG document and all its chunks */
export function ragDeleteDocument(docId: string): boolean {
    const docs = loadRagDocStore();
    const docIndex = docs.documents.findIndex(d => d.id === docId);
    if (docIndex < 0) return false;

    const doc = docs.documents[docIndex];

    // Remove all chunks from vector store
    if (store) {
        store.entries = store.entries.filter(e => {
            if (e.source !== RAG_SOURCE) return true;
            try {
                const meta = JSON.parse(e.metadata || '{}');
                return meta.docId !== docId;
            } catch {
                return !e.id.startsWith(docId);
            }
        });
        debouncedSave();
    }

    // Remove from doc store
    docs.documents.splice(docIndex, 1);
    saveRagDocStore();

    logger.info(COMPONENT, `RAG delete: removed "${doc.title}" (${doc.chunkCount} chunks)`);
    return true;
}

/** Get RAG context for a query (used by context manager) */
export async function getRagContext(query: string, topK: number = 3): Promise<string> {
    if (!available) return '';
    const results = await ragSearch(query, topK, 0.35);
    if (results.length === 0) return '';

    const contextParts = results.map((r, i) =>
        `[RAG ${i + 1}/${results.length} — "${r.title}" (score: ${r.score.toFixed(2)})]:\n${r.text}`
    );
    return contextParts.join('\n\n');
}
