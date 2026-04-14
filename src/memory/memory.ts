/**
 * TITAN — Memory / Persistence System
 * JSON-file-backed persistent memory for conversations, facts, preferences, and usage.
 * Uses no native dependencies — pure Node.js for maximum portability.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import { encrypt, decrypt, type EncryptedPayload } from '../security/encryption.js';
import { isVectorSearchAvailable, searchVectors, addVector } from './vectors.js';

const COMPONENT = 'Memory';

// ─── Data Store ──────────────────────────────────────────────────

interface DataStore {
  conversations: ConversationMessage[];
  memories: MemoryEntry[];
  sessions: SessionRecord[];
  usageStats: UsageRecord[];
  cronJobs: CronRecord[];
  skillsInstalled: SkillRecord[];
}

interface MemoryEntry {
  id: string;
  category: string;
  key: string;
  value: string;
  metadata?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionRecord {
  id: string;
  channel: string;
  user_id: string;
  agent_id: string;
  status: string;
  message_count: number;
  created_at: string;
  last_active: string;
  name?: string;
  last_message?: string;
  // D3: Persisted session overrides (survive session recovery after timeout/restart)
  model_override?: string;
  thinking_override?: string;
}

interface UsageRecord {
  id: number;
  session_id: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

interface CronRecord {
  id: string;
  name: string;
  schedule: string;
  command: string;
  mode?: 'shell' | 'tool';         // Execution mode (default: shell for backward compat)
  allowedTools?: string[];           // Tool allowlist for tool-mode jobs
  enabled: boolean;
  last_run?: string;
  next_run?: string;
  created_at: string;
}

interface SkillRecord {
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  installed_at: string;
}

const DB_FILE = join(TITAN_HOME, 'titan-data.json');

let store: DataStore | null = null;
let dirty = false;
let isShuttingDown = false;

function getDefaultStore(): DataStore {
  return {
    conversations: [],
    memories: [],
    sessions: [],
    usageStats: [],
    cronJobs: [],
    skillsInstalled: [],
  };
}

// NOTE: Sync I/O is intentional — runs only once at cold start, then cached in-memory.
function loadStore(): DataStore {
  if (store) return store;
  ensureDir(TITAN_HOME);
  if (existsSync(DB_FILE)) {
    try {
      const raw = readFileSync(DB_FILE, 'utf-8');
      store = JSON.parse(raw) as DataStore;
      // Ensure all fields exist
      store.conversations = store.conversations || [];
      store.memories = store.memories || [];
      store.sessions = store.sessions || [];
      store.usageStats = store.usageStats || [];
      store.cronJobs = store.cronJobs || [];
      store.skillsInstalled = store.skillsInstalled || [];
    } catch {
      logger.warn(COMPONENT, 'Could not load data store, creating fresh one');
      store = getDefaultStore();
    }
  } else {
    store = getDefaultStore();
  }
  return store;
}

function saveStore(): void {
  if (!store || isShuttingDown) return;
  ensureDir(TITAN_HOME);
  try {
    const tmpFile = DB_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmpFile, DB_FILE);
    dirty = false;
  } catch (e) {
    dirty = true;
    logger.error(COMPONENT, `Failed to save data: ${(e as Error).message}`);
  }
}

// Auto-save periodically
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(): void {
  if (dirty) { saveStore(); return; }
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveStore, 1000);
  saveTimeout.unref();
}

/** Initialize the memory system */
export function initMemory(): void {
  loadStore();
  logger.info(COMPONENT, 'Memory system initialized');
}

/** Close / flush the memory system */
export function closeMemory(): void {
  if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
  saveStore();
  if (dirty) {
    logger.error(COMPONENT, 'DATA MAY BE LOST — failed to flush memory store on shutdown');
  }
  isShuttingDown = true;
}

/** Get internal store (for skills like cron that need direct access) */
export function getDb(): DataStore {
  return loadStore();
}

// ─── Conversation History ────────────────────────────────────────

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolCalls?: string;
  toolCallId?: string;
  model?: string;
  tokenCount: number;
  createdAt: string;
  isEncrypted?: boolean;
}

/** Save a message to conversation history */
export function saveMessage(message: Omit<ConversationMessage, 'createdAt'>, e2eKey?: string): void {
  const s = loadStore();

  let content = message.content;
  let isEncrypted = false;

  if (e2eKey) {
    try {
      const payload = encrypt(message.content, Buffer.from(e2eKey, 'base64'));
      content = JSON.stringify(payload);
      isEncrypted = true;
    } catch {
      logger.error(COMPONENT, `Failed to encrypt message for storage`);
      content = "[ENCRYPTION FAILED] " + content; // Fallback, though we should probably throw in strict environments
    }
  }

  s.conversations.push({
    ...message,
    content,
    isEncrypted,
    createdAt: new Date().toISOString(),
  });
  // Keep only last 5000 messages total to prevent unbounded growth
  if (s.conversations.length > 5000) {
    s.conversations = s.conversations.slice(-5000);
  }
  debouncedSave();
}

/** Get conversation history for a session */
export function getHistory(sessionId: string, limit: number = 50, e2eKey?: string): ConversationMessage[] {
  const s = loadStore();
  const rawHistory = s.conversations
    .filter((m) => m.sessionId === sessionId)
    .slice(-limit);

  if (!e2eKey) {
    // If no key is provided, we just return the raw payload. 
    // If it's encrypted, it'll just show the JSON string of the EncryptedPayload.
    return rawHistory;
  }

  // Decrypt the ones that were encrypted
  return rawHistory.map(m => {
    if (m.isEncrypted) {
      try {
        const payload = JSON.parse(m.content) as EncryptedPayload;
        return {
          ...m,
          content: decrypt(payload, Buffer.from(e2eKey, 'base64'))
        };
      } catch {
        logger.error(COMPONENT, `Failed to decrypt message ${m.id}`);
        return { ...m, content: "[DECRYPTION FAILED]" };
      }
    }
    return m;
  });
}

/** Update session name and/or last message snippet */
export function updateSessionMeta(sessionId: string, meta: { name?: string; last_message?: string; model_override?: string; thinking_override?: string }): void {
  const s = loadStore();
  const rec = s.sessions.find(ses => ses.id === sessionId);
  if (!rec) return;
  if (meta.name !== undefined) rec.name = meta.name;
  if (meta.last_message !== undefined) rec.last_message = meta.last_message;
  // D3: Persist session overrides to database so they survive timeout/restart
  if (meta.model_override !== undefined) rec.model_override = meta.model_override;
  if (meta.thinking_override !== undefined) rec.thinking_override = meta.thinking_override;
  debouncedSave();
}

/** Clear conversation history for a session */
export function clearHistory(sessionId: string): void {
  const s = loadStore();
  s.conversations = s.conversations.filter((m) => m.sessionId !== sessionId);
  debouncedSave();
}

// ─── Persistent Memory (Facts / Preferences) ─────────────────────

/** Store a memory (key-value with category) */
export function rememberFact(category: string, key: string, value: string, metadata?: Record<string, unknown>): void {
  const s = loadStore();
  const id = `${category}:${key}`;
  const existingIdx = s.memories.findIndex((m) => m.id === id);
  const now = new Date().toISOString();

  if (existingIdx >= 0) {
    s.memories[existingIdx].value = value;
    s.memories[existingIdx].metadata = metadata ? JSON.stringify(metadata) : undefined;
    s.memories[existingIdx].updatedAt = now;
  } else {
    s.memories.push({
      id,
      category,
      key,
      value,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      createdAt: now,
      updatedAt: now,
    });
  }
  debouncedSave();

  // Index to vector store (fire-and-forget)
  if (isVectorSearchAvailable()) {
    addVector(id, `${category}: ${key} = ${value}`, 'memory', { category, key }).catch(() => {});
  }
}

/** Recall a specific memory */
export function recallFact(category: string, key: string): string | null {
  const s = loadStore();
  const entry = s.memories.find((m) => m.category === category && m.key === key);
  return entry?.value || null;
}

/** Search memories by category — hybrid keyword + vector search */
export async function searchMemories(category?: string, query?: string): Promise<Array<{ key: string; value: string; category: string; score?: number }>> {
  const s = loadStore();
  let results = s.memories;

  if (category) {
    results = results.filter((m) => m.category === category);
  }
  if (query) {
    const q = query.toLowerCase();
    // Word-boundary match to avoid false positives ("use" matching "user", "reuse")
    const qRegex = new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    results = results.filter((m) =>
      qRegex.test(m.key) || qRegex.test(m.value)
    );
  }

  // Keyword scoring
  const scored = results.map(m => {
    let score = 0;
    if (query) {
      const q = query.toLowerCase();
      const keyLower = m.key.toLowerCase();
      const valLower = m.value.toLowerCase();
      // Exact key match scores highest
      if (keyLower === q) score += 5;
      else if (keyLower.includes(q)) score += 2;
      if (valLower.includes(q)) score += 1;
      // BM25-style: boost for multiple keyword matches
      const terms = q.split(/\s+/).filter(Boolean);
      for (const term of terms) {
        if (keyLower.includes(term)) score += 1;
        if (valLower.includes(term)) score += 0.5;
      }
    }
    return { key: m.key, value: m.value, category: m.category, id: m.id, score };
  });

  // Vector search augmentation (hybrid mode)
  if (query && isVectorSearchAvailable()) {
    try {
      const vectorResults = await searchVectors(query, 20, 'memory', 0.4);
      for (const vr of vectorResults) {
        // Skip stale vector IDs that no longer exist in the store
        const memEntry = s.memories.find(m => m.id === vr.id);
        if (!memEntry) continue;
        const existing = scored.find(s => s.id === vr.id);
        if (existing) {
          // Boost keyword results that also match semantically
          existing.score += vr.score * 3;
        } else {
          // Add vector-only results (semantically similar but no keyword match)
          const entry = s.memories.find(m => m.id === vr.id);
          if (entry && (!category || entry.category === category)) {
            scored.push({
              key: entry.key,
              value: entry.value,
              category: entry.category,
              id: entry.id,
              score: vr.score * 2,
            });
          }
        }
      }
    } catch {
      // Vector search failure is non-fatal
    }
  }

  scored.sort((a, b) => b.score - a.score);
  // Deduplicate by ID (vector + keyword can match the same entry)
  const seen = new Set<string>();
  const unique = scored.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  return unique.slice(0, 50).map(m => ({ key: m.key, value: m.value, category: m.category, score: m.score }));
}

// ─── Usage Tracking ──────────────────────────────────────────────

/** Record usage statistics */
export function recordUsage(sessionId: string, provider: string, model: string, promptTokens: number, completionTokens: number): void {
  const s = loadStore();
  s.usageStats.push({
    id: Date.now(),
    session_id: sessionId,
    provider,
    model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    created_at: new Date().toISOString(),
  });
  // Keep only last 10000 records
  if (s.usageStats.length > 10000) {
    s.usageStats = s.usageStats.slice(-10000);
  }
  debouncedSave();
}

/** Get total usage statistics */
export function getUsageStats(): { totalTokens: number; totalRequests: number; byProvider: Record<string, number> } {
  const s = loadStore();
  let totalTokens = 0;
  const byProvider: Record<string, number> = {};

  for (const rec of s.usageStats) {
    totalTokens += rec.total_tokens;
    byProvider[rec.provider] = (byProvider[rec.provider] || 0) + rec.total_tokens;
  }

  return {
    totalTokens,
    totalRequests: s.usageStats.length,
    byProvider,
  };
}
