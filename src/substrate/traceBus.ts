/**
 * TITAN — Trace Bus (Soma substrate)
 *
 * Typed wrapper over the existing titanEvents EventEmitter in daemon.ts.
 * Provides a single canonical event stream for the organism layer — drives,
 * hormones, pressure fusion, and shadow rehearsal all subscribe here.
 *
 * Design invariant: this is NOT a parallel event system. It publishes to the
 * SAME underlying titanEvents emitter. That means existing consumers of
 * titanEvents (Command Post activity feed, SSE stream, daemon watchers)
 * continue to work unchanged. The organism just gets a typed facade.
 *
 * Zero cost when no subscribers: `emit()` is O(1) on the EventEmitter.
 * Safe to call from anywhere; safe to no-op during early boot.
 */
import { titanEvents } from '../agent/daemon.js';

// ── Topic Contracts ──────────────────────────────────────────────

/** Emitted at the start of processMessage before any LLM work runs. */
export interface TurnPreEvent {
    agentId: string;
    sessionId: string;
    channel: string;
    userId: string;
    message: string;
    taskType?: string;
    timestamp: string;
}

/** Emitted at the end of processMessage once the response is ready. */
export interface TurnPostEvent {
    agentId: string;
    sessionId: string;
    channel: string;
    userId: string;
    success: boolean;
    toolsUsed: string[];
    durationMs: number;
    costUsd?: number;
    model: string;
    timestamp: string;
}

/** Emitted whenever a tool is invoked inside a turn. */
export interface ToolCallEvent {
    agentId: string;
    sessionId: string;
    tool: string;
    argsPreview: string;
    timestamp: string;
}

/** Emitted when a tool returns (success or failure). */
export interface ToolResultEvent {
    agentId: string;
    sessionId: string;
    tool: string;
    success: boolean;
    durationMs: number;
    timestamp: string;
}

/** Emitted every driveTick (default 60s) with the full drive snapshot. */
export interface DriveTickEvent {
    timestamp: string;
    drives: Array<{
        id: string;
        label: string;
        satisfaction: number;
        setpoint: number;
        pressure: number;
        inputs?: Record<string, unknown>;
    }>;
}

/** Emitted when hormone levels change materially (for SSE/UI consumers). */
export interface HormoneUpdateEvent {
    timestamp: string;
    dominant: string | null;
    levels: Record<string, number>;
}

/** Emitted when combined pressure crosses the proposal threshold. */
export interface PressureThresholdEvent {
    timestamp: string;
    totalPressure: number;
    threshold: number;
    dominantDrives: string[];
    reason: string;
}

/** Emitted when Soma files a proposal (after shadow rehearsal). */
export interface SomaProposalEvent {
    timestamp: string;
    approvalId: string;
    proposedBy: string;
    title: string;
    dominantDrives: string[];
    shadowVerdict?: {
        reversibilityScore: number;
        estimatedCostUsd: number;
        breakRisks: string[];
    };
}

/** Full topic → payload map. Extend here; both emit and on are typed from this. */
export interface TraceBusTopics {
    'turn:pre': TurnPreEvent;
    'turn:post': TurnPostEvent;
    'tool:call': ToolCallEvent;
    'tool:result': ToolResultEvent;
    'drive:tick': DriveTickEvent;
    'hormone:update': HormoneUpdateEvent;
    'pressure:threshold': PressureThresholdEvent;
    'soma:proposal': SomaProposalEvent;
}

export type TraceBusTopic = keyof TraceBusTopics;

// ── Publish / Subscribe ──────────────────────────────────────────

/**
 * Emit a typed event on the trace bus. No-op when no subscribers are
 * registered for the topic (EventEmitter semantics). Safe during early boot.
 */
export function emit<T extends TraceBusTopic>(topic: T, payload: TraceBusTopics[T]): void {
    try {
        titanEvents.emit(topic, payload);
    } catch {
        /* emitter failures are never fatal to the caller */
    }
}

/**
 * Subscribe to a typed event. Returns an unsubscribe function. Use in
 * watcher registration, Command Post boot, or any long-lived module.
 */
export function on<T extends TraceBusTopic>(
    topic: T,
    handler: (payload: TraceBusTopics[T]) => void,
): () => void {
    const wrapped = (payload: TraceBusTopics[T]) => {
        try {
            handler(payload);
        } catch {
            /* subscriber errors must not crash the emitter */
        }
    };
    titanEvents.on(topic, wrapped);
    return () => titanEvents.off(topic, wrapped);
}

/**
 * Subscribe once; auto-unsubscribes after the first event. Useful for tests
 * and one-shot handlers.
 */
export function once<T extends TraceBusTopic>(
    topic: T,
    handler: (payload: TraceBusTopics[T]) => void,
): void {
    const wrapped = (payload: TraceBusTopics[T]) => {
        try {
            handler(payload);
        } catch {
            /* silent */
        }
    };
    titanEvents.once(topic, wrapped);
}

/** How many subscribers are currently attached to a topic. */
export function listenerCount(topic: TraceBusTopic): number {
    return titanEvents.listenerCount(topic);
}
