/**
 * TITAN — Multi-Agent Router
 * Manage up to 5 concurrent agent instances with independent workspaces,
 * models, and session isolation. Supports per-channel/per-account routing.
 */
import { v4 as uuid } from 'uuid';
import { loadConfig } from '../config/config.js';
import { processMessage, type AgentResponse, type StreamCallbacks } from './agent.js';
import { checkPromptInjection } from '../security/shield.js';
import { titanEvents } from './daemon.js';
import logger from '../utils/logger.js';

const COMPONENT = 'MultiAgent';
const MAX_AGENTS = 5;

export interface AgentInstance {
    id: string;
    name: string;
    model: string;
    systemPrompt?: string;
    workspace?: string;
    status: 'running' | 'idle' | 'stopped';
    channelBindings: Array<{ channel: string; pattern: string }>;
    messageCount: number;
    createdAt: string;
    lastActive: string;
}

/** Active agent instances */
const agents: Map<string, AgentInstance> = new Map();

/** Initialize with a default agent */
export function initAgents(): void {
    if (agents.size > 0) return;
    const config = loadConfig();
    const defaultAgent: AgentInstance = {
        id: 'default',
        name: 'TITAN Primary',
        model: config.agent.model,
        systemPrompt: config.agent.systemPrompt,
        status: 'running',
        channelBindings: [{ channel: '*', pattern: '*' }],
        messageCount: 0,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
    };
    agents.set('default', defaultAgent);
    logger.info(COMPONENT, 'Default agent initialized');
}

/** Spawn a new agent instance */
export function spawnAgent(options: {
    name: string;
    model?: string;
    systemPrompt?: string;
    workspace?: string;
    channelBindings?: Array<{ channel: string; pattern: string }>;
}): { success: boolean; agent?: AgentInstance; error?: string } {
    initAgents();

    if (agents.size >= MAX_AGENTS) {
        return { success: false, error: `Maximum ${MAX_AGENTS} agents reached. Stop an existing agent to spawn a new one.` };
    }

    const config = loadConfig();
    const id = uuid().slice(0, 8);
    const agent: AgentInstance = {
        id,
        name: options.name,
        model: options.model || config.agent.model,
        systemPrompt: options.systemPrompt,
        workspace: options.workspace,
        status: 'running',
        channelBindings: options.channelBindings || [],
        messageCount: 0,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
    };

    agents.set(id, agent);
    logger.info(COMPONENT, `Spawned agent "${agent.name}" (${id}) — model: ${agent.model} [${agents.size}/${MAX_AGENTS}]`);
    titanEvents.emit('agent:spawned', { id, name: agent.name, model: agent.model });
    return { success: true, agent };
}

/** Stop an agent instance */
export function stopAgent(agentId: string): { success: boolean; error?: string } {
    if (agentId === 'default') {
        return { success: false, error: 'Cannot stop the default agent.' };
    }
    const agent = agents.get(agentId);
    if (!agent) {
        return { success: false, error: `Agent "${agentId}" not found.` };
    }
    agent.status = 'stopped';
    agents.delete(agentId);
    logger.info(COMPONENT, `Stopped agent "${agent.name}" (${agentId}) [${agents.size}/${MAX_AGENTS}]`);
    titanEvents.emit('agent:stopped', { id: agentId, name: agent.name });
    return { success: true };
}

/** Get all agent instances */
export function listAgents(): AgentInstance[] {
    initAgents();
    return Array.from(agents.values());
}

/** Get a specific agent */
export function getAgent(agentId: string): AgentInstance | undefined {
    return agents.get(agentId);
}

/** Resolve which agent should handle a message based on channel routing rules */
export function resolveAgent(channel: string, userId: string): AgentInstance {
    initAgents();

    // Check channel bindings in reverse order (most recently spawned first)
    const agentList = Array.from(agents.values()).reverse();
    for (const agent of agentList) {
        if (agent.status !== 'running') continue;
        for (const binding of agent.channelBindings) {
            if (binding.channel === '*' || binding.channel === channel) {
                if (binding.pattern === '*' || binding.pattern === userId) {
                    return agent;
                }
            }
        }
    }

    // Fallback to default — defensive: reinit if somehow missing
    const defaultAgent = agents.get('default');
    if (!defaultAgent) {
        logger.error(COMPONENT, 'Default agent missing from registry — reinitializing');
        initAgents();
        return agents.get('default')!;
    }
    return defaultAgent;
}

/** Route a message to the appropriate agent and process it */
export async function routeMessage(
    message: string,
    channel: string,
    userId: string,
    streamCallbacks?: StreamCallbacks,
    overrideAgentId?: string,
    signal?: AbortSignal,
    sessionId?: string,
    modelOverride?: string,
    allowClaudeCode?: boolean,
): Promise<AgentResponse & { agentId: string; agentName: string }> {
    let agent = resolveAgent(channel, userId);

    // If a specific agent was requested and exists, use it instead
    if (overrideAgentId) {
        const override = getAgent(overrideAgentId);
        if (override && override.status === 'running') {
            agent = override;
        } else {
            logger.warn(COMPONENT, `Requested agent "${overrideAgentId}" not found or not running, falling back to default routing`);
        }
    }

    agent.messageCount++;
    agent.lastActive = new Date().toISOString();

    logger.info(COMPONENT, `Routing to agent "${agent.name}" (${agent.id}) for ${channel}/${userId}`);

    // Shield Check: intercept prompt injection before the LLM sees it
    const shieldResult = checkPromptInjection(message);
    if (!shieldResult.safe) {
        logger.warn(COMPONENT, `Message rejected by Shield: ${shieldResult.reason}`);
        return {
            content: `🛡️ Message rejected by TITAN Security Shield: ${shieldResult.reason}`,
            sessionId: channel + ':' + userId,
            toolsUsed: [],
            tokenUsage: { prompt: 0, completion: 0, total: 0 },
            model: 'shield-interceptor',
            durationMs: 0,
            agentId: agent.id,
            agentName: agent.name,
        };
    }

    // Process through the agent
    // Model priority: explicit API override > agent config > default config
    const effectiveModel = modelOverride || (agent.id === 'default' ? loadConfig().agent.model : agent.model);
    const response = await processMessage(message, channel, userId, {
        model: effectiveModel,
        systemPrompt: agent.systemPrompt,
        agentId: agent.id,
        sessionId,
        allowClaudeCode,
    }, streamCallbacks, signal);

    return {
        ...response,
        agentId: agent.id,
        agentName: agent.name,
    };
}

/** Get agent count and capacity */
export function getAgentCapacity(): { current: number; max: number; available: number } {
    initAgents();
    return {
        current: agents.size,
        max: MAX_AGENTS,
        available: MAX_AGENTS - agents.size,
    };
}
