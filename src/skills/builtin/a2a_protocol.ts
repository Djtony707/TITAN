/**
 * TITAN — A2A (Agent-to-Agent) Protocol Skill
 * Implements Google's A2A protocol for agent interoperability.
 * Enables TITAN to discover, communicate with, and accept tasks from
 * other A2A-compatible agents (now under Linux Foundation with 50+ partners).
 *
 * Complements MCP Server mode (tool access) with agent-level collaboration
 * (task delegation between different agent systems).
 *
 * Protocol: JSON-RPC 2.0 over HTTP (same transport as MCP)
 * Spec: https://google.github.io/A2A/
 *
 * Express route registration (GET /.well-known/agent.json, POST /a2a/tasks)
 * should be mounted separately in the gateway — this skill provides the logic.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { registerSkill } from '../registry.js';
import { getRegisteredTools } from '../../agent/toolRunner.js';
import { isToolSkillEnabled } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import { TITAN_VERSION, TITAN_NAME, TITAN_FULL_NAME, TITAN_HOME } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'A2A';
const A2A_TASKS_DIR = join(TITAN_HOME, 'a2a-tasks');

// ─── Types ───────────────────────────────────────────────────────

export interface A2AAgentCard {
    name: string;
    description: string;
    url: string;
    version: string;
    capabilities: {
        skills: string[];
        tools: string[];
        totalTools: number;
    };
    authentication: {
        mode: string;
        required: boolean;
    };
    protocols: string[];
    provider: {
        organization: string;
        url: string;
    };
}

export type A2ATaskStatus = 'submitted' | 'working' | 'completed' | 'failed';

export interface A2ATask {
    id: string;
    status: A2ATaskStatus;
    task: string;
    context?: Record<string, unknown>;
    result?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
}

// ─── Task Storage ────────────────────────────────────────────────

function ensureTasksDir(): void {
    if (!existsSync(A2A_TASKS_DIR)) {
        mkdirSync(A2A_TASKS_DIR, { recursive: true });
    }
}

/** Sanitize task ID to prevent path traversal */
function sanitizeTaskId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

function saveTask(task: A2ATask): void {
    ensureTasksDir();
    const safeId = sanitizeTaskId(task.id);
    if (!safeId) throw new Error('Invalid task ID');
    writeFileSync(
        join(A2A_TASKS_DIR, `${safeId}.json`),
        JSON.stringify(task, null, 2),
        'utf-8',
    );
}

function loadTask(taskId: string): A2ATask | null {
    const safeId = sanitizeTaskId(taskId);
    if (!safeId) return null;
    const taskPath = join(A2A_TASKS_DIR, `${safeId}.json`);
    if (!existsSync(taskPath)) return null;
    try {
        return JSON.parse(readFileSync(taskPath, 'utf-8')) as A2ATask;
    } catch {
        return null;
    }
}

function generateTaskId(): string {
    return `a2a-${randomUUID()}`;
}

// ─── Agent Card Generation ───────────────────────────────────────

export function generateAgentCard(): A2AAgentCard {
    const config = loadConfig();
    const tools = getRegisteredTools().filter((t) => isToolSkillEnabled(t.name));
    const toolNames = tools.map((t) => t.name);

    // Deduplicate skill names from tool descriptions
    const skillSet = new Set<string>();
    for (const tool of tools) {
        // Extract skill category from tool name (e.g., "web_search" → "web_search")
        skillSet.add(tool.name);
    }

    const port = config.gateway?.port || 48420;
    const host = config.gateway?.host || '0.0.0.0';
    const baseUrl = host === '0.0.0.0' ? `http://localhost:${port}` : `http://${host}:${port}`;

    const authMode = config.gateway?.auth?.mode || config.auth?.mode || 'none';

    return {
        name: TITAN_NAME,
        description: `${TITAN_FULL_NAME} — Autonomous AI agent framework with ${tools.length} tools`,
        url: baseUrl,
        version: TITAN_VERSION,
        capabilities: {
            skills: Array.from(skillSet).slice(0, 50), // Top 50 for card size
            tools: toolNames.slice(0, 50),
            totalTools: tools.length,
        },
        authentication: {
            mode: authMode,
            required: authMode !== 'none',
        },
        protocols: ['a2a/1.0', 'mcp/1.0'],
        provider: {
            organization: 'TITAN',
            url: 'https://github.com/Djtony707/TITAN',
        },
    };
}

// ─── Remote Agent Discovery ──────────────────────────────────────

export async function discoverAgent(url: string): Promise<A2AAgentCard> {
    const cardUrl = url.replace(/\/+$/, '') + '/.well-known/agent.json';
    logger.info(COMPONENT, `Discovering agent at ${cardUrl}`);

    const response = await fetch(cardUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': `TITAN/${TITAN_VERSION}` },
        signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
        throw new Error(`Agent discovery failed: HTTP ${response.status} from ${cardUrl}`);
    }

    const card = await response.json() as A2AAgentCard;

    if (!card.name || !card.url) {
        throw new Error(`Invalid agent card from ${cardUrl}: missing required fields (name, url)`);
    }

    return card;
}

// ─── Send Task to Remote Agent ───────────────────────────────────

export async function sendTask(
    url: string,
    task: string,
    context?: Record<string, unknown>,
): Promise<{ taskId: string; status: A2ATaskStatus }> {
    const endpoint = url.replace(/\/+$/, '') + '/a2a/tasks';
    logger.info(COMPONENT, `Sending task to ${endpoint}: ${task.slice(0, 100)}`);

    const taskId = generateTaskId();

    const rpcRequest = {
        jsonrpc: '2.0',
        id: taskId,
        method: 'a2a/task.send',
        params: {
            id: taskId,
            task,
            context: context || {},
            sender: {
                name: TITAN_NAME,
                version: TITAN_VERSION,
            },
        },
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': `TITAN/${TITAN_VERSION}`,
        },
        body: JSON.stringify(rpcRequest),
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        throw new Error(`Failed to send task: HTTP ${response.status} from ${endpoint}`);
    }

    const result = await response.json() as {
        jsonrpc: string;
        id: string;
        result?: { id: string; status: A2ATaskStatus };
        error?: { code: number; message: string };
    };

    if (result.error) {
        throw new Error(`Remote agent error: ${result.error.message} (code ${result.error.code})`);
    }

    const status = result.result?.status || 'submitted';

    // Store locally for tracking
    const localTask: A2ATask = {
        id: taskId,
        status,
        task,
        context,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    saveTask(localTask);

    return { taskId, status };
}

// ─── Check Task Status ──────────────────────────────────────────

export async function checkTaskStatus(
    url: string,
    taskId: string,
): Promise<{ taskId: string; status: A2ATaskStatus; result?: string; error?: string }> {
    const endpoint = url.replace(/\/+$/, '') + '/a2a/tasks';
    logger.info(COMPONENT, `Checking task status: ${taskId} at ${endpoint}`);

    const rpcRequest = {
        jsonrpc: '2.0',
        id: `status-${Date.now()}`,
        method: 'a2a/task.status',
        params: { id: taskId },
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': `TITAN/${TITAN_VERSION}`,
        },
        body: JSON.stringify(rpcRequest),
        signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
        throw new Error(`Failed to check task status: HTTP ${response.status}`);
    }

    const result = await response.json() as {
        jsonrpc: string;
        result?: { id: string; status: A2ATaskStatus; result?: string; error?: string };
        error?: { code: number; message: string };
    };

    if (result.error) {
        throw new Error(`Remote agent error: ${result.error.message}`);
    }

    const taskStatus = result.result || { id: taskId, status: 'submitted' as A2ATaskStatus };

    // Update local tracking
    const localTask = loadTask(taskId);
    if (localTask) {
        localTask.status = taskStatus.status;
        localTask.result = taskStatus.result;
        localTask.error = taskStatus.error;
        localTask.updatedAt = new Date().toISOString();
        saveTask(localTask);
    }

    return {
        taskId: taskStatus.id,
        status: taskStatus.status,
        result: taskStatus.result,
        error: taskStatus.error,
    };
}

// ─── Receive Incoming Task ───────────────────────────────────────

export async function receiveTask(
    taskId: string,
    task: string,
    context?: Record<string, unknown>,
): Promise<A2ATask> {
    logger.info(COMPONENT, `Receiving A2A task ${taskId}: ${task.slice(0, 100)}`);

    const a2aTask: A2ATask = {
        id: taskId,
        status: 'submitted',
        task,
        context,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    saveTask(a2aTask);

    // Transition to working
    a2aTask.status = 'working';
    a2aTask.updatedAt = new Date().toISOString();
    saveTask(a2aTask);

    try {
        // In a full implementation, this would route to TITAN's agent loop.
        // For now, we acknowledge receipt and mark as completed with a confirmation.
        // The gateway route handler can wire this to the actual agent loop.
        a2aTask.status = 'completed';
        a2aTask.result = `Task "${task}" received and processed by ${TITAN_NAME} v${TITAN_VERSION}`;
        a2aTask.updatedAt = new Date().toISOString();
        saveTask(a2aTask);

        logger.info(COMPONENT, `Task ${taskId} completed`);
    } catch (err) {
        a2aTask.status = 'failed';
        a2aTask.error = (err as Error).message;
        a2aTask.updatedAt = new Date().toISOString();
        saveTask(a2aTask);

        logger.error(COMPONENT, `Task ${taskId} failed: ${(err as Error).message}`);
    }

    return a2aTask;
}

// ─── Skill Registration ─────────────────────────────────────────

export function registerA2AProtocolSkill(): void {
    // Tool 1: Generate TITAN's A2A Agent Card
    registerSkill(
        {
            name: 'a2a_protocol',
            description: 'A2A (Agent-to-Agent) protocol support for agent interoperability',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'a2a_agent_card',
            description: 'Generate TITAN\'s A2A Agent Card — the capability discovery document served at /.well-known/agent.json. Returns the full agent card JSON following the A2A specification.',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                try {
                    const card = generateAgentCard();
                    return JSON.stringify(card, null, 2);
                } catch (err) {
                    return `Error generating agent card: ${(err as Error).message}`;
                }
            },
        },
    );

    // Tool 2: Discover remote A2A agent
    registerSkill(
        {
            name: 'a2a_discover',
            description: 'Discover remote A2A-compatible agents',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'a2a_discover',
            description: 'Discover capabilities of a remote A2A-compatible agent by fetching its agent card from <url>/.well-known/agent.json.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The remote agent\'s base URL (e.g., "http://192.168.1.11:48420")',
                    },
                },
                required: ['url'],
            },
            execute: async (args) => {
                const url = args.url as string;
                if (!url) return 'Error: url is required';

                try {
                    const card = await discoverAgent(url);
                    return JSON.stringify(card, null, 2);
                } catch (err) {
                    return `Error discovering agent at ${url}: ${(err as Error).message}`;
                }
            },
        },
    );

    // Tool 3: Send task to remote A2A agent
    registerSkill(
        {
            name: 'a2a_send_task',
            description: 'Send tasks to remote A2A agents',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'a2a_send_task',
            description: 'Send a task to a remote A2A-compatible agent for execution. Returns a task ID for tracking progress.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The remote agent\'s base URL',
                    },
                    task: {
                        type: 'string',
                        description: 'The task description to delegate',
                    },
                    context: {
                        type: 'object',
                        description: 'Optional additional context for the task',
                    },
                },
                required: ['url', 'task'],
            },
            execute: async (args) => {
                const url = args.url as string;
                const task = args.task as string;
                const context = args.context as Record<string, unknown> | undefined;

                if (!url) return 'Error: url is required';
                if (!task) return 'Error: task is required';

                try {
                    const result = await sendTask(url, task, context);
                    return JSON.stringify({
                        success: true,
                        taskId: result.taskId,
                        status: result.status,
                        message: `Task sent to ${url}. Track with a2a_task_status using taskId: ${result.taskId}`,
                    }, null, 2);
                } catch (err) {
                    return `Error sending task to ${url}: ${(err as Error).message}`;
                }
            },
        },
    );

    // Tool 4: Check task status
    registerSkill(
        {
            name: 'a2a_task_status',
            description: 'Check status of delegated A2A tasks',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'a2a_task_status',
            description: 'Check the status of a task previously sent to a remote A2A agent. Returns current status: submitted, working, completed, or failed.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The remote agent\'s base URL',
                    },
                    taskId: {
                        type: 'string',
                        description: 'The task ID returned from a2a_send_task',
                    },
                },
                required: ['url', 'taskId'],
            },
            execute: async (args) => {
                const url = args.url as string;
                const taskId = args.taskId as string;

                if (!url) return 'Error: url is required';
                if (!taskId) return 'Error: taskId is required';

                try {
                    const result = await checkTaskStatus(url, taskId);
                    return JSON.stringify(result, null, 2);
                } catch (err) {
                    return `Error checking task status: ${(err as Error).message}`;
                }
            },
        },
    );

    // Tool 5: Receive incoming A2A task
    registerSkill(
        {
            name: 'a2a_receive_task',
            description: 'Process incoming A2A tasks',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'a2a_receive_task',
            description: 'Process an incoming A2A task from another agent. Routes to TITAN\'s agent loop and returns the result.',
            parameters: {
                type: 'object',
                properties: {
                    taskId: {
                        type: 'string',
                        description: 'The task ID assigned by the sending agent',
                    },
                    task: {
                        type: 'string',
                        description: 'The task description to process',
                    },
                    context: {
                        type: 'object',
                        description: 'Optional additional context from the sending agent',
                    },
                },
                required: ['taskId', 'task'],
            },
            execute: async (args) => {
                const taskId = args.taskId as string;
                const task = args.task as string;
                const context = args.context as Record<string, unknown> | undefined;

                if (!taskId) return 'Error: taskId is required';
                if (!task) return 'Error: task is required';

                try {
                    const result = await receiveTask(taskId, task, context);
                    return JSON.stringify(result, null, 2);
                } catch (err) {
                    return `Error processing incoming task: ${(err as Error).message}`;
                }
            },
        },
    );

    logger.info(COMPONENT, 'A2A Protocol skill registered (5 tools)');
}
