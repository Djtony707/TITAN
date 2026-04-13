/**
 * TITAN — Agent Messaging Skill
 *
 * Exposes the inter-agent message bus as a tool so sub-agents
 * can send messages to each other during execution.
 * Tools: send_agent_message, list_agent_mailboxes
 */
import { registerSkill } from '../registry.js';
import { sendMessage, getMailboxStatus, hasMailbox, broadcastMessage } from '../../agent/messageBus.js';

export function registerAgentMessagingSkill(): void {
    registerSkill(
        {
            name: 'agent_messaging',
            description: 'Send messages between agents during execution',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'send_agent_message',
            description: 'Send a message to another running agent. Use this to coordinate work, share results, or request help from sibling agents.\nUSE THIS WHEN: you need to share information with another agent, coordinate on dependent tasks, or ask another agent for help.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Name of the recipient agent (e.g., "Coder", "Explorer", "Analyst"). Use "*" to broadcast to all agents.',
                    },
                    message: {
                        type: 'string',
                        description: 'The message content to send',
                    },
                    priority: {
                        type: 'string',
                        enum: ['normal', 'urgent'],
                        description: 'Message priority (default: normal). Urgent messages resist eviction.',
                    },
                },
                required: ['to', 'message'],
            },
            execute: async (args) => {
                const to = args.to as string;
                const message = args.message as string;
                const priority = (args.priority as 'normal' | 'urgent') || 'normal';
                const from = (args as Record<string, unknown>)?.agentName as string || 'Unknown';

                if (to === '*') {
                    const sent = broadcastMessage(from, message);
                    return `Broadcast sent to ${sent} agent(s).`;
                }

                if (!hasMailbox(to)) {
                    return `Agent "${to}" not found. Available agents: ${getMailboxStatus().map(s => s.agent).join(', ') || 'none'}`;
                }

                const msg = sendMessage(from, to, message, { priority });
                return msg
                    ? `Message sent to ${to} (id: ${msg.id}, priority: ${priority})`
                    : `Failed to send message to ${to}`;
            },
        },
    );

    registerSkill(
        {
            name: 'agent_messaging',
            description: 'Send messages between agents during execution',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'list_agent_mailboxes',
            description: 'List all currently active agent mailboxes and their message counts.\nUSE THIS WHEN: you need to discover which agents are running, or check message queue status.',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                const status = getMailboxStatus();
                if (status.length === 0) {
                    return 'No active agent mailboxes. Agents register mailboxes when spawned.';
                }

                const lines = status.map(s =>
                    `- ${s.agent}: ${s.pending} pending, ${s.total} total`,
                );
                return `Active agent mailboxes:\n${lines.join('\n')}`;
            },
        },
    );
}
