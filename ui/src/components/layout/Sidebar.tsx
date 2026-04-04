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
  ChevronDown,
  ChevronLeft,
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
  Plus,
  Mic,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { apiFetch } from '@/api/client';
import { SearchInput } from '@/components/shared/SearchInput';

// ── Types ───────────────────────────────────────────────────────────────

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** 'chat' = slim sidebar for chat, 'admin' = full sidebar for admin panels */
  mode: 'chat' | 'admin';
  onModeChange: (mode: 'chat' | 'admin') => void;
  onVoiceOpen?: () => void;
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

// ── Navigation Data ─────────────────────────────────────────────────────

export const navGroups: NavGroup[] = [
  {
    label: 'Monitoring',
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
      { label: 'Command Post', icon: Shield, path: '/command-post' },
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

// ── Version / Update Logic ──────────────────────────────────────────────

interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

type UpdateStatus = 'idle' | 'updating' | 'restarting' | 'success' | 'error';

// ── Component ───────────────────────────────────────────────────────────

export function Sidebar({ collapsed, onToggle, mode, onModeChange, onVoiceOpen }: SidebarProps) {
  const location = useLocation();
  const { logout } = useAuth();
  const hasToken = Boolean(localStorage.getItem('titan-token'));
  const [versionInfo, setVersionInfo] = useState<VersionInfo>({ current: '', latest: null, updateAvailable: false });
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateError, setUpdateError] = useState('');
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const group of navGroups) {
      if (group.items.some(item => location.pathname.startsWith(item.path))) {
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

  // Auto-expand group on navigate
  useEffect(() => {
    for (const group of navGroups) {
      if (group.items.some(item => location.pathname.startsWith(item.path))) {
        setExpandedGroups(prev => {
          if (prev.has(group.label)) return prev;
          return new Set(prev).add(group.label);
        });
      }
    }
  }, [location.pathname]);

  // Auto-switch to admin mode when navigating to an admin panel
  useEffect(() => {
    const isAdminRoute = navGroups.some(g => g.items.some(item => location.pathname.startsWith(item.path)));
    if (isAdminRoute && mode === 'chat') {
      onModeChange('admin');
    }
    if (location.pathname === '/' && mode === 'admin') {
      onModeChange('chat');
    }
  }, [location.pathname, mode, onModeChange]);

  // Version check
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
          setVersionInfo({ current, latest, updateAvailable: !!(latest && current && latest !== current) });
        } catch { /* npm check non-critical */ }
      } catch { /* health failed */ }
    })();
  }, []);

  const triggerUpdate = useCallback(async () => {
    if (updateStatus === 'updating' || updateStatus === 'restarting') return;
    setUpdateStatus('updating');
    setUpdateError('');
    try {
      const res = await apiFetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restart: true }) });
      const data = await res.json();
      if (!data.ok) { setUpdateStatus('error'); setUpdateError(data.error || 'Update failed'); return; }
      if (data.restarting) {
        setUpdateStatus('restarting');
        const poll = setInterval(async () => { try { const h = await apiFetch('/api/health'); if (h.ok) { clearInterval(poll); setUpdateStatus('success'); setTimeout(() => window.location.reload(), 1000); } } catch { /* still restarting */ } }, 2000);
        setTimeout(() => clearInterval(poll), 60_000);
      } else { setUpdateStatus('success'); setTimeout(() => window.location.reload(), 2000); }
    } catch { setUpdateStatus('error'); setUpdateError('Network error'); }
  }, [updateStatus]);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  // Filter groups by search
  const filteredGroups = search.trim()
    ? navGroups.map(g => ({
        ...g,
        items: g.items.filter(i => i.label.toLowerCase().includes(search.toLowerCase())),
      })).filter(g => g.items.length > 0)
    : navGroups;

  // ════════════════════════════════════════════════════════════════════
  // CHAT MODE — Slim sidebar for everyday use
  // ════════════════════════════════════════════════════════════════════
  if (mode === 'chat') {
    return (
      <div className="flex flex-col h-full w-[60px] bg-bg-secondary border-r border-border md:w-[64px]">
        {/* Logo */}
        <Link to="/" className="flex items-center justify-center h-14 flex-shrink-0 hover:opacity-90 transition-opacity">
          <div className="relative w-8 h-8">
            <img src="/titan-logo.png" alt="TITAN" className="w-8 h-8 rounded-lg" />
            <div className="absolute inset-0 rounded-lg ring-1 ring-white/10" />
          </div>
        </Link>

        {/* Quick actions — larger touch targets on mobile */}
        <nav className="flex-1 flex flex-col items-center gap-1 px-2 py-2">
          {/* New Chat */}
          <Link
            to="/"
            title="New Chat"
            className={`flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-xl transition-all active:scale-95 md:hover:scale-105 ${
              isActive('/') ? 'bg-accent text-white glow-accent' : 'text-text-secondary hover:text-text hover:bg-bg-tertiary'
            }`}
          >
            <Plus size={20} />
          </Link>

          <div className="w-6 border-t border-border my-1" />

          {/* Shortcuts */}
          <Link to="/agents" title="Agents" className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-xl text-text-muted hover:text-text hover:bg-bg-tertiary transition-all active:scale-95">
            <Users size={18} />
          </Link>
          <Link to="/skills" title="Skills" className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-xl text-text-muted hover:text-text hover:bg-bg-tertiary transition-all active:scale-95">
            <Wrench size={18} />
          </Link>
          {onVoiceOpen && (
            <button onClick={onVoiceOpen} title="Voice" className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-xl text-text-muted hover:text-text hover:bg-bg-tertiary transition-all active:scale-95">
              <Mic size={18} />
            </button>
          )}
        </nav>

        {/* Bottom: Admin + Logout */}
        <div className="flex flex-col items-center gap-1 px-2 pb-3">
          {hasToken && (
            <button onClick={logout} title="Sign Out" className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-xl text-text-muted hover:text-text hover:bg-bg-tertiary transition-all active:scale-95">
              <LogOut size={16} />
            </button>
          )}
          <button
            onClick={() => onModeChange('admin')}
            title="Admin Panel"
            className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-xl text-text-muted hover:text-accent hover:bg-accent/10 transition-all active:scale-95"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════
  // ADMIN MODE — Full sidebar for power users
  // ════════════════════════════════════════════════════════════════════
  return (
    <div className="flex flex-col h-full bg-bg-secondary border-r border-border">
      {/* Back to Chat header — better mobile touch target */}
      <div className="flex items-center gap-2 md:gap-3 px-2 md:px-3 h-14 flex-shrink-0 border-b border-border">
        <Link
          to="/"
          onClick={() => onModeChange('chat')}
          className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text transition-colors px-2 py-2 rounded-lg active:bg-bg-tertiary"
        >
          <ChevronLeft size={18} />
          <span className="font-medium hidden sm:inline">Back to Chat</span>
        </Link>
        {!collapsed && (
          <div className="ml-auto flex items-center gap-1">
            <kbd className="text-[9px] md:text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded border border-border hidden sm:inline-block">
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+K
            </kbd>
          </div>
        )}
      </div>

      {/* Search — hidden on very small screens */}
      {!collapsed && (
        <div className="px-2 md:px-3 py-2 hidden sm:block">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search panels..."
          />
        </div>
      )}

      {/* Navigation — larger touch targets on mobile */}
      <nav className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
        {filteredGroups.map((group) => {
          const isExpanded = expandedGroups.has(group.label) || search.trim().length > 0;
          const hasActiveChild = group.items.some(item => isActive(item.path));
          const GroupIcon = group.icon;

          return (
            <div key={group.label} className="mt-1">
              {/* Group header — better mobile touch target */}
              <button
                onClick={() => !collapsed && toggleGroup(group.label)}
                title={collapsed ? group.label : undefined}
                className={`flex items-center w-full px-2.5 md:px-3 py-2.5 md:py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors min-h-[44px] ${
                  hasActiveChild && collapsed
                    ? 'text-accent bg-accent/10'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-tertiary'
                } ${collapsed ? 'justify-center' : 'gap-2'}`}
              >
                {collapsed ? (
                  <GroupIcon size={18} className={hasActiveChild ? 'text-accent' : ''} />
                ) : (
                  <>
                    <GroupIcon size={14} className="flex-shrink-0" />
                    <span className="flex-1 text-left text-[11px] md:text-xs">{group.label}</span>
                    <ChevronDown
                      size={14}
                      className={`flex-shrink-0 transition-transform duration-200 ${isExpanded ? '' : '-rotate-90'}`}
                    />
                  </>
                )}
              </button>

              {/* Group items — expanded with larger touch targets */}
              {!collapsed && isExpanded && (
                <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border pl-2">
                  {group.items.map(({ label, icon: Icon, path }) => {
                    const active = isActive(path);
                    return (
                      <Link
                        key={path}
                        to={path}
                        className={`flex items-center gap-2.5 md:gap-3 px-3 py-2 md:py-1.5 rounded-lg text-sm transition-all min-h-[40px] active:scale-[0.98] ${
                          active
                            ? 'bg-accent/15 text-accent font-medium'
                            : 'text-text-secondary hover:text-text hover:bg-bg-tertiary'
                        }`}
                      >
                        <Icon size={15} className="flex-shrink-0" />
                        <span className="text-[11px] md:text-sm">{label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}

              {/* Collapsed icons — larger touch targets */}
              {collapsed && (
                <div className="space-y-0.5">
                  {group.items.map(({ label, icon: Icon, path }) => {
                    const active = isActive(path);
                    return (
                      <Link
                        key={path}
                        to={path}
                        title={label}
                        className={`flex items-center justify-center px-3 py-2 rounded-lg transition-all min-h-[44px] active:scale-95 ${
                          active
                            ? 'bg-accent/15 text-accent'
                            : 'text-text-muted hover:text-text hover:bg-bg-tertiary'
                        }`}
                      >
                        <Icon size={18} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Update banner — hidden on small screens in collapsed mode */}
      {versionInfo.updateAvailable && !collapsed && (
        <button
          onClick={triggerUpdate}
          disabled={updateStatus === 'updating' || updateStatus === 'restarting'}
          className="mx-2 mb-2 px-3 py-2.5 rounded-lg bg-gradient-to-r from-accent/15 to-accent-hover/10 border border-accent/25 hover:from-accent/25 hover:to-accent-hover/20 transition-all cursor-pointer text-left w-[calc(100%-1rem)] disabled:opacity-70 disabled:cursor-wait active:scale-[0.98]"
        >
          <div className="flex items-center gap-2 mb-1">
            {updateStatus === 'idle' && <ArrowUpCircle size={14} className="text-accent-hover flex-shrink-0" />}
            {updateStatus === 'updating' && <Loader2 size={14} className="text-accent-hover flex-shrink-0 animate-spin" />}
            {updateStatus === 'restarting' && <RotateCw size={14} className="text-accent-hover flex-shrink-0 animate-spin" />}
            {updateStatus === 'success' && <CheckCircle2 size={14} className="text-emerald flex-shrink-0" />}
            {updateStatus === 'error' && <XCircle size={14} className="text-error flex-shrink-0" />}
            <span className="text-xs font-semibold text-accent-hover">
              {updateStatus === 'idle' && 'Update Available'}
              {updateStatus === 'updating' && 'Updating...'}
              {updateStatus === 'restarting' && 'Restarting...'}
              {updateStatus === 'success' && 'Updated!'}
              {updateStatus === 'error' && 'Update Failed'}
            </span>
          </div>
          <p className="text-[10px] text-text-muted leading-relaxed">
            {updateStatus === 'idle' && <>v{versionInfo.latest} is out. <span className="text-accent-light">Click to update &amp; restart</span></>}
            {updateStatus === 'updating' && 'Installing update...'}
            {updateStatus === 'restarting' && 'Server restarting, please wait...'}
            {updateStatus === 'success' && 'Reloading...'}
            {updateStatus === 'error' && (updateError || 'Try again or update manually')}
          </p>
        </button>
      )}

      {/* Footer — better mobile touch targets */}
      <div className="flex-shrink-0 px-2 pb-2 pt-1 border-t border-border">
        {!collapsed && hasToken && (
          <button
            onClick={logout}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors w-full min-h-[44px] active:scale-[0.98]"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        )}
        {collapsed && hasToken && (
          <button onClick={logout} title="Sign Out" className="flex items-center justify-center w-full py-2 rounded-lg text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors min-h-[44px] active:scale-95">
            <LogOut size={16} />
          </button>
        )}
        {!collapsed && versionInfo.current && (
          <div className="flex items-center justify-between px-3 py-1.5 mb-1">
            <span className="text-[10px] text-text-muted">v{versionInfo.current}</span>
            {versionInfo.updateAvailable ? (
              <span className="text-[10px] text-accent-hover font-medium">New version</span>
            ) : versionInfo.latest ? (
              <span className="text-[10px] text-success">Up to date</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
