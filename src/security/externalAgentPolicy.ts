/** Standing runtime policy; saved settings and per-call flags cannot override it. */
export const CLAUDE_CODE_EXECUTION_ALLOWED = false;
export const CLAUDE_CODE_DISABLED_MESSAGE = 'Claude Code execution is disabled by TITAN standing policy.';

export function isClaudeCodeAgent(agent: string): boolean {
    const normalized = agent.trim().toLowerCase().replaceAll('_', '-').replace(/\s+/g, '-');
    const name = normalized.split('/')[0];
    return name === 'claude' || name === 'claude-code' || name === 'claudecode' ||
        normalized === '@anthropic-ai/claude-code' || normalized.startsWith('@anthropic-ai/claude-code/');
}

export function assertExternalAgentAllowed(agent: string): void {
    if (isClaudeCodeAgent(agent)) throw new Error(CLAUDE_CODE_DISABLED_MESSAGE);
}
