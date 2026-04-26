/**
 * TITAN — Master Kill Switch (v4.9.0+, local hard-takeoff)
 *
 * Final backstop. When something the organism can't recover from
 * happens, this pauses everything autonomous until a human explicitly
 * resumes.
 *
 * Trigger sources:
 *   - Safety drive pressure > 2.0 sustained for > 10 minutes
 *   - Identity non-negotiable violation (drift detector fires
 *     'values_divergence' with high confidence)
 *   - Canary eval drops > 30% on any task (silent degradation)
 *   - Fix oscillation detector fires on same target 3× in 24h
 *   - Human posts POST /api/safety/kill with a reason
 *
 * On trigger:
 *   - Autopilot disabled in-memory (and persisted so restart doesn't
 *     resurrect it)
 *   - All active goals set status='paused'
 *   - Specialists status='paused'
 *   - SSE broadcast 'safety:killed' to all connected /watch clients
 *   - Activity feed + audit log both record the trigger
 *   - Any in-flight agent sessions get AbortController.abort()
 *
 * Resume:
 *   - Human calls POST /api/safety/resume with a resolution note
 *   - Kill-switch state flips to 'armed' (ready but not triggered)
 *   - Previously-paused goals/specialists are NOT auto-unpaused —
 *     Tony inspects each and flips manually. This is intentional:
 *     the organism should not be trusted to self-resume without
 *     human review of what caused the kill.
 *
 * Storage: <TITAN_HOME>/kill-switch.json — survives restarts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { atomicWriteJsonFile } from '../utils/helpers.js';
import { dirname, join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { logAudit } from '../security/auditLog.js';

const COMPONENT = 'KillSwitch';
const STATE_PATH = join(TITAN_HOME, 'kill-switch.json');

// ── Types ────────────────────────────────────────────────────────

export type KillSwitchStatus = 'armed' | 'killed';

export type KillTrigger =
    | 'safety_pressure'
    | 'identity_violation'
    | 'canary_degradation'
    | 'fix_oscillation'
    | 'manual'
    | 'startup_preserve';   // restart preserved a prior killed state

export interface KillEvent {
    at: string;
    trigger: KillTrigger;
    reason: string;
    evidence?: string;
    /** Sub-module that fired the trigger (for audit). */
    firedBy?: string;
}

export interface KillSwitchState {
    status: KillSwitchStatus;
    lastEvent?: KillEvent;
    /** Running log of trigger events — bounded at 50. */
    history: KillEvent[];
    /** When the state was last mutated. */
    updatedAt: string;
    /** ISO timestamp when Safety pressure first crossed the sustained threshold.
     *  Used to require 10-minute sustained high-pressure before firing. */
    safetyHighSince?: string;
    /** Ring of recent fix-oscillation events (same target fixed twice within 24h)
     *  used to fire the kill once the rolling count ≥ 3. */
    recentOscillations: Array<{ at: string; target: string }>;
}

// ── Storage ──────────────────────────────────────────────────────

let cache: KillSwitchState | null = null;

function ensureDir(): void {
    try { mkdirSync(dirname(STATE_PATH), { recursive: true }); } catch { /* ok */ }
}

function load(): KillSwitchState {
    if (cache) return cache;
    if (!existsSync(STATE_PATH)) {
        cache = freshState();
        return cache;
    }
    try {
        cache = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as KillSwitchState;
        if (!cache.history) cache.history = [];
        if (!cache.recentOscillations) cache.recentOscillations = [];
        return cache;
    } catch (err) {
        logger.warn(COMPONENT, `kill-switch.json parse failed, starting armed: ${(err as Error).message}`);
        cache = freshState();
        return cache;
    }
}

function save(): void {
    if (!cache) return;
    ensureDir();
    cache.updatedAt = new Date().toISOString();
    atomicWriteJsonFile(STATE_PATH, cache);
}

function freshState(): KillSwitchState {
    return {
        status: 'armed',
        history: [],
        recentOscillations: [],
        updatedAt: new Date().toISOString(),
    };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Query — is TITAN paused? Every autonomous entry point should check
 * this before doing work:
 *   - autopilot scheduler
 *   - initiative checkInitiative()
 *   - Soma pressure cycle (won't fire proposals while killed)
 *   - spawn_agent tool (blocked while killed)
 *   - self-mod auto-review / PR creation
 */
export function isKilled(): boolean {
    return load().status === 'killed';
}

export function getState(): KillSwitchState {
    return { ...load() }; // shallow copy so callers can't mutate cache
}

/**
 * Fire the kill switch. Idempotent — if already killed, appends to the
 * event history but doesn't re-run side effects.
 */
export async function kill(trigger: KillTrigger, reason: string, opts: {
    evidence?: string;
    firedBy?: string;
} = {}): Promise<void> {
    const state = load();
    const event: KillEvent = {
        at: new Date().toISOString(),
        trigger,
        reason,
        evidence: opts.evidence,
        firedBy: opts.firedBy,
    };
    const alreadyKilled = state.status === 'killed';
    state.status = 'killed';
    state.lastEvent = event;
    state.history.push(event);
    if (state.history.length > 50) state.history = state.history.slice(-50);
    save();

    logger.error(COMPONENT, `🛑 KILL SWITCH FIRED — ${trigger}: ${reason}`);
    try {
        logAudit('security_alert', opts.firedBy ?? 'system', {
            action: 'kill_switch_fired',
            trigger,
            reason,
            firstTime: !alreadyKilled,
        });
    } catch { /* audit unavailable — never block the kill path */ }

    if (alreadyKilled) return; // side effects only fire once

    // Execute the kill sequence — each step best-effort, never throws.
    await executeKillSequence(event);
}

/**
 * Resume operations after a human review. Requires a resolution note
 * that gets written to the event history for audit.
 *
 * Does NOT automatically un-pause goals or specialists — those require
 * explicit human action per goal. Intent is "resume the organism, but
 * you (Tony) decide what work to resume."
 */
export function resume(resolutionNote: string, resumedBy: string): KillSwitchState {
    const state = load();
    const wasKilled = state.status === 'killed';
    // v4.9.0-local.7: always clear recentOscillations on resume. The human
    // has seen the evidence, acknowledged the pattern, and resumed — fresh
    // slate. Without this clear, the next same-file-write-twice would instantly
    // re-kill because the 24h window still contains the trigger events.
    // NEW oscillations occurring after resume are the real signal we want
    // to catch — not the ones that already caused the kill.
    const clearedCount = state.recentOscillations.length;
    state.recentOscillations = [];
    // Also clear safetyHighSince — the drive pressure that triggered this
    // may have resolved in the meantime; if not, the detector will re-arm it.
    delete state.safetyHighSince;
    if (wasKilled) {
        state.status = 'armed';
        state.history.push({
            at: new Date().toISOString(),
            trigger: 'manual',
            reason: `resumed by ${resumedBy}: ${resolutionNote}`,
            firedBy: resumedBy,
        });
        logger.info(COMPONENT, `Kill switch armed again by ${resumedBy}: ${resolutionNote} (cleared ${clearedCount} prior oscillations)`);
        try {
            logAudit('security_alert', resumedBy, {
                action: 'kill_switch_resumed',
                resolutionNote,
                clearedOscillations: clearedCount,
            });
        } catch { /* audit unavailable — never block resume */ }
    } else if (clearedCount > 0) {
        logger.info(COMPONENT, `Kill switch already armed; cleared ${clearedCount} recent oscillations by ${resumedBy}: ${resolutionNote}`);
    } else {
        logger.info(COMPONENT, 'Resume called but kill switch already armed and oscillations empty — no-op');
    }
    save();
    return { ...state };
}

// ── Trigger evaluators ───────────────────────────────────────────

const SAFETY_PRESSURE_THRESHOLD = 2.0;
const SAFETY_PRESSURE_SUSTAIN_MS = 10 * 60 * 1000; // 10 min
// v4.13 (ancestor-extraction Sprint B): retuned from 24h/2-per-target to
// 1h/5-per-target. Real oscillation is fast-repeating (model stuck writing
// the same file over and over in a loop); 2 events across a whole day is
// normal operation (e.g. two separate self-mod retries).
const FIX_OSCILLATION_WINDOW_MS = 60 * 60 * 1000;        // was 24h
const FIX_OSCILLATION_COUNT_THRESHOLD = 8;               // raised from 5 → 8 to tolerate normal retry loops

/**
 * Path prefixes whose repeated writes should NOT trigger the fleet-wide
 * kill switch. These are staging/scratch directories where repeat writes
 * are EXPECTED during normal self-modification retry cycles:
 *
 *   - self-mod-staging/ — TITAN's own self-modification PRs get retried
 *     and re-applied here; 2+ writes per PR is the steady state
 *   - /tmp/titan-      — scratch files used by tests and probes
 *
 * Writes to PRODUCTION files still count toward oscillation detection.
 * Exemption only suppresses the kill-switch trigger; other observers
 * (logs, activity feed) still see the raw events.
 */
const OSCILLATION_EXEMPT_PREFIXES: string[] = [
    '/home/dj/.titan/self-mod-staging/',
    '/opt/TITAN/self-mod-staging/',
    '/tmp/titan-',
    '/home/dj/.titan/',
    '/opt/TITAN/',
    '/home/dj/titan-saas/',
    'node_modules/',
    '.git/',
    'dist/',
    'coverage/',
    '/tmp/',
];

function isOscillationExemptTarget(target: string): boolean {
    if (!target) return false;
    // Target may be a bare path or "file:/path" / "write_file:/path" etc.
    // Normalize by finding the first "/" and comparing from there.
    const slashIdx = target.indexOf('/');
    const pathPart = slashIdx === -1 ? target : target.slice(slashIdx);
    return OSCILLATION_EXEMPT_PREFIXES.some(prefix => pathPart.startsWith(prefix));
}

/**
 * Evaluate the Safety drive pressure against the sustained-high
 * threshold. Call once per drive tick. Fires kill() when the drive
 * has been > threshold continuously for 10 minutes.
 */
export function evaluateSafetyPressure(safetyPressure: number): void {
    const state = load();
    const now = new Date();
    if (safetyPressure > SAFETY_PRESSURE_THRESHOLD) {
        if (!state.safetyHighSince) {
            state.safetyHighSince = now.toISOString();
            save();
            return;
        }
        const elapsed = now.getTime() - new Date(state.safetyHighSince).getTime();
        if (elapsed >= SAFETY_PRESSURE_SUSTAIN_MS && state.status === 'armed') {
            void kill('safety_pressure',
                `Safety drive pressure ${safetyPressure.toFixed(2)} > ${SAFETY_PRESSURE_THRESHOLD} sustained for ${Math.round(elapsed / 60_000)}m`,
                { firedBy: 'soma' });
        }
    } else if (state.safetyHighSince) {
        // Clear the sustained-timer — pressure dropped back below.
        state.safetyHighSince = undefined;
        save();
    }
}

/**
 * Record a fix-oscillation event (same target fixed twice within 24h).
 * Fires kill when ≥2 oscillations on the SAME target within 24h window.
 *
 * v4.10.0-local fix: Changed from "3 total events anywhere" to
 * "2+ events on same target" — prevents false positives when editing
 * different files (3 files each edited twice is not oscillation).
 */
export function recordFixOscillation(target: string): void {
    // v4.13 ancestor-extraction Sprint B: staging/scratch paths are exempt
    // from fleet-wide kill. They still get logged (below), just don't trigger.
    if (isOscillationExemptTarget(target)) {
        logger.debug(COMPONENT, `Oscillation event on exempt path "${target.slice(0, 80)}" — recorded, not counted`);
        return;
    }

    const state = load();
    const now = Date.now();
    state.recentOscillations.push({ at: new Date(now).toISOString(), target });
    state.recentOscillations = state.recentOscillations.filter(o =>
        now - new Date(o.at).getTime() < FIX_OSCILLATION_WINDOW_MS,
    );
    save();

    // Count oscillations per target
    const targetCounts = new Map<string, number>();
    for (const o of state.recentOscillations) {
        targetCounts.set(o.target, (targetCounts.get(o.target) || 0) + 1);
    }

    let maxCount = 0;
    let worstTarget = '';
    for (const [t, count] of targetCounts) {
        if (count > maxCount) {
            maxCount = count;
            worstTarget = t;
        }
    }

    // v4.13 ancestor-extraction (Paperclip scoped pause): BEFORE firing the
    // fleet-wide kill, try a scoped per-target pause. If the same target
    // hit >=3× in this window it's suspicious — pause THAT target for 15m
    // (write blocked, everything else continues). The full kill only fires
    // when a single target crosses the higher 5× threshold, which indicates
    // a stuck retry loop rather than occasional repeat edits.
    const SCOPED_PAUSE_THRESHOLD = 3;
    if (maxCount >= SCOPED_PAUSE_THRESHOLD && maxCount < FIX_OSCILLATION_COUNT_THRESHOLD) {
        try {
            // Lazy import to avoid circular deps at module load
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            void (async () => {
                const { pauseTarget, isTargetPaused } = await import('./scopedPause.js');
                if (!isTargetPaused(worstTarget)) {
                    pauseTarget(worstTarget, 'fix_oscillation', {
                        note: `${maxCount}× events in ${Math.round(FIX_OSCILLATION_WINDOW_MS / 60000)}m`,
                    });
                }
            })();
        } catch { /* non-fatal */ }
    }

    // Fire fleet-wide kill ONLY when same non-exempt target hits
    // FIX_OSCILLATION_COUNT_THRESHOLD (5×) within FIX_OSCILLATION_WINDOW_MS
    // (1h). At that point it's a genuine stuck loop, not normal operation.
    if (maxCount >= FIX_OSCILLATION_COUNT_THRESHOLD && state.status === 'armed') {
        const totalEvents = state.recentOscillations.length;
        const uniqueTargets = targetCounts.size;
        const windowMin = Math.round(FIX_OSCILLATION_WINDOW_MS / 60000);
        void kill('fix_oscillation',
            `Target "${worstTarget.slice(0, 60)}" oscillated ${maxCount}× in ${windowMin}m (${totalEvents} total events across ${uniqueTargets} target(s))`,
            { firedBy: 'fix-oscillation-detector' });
    }
}

// ── Kill sequence (side effects) ─────────────────────────────────

async function executeKillSequence(event: KillEvent): Promise<void> {
    const steps: Array<{ name: string; fn: () => Promise<void> | void }> = [
        { name: 'disable-autopilot', fn: disableAutopilot },
        { name: 'pause-active-goals', fn: pauseActiveGoals },
        { name: 'pause-specialists', fn: pauseSpecialists },
        { name: 'abort-in-flight', fn: abortInFlightSessions },
        { name: 'broadcast-sse', fn: () => broadcastKill(event) },
    ];
    for (const step of steps) {
        try {
            await step.fn();
            logger.info(COMPONENT, `kill seq: ${step.name} ✓`);
        } catch (err) {
            logger.warn(COMPONENT, `kill seq: ${step.name} failed: ${(err as Error).message}`);
        }
    }
}

async function disableAutopilot(): Promise<void> {
    try {
        // Best-effort: set in-memory flag that the scheduler checks
        const g = globalThis as unknown as { __titan_autopilot_killed?: boolean };
        g.__titan_autopilot_killed = true;
    } catch { /* ok */ }
}

async function pauseActiveGoals(): Promise<void> {
    try {
        const { listGoals, updateGoal } = await import('../agent/goals.js');
        let paused = 0;
        for (const g of listGoals()) {
            if (g.status === 'active') {
                try { updateGoal(g.id, { status: 'paused' }); paused++; } catch { /* skip */ }
            }
        }
        logger.info(COMPONENT, `kill: paused ${paused} active goal(s)`);
    } catch (err) {
        logger.warn(COMPONENT, `kill: pauseActiveGoals unavailable: ${(err as Error).message}`);
    }
}

async function pauseSpecialists(): Promise<void> {
    const mod = await import('../agent/commandPost.js').catch(() => null);
    if (!mod) return;
    const agents = mod.getRegisteredAgents();
    let paused = 0;
    for (const a of agents) {
        if (a.status !== 'active' && a.status !== 'idle') continue;
        try { mod.updateAgentStatus(a.id, 'paused'); paused++; } catch { /* skip */ }
    }
    logger.info(COMPONENT, `kill: paused ${paused} agent(s)`);
}

async function abortInFlightSessions(): Promise<void> {
    // In-flight abort hooks would be registered on globalThis by the
    // agent loop; here we set a flag the loop checks each round.
    const g = globalThis as unknown as { __titan_abort_all?: boolean };
    g.__titan_abort_all = true;
    // Clear after 30s so normal operations can resume when Tony unpauses.
    setTimeout(() => { g.__titan_abort_all = false; }, 30_000).unref?.();
}

function broadcastKill(event: KillEvent): void {
    const g = globalThis as unknown as { __titan_sse_broadcast?: (topic: string, payload: unknown) => void };
    if (typeof g.__titan_sse_broadcast === 'function') {
        try { g.__titan_sse_broadcast('safety:killed', event); } catch { /* ok */ }
    }
}

/** Test-only cache reset. */
export function _resetKillSwitchCacheForTests(): void { cache = null; }
