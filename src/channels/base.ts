/**
 * TITAN — Channel Base Interface
 * Abstract interface for all messaging channel adapters.
 */
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

/** Inbound message from a channel */
export interface InboundMessage {
    id: string;
    channel: string;
    userId: string;
    userName?: string;
    content: string;
    attachments?: Array<{ type: string; url: string; name?: string }>;
    replyTo?: string;
    groupId?: string;
    timestamp: Date;
    raw?: unknown;
}

/** Outbound message to a channel */
export interface OutboundMessage {
    channel: string;
    userId?: string;
    groupId?: string;
    content: string;
    replyTo?: string;
    attachments?: Array<{ type: string; data: Buffer; name: string }>;
}

/** Channel status */
export interface ChannelStatus {
    name: string;
    connected: boolean;
    userCount?: number;
    lastActivity?: Date;
    error?: string;
}

/**
 * Abstract Channel Adapter
 * All channel integrations (Discord, Telegram, Slack, etc.) extend this.
 *
 * Hunt Finding #13 (2026-04-14): every channel adapter previously implemented
 * its own `send()` without running outbound content through the centralized
 * sanitizer. Only Messenger was protected, leaving 16 other channels
 * (Discord, Telegram, Slack, Matrix, WhatsApp, etc.) exposed to system-prompt
 * leaks, tool artifact leaks, PII, and instruction echoes.
 *
 * The base class now provides a concrete `deliver()` method that:
 *   1. Runs the content through `sanitizeOutbound()`
 *   2. Blocks/replaces with a safe fallback if the content contains leaks
 *   3. Calls the subclass's `send()` with the sanitized payload
 *
 * Callers (gateway/server.ts safeSend, etc.) should call `deliver()` instead
 * of `send()`. Subclasses still implement `send()` for the actual wire-level
 * transport, but all public outbound content flows through `deliver()`.
 */
export abstract class ChannelAdapter extends EventEmitter {
    abstract readonly name: string;
    abstract readonly displayName: string;

    /** Connect to the channel service */
    abstract connect(): Promise<void>;

    /** Disconnect from the channel service */
    abstract disconnect(): Promise<void>;

    /** Send a message to the channel (raw transport — subclasses implement this) */
    abstract send(message: OutboundMessage): Promise<void>;

    /** Get the current connection status */
    abstract getStatus(): ChannelStatus;

    /**
     * Deliver a message to the user, sanitizing content first.
     * This is the PUBLIC entry point for outbound messages — callers should
     * use this, not send() directly. Enforces outbound safety across every
     * channel without requiring each subclass to opt in.
     */
    async deliver(message: OutboundMessage): Promise<void> {
        // Import lazily to avoid circular deps at module load
        let sanitized: { text: string; hadIssues: boolean; issues: string[] };
        try {
            const { sanitizeOutbound } = await import('../utils/outboundSanitizer.js');
            sanitized = sanitizeOutbound(
                message.content,
                `channel:${this.name}`,
                "I had trouble composing a response. Please try rephrasing your request.",
            );
        } catch {
            // Sanitizer unavailable — fail open (better to send than drop)
            return this.send(message);
        }

        if (sanitized.hadIssues) {
            logger.warn('ChannelAdapter', `[OutboundGuard:${this.name}] Content sanitized: ${sanitized.issues.join(', ')} — using fallback`);
        }

        const safeMessage: OutboundMessage = {
            ...message,
            content: sanitized.text,
        };
        return this.send(safeMessage);
    }

    /** Type declaration for events */
    declare on: (event: 'message', listener: (msg: InboundMessage) => void) => this;
    declare emit: (event: 'message', msg: InboundMessage) => boolean;
}
