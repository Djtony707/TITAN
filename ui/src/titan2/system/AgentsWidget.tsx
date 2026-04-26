import React, { useEffect, useState } from 'react';
import { Bot, Loader2, AlertCircle } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  role: string;
  status: 'idle' | 'busy' | 'error';
  model?: string;
}

export function AgentsWidget() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = async () => {
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : data.agents || []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <Loader2 className="w-4 h-4 text-[#6366f1] animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center p-4">
        <div className="text-center">
          <AlertCircle className="w-4 h-4 text-red-400 mx-auto mb-1" />
          <span className="text-[10px] text-red-400">{error}</span>
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center p-4">
        <span className="text-[10px] text-[#52525b]">No active agents</span>
      </div>
    );
  }

  return (
    <div className="w-full h-full p-3 overflow-auto">
      <div className="space-y-2">
        {agents.map(agent => (
          <div key={agent.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[#0a0a0f] border border-[#27272a]">
            <Bot className={`w-3.5 h-3.5 ${
              agent.status === 'busy' ? 'text-[#f59e0b]' :
              agent.status === 'error' ? 'text-red-400' :
              'text-[#6366f1]'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-[#a1a1aa] truncate">{agent.name}</div>
              <div className="text-[10px] text-[#52525b] truncate">{agent.role}{agent.model ? ` · ${agent.model}` : ''}</div>
            </div>
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase ${
              agent.status === 'busy' ? 'bg-[#f59e0b]/10 text-[#f59e0b]' :
              agent.status === 'error' ? 'bg-red-400/10 text-red-400' :
              'bg-[#6366f1]/10 text-[#818cf8]'
            }`}>
              {agent.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
