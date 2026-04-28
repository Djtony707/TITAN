/**
 * TITAN — Kimi Swarm Architecture
 *
 * Intercepts requests meant for kimi-k2.5:cloud and routes them through
 * specialized Sub-Agents. By breaking the 23-tool monolith into small 3-4
 * tool domain chunks, we prevent Kimi from suffering context collapse and
 * timeouts.
 *
 * v5.4.x note (Phase B consolidation): `runSubAgent` used to host its own
 * mini agent loop with a separate `chat()` + `executeTools()` cycle. That
 * bypassed every cross-cutting layer in `commandPost` / `budgetEnforcer` /
 * `guardrails` — sub-agents went off the books. It now delegates to the
 * canonical `spawnSubAgent` with a domain-restricted tool allowlist and a
 * 3-round cap. The Swarm Router's external surface (the
 * `delegate_to_X_agent` tools) is unchanged.
 */
import { spawnSubAgent } from './subAgent.js';
import { getToolDefinitions } from './toolRunner.js';
import type { ToolDefinition } from '../providers/base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Swarm';

export type Domain = 'file' | 'web' | 'system' | 'memory';

// Map generic tools to their specific domains
const domainMap: Record<string, Domain> = {
    // File Domain
    'read_file': 'file',
    'write_file': 'file',
    'edit_file': 'file',
    'list_dir': 'file',
    'filesystem': 'file',
    // Web Domain
    'web_search': 'web',
    'web_fetch': 'web',
    'webhook': 'web',
    'browser': 'web',
    // System Domain
    'shell': 'system',
    'cron': 'system',
    'process': 'system',
    // Memory Domain
    'memory_skill': 'memory',
};

/** Get the Swarm Router tools to present to the Main LLM */
export function getSwarmRouterTools(): ToolDefinition[] {
    return [
        {
            type: 'function',
            function: {
                name: 'delegate_to_file_agent',
                description: 'Delegate a file system task to the File Agent (reading, writing, listing directories)',
                parameters: {
                    type: 'object',
                    properties: {
                        instruction: { type: 'string', description: 'Detailed instruction of what the File Agent should do' }
                    },
                    required: ['instruction']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'delegate_to_web_agent',
                description: 'Delegate a web task to the Web Agent (searching the web, fetching URLs, controlling a browser)',
                parameters: {
                    type: 'object',
                    properties: {
                        instruction: { type: 'string', description: 'Detailed instruction of what the Web Agent should do' }
                    },
                    required: ['instruction']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'delegate_to_system_agent',
                description: 'Delegate an OS task to the System Agent (running shell commands, managing processes/cron)',
                parameters: {
                    type: 'object',
                    properties: {
                        instruction: { type: 'string', description: 'Detailed instruction of what the System Agent should do' }
                    },
                    required: ['instruction']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'delegate_to_memory_agent',
                description: 'Delegate a memory task to the Memory Agent (saving facts or retrieving knowledge)',
                parameters: {
                    type: 'object',
                    properties: {
                        instruction: { type: 'string', description: 'Detailed instruction of what the Memory Agent should do' }
                    },
                    required: ['instruction']
                }
            }
        }
    ];
}

/** Get the exact subset of registered tools belonging to a specific domain */
function getDomainTools(domain: Domain): ToolDefinition[] {
    const allTools = getToolDefinitions();
    // Default to 'file' domain for unrecognized tools to err on the side of caution
    return allTools.filter(t => (domainMap[t.function.name] || 'file') === domain);
}

/**
 * Spawn a domain-restricted ephemeral sub-agent for the Swarm Router.
 *
 * v5.4.x: this is now a thin shim over `spawnSubAgent`. The previous
 * implementation ran its own `chat()` + `executeTools()` loop, which left
 * the spawned agent invisible to the governance overlay (Command Post,
 * BudgetEnforcer, audit log). All sub-agent execution now flows through
 * the canonical path.
 *
 * Behavior preserved:
 *   - Tool surface restricted to the requested domain (file/web/system/memory).
 *   - 3-round cap (matched the original mini-loop ceiling).
 *   - Output prefixed with `[Sub-Agent Result / Domain: <domain>]` so
 *     callers' string parsing still works.
 *   - Errors return a string starting with `Sub-Agent encountered an error:`
 *     rather than throwing, matching the old contract.
 */
export async function runSubAgent(
    domain: Domain,
    instruction: string,
    model: string,
): Promise<string> {
    logger.info(COMPONENT, `[Swarm] Spawning ${domain.toUpperCase()} Sub-Agent to handle: "${instruction.slice(0, 50)}..."`);

    const domainTools = getDomainTools(domain);
    const toolNames = domainTools.map(t => t.function.name);

    try {
        const result = await spawnSubAgent({
            // The `name` field becomes the agent's identifier in logs and
            // governance feeds — keep it descriptive of the swarm domain.
            name: `swarm-${domain}`,
            task: instruction,
            model,
            // Match the historical 3-round budget exactly. The driver has
            // its own depth-aware reduction on top of this; see subAgent.ts
            // ~line 408.
            maxRounds: 3,
            // `spawnSubAgent` interprets `tools` as an allowlist of tool
            // *names*. Empty list → no tools are presented to the model
            // (matches the old `tools: domainTools.length > 0 ? ... :
            // undefined` semantics, since `spawnSubAgent` skips the tool
            // header when the resolved set is empty).
            tools: toolNames,
        });

        const finalContent = result?.content || 'Task completed silently.';
        return `[Sub-Agent Result / Domain: ${domain}]\n${finalContent}`;
    } catch (e) {
        logger.error(COMPONENT, `[Sub-Agent ${domain}] Error: ${(e as Error).message}`);
        return `Sub-Agent encountered an error: ${(e as Error).message}`;
    }
}
