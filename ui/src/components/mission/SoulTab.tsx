import { useState, useEffect } from 'react';
import { getSoulWisdom } from '../../api/client';
import type { SoulWisdom } from '../../api/types';
import { Sparkles, TrendingUp, AlertCircle, Brain } from 'lucide-react';
import clsx from 'clsx';

export default function SoulTab() {
  const [wisdom, setWisdom] = useState<SoulWisdom | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await getSoulWisdom();
        if (active) setWisdom(data);
      } catch { /* non-critical */ }
      if (active) setLoading(false);
    };
    load();
    const id = setInterval(load, 15000);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (loading) {
    return <div className="space-y-3">{[1, 2, 3].map(i => <div key={i} className="h-16 rounded-lg skeleton-shimmer" />)}</div>;
  }

  if (!wisdom || wisdom.totalTasks === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-text-muted text-xs">
        <Sparkles size={20} className="mb-2 opacity-40" />
        No soul wisdom yet
        <p className="text-[10px] mt-1">TITAN learns from every task</p>
      </div>
    );
  }

  const confidenceColor = wisdom.avgConfidence >= 0.7 ? 'text-success' : wisdom.avgConfidence >= 0.4 ? 'text-warning' : 'text-error';

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-2">
        <div className="p-2.5 rounded-lg bg-bg-tertiary/30 border border-border/50">
          <p className="text-[10px] text-text-muted uppercase tracking-wider">Tasks</p>
          <p className="text-lg font-semibold text-text">{wisdom.totalTasks}</p>
        </div>
        <div className="p-2.5 rounded-lg bg-bg-tertiary/30 border border-border/50">
          <p className="text-[10px] text-text-muted uppercase tracking-wider">Confidence</p>
          <p className={clsx('text-lg font-semibold', confidenceColor)}>
            {Math.round(wisdom.avgConfidence * 100)}%
          </p>
        </div>
      </div>

      {/* Learned patterns */}
      {wisdom.patterns.length > 0 && (
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
            <TrendingUp size={12} /> Learned Patterns
          </h4>
          <div className="space-y-1">
            {wisdom.patterns.slice(0, 8).map((p, i) => (
              <div key={i} className="flex items-center justify-between px-2 py-1.5 rounded bg-bg-secondary/30 text-[11px]">
                <span className="text-text-secondary">{p.taskType}</span>
                <div className="flex items-center gap-2 text-text-muted">
                  <span className="font-mono">{p.bestStrategy}</span>
                  <span className={p.successRate >= 0.7 ? 'text-success' : 'text-warning'}>
                    {Math.round(p.successRate * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mistakes to avoid */}
      {wisdom.mistakes.length > 0 && (
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-2">
            <AlertCircle size={12} /> Learned Mistakes
          </h4>
          <div className="space-y-1">
            {wisdom.mistakes.slice(-5).map((m, i) => (
              <div key={i} className="px-2 py-1.5 rounded bg-bg-secondary/30 text-[11px] text-text-muted">
                {m.description.slice(0, 80)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
