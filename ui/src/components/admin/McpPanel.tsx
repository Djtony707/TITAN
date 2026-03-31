import { useState, useEffect } from 'react';
import { Plug, Plus, Trash2, Power, TestTube, RefreshCw, Server, Globe } from 'lucide-react';
import { getMcpClients, addMcpClient, removeMcpClient, toggleMcpClient, testMcpClient, getMcpPresets } from '@/api/client';
import type { McpServerInfo, McpPreset } from '@/api/types';

function McpPanel() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; tools: number; error?: string } | null>(null);

  // Add form state
  const [newServer, setNewServer] = useState({
    id: '', name: '', description: '', type: 'stdio' as 'stdio' | 'http',
    command: '', args: '', url: '',
  });

  const refresh = async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([getMcpClients(), getMcpPresets()]);
      setServers(s);
      setPresets(p);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const handleAdd = async () => {
    try {
      await addMcpClient({
        id: newServer.id,
        name: newServer.name,
        description: newServer.description,
        type: newServer.type,
        ...(newServer.type === 'stdio'
          ? { command: newServer.command, args: newServer.args.split(/\s+/).filter(Boolean) }
          : { url: newServer.url }),
      });
      setShowAdd(false);
      setNewServer({ id: '', name: '', description: '', type: 'stdio', command: '', args: '', url: '' });
      refresh();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleAddPreset = async (presetId: string) => {
    try {
      await addMcpClient({ presetId });
      refresh();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm(`Remove MCP server "${id}"?`)) return;
    await removeMcpClient(id);
    refresh();
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await toggleMcpClient(id, enabled);
    refresh();
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    setTestResult(null);
    try {
      const result = await testMcpClient(id);
      setTestResult({ id, ...result });
    } catch (err) {
      setTestResult({ id, ok: false, tools: 0, error: (err as Error).message });
    }
    setTesting(null);
  };

  const statusColor = (status: string) => {
    if (status === 'connected') return 'text-[var(--success)]';
    if (status === 'error') return 'text-[var(--error)]';
    return 'text-[var(--text-muted)]';
  };

  const statusDot = (status: string) => {
    if (status === 'connected') return 'bg-[var(--success)]';
    if (status === 'error') return 'bg-[var(--error)]';
    return 'bg-[var(--text-muted)]';
  };

  // Filter presets not already added
  const availablePresets = presets.filter(p => !servers.some(s => s.id === p.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Plug className="w-6 h-6 text-[var(--accent)]" />
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">MCP Connections</h1>
            <p className="text-sm text-[var(--text-muted)]">Connect to external tools via Model Context Protocol</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setShowAdd(!showAdd)} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors">
            <Plus size={14} /> Add Server
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Configured Servers</p>
          <p className="text-2xl font-bold text-[var(--text)]">{servers.length}</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">Connected</p>
          <p className="text-2xl font-bold text-[var(--success)]">{servers.filter(s => s.status === 'connected').length}</p>
        </div>
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
          <p className="text-sm text-[var(--text-muted)]">External Tools</p>
          <p className="text-2xl font-bold text-[var(--accent)]">{servers.reduce((sum, s) => sum + s.toolCount, 0)}</p>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-semibold text-[var(--text)]">Add MCP Server</h2>

          {/* Quick presets */}
          {availablePresets.length > 0 && (
            <div>
              <p className="text-xs text-[var(--text-muted)] mb-2">Quick Add Presets</p>
              <div className="flex flex-wrap gap-2">
                {availablePresets.map(p => (
                  <button key={p.id} onClick={() => handleAddPreset(p.id)}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
                    <Server size={12} /> {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--text-muted)]">ID</label>
              <input id="mcp-server-id" name="mcp-server-id" value={newServer.id} onChange={e => setNewServer({ ...newServer, id: e.target.value })}
                className="w-full mt-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)]"
                placeholder="my-server" />
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)]">Name</label>
              <input id="mcp-server-name" name="mcp-server-name" value={newServer.name} onChange={e => setNewServer({ ...newServer, name: e.target.value })}
                className="w-full mt-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)]"
                placeholder="My MCP Server" />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-[var(--text-muted)]">Description</label>
              <input id="mcp-server-description" name="mcp-server-description" value={newServer.description} onChange={e => setNewServer({ ...newServer, description: e.target.value })}
                className="w-full mt-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)]"
                placeholder="What does this server do?" />
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)]">Type</label>
              <select id="mcp-server-type" name="mcp-server-type" value={newServer.type} onChange={e => setNewServer({ ...newServer, type: e.target.value as 'stdio' | 'http' })}
                className="w-full mt-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)]">
                <option value="stdio">stdio (local process)</option>
                <option value="http">HTTP (remote server)</option>
              </select>
            </div>
            {newServer.type === 'stdio' ? (
              <>
                <div>
                  <label className="text-xs text-[var(--text-muted)]">Command</label>
                  <input id="mcp-server-command" name="mcp-server-command" value={newServer.command} onChange={e => setNewServer({ ...newServer, command: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)]"
                    placeholder="npx @modelcontextprotocol/server-xxx" />
                </div>
                <div className="md:col-span-2">
                  <label className="text-xs text-[var(--text-muted)]">Arguments (space-separated)</label>
                  <input id="mcp-server-args" name="mcp-server-args" value={newServer.args} onChange={e => setNewServer({ ...newServer, args: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)]"
                    placeholder="--port 3000" />
                </div>
              </>
            ) : (
              <div className="md:col-span-2">
                <label className="text-xs text-[var(--text-muted)]">Server URL</label>
                <input id="mcp-server-url" name="mcp-server-url" value={newServer.url} onChange={e => setNewServer({ ...newServer, url: e.target.value })}
                  className="w-full mt-1 px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-md text-[var(--text)]"
                  placeholder="http://localhost:3000/mcp" />
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} disabled={!newServer.id || !newServer.name}
              className="px-4 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors">
              Add Server
            </button>
            <button onClick={() => setShowAdd(false)}
              className="px-4 py-1.5 text-sm rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="text-[var(--text-muted)] text-sm">Loading MCP servers...</div>
      ) : servers.length === 0 ? (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-8 text-center">
          <Plug className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3" />
          <p className="text-[var(--text-secondary)] mb-1">No MCP servers configured</p>
          <p className="text-xs text-[var(--text-muted)]">Add an MCP server to connect TITAN to external tools like databases, APIs, and services.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map(server => (
            <div key={server.id} className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {server.type === 'stdio' ? <Server size={18} className="text-[var(--text-muted)]" /> : <Globe size={18} className="text-[var(--text-muted)]" />}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--text)]">{server.name}</span>
                      <span className="flex items-center gap-1.5 text-xs">
                        <span className={`w-2 h-2 rounded-full ${statusDot(server.status)}`} />
                        <span className={statusColor(server.status)}>{server.status}</span>
                      </span>
                      {server.toolCount > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">
                          {server.toolCount} tools
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{server.description}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-1 font-mono">
                      {server.type === 'stdio' ? `${server.command} ${(server.args || []).join(' ')}` : server.url}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => handleTest(server.id)} disabled={testing === server.id}
                    title="Test connection"
                    className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40">
                    <TestTube size={14} className={testing === server.id ? 'animate-pulse' : ''} />
                  </button>
                  <button onClick={() => handleToggle(server.id, !server.enabled)}
                    title={server.enabled ? 'Disable' : 'Enable'}
                    className={`p-1.5 rounded-md transition-colors hover:bg-[var(--bg-tertiary)] ${server.enabled ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
                    <Power size={14} />
                  </button>
                  <button onClick={() => handleRemove(server.id)}
                    title="Remove"
                    className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-tertiary)] transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {testResult?.id === server.id && (
                <div className={`mt-3 px-3 py-2 rounded-md text-xs ${testResult.ok ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                  {testResult.ok ? `Connected successfully — ${testResult.tools} tools discovered` : `Connection failed: ${testResult.error}`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Info */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-2">About MCP</h2>
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          Model Context Protocol (MCP) is the universal standard for connecting AI agents to external tools.
          TITAN acts as both an MCP <strong className="text-[var(--text-secondary)]">server</strong> (exposing its tools to other agents)
          and an MCP <strong className="text-[var(--text-secondary)]">client</strong> (connecting to external MCP servers).
          Add any MCP-compatible server and its tools automatically become available in TITAN.
        </p>
      </div>
    </div>
  );
}

export default McpPanel;
