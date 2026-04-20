import { useEffect, useState } from 'react';
import { Plus, Square, RotateCcw, Check } from 'lucide-react';
import { PageHeader } from '@/components/shared/PageHeader';
import { getAgents, spawnAgent, stopAgent, getSpecialists, updateSpecialistModel, getModels } from '@/api/client';
import type { AgentInfo, ModelInfo } from '@/api/types';
import type { SpecialistInfo } from '@/api/client';
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
  const [specialists, setSpecialists] = useState<SpecialistInfo[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [draftModels, setDraftModels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

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

  const fetchSpecialists = async () => {
    try {
      const { specialists: list } = await getSpecialists();
      setSpecialists(list);
      // seed drafts from active models so the selector reflects current state
      const drafts: Record<string, string> = {};
      for (const s of list) drafts[s.id] = s.activeModel;
      setDraftModels(drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch specialists');
    }
  };

  const fetchAvailableModels = async () => {
    try {
      const models = await getModels();
      setAvailableModels(models);
    } catch { /* optional — falls back to text input */ }
  };

  useEffect(() => {
    fetchAgents();
    fetchSpecialists();
    fetchAvailableModels();
  }, []);

  const handleSaveSpecialistModel = async (specialistId: string) => {
    const model = draftModels[specialistId]?.trim() || null;
    setSaving(specialistId);
    try {
      await updateSpecialistModel(specialistId, model);
      await fetchSpecialists();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update specialist model');
    } finally {
      setSaving(null);
    }
  };

  const handleResetSpecialistModel = async (specialistId: string) => {
    setSaving(specialistId);
    try {
      await updateSpecialistModel(specialistId, null);
      await fetchSpecialists();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset specialist model');
    } finally {
      setSaving(null);
    }
  };

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

      {/* Specialists — per-agent model selector */}
      <div className="mt-6">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text">Specialists</h3>
            <p className="text-xs text-text-secondary mt-0.5">
              Override the model each specialist uses. Changes take effect immediately on the next spawn. Leave the default to keep the built-in choice.
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Specialist</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Role</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Default</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">Active model</th>
                <th className="w-32 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {specialists.map(s => {
                const draft = draftModels[s.id] ?? s.activeModel;
                const dirty = draft.trim() !== s.activeModel;
                const listId = `specialist-models-${s.id}`;
                return (
                  <tr key={s.id} className="hover:bg-bg-tertiary/40">
                    <td className="px-3 py-2">
                      <div className="font-medium text-text">{s.name}</div>
                      <div className="text-xs text-text-muted">{s.title}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary capitalize">{s.role}</td>
                    <td className="px-3 py-2 text-xs text-text-muted font-mono">{s.defaultModel}</td>
                    <td className="px-3 py-2">
                      <input
                        list={listId}
                        value={draft}
                        onChange={e => setDraftModels({ ...draftModels, [s.id]: e.target.value })}
                        placeholder={s.defaultModel}
                        className={`w-full rounded-md border bg-bg px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent ${
                          s.overridden ? 'border-warn/60' : 'border-border'
                        }`}
                      />
                      <datalist id={listId}>
                        {availableModels.map(m => (
                          <option key={m.id} value={m.id}>{m.name ?? m.id}</option>
                        ))}
                      </datalist>
                      {s.overridden && (
                        <div className="mt-0.5 text-[10px] text-warn">overridden</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1 justify-end">
                        {dirty && (
                          <button
                            onClick={() => handleSaveSpecialistModel(s.id)}
                            disabled={saving === s.id}
                            className="rounded-md p-1.5 text-success transition-colors hover:bg-bg-tertiary disabled:opacity-50"
                            title="Save"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                        )}
                        {s.overridden && (
                          <button
                            onClick={() => handleResetSpecialistModel(s.id)}
                            disabled={saving === s.id}
                            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-tertiary disabled:opacity-50"
                            title="Reset to default"
                          >
                            <RotateCcw className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {specialists.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-xs text-text-muted">
                    No specialists registered
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default AgentsPanel;
