import { useState, useCallback } from 'react';
import { getLiveKitToken, apiFetch } from '@/api/client';
import type { LiveKitTokenResponse } from '@/api/types';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export function useLiveKit() {
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [tokenData, setTokenData] = useState<LiveKitTokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setState('connecting');
    setError(null);
    try {
      // Pre-check voice services before connecting
      const healthRes = await apiFetch('/api/voice/health');
      if (healthRes.ok) {
        const health = await healthRes.json();
        if (!health.overall) {
          const down = Object.entries(health)
            .filter(([k, v]) => k !== 'overall' && !v)
            .map(([k]) => k);
          throw new Error(`Voice services unavailable: ${down.join(', ')}`);
        }
      }
      const data = await getLiveKitToken();
      setTokenData(data);
      setState('connected');
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to connect';
      setError(msg);
      setState('error');
      return null;
    }
  }, []);

  const disconnect = useCallback(() => {
    setTokenData(null);
    setState('disconnected');
    setError(null);
  }, []);

  return { state, tokenData, error, connect, disconnect };
}
