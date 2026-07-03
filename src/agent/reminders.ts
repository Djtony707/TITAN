/**
 * Reminders — "remind me Friday at 5pm" that actually fires (v7.0).
 *
 * User-testing exposed the gap: models CLAIMED to set reminders because the
 * natural tool didn't exist (cron schedules shell commands, not "tell ME a
 * thing at a time"). This is that tool's engine: a tiny persistent store +
 * a 60s daemon watcher. Due reminders fire through the heartbeat note
 * channel, so the mascot speaks them — and they show anywhere heartbeat
 * notes show. No new UI, no LLM calls, deterministic.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Reminders';
const FILE = () => join(TITAN_HOME, 'reminders.json');
export const CHECK_INTERVAL_MS = 60_000;

export interface Reminder {
    id: string;
    message: string;
    /** ISO 8601 — when to fire. */
    dueAt: string;
    createdAt: string;
    firedAt?: string;
}

function readAll(): Reminder[] {
    try {
        if (!existsSync(FILE())) return [];
        const raw = JSON.parse(readFileSync(FILE(), 'utf-8'));
        return Array.isArray(raw) ? raw as Reminder[] : [];
    } catch {
        return [];
    }
}

function writeAll(reminders: Reminder[]): void {
    try {
        mkdirSync(dirname(FILE()), { recursive: true });
        // Keep the file bounded: drop fired reminders older than 30 days.
        const cutoff = Date.now() - 30 * 86_400_000;
        const kept = reminders.filter(r => !r.firedAt || new Date(r.firedAt).getTime() > cutoff);
        writeFileSync(FILE(), JSON.stringify(kept, null, 2));
    } catch (err) {
        logger.warn(COMPONENT, `Could not persist reminders: ${(err as Error).message}`);
    }
}

export function addReminder(message: string, dueAtIso: string): Reminder | { error: string } {
    const due = new Date(dueAtIso);
    if (isNaN(due.getTime())) return { error: `Not a valid date/time: "${dueAtIso}". Use ISO 8601, e.g. 2026-06-12T17:00:00-07:00.` };
    if (due.getTime() < Date.now() - 60_000) return { error: `That time is in the past (${due.toLocaleString()}).` };
    const trimmed = message.trim();
    if (!trimmed) return { error: 'Reminder message is empty.' };
    const reminder: Reminder = {
        id: `rem-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        message: trimmed.slice(0, 300),
        dueAt: due.toISOString(),
        createdAt: new Date().toISOString(),
    };
    const all = readAll();
    all.push(reminder);
    writeAll(all);
    logger.info(COMPONENT, `Reminder set: "${reminder.message}" at ${reminder.dueAt}`);
    return reminder;
}

export function listReminders(includeFired = false): Reminder[] {
    const all = readAll();
    return (includeFired ? all : all.filter(r => !r.firedAt))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export function cancelReminder(id: string): boolean {
    const all = readAll();
    const next = all.filter(r => r.id !== id && !(id === 'all' && !r.firedAt));
    if (next.length === all.length) return false;
    writeAll(next);
    return true;
}

/** Pure: which pending reminders are due at `now`? Exported for tests. */
export function dueReminders(all: Reminder[], now: number): Reminder[] {
    return all.filter(r => !r.firedAt && new Date(r.dueAt).getTime() <= now);
}

/** One watcher pass: fire anything due via the heartbeat/mascot channel. */
export async function checkReminders(now: number = Date.now()): Promise<number> {
    const all = readAll();
    const due = dueReminders(all, now);
    if (due.length === 0) return 0;
    const { speakNote } = await import('./heartbeat.js');
    for (const r of due) {
        speakNote(`⏰ Reminder: ${r.message}`);
        r.firedAt = new Date(now).toISOString();
        logger.info(COMPONENT, `Fired reminder ${r.id}: ${r.message}`);
    }
    writeAll(all);
    return due.length;
}

/** Register the 60s due-check on the daemon (same lifecycle as heartbeat). */
export function registerReminderWatcher(): void {
    import('./daemon.js').then(({ registerWatcher }) => {
        registerWatcher('reminders', async () => { await checkReminders(); }, CHECK_INTERVAL_MS);
        logger.info(COMPONENT, 'Reminder watcher registered (every 60s)');
    }).catch(err => logger.warn(COMPONENT, `Register failed: ${(err as Error).message}`));
    // The daemon defaults to disabled — reminders must fire regardless, so run
    // a self-owned timer when the daemon never starts (v7.0 review finding).
    import('../config/config.js').then(({ loadConfig }) => {
        const cfg = loadConfig() as { daemon?: { enabled?: boolean } };
        if (cfg.daemon?.enabled !== true) {
            setInterval(() => { checkReminders().catch(() => {}); }, CHECK_INTERVAL_MS).unref();
            logger.info(COMPONENT, 'Daemon disabled — reminders running on their own 60s timer');
        }
    }).catch(() => {});
}
