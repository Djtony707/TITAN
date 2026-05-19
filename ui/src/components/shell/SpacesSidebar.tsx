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
import { useAuth } from '@/hooks/useAuth';
import {
  SPACES_SIDEBAR_COLLAPSED_KEY,
  SPACES_SIDEBAR_CANVAS_PIN_KEY,
  readSpacesSidebarCollapsedPreference,
  writeSpacesSidebarCollapsedPreference,
} from './spacesSidebarPreference';

// v6.3.2 — re-export so existing call sites keep working through the
// component file. Pure logic now lives in spacesSidebarPreference.ts
// so unit tests can exercise it without rendering React.
// v6.3.4 — added the canvas-pin key + write helper.
export {
  SPACES_SIDEBAR_COLLAPSED_KEY,
  SPACES_SIDEBAR_CANVAS_PIN_KEY,
  readSpacesSidebarCollapsedPreference,
  writeSpacesSidebarCollapsedPreference,
};

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
  const { logout } = useAuth();
  const [spaces, setSpaces] = useState<PersistedSpace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [presets, setPresets] = useState<StarterPreset[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // v6.1.0-alpha.28 — collapsible sidebar. Tony reported the sidebar
  // covering an admin button he wanted to reach. State persists across
  // reloads.
  //
  // v6.3.2 — default to COLLAPSED on first visit to a Space page. The
  // global TitanShell sidebar already auto-collapses on /space/* (see
  // isImmersiveCanvasPath); doing the same here means a fresh Space
  // page opens with both rails as 14px strips and the canvas getting
  // ~95% of width. User can pin either rail open and that sticks.
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readSpacesSidebarCollapsedPreference(
      typeof window !== 'undefined' ? window.location.pathname : '/',
    ),
  );
  // v6.3.4 — re-derive on every route change so navigating from a
  // non-canvas page (where the rail might be pinned open) to a canvas
  // route correctly collapses the rail per the canvas default. Mirrors
  // TitanShell's pattern.
  useEffect(() => {
    setCollapsed(readSpacesSidebarCollapsedPreference(location.pathname));
  }, [location.pathname]);
  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      // v6.3.4 — route the write through the canvas-aware helper so a
      // toggle on a /space/* page writes the canvas-pin key (scoped)
      // and a toggle elsewhere writes the global key. Prevents pin-open
      // state from leaking between canvas and non-canvas pages.
      writeSpacesSidebarCollapsedPreference(
        next,
        typeof window !== 'undefined' ? window.location.pathname : '/',
      );
      return next;
    });
  }, []);

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

  // v6.1.0-alpha.28 — when collapsed, render a thin pull-tab instead
  // of the full sidebar. The tab takes ~10px of horizontal space
  // (vs. 224px expanded) and floats a small chevron handle so the
  // user can drag the sidebar back into view. The flex parent
  // (TitanCanvas's two-column layout) gives the canvas the full
  // remaining width when this tab is showing.
  if (collapsed) {
    return (
      <aside
        className="w-3 bg-[#0a0e1a] border-r border-[#1f2937] relative flex-shrink-0"
        title="Spaces sidebar — collapsed"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          className="absolute top-3 left-full -translate-x-1/2 z-50 w-6 h-12 rounded-r-md bg-[#1f2937] border border-[#27272a] border-l-0 text-[#a1a1aa] hover:text-white hover:bg-[#27272a] flex items-center justify-center text-sm shadow-lg"
          title="Show the spaces sidebar"
          aria-label="Show sidebar"
        >
          ›
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="w-60 flex flex-col relative flex-shrink-0"
      style={{
        background: 'var(--theme-menu-bg-solid, #0a0e1a)',
        borderRight: '1px solid var(--theme-menu-border, #1f2937)',
        color: 'var(--theme-ink, #d4d4d8)',
        fontFamily: 'var(--theme-font-display, ui-sans-serif, system-ui)',
      }}
    >
      {/* Brand mark — replaces the misleading "Spaces" label that
          previously sat above MISSIONS content. The wordmark anchors
          the rail and gives the eye a stable point to return to.
          Brass T tile + serif TITAN wordmark per the v6 desk aesthetic. */}
      <div
        className="px-4 pt-4 pb-3 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--theme-menu-border, #1f2937)' }}
      >
        <button
          type="button"
          onClick={() => navigate('/space/home')}
          className="flex items-center gap-2 group"
          title="TITAN home"
        >
          <span
            className="w-7 h-7 rounded-md flex items-center justify-center text-[14px] font-bold leading-none"
            style={{
              background: 'var(--theme-metal, #c4a35a)',
              color: 'var(--theme-bolt, #2a1808)',
              boxShadow: '0 1px 2px var(--theme-shadow, rgba(0,0,0,0.3))',
              fontFamily: 'var(--theme-font-display, serif)',
            }}
          >T</span>
          <span
            className="text-[15px] tracking-[0.18em] font-semibold leading-none"
            style={{ color: 'var(--theme-ink, #e8e8ff)' }}
          >TITAN</span>
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="w-6 h-6 rounded-md flex items-center justify-center text-base transition-colors"
          style={{ color: 'var(--theme-ink-soft, #a1a1aa)' }}
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >‹</button>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {/* MISSIONS section — sibling, equal-weight items under a
            clear section header. Library is no longer indented-orphan
            below Missions; the section header groups them visually
            without the misleading parent/child indentation. */}
        <div className="mb-5">
          <SectionHeader>Missions</SectionHeader>
          <SidebarLink
            onClick={() => navigate('/mission')}
            active={onMissionRoute && location.pathname === '/mission'}
            icon="✶"
            label="New Mission"
            title="Start a new mission or pick a template"
          />
          <SidebarLink
            onClick={() => navigate('/mission/library')}
            active={location.pathname === '/mission/library'}
            icon="❑"
            label="Library"
            title="Every mission you've run"
          />
        </div>

        {/* WORKSPACES section — clearly labeled. "+" sits in the section
            header so creating a Workspace is one click and obviously
            scoped to this section. */}
        <div className="mb-2 flex items-center justify-between px-2">
          <SectionHeader inline>Workspaces</SectionHeader>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="w-5 h-5 rounded flex items-center justify-center text-sm leading-none transition-colors"
            style={{ color: 'var(--theme-ink-soft, #a1a1aa)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--theme-menu-hover, rgba(244,215,145,0.10))';
              e.currentTarget.style.color = 'var(--theme-ink, #fff)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--theme-ink-soft, #a1a1aa)';
            }}
            title="Create a new Workspace"
            aria-label="Create a new Workspace"
          >+</button>
        </div>
        {error && (
          <div
            className="mx-1 my-1 px-2 py-2 text-[11px] rounded"
            style={{
              color: 'var(--theme-accent, #ef4444)',
              background: 'rgba(239,68,68,0.08)',
            }}
          >
            {error}
          </div>
        )}

        {spaces.length === 0 && !error && (
          <div
            className="px-2 py-3 text-[11px] leading-relaxed italic"
            style={{ color: 'var(--theme-ink-soft, #71717a)' }}
          >
            No Workspaces yet. Tap + above, or ask TITAN
            <br />"make me a workspace for…"
          </div>
        )}

        {spaces.map(space => {
          const isActive = space.id === activeId;
          // Themed Workspace row. Same right-click-to-archive behavior
          // as v5.x preserved — context menu still archives.
          return (
            <button
              key={space.id}
              type="button"
              onClick={() => handleActivate(space.id)}
              onContextMenu={(e) => { e.preventDefault(); handleArchive(space.id); }}
              className="w-full text-left px-2 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors"
              style={{
                background: isActive
                  ? 'var(--theme-menu-active-bg, #1f2937)'
                  : 'transparent',
                color: isActive
                  ? 'var(--theme-menu-active-fg, #fff)'
                  : 'var(--theme-ink, #d4d4d8)',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'var(--theme-menu-hover, rgba(244,215,145,0.10))';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
              title={`${space.name} · right-click to archive`}
            >
              {space.icon && <span className="text-base leading-none">{space.icon}</span>}
              <span className="flex-1 truncate">{space.name}</span>
              {space.widgets.length > 0 && (
                <span
                  className="text-[10px] tabular-nums px-1.5 rounded-full"
                  style={{
                    color: 'var(--theme-ink-soft, #71717a)',
                    background: 'var(--theme-menu-hover, rgba(244,215,145,0.10))',
                  }}
                >
                  {space.widgets.length}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom rail — equal-weight Admin + Log out, themed to the
          active surface. Previously these were tiny grey links wedged
          into a flex row; now they're full-width hover targets with
          icons so they read as primary affordances. */}
      <div
        className="px-2 py-2 flex flex-col gap-0.5"
        style={{ borderTop: '1px solid var(--theme-menu-border, #1f2937)' }}
      >
        <a
          href="/command-post"
          className="px-2 py-1.5 rounded text-[12px] flex items-center gap-2 transition-colors no-underline"
          style={{ color: 'var(--theme-ink-soft, #a1a1aa)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--theme-menu-hover, rgba(244,215,145,0.10))';
            e.currentTarget.style.color = 'var(--theme-ink, #fff)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--theme-ink-soft, #a1a1aa)';
          }}
        >
          <span aria-hidden>⚙</span>
          <span>Admin</span>
        </a>
        {/*
          v6.1.0-alpha.27 — Logout button. Previously you had to nuke
          localStorage in devtools to mint a fresh session token after
          a gateway restart wiped the old one. This button calls
          useAuth().logout() (removes titan-token, sets
          isAuthenticated=false) and reloads so the login screen
          re-mounts cleanly.
        */}
        <button
          type="button"
          onClick={() => {
            logout();
            // Hard reload so the AuthProvider mounts fresh and routes
            // re-evaluate. Avoids any stale module-scoped state.
            window.location.assign('/');
          }}
          className="w-full text-left px-2 py-1.5 rounded text-[12px] flex items-center gap-2 transition-colors"
          style={{ color: 'var(--theme-ink-soft, #a1a1aa)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--theme-menu-hover, rgba(244,215,145,0.10))';
            e.currentTarget.style.color = 'var(--theme-accent, #ef4444)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--theme-ink-soft, #a1a1aa)';
          }}
          title="Sign out — mints a fresh token next login"
        >
          <span aria-hidden>⇥</span>
          <span>Sign out</span>
        </button>
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

/* ────────────────────────  Sidebar helper components  ────────────────────────
 *
 * SectionHeader + SidebarLink are small, theme-aware presentational
 * helpers extracted to keep the main SpacesSidebar body legible.
 * Both use the --theme-* CSS variables so they re-skin automatically
 * when the user toggles Office / Workshop / Observatory. */

function SectionHeader({
  children, inline = false,
}: { children: React.ReactNode; inline?: boolean }) {
  return (
    <div
      className={`${inline ? '' : 'px-2 mb-1.5'} text-[10px] uppercase tracking-[0.18em] font-semibold`}
      style={{ color: 'var(--theme-metal, #c4a35a)' }}
    >
      {children}
    </div>
  );
}

function SidebarLink({
  active, icon, label, title, onClick,
}: {
  active: boolean;
  icon: string;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-2 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors"
      style={{
        background: active
          ? 'var(--theme-menu-active-bg, #1f2937)'
          : 'transparent',
        color: active
          ? 'var(--theme-menu-active-fg, #fff)'
          : 'var(--theme-ink, #d4d4d8)',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--theme-menu-hover, rgba(244,215,145,0.10))';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
      title={title}
    >
      <span
        className="w-5 text-center leading-none"
        style={{
          color: active
            ? 'var(--theme-menu-active-fg, #fff)'
            : 'var(--theme-metal, #c4a35a)',
        }}
        aria-hidden
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}
