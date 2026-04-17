/**
 * TITAN — Drive Tick Watcher (Soma)
 *
 * Registered with the existing daemon watcher pattern (registerWatcher).
 * Runs every `organism.tickIntervalMs` (default 60s). On each tick:
 *   1. build snapshot + compute drives
 *   2. persist tick to ~/.titan/drive-state.json (ring buffer)
 *   3. emit drive:tick + hormone:update on the trace bus
 *   4. run pressure fusion — optionally fires a soma_proposal
 *
 * Gated by config.organism.enabled. The watcher is registered only when
 * the flag is true at initDaemon time.
 */
import { runDriveTick, saveDriveTick, buildSnapshot, computeAllDrives } from './drives.js';
import { buildBlock, broadcastHormonalUpdate } from './hormones.js';
import { runPressureCycle } from './pressure.js';
import { emit } from '../substrate/traceBus.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'DriveTick';

/** One full tick. Never throws — swallows all errors so a bad tick never
 *  crashes the daemon. */
export async function driveTickHandler(): Promise<void> {
    const config = loadConfig();
    const organism = (config as unknown as { organism?: {
        enabled?: boolean;
        driveSetpoints?: Record<string, number>;
    } }).organism || {};

    if (!organism.enabled) {
        // Safety: watcher shouldn't have been registered when disabled, but
        // guard anyway in case config was changed at runtime.
        return;
    }

    try {
        // Use runDriveTick rather than direct calls so setpoint overrides
        // flow through a single code path.
        const snapshot = buildSnapshot();
        const drives = computeAllDrives(snapshot, (organism.driveSetpoints as Record<import('./drives.js').DriveId, number>) || {});
        const totalPressure = drives.reduce((sum, d) => sum + d.pressure, 0);
        const dominantDrives = drives
            .filter(d => d.pressure > 0)
            .sort((a, b) => b.pressure - a.pressure)
            .slice(0, 2)
            .map(d => d.id);
        const tick = {
            timestamp: new Date().toISOString(),
            drives,
            totalPressure,
            dominantDrives,
        };

        saveDriveTick(tick);

        emit('drive:tick', {
            timestamp: tick.timestamp,
            drives: tick.drives.map(d => ({
                id: d.id,
                label: d.label,
                satisfaction: d.satisfaction,
                setpoint: d.setpoint,
                pressure: d.pressure,
                inputs: d.inputs,
            })),
        });

        const block = buildBlock(tick.drives, tick.timestamp);
        broadcastHormonalUpdate(block);

        // Pressure cycle: maybe file a proposal. Awaited so logs are
        // ordered; runPressureCycle is already defensive.
        const cycle = await runPressureCycle(tick.drives);
        if (cycle.fired) {
            logger.info(COMPONENT, `Tick ${tick.timestamp} — fired ${cycle.approvalId} (${cycle.decision.reason})`);
        } else {
            logger.debug(COMPONENT, `Tick ${tick.timestamp} — ${cycle.decision.reason}${cycle.skipped ? ` (${cycle.skipped})` : ''}`);
        }
    } catch (err) {
        // Catch-all: never crash the daemon over a tick failure.
        logger.warn(COMPONENT, `Tick failed: ${(err as Error).message}`);
    }
}

/** Utility for ad-hoc invocation (tests, debug endpoint). */
export async function runOneTick(): Promise<void> {
    return driveTickHandler();
}

// Re-export the stable tick runner in case a unit test wants to avoid the
// "when disabled" early-return.
export { runDriveTick } from './drives.js';
