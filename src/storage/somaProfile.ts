/**
 * TITAN — Per-user Soma profile (v6.0 step 14)
 *
 * Why this exists
 * ---------------
 * The v6.0 differentiator "TITAN learns YOU specifically" depends on Soma
 * maintaining a stable, per-user model of how the user works, what helped
 * them, and what their long-term drive baselines look like. The agent
 * loop reads this every turn so the system prompt can reference "what you
 * know about Tony" rather than "what you know in general."
 *
 * Storage: `~/.titan/users/<userId>/soma.json`. Migration 003 seeds the
 * file shape on fresh installs. This module owns read + write + the
 * append-observation helpers.
 *
 * The profile is deliberately small + boring. Soma writes incremental
 * observations; this module reads them and exposes them as the
 * `learnedAboutUser` list the system prompt can reference.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';

const COMPONENT = 'SomaProfile';

function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function profilePath(userId: string): string {
    return join(titanHome(), 'users', userId, 'soma.json');
}

/** Drive level — 0.0 (absent) to 1.0 (max). 0.5 = neutral. */
export type DriveLevel = number;

export interface SomaProfile {
    schema: 1;
    userId: string;
    createdAt: string;
    updatedAt: string;
    /** Soma's learned baseline for the user's normal drive levels. The agent
     *  loop compares CURRENT drives against this baseline to detect anomalies
     *  ("they're more frustrated than usual today"). */
    baseline: {
        curiosity: DriveLevel;
        focus: DriveLevel;
        fatigue: DriveLevel;
        satisfaction: DriveLevel;
        frustration: DriveLevel;
    };
    /** Working-hours heuristic (populated by Soma as it observes timing
     *  patterns over weeks of use). Absent on fresh profiles. */
    workingHours?: {
        timezone: string;
        weekdayStartHour?: number;
        weekdayEndHour?: number;
    };
    /** Things Soma has observed about this user, in append order. The 50
     *  most-recent entries are read into the system prompt. */
    learnedAboutUser: string[];
}

const DEFAULT_BASELINE: SomaProfile['baseline'] = {
    curiosity: 0.6,
    focus: 0.5,
    fatigue: 0.4,
    satisfaction: 0.5,
    frustration: 0.3,
};

/** Cap on learnedAboutUser items rendered into the system prompt. */
const PROMPT_OBSERVATION_CAP = 50;
/** Cap on raw `learnedAboutUser` length on disk (kept tight so the file
 *  doesn't grow unbounded over years of use). Older entries roll off. */
const PROFILE_OBSERVATION_CAP = 500;

/** Read profile from disk. Returns a fresh default when missing/malformed. */
export function readSomaProfile(userId = 'default-user'): SomaProfile {
    const path = profilePath(userId);
    if (!existsSync(path)) {
        return freshProfile(userId);
    }
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw && raw.schema === 1 && raw.userId === userId && raw.baseline) {
            return raw as SomaProfile;
        }
        logger.warn(COMPONENT, `Profile for ${userId} has unexpected shape — using fresh default.`);
    } catch (err) {
        logger.warn(COMPONENT, `Failed to read profile for ${userId} (${(err as Error).message}) — using fresh default.`);
    }
    return freshProfile(userId);
}

/** Write profile to disk. Creates parent dir if needed. */
export function writeSomaProfile(profile: SomaProfile): void {
    const path = profilePath(profile.userId);
    try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
    profile.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(profile, null, 2));
}

function freshProfile(userId: string): SomaProfile {
    const now = new Date().toISOString();
    return {
        schema: 1,
        userId,
        createdAt: now,
        updatedAt: now,
        baseline: { ...DEFAULT_BASELINE },
        learnedAboutUser: [],
    };
}

/**
 * Append an observation. Trims the list to `PROFILE_OBSERVATION_CAP` from the
 * head, so the most recent N entries are always preserved.
 */
export function appendObservation(userId: string, observation: string): SomaProfile {
    const profile = readSomaProfile(userId);
    const trimmed = observation.trim();
    if (!trimmed) return profile;
    profile.learnedAboutUser.push(trimmed);
    if (profile.learnedAboutUser.length > PROFILE_OBSERVATION_CAP) {
        profile.learnedAboutUser = profile.learnedAboutUser.slice(-PROFILE_OBSERVATION_CAP);
    }
    writeSomaProfile(profile);
    logger.info(COMPONENT, `Observation appended for ${userId} (${profile.learnedAboutUser.length} total).`);
    return profile;
}

/** Adjust a single drive baseline using exponential moving average with
 *  alpha=0.1 (slow learner — needs many observations to shift). */
export function adjustBaseline(
    userId: string,
    drive: keyof SomaProfile['baseline'],
    observedValue: DriveLevel,
): SomaProfile {
    const profile = readSomaProfile(userId);
    const alpha = 0.1;
    const prev = profile.baseline[drive];
    const next = clamp(prev * (1 - alpha) + observedValue * alpha, 0, 1);
    profile.baseline[drive] = next;
    writeSomaProfile(profile);
    return profile;
}

function clamp(n: number, lo: number, hi: number): number {
    if (!Number.isFinite(n)) return (lo + hi) / 2;
    return Math.max(lo, Math.min(hi, n));
}

/**
 * Render a compact prompt-friendly block summarizing what TITAN has learned
 * about THIS user. Returns empty string when the profile is empty (so the
 * system prompt doesn't carry a useless header).
 */
export function renderSomaProfileForPrompt(userId = 'default-user'): string {
    const profile = readSomaProfile(userId);
    const lines: string[] = [];
    const baseline = profile.baseline;
    // Only render the baseline block if any drive deviates >0.1 from the
    // neutral default — saves prompt tokens for fresh installs.
    const baselineNoteworthy =
        Math.abs(baseline.curiosity - DEFAULT_BASELINE.curiosity) > 0.1 ||
        Math.abs(baseline.focus - DEFAULT_BASELINE.focus) > 0.1 ||
        Math.abs(baseline.fatigue - DEFAULT_BASELINE.fatigue) > 0.1 ||
        Math.abs(baseline.satisfaction - DEFAULT_BASELINE.satisfaction) > 0.1 ||
        Math.abs(baseline.frustration - DEFAULT_BASELINE.frustration) > 0.1;

    if (baselineNoteworthy) {
        lines.push(`Long-term Soma baseline for this user: curiosity=${baseline.curiosity.toFixed(2)}, focus=${baseline.focus.toFixed(2)}, fatigue=${baseline.fatigue.toFixed(2)}, satisfaction=${baseline.satisfaction.toFixed(2)}, frustration=${baseline.frustration.toFixed(2)}.`);
    }
    if (profile.learnedAboutUser.length > 0) {
        const recent = profile.learnedAboutUser.slice(-PROMPT_OBSERVATION_CAP);
        lines.push(`What you've learned about this user (${recent.length} observation${recent.length === 1 ? '' : 's'}):`);
        for (const obs of recent) lines.push(`- ${obs}`);
    }
    if (lines.length === 0) return '';
    return `## What you know about this user\n${lines.join('\n')}`;
}

/** Test helper — reset profile + remove file. */
export function __resetProfileForTests(userId = 'default-user'): void {
    try { require('fs').unlinkSync(profilePath(userId)); } catch { /* fine */ }
}
