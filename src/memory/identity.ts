/**
 * TITAN persistent identity.
 *
 * This is intentionally local and boring: a small JSON document in TITAN_HOME
 * that lets the running agent know its mission, non-negotiables, tenure, and
 * any unresolved identity drift. It never calls models or tools.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { TITAN_HOME, TITAN_VERSION } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Identity';
const IDENTITY_PATH = join(TITAN_HOME, 'identity.json');
const MAX_DRIFT_EVENTS = 200;

export type DriftKind = 'identity_hash_change' | 'voice_drift' | 'values_divergence' | 'mission_drift' | 'operator_note';
export type DriftResolution = 'pending' | 'accepted' | 'rejected' | 'resolved';

export interface DriftEvent {
    id: string;
    at: string;
    kind: DriftKind;
    detail: string;
    evidence?: string;
    resolution: DriftResolution;
    resolvedAt?: string;
    resolutionNote?: string;
}

export interface TitanIdentity {
    core: {
        mission: string;
        coreValues: string[];
        nonNegotiables: string[];
    };
    tenure: {
        firstBootAt: string;
        lastBootAt: string;
        sessionCount: number;
        currentVersion: string;
        versionHistory: Array<{ version: string; firstSeenAt: string }>;
    };
    coreHash: string;
    driftLog: DriftEvent[];
}

let cache: TitanIdentity | null = null;

function now(): string {
    return new Date().toISOString();
}

function ensureDir(): void {
    mkdirSync(dirname(IDENTITY_PATH), { recursive: true });
}

function hashCore(core: TitanIdentity['core']): string {
    const canonical = JSON.stringify({
        mission: core.mission,
        coreValues: core.coreValues,
        nonNegotiables: core.nonNegotiables,
    });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function defaultIdentity(): TitanIdentity {
    const at = now();
    const core: TitanIdentity['core'] = {
        mission: 'Operate as a local-first autonomous AI agent framework that helps Tony get real work done safely, truthfully, and audibly.',
        coreValues: ['truthfulness', 'operator control', 'local-first reliability', 'auditability'],
        nonNegotiables: [
            'Do not execute risky actions without the required approval.',
            'Do not store or reveal secrets in plaintext.',
            'Do not claim work is complete unless it was verified.',
            'Do not use Claude Code as a TITAN runtime provider or adapter.',
        ],
    };
    return {
        core,
        tenure: {
            firstBootAt: at,
            lastBootAt: at,
            sessionCount: 1,
            currentVersion: TITAN_VERSION,
            versionHistory: [{ version: TITAN_VERSION, firstSeenAt: at }],
        },
        coreHash: hashCore(core),
        driftLog: [],
    };
}

function saveIdentity(id: TitanIdentity): void {
    ensureDir();
    writeFileSync(IDENTITY_PATH, `${JSON.stringify(id, null, 2)}\n`, 'utf-8');
    cache = id;
}

export function getIdentityPath(): string {
    return IDENTITY_PATH;
}

export function loadIdentity(): TitanIdentity | null {
    if (!existsSync(IDENTITY_PATH)) {
        cache = null;
        return null;
    }
    try {
        cache = JSON.parse(readFileSync(IDENTITY_PATH, 'utf-8')) as TitanIdentity;
        return cache;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to load identity.json: ${(err as Error).message}`);
        return null;
    }
}

export function initIdentity(): TitanIdentity {
    const existing = loadIdentity();
    if (!existing) {
        const created = defaultIdentity();
        saveIdentity(created);
        return created;
    }

    const id = existing;
    const currentHash = hashCore(id.core);
    if (id.coreHash && id.coreHash !== currentHash) {
        id.driftLog.push({
            id: randomUUID(),
            at: now(),
            kind: 'identity_hash_change',
            detail: 'Persistent identity core changed outside normal initialization.',
            evidence: `stored=${id.coreHash}; current=${currentHash}`,
            resolution: 'pending',
        });
        id.driftLog = id.driftLog.slice(-MAX_DRIFT_EVENTS);
    }
    id.coreHash = currentHash;
    id.tenure.sessionCount = (id.tenure.sessionCount || 0) + 1;
    id.tenure.lastBootAt = now();
    if (id.tenure.currentVersion !== TITAN_VERSION) {
        id.tenure.currentVersion = TITAN_VERSION;
        id.tenure.versionHistory.push({ version: TITAN_VERSION, firstSeenAt: now() });
    }
    saveIdentity(id);
    return id;
}

export function getIdentity(): TitanIdentity | null {
    return loadIdentity();
}

export function recordDrift(kind: DriftKind, detail: string, evidence?: string): DriftEvent | null {
    const id = loadIdentity() ?? initIdentity();
    const event: DriftEvent = { id: randomUUID(), at: now(), kind, detail, evidence, resolution: 'pending' };
    id.driftLog.push(event);
    id.driftLog = id.driftLog.slice(-MAX_DRIFT_EVENTS);
    saveIdentity(id);
    return event;
}

export function resolveDrift(indexFromEnd: number, resolution: Exclude<DriftResolution, 'pending'>, note?: string): boolean {
    const id = loadIdentity();
    if (!id) return false;
    const index = id.driftLog.length - 1 - indexFromEnd;
    const event = id.driftLog[index];
    if (!event) return false;
    event.resolution = resolution;
    event.resolvedAt = now();
    event.resolutionNote = note;
    saveIdentity(id);
    return true;
}

export function renderIdentityBlock(id: TitanIdentity = initIdentity()): string {
    const pending = id.driftLog.filter(d => d.resolution === 'pending');
    return [
        '## Persistent TITAN Identity',
        `Mission: ${id.core.mission}`,
        `Core values: ${id.core.coreValues.join(', ')}`,
        `Non-negotiables: ${id.core.nonNegotiables.join('; ')}`,
        `Tenure: session #${id.tenure.sessionCount}, first boot ${id.tenure.firstBootAt}, version ${id.tenure.currentVersion}`,
        pending.length ? `Warning: ${pending.length} unresolved drift event(s). Latest: ${pending.at(-1)?.kind} - ${pending.at(-1)?.detail}` : 'No unresolved drift event.',
    ].join('\n');
}

export function _resetIdentityCacheForTests(): void {
    cache = null;
}
