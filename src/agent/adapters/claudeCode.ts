/** Disabled compatibility adapter. It never starts a process or calls a provider. */
import type { ExternalAdapter } from './base.js';
import { CLAUDE_CODE_DISABLED_MESSAGE } from '../../security/externalAgentPolicy.js';

export const claudeCodeAdapter: ExternalAdapter = {
    type: 'claude-code',
    displayName: 'Claude Code (disabled by policy)',
    execute: async () => ({
        content: CLAUDE_CODE_DISABLED_MESSAGE,
        exitCode: 1,
        success: false,
        durationMs: 0,
        toolsUsed: [],
    }),
};
