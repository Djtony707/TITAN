import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import {
  Brain,
  ChevronDown,
  Hexagon,
  Home,
  Menu,
  Settings,
  Target,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';

interface ShellLink {
  label: string;
  route: string;
  aliases?: string[];
}

interface ShellSection extends ShellLink {
  icon: LucideIcon;
  submenu?: ShellLink[];
}

export const TITAN_SHELL_SECTIONS: ShellSection[] = [
  { label: 'Home', route: '/', icon: Home, aliases: ['/command-post', '/dashboard'] },
  {
    label: 'Missions & Work',
    route: '/missions',
    icon: Target,
    aliases: ['/mission'],
    submenu: [
      { label: 'Library', route: '/missions/library', aliases: ['/mission/library'] },
      { label: 'Goals', route: '/missions/goals', aliases: ['/goals', '/command-post/goals'] },
      { label: 'Issues', route: '/missions/issues', aliases: ['/issues', '/command-post/issues'] },
      { label: 'Approvals', route: '/missions/approvals', aliases: ['/approvals', '/command-post/approvals'] },
      { label: 'Activity', route: '/missions/activity', aliases: ['/activity', '/watch', '/command-post/activity'] },
      { label: 'Work', route: '/missions/work', aliases: ['/command-post/runs', '/command-post/work'] },
    ],
  },
  {
    label: 'Team',
    route: '/team',
    icon: Users,
    submenu: [
      { label: 'Agents', route: '/team/agents', aliases: ['/command-post/agents'] },
      { label: 'Org Chart', route: '/team/org-chart', aliases: ['/command-post/org'] },
      { label: 'Personas', route: '/team/personas' },
    ],
  },
  {
    label: 'Knowledge',
    route: '/knowledge',
    icon: Brain,
    aliases: ['/soma', '/intelligence'],
    submenu: [
      { label: 'Memory Graph', route: '/knowledge/memory-graph' },
      { label: 'Wiki', route: '/knowledge/wiki' },
      { label: 'Autoresearch', route: '/knowledge/autoresearch' },
      { label: 'Self-Improve', route: '/knowledge/self-improve' },
      { label: 'Dreams', route: '/knowledge/dreams' },
      { label: 'Training', route: '/knowledge/training' },
    ],
  },
  {
    label: 'Tools & Connections',
    route: '/tools',
    icon: Wrench,
    submenu: [
      { label: 'Skills', route: '/tools/skills' },
      { label: 'MCP', route: '/tools/mcp' },
      { label: 'Integrations', route: '/tools/integrations' },
      { label: 'Channels', route: '/tools/channels' },
      { label: 'Mesh', route: '/tools/mesh' },
      { label: 'Browser', route: '/tools/browser' },
      { label: 'Recipes', route: '/tools/recipes' },
      { label: 'Files', route: '/tools/files', aliases: ['/command-post/files'] },
      { label: 'Voice', route: '/tools/voice' },
      { label: 'Phone Desk', route: '/tools/phone-desk' },
    ],
  },
  {
    label: 'System',
    route: '/system',
    icon: Settings,
    aliases: ['/infra', '/settings'],
    submenu: [
      { label: 'Settings', route: '/system/settings', aliases: ['/settings'] },
      { label: 'Security', route: '/system/security' },
      { label: 'Costs', route: '/system/costs', aliases: ['/command-post/costs'] },
      { label: 'Audit', route: '/system/audit' },
      { label: 'Backup/Recovery', route: '/system/backup-recovery' },
      { label: 'Logs', route: '/system/logs' },
      { label: 'Homelab', route: '/system/homelab' },
      { label: 'GPU', route: '/system/gpu' },
      { label: 'VRAM', route: '/system/vram' },
      { label: 'Fleet', route: '/system/fleet' },
      { label: 'Cron', route: '/system/cron' },
      { label: 'Quality Lab', route: '/system/quality-lab' },
    ],
  },
];

function matchesPath(pathname: string, link: ShellLink): boolean {
  return getPathMatchScore(pathname, link) > 0;
}

function getPathMatchScore(pathname: string, link: ShellLink): number {
  const paths = [link.route, ...(link.aliases ?? [])];
  return Math.max(
    0,
    ...paths.map((path) => {
      const exactMatch = path === '/'
        ? pathname === '/' || pathname === '/command-post' || pathname === '/command-post/dashboard'
        : pathname === path;

      if (exactMatch) {
        return 1000 + path.length;
      }

      if (path !== '/' && pathname.startsWith(`${path}/`)) {
        return path.length;
      }

      return 0;
    }),
  );
}

function getSectionMatchScore(pathname: string, section: ShellSection): number {
  const sectionScore = getPathMatchScore(pathname, section);
  const submenuScore = Math.max(
    0,
    ...(section.submenu ?? []).map((item) => getPathMatchScore(pathname, item) + 100),
  );

  return Math.max(sectionScore, submenuScore);
}

const shellStyle = {
  background: 'var(--theme-menu-bg-solid, var(--color-bg-secondary))',
  borderColor: 'var(--theme-menu-border, var(--color-border))',
  color: 'var(--theme-ink, var(--color-text))',
  fontFamily: 'var(--theme-font-display, system-ui, sans-serif)',
} satisfies CSSProperties;

const mutedStyle = {
  color: 'var(--theme-ink-soft, var(--color-text-secondary))',
} satisfies CSSProperties;

const activeStyle = {
  background: 'var(--theme-menu-active-bg, var(--color-accent))',
  color: 'var(--theme-menu-active-fg, var(--color-bg))',
} satisfies CSSProperties;

const activeSubtleStyle = {
  background: 'var(--theme-menu-hover, var(--color-bg-tertiary))',
  color: 'var(--theme-ink, var(--color-text))',
} satisfies CSSProperties;

export const SHELL_SIDEBAR_COLLAPSED_KEY = 'titan:shell-sidebar-collapsed';

export function isImmersiveCanvasPath(pathname: string): boolean {
  return /^\/mission\/[^/]+\/canvas\/?$/.test(pathname);
}

export function readShellSidebarCollapsedPreference(
  pathname: string,
  getItem: (key: string) => string | null = (key) => {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  },
): boolean {
  try {
    const raw = getItem(SHELL_SIDEBAR_COLLAPSED_KEY);
    if (raw !== null) return raw === '1';
  } catch {
    // Storage can be unavailable in hardened browser contexts. Fall
    // through to the safe route default instead of breaking navigation.
  }
  return isImmersiveCanvasPath(pathname);
}

function writeShellSidebarCollapsedPreference(collapsed: boolean): void {
  try {
    localStorage.setItem(SHELL_SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Ignore quota/privacy failures; the in-memory state still updates.
  }
}

interface TitanShellSidebarProps {
  className?: string;
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function TitanShellSidebar({
  className = '',
  onNavigate,
  collapsed = false,
  onToggleCollapsed,
}: TitanShellSidebarProps) {
  const location = useLocation();
  const activeSection = useMemo(
    () => TITAN_SHELL_SECTIONS
      .map((section) => ({ section, score: getSectionMatchScore(location.pathname, section) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)[0]?.section,
    [location.pathname],
  );

  if (collapsed) {
    return (
      <aside
        className={`relative z-40 h-full w-14 shrink-0 flex-col border-r ${className}`}
        style={shellStyle}
        aria-label="Primary navigation — collapsed"
      >
        <div className="flex items-center justify-center border-b px-2 py-3" style={{ borderColor: shellStyle.borderColor }}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex h-8 w-8 items-center justify-center rounded-md text-sm font-bold transition-colors hover:brightness-110"
            style={{
              background: 'var(--theme-metal, var(--color-accent))',
              color: 'var(--theme-bolt, var(--color-bg))',
              boxShadow: '0 1px 2px var(--theme-shadow, rgba(0, 0, 0, 0.3))',
            }}
            title="Expand navigation"
            aria-label="Expand navigation"
          >
            T
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-1.5 py-3" aria-label="Sections">
          <div className="space-y-1">
            {TITAN_SHELL_SECTIONS.map((section) => {
              const sectionActive = activeSection?.route === section.route;
              const Icon = section.icon;
              return (
                <NavLink
                  key={section.route}
                  to={section.route}
                  end={section.route === '/'}
                  onClick={onNavigate}
                  className="flex min-h-10 items-center justify-center rounded-md transition-colors"
                  style={sectionActive ? activeStyle : mutedStyle}
                  title={section.label}
                  aria-label={section.label}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </NavLink>
              );
            })}
          </div>
        </nav>

        <div className="space-y-1 border-t p-1.5" style={{ borderColor: shellStyle.borderColor }}>
          <NavLink
            to="/space/home"
            onClick={onNavigate}
            className="flex min-h-10 items-center justify-center rounded-md transition-colors"
            style={location.pathname.startsWith('/space') ? activeStyle : mutedStyle}
            title="Workspaces"
            aria-label="Workspaces"
          >
            <Hexagon className="h-4 w-4" aria-hidden="true" />
          </NavLink>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex min-h-10 w-full items-center justify-center rounded-md transition-colors"
            style={mutedStyle}
            title="Expand navigation"
            aria-label="Expand navigation"
          >
            ›
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={`relative z-40 h-full w-64 shrink-0 flex-col border-r ${className}`}
      style={shellStyle}
      aria-label="Primary navigation"
    >
      <div className="flex items-center gap-2 px-4 py-4 border-b" style={{ borderColor: shellStyle.borderColor }}>
        <Link
          to="/"
          onClick={onNavigate}
          className="flex min-w-0 flex-1 items-center gap-2"
          aria-label="TITAN home"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm font-bold"
            style={{
              background: 'var(--theme-metal, var(--color-accent))',
              color: 'var(--theme-bolt, var(--color-bg))',
              boxShadow: '0 1px 2px var(--theme-shadow, rgba(0, 0, 0, 0.3))',
            }}
          >
            T
          </span>
          <span className="truncate text-sm font-semibold tracking-[0.16em]">TITAN</span>
        </Link>
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg leading-none transition-colors"
            style={mutedStyle}
            title="Collapse navigation"
            aria-label="Collapse navigation"
          >
            ‹
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Sections">
        <div className="space-y-1">
          {TITAN_SHELL_SECTIONS.map((section) => {
            const sectionActive = activeSection?.route === section.route;
            const Icon = section.icon;
            const showSubmenu = sectionActive && section.submenu && section.submenu.length > 0;

            return (
              <div key={section.route}>
                <NavLink
                  to={section.route}
                  end={section.route === '/'}
                  onClick={onNavigate}
                  className="group flex min-h-10 items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors"
                  style={sectionActive ? activeStyle : mutedStyle}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{section.label}</span>
                  {section.submenu && <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />}
                </NavLink>

                {showSubmenu && (
                  <div className="ml-5 mt-1 space-y-0.5 border-l pl-2" style={{ borderColor: shellStyle.borderColor }}>
                    {section.submenu!.map((item) => {
                      const itemActive = matchesPath(location.pathname, item);
                      return (
                        <NavLink
                          key={item.route}
                          to={item.route}
                          onClick={onNavigate}
                          className="block rounded-md px-2 py-1.5 text-xs transition-colors"
                          style={itemActive ? activeSubtleStyle : mutedStyle}
                        >
                          {item.label}
                        </NavLink>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      <div className="border-t p-2" style={{ borderColor: shellStyle.borderColor }}>
        <NavLink
          to="/space/home"
          onClick={onNavigate}
          className="flex min-h-10 items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors"
          style={location.pathname.startsWith('/space') ? activeStyle : mutedStyle}
        >
          <Hexagon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Workspaces</span>
        </NavLink>
      </div>
    </aside>
  );
}

export function TitanShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const [desktopCollapsed, setDesktopCollapsed] = useState(() =>
    readShellSidebarCollapsedPreference(
      typeof window !== 'undefined' ? window.location.pathname : '/',
    ),
  );

  useEffect(() => {
    setDesktopCollapsed(readShellSidebarCollapsedPreference(location.pathname));
  }, [location.pathname]);

  const toggleDesktopSidebar = () => {
    setDesktopCollapsed((prev) => {
      const next = !prev;
      writeShellSidebarCollapsedPreference(next);
      return next;
    });
  };

  return (
    <div
      className="flex h-screen min-h-0 w-full overflow-hidden"
      style={{
        background: 'var(--theme-bg-base, var(--color-bg))',
        color: 'var(--theme-paper-fg, var(--color-text))',
      }}
    >
      <button
        type="button"
        className="fixed left-3 top-3 z-[60] flex h-9 w-9 items-center justify-center rounded-md border md:hidden"
        style={{
          ...shellStyle,
          borderColor: 'var(--theme-menu-border, var(--color-border))',
          boxShadow: '0 6px 18px var(--theme-shadow, rgba(0, 0, 0, 0.35))',
        }}
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4" aria-hidden="true" />
      </button>

      <TitanShellSidebar
        className="hidden md:flex"
        collapsed={desktopCollapsed}
        onToggleCollapsed={toggleDesktopSidebar}
      />

      {mobileOpen && (
        <div className="fixed inset-0 z-[70] md:hidden">
          <button
            type="button"
            className="absolute inset-0"
            style={{ background: 'var(--theme-menu-overlay, rgba(0, 0, 0, 0.62))' }}
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          />
          <TitanShellSidebar className="absolute inset-y-0 left-0 flex" onNavigate={() => setMobileOpen(false)} />
          <button
            type="button"
            className="absolute left-[17rem] top-3 flex h-9 w-9 items-center justify-center rounded-md border"
            style={{
              ...shellStyle,
              borderColor: 'var(--theme-menu-border, var(--color-border))',
            }}
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto pb-16 pt-16 md:pb-0 md:pt-0">
        {children}
      </main>
    </div>
  );
}

export default TitanShell;
