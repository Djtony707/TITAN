import { useState, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router';
import {
  MessageSquare,
  Activity,
  Users,
  ScrollText,
  Settings,
  Radio,
  Wrench,
  BarChart3,
  Network,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Brain,
  Zap,
  Shield,
  GitBranch,
  Plug,
  FlaskConical,
  UserCircle,
  ArrowUpCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  RotateCw,
  Bot,
  Eye,
  ClipboardList,
  Cable,
  Cpu,
  FolderOpen,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { apiFetch } from '@/api/client';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface NavItem {
  label: string;
  icon: LucideIcon;
  path: string;
}

interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: 'Dashboard',
    icon: Activity,
    items: [
      { label: 'Overview', icon: BarChart3, path: '/overview' },
      { label: 'Activity', icon: Radio, path: '/activity' },
      { label: 'Sessions', icon: ScrollText, path: '/sessions' },
      { label: 'Agents', icon: Users, path: '/agents' },
      { label: 'Telemetry', icon: BarChart3, path: '/telemetry' },
      { label: 'Logs', icon: ScrollText, path: '/logs' },
    ],
  },
  {
    label: 'Agent',
    icon: Bot,
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
    label: 'Tools',
    icon: Cable,
    items: [
      { label: 'Skills', icon: Wrench, path: '/skills' },
      { label: 'MCP', icon: Plug, path: '/mcp' },
      { label: 'Integrations', icon: Plug, path: '/integrations' },
      { label: 'NVIDIA', icon: Cpu, path: '/nvidia' },
      { label: 'Channels', icon: Radio, path: '/channels' },
      { label: 'Mesh', icon: Network, path: '/mesh' },
    ],
  },
  {
    label: 'Memory',
    icon: Brain,
    items: [
      { label: 'Learning', icon: Brain, path: '/learning' },
      { label: 'Graph', icon: Network, path: '/memory-graph' },
      { label: 'Audit Log', icon: ClipboardList, path: '/audit' },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    items: [
      { label: 'Settings', icon: Settings, path: '/settings' },
      { label: 'Security', icon: Shield, path: '/security' },
    ],
  },
];

interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

type UpdateStatus = 'idle' | 'updating' | 'restarting' | 'success' | 'error';

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const location = useLocation();
  const { logout } = useAuth();
  const hasToken = Boolean(localStorage.getItem('titan-token'));
  const [versionInfo, setVersionInfo] = useState<VersionInfo>({
    current: '',
    latest: null,
    updateAvailable: false,
  });
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateError, setUpdateError] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    // Auto-expand the group containing the current path
    const initial = new Set<string>();
    for (const group of navGroups) {
      if (group.items.some(item => {
        if (item.path === '/') return location.pathname === '/';
        return location.pathname.startsWith(item.path);
      })) {
        initial.add(group.label);
      }
    }
    return initial;
  });

  const toggleGroup = (label: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // Auto-expand when navigating to a new group
  useEffect(() => {
    for (const group of navGroups) {
      if (group.items.some(item => {
        if (item.path === '/') return location.pathname === '/';
        return location.pathname.startsWith(item.path);
      })) {
        setExpandedGroups(prev => {
          if (prev.has(group.label)) return prev;
          return new Set(prev).add(group.label);
        });
      }
    }
  }, [location.pathname]);

  const triggerUpdate = useCallback(async () => {
    if (updateStatus === 'updating' || updateStatus === 'restarting') return;
    setUpdateStatus('updating');
    setUpdateError('');
    try {
      const res = await apiFetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restart: true }),
      });
      const data = await res.json();
      if (!data.ok) {
        setUpdateStatus('error');
        setUpdateError(data.error || 'Update failed');
        return;
      }
      if (data.restarting) {
        setUpdateStatus('restarting');
        const poll = setInterval(async () => {
          try {
            const h = await apiFetch('/api/health');
            if (h.ok) {
              clearInterval(poll);
              setUpdateStatus('success');
              setTimeout(() => window.location.reload(), 1000);
            }
          } catch { /* server still restarting */ }
        }, 2000);
        setTimeout(() => clearInterval(poll), 60_000);
      } else {
        setUpdateStatus('success');
        setTimeout(() => window.location.reload(), 2000);
      }
    } catch {
      setUpdateStatus('error');
      setUpdateError('Network error');
    }
  }, [updateStatus]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/health');
        const health = await res.json();
        const current = health.version || '';
        setVersionInfo((prev) => ({ ...prev, current }));
        try {
          const npmRes = await fetch('https://registry.npmjs.org/titan-agent/latest');
          const pkg = await npmRes.json();
          const latest = pkg.version || null;
          if (latest && current && latest !== current) {
            setVersionInfo({ current, latest, updateAvailable: true });
          } else {
            setVersionInfo({ current, latest, updateAvailable: false });
          }
        } catch { /* npm check is non-critical */ }
      } catch { /* health check failed */ }
    })();
  }, []);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-secondary)] border-r border-[var(--border)]">
      {/* Logo header */}
      <Link to="/" className="flex items-center gap-3 px-4 h-14 flex-shrink-0 hover:opacity-90 transition-opacity">
        <div className="relative w-9 h-9 flex-shrink-0">
          <img src="/titan-logo.png" alt="TITAN" className="w-9 h-9 rounded-lg" />
          <div className="absolute inset-0 rounded-lg ring-1 ring-white/10" />
        </div>
        {!collapsed && (
          <div className="flex flex-col">
            <span className="text-[var(--text)] font-bold text-base tracking-wider leading-tight">TITAN</span>
            <span className="text-[var(--text-muted)] text-[10px] leading-tight">Mission Control</span>
          </div>
        )}
      </Link>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {/* Chat — always top-level */}
        <Link
          to="/"
          title={collapsed ? 'Chat' : undefined}
          className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
            isActive('/')
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)]'
          } ${collapsed ? 'justify-center' : ''}`}
        >
          <MessageSquare size={18} className="flex-shrink-0" />
          {!collapsed && <span>Chat</span>}
        </Link>

        {/* Grouped navigation */}
        {navGroups.map((group) => {
          const isExpanded = expandedGroups.has(group.label);
          const hasActiveChild = group.items.some(item => isActive(item.path));
          const GroupIcon = group.icon;

          return (
            <div key={group.label} className="mt-1">
              {/* Group header */}
              <button
                onClick={() => collapsed ? undefined : toggleGroup(group.label)}
                title={collapsed ? group.label : undefined}
                className={`flex items-center w-full px-3 py-2 rounded-md text-xs font-semibold uppercase tracking-wider transition-colors ${
                  hasActiveChild && collapsed
                    ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                } ${collapsed ? 'justify-center' : 'gap-2'}`}
              >
                {collapsed ? (
                  <GroupIcon size={18} className={hasActiveChild ? 'text-[var(--accent)]' : ''} />
                ) : (
                  <>
                    <GroupIcon size={14} className="flex-shrink-0" />
                    <span className="flex-1 text-left">{group.label}</span>
                    <ChevronDown
                      size={14}
                      className={`flex-shrink-0 transition-transform duration-200 ${isExpanded ? '' : '-rotate-90'}`}
                    />
                  </>
                )}
              </button>

              {/* Group items */}
              {!collapsed && isExpanded && (
                <div className="ml-2 mt-0.5 space-y-0.5 border-l border-[var(--border)] pl-2">
                  {group.items.map(({ label, icon: Icon, path }) => {
                    const active = isActive(path);
                    return (
                      <Link
                        key={path}
                        to={path}
                        className={`flex items-center gap-3 px-3 py-1.5 rounded-md text-sm transition-colors ${
                          active
                            ? 'bg-[var(--accent)] text-white'
                            : 'text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)]'
                        }`}
                      >
                        <Icon size={16} className="flex-shrink-0" />
                        <span>{label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}

              {/* Collapsed mode — show items as tooltipped icons on click */}
              {collapsed && (
                <div className="space-y-0.5">
                  {group.items.map(({ label, icon: Icon, path }) => {
                    const active = isActive(path);
                    return (
                      <Link
                        key={path}
                        to={path}
                        title={label}
                        className={`flex items-center justify-center px-3 py-1.5 rounded-md transition-colors ${
                          active
                            ? 'bg-[var(--accent)] text-white'
                            : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)]'
                        }`}
                      >
                        <Icon size={16} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Update banner */}
      {versionInfo.updateAvailable && !collapsed && (
        <button
          onClick={triggerUpdate}
          disabled={updateStatus === 'updating' || updateStatus === 'restarting'}
          className="mx-2 mb-2 px-3 py-2.5 rounded-lg bg-gradient-to-r from-[#6366f1]/15 to-[#818cf8]/10 border border-[#6366f1]/25 hover:from-[#6366f1]/25 hover:to-[#818cf8]/20 transition-all cursor-pointer text-left w-[calc(100%-1rem)] disabled:opacity-70 disabled:cursor-wait"
        >
          <div className="flex items-center gap-2 mb-1">
            {updateStatus === 'idle' && <ArrowUpCircle size={14} className="text-[#818cf8] flex-shrink-0" />}
            {updateStatus === 'updating' && <Loader2 size={14} className="text-[#818cf8] flex-shrink-0 animate-spin" />}
            {updateStatus === 'restarting' && <RotateCw size={14} className="text-[#818cf8] flex-shrink-0 animate-spin" />}
            {updateStatus === 'success' && <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" />}
            {updateStatus === 'error' && <XCircle size={14} className="text-red-400 flex-shrink-0" />}
            <span className="text-xs font-semibold text-[#818cf8]">
              {updateStatus === 'idle' && 'Update Available'}
              {updateStatus === 'updating' && 'Updating...'}
              {updateStatus === 'restarting' && 'Restarting...'}
              {updateStatus === 'success' && 'Updated!'}
              {updateStatus === 'error' && 'Update Failed'}
            </span>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
            {updateStatus === 'idle' && <>v{versionInfo.latest} is out. <span className="text-[#a5b4fc]">Click to update &amp; restart</span></>}
            {updateStatus === 'updating' && 'Installing update...'}
            {updateStatus === 'restarting' && 'Server restarting, please wait...'}
            {updateStatus === 'success' && 'Reloading...'}
            {updateStatus === 'error' && (updateError || 'Try again or update manually')}
          </p>
        </button>
      )}

      {/* Version + logout + collapse */}
      <div className="flex-shrink-0 px-2 pb-2 pt-1 border-t border-[var(--border)]">
        {!collapsed && hasToken && (
          <button
            onClick={logout}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors w-full"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        )}
        {collapsed && hasToken && (
          <button
            onClick={logout}
            title="Sign Out"
            className="flex items-center justify-center w-full py-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <LogOut size={16} />
          </button>
        )}
        {!collapsed && versionInfo.current && (
          <div className="flex items-center justify-between px-3 py-1.5 mb-1">
            <span className="text-[10px] text-[var(--text-muted)]">
              v{versionInfo.current}
            </span>
            {versionInfo.updateAvailable ? (
              <span className="text-[10px] text-[#818cf8] font-medium">New version</span>
            ) : versionInfo.latest ? (
              <span className="text-[10px] text-[var(--success)]">Up to date</span>
            ) : null}
          </div>
        )}
        <button
          onClick={onToggle}
          className="flex items-center justify-center w-full py-2 rounded-md text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>
    </div>
  );
}
