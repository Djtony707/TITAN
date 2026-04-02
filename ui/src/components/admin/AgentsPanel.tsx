import { useEffect, useState } from 'react';
import { Plus, Square } from 'lucide-react';
import { PageHeader } from '@/components/shared/PageHeader';
import { getAgents, spawnAgent, stopAgent } from '@/api/client';
import type { AgentInfo } from '@/api/types';
import { DataTable, type Column } from '@/components/shared/DataTable';

const statusDot: Record<string, string> = {
  running: 'bg-success',
  error: 'bg-error',
  stopped: 'bg-text-muted',
};

function AgentsPanel() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newModel, setNewModel] = useState('');
  const [spawning, setSpawning] = useState(false);

  const fetchAgents = async () => {
    try {
      const data = await getAgents();
      setAgents(data.agents);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch agents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  const handleSpawn = async () => {
    if (!newName.trim()) return;
    setSpawning(true);
    try {
      await spawnAgent(newName.trim(), newModel.trim() || undefined);
      setNewName('');
      setNewModel('');
      setShowForm(false);
      await fetchAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to spawn agent');
    } finally {
      setSpawning(false);
    }
  };

  const handleStop = async (id: string) => {
    try {
      await stopAgent(id);
      await fetchAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to stop agent');
    }
  };

  const columns: Column<AgentInfo>[] = [
    { key: 'name', header: 'Name' },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <span className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${statusDot[row.status] ?? 'bg-text-muted'}`} />
          <span className="capitalize">{row.status}</span>
        </span>
      ),
    },
    { key: 'model', header: 'Model', render: (row) => <span>{row.model ?? '-'}</span> },
    { key: 'messageCount', header: 'Messages' },
    {
      key: 'createdAt',
      header: 'Created',
      render: (row) => <span>{new Date(row.createdAt).toLocaleString()}</span>,
    },
    {
      key: '_actions',
      header: '',
      className: 'w-16',
      render: (row) =>
        row.status === 'running' ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleStop(row.id);
            }}
            className="rounded-md p-1.5 text-error transition-colors hover:bg-bg-tertiary"
            title="Stop agent"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : null,
    },
  ];

  if (loading) {
    return (
      <div className="h-64 animate-pulse rounded-xl border border-border bg-bg-secondary" />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agents"
        breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Monitoring'}, {label:'Agents'}]}
        actions={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/80"
          >
            <Plus className="h-4 w-4" />
            Spawn Agent
          </button>
        }
      />

      {showForm && (
        <div className="flex items-end gap-3 rounded-xl border border-border bg-bg-secondary p-4">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-text-secondary">Name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Agent name"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs text-text-secondary">Model (optional)</label>
            <input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="e.g. gpt-4o"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </div>
          <button
            onClick={handleSpawn}
            disabled={spawning || !newName.trim()}
            className="rounded-lg bg-success px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-success/80 disabled:opacity-50"
          >
            {spawning ? 'Spawning...' : 'Create'}
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-error/50 bg-bg-secondary px-4 py-2 text-sm text-error">
          {error}
        </div>
      )}

      <DataTable columns={columns} data={agents} emptyMessage="No agents running" />
    </div>
  );
}

export default AgentsPanel;
