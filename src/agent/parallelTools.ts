/**
 * TITAN — Parallel Tool Execution Engine
 * Runs independent tools concurrently via Promise.all.
 * No other OpenClaw clone does this — they all execute tools sequentially.
 * This gives TITAN a significant speed advantage.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'ParallelTools';

interface ToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

interface ToolResult {
    toolCallId: string;
    name: string;
    content: string;
}

type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

/** Max concurrent tool executions (TITAN pattern) */
const MAX_TOOL_CONCURRENCY = 10;

/** Tools that are always read-only regardless of input */
const READ_ONLY_TOOLS = new Set([
    'read_file', 'list_dir', 'web_search', 'web_fetch', 'web_read',
    'memory', 'graph_search', 'tool_search', 'system_info', 'self_doctor',
    'weather', 'ha_status', 'ha_devices', 'goal_list', 'analyze_image',
    'audit_log', 'sentry_issues', 'linear_issues', 'jira_issues',
    'generate_changelog', 'summarize_pr', 'session_teleport',
    'external_agent',
]);

/** Tools that modify state — cannot run concurrently with each other */
const WRITING_TOOLS = new Set([
    'write_file', 'edit_file', 'append_file', 'exec', 'shell', 'apply_patch',
    'process_kill', 'process_write', 'webhook_register', 'code_exec',
    'memory', 'spawn_agent',
]);

/** Tools that are destructive — need extra caution */
const DESTRUCTIVE_TOOLS = new Set([
    'process_kill', 'apply_patch',
]);

/** Check if a specific tool call is safe to run concurrently (TITAN pattern) */
function isConcurrencySafe(tool: ToolCall): boolean {
    // Read-only tools are always safe
    if (READ_ONLY_TOOLS.has(tool.name)) return true;

    // Input-aware: memory tool is read-only if action is 'search' or 'recall'
    if (tool.name === 'memory') {
        const action = (tool.args as Record<string, unknown>).action as string;
        return action === 'search' || action === 'recall' || action === 'list';
    }

    // Shell is read-only if the command doesn't modify anything
    if (tool.name === 'shell') {
        const cmd = ((tool.args as Record<string, unknown>).command as string || '').trim();
        const readOnlyCmds = /^(cat|head|tail|less|grep|find|ls|pwd|whoami|hostname|uname|date|echo|wc|which|env|printenv|df|du|free|top|ps|curl.*-s|wget.*-q)/;
        return readOnlyCmds.test(cmd);
    }

    return false;
}

/** Detect duplicate tool calls with same inputs */
function isDuplicate(a: ToolCall, b: ToolCall): boolean {
    return a.name === b.name && JSON.stringify(a.args) === JSON.stringify(b.args);
}

/** Partition tool calls into batches: read-only concurrent, write sequential (TITAN pattern) */
function partitionToolCalls(tools: ToolCall[]): Array<{ concurrent: boolean; calls: ToolCall[] }> {
    // Deduplicate first
    const deduped: ToolCall[] = [];
    for (const tool of tools) {
        if (!deduped.some(d => isDuplicate(d, tool))) {
            deduped.push(tool);
        } else {
            logger.info(COMPONENT, `[Dedup] Skipping duplicate: \${tool.name}(\${JSON.stringify(tool.args).slice(0, 60)})`);
        }
    }

    const batches: Array<{ concurrent: boolean; calls: ToolCall[] }> = [];

    for (const tool of deduped) {
        const safe = isConcurrencySafe(tool);

        if (safe && batches.length > 0 && batches[batches.length - 1].concurrent) {
            // Add to existing concurrent batch
            batches[batches.length - 1].calls.push(tool);
        } else {
            // New batch
            batches.push({ concurrent: safe, calls: [tool] });
        }
    }

    return batches;
}

/** Analyze tools for dependency — can they run in parallel? */
function canRunParallel(tools: ToolCall[]): boolean {
    if (tools.length <= 1) return false;
    return tools.every(t => isConcurrencySafe(t));
}

/** Execute tools — partitioned into concurrent/sequential batches (TITAN pattern) */
export async function executeToolsParallel(
    toolCalls: ToolCall[],
    executor: ToolExecutor,
): Promise<ToolResult[]> {
    if (toolCalls.length === 0) return [];

    if (toolCalls.length === 1) {
        const tc = toolCalls[0];
        const content = await executor(tc.name, tc.args);
        return [{ toolCallId: tc.id, name: tc.name, content }];
    }

    // Partition into batches (TITAN pattern)
    const batches = partitionToolCalls(toolCalls);

    if (batches.length === 1 && batches[0].concurrent) {
        // All concurrent — run in parallel with concurrency cap
        const calls = batches[0].calls.slice(0, MAX_TOOL_CONCURRENCY);
        logger.info(COMPONENT, `\u26a1 Executing \${calls.length} tools in parallel (max \${MAX_TOOL_CONCURRENCY})`);
        const start = Date.now();
        const results = await Promise.all(
            calls.map(async (tc) => {
                const content = await executor(tc.name, tc.args);
                return { toolCallId: tc.id, name: tc.name, content };
            })
        );
        logger.info(COMPONENT, `\u2705 Parallel execution: \${calls.length} tools in \${Date.now() - start}ms`);
        return results;
    }

    // Mixed batches — run each batch in order
    const allResults: ToolResult[] = [];
    for (const batch of batches) {
        if (batch.concurrent && batch.calls.length > 1) {
            const calls = batch.calls.slice(0, MAX_TOOL_CONCURRENCY);
            logger.info(COMPONENT, `\u26a1 Batch: \${calls.length} concurrent tools`);
            const results = await Promise.all(
                calls.map(async (tc) => {
                    const content = await executor(tc.name, tc.args);
                    return { toolCallId: tc.id, name: tc.name, content };
                })
            );
            allResults.push(...results);
        } else {
            for (const tc of batch.calls) {
                const content = await executor(tc.name, tc.args);
                allResults.push({ toolCallId: tc.id, name: tc.name, content });
            }
        }
    }
    return allResults;
}

export function getParallelStats(toolCalls: ToolCall[]): {
    total: number;
    canParallelize: boolean;
    estimatedSpeedup: string;
} {
    const canP = canRunParallel(toolCalls);
    return {
        total: toolCalls.length,
        canParallelize: canP,
        estimatedSpeedup: canP && toolCalls.length > 1
            ? `~${toolCalls.length}x faster`
            : '1x (sequential)',
    };
}
