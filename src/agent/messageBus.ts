/**
 * TITAN — Inter-Agent Message Bus
 *
 * Enables agents to communicate directly with each other via named mailboxes.
 * Uses titanEvents as the transport layer. Messages are injected into
 * agent context at the start of each loop round.
 */
import { titanEvents } from './daemon.js';
import logger from '../utils/logger.js';

const COMPONENT = 'MessageBus';

// ── Types ─────────────────────────────────────────────────────────
export interface AgentMessage {
    id: string;
    from: string;
    to: string;
    content: string;
    replyTo?: string;
    priority: 'normal' | 'urgent';
    timestamp: number;
    read: boolean;
}

interface Mailbox {
    agentName: string;
    messages: AgentMessage[];
    maxSize: number;
}

// ── State ─────────────────────────────────────────────────────────
const mailboxes = new Map<string, Mailbox>();
const DEFAULT_MAX_SIZE = 50;
let messageCounter = 0;

// ── Core Functions ────────────────────────────────────────────────

/**
 * Register a mailbox for an agent. Idempotent — safe to call multiple times.
 */
export function registerMailbox(agentName: string, maxSize: number = DEFAULT_MAX_SIZE): void {
    if (mailboxes.has(agentName)) return;
    mailboxes.set(agentName, { agentName, messages: [], maxSize });
    logger.debug(COMPONENT, `Mailbox registered: ${agentName}`);
}

/**
 * Unregister a mailbox when an agent completes.
 */
export function unregisterMailbox(agentName: string): void {
    mailboxes.delete(agentName);
    logger.debug(COMPONENT, `Mailbox unregistered: ${agentName}`);
}

/**
 * Send a message from one agent to another.
 * If the recipient's mailbox is full, the oldest non-urgent message is evicted.
 */
export function sendMessage(
    from: string,
    to: string,
    content: string,
    opts?: { priority?: 'normal' | 'urgent'; replyTo?: string },
): AgentMessage | null {
    const mailbox = mailboxes.get(to);
    if (!mailbox) {
        logger.warn(COMPONENT, `Cannot send to ${to}: mailbox not registered`);
        return null;
    }

    const message: AgentMessage = {
        id: `msg-${++messageCounter}`,
        from,
        to,
        content,
        replyTo: opts?.replyTo,
        priority: opts?.priority || 'normal',
        timestamp: Date.now(),
        read: false,
    };

    // Evict oldest non-urgent message if at capacity
    if (mailbox.messages.length >= mailbox.maxSize) {
        const idx = mailbox.messages.findIndex(m => m.priority !== 'urgent');
        if (idx >= 0) {
            mailbox.messages.splice(idx, 1);
        } else {
            mailbox.messages.shift(); // All urgent — evict oldest anyway
        }
    }

    mailbox.messages.push(message);

    // Emit event for real-time dashboard updates
    titanEvents.emit('agent:message', { from, to, messageId: message.id, priority: message.priority });

    logger.info(COMPONENT, `Message sent: ${from} → ${to} (${content.length} chars, ${message.priority})`);
    return message;
}

/**
 * Drain all unread messages for an agent. Marks them as read and returns them.
 * Called at the start of each agent loop round.
 * Follows the same pattern as drainPendingResults() in agentWakeup.ts.
 */
export function drainMessages(agentName: string): AgentMessage[] {
    const mailbox = mailboxes.get(agentName);
    if (!mailbox || mailbox.messages.length === 0) return [];

    const unread = mailbox.messages.filter(m => !m.read);
    for (const msg of unread) {
        msg.read = true;
    }

    // Clear read messages to prevent memory growth
    mailbox.messages = mailbox.messages.filter(m => !m.read);

    return unread;
}

/**
 * Format messages for injection into agent context.
 * Returns a system-role message string, or null if no messages.
 */
export function formatMessagesForContext(messages: AgentMessage[]): string | null {
    if (messages.length === 0) return null;

    const lines = messages.map(m => {
        const urgentTag = m.priority === 'urgent' ? ' [URGENT]' : '';
        return `- From ${m.from}${urgentTag}: ${m.content}`;
    });

    return `[Incoming messages from other agents]\n${lines.join('\n')}\n[You can reply using the send_agent_message tool]`;
}

/**
 * Get the status of all mailboxes (for monitoring).
 */
export function getMailboxStatus(): Array<{ agent: string; pending: number; total: number }> {
    return [...mailboxes.entries()].map(([name, mb]) => ({
        agent: name,
        pending: mb.messages.filter(m => !m.read).length,
        total: mb.messages.length,
    }));
}

/**
 * Broadcast a message to all registered agents (except sender).
 */
export function broadcastMessage(from: string, content: string): number {
    let sent = 0;
    for (const [name] of mailboxes) {
        if (name !== from) {
            sendMessage(from, name, content);
            sent++;
        }
    }
    return sent;
}

/**
 * Check if an agent has a registered mailbox.
 */
export function hasMailbox(agentName: string): boolean {
    return mailboxes.has(agentName);
}

/**
 * Clear all mailboxes (for testing/shutdown).
 */
export function clearAllMailboxes(): void {
    mailboxes.clear();
    messageCounter = 0;
}
