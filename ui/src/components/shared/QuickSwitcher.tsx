import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  MessageSquare, Activity, Users, ScrollText, Settings,
  Radio, Wrench, BarChart3, Network, Brain, Zap, Shield,
  GitBranch, Plug, FlaskConical, UserCircle, Bot, Eye,
  ClipboardList, Cable, Cpu, FolderOpen, Search, GitPullRequest,
} from 'lucide-react';
import clsx from 'clsx';

interface PanelEntry {
  path: string;
  label: string;
  icon: React.ReactNode;
  group: string;
}

const PANELS: PanelEntry[] = [
  { path: '/chat', label: 'Chat', icon: <MessageSquare size={16} />, group: 'Main' },
  { path: '/overview', label: 'Overview', icon: <BarChart3 size={16} />, group: 'Dashboard' },
  { path: '/activity', label: 'Activity', icon: <Activity size={16} />, group: 'Dashboard' },
  { path: '/sessions', label: 'Sessions', icon: <ScrollText size={16} />, group: 'Dashboard' },
  { path: '/agents', label: 'Agents', icon: <Users size={16} />, group: 'Dashboard' },
  { path: '/telemetry', label: 'Telemetry', icon: <BarChart3 size={16} />, group: 'Dashboard' },
  { path: '/logs', label: 'Logs', icon: <ScrollText size={16} />, group: 'Dashboard' },
  { path: '/autopilot', label: 'Autopilot', icon: <Zap size={16} />, group: 'Agent' },
  { path: '/self-proposals', label: 'Self-Proposals', icon: <GitPullRequest size={16} />, group: 'Agent' },
  { path: '/daemon', label: 'Daemon', icon: <Bot size={16} />, group: 'Agent' },
  { path: '/command-post', label: 'Command Post', icon: <ClipboardList size={16} />, group: 'Agent' },
  { path: '/workflows', label: 'Workflows', icon: <GitBranch size={16} />, group: 'Agent' },
  { path: '/personas', label: 'Personas', icon: <UserCircle size={16} />, group: 'Agent' },
  { path: '/self-improve', label: 'Self-Improve', icon: <FlaskConical size={16} />, group: 'Agent' },
  { path: '/autoresearch', label: 'Autoresearch', icon: <Eye size={16} />, group: 'Agent' },
  { path: '/files', label: 'Files', icon: <FolderOpen size={16} />, group: 'Agent' },
  { path: '/skills', label: 'Skills', icon: <Wrench size={16} />, group: 'Tools' },
  { path: '/mcp', label: 'MCP', icon: <Cable size={16} />, group: 'Tools' },
  { path: '/integrations', label: 'Integrations', icon: <Plug size={16} />, group: 'Tools' },
  { path: '/nvidia', label: 'NVIDIA', icon: <Cpu size={16} />, group: 'Tools' },
  { path: '/channels', label: 'Channels', icon: <Radio size={16} />, group: 'Tools' },
  { path: '/mesh', label: 'Mesh', icon: <Network size={16} />, group: 'Tools' },
  { path: '/learning', label: 'Learning', icon: <Brain size={16} />, group: 'Memory' },
  { path: '/memory-graph', label: 'Memory Graph', icon: <Brain size={16} />, group: 'Memory' },
  { path: '/audit', label: 'Audit Log', icon: <Shield size={16} />, group: 'Memory' },
  { path: '/settings', label: 'Settings', icon: <Settings size={16} />, group: 'Settings' },
  { path: '/security', label: 'Security', icon: <Shield size={16} />, group: 'Settings' },
];

interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
}

export function QuickSwitcher({ open, onClose }: QuickSwitcherProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!query.trim()) return PANELS;
    const q = query.toLowerCase();
    return PANELS.filter(
      (p) => p.label.toLowerCase().includes(q) || p.group.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const select = useCallback(
    (path: string) => {
      navigate(path);
      onClose();
    },
    [navigate, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[selectedIndex]) {
        select(filtered[selectedIndex].path);
      }
    },
    [filtered, selectedIndex, select],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search size={16} className="text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to panel..."
            className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-muted"
          />
          <kbd className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded border border-border">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-text-muted">No panels found</div>
          )}
          {filtered.map((panel, i) => (
            <button
              key={panel.path}
              onClick={() => select(panel.path)}
              className={clsx(
                'flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                i === selectedIndex ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary',
              )}
            >
              <span className="flex-shrink-0 opacity-60">{panel.icon}</span>
              <span className="font-medium">{panel.label}</span>
              <span className="ml-auto text-xs text-text-muted">{panel.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
