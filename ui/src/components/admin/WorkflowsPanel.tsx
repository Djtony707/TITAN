import { useState, useEffect, useCallback } from 'react';
import {
  GitBranch,
  Target,
  Clock,
  BookOpen,
  Zap,
  Play,
  Trash2,
  Plus,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  XCircle,
  Pause,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  AlertTriangle,
  Timer,
} from 'lucide-react';
import { PageHeader } from '@/components/shared/PageHeader';
import { apiFetch } from '@/api/client';
import { InlineEditableField } from '@/components/shared';

// ─── Types ──────────────────────────────────────────────────────

interface Subtask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  error?: string;
  retries: number;
}

interface Goal {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  priority: number;
  subtasks: Subtask[];
  progress: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  last_run?: string;
  created_at: string;
}

interface Recipe {
  id: string;
  name: string;
  description: string;
  slashCommand?: string;
  steps: Array<{ prompt: string; tool?: string }>;
  tags?: string[];
  author?: string;
  lastRunAt?: string;
}

interface AutopilotRun {
  timestamp: string;
  duration: number;
  classification: 'ok' | 'notable' | 'urgent';
  summary: string;
  skipped?: boolean;
}

interface AutopilotStatus {
  enabled: boolean;
  schedule: string;
  lastRun: AutopilotRun | null;
  nextRunEstimate: string | null;
  totalRuns: number;
  isRunning: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

function cronToHuman(expr: string): string {
  const parts = expr.split(' ');
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  const dowNames: Record<string, string> = {
    '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun',
  };

  if (dom === '*' && mon === '*') {
    const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (dow === '*') return `Daily at ${timeStr}`;
    if (dow === '1-5') return `Weekdays at ${timeStr}`;
    if (dow === '0,6') return `Weekends at ${timeStr}`;
    const days = dow.split(',').map(d => dowNames[d] || d).join(', ');
    return `${days} at ${timeStr}`;
  }
  if (min.startsWith('*/')) return `Every ${min.slice(2)} min`;
  if (hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`;
  return expr;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const api = async (path: string, opts?: RequestInit) => {
  const res = await apiFetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
};

// ─── Sub-components ─────────────────────────────────────────────

function SectionHeader({ icon: Icon, title, count, accent = 'var(--color-accent)' }: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  title: string;
  count?: number;
  accent?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="w-5 h-5" style={{ color: accent }} />
      <h2 className="text-base font-semibold text-text">{title}</h2>
      {count !== undefined && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary text-text-secondary">
          {count}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string }> = {
    active: { bg: '#34d39920', text: 'var(--color-emerald)' },
    completed: { bg: '#6366f120', text: 'var(--color-accent)' },
    paused: { bg: '#f59e0b20', text: 'var(--color-warning)' },
    failed: { bg: '#ef444420', text: 'var(--color-error)' },
    pending: { bg: '#52525b20', text: 'var(--color-text-secondary)' },
    running: { bg: '#22d3ee20', text: 'var(--color-cyan)' },
    done: { bg: '#34d39920', text: 'var(--color-emerald)' },
    skipped: { bg: '#52525b20', text: 'var(--color-border-light)' },
    ok: { bg: '#34d39920', text: 'var(--color-emerald)' },
    notable: { bg: '#f59e0b20', text: 'var(--color-warning)' },
    urgent: { bg: '#ef444420', text: 'var(--color-error)' },
  };
  const s = styles[status] || styles.pending;
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium capitalize" style={{ backgroundColor: s.bg, color: s.text }}>
      {status}
    </span>
  );
}

function SubtaskIcon({ status }: { status: string }) {
  switch (status) {
    case 'done': return <CheckCircle2 className="w-3.5 h-3.5 text-emerald" />;
    case 'failed': return <XCircle className="w-3.5 h-3.5 text-error" />;
    case 'running': return <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan" />;
    case 'skipped': return <Pause className="w-3.5 h-3.5 text-text-muted" />;
    default: return <Circle className="w-3.5 h-3.5 text-text-muted" />;
  }
}

// ─── Goals Section ──────────────────────────────────────────────

function GoalsSection({ goals, onRefresh }: { goals: Goal[]; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formDesc, setFormDesc] = useState('');

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const createNewGoal = async () => {
    if (!formTitle.trim()) return;
    await api('/api/goals', {
      method: 'POST',
      body: JSON.stringify({ title: formTitle, description: formDesc }),
    });
    setFormTitle('');
    setFormDesc('');
    setShowForm(false);
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await api(`/api/goals/${id}`, { method: 'DELETE' });
    onRefresh();
  };

  // v4.3.1: pause a stuck or noisy goal without deleting it. Backend
  // accepts any of Goal.status values — UI flips active⇄paused.
  const handleToggleStatus = async (goalId: string, currentStatus: string) => {
    const next = currentStatus === 'paused' ? 'active' : 'paused';
    try {
      await api(`/api/goals/${goalId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      onRefresh();
    } catch (e) { alert(`Update failed: ${(e as Error).message}`); }
  };

  const handleRetrySubtask = async (goalId: string, subtaskId: string) => {
    try {
      await api(`/api/goals/${goalId}/subtasks/${subtaskId}/retry`, { method: 'POST' });
      onRefresh();
    } catch (e) { alert(`Retry failed: ${(e as Error).message}`); }
  };

  const handleEditSubtaskTitle = async (goalId: string, subtaskId: string, title: string) => {
    try {
      await api(`/api/goals/${goalId}/subtasks/${subtaskId}`, {
        method: 'PATCH', body: JSON.stringify({ title }),
      });
      onRefresh();
    } catch (e) { alert(`Save failed: ${(e as Error).message}`); }
  };

  const handleCompleteSubtask = async (goalId: string, subtaskId: string) => {
    await api(`/api/goals/${goalId}/subtasks/${subtaskId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result: 'Completed via dashboard' }),
    });
    onRefresh();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <SectionHeader icon={Target} title="Active Goals" count={goals.length} accent="#34d399" />
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg transition-colors bg-bg-tertiary text-text-secondary"
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#34d39930'; e.currentTarget.style.color = 'var(--color-emerald)'; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--color-bg-tertiary)'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
        >
          <Plus className="w-3.5 h-3.5" /> New Goal
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg p-4 mb-4" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
          <input
            id="workflow-goal-title"
            name="workflow-goal-title"
            type="text"
            placeholder="Goal title..."
            value={formTitle}
            onChange={e => setFormTitle(e.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm mb-2 outline-none"
            style={{ backgroundColor: 'var(--color-bg)', border: '1px solid #27272a', color: 'var(--color-text)' }}
          />
          <textarea
            id="workflow-goal-description"
            name="workflow-goal-description"
            placeholder="Description (optional)..."
            value={formDesc}
            onChange={e => setFormDesc(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg text-sm mb-3 outline-none resize-none"
            style={{ backgroundColor: 'var(--color-bg)', border: '1px solid #27272a', color: 'var(--color-text)' }}
          />
          <div className="flex gap-2">
            <button
              onClick={createNewGoal}
              className="text-xs px-4 py-1.5 rounded-lg font-medium transition-opacity hover:opacity-80"
              style={{ backgroundColor: 'var(--color-emerald)', color: 'var(--color-bg)' }}
            >
              Create
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-xs px-4 py-1.5 rounded-lg transition-colors hover:opacity-80 bg-bg-tertiary text-text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {goals.length === 0 ? (
        <div className="rounded-lg p-6 text-center" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
          <Target className="w-8 h-8 mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">No goals yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {goals.map(goal => {
            const isOpen = expanded.has(goal.id);
            const done = goal.subtasks.filter(s => s.status === 'done' || s.status === 'skipped').length;
            const total = goal.subtasks.length;
            return (
              <div key={goal.id} className="rounded-lg overflow-hidden" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                  onClick={() => toggle(goal.id)}
                >
                  {isOpen
                    ? <ChevronDown className="w-4 h-4 flex-shrink-0 text-text-muted" />
                    : <ChevronRight className="w-4 h-4 flex-shrink-0 text-text-muted" />
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate text-text">{goal.title}</span>
                      <StatusBadge status={goal.status} />
                    </div>
                    {total > 0 && (
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-bg-tertiary">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${goal.progress}%`, backgroundColor: 'var(--color-emerald)' }}
                          />
                        </div>
                        <span className="text-xs flex-shrink-0 text-text-secondary">{done}/{total}</span>
                      </div>
                    )}
                  </div>
                  {goal.status !== 'completed' && (
                    <button
                      onClick={e => { e.stopPropagation(); handleToggleStatus(goal.id, goal.status); }}
                      className="p-1 rounded hover:opacity-80 flex-shrink-0"
                      title={goal.status === 'paused' ? 'Resume goal' : 'Pause goal'}
                    >
                      {goal.status === 'paused'
                        ? <Play className="w-3.5 h-3.5 text-emerald" />
                        : <Pause className="w-3.5 h-3.5" style={{ color: '#fbbf24' }} />
                      }
                    </button>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(goal.id); }}
                    className="p-1 rounded hover:opacity-80 flex-shrink-0"
                    title="Delete goal"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-text-muted" />
                  </button>
                </div>
                {isOpen && goal.subtasks.length > 0 && (
                  <div className="px-4 pb-3 border-t" style={{ borderColor: 'var(--color-bg-tertiary)' }}>
                    <div className="space-y-1.5 mt-2">
                      {goal.subtasks.map(st => (
                        <div key={st.id} className="flex items-center gap-2 py-1 px-2 rounded bg-bg">
                          <SubtaskIcon status={st.status} />
                          <span className="text-xs flex-1 min-w-0" style={{ color: st.status === 'done' ? 'var(--color-border-light)' : 'var(--color-text-secondary)' }}>
                            <InlineEditableField
                              value={st.title}
                              onSave={(v) => handleEditSubtaskTitle(goal.id, st.id, v)}
                              placeholder="Subtask title"
                            />
                          </span>
                          {st.status === 'failed' && st.error && (
                            <span className="text-xs truncate max-w-40 text-error" title={st.error}>
                              {st.error}
                            </span>
                          )}
                          {st.status === 'failed' && (
                            <button
                              onClick={() => handleRetrySubtask(goal.id, st.id)}
                              className="text-xs px-2 py-0.5 rounded transition-colors hover:opacity-80"
                              style={{ backgroundColor: 'var(--color-bg-tertiary)', color: '#fbbf24' }}
                              title="Reset to pending, clear error, retry"
                            >
                              <RefreshCw className="w-3 h-3 inline" /> Retry
                            </button>
                          )}
                          {st.status === 'pending' && (
                            <button
                              onClick={() => handleCompleteSubtask(goal.id, st.id)}
                              className="text-xs px-2 py-0.5 rounded transition-colors hover:opacity-80"
                              style={{ backgroundColor: 'var(--color-bg-tertiary)', color: 'var(--color-emerald)' }}
                            >
                              Done
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Cron Section ───────────────────────────────────────────────

function CronSection({ jobs, onRefresh }: { jobs: CronJob[]; onRefresh: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [command, setCommand] = useState('');

  const handleCreate = async () => {
    if (!name.trim() || !schedule.trim() || !command.trim()) return;
    await api('/api/cron', {
      method: 'POST',
      body: JSON.stringify({ name, schedule, command }),
    });
    setName(''); setSchedule(''); setCommand('');
    setShowForm(false);
    onRefresh();
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await api(`/api/cron/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled: !enabled }),
    });
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await api(`/api/cron/${id}`, { method: 'DELETE' });
    onRefresh();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <SectionHeader icon={Clock} title="Scheduled Tasks" count={jobs.length} accent="#22d3ee" />
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg transition-colors bg-bg-tertiary text-text-secondary"
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#22d3ee30'; e.currentTarget.style.color = 'var(--color-cyan)'; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--color-bg-tertiary)'; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
        >
          <Plus className="w-3.5 h-3.5" /> New Cron
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg p-4 mb-4" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
            <input
              id="workflow-cron-name"
              name="workflow-cron-name"
              type="text"
              placeholder="Job name..."
              value={name}
              onChange={e => setName(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={{ backgroundColor: 'var(--color-bg)', border: '1px solid #27272a', color: 'var(--color-text)' }}
            />
            <input
              id="workflow-cron-schedule"
              name="workflow-cron-schedule"
              type="text"
              placeholder="Schedule (e.g. */5 * * * *)"
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              className="px-3 py-2 rounded-lg text-sm outline-none"
              style={{ backgroundColor: 'var(--color-bg)', border: '1px solid #27272a', color: 'var(--color-text)' }}
            />
          </div>
          <input
            id="workflow-cron-command"
            name="workflow-cron-command"
            type="text"
            placeholder="Command to execute..."
            value={command}
            onChange={e => setCommand(e.target.value)}
            className="w-full px-3 py-2 rounded-lg text-sm mb-3 outline-none"
            style={{ backgroundColor: 'var(--color-bg)', border: '1px solid #27272a', color: 'var(--color-text)' }}
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="text-xs px-4 py-1.5 rounded-lg font-medium transition-opacity hover:opacity-80"
              style={{ backgroundColor: 'var(--color-cyan)', color: 'var(--color-bg)' }}
            >
              Create
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-xs px-4 py-1.5 rounded-lg transition-colors hover:opacity-80 bg-bg-tertiary text-text-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="rounded-lg p-6 text-center" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
          <Clock className="w-8 h-8 mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">No scheduled tasks. Create a cron job to automate tasks.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => (
            <div key={job.id} className="flex items-center gap-3 rounded-lg px-4 py-3" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
              <button
                onClick={() => handleToggle(job.id, job.enabled)}
                title={job.enabled ? 'Disable' : 'Enable'}
              >
                {job.enabled
                  ? <ToggleRight className="w-5 h-5 text-emerald" />
                  : <ToggleLeft className="w-5 h-5 text-text-muted" />
                }
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate" style={{ color: job.enabled ? 'var(--color-text)' : 'var(--color-border-light)' }}>{job.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--color-bg-tertiary)', color: 'var(--color-cyan)' }}>
                    {cronToHuman(job.schedule)}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs font-mono truncate text-text-muted">{job.command}</span>
                  {job.last_run && (
                    <span className="text-xs flex-shrink-0 text-text-muted">
                      Last: {timeAgo(job.last_run)}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDelete(job.id)}
                className="p-1 rounded hover:opacity-80 flex-shrink-0"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5 text-text-muted" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Recipes Section ────────────────────────────────────────────

function RecipesSection({ recipes, onRefresh }: { recipes: Recipe[]; onRefresh: () => void }) {
  const [runningId, setRunningId] = useState<string | null>(null);

  const handleRun = async (id: string) => {
    setRunningId(id);
    try {
      await api(`/api/recipes/${id}/run`, {
        method: 'POST',
        body: JSON.stringify({ params: {} }),
      });
      onRefresh();
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div>
      <SectionHeader icon={BookOpen} title="Recipes" count={recipes.length} accent="#6366f1" />
      {recipes.length === 0 ? (
        <div className="rounded-lg p-6 text-center" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
          <BookOpen className="w-8 h-8 mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">No recipes available.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {recipes.map(r => (
            <div key={r.id} className="rounded-lg p-4 flex flex-col" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium truncate text-text">{r.name}</h3>
                  {r.slashCommand && (
                    <span className="text-xs font-mono text-accent">/{r.slashCommand}</span>
                  )}
                </div>
                <button
                  onClick={() => handleRun(r.id)}
                  disabled={runningId === r.id}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg transition-opacity hover:opacity-80 flex-shrink-0"
                  style={{ backgroundColor: '#6366f130', color: 'var(--color-accent)' }}
                >
                  {runningId === r.id
                    ? <RefreshCw className="w-3 h-3 animate-spin" />
                    : <Play className="w-3 h-3" />
                  }
                  Run
                </button>
              </div>
              <p className="text-xs flex-1 line-clamp-2 mb-2 text-text-secondary">
                {r.description}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-text-muted">{r.steps.length} step{r.steps.length !== 1 ? 's' : ''}</span>
                {r.tags?.map(tag => (
                  <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">
                    {tag}
                  </span>
                ))}
                {r.lastRunAt && (
                  <span className="text-xs ml-auto text-text-muted">
                    Ran {timeAgo(r.lastRunAt)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Autopilot Section ──────────────────────────────────────────

function AutopilotSection({ status, history, onRefresh }: {
  status: AutopilotStatus | null;
  history: AutopilotRun[];
  onRefresh: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      await api('/api/autopilot/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled: !status?.enabled }),
      });
      onRefresh();
    } finally {
      setToggling(false);
    }
  };

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await api('/api/autopilot/run', { method: 'POST' });
      onRefresh();
    } finally {
      setTriggering(false);
    }
  };

  const classIcon = (c: string) => {
    switch (c) {
      case 'urgent': return <AlertTriangle className="w-3.5 h-3.5 text-error" />;
      case 'notable': return <Zap className="w-3.5 h-3.5 text-warning" />;
      default: return <CheckCircle2 className="w-3.5 h-3.5 text-emerald" />;
    }
  };

  return (
    <div>
      <SectionHeader icon={Zap} title="Autopilot" accent="#f59e0b" />
      <div className="rounded-lg overflow-hidden" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
        {/* Status bar */}
        <div className="flex items-center gap-4 px-4 py-3">
          <button onClick={handleToggle} disabled={toggling} title={status?.enabled ? 'Disable autopilot' : 'Enable autopilot'}>
            {status?.enabled
              ? <ToggleRight className="w-6 h-6 text-emerald" />
              : <ToggleLeft className="w-6 h-6 text-text-muted" />
            }
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text">
                {status?.enabled ? 'Active' : 'Disabled'}
              </span>
              {status?.isRunning && (
                <span className="flex items-center gap-1 text-xs text-cyan">
                  <RefreshCw className="w-3 h-3 animate-spin" /> Running...
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-xs text-text-muted">
                <Timer className="w-3 h-3 inline mr-1" />
                {status?.schedule ? cronToHuman(status.schedule) : 'No schedule'}
              </span>
              <span className="text-xs text-text-muted">
                {status?.totalRuns ?? 0} total runs
              </span>
              {status?.lastRun && (
                <span className="text-xs text-text-muted">
                  Last: {timeAgo(status.lastRun.timestamp)}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={handleTrigger}
            disabled={triggering || status?.isRunning}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80"
            style={{ backgroundColor: '#f59e0b30', color: 'var(--color-warning)' }}
          >
            {triggering
              ? <RefreshCw className="w-3 h-3 animate-spin" />
              : <Play className="w-3 h-3" />
            }
            Run Now
          </button>
        </div>

        {/* Recent runs */}
        {history.length > 0 && (
          <div className="border-t" style={{ borderColor: 'var(--color-bg-tertiary)' }}>
            <div className="px-4 py-2">
              <span className="text-xs font-medium text-text-muted">Recent Runs</span>
            </div>
            <div className="divide-y" style={{ borderColor: 'var(--color-bg-tertiary)' }}>
              {history.slice(-5).reverse().map((run, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2">
                  {classIcon(run.classification)}
                  <span className="text-xs flex-1 truncate text-text-secondary">
                    {run.skipped ? `Skipped: ${run.summary}` : run.summary.slice(0, 120)}
                  </span>
                  <StatusBadge status={run.classification} />
                  <span className="text-xs flex-shrink-0 text-text-muted">
                    {timeAgo(run.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────

function WorkflowsPanel() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [autopilotStatus, setAutopilotStatus] = useState<AutopilotStatus | null>(null);
  const [autopilotHistory, setAutopilotHistory] = useState<AutopilotRun[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [goalsRes, cronRes, recipesRes, apStatusRes, apHistoryRes] = await Promise.allSettled([
        api('/api/goals'),
        api('/api/cron'),
        api('/api/recipes'),
        api('/api/autopilot/status'),
        api('/api/autopilot/history?limit=5'),
      ]);

      if (goalsRes.status === 'fulfilled') setGoals(goalsRes.value.goals || []);
      if (cronRes.status === 'fulfilled') setCronJobs(cronRes.value.jobs || []);
      if (recipesRes.status === 'fulfilled') setRecipes(recipesRes.value.recipes || []);
      if (apStatusRes.status === 'fulfilled') setAutopilotStatus(apStatusRes.value);
      if (apHistoryRes.status === 'fulfilled') setAutopilotHistory(Array.isArray(apHistoryRes.value) ? apHistoryRes.value : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Workflows"
        breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Agent'}, {label:'Workflows'}]}
        actions={
          <button
            onClick={() => { setLoading(true); fetchAll(); }}
            className="p-2 rounded-lg transition-colors hover:opacity-80 bg-bg-tertiary"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4 text-text-secondary" />
          </button>
        }
      />

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Goals', value: goals.filter(g => g.status === 'active').length, total: goals.length, color: 'var(--color-emerald)' },
          { label: 'Cron Jobs', value: cronJobs.filter(j => j.enabled).length, total: cronJobs.length, color: 'var(--color-cyan)' },
          { label: 'Recipes', value: recipes.length, color: 'var(--color-accent)' },
          { label: 'Autopilot Runs', value: autopilotStatus?.totalRuns ?? 0, color: 'var(--color-warning)' },
        ].map(stat => (
          <div key={stat.label} className="rounded-lg px-4 py-3" style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid #27272a' }}>
            <p className="text-xs mb-1 text-text-muted">{stat.label}</p>
            <p className="text-lg font-bold" style={{ color: stat.color }}>
              {stat.value}
              {stat.total !== undefined && stat.total !== stat.value && (
                <span className="text-xs font-normal ml-1 text-text-muted">/ {stat.total}</span>
              )}
            </p>
          </div>
        ))}
      </div>

      {/* Sections */}
      <GoalsSection goals={goals} onRefresh={fetchAll} />
      <CronSection jobs={cronJobs} onRefresh={fetchAll} />
      <RecipesSection recipes={recipes} onRefresh={fetchAll} />
      <AutopilotSection status={autopilotStatus} history={autopilotHistory} onRefresh={fetchAll} />
    </div>
  );
}

export default WorkflowsPanel;
