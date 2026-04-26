import React, { useEffect, useState } from 'react';
import { Activity, Wifi, WifiOff, Loader2 } from 'lucide-react';

interface HealthState {
  gateway: boolean;
  ollama: boolean;
  version: string;
  uptime: number;
}

export function HealthWidget() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [loading, setLoading] = useState(true);

  const checkHealth = async () => {
    try {
      const [gatewayRes, ollamaRes] = await Promise.allSettled([
        fetch('/api/health').then(r => r.ok ? r.json() : null),
        fetch('/ollama/api/tags').then(r => r.ok),
      ]);
      const gateway = gatewayRes.status === 'fulfilled' && gatewayRes.value;
      const ollama = ollamaRes.status === 'fulfilled' && ollamaRes.value;
      setHealth({
        gateway,
        ollama,
        version: gateway?.version || 'unknown',
        uptime: gateway?.uptime || 0,
      });
    } catch {
      setHealth({ gateway: false, ollama: false, version: 'unknown', uptime: 0 });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <Loader2 className="w-4 h-4 text-[#6366f1] animate-spin" />
      </div>
    );
  }

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div className="w-full h-full p-3 overflow-auto">
      <div className="space-y-3">
        {/* Gateway */}
        <div className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
          <div className="flex items-center gap-2">
            {health?.gateway ? <Wifi className="w-3.5 h-3.5 text-emerald-400" /> : <WifiOff className="w-3.5 h-3.5 text-red-400" />}
            <span className="text-[11px] text-[#a1a1aa]">TITAN Gateway</span>
          </div>
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase ${health?.gateway ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'}`}>
            {health?.gateway ? 'Online' : 'Offline'}
          </span>
        </div>

        {/* Ollama */}
        <div className="flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
          <div className="flex items-center gap-2">
            <Activity className={`w-3.5 h-3.5 ${health?.ollama ? 'text-emerald-400' : 'text-red-400'}`} />
            <span className="text-[11px] text-[#a1a1aa]">Ollama</span>
          </div>
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase ${health?.ollama ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'}`}>
            {health?.ollama ? 'Online' : 'Offline'}
          </span>
        </div>

        {/* Version + Uptime */}
        <div className="grid grid-cols-2 gap-2">
          <div className="px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-[9px] text-[#52525b] uppercase tracking-wider">Version</div>
            <div className="text-[11px] text-[#a1a1aa] font-mono mt-0.5">{health?.version}</div>
          </div>
          <div className="px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <div className="text-[9px] text-[#52525b] uppercase tracking-wider">Uptime</div>
            <div className="text-[11px] text-[#a1a1aa] font-mono mt-0.5">{formatUptime(health?.uptime || 0)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
