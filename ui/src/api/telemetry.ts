import { apiFetch } from './client';

/**
 * Fire-and-forget telemetry event tracker.
 * The backend silently drops events if telemetry.enabled === false.
 */
export function trackEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  apiFetch('/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event,
      properties,
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {
    // Telemetry is best-effort; never block the UI
  });
}
