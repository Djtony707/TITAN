/**
 * TITAN — Persistent Agent Daemon
 * Always-on background event loop that watches for triggers and acts.
 * Runs alongside the gateway, providing continuous awareness between
 * autopilot runs and user requests.
 *
 * Watchers are pluggable checker functions that run on configurable intervals.
 * The daemon respects autonomy mode, throttling, and safety rails.
 */
import { EventEmitter } from 'events';
import { loadConfig } from '../config/config.js';
import { getReadyTasks } from './goals.js';
import { getAutopilotStatus } from './autopilot.js';
import { auditLog } from './auditLog.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Daemon';

// ── Event Bus ──────────────────────────────────────────────────────
export const titanEvents = new EventEmitter();
titanEvents.setMaxListeners(100);

// ── Types ──────────────────────────────────────────────────────────

export interface WatcherConfig {
    name: string;
    enabled: boolean;
    intervalMs: number;
}

export interface DaemonStatus {
    running: boolean;
    startedAt: string | null;
    uptimeMs: number;
    activeWatchers: string[];
    actionsThisHour: number;
    maxActionsPerHour: number;
    errorRatePercent: number;
    paused: boolean;
    pauseReason: string | null;
}

interface WatcherState {
    config: WatcherConfig;
    timer: ReturnType<typeof setInterval> | null;
    lastRun: number;
    runCount: number;
    errorCount: number;
    handler: () => Promise<void>;
}

// ── Rate Limiting ──────────────────────────────────────────────────

interface ActionRecord {
    timestamp: number;
    watcher: string;
    success: boolean;
}

const actionLog: ActionRecord[] = [];
let maxActionsPerHour = 10;

function recordAction(watcher: string, success: boolean): void {
    actionLog.push({ timestamp: Date.now(), watcher, success });
    // Prune records older than 1 hour
    const cutoff = Date.now() - 3_600_000;
    while (actionLog.length > 0 && actionLog[0].timestamp < cutoff) {
        actionLog.shift();
    }
}

function getActionsThisHour(): number {
    const cutoff = Date.now() - 3_600_000;
    return actionLog.filter(a => a.timestamp >= cutoff).length;
}

function getErrorRatePercent(): number {
    const cutoff = Date.now() - 3_600_000;
    const recent = actionLog.filter(a => a.timestamp >= cutoff);
    if (recent.length === 0) return 0;
    const errors = recent.filter(a => !a.success).length;
    return Math.round((errors / recent.length) * 100);
}

function isThrottled(): boolean {
    return getActionsThisHour() >= maxActionsPerHour;
}

// ── Pause/Circuit Breaker ──────────────────────────────────────────

let paused = false;
let pauseReason: string | null = null;

function pauseDaemon(reason: string): void {
    paused = true;
    pauseReason = reason;
    logger.warn(COMPONENT, `Daemon PAUSED: ${reason}`);
    auditLog({
        action: 'daemon_paused',
        source: 'daemon',
        detail: { reason },
    });
    titanEvents.emit('daemon:paused', { reason });
}

function checkCircuitBreakers(): void {
    // Error rate breaker: >30% of actions in last hour failed
    const errorRate = getErrorRatePercent();
    if (errorRate > 30 && getActionsThisHour() >= 5) {
        pauseDaemon(`Error rate too high: ${errorRate}% of actions failed in the last hour`);
        return;
    }
}

// ── Daemon State ───────────────────────────────────────────────────

let running = false;
let startedAt: number | null = null;
const watchers = new Map<string, WatcherState>();

// ── Built-in Watchers ──────────────────────────────────────────────

/** Check if any goal subtask is ready and execute it via the initiative system */
async function goalWatcher(): Promise<void> {
    const readyTasks = getReadyTasks();
    if (readyTasks.length === 0) return;

    const config = loadConfig();
    const isAutonomous = config.autonomy.mode === 'autonomous';

    for (const { goal, subtask } of readyTasks.slice(0, 1)) { // One subtask at a time
        if (isThrottled()) break;

        logger.info(COMPONENT, `[GoalWatcher] Ready subtask: "${subtask.title}" (goal: ${goal.title})`);
        titanEvents.emit('goal:subtask:ready', { goalId: goal.id, subtaskId: subtask.id, title: subtask.title });

        // In autonomous mode, execute the subtask via the initiative system
        if (isAutonomous) {
            try {
                const { checkInitiative } = await import('./initiative.js');
                const result = await checkInitiative();
                if (result.acted) {
                    logger.info(COMPONENT, `[GoalWatcher] Initiative acted on: "${subtask.title}"`);
                    recordAction('goal', true);
                } else {
                    recordAction('goal', true); // Detection still counts as an action
                }
            } catch (err) {
                logger.error(COMPONENT, `[GoalWatcher] Initiative failed: ${(err as Error).message}`);
                recordAction('goal', false);
            }
        } else {
            recordAction('goal', true);
        }

        auditLog({
            action: 'goal_subtask_detected',
            source: 'daemon:goal',
            detail: { goalId: goal.id, subtaskId: subtask.id, title: subtask.title },
        });
    }
}

/** Check autopilot health — if the last run failed, emit an event */
async function cronFailureWatcher(): Promise<void> {
    const status = getAutopilotStatus();
    if (!status.enabled) return;

    // Check if last run had an error (detected via run history)
    if (status.lastRun) {
        const timeSinceLastRun = Date.now() - new Date(status.lastRun.timestamp).getTime();
        // If last run was recent (within 2x the schedule interval) and we're still running, something might be stuck
        if (status.isRunning && timeSinceLastRun > 1_800_000) {
            logger.warn(COMPONENT, '[CronFailureWatcher] Autopilot run appears stuck (running > 30 min)');
            titanEvents.emit('cron:stuck', { since: status.lastRun });
            recordAction('cronFailure', true);
        }
    }
}

/** Monitor critical services: Ollama, voice, etc. */
async function healthWatcher(): Promise<void> {
    const config = loadConfig();
    const ollamaUrl = config.providers?.ollama?.baseUrl || 'http://localhost:11434';

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) {
            logger.warn(COMPONENT, `[HealthWatcher] Ollama returned ${res.status}`);
            titanEvents.emit('health:ollama:degraded', { status: res.status });
            recordAction('health', false);
        } else {
            recordAction('health', true);
        }
    } catch (err) {
        logger.warn(COMPONENT, `[HealthWatcher] Ollama unreachable: ${(err as Error).message}`);
        titanEvents.emit('health:ollama:down', { error: (err as Error).message });
        recordAction('health', false);
    }
}

/** Check for unprocessed "remind me" / follow-up items in memory */
async function memoryTriggerWatcher(): Promise<void> {
    // Future: scan memory for time-based triggers
    // For now, emit a heartbeat so the event bus stays alive
    titanEvents.emit('daemon:heartbeat', { timestamp: Date.now() });
}

/** Daily memory consolidation — prune, dedupe, synthesize entity summaries + staleness check */
async function dreamingWatcher(): Promise<void> {
    try {
        const { runConsolidation } = await import('../memory/dreaming.js');
        const result = await runConsolidation();
        const pruned = result?.deepSleep?.entriesPruned ?? 0;

        // Memory staleness verification — decay old strategies, prune stale knowledge
        const { verifyMemoryStaleness } = await import('../memory/learning.js');
        const staleness = verifyMemoryStaleness();

        logger.info(COMPONENT, `[DreamingWatcher] Consolidation complete: ${pruned} entries pruned, ${staleness.pruned} stale removed, ${staleness.decayed} strategies decayed`);
        titanEvents.emit('dreaming:consolidated', { result, staleness });
        recordAction('dreaming', true);
    } catch (err) {
        logger.error(COMPONENT, `[DreamingWatcher] Failed: ${(err as Error).message}`);
        recordAction('dreaming', false);
    }
}

// ── Watcher Registry ───────────────────────────────────────────────

/** Soma drive tick — lazy-imported to avoid loading organism modules in
 *  installations where organism is disabled (keeps cold-start fast). */
async function driveTickWatcherAdapter(): Promise<void> {
    const { driveTickHandler } = await import('../organism/driveTickWatcher.js');
    return driveTickHandler();
}

const BUILTIN_WATCHERS: Record<string, () => Promise<void>> = {
    goal: goalWatcher,
    cronFailure: cronFailureWatcher,
    health: healthWatcher,
    memoryTrigger: memoryTriggerWatcher,
    dreaming: dreamingWatcher,
    driveTick: driveTickWatcherAdapter,
};

/** Watchers registered before daemon starts — stores their requested intervals */
const pendingWatcherConfigs: Map<string, { handler: () => Promise<void>; intervalMs: number }> = new Map();

const DEFAULT_WATCHER_CONFIGS: WatcherConfig[] = [
    { name: 'goal', enabled: true, intervalMs: 300_000 },          // 5 min
    { name: 'cronFailure', enabled: true, intervalMs: 600_000 },   // 10 min
    { name: 'health', enabled: true, intervalMs: 120_000 },        // 2 min
    { name: 'memoryTrigger', enabled: true, intervalMs: 300_000 }, // 5 min
    { name: 'dreaming', enabled: true, intervalMs: 86_400_000 },   // 24 hours
    // Soma drive tick. Gated by config.organism.enabled in initDaemon; if the
    // flag is false at daemon startup this watcher is excluded from the
    // runtime registry entirely (zero overhead for existing users).
    { name: 'driveTick', enabled: true, intervalMs: 60_000 },       // 60 s
];

// ── Core Daemon Functions ──────────────────────────────────────────

function startWatcher(state: WatcherState): void {
    if (state.timer) return;

    const wrappedHandler = async () => {
        if (paused || !running) return;
        if (isThrottled()) {
            logger.debug(COMPONENT, `[${state.config.name}] Throttled — skipping`);
            return;
        }

        try {
            await state.handler();
            state.lastRun = Date.now();
            state.runCount++;
        } catch (err) {
            state.errorCount++;
            logger.error(COMPONENT, `[${state.config.name}] Error: ${(err as Error).message}`);
            recordAction(state.config.name, false);
        }

        // Check circuit breakers after each action
        checkCircuitBreakers();
    };

    // Run immediately on start, then on interval
    wrappedHandler();
    state.timer = setInterval(wrappedHandler, state.config.intervalMs);
    (state.timer as ReturnType<typeof setInterval>).unref(); // Don't block process shutdown
}

function stopWatcher(state: WatcherState): void {
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
}

// ── Public API ─────────────────────────────────────────────────────

export function initDaemon(): void {
    const config = loadConfig();
    const daemonConfig = (config as Record<string, unknown>).daemon as {
        enabled?: boolean;
        watchers?: WatcherConfig[];
        maxActionsPerHour?: number;
    } | undefined;

    if (!daemonConfig?.enabled) {
        logger.info(COMPONENT, 'Daemon disabled in config');
        return;
    }

    if (running) {
        logger.warn(COMPONENT, 'Daemon already running');
        return;
    }

    maxActionsPerHour = daemonConfig.maxActionsPerHour ?? 10;

    // Merge user watcher configs with defaults
    const userWatchers = daemonConfig.watchers ?? [];
    const watcherConfigs = DEFAULT_WATCHER_CONFIGS.map(dw => {
        const override = userWatchers.find(uw => uw.name === dw.name);
        return override ? { ...dw, ...override } : dw;
    });

    // Soma gate: driveTick only runs when organism.enabled=true. We mutate
    // the config we're about to iterate — cleaner than a runtime check in
    // the handler, and guarantees zero overhead for installations that
    // never opt in to Soma.
    const organismEnabled = !!(config as unknown as { organism?: { enabled?: boolean } }).organism?.enabled;
    if (!organismEnabled) {
        const idx = watcherConfigs.findIndex(wc => wc.name === 'driveTick');
        if (idx >= 0) watcherConfigs[idx] = { ...watcherConfigs[idx], enabled: false };
    }

    // Add any custom user watchers not in defaults
    for (const uw of userWatchers) {
        if (!watcherConfigs.find(wc => wc.name === uw.name)) {
            watcherConfigs.push(uw);
        }
    }

    // Set running BEFORE starting watchers so their immediate invocation doesn't bail
    running = true;
    startedAt = Date.now();
    paused = false;
    pauseReason = null;

    // Initialize watchers from default + user config
    for (const wc of watcherConfigs) {
        if (!wc.enabled) continue;

        const handler = BUILTIN_WATCHERS[wc.name];
        if (!handler) {
            logger.warn(COMPONENT, `Unknown watcher: ${wc.name} — skipping`);
            continue;
        }

        const state: WatcherState = {
            config: wc,
            timer: null,
            lastRun: 0,
            runCount: 0,
            errorCount: 0,
            handler,
        };
        watchers.set(wc.name, state);
        startWatcher(state);
    }

    // Start any watchers registered early via registerWatcher() (e.g. from skills loaded before daemon)
    for (const [name, pending] of pendingWatcherConfigs) {
        if (watchers.has(name)) continue; // Already started above
        const state: WatcherState = {
            config: { name, enabled: true, intervalMs: pending.intervalMs },
            timer: null,
            lastRun: 0,
            runCount: 0,
            errorCount: 0,
            handler: pending.handler,
        };
        watchers.set(name, state);
        startWatcher(state);
    }
    pendingWatcherConfigs.clear();

    logger.info(COMPONENT, `Daemon started with ${watchers.size} watchers: ${[...watchers.keys()].join(', ')}`);
    logger.info(COMPONENT, `Rate limit: ${maxActionsPerHour} actions/hour`);

    auditLog({
        action: 'daemon_started',
        source: 'daemon',
        detail: { watchers: [...watchers.keys()], maxActionsPerHour },
    });

    titanEvents.emit('daemon:started', { watchers: [...watchers.keys()] });
}

export function stopDaemon(): void {
    if (!running) return;

    for (const state of watchers.values()) {
        stopWatcher(state);
    }
    watchers.clear();

    running = false;
    startedAt = null;

    logger.info(COMPONENT, 'Daemon stopped');
    auditLog({ action: 'daemon_stopped', source: 'daemon', detail: {} });
    titanEvents.emit('daemon:stopped');
}

export function pauseDaemonManual(): void {
    pauseDaemon('Manual pause via API');
}

export function resumeDaemon(): void {
    if (!running) {
        logger.warn(COMPONENT, 'Cannot resume — daemon not running. Call initDaemon() first.');
        return;
    }
    paused = false;
    pauseReason = null;
    logger.info(COMPONENT, 'Daemon resumed');
    auditLog({ action: 'daemon_resumed', source: 'daemon', detail: {} });
    titanEvents.emit('daemon:resumed');
}

export function getDaemonStatus(): DaemonStatus {
    return {
        running,
        startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        uptimeMs: startedAt ? Date.now() - startedAt : 0,
        activeWatchers: [...watchers.entries()]
            .filter(([, s]) => s.timer !== null)
            .map(([name]) => name),
        actionsThisHour: getActionsThisHour(),
        maxActionsPerHour,
        errorRatePercent: getErrorRatePercent(),
        paused,
        pauseReason,
    };
}

/** Register a custom watcher at runtime */
export function registerWatcher(name: string, handler: () => Promise<void>, intervalMs: number = 300_000): void {
    if (watchers.has(name)) {
        logger.warn(COMPONENT, `Watcher "${name}" already registered — skipping`);
        return;
    }

    BUILTIN_WATCHERS[name] = handler;

    if (!running) {
        pendingWatcherConfigs.set(name, { handler, intervalMs });
        return;
    }

    const state: WatcherState = {
        config: { name, enabled: true, intervalMs },
        timer: null,
        lastRun: 0,
        runCount: 0,
        errorCount: 0,
        handler,
    };
    watchers.set(name, state);
    startWatcher(state);

    logger.info(COMPONENT, `Custom watcher registered: ${name} (${intervalMs}ms interval)`);
}
