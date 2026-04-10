import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import {
  MessageSquare, Activity, Users, ScrollText, Settings, Radio, Wrench,
  BarChart3, Network, Brain, Zap, Shield, GitBranch, Plug, FlaskConical,
  UserCircle, Bot, Eye, ClipboardList, Cable, Cpu, FolderOpen, LogOut,
  Mic, BookOpen, Server, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { apiFetch } from '@/api/client';

interface NavItem { label: string; icon: LucideIcon; path: string; }
interface NavSection { title: string; items: NavItem[]; }

const sections: NavSection[] = [
  {
    title: 'MAIN',
    items: [
      { label: 'Overview', icon: BarChart3, path: '/' },
      { label: 'Chat', icon: MessageSquare, path: '/chat' },
      { label: 'Command Post', icon: Shield, path: '/command-post' },
    ],
  },
  {
    title: 'MONITORING',
    items: [
      { label: 'Activity', icon: Activity, path: '/activity' },
      { label: 'Sessions', icon: ScrollText, path: '/sessions' },
      { label: 'Agents', icon: Users, path: '/agents' },
      { label: 'Telemetry', icon: BarChart3, path: '/telemetry' },
      { label: 'Logs', icon: ScrollText, path: '/logs' },
    ],
  },
  {
    title: 'AGENT',
    items: [
      { label: 'Autopilot', icon: Zap, path: '/autopilot' },
      { label: 'Daemon', icon: Eye, path: '/daemon' },
      { label: 'Workflows', icon: GitBranch, path: '/workflows' },
      { label: 'Personas', icon: UserCircle, path: '/personas' },
      { label: 'Self-Improve', icon: Brain, path: '/self-improve' },
      { label: 'Autoresearch', icon: FlaskConical, path: '/autoresearch' },
      { label: 'Files', icon: FolderOpen, path: '/files' },
    ],
  },
  {
    title: 'TOOLS',
    items: [
      { label: 'Skills', icon: Wrench, path: '/skills' },
      { label: 'MCP', icon: Plug, path: '/mcp' },
      { label: 'Integrations', icon: Cable, path: '/integrations' },
      { label: 'NVIDIA', icon: Cpu, path: '/nvidia' },
      { label: 'Channels', icon: Radio, path: '/channels' },
      { label: 'Mesh', icon: Network, path: '/mesh' },
    ],
  },
  {
    title: 'MEMORY',
    items: [
      { label: 'Learning', icon: Brain, path: '/learning' },
      { label: 'Knowledge Graph', icon: Network, path: '/memory-graph' },
      { label: 'Memory Wiki', icon: BookOpen, path: '/memory-wiki' },
      { label: 'Audit Log', icon: ClipboardList, path: '/audit' },
    ],
  },
  {
    title: 'INFRASTRUCTURE',
    items: [
      { label: 'Homelab', icon: Server, path: '/homelab' },
    ],
  },
  {
    title: 'CONFIGURE',
    items: [
      { label: 'Settings', icon: Settings, path: '/settings' },
      { label: 'Security', icon: Shield, path: '/security' },
    ],
  },
];

// Export for QuickSwitcher
export const navGroups = sections.map(s => ({
  label: s.title,
  icon: Activity,
  items: s.items.map(i => ({ label: i.label, icon: i.icon, path: i.path })),
}));

export function Sidebar() {
  const location = useLocation();
  const { logout } = useAuth();
  const hasToken = Boolean(localStorage.getItem('titan-token'));
  const [version, setVersion] = useState('');

  useEffect(() => {
    apiFetch('/api/health').then(r => r.json()).then(d => setVersion(d.version || '')).catch(() => {});
  }, []);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <div className="flex flex-col h-full w-full bg-bg-secondary border-r border-border">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 h-14 flex-shrink-0 border-b border-border">
        <Link to="/" className="flex items-center gap-2">
          <img src="/titan-logo.png" alt="TITAN" className="w-7 h-7 rounded-lg" />
          <div>
            <div className="font-bold text-sm text-text leading-none">TITAN</div>
            <div className="text-[9px] text-accent font-semibold tracking-wider">MISSION CONTROL</div>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {sections.map((section) => (
          <div key={section.title}>
            <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map(({ label, icon: Icon, path }) => {
                const active = isActive(path);
                return (
                  <Link
                    key={path}
                    to={path}
                    className={`flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] transition-all ${
                      active
                        ? 'bg-accent/15 text-accent font-medium'
                        : 'text-text-secondary hover:text-text hover:bg-bg-tertiary'
                    }`}
                  >
                    <Icon size={15} className={active ? 'text-accent' : 'opacity-60'} />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="flex-shrink-0 px-3 py-2 border-t border-border space-y-1">
        {hasToken && (
          <button
            onClick={logout}
            className="flex items-center gap-2 px-2 py-1.5 w-full rounded-md text-[12px] text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
          >
            <LogOut size={13} />
            <span>Sign Out</span>
          </button>
        )}
        {version && (
          <div className="flex items-center justify-between px-2">
            <span className="text-[10px] text-text-muted">v{version}</span>
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] text-text-muted">Online</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
