import { useState, useEffect } from 'react';
import { Brain, RefreshCw, BookOpen, Wrench, AlertTriangle, Lightbulb, Database, TrendingUp } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

interface LearningData {
  knowledgeEntries: number;
  toolsTracked: number;
  errorPatterns: number;
  corrections: number;
  insights: number;
}

interface StatsData {
  totalTokens: number;
  totalRequests: number;
  version: string;
  uptime: number;
  memoryMB: number;
}

interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  episodeCount: number;
}

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1000000).toFixed(2)}M`;
}

function StatCard({ icon: Icon, label, value, color, sub }: {
  icon: typeof Brain;
  label: string;
  value: string | number;
  color: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md" style={{ backgroundColor: color + '15' }}>
          <Icon className="h-3.5 w-3.5" style={{ color }} />
        </div>
        <p className="text-xs text-text-muted">{label}</p>
      </div>
      <p className="text-2xl font-bold text-text">{value}</p>
      {sub && <p className="text-[10px] text-text-muted mt-1">{sub}</p>}
    </div>
  );
}

function LearningPanel() {
  const [learning, setLearning] = useState<LearningData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [graph, setGraph] = useState<GraphStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/learning').then(r => r.ok ? r.json() : null).catch(() => null),
      apiFetch('/api/stats').then(r => r.ok ? r.json() : null).catch(() => null),
      apiFetch('/api/graphiti').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([l, s, g]) => {
      setLearning(l);
      setStats(s);
      setGraph(g ? { nodeCount: g.nodeCount || 0, edgeCount: g.edgeCount || 0, episodeCount: g.episodeCount || 0 } : null);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { fetchAll(); }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-10 animate-pulse rounded-xl bg-bg-secondary" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-bg-secondary" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Learning"
        subtitle="Knowledge base, tool mastery, and memory systems"
        breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Memory'}, {label:'Learning'}]}
        actions={
          <button
            onClick={fetchAll}
            className="flex items-center gap-1.5 rounded-lg bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:bg-border hover:text-text transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        }
      />

      {/* Knowledge Stats */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Knowledge Base</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={BookOpen}
            label="Knowledge Entries"
            value={learning?.knowledgeEntries ?? 0}
            color="#6366f1"
            sub="Facts, patterns, corrections"
          />
          <StatCard
            icon={Wrench}
            label="Tools Tracked"
            value={learning?.toolsTracked ?? 0}
            color="#22d3ee"
            sub="Success rates learned"
          />
          <StatCard
            icon={AlertTriangle}
            label="Error Patterns"
            value={learning?.errorPatterns ?? 0}
            color="#f59e0b"
            sub="Known failure modes"
          />
          <StatCard
            icon={Lightbulb}
            label="Corrections"
            value={learning?.corrections ?? 0}
            color="#34d399"
            sub="User-taught improvements"
          />
        </div>
      </div>

      {/* Memory Graph Stats */}
      {graph && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">Memory Graph</p>
          <div className="grid grid-cols-3 gap-3">
            <StatCard
              icon={Database}
              label="Entities"
              value={graph.nodeCount}
              color="#818cf8"
              sub="People, topics, projects"
            />
            <StatCard
              icon={TrendingUp}
              label="Relationships"
              value={graph.edgeCount}
              color="#22d3ee"
              sub="Connections between entities"
            />
            <StatCard
              icon={BookOpen}
              label="Episodes"
              value={graph.episodeCount}
              color="#34d399"
              sub="Conversation memories"
            />
          </div>
        </div>
      )}

      {/* System Stats */}
      {stats && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-text-muted mb-3">System</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <p className="text-xs text-text-muted">Tokens Used</p>
              <p className="text-xl font-bold text-text">{formatTokens(stats.totalTokens)}</p>
            </div>
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <p className="text-xs text-text-muted">Requests</p>
              <p className="text-xl font-bold text-text">{stats.totalRequests}</p>
            </div>
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <p className="text-xs text-text-muted">Uptime</p>
              <p className="text-xl font-bold text-text">{formatUptime(stats.uptime)}</p>
            </div>
            <div className="rounded-xl border border-bg-tertiary bg-bg-secondary p-4">
              <p className="text-xs text-text-muted">Memory</p>
              <p className="text-xl font-bold text-text">{stats.memoryMB}MB</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LearningPanel;
