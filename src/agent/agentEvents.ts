/**
 * TITAN — Agent Event Bus
 * Shared event emitter for agent activity. Used by gateway (SSE), Agent Watcher,
 * sub-agents, and wakeup processor to broadcast tool/agent events.
 */
import { EventEmitter } from 'events';

const bus = new EventEmitter();
bus.setMaxListeners(50); // Multiple SSE clients + watcher

export interface AgentEvent {
    type: 'tool_call' | 'tool_end' | 'thinking' | 'round' | 'agent_spawn' | 'agent_done' | 'token';
    agentId?: string;
    agentName?: string;
    sessionId?: string;
    timestamp: number;
    data: Record<string, unknown>;
}

export function emitAgentEvent(event: AgentEvent): void {
    bus.emit('agent_event', event);
}

export function onAgentEvent(handler: (event: AgentEvent) => void): () => void {
    bus.on('agent_event', handler);
    return () => bus.off('agent_event', handler);
}

export default bus;
