import { useEffect, useState } from 'react';
import {
  Activity,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  MessageSquare,
  Server,
  Zap,
} from 'lucide-react';
import { getStats } from '@/api/client';
import type { SystemStats } from '@/api/types';
import { StatCard } from '@/components/shared/StatCard';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonLoader } from '@/components/shared/SkeletonLoader';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb > 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function OverviewPanel() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    try {
      const data = await getStats();
      setStats(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch stats');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 10_000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="System Overview"
          breadcrumbs={[{ label: 'Admin', href: '/overview' }, { label: 'Monitoring' }, { label: 'Overview' }]}
        />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <SkeletonLoader variant="metric" count={8} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-error/50 bg-bg-secondary p-6 text-center text-error">
        {error}
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="System Overview"
        subtitle="Real-time system health and metrics"
        breadcrumbs={[{ label: 'Admin', href: '/overview' }, { label: 'Monitoring' }, { label: 'Overview' }]}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Uptime"
          value={formatUptime(stats.uptime)}
          icon={<Clock className="h-5 w-5" />}
        />
        <StatCard
          title="Total Requests"
          value={stats.totalRequests.toLocaleString()}
          icon={<Zap className="h-5 w-5" />}
        />
        <StatCard
          title="Active Agents"
          value={stats.activeAgents}
          icon={<Activity className="h-5 w-5" />}
        />
        <StatCard
          title="Active Sessions"
          value={stats.activeSessions}
          icon={<MessageSquare className="h-5 w-5" />}
        />
        <StatCard
          title="Memory Usage"
          value={formatBytes(stats.memoryUsage.heapUsed)}
          icon={<HardDrive className="h-5 w-5" />}
          subtitle={`${formatBytes(stats.memoryUsage.heapTotal)} total`}
        />
        <StatCard
          title="Model"
          value={stats.model}
          icon={<Cpu className="h-5 w-5" />}
        />
        <StatCard
          title="Provider"
          value={stats.provider}
          icon={<Server className="h-5 w-5" />}
        />
        <StatCard
          title="Version"
          value={stats.version}
          icon={<Layers className="h-5 w-5" />}
        />
      </div>
    </div>
  );
}

export default OverviewPanel;
