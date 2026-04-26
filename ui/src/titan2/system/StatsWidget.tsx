import React, { useEffect, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, Activity } from 'lucide-react';

interface SystemStats {
  cpu: number;
  memory: number;
  disk: number;
  load: number;
}

function StatBar({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[10px] text-[#52525b] uppercase tracking-wider">{label}</span>
        </div>
        <span className="text-[11px] text-[#a1a1aa] font-mono">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-[#27272a] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

export function StatsWidget() {
  const [stats, setStats] = useState<SystemStats>({ cpu: 0, memory: 0, disk: 0, load: 0 });

  useEffect(() => {
    const interval = setInterval(() => {
      setStats({
        cpu: Math.random() * 60 + 10,
        memory: Math.random() * 50 + 30,
        disk: Math.random() * 40 + 20,
        load: Math.random() * 30 + 5,
      });
    }, 3000);
    // Seed initial
    setStats({
      cpu: Math.random() * 60 + 10,
      memory: Math.random() * 50 + 30,
      disk: Math.random() * 40 + 20,
      load: Math.random() * 30 + 5,
    });
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-full h-full p-3 overflow-auto">
      <div className="space-y-2">
        <StatBar label="CPU" value={stats.cpu} icon={<Cpu className="w-3 h-3 text-[#6366f1]" />} color="#6366f1" />
        <StatBar label="Memory" value={stats.memory} icon={<MemoryStick className="w-3 h-3 text-[#a78bfa]" />} color="#a78bfa" />
        <StatBar label="Disk" value={stats.disk} icon={<HardDrive className="w-3 h-3 text-[#10b981]" />} color="#10b981" />
        <StatBar label="Load" value={stats.load} icon={<Activity className="w-3 h-3 text-[#f59e0b]" />} color="#f59e0b" />
      </div>
    </div>
  );
}
