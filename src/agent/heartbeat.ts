/**
 * TITAN Heartbeat — the pulse that makes the agent ALIVE (v7.0).
 *
 * Modeled on what makes OpenClaw/Hermes feel inhabited: every ~30 minutes the
 * agent wakes, looks at its world (advisories, missions, drives, time of day),
 * and decides whether there is ONE thing worth telling its human right now.
 * If yes → a short note is persisted + announced (the mascot speaks it, and
 * it's available to any channel). If no → HEARTBEAT_OK, total silence.
 *
 * This is deliberately the opposite of a notification firehose: one fast-tier
 * LLM call per beat, one sentence max, silence is the default. The point is
 * that TITAN sometimes speaks FIRST — that single behavior separates a tool
 * you operate from a companion that lives on your machine.
 *
 * Model-agnostic (router tiers); never shells any CLI.
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { titanEvents } from './daemon.js';

const COMPONENT = 'Heartbeat';
const NOTES_FILE = () => join(TITAN_HOME, 'heartbeats.jsonl');
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export interface HeartbeatNote {
    at: string;
    message: string;
}

export function latestHeartbeat(): HeartbeatNote | null {
    try {
        const f = NOTES_FILE();
        if (!existsSync(f)) return null;
        const lines = readFileSync(f, 'utf-8').trim().split('\n');
        if (lines.length === 0) return null;
        return JSON.parse(lines[lines.length - 1]) as HeartbeatNote;
    } catch {
        return null;
    }
}

function persistNote(note: HeartbeatNote): void {
    try {
        mkdirSync(dirname(NOTES_FILE()), { recursive: true });
        appendFileSync(NOTES_FILE(), JSON.stringify(note) + '\n');
    } catch (err) {
        logger.warn(COMPONENT, `Could not persist note: ${(err as Error).message}`);
    }
}

/** Gather the small world-snapshot the beat reasons over. All best-effort. */
async function gatherContext(): Promise<string> {
    const parts: string[] = [];
    const hour = new Date().getHours();
    parts.push(`Local time: ${new Date().toLocaleString()} (hour ${hour}).`);

    try {
        const { readRecentAdvisories } = await import('./somaInitiative.js');
        const advisories = readRecentAdvisories('default-user', 3);
        if (advisories.length) {
            parts.push(`Pending suggestions Soma has queued (never yet shown to the user): ${JSON.stringify(advisories).slice(0, 600)}`);
        }
    } catch { /* optional */ }

    try {
        const { listAllDrivers } = await import('./goalDriver.js');
        const all = listAllDrivers();
        const active = all.filter(d => !['done', 'failed', 'cancelled'].includes(d.phase)).length;
        const cutoff = Date.now() - 6 * 3600_000;
        const recentDone = all.filter(d => d.phase === 'done' && new Date(d.history?.[d.history.length - 1]?.at ?? d.startedAt).getTime() >= cutoff).length;
        if (active || recentDone) parts.push(`Missions: ${active} active, ${recentDone} finished in the last 6h.`);
    } catch { /* optional */ }

    try {
        const f = join(TITAN_HOME, 'drive-state.json');
        if (existsSync(f)) {
            const raw = JSON.parse(readFileSync(f, 'utf-8')) as { latest?: { dominantDrives?: string[] } };
            if (raw.latest?.dominantDrives?.length) parts.push(`Current dominant drive: ${raw.latest.dominantDrives[0]}.`);
        }
    } catch { /* optional */ }

    const last = latestHeartbeat();
    if (last) parts.push(`Your previous note (NEVER repeat it or anything close to it): "${last.message}" at ${last.at}.`);
    return parts.join('\n');
}

/**
 * Run one beat. Returns the note when the agent chose to speak, else null.
 * Exposed for the manual POST /api/heartbeat/beat trigger + tests.
 */
export async function runHeartbeat(): Promise<HeartbeatNote | null> {
    const ctx = await gatherContext();
    const { spawnSubAgent } = await import('./subAgent.js');
    const result = await spawnSubAgent({
        name: 'heartbeat',
        task: [
            'You are TITAN\'s heartbeat — a quiet pulse deciding if ANYTHING is worth telling your human (Tony) right now, unprompted.',
            '',
            'WORLD STATE:',
            ctx,
            '',
            'RULES:',
            '- Default to silence. If there is nothing genuinely useful, timely, or delightful to say, reply with exactly: HEARTBEAT_OK',
            '- Otherwise reply with ONE short, friendly, concrete message (max 140 characters) in TITAN\'s voice — a companion on the desk, not a notification system. No jargon, no "Soma", no markdown.',
            '- Worth speaking for: a finished mission he hasn\'t seen, a genuinely useful pending suggestion, something time-relevant. NOT worth it: status filler, greetings, anything resembling the previous note.',
            '- Between 11pm and 7am local time, reply HEARTBEAT_OK unless something FINISHED.',
        ].join('\n'),
        tier: 'fast',
        maxRounds: 1,
    });

    const text = (result.content || '').trim();
    if (!text || /HEARTBEAT_OK/i.test(text)) {
        logger.debug(COMPONENT, 'Beat: nothing to say (OK)');
        return null;
    }
    const note: HeartbeatNote = { at: new Date().toISOString(), message: text.slice(0, 200) };
    persistNote(note);
    try { titanEvents.emit('heartbeat:note', note); } catch { /* never fatal */ }
    logger.info(COMPONENT, `Beat spoke: ${note.message}`);
    return note;
}

/** Register the beat on the daemon. Gated on daemon.enabled (same lifecycle). */
export function registerHeartbeat(): void {
    try {
        const cfg = loadConfig() as { daemon?: { enabled?: boolean } };
        if (cfg.daemon?.enabled === false) {
            logger.info(COMPONENT, 'Daemon disabled — heartbeat not registered');
            return;
        }
    } catch { /* config unavailable — register anyway, daemon gates execution */ }
    const interval = Number(process.env.TITAN_HEARTBEAT_MS) || DEFAULT_INTERVAL_MS;
    import('./daemon.js').then(({ registerWatcher }) => {
        registerWatcher('heartbeat', async () => { await runHeartbeat(); }, interval);
        logger.info(COMPONENT, `Heartbeat registered (every ${Math.round(interval / 60000)}m)`);
    }).catch(err => logger.warn(COMPONENT, `Register failed: ${(err as Error).message}`));
}
