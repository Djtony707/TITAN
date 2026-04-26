import { getAgents, getConfig, getSkills, getTools, getSessions, getTraces } from './client';
import type { AgentInfo, SkillInfo, ToolInfo, Session, Trace } from './types';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Dashboard API — Aggregates data for the overview screen
   Pattern ported from Space Agent (Paperclip)
   ═══════════════════════════════════════════════════════════════════ */

export interface DashboardSummary {
  agents: {
    total: number;
    running: number;
    paused: number;
    error: number;
  };
  sessions: {
    total: number;
    today: number;
    recent: Session[];
  };
  skills: {
    total: number;
    enabled: number;
  };
  tools: {
    total: number;
  };
  model: string;
  provider: string;
}

export interface DashboardActivity {
  id: string;
  type: 'agent_start' | 'agent_stop' | 'session_created' | 'tool_called' | 'error';
  title: string;
  description: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
}

export const dashboardApi = {
  async summary(): Promise<DashboardSummary> {
    const [agents, sessions, skills, tools, config] = await Promise.all([
      getAgents().catch(() => ({ agents: [] as AgentInfo[], capacity: 0 })),
      getSessions().catch(() => [] as Session[]),
      getSkills().catch(() => [] as SkillInfo[]),
      getTools().catch(() => [] as ToolInfo[]),
      getConfig().catch(() => ({ model: 'unknown', provider: 'unknown' })),
    ]);

    const today = new Date().toISOString().slice(0, 10);

    return {
      agents: {
        total: agents.agents.length,
        running: agents.agents.filter(a => a.status === 'running').length,
        paused: agents.agents.filter(a => a.status === 'stopped').length,
        error: agents.agents.filter(a => a.status === 'error').length,
      },
      sessions: {
        total: sessions.length,
        today: sessions.filter(s => s.createdAt?.startsWith(today)).length,
        recent: sessions.slice(0, 5),
      },
      skills: {
        total: skills.length,
        enabled: skills.filter(s => s.enabled).length,
      },
      tools: {
        total: tools.length,
      },
      model: config.model || 'default',
      provider: config.provider || 'default',
    };
  },

  async activity(): Promise<DashboardActivity[]> {
    try {
      const [{ agents }, sessions, { traces }] = await Promise.all([
        getAgents(),
        getSessions(),
        getTraces(20),
      ]);

      const activities: DashboardActivity[] = [];

      // Agent events
      for (const agent of agents.slice(0, 5)) {
        activities.push({
          id: `agent-${agent.id}`,
          type: agent.status === 'running' ? 'agent_start' : agent.status === 'error' ? 'error' : 'agent_stop',
          title: agent.name,
          description: `${agent.status} · ${agent.messageCount} messages`,
          timestamp: agent.createdAt || new Date().toISOString(),
          agentId: agent.id,
          agentName: agent.name,
        });
      }

      // Session events
      for (const session of sessions.slice(0, 5)) {
        activities.push({
          id: `session-${session.id}`,
          type: 'session_created',
          title: session.name || 'Untitled Session',
          description: `${session.messageCount ?? 0} messages`,
          timestamp: session.createdAt || new Date().toISOString(),
        });
      }

      // Trace events
      for (const trace of traces.slice(0, 5)) {
        const firstTool = trace.toolCalls[0];
        activities.push({
          id: `trace-${trace.traceId}`,
          type: trace.status === 'failed' ? 'error' : 'tool_called',
          title: firstTool?.tool || trace.model || 'Trace',
          description: trace.error || `Duration: ${trace.totalMs ?? 0}ms · ${trace.rounds} rounds`,
          timestamp: trace.startedAt,
        });
      }

      // Sort by timestamp descending
      return activities
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 15);
    } catch {
      return [];
    }
  },
};
