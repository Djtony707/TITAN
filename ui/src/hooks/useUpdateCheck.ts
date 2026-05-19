import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/api/client';

export type UpdateMode = 'dev-git' | 'systemd' | 'npm-global';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  isNewer: boolean;
  /** Detected deployment shape — drives the right post-restart copy in the UI. */
  mode?: UpdateMode;
}

/**
 * POST /api/update response. `ok` is the only field guaranteed across versions;
 * `willRestart` and `expectedDownMs` arrive from the patched router in
 * src/gateway/routes/update.ts.
 */
export interface UpdateActionResult {
  ok: boolean;
  mode?: UpdateMode;
  willRestart?: boolean;
  expectedDownMs?: number;
  message?: string;
  output?: string;
  error?: string;
}

export function useUpdateCheck(intervalMs = 300_000): {
  info: UpdateInfo | null;
  checking: boolean;
  triggerUpdate: (restart?: boolean) => Promise<UpdateActionResult>;
  /**
   * Poll GET /api/update until the reported `current` differs from the
   * version we saw before the restart. Resolves with the new version on
   * success, or `null` if it times out (server didn't come back, or came
   * back on the same version — both worth surfacing to the user).
   */
  waitForReload: (previousVersion: string, timeoutMs?: number) => Promise<string | null>;
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

  const triggerUpdate = useCallback(async (restart = true): Promise<UpdateActionResult> => {
    try {
      const res = await apiFetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restart }),
      });
      const data = await res.json();
      return data as UpdateActionResult;
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, []);

  // Poll GET /api/update on a short interval until the version changes (= new
  // process is up) or we time out. Errors are expected during the restart
  // gap — we keep polling. Keeping this in the hook (rather than the
  // components) means both StatusBar and TitanCanvas get the same behavior.
  const waitForReload = useCallback(async (previousVersion: string, timeoutMs = 30_000): Promise<string | null> => {
    const start = Date.now();
    const pollIntervalMs = 1500;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      try {
        const res = await apiFetch('/api/update');
        if (res.ok) {
          const data = (await res.json()) as UpdateInfo;
          if (data.current && data.current !== previousVersion) {
            setInfo(data);
            return data.current;
          }
        }
      } catch {
        // Server is down mid-restart — expected, keep polling
      }
    }
    return null;
  }, []);

  return { info, checking, triggerUpdate, waitForReload };
}
