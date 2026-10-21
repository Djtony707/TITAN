import { describe, it, expect } from 'vitest';
import { detectAvailableAgents, buildAgentCommand, EXTERNAL_AGENTS } from '../src/skills/builtin/delegate_agent.js';

describe('detectAvailableAgents', () => {
    it('returns only the agents whose binary is available', () => {
        const probe = (bin: string) => bin === 'codex' || bin === 'aider';
        expect(detectAvailableAgents(probe).sort()).toEqual(['aider', 'codex']);
    });
    it('returns empty when nothing is installed', () => {
        expect(detectAvailableAgents(() => false)).toEqual([]);
    });
    it('never reports claude/claude-code even if a binary named claude exists', () => {
        // A machine with `claude` installed must NOT surface it for delegation.
        const probe = (bin: string) => bin === 'claude' || bin === 'goose';
        const got = detectAvailableAgents(probe);
        expect(got).not.toContain('claude');
        expect(got).not.toContain('claude-code');
        expect(got).toContain('goose');
    });
});

describe('buildAgentCommand', () => {
    it('builds a non-interactive command for each known agent', () => {
        expect(buildAgentCommand('codex', 'fix the bug')).toEqual({ cmd: 'codex', args: ['exec', '--full-auto', '-'], input: 'fix the bug' });
        expect(buildAgentCommand('aider', 'add tests')).toMatchObject({ cmd: 'aider' });
        expect(buildAgentCommand('goose', 'refactor')).toMatchObject({ cmd: 'goose' });
    });
    it('REFUSES to delegate to Claude Code (standing rule)', () => {
        expect(() => buildAgentCommand('claude', 'do it')).toThrow(/disabled by TITAN standing policy/);
        expect(() => buildAgentCommand('claude-code', 'do it')).toThrow();
    });
    it('throws on an unknown agent', () => {
        expect(() => buildAgentCommand('nonsense', 'task')).toThrow(/Unknown agent/);
    });
    it('requires a non-empty task', () => {
        expect(() => buildAgentCommand('codex', '')).toThrow(/task is required/i);
    });
    it.each(['codex', 'aider', 'goose', 'gemini', 'opencode'])('binds leading task options literally for %s', (agent) => {
        const task = '--dangerously-bypass-approvals-and-sandbox';
        const command = buildAgentCommand(agent, task);
        if (agent === 'codex') {
            expect(command).toEqual({ cmd: 'codex', args: ['exec', '--full-auto', '-'], input: task });
        } else if (agent === 'opencode') {
            expect(command.args).toEqual(['run', '--', task]);
        } else {
            const option = { aider: '--message', goose: '--text', gemini: '--prompt' }[agent];
            expect(command.args).toContain(`${option}=${task}`);
            expect(command.args).not.toContain(task);
        }
    });
});

describe('EXTERNAL_AGENTS registry', () => {
    it('does not contain claude in any form', () => {
        for (const name of Object.keys(EXTERNAL_AGENTS)) {
            expect(name).not.toMatch(/claude/i);
            expect(EXTERNAL_AGENTS[name].bin).not.toMatch(/claude/i);
        }
    });
});
