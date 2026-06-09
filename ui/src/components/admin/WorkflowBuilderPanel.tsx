import { useState, useEffect, useMemo } from 'react';
import { Workflow, Play, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { PageHeader } from '@/components/shared/PageHeader';

interface Subtask { id: string; title: string; description?: string; status: string; dependsOn: string[] }
interface MissionRef { goalId: string; title: string; phase?: string }

const STATUS_FILL: Record<string, string> = {
  done: '#22c55e', completed: '#22c55e', in_progress: '#3b82f6', running: '#3b82f6',
  pending: '#64748b', blocked: '#f59e0b', failed: '#ef4444', skipped: '#475569',
};

/** Layered DAG layout: column = longest dependency depth, row = order within column. */
function layout(subtasks: Subtask[]) {
  const byId = new Map(subtasks.map(s => [s.id, s]));
  const depth = new Map<string, number>();
  const compute = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const deps = (byId.get(id)?.dependsOn || []).filter(d => byId.has(d));
    const v = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(d => compute(d, seen)));
    depth.set(id, v);
    return v;
  };
  subtasks.forEach(s => compute(s.id));
  const cols = new Map<number, string[]>();
  subtasks.forEach(s => { const c = depth.get(s.id) ?? 0; if (!cols.has(c)) cols.set(c, []); cols.get(c)!.push(s.id); });
  const pos = new Map<string, { x: number; y: number }>();
  let maxRow = 0;
  [...cols.entries()].forEach(([c, ids]) => ids.forEach((id, row) => { pos.set(id, { x: c * 240 + 20, y: row * 92 + 20 }); maxRow = Math.max(maxRow, row); }));
  const width = (Math.max(0, ...cols.keys()) + 1) * 240 + 40;
  const height = (maxRow + 1) * 92 + 40;
  return { pos, width, height };
}

const NODE_W = 190, NODE_H = 64;

function WorkflowBuilderPanel() {
  const [missions, setMissions] = useState<MissionRef[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Subtask | null>(null);

  const loadMissions = () => {
    Promise.all([
      apiFetch('/api/missions/active', { headers: { 'Content-Type': 'application/json' } }).then(r => r.json()).then(d => d.missions || d.active || (Array.isArray(d) ? d : [])).catch(() => []),
      apiFetch('/api/missions/recent', { headers: { 'Content-Type': 'application/json' } }).then(r => r.json()).then(d => d.recent || d.missions || (Array.isArray(d) ? d : [])).catch(() => []),
    ]).then(([a, r]) => {
      const norm = (m: Record<string, unknown>): MissionRef => ({ goalId: (m.goalId || m.id) as string, title: (m.title as string) || '(workflow)', phase: m.phase as string });
      const all = [...(a as Record<string, unknown>[]).map(norm), ...(r as Record<string, unknown>[]).map(norm)];
      const seen = new Set<string>();
      setMissions(all.filter(m => m.goalId && !seen.has(m.goalId) && seen.add(m.goalId)));
    });
  };
  useEffect(loadMissions, []);

  useEffect(() => {
    if (!selected) { setSubtasks([]); return; }
    apiFetch(`/api/mission/${selected}`, { headers: { 'Content-Type': 'application/json' } })
      .then(r => r.json())
      .then(d => { setSubtasks(d.goal?.subtasks || []); setCurrentId(d.driver?.currentSubtaskId || null); })
      .catch(() => setSubtasks([]));
  }, [selected]);

  const { pos, width, height } = useMemo(() => layout(subtasks), [subtasks]);
  const byId = useMemo(() => new Map(subtasks.map(s => [s.id, s])), [subtasks]);

  const create = async () => {
    if (!prompt.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch('/api/mission/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }).then(r => r.json());
      setPrompt('');
      loadMissions();
      const id = res.goalId || res.id;
      if (id) setSelected(id);
    } finally { setCreating(false); }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Workflow Builder" breadcrumbs={[{label:'Admin', href:'/overview'}, {label:'Missions'}, {label:'Workflow Builder'}]} />

      <div className="flex items-center gap-2">
        <Workflow size={18} className="text-[var(--text-secondary)]" />
        <span className="text-sm text-[var(--text-secondary)]">Visualize + author workflows as a goal/subtask DAG</span>
        <button onClick={loadMissions} className="ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text)]">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Create from plain English */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3 flex gap-2">
        <input
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') create(); }}
          placeholder="Describe a workflow in plain English (e.g. 'research X, draft a summary, then post it')"
          className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none"
        />
        <button onClick={create} disabled={creating || !prompt.trim()}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30 disabled:opacity-50">
          <Play size={12} /> {creating ? 'Decomposing…' : 'Build'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Mission list */}
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-2 space-y-1 max-h-[60vh] overflow-auto">
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] px-2 py-1">Workflows</p>
          {missions.length === 0 && <p className="text-xs text-[var(--text-muted)] px-2">None yet — build one above.</p>}
          {missions.map(m => (
            <button key={m.goalId} onClick={() => setSelected(m.goalId)}
              className={`w-full text-left text-xs px-2 py-1.5 rounded ${selected === m.goalId ? 'bg-blue-500/15 text-blue-300' : 'text-[var(--text-secondary)] hover:bg-[var(--bg)]'}`}>
              <span className="truncate block">{m.title}</span>
              {m.phase && <span className="text-[10px] text-[var(--text-muted)]">{m.phase}</span>}
            </button>
          ))}
        </div>

        {/* DAG canvas */}
        <div className="md:col-span-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-2 overflow-auto max-h-[60vh]">
          {subtasks.length === 0 ? (
            <div className="text-[var(--text-muted)] text-sm p-6 text-center">Select a workflow to view its DAG, or build one from a prompt.</div>
          ) : (
            <svg width={width} height={height} className="min-w-full">
              {/* edges */}
              {subtasks.flatMap(s => (s.dependsOn || []).filter(d => byId.has(d)).map(d => {
                const from = pos.get(d)!, to = pos.get(s.id)!;
                return <line key={`${d}->${s.id}`} x1={from.x + NODE_W} y1={from.y + NODE_H / 2} x2={to.x} y2={to.y + NODE_H / 2}
                  stroke="var(--border)" strokeWidth={1.5} markerEnd="url(#arrow)" />;
              }))}
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--text-muted)" />
                </marker>
              </defs>
              {/* nodes */}
              {subtasks.map(s => {
                const p = pos.get(s.id)!;
                const fill = STATUS_FILL[s.status] || '#64748b';
                const isCurrent = s.id === currentId;
                return (
                  <g key={s.id} transform={`translate(${p.x},${p.y})`} onClick={() => setDetail(s)} style={{ cursor: 'pointer' }}>
                    <rect width={NODE_W} height={NODE_H} rx={8} fill="var(--bg)" stroke={isCurrent ? '#3b82f6' : 'var(--border)'} strokeWidth={isCurrent ? 2 : 1} />
                    <rect width={4} height={NODE_H} rx={2} fill={fill} />
                    <text x={12} y={22} fill="var(--text)" fontSize={11} fontWeight={600}>{s.title.slice(0, 26)}</text>
                    <text x={12} y={40} fill="var(--text-muted)" fontSize={9}>{s.status}{isCurrent ? ' • running' : ''}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>

      {/* Node detail */}
      {detail && (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4" onClick={() => setDetail(null)}>
          <p className="text-sm font-semibold text-[var(--text)]">{detail.title}</p>
          <p className="text-xs text-[var(--text-muted)]">status: {detail.status} · depends on: {detail.dependsOn.length ? detail.dependsOn.join(', ') : '—'}</p>
          {detail.description && <p className="text-xs text-[var(--text-secondary)] mt-1">{detail.description}</p>}
        </div>
      )}
    </div>
  );
}

export default WorkflowBuilderPanel;
