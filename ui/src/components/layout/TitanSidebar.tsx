import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  LayoutDashboard, Hexagon, MessageSquare, Bot, Brain,
  Wrench, Server, Settings, Activity, Zap, ChevronLeft, ChevronRight,
  FolderKanban, CircleDot, Target, ShieldCheck, Radio, BarChart3,
  Sparkles, Cpu, Plus, Mic
} from 'lucide-react';
import { useSidebar } from '@/context/SidebarContext';
import { useCanvas } from '@/space-agent/CanvasContext';
import { useVoice } from '@/context/VoiceContext';
import { Modal, Button } from '@/components/shared';
import { createCPIssue } from '@/api/client';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Sidebar — Space Agent-style navigation
   ═══════════════════════════════════════════════════════════════════ */

interface NavSection {
  label: string;
  path: string;
  icon: React.ElementType;
  color: string;
  badge?: string;
}

const PRIMARY_NAV: NavSection[] = [
  { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, color: '#6366f1' },
  { label: 'Canvas', path: '/space', icon: Hexagon, color: '#a855f7' },
  { label: 'Mission', path: '/', icon: MessageSquare, color: '#22d3ee' },
];

const WORK_NAV: NavSection[] = [
  { label: 'Command Post', path: '/command-post', icon: Bot, color: '#f59e0b' },
  { label: 'Projects', path: '/projects', icon: FolderKanban, color: '#34d399' },
  { label: 'Issues', path: '/issues', icon: CircleDot, color: '#ef4444' },
  { label: 'Goals', path: '/goals', icon: Target, color: '#8b5cf6' },
  { label: 'Approvals', path: '/approvals', icon: ShieldCheck, color: '#f59e0b' },
];

const SYSTEM_NAV: NavSection[] = [
  { label: 'Intelligence', path: '/intelligence', icon: Brain, color: '#34d399' },
  { label: 'Tools', path: '/tools', icon: Wrench, color: '#818cf8' },
  { label: 'Infra', path: '/infra', icon: Server, color: '#ec4899' },
  { label: 'Watch', path: '/watch', icon: BarChart3, color: '#22c55e' },
  { label: 'Activity', path: '/activity', icon: Activity, color: '#22d3ee' },
  { label: 'Soma', path: '/soma', icon: Cpu, color: '#8b5cf6' },
  { label: 'Settings', path: '/settings', icon: Settings, color: '#71717a' },
];

function NavGroup({ title, items }: { title: string; items: NavSection[] }) {
  const location = useLocation();
  const { sidebarOpen } = useSidebar();

  return (
    <div className="mb-1">
      {sidebarOpen && (
        <div className="px-4 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#3f3f46]">
          {title}
        </div>
      )}
      {items.map((section) => {
        const isActive = location.pathname === section.path ||
          (section.path !== '/' && location.pathname.startsWith(section.path));
        return (
          <Link
            key={section.path}
            to={section.path}
            className={`flex items-center gap-3 px-3 py-1.5 mx-2 rounded-lg transition-all group ${
              isActive
                ? 'bg-[#6366f1]/10 text-[#818cf8] border border-[#6366f1]/20'
                : 'text-[#a1a1aa] hover:bg-[#27272a]/50 hover:text-[#fafafa]'
            }`}
            title={section.label}
          >
            <section.icon
              className="w-4 h-4 flex-shrink-0 transition-colors"
              style={{ color: isActive ? section.color : undefined }}
            />
            {sidebarOpen && (
              <span className="text-[12px] font-medium truncate flex-1">{section.label}</span>
            )}
            {sidebarOpen && section.badge && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#ef4444]/20 text-[#ef4444] font-bold">
                {section.badge}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export function TitanSidebar() {
  const { sidebarOpen, setSidebarOpen, isMobile } = useSidebar();
  const { widgets } = useCanvas();
  const { open: openVoice } = useVoice();
  const navigate = useNavigate();

  // ─── New Issue dialog state ────────────────────────────────────────
  // Mirrors the CPIssues panel pattern (ui/src/components/command-post/
  // CPIssues.tsx) so the create-flow stays consistent across the app.
  // Pre-fix: the sidebar's "New Issue" button had an empty onClick that
  // did nothing; users had no way to create issues without navigating
  // to the Command Post panel first.
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState('medium');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const resetForm = () => {
    setNewTitle('');
    setNewPriority('medium');
    setNewDesc('');
    setCreateError(null);
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const issue = await createCPIssue({
        title: newTitle.trim(),
        description: newDesc.trim() || undefined,
        priority: newPriority,
      });
      setShowCreate(false);
      resetForm();
      // Navigate to the new issue so the user lands on something concrete.
      // If the API didn't echo an id back (older gateway), fall back to the
      // issues list — never leave the user with a closed-modal-and-nothing-changed UX.
      const issueId = (issue as { id?: string } | undefined)?.id;
      if (issueId) navigate(`/command-post/issues/${issueId}`);
      else navigate('/issues');
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create issue');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#09090b] border-r border-[#27272a]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#27272a]">
        <div className="w-8 h-8 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-4 h-4 text-[#6366f1]" />
        </div>
        {sidebarOpen && (
          <div className="flex-1 min-w-0">
            <span className="text-sm font-bold text-[#fafafa]">TITAN</span>
            <span className="text-[10px] text-[#52525b] block">AI Control Plane</span>
          </div>
        )}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1 rounded hover:bg-[#27272a] text-[#52525b] hover:text-[#a1a1aa] transition-colors"
        >
          {sidebarOpen ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Quick Create */}
      {sidebarOpen && (
        <div className="px-3 py-2">
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] text-xs font-medium hover:bg-[#6366f1]/20 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Issue
          </button>
        </div>
      )}

      {/* New Issue dialog — POST /api/command-post/issues */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); resetForm(); }}
        title="New Issue"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => { setShowCreate(false); resetForm(); }}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} loading={creating} disabled={!newTitle.trim()}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Title</label>
            <input
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
              placeholder="Issue title..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Priority</label>
            <select
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text focus:outline-none focus:border-accent"
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Description</label>
            <textarea
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-accent min-h-[80px] resize-y"
              placeholder="Describe the issue..."
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>
          {createError && (
            <div className="text-xs text-error" role="alert">{createError}</div>
          )}
        </div>
      </Modal>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        <NavGroup title="Overview" items={PRIMARY_NAV} />
        <div className="my-2 mx-3 border-t border-[#27272a]/50" />
        <NavGroup title="Work" items={WORK_NAV} />
        <div className="my-2 mx-3 border-t border-[#27272a]/50" />
        <NavGroup title="System" items={SYSTEM_NAV} />
      </nav>

      {/* Footer */}
      {sidebarOpen && (
        <div className="px-4 py-3 border-t border-[#27272a]">
          <button
            onClick={openVoice}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 mb-2 rounded-lg bg-[#22c55e]/10 border border-[#22c55e]/20 text-[#22c55e] text-xs font-medium hover:bg-[#22c55e]/20 transition-colors"
          >
            <Mic className="w-3.5 h-3.5" />
            Voice Chat
          </button>
          <div className="flex items-center gap-2 mb-1">
            <Radio className="w-3 h-3 text-[#22c55e]" />
            <span className="text-[10px] text-[#52525b]">System Online</span>
          </div>
          <div className="text-[9px] text-[#3f3f46]">
            {widgets.length} widget{widgets.length !== 1 ? 's' : ''} · v4.13.0
          </div>
        </div>
      )}
    </div>
  );
}
