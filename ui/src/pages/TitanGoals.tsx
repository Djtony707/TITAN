import { useState } from 'react';
import { Target, Plus, TrendingUp, CheckCircle2, Circle, Clock, Zap } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════
   TITAN Goals — Space Agent-style goal tracking
   ═══════════════════════════════════════════════════════════════════ */

type GoalStatus = 'active' | 'completed' | 'at_risk';

interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  progress: number;
  target: number;
  current: number;
  unit: string;
  deadline?: string;
}

export function TitanGoals() {
  const [goals] = useState<Goal[]>([
    {
      id: '1', title: 'Deploy TITAN Canvas to production',
      description: 'Complete the Canvas widget system and deploy to all users',
      status: 'active', progress: 75, target: 100, current: 75, unit: '%',
      deadline: '2026-05-01',
    },
    {
      id: '2', title: 'Integrate 5 new LLM providers',
      description: 'Add support for Gemini, Claude, Grok, Mistral, and Cohere',
      status: 'active', progress: 40, target: 5, current: 2, unit: 'providers',
    },
    {
      id: '3', title: 'Achieve 99.9% uptime',
      description: 'Infrastructure reliability target for Q2',
      status: 'at_risk', progress: 85, target: 99.9, current: 98.5, unit: '%',
    },
    {
      id: '4', title: 'Onboard 1000 new users',
      description: 'Growth target for the quarter',
      status: 'completed', progress: 100, target: 1000, current: 1247, unit: 'users',
    },
  ]);

  const active = goals.filter(g => g.status === 'active');
  const completed = goals.filter(g => g.status === 'completed');
  const atRisk = goals.filter(g => g.status === 'at_risk');

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-[#fafafa]">Goals</h1>
          <p className="text-xs text-[#52525b]">{goals.length} goals · {active.length} active</p>
        </div>
        <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] text-xs font-medium hover:bg-[#6366f1]/20 transition-colors">
          <Plus className="w-3.5 h-3.5" />
          New Goal
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <SummaryCard label="Active" value={active.length} icon={Zap} color="#6366f1" />
        <SummaryCard label="Completed" value={completed.length} icon={CheckCircle2} color="#22c55e" />
        <SummaryCard label="At Risk" value={atRisk.length} icon={TrendingUp} color="#ef4444" />
      </div>

      {/* Goals */}
      <div className="space-y-3">
        {goals.map(goal => (
          <GoalCard key={goal.id} goal={goal} />
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon, color }: {
  label: string; value: number; icon: React.ElementType; color: string;
}) {
  return (
    <div className="rounded-xl bg-[#18181b]/80 border border-[#27272a]/60 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4" style={{ color }} />
        <span className="text-[10px] text-[#52525b] uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-2xl font-bold text-[#fafafa]">{value}</span>
    </div>
  );
}

function GoalCard({ goal }: { goal: Goal }) {
  const statusConfig = {
    active: { border: 'border-[#6366f1]/20', badge: 'bg-[#6366f1]/10 text-[#6366f1]' },
    completed: { border: 'border-[#22c55e]/20', badge: 'bg-[#22c55e]/10 text-[#22c55e]' },
    at_risk: { border: 'border-[#ef4444]/20', badge: 'bg-[#ef4444]/10 text-[#ef4444]' },
  };
  const s = statusConfig[goal.status];

  return (
    <div className={`rounded-xl bg-[#18181b]/80 border ${s.border} p-4`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-[#a855f7]" />
          <h3 className="text-sm font-semibold text-[#fafafa]">{goal.title}</h3>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${s.badge}`}>
          {goal.status.replace('_', ' ')}
        </span>
      </div>

      <p className="text-[11px] text-[#52525b] mb-3">{goal.description}</p>

      {/* Progress */}
      <div className="mb-2">
        <div className="flex items-center justify-between text-[10px] mb-1">
          <span className="text-[#a1a1aa]">{goal.current} / {goal.target} {goal.unit}</span>
          <span className="text-[#fafafa] font-medium">{goal.progress}%</span>
        </div>
        <div className="w-full bg-[#27272a] rounded-full h-2">
          <div
            className="h-2 rounded-full bg-[#6366f1] transition-all"
            style={{ width: `${goal.progress}%` }}
          />
        </div>
      </div>

      {goal.deadline && (
        <div className="flex items-center gap-1 text-[9px] text-[#52525b]">
          <Clock className="w-3 h-3" />
          Due {goal.deadline}
        </div>
      )}
    </div>
  );
}
