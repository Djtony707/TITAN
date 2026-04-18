/**
 * TITAN — Self-Proposal Drive Learning Loop (v4.8.0+)
 *
 * When Tony merges or rejects a self-proposal PR, that outcome feeds
 * back into the originating drive's satisfaction state:
 *
 *   merged          → drive satisfaction nudge +0.05 (reinforcement)
 *                     "this was valuable, keep proposing this kind of thing"
 *   closed_unmerged → drive satisfaction dampens for 24h (negative signal)
 *                     "this wasn't valuable; cool your jets"
 *
 * The learning is intentionally gentle — we don't want a single rejection
 * to permanently disable Curiosity. It just shifts the drive's setpoint
 * slightly so the pressure → proposal cycle slows for that drive.
 *
 * The dampening is implemented as a temporary "cooldown" stored in-memory
 * + persisted to drive-state.json. It decays linearly over 24h back to
 * the original weight.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { getProposal, updateStatus, type SelfProposal } from './selfProposals.js';
import { pollPRStatus } from './selfProposalPR.js';

const COMPONENT = 'SelfProposalLearning';

/** Per-drive cooldown state. */
interface DriveCooldown {
    driveId: string;
    startedAt: number;
    expiresAt: number;
    reason: string;
    /** Multiplier applied to pressure threshold. >1 makes the drive less likely to fire. */
    pressureMultiplier: number;
}

const COOLDOWN_FILE = join(TITAN_HOME, 'self-mod-cooldowns.json');
const COOLDOWN_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
const REJECTION_MULTIPLIER = 1.5; // 50% harder to fire
const MERGE_SATISFACTION_DELTA = 0.05;

function loadCooldowns(): DriveCooldown[] {
    try {
        if (!existsSync(COOLDOWN_FILE)) return [];
        return JSON.parse(readFileSync(COOLDOWN_FILE, 'utf-8')) as DriveCooldown[];
    } catch { return []; }
}

function saveCooldowns(list: DriveCooldown[]): void {
    try {
        writeFileSync(COOLDOWN_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `saveCooldowns: ${(err as Error).message}`);
    }
}

/** Get the live pressure multiplier for a drive. Expired cooldowns are pruned. */
export function getDrivePressureMultiplier(driveId: string): number {
    const now = Date.now();
    const active = loadCooldowns().filter(c => c.expiresAt > now);
    const match = active.find(c => c.driveId === driveId);
    if (!match) return 1.0;
    // Linear decay from `pressureMultiplier` back to 1.0 over the cooldown.
    const elapsed = now - match.startedAt;
    const total = match.expiresAt - match.startedAt;
    const progress = Math.min(1, elapsed / total);
    const decayed = match.pressureMultiplier - (match.pressureMultiplier - 1.0) * progress;
    return decayed;
}

/** Apply drive learning feedback. Called when a PR is merged or closed. */
export function applyLearning(
    proposal: SelfProposal,
    outcome: 'merged' | 'closed_unmerged',
): void {
    const drive = proposal.drive;
    if (!drive) return;

    if (outcome === 'merged') {
        // Positive reinforcement — nudge the drive satisfaction up a bit.
        // We don't modify the setpoint (permanent) — just bump current
        // satisfaction so pressure drops briefly. The drive will re-rise
        // naturally if it's genuinely needed.
        nudgeDriveSatisfaction(drive, MERGE_SATISFACTION_DELTA).catch(err =>
            logger.warn(COMPONENT, `nudgeDriveSatisfaction failed: ${err.message}`),
        );
        logger.info(COMPONENT, `Merged: ${drive} satisfaction +${MERGE_SATISFACTION_DELTA}`);
    } else {
        // Negative signal — add a 24h cooldown to dampen the drive.
        const list = loadCooldowns().filter(c => c.driveId !== drive); // replace any existing
        list.push({
            driveId: drive,
            startedAt: Date.now(),
            expiresAt: Date.now() + COOLDOWN_DURATION_MS,
            reason: `proposal ${proposal.id.slice(0, 8)} closed unmerged`,
            pressureMultiplier: REJECTION_MULTIPLIER,
        });
        saveCooldowns(list);
        logger.info(COMPONENT, `Closed: ${drive} dampened ×${REJECTION_MULTIPLIER} for 24h`);
    }
}

async function nudgeDriveSatisfaction(driveId: string, delta: number): Promise<void> {
    try {
        // Dynamic import to avoid cycle with drives/pressure modules.
        const drivesModule = await import('../organism/drives.js');
        const modAny = drivesModule as unknown as {
            nudgeDriveSatisfaction?: (id: string, delta: number) => void;
            adjustDrive?: (id: string, delta: number) => void;
        };
        if (typeof modAny.nudgeDriveSatisfaction === 'function') {
            modAny.nudgeDriveSatisfaction(driveId, delta);
        } else if (typeof modAny.adjustDrive === 'function') {
            modAny.adjustDrive(driveId, delta);
        } else {
            logger.debug(COMPONENT, `No drive-nudge hook in drives.js — skipping direct nudge (cooldowns still apply)`);
        }
    } catch (err) {
        logger.debug(COMPONENT, `drive nudge skipped: ${(err as Error).message}`);
    }
}

// ── Poller (call periodically from server interval) ──────────────

let pollerActive = false;

export async function pollOpenProposals(): Promise<void> {
    if (pollerActive) return;
    pollerActive = true;
    try {
        const { listProposals } = await import('./selfProposals.js');
        const open = listProposals(100).filter(p => p.status === 'pr_open');
        for (const p of open) {
            try {
                const newStatus = await pollPRStatus(p.id);
                if (newStatus) {
                    updateStatus(p.id, newStatus, {
                        mergedAt: newStatus === 'merged' ? new Date().toISOString() : undefined,
                    });
                    applyLearning(p, newStatus);
                }
            } catch (err) {
                logger.debug(COMPONENT, `poll ${p.id.slice(0, 8)} failed: ${(err as Error).message}`);
            }
        }
    } finally {
        pollerActive = false;
    }
}
