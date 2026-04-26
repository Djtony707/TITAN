/**
 * TITAN — Session Manager
 * Manages per-user/per-channel isolated sessions with history and context.
 */
import { v4 as uuid } from 'uuid';
import { getDb, getHistory, saveMessage, updateSessionMeta, debouncedSave } from '../memory/memory.js';

/** Idle sessions older than this are purged from the store entirely */
const SESSION_IDLE_PURGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
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
export const activeSessions: Map<string, Session> = new Map();

// ─── Ephemeral channel cleanup (Phase 9 / TITAN PC leak fix) ────────────
//
// Background: TITAN PC v5.3.2 accumulated 755 in-memory sessions in 29min
// because every endpoint that internally calls processMessage with a
// templated channel name (autoresearch-trigger-${type}, twilio-call-${sid},
// initiative-fix, etc.) creates a unique cache key under
// `${channel}:${userId}:${agentId}` — and all sessions previously shared
// the same SESSION_TIMEOUT_MS (30min) idle TTL. At ~26 sessions/min creation
// rate, that 30min window buffered 750+ entries before the first expired.
//
// Fix: classify channels as ephemeral (one-shot agent invocations from
// internal triggers) vs persistent (webchat, voice, discord, telegram,
// slack — where the user expects to resume mid-conversation). Ephemerals
// get a 5-minute idle TTL and an LRU cap; persistents keep the full 30min.
//
// Persistent channels are an EXPLICIT allowlist — any new channel added
// in the future defaults to ephemeral by accident, which is the safer
// failure mode (a few extra closeSession calls vs a slow OOM).
const PERSISTENT_CHANNELS_EXACT = new Set([
    'webchat', 'voice', 'discord', 'telegram', 'slack',
    'whatsapp', 'matrix', 'irc', 'line', 'zulip',
    'mattermost', 'rocketchat', 'twilio', 'sms', 'email',
]);

/** True if the channel is an ephemeral one-shot — short TTL + LRU cap. */
export function isEphemeralChannel(channel: string): boolean {
    return !PERSISTENT_CHANNELS_EXACT.has(channel);
}

/** Idle TTL for ephemeral sessions. Far shorter than SESSION_TIMEOUT_MS. */
export const EPHEMERAL_TTL_MS = 5 * 60 * 1000;
/** Max ephemeral sessions retained in the in-memory cache; LRU evicts beyond. */
export const EPHEMERAL_MAX_ACTIVE = 100;

/** Create or retrieve a session */
// Hunt Finding #19 (2026-04-14): UUID v4 pattern used to distinguish
// auto-generated default sessions from caller-supplied named sessions.
// Needed for backward compatibility with sessions created BEFORE the
// is_named flag was added — those don't have the flag but can still be
// identified by ID shape (non-UUID = named by caller).
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isDefaultSession(s: { id: string } & { is_named?: boolean }): boolean {
    // Explicitly marked as named via the flag → not a default session.
    if (s.is_named === true) return false;
    // Pre-#19 sessions don't have the flag. Fall back to ID-shape detection:
    // auto-generated defaults use uuid(), named sessions use caller-supplied
    // strings that rarely match UUID v4.
    return UUID_V4_PATTERN.test(s.id);
}

export function getOrCreateSession(channel: string, userId: string, agentId: string = 'default', isEncrypted: boolean = false): Session {
    const sessionKey = `${channel}:${userId}:${agentId}`;

    // Check cache
    const cached = activeSessions.get(sessionKey);
    if (cached && cached.status === 'active') {
        return cached;
    }

    // Check data store. Hunt Finding #19 (2026-04-14): exclude named sessions
    // (those created via getOrCreateSessionById with an explicit ID). A named
    // session belongs to whoever holds its ID — it must NOT be returned as the
    // default for the channel+user+agent slot, or a subsequent no-sessionId
    // request inherits the previous named caller's conversation history.
    const store = getDb();
    const existing = store.sessions.find(
        (s) => s.channel === channel
            && s.user_id === userId
            && s.agent_id === agentId
            && s.status === 'active'
            && isDefaultSession(s as unknown as { id: string; is_named?: boolean }),
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
        // Hunt Finding #19 (2026-04-14): mark as named so the default-slot
        // lookup in getOrCreateSession doesn't return this to an unrelated
        // no-sessionId caller.
        is_named: true,
    } as Parameters<typeof store.sessions.push>[0]);

    // Hunt Finding #19 (2026-04-14): register ONLY under the id: key. Do NOT
    // overwrite the default channel+user+agent slot — that's what was causing
    // no-sessionId requests to inherit the most recent named session. The
    // previous behavior claimed to "avoid creating another session for the
    // same user" but that convenience cost was a privacy leak between API
    // callers sharing the api-user:default fallback.
    activeSessions.set(`id:${session.id}`, session);

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

/**
 * Mark sessions inactive past the per-channel idle TTL as idle, evict from
 * the in-memory cache, enforce the ephemeral LRU cap, and purge ancient
 * idle records from the store.
 *
 * TTL is per-channel:
 *   - Persistent channels (webchat, voice, discord, telegram, slack, ...)
 *     keep SESSION_TIMEOUT_MS (30min) so user conversations can resume.
 *   - Ephemeral channels (api, eval, autoresearch-*, initiative-*, twilio-*,
 *     monitor, mesh, deliberation, ...) get EPHEMERAL_TTL_MS (5min) — these
 *     are internal one-shot agent invocations that don't need to linger.
 *
 * After idle eviction, the ephemeral entries in the cache are capped at
 * EPHEMERAL_MAX_ACTIVE; oldest-by-lastActive get dropped beyond that.
 */
export function cleanupStaleSessions(): void {
    const store = getDb();
    const now = Date.now();
    let cleaned = 0;
    for (const s of store.sessions) {
        if (s.status === 'active') {
            const ttl = isEphemeralChannel(s.channel) ? EPHEMERAL_TTL_MS : SESSION_TIMEOUT_MS;
            const lastActive = new Date(s.last_active || s.created_at).getTime();
            if (now - lastActive > ttl) {
                s.status = 'idle';
                cleaned++;
            }
        }
    }

    // Evict timed-out entries from the in-memory cache too — otherwise
    // getOrCreateSessionById registrations (keyed by id:*) leak forever.
    const keysToDelete: string[] = [];
    for (const [key, session] of activeSessions.entries()) {
        const ttl = isEphemeralChannel(session.channel) ? EPHEMERAL_TTL_MS : SESSION_TIMEOUT_MS;
        const lastActive = new Date(session.lastActive || session.createdAt).getTime();
        if (now - lastActive > ttl) {
            keysToDelete.push(key);
        }
    }
    for (const key of keysToDelete) {
        activeSessions.delete(key);
    }

    // LRU cap on ephemeral cache entries — even within the 5min window, a
    // burst of 200+ one-shot agent calls would still buffer up. Drop the
    // oldest-by-lastActive past EPHEMERAL_MAX_ACTIVE. We dedupe by session
    // ID first because `id:` and `channel:user:agent` keys often share an
    // underlying Session object.
    const ephemeralEntries: Array<{ key: string; session: Session; lastActive: number }> = [];
    const seenSessionIds = new Set<string>();
    for (const [key, session] of activeSessions.entries()) {
        if (!isEphemeralChannel(session.channel)) continue;
        if (seenSessionIds.has(session.id)) continue;
        seenSessionIds.add(session.id);
        ephemeralEntries.push({
            key,
            session,
            lastActive: new Date(session.lastActive || session.createdAt).getTime(),
        });
    }
    let lruEvicted = 0;
    if (ephemeralEntries.length > EPHEMERAL_MAX_ACTIVE) {
        ephemeralEntries.sort((a, b) => a.lastActive - b.lastActive); // oldest first
        const toEvict = ephemeralEntries.slice(0, ephemeralEntries.length - EPHEMERAL_MAX_ACTIVE);
        for (const { session } of toEvict) {
            // Remove BOTH key patterns for this session id.
            const allKeys: string[] = [];
            for (const [k, v] of activeSessions.entries()) {
                if (v.id === session.id) allKeys.push(k);
            }
            for (const k of allKeys) activeSessions.delete(k);
            lruEvicted++;
        }
    }

    // Purge idle sessions older than 7 days from the store entirely —
    // otherwise the sessions array grows forever (755+ sessions observed).
    const beforePurge = store.sessions.length;
    store.sessions = store.sessions.filter((s) => {
        if (s.status !== 'idle') return true;
        const lastActive = new Date(s.last_active || s.created_at).getTime();
        return now - lastActive < SESSION_IDLE_PURGE_MS;
    });
    const purged = beforePurge - store.sessions.length;

    if (cleaned > 0 || keysToDelete.length > 0 || lruEvicted > 0 || purged > 0) {
        logger.info(
            COMPONENT,
            `Cleaned up ${cleaned} stale session(s), evicted ${keysToDelete.length} from cache, ` +
            `LRU-evicted ${lruEvicted} ephemeral over cap, purged ${purged} old idle session(s)`,
        );
    }

    if (cleaned > 0 || purged > 0) {
        debouncedSave();
    }
}

/**
 * Bulk close sessions matching a filter — used by POST /api/sessions/sweep
 * for live operational drain (no service restart needed) when the cache
 * unexpectedly grows.
 *
 * @param opts.channel  If set, only close sessions on this exact channel.
 * @param opts.channelPrefix  If set, only close sessions whose channel
 *   starts with this prefix (matches templated channels like
 *   "autoresearch-trigger-tool_router").
 * @param opts.idleMs   Minimum idle time in ms; only close sessions whose
 *   lastActive is older than now - idleMs. Defaults to 0 (any age).
 * @param opts.force    If true, also close persistent channels. Off by
 *   default to keep webchat/voice conversations alive.
 *
 * Returns the count of sessions closed (cache + DB record).
 */
export function sweepSessions(opts: {
    channel?: string;
    channelPrefix?: string;
    idleMs?: number;
    force?: boolean;
} = {}): { closed: number } {
    const now = Date.now();
    const idleThreshold = opts.idleMs ?? 0;

    const sessionIdsToClose = new Set<string>();
    for (const session of activeSessions.values()) {
        if (sessionIdsToClose.has(session.id)) continue;
        if (!opts.force && !isEphemeralChannel(session.channel)) continue;
        if (opts.channel && session.channel !== opts.channel) continue;
        if (opts.channelPrefix && !session.channel.startsWith(opts.channelPrefix)) continue;
        const lastActive = new Date(session.lastActive || session.createdAt).getTime();
        if (now - lastActive < idleThreshold) continue;
        sessionIdsToClose.add(session.id);
    }

    let closed = 0;
    for (const id of sessionIdsToClose) {
        closeSession(id);
        closed++;
    }
    if (closed > 0) {
        logger.info(COMPONENT, `Sweep closed ${closed} session(s) — channel=${opts.channel ?? opts.channelPrefix ?? '*'} idleMs=${idleThreshold} force=${!!opts.force}`);
    }
    return { closed };
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

    // Flush accumulated tool analytics for this session (fire-and-forget)
    import('../analytics/featureTracker.js')
        .then(({ endToolSession }) => endToolSession(sessionId))
        .catch(() => {});

    logger.info(COMPONENT, `Closed session: ${sessionId}`);
}

// v5.0: Guest session support (Space Agent parity)
const GUEST_PREFIX = 'guest_';
const GUEST_MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72h
const GUEST_MAX_FILES = 1000;

export function createGuestSession(): Session {
    const id = `${GUEST_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const session: Session = {
        id,
        channel: 'webchat',
        userId: id,
        agentId: 'default',
        status: 'active',
        messageCount: 0,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
    };
    activeSessions.set(`id:${id}`, session);
    logger.info(COMPONENT, `Created guest session: ${id}`);
    return session;
}

export function isGuestSession(sessionId: string): boolean {
    return sessionId.startsWith(GUEST_PREFIX);
}

/** Prune old guest sessions */
export function pruneGuestSessions(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    for (const [key, session] of activeSessions) {
        if (isGuestSession(session.id)) {
            const age = now - new Date(session.lastActive).getTime();
            if (age > GUEST_MAX_AGE_MS) {
                keysToDelete.push(key);
            }
        }
    }
    for (const key of keysToDelete) {
        const session = activeSessions.get(key);
        if (session) {
            closeSession(session.id);
        }
    }
    if (keysToDelete.length > 0) {
        logger.info(COMPONENT, `Pruned ${keysToDelete.length} inactive guest session(s)`);
    }
}
