/**
 * TITAN — Kimi Swarm Architecture
 * 
 * Intercepts requests meant for kimi-k2.5:cloud and routes them through specialized Sub-Agents.
 * By breaking the 23-tool monolith into small 3-4 tool domain chunks, we prevent Kimi from
 * suffering context collapse and timeouts.
 */
import { chat } from '../providers/router.js';
import { executeTools, getToolDefinitions } from './toolRunner.js';
import type { ChatMessage, ToolDefinition } from '../providers/base.js';
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
 * Spawns an ephemeral Sub-Agent with a restricted toolset. 
 * This is executed sequentially by the Main Director.
 */
export async function runSubAgent(
    domain: Domain,
    instruction: string,
    model: string,
): Promise<string> {
    logger.info(COMPONENT, `[Swarm] Spawning ${domain.toUpperCase()} Sub-Agent to handle: "${instruction.slice(0, 50)}..."`);

    const domainTools = getDomainTools(domain);

    // Mini agent loop (max 3 rounds)
    const messages: ChatMessage[] = [
        { role: 'system', content: `You are the ${domain.toUpperCase()} Sub-Agent of TITAN.\nYour ONLY job is to execute the tools necessary to fulfill this instruction:\n\n${instruction}\n\nReturn a final text summary of the results.` },
        { role: 'user', content: instruction }
    ];

    let finalContent = '';

    for (let round = 0; round < 3; round++) {
        logger.debug(COMPONENT, `[Sub-Agent ${domain}] Round ${round + 1} with ${domainTools.length} tools`);

        try {
            const response = await chat({
                model,
                messages,
                tools: domainTools.length > 0 ? domainTools : undefined,
                maxTokens: 4096,
                temperature: 0.2, // Low temp for strictly clinical tool execution
            });

            if (!response.toolCalls || response.toolCalls.length === 0) {
                finalContent = response.content || 'Task completed silently.';
                break;
            }

            messages.push({
                role: 'assistant',
                content: response.content || '',
                toolCalls: response.toolCalls,
            });

            const toolResults = await executeTools(response.toolCalls);

            for (const result of toolResults) {
                messages.push({
                    role: 'tool',
                    // Include name — Gemini's Ollama adapter rejects
                    // function_response with empty name (HTTP 400).
                    name: result.name,
                    content: result.content,
                    toolCallId: result.toolCallId,
                });
            }

            if (round === 2) {
                finalContent = "Max sub-agent rounds reached. Partial results returned.";
            }

        } catch (e) {
            logger.error(COMPONENT, `[Sub-Agent ${domain}] Error: ${(e as Error).message}`);
            return `Sub-Agent encountered an error: ${(e as Error).message}`;
        }
    }

    return `[Sub-Agent Result / Domain: ${domain}]\n${finalContent}`;
}
