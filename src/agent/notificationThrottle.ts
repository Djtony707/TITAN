/**
 * TITAN — Notification Throttle (v4.10.0-local, Phase B)
 *
 * Rate-limits:
 *   - SSE broadcasts for the same (topic, goalId) to 1 per 60s
 *   - Approval creation for the same (goalId, kind) to 1 per 5 min
 *
 * Without this, a looping driver that hits a verifier failure on every
 * retry would create 5+ approvals for the same goal in 30 seconds and
 * spam the approval queue. We keep one per (goalId, kind) within the
 * window and coalesce the rest.
 *
 * In-memory only — bucket resets on restart. That's fine for throttling.
 */

const broadcastBuckets = new Map<string, number>();      // key → lastBroadcastMs
const approvalBuckets = new Map<string, number>();       // key → lastCreateMs

const BROADCAST_WINDOW_MS = 60 * 1000;                   // 1 min
const APPROVAL_WINDOW_MS = 5 * 60 * 1000;                // 5 min

/**
 * Returns true if this (topic, key) should be broadcast NOW, false if it
 * should be throttled. Caller broadcasts only when true.
 */
export function shouldBroadcast(topic: string, key: string = 'default'): boolean {
    const bucket = `${topic}:${key}`;
    const last = broadcastBuckets.get(bucket) ?? 0;
    const now = Date.now();
    if (now - last < BROADCAST_WINDOW_MS) return false;
    broadcastBuckets.set(bucket, now);
    return true;
}

/**
 * Returns true if a new approval for this (goalId, kind) should be created
 * now. False if an approval was already created for the same pair within
 * the throttle window.
 */
export function shouldCreateApproval(goalId: string, kind: string): boolean {
    const bucket = `${goalId}:${kind}`;
    const last = approvalBuckets.get(bucket) ?? 0;
    const now = Date.now();
    if (now - last < APPROVAL_WINDOW_MS) return false;
    approvalBuckets.set(bucket, now);
    return true;
}

/** Test-only — clear both buckets. */
export function _resetThrottlesForTests(): void {
    broadcastBuckets.clear();
    approvalBuckets.clear();
}

/** Diagnostic snapshot. */
export function getThrottleStats(): {
    broadcastBuckets: number;
    approvalBuckets: number;
} {
    return {
        broadcastBuckets: broadcastBuckets.size,
        approvalBuckets: approvalBuckets.size,
    };
}
