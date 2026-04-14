/**
 * TITAN — Session Manager
 * Manages per-user/per-channel isolated sessions with history and context.
 */
import { v4 as uuid } from 'uuid';
import { getDb, getHistory, saveMessage, updateSessionMeta } from '../memory/memory.js';
import type { ChatMessage } from '../providers/base.js';
import { MAX_CONTEXT_MESSAGES, SESSION_TIMEOUT_MS } from '../utils/constants.js';
import { generateKey } from '../security/encryption.js';
import { resetLoopDetection } from './loopDetection.js';
import logger from '../utils/logger.js';
// chat imported dynamically to avoid circular dependency

const COMPONENT = 'Session';

export interface Session {
    id: string;
    channel: string;
    userId: string;
    agentId: string;
    status: 'active' | 'idle' | 'closed';
    messageCount: number;
    createdAt: string;
    lastActive: string;
    name?: string;
    lastMessage?: string;
    e2eKey?: string; // Stored only in memory for active sessions
    /** Team ID if this session belongs to a team (for RBAC) */
    teamId?: string;
    // Per-session overrides (in-memory only, reset when session closes/times out)
    modelOverride?: string;
    thinkingOverride?: 'off' | 'low' | 'medium' | 'high';
    verboseMode?: boolean;
}

/** Active sessions cache */
const activeSessions: Map<string, Session> = new Map();

/** Create or retrieve a session */
export function getOrCreateSession(channel: string, userId: string, agentId: string = 'default', isEncrypted: boolean = false): Session {
    const sessionKey = `${channel}:${userId}:${agentId}`;

    // Check cache
    const cached = activeSessions.get(sessionKey);
    if (cached && cached.status === 'active') {
        return cached;
    }

    // Check data store
    const store = getDb();
    const existing = store.sessions.find(
        (s) => s.channel === channel && s.user_id === userId && s.agent_id === agentId && s.status === 'active'
    );

    if (existing) {
        const lastActive = new Date(existing.last_active || existing.created_at).getTime();
        if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
            existing.status = 'idle';
            logger.debug(COMPONENT, `Session ${existing.id} timed out, creating new one`);
            // Fall through to create a new session
        } else {
            const session: Session = {
                id: existing.id,
                channel: existing.channel,
                userId: existing.user_id,
                agentId: existing.agent_id,
                status: existing.status as 'active',
                messageCount: existing.message_count,
                createdAt: existing.created_at,
                lastActive: existing.last_active,
                name: existing.name,
                lastMessage: existing.last_message,
                // D3: Restore persisted overrides on session recovery
                modelOverride: (existing as unknown as Record<string, unknown>).model_override as string | undefined,
                thinkingOverride: (existing as unknown as Record<string, unknown>).thinking_override as Session['thinkingOverride'],
                // Note: If a session was encrypted but dropped from memory, we cannot recover the key
                // A robust implementation would involve key exchange, but for now we warn:
                e2eKey: undefined
            };
            if (isEncrypted) {
                logger.warn(COMPONENT, `Recovered session ${existing.id}, but E2E key was lost from memory.`);
            }
            activeSessions.set(sessionKey, session);
            return session;
        }
    }

    // Create new session
    const session: Session = {
        id: uuid(),
        channel,
        userId,
        agentId,
        status: 'active',
        messageCount: 0,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
    };

    if (isEncrypted) {
        try {
            session.e2eKey = generateKey().toString('base64');
            logger.info(COMPONENT, `Generated E2E key for session ${session.id}`);
        } catch (err) {
            logger.error(COMPONENT, `Failed to generate E2E key: ${err} — session will proceed without encryption`);
            // e2eKey remains undefined; addMessage/getContextMessages handle undefined gracefully
        }
    }

    store.sessions.push({
        id: session.id,
        channel,
        user_id: userId,
        agent_id: agentId,
        status: 'active',
        message_count: 0,
        created_at: session.createdAt,
        last_active: session.lastActive,
    });

    activeSessions.set(sessionKey, session);
    logger.info(COMPONENT, `Created new session: ${session.id} (${channel}/${userId})`);
    return session;
}

/** Create a new session (always fresh — never reuses existing) */
export function createNewSession(channel: string, userId: string, agentId: string = 'default'): Session {
    const session: Session = {
        id: uuid(),
        channel,
        userId,
        agentId,
        status: 'active',
        messageCount: 0,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
    };

    const store = getDb();
    store.sessions.push({
        id: session.id,
        channel,
        user_id: userId,
        agent_id: agentId,
        status: 'active',
        message_count: 0,
        created_at: session.createdAt,
        last_active: session.lastActive,
    });

    // Cache by ID so getSessionById can find it
    activeSessions.set(`id:${session.id}`, session);
    // Also set as the active session for this channel/user combo
    activeSessions.set(`${channel}:${userId}:${agentId}`, session);

    logger.info(COMPONENT, `Created new session (explicit): ${session.id} (${channel}/${userId})`);
    return session;
}

/**
 * Get a session by ID, or create a new one with that exact ID if it doesn't exist.
 *
 * Hunt Finding #06 (2026-04-14): clients that pass an explicit sessionId to
 * /api/message previously had their ID silently ignored when the session
 * didn't exist — processMessage fell through to getOrCreateSession(channel,
 * userId, agentId), which returned the default session for that channel+user
 * combo. The client's intent to start a fresh isolated session was dropped
 * and old context polluted the new request.
 *
 * This helper preserves the requested ID: if the session exists, return it;
 * if not, create a brand-new session and register it under the requested ID.
 */
export function getOrCreateSessionById(
    sessionId: string,
    channel: string,
    userId: string,
    agentId: string = 'default',
): Session {
    const existing = getSessionById(sessionId);
    if (existing) return existing;

    const session: Session = {
        id: sessionId,
        channel,
        userId,
        agentId,
        status: 'active',
        messageCount: 0,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
    };

    const store = getDb();
    store.sessions.push({
        id: session.id,
        channel,
        user_id: userId,
        agent_id: agentId,
        status: 'active',
        message_count: 0,
        created_at: session.createdAt,
        last_active: session.lastActive,
    });

    // Register under BOTH the id: key (for getSessionById) and the default
    // channel+user+agent key (so subsequent requests without sessionId don't
    // accidentally create yet another session for the same user).
    activeSessions.set(`id:${session.id}`, session);
    activeSessions.set(`${channel}:${userId}:${agentId}`, session);

    logger.info(COMPONENT, `Created new session with explicit ID: ${session.id} (${channel}/${userId})`);
    return session;
}

/** Get a session by its ID (for session switching) */
export function getSessionById(sessionId: string): Session | null {
    // Check cache first
    const cached = activeSessions.get(`id:${sessionId}`);
    if (cached) return cached;

    // Check data store
    const store = getDb();
    const existing = store.sessions.find(s => s.id === sessionId);
    if (!existing) return null;

    const session: Session = {
        id: existing.id,
        channel: existing.channel,
        userId: existing.user_id,
        agentId: existing.agent_id,
        status: existing.status as 'active' | 'idle' | 'closed',
        messageCount: existing.message_count,
        createdAt: existing.created_at,
        lastActive: existing.last_active,
        name: existing.name,
        lastMessage: existing.last_message,
    };

    // Cache for future lookups
    activeSessions.set(`id:${sessionId}`, session);

    return session;
}

/** Add a message to a session */
export function addMessage(
    session: Session,
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    extra?: { toolCalls?: string; toolCallId?: string; model?: string; tokenCount?: number }
): void {
    const messageId = uuid();
    saveMessage({
        id: messageId,
        sessionId: session.id,
        role,
        content,
        toolCalls: extra?.toolCalls,
        toolCallId: extra?.toolCallId,
        model: extra?.model,
        tokenCount: extra?.tokenCount || 0,
    }, session.e2eKey);

    // Update session
    session.messageCount++;
    session.lastActive = new Date().toISOString();

    const store = getDb();
    const sessionRec = store.sessions.find((s) => s.id === session.id);
    if (sessionRec) {
        sessionRec.message_count = session.messageCount;
        sessionRec.last_active = session.lastActive;
    }

    // Auto-name session from first user message; track last user message snippet
    if (role === 'user') {
        const snippet = content.slice(0, 60) + (content.length > 60 ? '…' : '');
        const meta: { name?: string; last_message?: string } = { last_message: snippet };
        if (!session.name) {
            // Generate a concise title via LLM (fire-and-forget, fallback to truncation)
            const cleaned = content.replace(/^\[voice\/voice-user\]\s*/i, '').replace(/^\[api\/api-user\]\s*/i, '');
            const fallbackTitle = cleaned.charAt(0).toUpperCase() + cleaned.slice(1, 47) + (cleaned.length > 47 ? '…' : '');
            session.name = fallbackTitle;
            meta.name = fallbackTitle;
            // Async LLM title generation — updates session name when ready
            import('../providers/router.js').then(({ chat: chatFn }) => chatFn({ model: 'fast', messages: [{ role: 'user', content: `Generate a concise 5-word title for this conversation. Only output the title, nothing else. Message: ${cleaned.slice(0, 200)}` }], maxTokens: 30, temperature: 0.7 }).then(res => {
                if (res.content && res.content.length > 0 && res.content.length < 60) {
                    session.name = res.content.trim();
                    updateSessionMeta(session.id, { name: session.name });
                    logger.info('Session', `LLM title for ${session.id.slice(0, 8)}: "${session.name}"`);
                }
            })).catch(() => { /* fallback title already set */ });
        }
        session.lastMessage = snippet;
        updateSessionMeta(session.id, meta);
    }
}

/** Get the context messages for a session (for sending to LLM) */
export function getContextMessages(session: Session, maxMessages: number = MAX_CONTEXT_MESSAGES): ChatMessage[] {
    const history = getHistory(session.id, maxMessages, session.e2eKey);
    return history.map((msg) => ({
        role: msg.role as ChatMessage['role'],
        content: msg.content,
        toolCallId: msg.toolCallId || undefined,
        toolCalls: msg.toolCalls ? JSON.parse(msg.toolCalls) : undefined,
    }));
}

/** Mark sessions that have been inactive > SESSION_TIMEOUT_MS as idle */
export function cleanupStaleSessions(): void {
    const store = getDb();
    const now = Date.now();
    let cleaned = 0;
    for (const s of store.sessions) {
        if (s.status === 'active') {
            const lastActive = new Date(s.last_active || s.created_at).getTime();
            if (now - lastActive > SESSION_TIMEOUT_MS) {
                s.status = 'idle';
                cleaned++;
            }
        }
    }
    if (cleaned > 0) {
        logger.info(COMPONENT, `Cleaned up ${cleaned} stale session(s)`);
    }
}

/** Rename a session */
export function renameSession(sessionId: string, name: string): boolean {
    const store = getDb();
    const s = store.sessions.find((s) => s.id === sessionId);
    if (!s) return false;
    s.name = name.trim().slice(0, 100);
    updateSessionMeta(sessionId, { name: s.name });
    // Update in-memory cache too
    for (const session of activeSessions.values()) {
        if (session.id === sessionId) {
            session.name = s.name;
            break;
        }
    }
    logger.info(COMPONENT, `Renamed session ${sessionId.slice(0, 8)} → "${s.name}"`);
    return true;
}

/** List all active sessions */
export function listSessions(): Session[] {
    cleanupStaleSessions();
    const store = getDb();
    return store.sessions
        .filter((s) => s.status === 'active' || s.status === 'idle')
        .sort((a, b) => b.last_active.localeCompare(a.last_active))
        .map((s) => {
            // Backfill name/lastMessage from conversation history for sessions created before this feature
            if (!s.name) {
                const msgs = store.conversations.filter(m => m.sessionId === s.id && m.role === 'user');
                if (msgs.length > 0) {
                    const first = msgs[0].content.slice(0, 60) + (msgs[0].content.length > 60 ? '…' : '');
                    const last = msgs[msgs.length - 1].content.slice(0, 60) + (msgs[msgs.length - 1].content.length > 60 ? '…' : '');
                    s.name = first;
                    s.last_message = last;
                }
            }
            return {
                id: s.id,
                channel: s.channel,
                userId: s.user_id,
                agentId: s.agent_id,
                status: s.status as 'active',
                messageCount: s.message_count,
                createdAt: s.created_at,
                lastActive: s.last_active,
                name: s.name,
                lastMessage: s.last_message,
            };
        });
}

/** Set a model override for the current session */
export function setSessionModelOverride(channel: string, userId: string, model: string): void {
    const session = getOrCreateSession(channel, userId, 'default');
    session.modelOverride = model;
    // D3: Persist to database so override survives session recovery
    updateSessionMeta(session.id, { model_override: model });
    logger.info(COMPONENT, `Session ${session.id.slice(0, 8)}: model override → ${model}`);
}

/** Set a thinking mode override for the current session */
export function setSessionThinkingOverride(channel: string, userId: string, level: 'off' | 'low' | 'medium' | 'high'): void {
    const session = getOrCreateSession(channel, userId, 'default');
    session.thinkingOverride = level;
    // D3: Persist to database so override survives session recovery
    updateSessionMeta(session.id, { thinking_override: level });
    logger.info(COMPONENT, `Session ${session.id.slice(0, 8)}: thinking override → ${level}`);
}

/** Set verbose mode for the current session */
export function setSessionVerbose(channel: string, userId: string, on: boolean): void {
    const session = getOrCreateSession(channel, userId, 'default');
    session.verboseMode = on;
    logger.info(COMPONENT, `Session ${session.id.slice(0, 8)}: verbose → ${on}`);
}

/** Replace session message context with compacted messages (used by /compact) */
export function replaceSessionContext(session: Session, messages: ChatMessage[]): void {
    // Clear existing history from the DB for this session
    const store = getDb();
    store.conversations = store.conversations.filter((m) => m.sessionId !== session.id);

    // Re-insert compacted messages
    for (const msg of messages) {
        if (msg.role === 'system') continue; // system prompts are rebuilt each turn
        saveMessage({
            id: uuid(),
            sessionId: session.id,
            role: msg.role,
            content: msg.content || '',
            toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : undefined,
            toolCallId: msg.toolCallId,
            tokenCount: 0,
        }, session.e2eKey);
    }

    // Update session message count
    session.messageCount = messages.filter((m) => m.role !== 'system').length;
    const sessionRec = store.sessions.find((s) => s.id === session.id);
    if (sessionRec) sessionRec.message_count = session.messageCount;

    logger.info(COMPONENT, `Session ${session.id.slice(0, 8)}: context replaced (${session.messageCount} messages)`);
}

/** Close a session */
export function closeSession(sessionId: string): void {
    const store = getDb();
    const sessionRec = store.sessions.find((s) => s.id === sessionId);
    if (sessionRec) {
        sessionRec.status = 'closed';
    }

    // Delete ALL cache entries for this session (both id: and channel:user:agent keys)
    const keysToDelete: string[] = [];
    for (const [key, session] of activeSessions) {
        if (session.id === sessionId) {
            keysToDelete.push(key);
        }
    }
    for (const key of keysToDelete) {
        activeSessions.delete(key);
    }

    // D1: Clean up loop detection state to prevent unbounded memory growth
    resetLoopDetection(sessionId);

    logger.info(COMPONENT, `Closed session: ${sessionId}`);
}
