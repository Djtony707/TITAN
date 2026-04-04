import { useState, useEffect, useCallback } from 'react';
import { Network } from 'lucide-react';
import { getCPOrg } from '@/api/client';
import type { OrgNode } from '@/api/types';
import { PageHeader, StatusBadge, EmptyState, SkeletonLoader } from '@/components/shared';

function timeSince(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function modelShort(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1];
}

function OrgTreeNode({ node, depth }: { node: OrgNode; depth: number }) {
  return (
    <div>
      <div className="flex items-start gap-3 py-2" style={{ paddingLeft: `${depth * 32 + 16}px` }}>
        {/* Connector lines */}
        {depth > 0 && (
          <div className="flex items-center gap-0 -ml-5">
            <div className="w-4 border-t border-border-light" />
          </div>
        )}
        <div className="bg-bg-secondary border border-border rounded-lg p-3 flex-1 max-w-sm hover:border-border-light transition-colors">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-text">{node.name}</span>
            <StatusBadge status={node.status} size="sm" />
          </div>
          <div className="flex items-center gap-3 text-[10px] text-text-muted">
            <span className="capitalize">{node.role}</span>
            {node.title && <span>{node.title}</span>}
            <span>{modelShort(node.model)}</span>
          </div>
        </div>
      </div>
      {node.reports.length > 0 && (
        <div className="relative">
          {/* Vertical connector */}
          <div
            className="absolute border-l border-border-light"
            style={{
              left: `${(depth + 1) * 32 + 16}px`,
              top: 0,
              height: '100%',
            }}
          />
          {node.reports.map(child => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function CPOrg() {
  const [org, setOrg] = useState<OrgNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getCPOrg();
      setOrg(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load org chart');
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Org Chart"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Org Chart' }]}
      />

      {loading && <SkeletonLoader variant="row" count={5} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && org.length === 0 && (
        <EmptyState icon={<Network size={32} />} title="No org structure" description="Register agents in Command Post to see the org chart." />
      )}

      {!loading && !error && org.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 overflow-x-auto">
          {org.map(node => (
            <OrgTreeNode key={node.id} node={node} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}

export default CPOrg;
