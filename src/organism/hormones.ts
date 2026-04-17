/**
 * TITAN — Hormonal State (Soma ambient broadcast)
 *
 * The bloodstream of the organism. Reads the latest drive state and produces
 * (a) a short context block injected into every agent's system prompt so the
 * ambient body state colors their reasoning, and (b) a dominant-drive signal
 * the UI and other subsystems can subscribe to.
 *
 * Gated by config.organism.hormonesInPrompt. Safe to call when organism is
 * disabled — returns an empty block so agent.ts wiring is a no-op.
 */
import { loadDriveHistory, type DriveState, type DriveId } from './drives.js';
import { emit } from '../substrate/traceBus.js';

// ── Types ────────────────────────────────────────────────────────

export interface HormoneBlock {
    /** True if recent drive state is available. */
    available: boolean;
    /** Timestamp of the drive tick this reflects (ISO). */
    asOf: string | null;
    /** All drive satisfactions (0-1) keyed by id. */
    levels: Record<string, number>;
    /** Drives currently contributing pressure, ordered by weight. */
    elevated: Array<{ id: string; label: string; satisfaction: number; reason: string }>;
    /** The single most-elevated drive id, if any. */
    dominant: string | null;
}

// ── State resolution ─────────────────────────────────────────────

/** Build the current hormonal snapshot from persisted drive state. Returns
 *  an empty block when no drive tick has ever run (organism freshly enabled
 *  or permanently disabled). */
export function getHormonalState(): HormoneBlock {
    const history = loadDriveHistory();
    if (!history) {
        return { available: false, asOf: null, levels: {}, elevated: [], dominant: null };
    }
    return buildBlock(history.latest.drives, history.latest.timestamp);
}

/** Build a block directly from a fresh drive-state array. Used by the
 *  driveTickWatcher so it doesn't reread disk after writing. */
export function buildBlock(drives: DriveState[], timestamp: string): HormoneBlock {
    const levels: Record<string, number> = {};
    for (const d of drives) levels[d.id] = d.satisfaction;
    const elevatedDrives = drives
        .filter(d => d.pressure > 0)
        .sort((a, b) => b.pressure - a.pressure);
    const elevated = elevatedDrives.map(d => ({
        id: d.id,
        label: d.label,
        satisfaction: d.satisfaction,
        reason: d.description,
    }));
    return {
        available: true,
        asOf: timestamp,
        levels,
        elevated,
        dominant: elevated[0]?.id ?? null,
    };
}

// ── Prompt formatting ────────────────────────────────────────────

/** Format hormonal state as a system-prompt context block. Returns empty
 *  string when no state is available or all drives are satiated (nothing
 *  worth telling the agent about). Kept tight — system prompts are already
 *  large; we add at most ~400 chars. */
export function formatForSystemPrompt(state: HormoneBlock): string {
    if (!state.available) return '';
    if (state.elevated.length === 0) {
        // All satiated. One-line acknowledgment — lets the agent know
        // the organism is healthy and no extra caution is warranted.
        return '\n## Ambient State (hormonal)\nAll drives satiated. Routine operation.\n';
    }
    const lines: string[] = ['\n## Ambient State (hormonal)'];
    lines.push(`Dominant: ${state.dominant}. Be attentive to factors that would worsen it.`);
    for (const d of state.elevated.slice(0, 3)) {
        const pct = Math.round(d.satisfaction * 100);
        lines.push(`- ${d.label} at ${pct}% — ${d.reason}`);
    }
    lines.push('');
    return lines.join('\n');
}

// ── Broadcast ────────────────────────────────────────────────────

let lastDominant: string | null = null;
let lastLevelsHash = '';

/** Fire a `hormone:update` event IF the state materially changed since last
 *  broadcast. Called from the driveTick watcher after each tick. Cheap no-op
 *  when state is stable. */
export function broadcastHormonalUpdate(state: HormoneBlock): void {
    if (!state.available) return;
    const hash = Object.entries(state.levels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v.toFixed(2)}`)
        .join('|');
    if (hash === lastLevelsHash && state.dominant === lastDominant) return;
    lastLevelsHash = hash;
    lastDominant = state.dominant;
    emit('hormone:update', {
        timestamp: state.asOf ?? new Date().toISOString(),
        dominant: state.dominant,
        levels: state.levels,
    });
}

/** Reset the broadcast cache. Used by tests that re-initialize state. */
export function __resetHormonalBroadcastCache__(): void {
    lastDominant = null;
    lastLevelsHash = '';
}

// ── Convenience ──────────────────────────────────────────────────

/** One-shot: read current state and format it. Used by buildSystemPrompt. */
export function getHormonalPromptBlock(): string {
    return formatForSystemPrompt(getHormonalState());
}

// Re-export DriveId for convenience where hormones and drives both appear.
export type { DriveId };
