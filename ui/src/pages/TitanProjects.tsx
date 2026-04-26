import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  FolderKanban, Plus, Search, Filter, MoreHorizontal,
  Clock, Bot, CircleDot, TrendingUp, Calendar
} from 'lucide-react';
import { getSessions, getAgents } from '@/api/client';
import { queryKeys } from '@/lib/queryKeys';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Projects — Space Agent-style project board
   Groups sessions/agents into project workspaces
   ═══════════════════════════════════════════════════════════════════ */

interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'completed';
  issueCount: number;
  agentCount: number;
  lastActive: string;
  progress: number;
}

export function TitanProjects() {
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [search, setSearch] = useState('');

  // Derive projects from sessions for prototype
  const { data: sessions } = useQuery({
    queryKey: queryKeys.sessions.list(),
    queryFn: getSessions,
  });

  const { data: agentsData } = useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: getAgents,
  });

  // Mock projects derived from sessions
  const projects: Project[] = (sessions ?? []).slice(0, 8).map((session, i) => ({
    id: session.id,
    name: session.name || `Project ${i + 1}`,
    description: `${session.messageCount} messages · ${session.channel || 'general'}`,
    status: i % 3 === 0 ? 'active' : i % 3 === 1 ? 'paused' : 'completed',
    issueCount: Math.floor(Math.random() * 12) + 1,
    agentCount: Math.floor(Math.random() * 3) + 1,
    lastActive: session.lastActive || session.createdAt,
    progress: Math.floor(Math.random() * 100),
  }));

  const filtered = projects
    .filter(p => filter === 'all' || p.status === filter)
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-[#fafafa]">Projects</h1>
          <p className="text-xs text-[#52525b]">{filtered.length} project{filtered.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] text-xs font-medium hover:bg-[#6366f1]/20 transition-colors">
          <Plus className="w-3.5 h-3.5" />
          New Project
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#52525b]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full bg-[#18181b] border border-[#27272a] rounded-lg pl-8 pr-3 py-2 text-xs text-[#fafafa] placeholder:text-[#3f3f46] outline-none focus:border-[#6366f1]/30"
          />
        </div>
        <div className="flex gap-1">
          {(['all', 'active', 'paused'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] capitalize transition-colors ${
                filter === f
                  ? 'bg-[#6366f1]/15 text-[#6366f1] font-medium'
                  : 'text-[#52525b] hover:text-[#a1a1aa] hover:bg-[#27272a]/50'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Project Grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(project => (
          <ProjectCard key={project.id} project={project} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12">
          <FolderKanban className="w-8 h-8 text-[#3f3f46] mx-auto mb-3" />
          <p className="text-sm text-[#52525b]">No projects found</p>
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const statusColors = {
    active: { bg: 'bg-[#22c55e]/10', text: 'text-[#22c55e]', border: 'border-[#22c55e]/20' },
    paused: { bg: 'bg-[#f59e0b]/10', text: 'text-[#f59e0b]', border: 'border-[#f59e0b]/20' },
    completed: { bg: 'bg-[#6366f1]/10', text: 'text-[#6366f1]', border: 'border-[#6366f1]/20' },
  };
  const s = statusColors[project.status];

  return (
    <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 p-4 hover:border-[#6366f1]/20 transition-all group">
      <div className="flex items-start justify-between mb-3">
        <div className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${s.bg} ${s.text} ${s.border} border`}>
          {project.status}
        </div>
        <button className="text-[#3f3f46] hover:text-[#a1a1aa] transition-colors">
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      <h3 className="text-sm font-semibold text-[#fafafa] mb-1">{project.name}</h3>
      <p className="text-[11px] text-[#52525b] mb-3 line-clamp-2">{project.description}</p>

      {/* Progress */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-[9px] text-[#52525b] mb-1">
          <span>Progress</span>
          <span>{project.progress}%</span>
        </div>
        <div className="w-full bg-[#27272a] rounded-full h-1.5">
          <div
            className="h-1.5 rounded-full bg-[#6366f1] transition-all"
            style={{ width: `${project.progress}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 text-[10px] text-[#52525b]">
        <span className="flex items-center gap-1">
          <CircleDot className="w-3 h-3" />
          {project.issueCount} issues
        </span>
        <span className="flex items-center gap-1">
          <Bot className="w-3 h-3" />
          {project.agentCount} agents
        </span>
        <span className="flex items-center gap-1 ml-auto">
          <Clock className="w-3 h-3" />
          {timeAgo(project.lastActive)}
        </span>
      </div>
    </div>
  );
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}
