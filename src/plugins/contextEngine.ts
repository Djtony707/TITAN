/**
 * TITAN — ContextEngine Plugin Interface & Lifecycle Runner
 * Extensible plugin system for context assembly, compaction, and ingestion.
 */
import logger from '../utils/logger.js';
import type { ChatMessage } from '../providers/base.js';

const COMPONENT = 'ContextPlugin';

export interface ContextEnginePlugin {
    name: string;
    version: string;
    bootstrap?(config: Record<string, unknown>): Promise<void>;
    ingest?(content: string, metadata: Record<string, unknown>): Promise<void>;
    assemble?(context: ChatMessage[], userMessage: string): Promise<ChatMessage[]>;
    compact?(context: ChatMessage[], maxTokens: number): Promise<ChatMessage[]>;
    afterTurn?(turnResult: { content: string; toolsUsed: string[] }): Promise<void>;
    preTool?(toolName: string, args: Record<string, unknown>): Promise<{ allow: boolean; reason?: string; modifiedArgs?: Record<string, unknown> }>;
    postTool?(toolName: string, args: Record<string, unknown>, result: { content: string; success: boolean; durationMs: number }): Promise<{ modifiedContent?: string }>;
}

/** Run assemble hooks across all plugins in order */
export async function runAssemble(
    plugins: ContextEnginePlugin[],
    context: ChatMessage[],
    userMessage: string,
): Promise<ChatMessage[]> {
    let result = context;
    for (const plugin of plugins) {
        if (plugin.assemble) {
            try {
                result = await plugin.assemble(result, userMessage);
            } catch (e) {
                logger.warn(COMPONENT, `Plugin "${plugin.name}" assemble failed: ${(e as Error).message}`);
            }
        }
    }
    return result;
}

/** Run compact hooks across all plugins in order */
export async function runCompact(
    plugins: ContextEnginePlugin[],
    context: ChatMessage[],
    maxTokens: number,
): Promise<ChatMessage[]> {
    let result = context;
    for (const plugin of plugins) {
        if (plugin.compact) {
            try {
                result = await plugin.compact(result, maxTokens);
            } catch (e) {
                logger.warn(COMPONENT, `Plugin "${plugin.name}" compact failed: ${(e as Error).message}`);
            }
        }
    }
    return result;
}

/** Run afterTurn hooks across all plugins (fire-and-forget style, errors logged) */
export async function runAfterTurn(
    plugins: ContextEnginePlugin[],
    turnResult: { content: string; toolsUsed: string[] },
): Promise<void> {
    for (const plugin of plugins) {
        if (plugin.afterTurn) {
            try {
                await plugin.afterTurn(turnResult);
            } catch (e) {
                logger.warn(COMPONENT, `Plugin "${plugin.name}" afterTurn failed: ${(e as Error).message}`);
            }
        }
    }
}

/** Run ingest hooks across all plugins */
export async function runIngest(
    plugins: ContextEnginePlugin[],
    content: string,
    metadata: Record<string, unknown>,
): Promise<void> {
    for (const plugin of plugins) {
        if (plugin.ingest) {
            try {
                await plugin.ingest(content, metadata);
            } catch (e) {
                logger.warn(COMPONENT, `Plugin "${plugin.name}" ingest failed: ${(e as Error).message}`);
            }
        }
    }
}


/** Run preTool hooks — any plugin can block execution */
export async function runPreTool(
    plugins: ContextEnginePlugin[],
    toolName: string,
    args: Record<string, unknown>,
): Promise<{ allow: boolean; reason?: string; modifiedArgs?: Record<string, unknown> }> {
    let currentArgs = args;
    for (const plugin of plugins) {
        if (plugin.preTool) {
            try {
                const result = await plugin.preTool(toolName, currentArgs);
                if (!result.allow) {
                    logger.info(COMPONENT, `Plugin "${plugin.name}" blocked tool "${toolName}": ${result.reason || 'no reason'}`);
                    return result;
                }
                if (result.modifiedArgs) currentArgs = result.modifiedArgs;
            } catch (e) {
                logger.warn(COMPONENT, `Plugin "${plugin.name}" preTool failed: ${(e as Error).message}`);
            }
        }
    }
    return { allow: true, modifiedArgs: currentArgs !== args ? currentArgs : undefined };
}

/** Run postTool hooks — plugins can modify the result */
export async function runPostTool(
    plugins: ContextEnginePlugin[],
    toolName: string,
    args: Record<string, unknown>,
    result: { content: string; success: boolean; durationMs: number },
): Promise<{ modifiedContent?: string }> {
    let content = result.content;
    let modified = false;
    for (const plugin of plugins) {
        if (plugin.postTool) {
            try {
                const hookResult = await plugin.postTool(toolName, args, { ...result, content });
                if (hookResult.modifiedContent !== undefined) {
                    content = hookResult.modifiedContent;
                    modified = true;
                }
            } catch (e) {
                logger.warn(COMPONENT, `Plugin "${plugin.name}" postTool failed: ${(e as Error).message}`);
            }
        }
    }
    return modified ? { modifiedContent: content } : {};
}