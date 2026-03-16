/**
 * TITAN — Sessions Skill (Built-in)
 * Agent-to-agent session management: list, history, send, spawn.
 * Mirrors OpenClaw's sessions_* tools.
 */
import { registerSkill } from '../registry.js';
import { listSessions, getOrCreateSession, getContextMessages, closeSession } from '../../agent/session.js';
import { processMessage } from '../../agent/agent.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Sessions';

export function registerSessionsSkill(): void {
    // sessions_list
    registerSkill(
        { name: 'sessions_list', description: 'List all active agent sessions. USE THIS WHEN Tony says: "show active sessions", "what sessions are running", "list sessions".', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'sessions_list',
            description: 'Lists all active agent sessions with their IDs, channels, users, and message counts. USE THIS WHEN Tony says: "show active sessions", "what sessions are running", "list sessions", "who is connected".',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                const sessions = listSessions();
                if (sessions.length === 0) return 'No active sessions.';
                return sessions.map((s) =>
                    `• ${s.id.slice(0, 8)} | ${s.channel} | user: ${s.userId} | msgs: ${s.messageCount} | last active: ${s.lastActive}`
                ).join('\n');
            },
        },
    );

    // sessions_history
    registerSkill(
        { name: 'sessions_history', description: 'Get message history for a specific session. USE THIS WHEN Tony says: "show conversation history", "what did we discuss before", "show session messages", "recall previous conversation".', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'sessions_history',
            description: 'Retrieves the recent message history for a specific session. USE THIS WHEN Tony says: "show conversation history", "what did we discuss before", "show session messages", "recall previous conversation", "what was said in session X". WORKFLOW: Requires sessionChannel and sessionUserId to identify the session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionChannel: { type: 'string', description: 'Channel of the session' },
                    sessionUserId: { type: 'string', description: 'User ID of the session' },
                    limit: { type: 'number', description: 'Max messages to return (default: 20)' },
                },
                required: ['sessionChannel', 'sessionUserId'],
            },
            execute: async (args) => {
                const channel = args.sessionChannel as string;
                const userId = args.sessionUserId as string;
                const limit = (args.limit as number) || 20;
                const session = getOrCreateSession(channel, userId);
                const messages = getContextMessages(session, limit);
                if (messages.length === 0) return `No messages in session ${channel}/${userId}.`;
                return messages.map((m) =>
                    `[${m.role}] ${m.content.slice(0, 500)}`
                ).join('\n---\n');
            },
        },
    );

    // sessions_send
    registerSkill(
        { name: 'sessions_send', description: 'Send a message to another agent session, triggering agent processing. USE THIS WHEN an agent needs to communicate with another session or delegate a task.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'sessions_send',
            description: 'Sends a message to a specific user\'s session on a channel, triggering agent processing. USE THIS for agent-to-agent communication — when one agent needs to delegate a task, send a message, or coordinate with another session. WORKFLOW: Provide targetChannel, targetUserId, and message.',
            parameters: {
                type: 'object',
                properties: {
                    targetChannel: { type: 'string', description: 'Target channel (e.g., "discord", "telegram")' },
                    targetUserId: { type: 'string', description: 'Target user ID' },
                    message: { type: 'string', description: 'Message to send' },
                },
                required: ['targetChannel', 'targetUserId', 'message'],
            },
            execute: async (args) => {
                const channel = args.targetChannel as string;
                const userId = args.targetUserId as string;
                const message = args.message as string;
                logger.info(COMPONENT, `Sending inter-session message to ${channel}/${userId}`);

                try {
                    const response = await processMessage(message, channel, userId);
                    return `Message delivered to ${channel}/${userId}. Response: ${response?.content?.slice(0, 500) ?? '(no response)'}`;
                } catch (error) {
                    return `Error sending to ${channel}/${userId}: ${(error as Error).message}`;
                }
            },
        },
    );

    // sessions_close
    registerSkill(
        { name: 'sessions_close', description: 'Close and clear a specific session. USE THIS WHEN Tony says: "clear history", "reset this session", "close session X", "start fresh".', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'sessions_close',
            description: 'Closes a specific session by its session ID, clearing its context. USE THIS WHEN Tony says: "clear history", "reset this session", "close session X", "start fresh", "end that session". WORKFLOW: Use sessions_list first to get the session ID, then call sessions_close.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID to close' },
                },
                required: ['sessionId'],
            },
            execute: async (args) => {
                const sessionId = args.sessionId as string;
                closeSession(sessionId);
                return `Session ${sessionId} closed.`;
            },
        },
    );
}
