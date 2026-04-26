import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/api/client';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  isNewer: boolean;
}

export function useUpdateCheck(intervalMs = 300_000): {
  info: UpdateInfo | null;
  checking: boolean;
  triggerUpdate: (restart?: boolean) => Promise<{ ok: boolean; message?: string; error?: string }>;
} {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await apiFetch('/api/update');
      if (res.ok) {
        const data = await res.json();
        setInfo(data as UpdateInfo);
      }
    } catch {
      // Silent fail — update checks are non-critical
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, intervalMs);
    return () => clearInterval(id);
  }, [check, intervalMs]);

  const triggerUpdate = useCallback(async (restart = true) => {
    try {
      const res = await apiFetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restart }),
      });
      const data = await res.json();
      return data as { ok: boolean; message?: string; error?: string };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, []);

  return { info, checking, triggerUpdate };
}
