/**
 * TITAN — Claude Code External Adapter (v4.10.0-local)
 *
 * Wraps the Claude Code provider as an external adapter for the
 * multi-tool agent loop. All calls require explicit user opt-in.
 */
import type { ExternalAdapter, AdapterContext, AdapterResult } from './base.js';
import { ClaudeCodeProvider } from '../../providers/claudeCode.js';

const provider = new ClaudeCodeProvider();

export const claudeCodeAdapter: ExternalAdapter = {
    type: 'claude-code',
    displayName: 'Claude Code',
    execute: async (ctx: AdapterContext): Promise<AdapterResult> => {
        const start = Date.now();
        try {
            const result = await provider.chat({
                messages: [{ role: 'user', content: ctx.task }],
                model: 'claude-code/default',
                providerOptions: { allowClaudeCode: true },
            });
            return {
                content: result.content,
                exitCode: 0,
                success: true,
                durationMs: Date.now() - start,
                toolsUsed: [],
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: msg,
                exitCode: 1,
                success: false,
                durationMs: Date.now() - start,
                toolsUsed: [],
            };
        }
    },
};
