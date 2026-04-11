import { useState, useEffect, useCallback } from 'react';
import { Network, Trash2, StopCircle, Play } from 'lucide-react';
import { getCPOrg } from '@/api/client';
import { deleteCompany } from '@/api/client';
import type { OrgNode } from '@/api/types';
import { PageHeader, StatusBadge, EmptyState, SkeletonLoader } from '@/components/shared';

function modelShort(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1];
}

function OrgTreeNode({
  node,
  depth,
  onDelete,
}: {
  node: OrgNode;
  depth: number;
  onDelete?: (id: string, name: string) => void;
}) {
  const isCompany = node.role === 'Company';

  return (
    <div>
      <div className="flex items-start gap-3 py-2" style={{ paddingLeft: `${depth * 32 + 16}px` }}>
        {depth > 0 && (
          <div className="flex items-center gap-0 -ml-5">
            <div className="w-4 border-t border-border-light" />
          </div>
        )}
        <div className={`border rounded-lg p-3 flex-1 max-w-sm transition-colors group ${
          isCompany
            ? 'bg-accent/5 border-accent/20 hover:border-accent/40'
            : 'bg-bg-secondary border-border hover:border-border-light'
        }`}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text">{node.name}</span>
              <StatusBadge status={node.status} size="sm" />
            </div>
            {/* Delete button for companies */}
            {isCompany && onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(node.id, node.name); }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-error/20 text-text-muted hover:text-error transition-all"
                title={`Delete ${node.name}`}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 text-[10px] text-text-muted">
            {isCompany && <span className="text-accent text-[9px] font-medium uppercase tracking-wider">Company</span>}
            {!isCompany && <span className="capitalize">{node.role}</span>}
            {node.title && <span>{node.title}</span>}
            {node.model && <span>{modelShort(node.model)}</span>}
          </div>
          {/* Show agent count for companies */}
          {isCompany && node.reports.length > 0 && (
            <div className="text-[10px] text-text-muted mt-1">
              {node.reports.length} agent{node.reports.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
      {node.reports.length > 0 && (
        <div className="relative">
          <div
            className="absolute border-l border-border-light"
            style={{
              left: `${(depth + 1) * 32 + 16}px`,
              top: 0,
              height: '100%',
            }}
          />
          {node.reports.map(child => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} onDelete={onDelete} />
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
  const [deleting, setDeleting] = useState<string | null>(null);

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

  const handleDeleteCompany = useCallback(async (id: string, name: string) => {
    if (!confirm(`Delete company "${name}"?\n\nThis will:\n• Stop the heartbeat runner\n• Archive all agents\n• Archive all goals and issues\n\nThis cannot be undone.`)) return;

    setDeleting(id);
    try {
      await deleteCompany(id);
      await refresh();
    } catch (e) {
      alert(`Failed to delete: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
    setDeleting(null);
  }, [refresh]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Organization Chart"
        breadcrumbs={[{ label: 'Command Post' }, { label: 'Org Chart' }]}
        count={org.length}
      />

      {loading && <SkeletonLoader variant="row" count={5} />}
      {error && <div className="text-center py-8 text-error text-sm">{error}</div>}

      {!loading && !error && org.length === 0 && (
        <EmptyState icon={<Network size={32} />} title="No org structure" description="Register agents or create companies to see the org chart." />
      )}

      {!loading && !error && org.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4 overflow-x-auto">
          {org.map(node => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              onDelete={handleDeleteCompany}
            />
          ))}
          {deleting && (
            <div className="text-xs text-text-muted text-center py-2 animate-pulse">Deleting...</div>
          )}
        </div>
      )}
    </div>
  );
}

export default CPOrg;
