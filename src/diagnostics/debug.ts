/**
 * TITAN v5.0 — /debug Diagnostics Toolkit (Hermes v0.9.0 parity)
 *
 * Generates a full system snapshot for troubleshooting.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { loadConfig } from '../config/config.js';
import { getRegisteredTools } from '../agent/toolRunner.js';
import logger from '../utils/logger.js';
import type { DebugSnapshot } from './types.js';

const COMPONENT = 'DebugToolkit';

function redactConfig(config: unknown): unknown {
    if (typeof config !== 'object' || config === null) return config;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
        if (typeof value === 'string' && /key|token|secret|password|apiKey/i.test(key)) {
            out[key] = value ? '[REDACTED]' : '';
        } else if (typeof value === 'object' && value !== null) {
            out[key] = redactConfig(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/** Generate a full debug snapshot */
export async function generateDebugSnapshot(): Promise<DebugSnapshot> {
    const config = loadConfig();
    const providersConfigured: string[] = [];
    for (const [name, pc] of Object.entries(config.providers ?? {})) {
        const profiles = (pc as Record<string, unknown>)?.authProfiles;
        const hasProfiles = Array.isArray(profiles) && profiles.length > 0;
        if (pc?.apiKey || hasProfiles) {
            providersConfigured.push(name);
        }
    }

    const channelsEnabled: string[] = [];
    for (const [name, cc] of Object.entries(config.channels ?? {})) {
        if ((cc as Record<string, unknown>)?.enabled) {
            channelsEnabled.push(name);
        }
    }

    // Session counts
    let sessionsTotal = 0;
    let sessionsActive = 0;
    let sessionsIdle = 0;
    try {
        const dataPath = `${homedir()}/.titan/titan-data.json`;
        if (existsSync(dataPath)) {
            const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
            const sessions = data.sessions ?? [];
            sessionsTotal = sessions.length;
            sessionsActive = sessions.filter((s: { status?: string }) => s.status === 'active').length;
            sessionsIdle = sessions.filter((s: { status?: string }) => s.status === 'idle').length;
        }
    } catch { /* ignore */ }

    // Tool usage
    const tools = getRegisteredTools();
    const topTools = tools.slice(0, 10).map(t => ({ name: t.name, count: 0 }));

    // Memory stats
    let vectorDBSize = 0;
    let graphNodes = 0;
    try {
        const memPath = `${homedir()}/.titan/memory/vectors.json`;
        if (existsSync(memPath)) {
            const vecData = JSON.parse(readFileSync(memPath, 'utf-8'));
            vectorDBSize = Array.isArray(vecData) ? vecData.length : 0;
        }
    } catch { /* ignore */ }
    try {
        const graphPath = `${homedir()}/.titan/memory/graph.json`;
        if (existsSync(graphPath)) {
            const graphData = JSON.parse(readFileSync(graphPath, 'utf-8'));
            graphNodes = graphData.nodes?.length ?? 0;
        }
    } catch { /* ignore */ }

    // CP stats — `listAgents` lives on multiAgent, `listIssues` on commandPost.
    // The earlier import path bundled them as one but commandPost no longer
    // re-exports listAgents.
    let cpAgents = 0;
    let cpIssues = 0;
    try {
        const { listAgents } = await import('../agent/multiAgent.js');
        cpAgents = listAgents().length;
    } catch { /* ignore */ }
    try {
        const { listIssues } = await import('../agent/commandPost.js');
        cpIssues = listIssues().length;
    } catch { /* ignore */ }

    return {
        version: '5.0.0',
        timestamp: new Date().toISOString(),
        config: {
            onboarded: config.onboarded ?? false,
            agentModel: config.agent?.model ?? 'unknown',
            providersConfigured,
            channelsEnabled,
            features: (() => {
                const ag = config.agent as Record<string, unknown> | undefined;
                return {
                    fastMode: (ag?.fastMode as boolean | undefined) ?? false,
                    piiRedaction: config.security?.redactPII ?? false,
                    shellHooks: config.hooks?.shell?.enabled ?? false,
                    secretScanning: (config.security?.secretScan?.level ?? 'tool_only') !== 'tool_only',
                    commandPost: config.commandPost?.enabled ?? false,
                    steer: (ag?.steerEnabled as boolean | undefined) ?? true,
                    concurrentTools: (ag?.concurrentTools as boolean | undefined) ?? true,
                    checkpoints: config.checkpoints?.enabled ?? true,
                };
            })(),
        },
        sessions: {
            total: sessionsTotal,
            active: sessionsActive,
            idle: sessionsIdle,
        },
        providers: providersConfigured.map(name => ({
            name,
            healthy: true,
            lastUsed: '',
            failureCount: 0,
        })),
        tools: {
            totalCalls24h: 0,
            topTools,
        },
        memory: {
            vectorDBSize,
            graphNodes,
        },
        channels: Object.entries(config.channels ?? {}).map(([name, cc]) => ({
            name,
            enabled: Boolean((cc as Record<string, unknown>)?.enabled),
            connected: false,
        })),
        commandPost: {
            enabled: config.commandPost?.enabled ?? false,
            agents: cpAgents,
            issues: cpIssues,
        },
        daemon: {
            running: false,
            watchers: 0,
        },
        recentErrors: [],
    };
}

/** Generate a sharable debug blob (redacted) */
export async function generateShareableDebug(): Promise<string> {
    const snapshot = await generateDebugSnapshot();
    return JSON.stringify(snapshot, null, 2);
}
