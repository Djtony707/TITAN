import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/agent/daemon.js', () => ({
    titanEvents: { emit: vi.fn(), on: vi.fn(), setMaxListeners: vi.fn() },
}));

import {
    registerMailbox, unregisterMailbox, sendMessage, drainMessages,
    formatMessagesForContext, getMailboxStatus, broadcastMessage,
    hasMailbox, clearAllMailboxes,
} from '../src/agent/messageBus.js';

beforeEach(() => { clearAllMailboxes(); });

describe('Message Bus', () => {
    it('registers and unregisters mailboxes', () => {
        registerMailbox('agent-1');
        expect(hasMailbox('agent-1')).toBe(true);
        unregisterMailbox('agent-1');
        expect(hasMailbox('agent-1')).toBe(false);
    });

    it('sends messages between agents', () => {
        registerMailbox('agent-a');
        registerMailbox('agent-b');
        const msg = sendMessage('agent-a', 'agent-b', 'hello from A');
        expect(msg).not.toBeNull();
        expect(msg!.from).toBe('agent-a');
        expect(msg!.to).toBe('agent-b');
    });

    it('drains unread messages', () => {
        registerMailbox('reader');
        sendMessage('sender', 'reader', 'msg 1');
        sendMessage('sender', 'reader', 'msg 2');
        const msgs = drainMessages('reader');
        expect(msgs.length).toBe(2);
        expect(msgs[0].content).toBe('msg 1');
        // Second drain should be empty
        expect(drainMessages('reader').length).toBe(0);
    });

    it('returns null for unregistered recipient', () => {
        registerMailbox('sender');
        const msg = sendMessage('sender', 'nonexistent', 'hello');
        expect(msg).toBeNull();
    });

    it('evicts oldest message when mailbox full', () => {
        registerMailbox('full', 3);
        sendMessage('a', 'full', 'msg 1');
        sendMessage('a', 'full', 'msg 2');
        sendMessage('a', 'full', 'msg 3');
        sendMessage('a', 'full', 'msg 4'); // Should evict msg 1
        const msgs = drainMessages('full');
        expect(msgs.length).toBe(3);
        expect(msgs[0].content).toBe('msg 2'); // msg 1 evicted
    });

    it('formats messages for context injection', () => {
        registerMailbox('ctx');
        sendMessage('helper', 'ctx', 'I found the bug');
        const msgs = drainMessages('ctx');
        const formatted = formatMessagesForContext(msgs);
        expect(formatted).toContain('helper');
        expect(formatted).toContain('I found the bug');
        expect(formatted).toContain('send_agent_message');
    });

    it('returns null format for empty messages', () => {
        expect(formatMessagesForContext([])).toBeNull();
    });

    it('broadcasts to all except sender', () => {
        registerMailbox('broadcaster');
        registerMailbox('listener-1');
        registerMailbox('listener-2');
        const count = broadcastMessage('broadcaster', 'attention everyone');
        expect(count).toBe(2);
        expect(drainMessages('listener-1').length).toBe(1);
        expect(drainMessages('listener-2').length).toBe(1);
        expect(drainMessages('broadcaster').length).toBe(0);
    });

    it('reports mailbox status', () => {
        registerMailbox('status-test');
        sendMessage('other', 'status-test', 'pending msg');
        const status = getMailboxStatus();
        expect(status.length).toBe(1);
        expect(status[0].agent).toBe('status-test');
        expect(status[0].pending).toBe(1);
    });
});
