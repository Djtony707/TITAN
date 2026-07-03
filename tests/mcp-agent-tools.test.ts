/**
 * Agent-level MCP tools (v7.1 interop) — surface contract tests.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_TOOLS, getAgentTool } from '../src/mcp/agentTools.js';

describe('MCP agent tools', () => {
    it('exposes the whole-agent interface', () => {
        const names = AGENT_TOOLS.map(t => t.name);
        expect(names).toEqual(['titan_chat', 'titan_delegate_task', 'titan_task_status', 'titan_moa', 'titan_status']);
    });

    it('every tool has a schema with required fields declared', () => {
        for (const t of AGENT_TOOLS) {
            expect(t.inputSchema).toHaveProperty('type', 'object');
            expect(t.description.length).toBeGreaterThan(80); // peers need real guidance
            expect(t.description).toMatch(/Returns:/);
            expect(t.description).toMatch(/Errors:/);
        }
    });

    it('titan_task_status reports unknown ids as JSON, not a throw', async () => {
        const tool = getAgentTool('titan_task_status')!;
        const out = await tool.execute({ taskId: 'nope' });
        expect(JSON.parse(out)).toEqual({ status: 'unknown' });
    });

    it('getAgentTool misses cleanly', () => {
        expect(getAgentTool('shell')).toBeUndefined();
    });
});
