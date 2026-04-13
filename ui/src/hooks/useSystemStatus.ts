import { useState, useEffect } from 'react';
import { apiFetch } from '@/api/client';

interface SystemStatus {
  version: string;
  uptime: number;
  model: string;
  connected: boolean;
  memoryMB: number;
  agents: number;
}

export function useSystemStatus(intervalMs = 10000): SystemStatus {
  const [status, setStatus] = useState<SystemStatus>({
    version: '',
    uptime: 0,
    model: '',
    connected: false,
    memoryMB: 0,
    agents: 0,
  });

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await apiFetch('/api/stats');
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (active) {
          setStatus({
            version: data.version || '',
            uptime: data.uptime || 0,
            model: data.model || '',
            connected: true,
            memoryMB: data.memoryMB || 0,
            agents: data.health?.activeLlmRequests || 0,
          });
        }
      } catch {
        if (active) setStatus(prev => ({ ...prev, connected: false }));
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => { active = false; clearInterval(id); };
  }, [intervalMs]);

  return status;
}
