/**
 * TITAN — Claude Code Provider (v4.10.0-local)
 *
 * Bridges to Anthropic's Claude Code CLI. Requires explicit user opt-in
 * via `providerOptions.allowClaudeCode: true` on every call — autonomous
 * paths are blocked by design to prevent runaway CLI spend.
 */
import { existsSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { LLMProvider, type ChatOptions, type ChatResponse, type ChatStreamChunk } from './base.js';
import { isClaudeCodeAllowed } from './base.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ClaudeCode';

function findClaudeBinary(): string | null {
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
        const p = `${dir}/claude`;
        if (existsSync(p)) {
            // In non-TTY environments Claude Code may hang on --print,
            // so we probe with a short timeout. If it doesn't respond
            // we treat it as unavailable.
            const probe = spawnSync(p, ['--print', 'hello'], { timeout: 3000, encoding: 'utf-8' });
            if (probe.status === 0) {
                return p;
            }
        }
    }
    return null;
}

export class ClaudeCodeProvider extends LLMProvider {
    name = 'claude-code';
    displayName = 'Claude Code (requires MAX plan)';

    async listModels(): Promise<string[]> {
        return [
            'claude-code/default',
            'claude-code/sonnet-4.5',
            'claude-code/opus-4.6',
            'claude-code/haiku-4.5',
            'claude-code/sonnet-4.6',
            'claude-code/haiku-4.6',
            'claude-code/opus-4.7',
        ];
    }

    async healthCheck(): Promise<boolean> {
        return findClaudeBinary() !== null;
    }

    async chat(options: ChatOptions): Promise<ChatResponse> {
        if (!isClaudeCodeAllowed(options)) {
            throw new Error(
                'Claude Code blocked for autonomous use. ' +
                'Set providerOptions.allowClaudeCode: true when the user explicitly picks a claude-code model.',
            );
        }

        const binary = findClaudeBinary();
        if (!binary) {
            throw new Error('Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code');
        }

        const prompt = options.messages.map(m =>
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ).join('\n\n');

        return new Promise((resolve, reject) => {
            const child = spawn(binary, ['--print', prompt], {
                timeout: options.maxTokens ? options.maxTokens * 10 : 300_000,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', (err) => reject(err));
            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Claude Code exited ${code}: ${stderr}`));
                    return;
                }
                resolve({
                    id: `claude-${Date.now()}`,
                    content: stdout.trim(),
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                    finishReason: 'stop',
                    model: options.model || 'claude-code/default',
                });
            });
        });
    }

    async *chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
        const response = await this.chat(options);
        yield { type: 'text', content: response.content };
        yield { type: 'done' };
    }
}
