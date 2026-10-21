/**
 * TITAN — Claude Code Provider (v4.10.0-local)
 *
 * Disabled compatibility provider. Standing runtime policy prohibits execution;
 * filesystem health metadata only reports whether an executable is installed.
 */
import { accessSync, constants, statSync } from 'fs';
import { LLMProvider, type ChatOptions, type ChatResponse, type ChatStreamChunk } from './base.js';
import { CLAUDE_CODE_DISABLED_MESSAGE } from '../security/externalAgentPolicy.js';

function findClaudeBinary(): string | null {
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
        const p = `${dir}/claude`;
        try {
            // stat follows symlinks; directories and non-executable targets are
            // unavailable. Discovery must never start the CLI, even for metadata.
            if (!statSync(p).isFile()) continue;
            accessSync(p, constants.X_OK);
            return p;
        } catch { /* Missing, inaccessible or broken symlink: try the next PATH entry. */ }
    }
    return null;
}

export class ClaudeCodeProvider extends LLMProvider {
    name = 'claude-code';
    displayName = 'Claude Code (disabled by policy)';

    isConfigured(): boolean { return false; }

    async listModels(): Promise<string[]> { return []; }

    async healthCheck(): Promise<boolean> {
        return findClaudeBinary() !== null;
    }

    async chat(_options: ChatOptions): Promise<ChatResponse> {
        throw new Error(CLAUDE_CODE_DISABLED_MESSAGE);
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const response = await this.chat(options);
        yield { type: 'text', content: response.content };
        yield { type: 'done' };
    }
}
