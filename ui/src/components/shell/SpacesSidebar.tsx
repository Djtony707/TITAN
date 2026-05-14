/**
 * SpacesSidebar — v6.0 Step 2
 *
 * The left rail on the canvas surface. Lists the user's Spaces (active
 * highlighted), offers a + button to create a new one, and a right-click /
 * long-press menu to rename / archive. Drag-reorder ships later — for v6.0
 * launch we sort by last-updated so the user's active work stays near the
 * top.
 *
 * Data source: GET /api/spaces (server-side persistence at ~/.titan/spaces.json).
 * Mutations: POST /api/spaces, POST /api/spaces/:id/activate, DELETE /api/spaces/:id.
 *
 * The agent's `canvas_spaces` tools write to the same file, so the sidebar
 * + agent share one source of truth.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';

interface PersistedSpace {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  widgets: unknown[];
  agentInstructions?: string;
  createdAt: string;
  updatedAt: string;
}

interface StarterPreset {
  id: string;
  name: string;
  icon: string;
  color: string;
  tagline: string;
}

// Local copy of the auth-headers helper so the sidebar doesn't need to
// import the full api/client.ts (avoids React-render-cycle issues with
// fetch wrappers in this file).
function authHeaders(): Record<string, string> {
  const token = (typeof localStorage !== 'undefined') ? localStorage.getItem('titan-token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function SpacesSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [spaces, setSpaces] = useState<PersistedSpace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [presets, setPresets] = useState<StarterPreset[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetchJSON<{ spaces: PersistedSpace[]; activeSpaceId: string | null }>('/api/spaces');
      setSpaces(r.spaces);
      setActiveId(r.activeSpaceId);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    fetchJSON<{ presets: StarterPreset[] }>('/api/spaces/presets')
      .then(r => setPresets(r.presets))
      .catch(() => { /* presets optional */ });

    // Listen for agent-driven space mutations so the sidebar stays fresh
    // when TITAN creates a Space via tool calls.
    const handler = () => refresh();
    window.addEventListener('titan:spaces:refresh', handler);
    return () => window.removeEventListener('titan:spaces:refresh', handler);
  }, [refresh]);

  const handleActivate = useCallback(async (id: string) => {
    try {
      await fetchJSON(`/api/spaces/${id}/activate`, { method: 'POST' });
      setActiveId(id);
      navigate(`/space/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [navigate]);

  const handleCreate = useCallback(async (input: { name: string; preset?: string }) => {
    setCreating(true);
    try {
      const preset = input.preset ? presets.find(p => p.id === input.preset) : undefined;
      const r = await fetchJSON<{ space: PersistedSpace }>('/api/spaces', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name || preset?.name || 'New Space',
          icon: preset?.icon,
          color: preset?.color,
          makeActive: true,
        }),
      });
      await refresh();
      navigate(`/space/${r.space.id}`);
      setShowCreate(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [navigate, presets, refresh]);

  const handleArchive = useCallback(async (id: string) => {
    if (!window.confirm('Archive this Space? Widgets will be preserved and you can restore it later.')) return;
    try {
      await fetchJSON(`/api/spaces/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refresh]);

  // Show on Space routes and Mission routes; admin routes don't get the sidebar.
  // v6.1.0-alpha.20 — Mission Chat / Desk live as a top-level "Missions"
  // entry pinned above the user's custom Spaces so the desk + chat
  // surfaces are reachable without leaving the canvas shell.
  if (
    !location.pathname.startsWith('/space') &&
    !location.pathname.startsWith('/mission') &&
    location.pathname !== '/'
  ) return null;

  const onMissionRoute = location.pathname.startsWith('/mission');

  return (
    <aside className="w-56 bg-[#0a0e1a] border-r border-[#1f2937] flex flex-col">
      <div className="px-3 py-2 border-b border-[#1f2937] flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-[#a1a1aa] font-medium">Spaces</span>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="text-[#a1a1aa] hover:text-white text-lg leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-[#1f2937]"
          title="Create a new Space"
          aria-label="Create a new Space"
        >+</button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {/* v6.1.0-alpha.20 — Missions: pinned entry. Two-line item:
            "Missions" → /mission (start a new one or pick a template),
            "Library" → /mission/library (past missions). */}
        <div className="px-1.5 mb-2">
          <button
            type="button"
            onClick={() => navigate('/mission')}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
              onMissionRoute && location.pathname === '/mission'
                ? 'bg-[#1f2937] text-white'
                : 'text-[#d4d4d8] hover:bg-[#1a1f2e] hover:text-white'
            }`}
            title="Start a new mission or open a template"
          >
            <span className="text-base leading-none">🪵</span>
            <span className="flex-1 truncate">Missions</span>
            <span className="text-[10px] text-[#71717a]">desk</span>
          </button>
          <button
            type="button"
            onClick={() => navigate('/mission/library')}
            className={`w-full text-left px-2 py-1 rounded text-[12px] flex items-center gap-2 ml-3 ${
              location.pathname === '/mission/library'
                ? 'bg-[#1f2937] text-white'
                : 'text-[#a1a1aa] hover:bg-[#1a1f2e] hover:text-white'
            }`}
            title="Past missions"
          >
            <span>📚</span>
            <span className="flex-1 truncate">Library</span>
          </button>
        </div>
        <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-[#71717a]">Spaces</div>
        {error && (
          <div className="px-3 py-2 text-[11px] text-[#ef4444] bg-[#1f0a0a]">
            {error}
          </div>
        )}
        {spaces.length === 0 && !error && (
          <div className="px-3 py-4 text-[11px] text-[#71717a]">
            No Spaces yet. Use + to create one, or ask TITAN "make me a workspace for…".
          </div>
        )}
        {spaces.map(space => {
          const isActive = space.id === activeId;
          return (
            <div key={space.id} className="group flex items-center px-1.5">
              <button
                type="button"
                onClick={() => handleActivate(space.id)}
                onContextMenu={(e) => { e.preventDefault(); handleArchive(space.id); }}
                className={`flex-1 text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${
                  isActive
                    ? 'bg-[#1f2937] text-white'
                    : 'text-[#d4d4d8] hover:bg-[#1a1f2e] hover:text-white'
                }`}
                title={`${space.name} · right-click to archive`}
              >
                {space.icon && <span className="text-base leading-none">{space.icon}</span>}
                <span className="flex-1 truncate">{space.name}</span>
                {space.widgets.length > 0 && (
                  <span className="text-[10px] text-[#71717a]">{space.widgets.length}</span>
                )}
              </button>
            </div>
          );
        })}
      </nav>

      <div className="px-3 py-2 border-t border-[#1f2937]">
        <a
          href="/command-post"
          className="text-[11px] text-[#71717a] hover:text-[#d4d4d8] flex items-center gap-1"
        >
          ⚙ Admin
        </a>
      </div>

      {showCreate && (
        <CreateSpaceModal
          presets={presets}
          creating={creating}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}
    </aside>
  );
}

/** Modal — pick a preset (or "blank") + name. */
function CreateSpaceModal(props: {
  presets: StarterPreset[];
  creating: boolean;
  onCreate: (input: { name: string; preset?: string }) => void;
  onClose: () => void;
}) {
  const { presets, creating, onCreate, onClose } = props;
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState<string | undefined>(undefined);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#0a0e1a] border border-[#1f2937] rounded-lg p-5 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-white mb-4">New Space</div>

        <label className="block text-[11px] text-[#a1a1aa] mb-1">Starter preset (optional)</label>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {presets.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => { setPresetId(p.id); if (!name) setName(p.name); }}
              className={`text-left px-3 py-2 rounded border ${
                presetId === p.id
                  ? 'border-[#3b82f6] bg-[#0f172a]'
                  : 'border-[#1f2937] hover:border-[#374151]'
              }`}
              title={p.tagline}
            >
              <div className="text-sm flex items-center gap-2 text-white">
                <span>{p.icon}</span><span>{p.name}</span>
              </div>
              <div className="text-[10px] text-[#71717a] mt-0.5 line-clamp-1">{p.tagline}</div>
            </button>
          ))}
        </div>

        <label className="block text-[11px] text-[#a1a1aa] mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Workspace"
          className="w-full bg-[#0d1117] border border-[#1f2937] rounded px-3 py-2 text-sm text-white mb-4"
          autoFocus
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-[#a1a1aa] hover:text-white"
          >Cancel</button>
          <button
            type="button"
            onClick={() => onCreate({ name: name.trim(), preset: presetId })}
            disabled={creating || (!name.trim() && !presetId)}
            className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-50 text-white text-sm rounded"
          >{creating ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

export default SpacesSidebar;
