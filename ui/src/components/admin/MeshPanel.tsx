import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, ShieldX, Unplug } from 'lucide-react';
import {
  getMeshPeers,
  getPendingPeers,
  approvePeer,
  rejectPeer,
  revokePeer,
} from '@/api/client';
import type { MeshPeer } from '@/api/types';
import { DataTable, type Column } from '@/components/shared/DataTable';

function MeshPanel() {
  const [peers, setPeers] = useState<MeshPeer[]>([]);
  const [pending, setPending] = useState<MeshPeer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async () => {
    try {
      const [p, pend] = await Promise.all([getMeshPeers(), getPendingPeers()]);
      setPeers(p);
      setPending(pend);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch mesh data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const handleApprove = async (id: string) => {
    try {
      await approvePeer(id);
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve peer');
    }
  };

  const handleReject = async (id: string) => {
    try {
      await rejectPeer(id);
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject peer');
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokePeer(id);
      await fetchAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke peer');
    }
  };

  const peerColumns: Column<MeshPeer>[] = [
    { key: 'nodeId', header: 'Node ID', render: (row) => <span className="font-mono text-xs">{row.nodeId}</span> },
    { key: 'url', header: 'URL' },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <span className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-success" />
          <span className="capitalize">{row.status}</span>
        </span>
      ),
    },
    {
      key: 'connectedAt',
      header: 'Connected At',
      render: (row) =>
        row.connectedAt ? (
          <span>{new Date(row.connectedAt).toLocaleString()}</span>
        ) : (
          <span className="text-text-muted">-</span>
        ),
    },
    {
      key: '_actions',
      header: '',
      className: 'w-16',
      render: (row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleRevoke(row.id);
          }}
          className="rounded-md p-1.5 text-error transition-colors hover:bg-bg-tertiary"
          title="Revoke peer"
        >
          <Unplug className="h-4 w-4" />
        </button>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-xl border border-border bg-bg-secondary" />
        <div className="h-48 animate-pulse rounded-xl border border-border bg-bg-secondary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-text">Mesh Network</h2>
        <button
          onClick={fetchAll}
          className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-error/50 bg-bg-secondary px-4 py-2 text-sm text-error">
          {error}
        </div>
      )}

      {/* Pending Requests */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-text-secondary">
          Pending Requests ({pending.length})
        </h3>
        {pending.length === 0 ? (
          <div className="rounded-xl border border-border bg-bg-secondary p-6 text-center text-text-muted">
            No pending requests
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {pending.map((peer) => (
              <div
                key={peer.id}
                className="rounded-xl border border-border bg-bg-secondary p-4"
              >
                <p className="font-mono text-sm text-text">{peer.nodeId}</p>
                <p className="mt-1 text-xs text-text-secondary">{peer.url}</p>
                {peer.name && (
                  <p className="mt-1 text-xs text-text-muted">{peer.name}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => handleApprove(peer.id)}
                    className="flex items-center gap-1.5 rounded-lg bg-success px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-success/80"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(peer.id)}
                    className="flex items-center gap-1.5 rounded-lg bg-error px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-error/80"
                  >
                    <ShieldX className="h-3.5 w-3.5" />
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Connected Peers */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-text-secondary">
          Connected Peers ({peers.length})
        </h3>
        <DataTable columns={peerColumns} data={peers} emptyMessage="No connected peers" />
      </div>
    </div>
  );
}

export default MeshPanel;
