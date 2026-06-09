/**
 * TITAN — agent_messaging skill HANDLER tests (v7.0 verify gap B5).
 *
 * The message bus PRIMITIVES are covered in message-bus.test.ts, but no test
 * exercised the `send_agent_message` / `list_agent_mailboxes` tool handlers —
 * the broadcast path, the not-found path, priority pass-through, and the
 * mailbox-status formatting were all dark. This drives the real handler
 * closures against the real (already-tested) message bus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the tool defs the skill registers (instead of pushing to the real registry).
interface CapturedTool { name: string; execute: (args: Record<string, unknown>) => Promise<string> }
const captured: CapturedTool[] = [];
vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, toolDef: CapturedTool) => { captured.push(toolDef); },
}));

import { registerAgentMessagingSkill } from '../src/skills/builtin/agent_messaging.js';
import { registerMailbox, unregisterMailbox, getMailboxStatus, drainMessages } from '../src/agent/messageBus.js';

registerAgentMessagingSkill();
const sendTool = captured.find((t) => t.name === 'send_agent_message')!;
const listTool = captured.find((t) => t.name === 'list_agent_mailboxes')!;

beforeEach(() => {
    // Singleton bus — clear any mailboxes left by other tests/this file.
    for (const s of getMailboxStatus()) unregisterMailbox(s.agent);
});

describe('agent_messaging — registration', () => {
    it('registers both tools with execute handlers', () => {
        expect(sendTool).toBeDefined();
        expect(listTool).toBeDefined();
        expect(typeof sendTool.execute).toBe('function');
        expect(typeof listTool.execute).toBe('function');
    });
});

describe('send_agent_message handler', () => {
    it('delivers a message to a known recipient and reports the id', async () => {
        registerMailbox('Coder');
        const res = await sendTool.execute({ to: 'Coder', message: 'build the parser', agentName: 'Planner' });
        expect(res).toMatch(/Message sent to Coder \(id: .+, priority: normal\)/);
        const inbox = drainMessages('Coder');
        expect(inbox).toHaveLength(1);
        expect(inbox[0]).toMatchObject({ from: 'Planner', content: 'build the parser' });
    });

    it('passes urgent priority through to the bus', async () => {
        registerMailbox('Coder');
        const res = await sendTool.execute({ to: 'Coder', message: 'stop!', priority: 'urgent', agentName: 'X' });
        expect(res).toContain('priority: urgent');
    });

    it('returns a helpful "not found" message for an unknown recipient (no throw)', async () => {
        registerMailbox('Coder');
        const res = await sendTool.execute({ to: 'Ghost', message: 'hi' });
        expect(res).toMatch(/Agent "Ghost" not found/);
        expect(res).toContain('Coder'); // lists available agents
    });

    it('broadcasts to all OTHER agents when to="*" and reports the count', async () => {
        registerMailbox('A');
        registerMailbox('B');
        const res = await sendTool.execute({ to: '*', message: 'all hands', agentName: 'Boss' });
        expect(res).toBe('Broadcast sent to 2 agent(s).');
        expect(drainMessages('A')[0]).toMatchObject({ content: 'all hands' });
        expect(drainMessages('B')[0]).toMatchObject({ content: 'all hands' });
    });
});

describe('list_agent_mailboxes handler', () => {
    it('reports the empty state when no mailboxes are registered', async () => {
        const res = await listTool.execute({});
        expect(res).toMatch(/No active agent mailboxes/);
    });

    it('lists active mailboxes with pending/total counts', async () => {
        registerMailbox('Coder');
        registerMailbox('Explorer');
        await sendTool.execute({ to: 'Coder', message: 'task', agentName: 'Planner' });
        const res = await listTool.execute({});
        expect(res).toContain('Active agent mailboxes:');
        expect(res).toMatch(/- Coder: 1 pending, 1 total/);
        expect(res).toMatch(/- Explorer: 0 pending, 0 total/);
    });
});
