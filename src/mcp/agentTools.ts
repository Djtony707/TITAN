/**
 * Agent-level MCP tools (v7.1 interop) — TITAN as a tool inside other agents.
 *
 * These are exposed ONLY over the MCP server surface (tools/list, tools/call)
 * and never registered into TITAN's own agent loop — a peer agent (Hermes,
 * OpenClaw, Claude, anything MCP) can converse with TITAN, delegate work, and
 * consult TITAN's mixture-of-agents council, with zero recursion risk.
 *
 * Registration is one line on the peer:
 *   Hermes   → ~/.hermes/config.yaml  mcp_servers: { titan: { command: "titan", args: ["mcp","serve"] } }
 *   OpenClaw → openclaw mcp add titan --command titan --arg mcp --arg serve
 */
import { randomBytes } from 'crypto';
import logger from '../utils/logger.js';
import { TITAN_VERSION } from '../utils/constants.js';

const COMPONENT = 'McpAgentTools';

interface DelegatedTask {
    id: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    startedAt: string;
    finishedAt?: string;
    result?: string;
    error?: string;
    toolsUsed?: string[];
}

const tasks = new Map<string, DelegatedTask>();
const MAX_TASKS = 200;

function pruneTasks(): void {
    if (tasks.size <= MAX_TASKS) return;
    const sorted = [...tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const t of sorted.slice(0, tasks.size - MAX_TASKS)) tasks.delete(t.id);
}

export interface McpAgentTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
}

export const AGENT_TOOLS: McpAgentTool[] = [
    {
        name: 'titan_chat',
        description: 'Have one conversational turn with the TITAN agent. TITAN runs its full agent loop — it can use its own tools (files, web, widgets, memory, automations) and replies when done. Use sessionId to continue a conversation across calls. Synchronous: returns the final answer (may take up to a couple of minutes for tool-heavy asks). For long jobs use titan_delegate_task instead. Returns: the reply text, prefixed with the tools TITAN used. Errors: returns "Error: ..." text if TITAN\'s providers are unavailable.',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'What to say or ask.' },
                sessionId: { type: 'string', description: 'Optional conversation id for continuity.' },
            },
            required: ['message'],
        },
        execute: async (args) => {
            const { processMessage } = await import('../agent/agent.js');
            const sessionId = String(args.sessionId || 'peer');
            const res = await processMessage(String(args.message || ''), 'mcp', `mcp-${sessionId}`);
            const used = res.toolsUsed.length ? `[tools: ${res.toolsUsed.join(', ')}]\n` : '';
            return `${used}${res.content}`;
        },
    },
    {
        name: 'titan_delegate_task',
        description: 'Delegate a long-running task to TITAN and return immediately with a taskId. TITAN works autonomously (full agent loop + tools) in the background. Poll titan_task_status with the taskId; typical tasks finish in 1-10 minutes. Use for anything that would time out a synchronous call. Returns: {"taskId": "..."} as JSON text. Errors: none at submit time — failures surface in titan_task_status.',
        inputSchema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'The work to do, self-contained (TITAN has no other context about your session).' },
            },
            required: ['task'],
        },
        execute: async (args) => {
            const id = `tt-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
            const record: DelegatedTask = { id, task: String(args.task || ''), status: 'running', startedAt: new Date().toISOString() };
            tasks.set(id, record);
            pruneTasks();
            (async () => {
                try {
                    const { processMessage } = await import('../agent/agent.js');
                    const res = await processMessage(record.task, 'mcp', `mcp-task-${id}`);
                    record.status = 'done';
                    record.result = res.content;
                    record.toolsUsed = res.toolsUsed;
                } catch (e) {
                    record.status = 'failed';
                    record.error = (e as Error).message;
                } finally {
                    record.finishedAt = new Date().toISOString();
                    logger.info(COMPONENT, `Delegated task ${id} ${record.status} (${record.task.slice(0, 60)})`);
                }
            })();
            return JSON.stringify({ taskId: id });
        },
    },
    {
        name: 'titan_task_status',
        description: 'Check a task started with titan_delegate_task. Returns: JSON text — {"status":"running"} while working, or {"status":"done","result":"...","toolsUsed":[...]} / {"status":"failed","error":"..."} when finished. Errors: {"status":"unknown"} if the taskId does not exist (tasks are kept for the gateway\'s lifetime, max 200).',
        inputSchema: {
            type: 'object',
            properties: {
                taskId: { type: 'string', description: 'The id returned by titan_delegate_task.' },
            },
            required: ['taskId'],
        },
        execute: async (args) => {
            const t = tasks.get(String(args.taskId || ''));
            if (!t) return JSON.stringify({ status: 'unknown' });
            if (t.status === 'running') return JSON.stringify({ status: 'running', startedAt: t.startedAt });
            if (t.status === 'failed') return JSON.stringify({ status: 'failed', error: t.error, finishedAt: t.finishedAt });
            return JSON.stringify({ status: 'done', result: t.result, toolsUsed: t.toolsUsed, finishedAt: t.finishedAt });
        },
    },
    {
        name: 'titan_moa',
        description: 'Ask TITAN\'s Mixture-of-Agents council: several models advise in parallel and an aggregator synthesizes one answer — typically sharper than any single model. Great for design decisions, reviews, and second opinions. Slower than titan_chat (advisors run first). Returns: the council\'s synthesized answer. Errors: "Error: ..." if no MoA preset is configured on this TITAN.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'The question or task for the council.' },
                preset: { type: 'string', description: 'Optional preset name (defaults to the configured default).' },
            },
            required: ['prompt'],
        },
        execute: async (args) => {
            const { getMoaPresets } = await import('../providers/moa.js');
            const { loadConfig } = await import('../config/config.js');
            const presets = getMoaPresets();
            const cfg = loadConfig() as { moa?: { defaultPreset?: string } };
            const name = String(args.preset || cfg.moa?.defaultPreset || Object.keys(presets)[0] || '');
            if (!name || !presets[name]) return `Error: no MoA preset ${name ? `"${name}" ` : ''}configured on this TITAN.`;
            const { processMessage } = await import('../agent/agent.js');
            const res = await processMessage(String(args.prompt || ''), 'mcp', 'mcp-moa', { model: `moa/${name}` });
            return res.content;
        },
    },
    {
        name: 'titan_status',
        description: 'TITAN identity + health for peer discovery. Returns: JSON text — version, configured model, tool count, MoA presets, uptime seconds. Errors: none.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
            const { loadConfig } = await import('../config/config.js');
            const { getRegisteredTools } = await import('../agent/toolRunner.js');
            const { getMoaPresets } = await import('../providers/moa.js');
            const cfg = loadConfig();
            return JSON.stringify({
                agent: 'TITAN',
                version: TITAN_VERSION,
                model: cfg.agent.model,
                tools: getRegisteredTools().length,
                moaPresets: Object.keys(getMoaPresets()),
                uptimeSec: Math.round(process.uptime()),
            });
        },
    },
];

export function getAgentTool(name: string): McpAgentTool | undefined {
    return AGENT_TOOLS.find(t => t.name === name);
}
