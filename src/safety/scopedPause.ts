/**
 * TITAN — Scoped Pause (per-target, self-expiring)
 *
 * Paperclip-inspired pattern (`server/src/services/budgets.ts:pauseScopeForBudget`).
 * The point is to replace the fleet-wide kill-switch-for-everything response
 * with a TARGETED "don't touch this thing for N minutes" marker.
 *
 * Before this module, every trigger that wasn't a genuine emergency (canary
 * regression, identity violation, sustained safety pressure) still paused
 * autopilot, paused every goal, paused every specialist, and required a human
 * POST /api/safety/resume to unstick. Fix-oscillation on a scratch directory
 * would take down the whole system for hours.
 *
 * After: non-emergency triggers (like repeat writes to a production file)
 * pause ONLY that target for a bounded cooldown. Writes to that target get
 * blocked; everything else keeps running. The cooldown auto-expires — no
 * human resume needed for scoped pauses.
 *
 * The full kill switch stays as the last-resort response for the THREE
 * genuine emergencies:
 *   - identity_violation
 *   - safety_pressure > threshold sustained 10m
 *   - canary_degradation > 30%
 *   - manual
 *
 * Scoped pauses also get a probe cycle: after the cooldown expires the
 * tracker auto-clears; if the condition recurs we'll just pause again.
 */
import logger from '../utils/logger.js';
import { titanEvents } from '../agent/daemon.js';

const COMPONENT = 'ScopedPause';

export type ScopedPauseReason =
    | 'fix_oscillation'
    | 'tool_failure_streak'
    | 'rate_limit_proximity'
    | 'manual';

export interface ScopedPauseEntry {
    target: string;
    reason: ScopedPauseReason;
    until: number;                 // epoch ms when pause expires
    createdAt: number;
    note?: string;
}

const pauses = new Map<string, ScopedPauseEntry>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// Default cooldowns per reason. Can be overridden by caller.
const DEFAULT_COOLDOWN_MS: Record<ScopedPauseReason, number> = {
    fix_oscillation: 15 * 60 * 1000,        // 15 min
    tool_failure_streak: 10 * 60 * 1000,    // 10 min
    rate_limit_proximity: 5 * 60 * 1000,    // 5 min
    manual: 30 * 60 * 1000,                 // 30 min
};

/**
 * Pause a target for cooldown. Auto-expires; no human resume required.
 * If the target is already paused, extend the cooldown to whichever is
 * later — never accidentally shorten a pause.
 */
export function pauseTarget(
    target: string,
    reason: ScopedPauseReason,
    opts?: { cooldownMs?: number; note?: string },
): ScopedPauseEntry {
    const cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS[reason];
    const newUntil = Date.now() + cooldownMs;
    const existing = pauses.get(target);
    const until = existing ? Math.max(existing.until, newUntil) : newUntil;

    const entry: ScopedPauseEntry = {
        target,
        reason,
        until,
        createdAt: existing?.createdAt ?? Date.now(),
        note: opts?.note ?? existing?.note,
    };
    pauses.set(target, entry);

    // Schedule auto-expire
    const prevTimer = timers.get(target);
    if (prevTimer) clearTimeout(prevTimer);
    const delay = Math.max(1, until - Date.now());
    const t = setTimeout(() => {
        const current = pauses.get(target);
        if (current && Date.now() >= current.until) {
            pauses.delete(target);
            timers.delete(target);
            logger.info(COMPONENT, `Target "${target.slice(0, 80)}" unpaused (cooldown expired)`);
            try { titanEvents.emit('safety:scoped-unpause', { target, reason: current.reason }); } catch { /* ok */ }
        }
    }, delay);
    t.unref?.();
    timers.set(target, t);

    const cooldownMin = Math.round(cooldownMs / 60000 * 10) / 10;
    logger.warn(COMPONENT, `Target "${target.slice(0, 80)}" paused for ${cooldownMin}m (reason: ${reason}${opts?.note ? `: ${opts.note}` : ''})`);
    try { titanEvents.emit('safety:scoped-pause', entry); } catch { /* ok */ }
    return entry;
}

/** Is the given target currently paused? */
export function isTargetPaused(target: string): boolean {
    const entry = pauses.get(target);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
        // Lazy cleanup if the timer hadn't fired yet
        pauses.delete(target);
        const t = timers.get(target);
        if (t) { clearTimeout(t); timers.delete(target); }
        return false;
    }
    return true;
}

/** Check multiple candidate paths; returns the first match or null. */
export function findPausedPrefix(path: string): ScopedPauseEntry | null {
    for (const [target, entry] of pauses) {
        if (Date.now() >= entry.until) continue;
        if (path === target || path.startsWith(target + '/') || target === path) {
            return entry;
        }
    }
    return null;
}

/** Manually lift a pause early. */
export function resumeTarget(target: string, resumedBy: string, note?: string): boolean {
    const existing = pauses.get(target);
    if (!existing) return false;
    pauses.delete(target);
    const t = timers.get(target);
    if (t) { clearTimeout(t); timers.delete(target); }
    logger.info(COMPONENT, `Target "${target.slice(0, 80)}" manually resumed by ${resumedBy}${note ? `: ${note}` : ''}`);
    try { titanEvents.emit('safety:scoped-resume', { target, reason: existing.reason, resumedBy, note }); } catch { /* ok */ }
    return true;
}

/** List currently active pauses (expired entries auto-pruned). */
export function listActivePauses(): ScopedPauseEntry[] {
    const now = Date.now();
    const out: ScopedPauseEntry[] = [];
    for (const [target, entry] of pauses) {
        if (now < entry.until) out.push(entry);
        else { pauses.delete(target); const t = timers.get(target); if (t) { clearTimeout(t); timers.delete(target); } }
    }
    return out;
}

/** Test helper. */
export function __resetScopedPausesForTests(): void {
    for (const t of timers.values()) clearTimeout(t);
    pauses.clear();
    timers.clear();
}

/**
 * Probe-on-recovery harness. Called by full-kill triggers (not scoped pauses
 * — those auto-expire already). Schedules a probe N minutes after the trigger
 * fires; the probe function checks whether the underlying condition is still
 * present. If clear → auto re-arm via resumeFn. If still present → schedule
 * the next probe at 2× the interval (exponential back-off, capped).
 *
 * Currently opt-in — killSwitch Changes 3+4 wire this in for
 * safety_pressure / canary_degradation / fix_oscillation triggers.
 */
export interface ProbeHandle {
    /** Cancel a scheduled probe (e.g. if the user resumes manually first). */
    cancel: () => void;
}

export function scheduleRecoveryProbe(opts: {
    triggerId: string;                        // stable ID for logs
    initialDelayMs: number;                   // when to first probe
    maxDelayMs?: number;                      // cap on exponential growth (default 4h)
    isClear: () => boolean | Promise<boolean>;// true when condition no longer holds
    onClear: () => void | Promise<void>;      // called when probe says "clear"
}): ProbeHandle {
    const maxDelayMs = opts.maxDelayMs ?? 4 * 60 * 60 * 1000;
    let delay = opts.initialDelayMs;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
        if (cancelled) return;
        try {
            const clear = await opts.isClear();
            if (clear) {
                logger.info(COMPONENT, `[${opts.triggerId}] probe-on-recovery: condition clear — auto-resuming`);
                try { await opts.onClear(); } catch (err) { logger.warn(COMPONENT, `[${opts.triggerId}] onClear threw: ${(err as Error).message}`); }
                return;
            }
        } catch (err) {
            logger.warn(COMPONENT, `[${opts.triggerId}] probe isClear() threw: ${(err as Error).message} — rescheduling`);
        }
        delay = Math.min(delay * 2, maxDelayMs);
        logger.debug(COMPONENT, `[${opts.triggerId}] probe — still present, next probe in ${Math.round(delay / 60000)}m`);
        timer = setTimeout(tick, delay);
        timer.unref?.();
    };

    timer = setTimeout(tick, opts.initialDelayMs);
    timer.unref?.();
    logger.debug(COMPONENT, `[${opts.triggerId}] probe scheduled in ${Math.round(opts.initialDelayMs / 60000)}m`);

    return {
        cancel: () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        },
    };
}
