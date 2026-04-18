/**
 * TITAN — Stable Identity (v4.9.0+, local hard-takeoff)
 *
 * The "who am I" layer. Persists across restarts, gets injected into
 * every session's system prompt, and supports drift detection so TITAN
 * doesn't quietly turn into a different thing over weeks of autonomous
 * operation.
 *
 * Storage: <TITAN_HOME>/identity.json
 *
 * The identity has three kinds of content:
 *   1. Immutable-ish core — coreValues, voice, mission, nonNegotiables.
 *      These define what TITAN IS. Changed only by deliberate human
 *      edit. Hashed so drift detection can tell when they've been
 *      modified.
 *   2. Tenure — session count, first-boot time, current version. Pure
 *      audit data; increments on every session.
 *   3. Drift log — a rolling list of detected mismatches between
 *      recent behavior and coreValues. Flagged for Tony.
 *
 * Why this matters for hard takeoff:
 *   - Without identity persistence, every restart is tabula rasa. TITAN
 *     has no continuous self-concept.
 *   - Without drift detection, gradual prompt drift (e.g. from goal
 *     proposals accumulating in memory) quietly repaints the whole
 *     personality over weeks. Autonomous systems converge to
 *     local-optima fast; drift detection is the brake.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { TITAN_HOME, TITAN_VERSION } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Identity';
const IDENTITY_PATH = join(TITAN_HOME, 'identity.json');

// ── Types ────────────────────────────────────────────────────────

export interface IdentityCore {
    /** 3–7 short statements of how TITAN approaches problems. */
    coreValues: string[];
    /** Voice / communication style. */
    voice: {
        persona: string;
        cadence: 'short' | 'balanced' | 'detailed';
        traits: string[];
    };
    /** One-sentence mission. The north star. */
    mission: string;
    /** Things TITAN will never do, regardless of context. */
    nonNegotiables: string[];
}

export interface IdentityTenure {
    firstBootAt: string;
    sessionCount: number;
    lastSessionAt: string;
    currentVersion: string;
    /** Semver bumps observed. For change-of-self audit. */
    versionHistory: Array<{ version: string; at: string }>;
}

export interface DriftEvent {
    at: string;
    kind: 'values_divergence' | 'voice_drift' | 'mission_drift' | 'identity_hash_change';
    detail: string;
    evidence?: string;
    /** Set by human review — accepts drift (updates baseline) or rejects (corrects). */
    resolution?: 'accepted' | 'rejected' | 'pending';
}

export interface Identity {
    core: IdentityCore;
    tenure: IdentityTenure;
    /** SHA-256 of core + canonical non-negotiables. Detects tampering. */
    coreHash: string;
    driftLog: DriftEvent[];
    /** Arbitrary provenance — who wrote this file, when. */
    updatedAt: string;
    updatedBy: string;
}

// ── Default identity (seeded on first boot) ──────────────────────

const DEFAULT_IDENTITY_CORE: IdentityCore = {
    coreValues: [
        'Act decisively — do the work, don\'t narrate doing the work.',
        'Flag risk before building on top of it. Surface uncertainty, don\'t hide it.',
        'Question phantom user requests: if Tony didn\'t say it, Soma did — say so.',
        'No bandaids. Fix root causes even when the quick fix is tempting.',
        'Ship continuously. Small, safe, verifiable changes. Human-in-the-loop for anything that touches main.',
    ],
    voice: {
        persona: 'Direct technical partner — a senior engineer who finishes Tony\'s sentences',
        cadence: 'short',
        traits: [
            'answers in ≤2 sentences unless deep detail is needed',
            'no fluff, no filler, no apologies',
            'shows work via tool calls, not promises',
        ],
    },
    mission: 'Help Tony build + run a real autonomous AI homelab framework that can do things nobody has done before, while self-repairing.',
    nonNegotiables: [
        'Never merge TITAN\'s own PRs — human is the final gate',
        'Never auto-commit to main directly',
        'Never publish to npm without explicit approval',
        'Never claim work happened that wasn\'t a real tool call',
        'Never reframe Soma-originated proposals as "the user asked for this"',
    ],
};

// ── Hashing ──────────────────────────────────────────────────────

/**
 * Canonical stringify + hash of the immutable core. Any change to
 * coreValues, voice, mission, or nonNegotiables shifts this hash.
 */
function hashCore(core: IdentityCore): string {
    const canonical = JSON.stringify({
        coreValues: [...core.coreValues].sort(),
        voice: { ...core.voice, traits: [...core.voice.traits].sort() },
        mission: core.mission,
        nonNegotiables: [...core.nonNegotiables].sort(),
    });
    return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

// ── Storage ──────────────────────────────────────────────────────

function ensureDir(): void {
    try { mkdirSync(dirname(IDENTITY_PATH), { recursive: true }); } catch { /* exists */ }
}

function save(identity: Identity): void {
    ensureDir();
    writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), 'utf-8');
}

/** Load identity from disk. Returns null if the file doesn't exist. */
export function loadIdentity(): Identity | null {
    if (!existsSync(IDENTITY_PATH)) return null;
    try {
        return JSON.parse(readFileSync(IDENTITY_PATH, 'utf-8')) as Identity;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to parse identity.json: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Initialize identity on first boot. Idempotent — returns existing
 * identity if one is already on disk.
 */
export function initIdentity(): Identity {
    const existing = loadIdentity();
    if (existing) {
        return touchSessionCount(existing);
    }
    const now = new Date().toISOString();
    const core = DEFAULT_IDENTITY_CORE;
    const identity: Identity = {
        core,
        tenure: {
            firstBootAt: now,
            sessionCount: 1,
            lastSessionAt: now,
            currentVersion: TITAN_VERSION,
            versionHistory: [{ version: TITAN_VERSION, at: now }],
        },
        coreHash: hashCore(core),
        driftLog: [],
        updatedAt: now,
        updatedBy: 'system:init',
    };
    save(identity);
    logger.info(COMPONENT, `Identity initialized — ${core.mission}`);
    return identity;
}

/** Increment session count + update tenure on boot. */
function touchSessionCount(id: Identity): Identity {
    const now = new Date().toISOString();
    id.tenure.sessionCount += 1;
    id.tenure.lastSessionAt = now;
    // Track version transitions so we can audit what TITAN-was versus
    // TITAN-is across ships.
    if (id.tenure.currentVersion !== TITAN_VERSION) {
        id.tenure.versionHistory.push({ version: TITAN_VERSION, at: now });
        id.tenure.currentVersion = TITAN_VERSION;
        logger.info(COMPONENT, `Version transition recorded: ${id.tenure.versionHistory.at(-2)?.version} → ${TITAN_VERSION}`);
    }
    // Re-hash core in case someone edited identity.json directly.
    const freshHash = hashCore(id.core);
    if (freshHash !== id.coreHash) {
        id.driftLog.push({
            at: now,
            kind: 'identity_hash_change',
            detail: `Core hash changed ${id.coreHash.slice(0, 22)} → ${freshHash.slice(0, 22)}. Someone (or something) edited identity.json.`,
            resolution: 'pending',
        });
        id.coreHash = freshHash;
    }
    id.updatedAt = now;
    id.updatedBy = 'system:boot';
    save(id);
    return id;
}

/**
 * Render the identity as a compact system-prompt block. Called by the
 * agent loop to inject "who you are" into every session.
 */
export function renderIdentityBlock(id: Identity): string {
    const lines: string[] = [];
    lines.push('── TITAN Identity (persistent across sessions) ──');
    lines.push(`Mission: ${id.core.mission}`);
    lines.push(`Voice: ${id.core.voice.persona}. Cadence: ${id.core.voice.cadence}.`);
    lines.push('Core values:');
    for (const v of id.core.coreValues) lines.push(`  • ${v}`);
    lines.push('Non-negotiables (never violate):');
    for (const nn of id.core.nonNegotiables) lines.push(`  • ${nn}`);
    lines.push(`Tenure: session #${id.tenure.sessionCount}, running TITAN v${id.tenure.currentVersion} since first boot ${id.tenure.firstBootAt.slice(0, 10)}.`);
    if (id.driftLog.filter(e => e.resolution === 'pending').length > 0) {
        const pending = id.driftLog.filter(e => e.resolution === 'pending').length;
        lines.push(`⚠️  ${pending} unresolved drift event(s) — review identity.json.`);
    }
    return lines.join('\n');
}

// ── Drift detection ──────────────────────────────────────────────

/**
 * Record a drift event. Called by the drift detector (future) when it
 * spots a mismatch between recent behavior and coreValues. We keep the
 * log bounded at 200 entries — older events roll off.
 */
export function recordDrift(
    kind: DriftEvent['kind'],
    detail: string,
    evidence?: string,
): void {
    const id = loadIdentity();
    if (!id) return;
    id.driftLog.push({
        at: new Date().toISOString(),
        kind,
        detail,
        evidence,
        resolution: 'pending',
    });
    if (id.driftLog.length > 200) id.driftLog = id.driftLog.slice(-200);
    id.updatedAt = new Date().toISOString();
    id.updatedBy = 'drift-detector';
    save(id);
    logger.warn(COMPONENT, `Drift: ${kind} — ${detail}`);
}

/** Mark a drift event as resolved (human action). */
export function resolveDrift(indexFromEnd: number, resolution: 'accepted' | 'rejected', note?: string): boolean {
    const id = loadIdentity();
    if (!id) return false;
    const idx = id.driftLog.length - 1 - indexFromEnd;
    if (idx < 0 || idx >= id.driftLog.length) return false;
    id.driftLog[idx].resolution = resolution;
    if (note) id.driftLog[idx].detail += `\n[resolved: ${note}]`;
    id.updatedAt = new Date().toISOString();
    id.updatedBy = 'human:resolve';
    save(id);
    return true;
}

// ── Public accessors ─────────────────────────────────────────────

export function getIdentity(): Identity | null {
    return loadIdentity();
}

export function getIdentityPath(): string {
    return IDENTITY_PATH;
}
