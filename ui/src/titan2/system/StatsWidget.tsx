import React, { useEffect, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, Activity } from 'lucide-react';
import { apiFetch } from '@/api/client';

interface SystemStats {
  cpu: number;
  memory: number;
  disk: number;
  load: number;
  loaded: boolean;
  error: string | null;
  diskAvailable: boolean;
}

function StatBar({ label, value, icon, color, unknown }: { label: string; value: number; icon: React.ReactNode; color: string; unknown?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[10px] text-[#52525b] uppercase tracking-wider">{label}</span>
        </div>
        <span className="text-[11px] text-[#a1a1aa] font-mono">{unknown ? '—' : `${pct}%`}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[#27272a] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: unknown ? '0%' : `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

export function StatsWidget() {
  const [stats, setStats] = useState<SystemStats>({
    cpu: 0, memory: 0, disk: 0, load: 0,
    loaded: false, error: null, diskAvailable: true,
  });

  useEffect(() => {
    let cancelled = false;

    // v6.1.0-beta.23 — wired to real /api/stats. The previous implementation
    // generated CPU/Memory/Disk/Load with Math.random() every 3 seconds —
    // Tony's mock-data audit (2026-05-17) flagged it as a top offender.
    // Now reads the `host` block the gateway returns with real
    // cpu/load/mem/disk percentages from os.loadavg, totalmem/freemem,
    // and fs.statfs. While loading, every bar shows "—" instead of a
    // fabricated number; on error, the bars stay at 0 and a tiny error
    // line surfaces what went wrong.
    async function load() {
      try {
        const r = await apiFetch('/api/stats');
        if (!r.ok) {
          const msg = `HTTP ${r.status}`;
          if (!cancelled) setStats(s => ({ ...s, loaded: true, error: msg }));
          return;
        }
        const data = await r.json();
        if (cancelled) return;
        const host = data.host as
          | { cpuPercent?: number; memPercent?: number; diskPercent?: number; loadAvg1?: number; cores?: number; diskError?: string | null }
          | undefined;
        if (!host) {
          setStats(s => ({ ...s, loaded: true, error: 'no host metrics' }));
          return;
        }
        const cpu = typeof host.cpuPercent === 'number' ? host.cpuPercent : 0;
        const memory = typeof host.memPercent === 'number' ? host.memPercent : 0;
        const disk = typeof host.diskPercent === 'number' ? host.diskPercent : 0;
        // Load: 1-min load average normalised to a per-core percentage.
        const cores = host.cores || 1;
        const loadPct = typeof host.loadAvg1 === 'number'
          ? Math.min(100, (host.loadAvg1 / cores) * 100)
          : 0;
        setStats({
          cpu, memory, disk, load: loadPct,
          loaded: true,
          error: null,
          diskAvailable: !host.diskError,
        });
      } catch (err) {
        if (!cancelled) setStats(s => ({ ...s, loaded: true, error: (err as Error).message }));
      }
    }

    load();
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const unknown = !stats.loaded || !!stats.error;

  return (
    <div className="w-full h-full p-3 overflow-auto">
      <div className="space-y-2">
        <StatBar label="CPU" value={stats.cpu} icon={<Cpu className="w-3 h-3 text-[#6366f1]" />} color="#6366f1" unknown={unknown} />
        <StatBar label="Memory" value={stats.memory} icon={<MemoryStick className="w-3 h-3 text-[#a78bfa]" />} color="#a78bfa" unknown={unknown} />
        <StatBar label="Disk" value={stats.disk} icon={<HardDrive className="w-3 h-3 text-[#10b981]" />} color="#10b981" unknown={unknown || !stats.diskAvailable} />
        <StatBar label="Load" value={stats.load} icon={<Activity className="w-3 h-3 text-[#f59e0b]" />} color="#f59e0b" unknown={unknown} />
      </div>
      {stats.error && (
        <div className="mt-2 text-[10px] text-[#ef4444]/80">
          {stats.error}
        </div>
      )}
    </div>
  );
}
