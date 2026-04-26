/**
 * TITAN v5.0 — Diagnostics / OTEL Types
 */

export interface SpanContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
}

export interface DiagnosticSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    attributes: Record<string, string | number | boolean>;
    error?: {
        type: string;
        message: string;
    };
}

export interface DebugSnapshot {
    version: string;
    timestamp: string;
    config: {
        onboarded: boolean;
        agentModel: string;
        providersConfigured: string[];
        channelsEnabled: string[];
        features: Record<string, boolean>;
    };
    sessions: {
        total: number;
        active: number;
        idle: number;
    };
    providers: Array<{
        name: string;
        healthy: boolean;
        lastUsed: string;
        failureCount: number;
    }>;
    tools: {
        totalCalls24h: number;
        topTools: Array<{ name: string; count: number }>;
    };
    memory: {
        vectorDBSize: number;
        graphNodes: number;
    };
    channels: Array<{
        name: string;
        enabled: boolean;
        connected: boolean;
    }>;
    commandPost: {
        enabled: boolean;
        agents: number;
        issues: number;
    };
    daemon: {
        running: boolean;
        watchers: number;
    };
    recentErrors: Array<{
        time: string;
        component: string;
        message: string;
    }>;
}
