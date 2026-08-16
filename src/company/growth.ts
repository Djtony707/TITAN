/**
 * TITAN — Growth moments + huddle digest (v8 Slice 8)
 *
 * The social layer: the surfaces that make the company FEEL like a team of
 * colleagues rather than a control panel (north star doc). Everything here
 * is a deterministic derivation over the signed company log — no model
 * calls, no stored state, nothing to migrate. Same fold-from-truth pattern
 * as queue.ts / brain.ts.
 *
 * Growth moments: celebration-worthy events, newest first —
 *   hire, first accepted task, lesson shared, acceptance streak, farewell.
 * Huddle digest: a standup-shaped snapshot of the recent window —
 *   per-agent open/accepted work, fresh lessons, roster changes.
 */
import type { CompanyEvent, CompanyLog } from './log.js';
import { foldBrain } from './brain.js';
import { companyRoster } from './hiring.js';

export type GrowthMomentKind = 'hired' | 'first-accept' | 'lesson' | 'streak' | 'retired';

export interface GrowthMoment {
    ts: number;
    kind: GrowthMomentKind;
    agentId: string;
    /** Ready-to-render line ("Quill joined the company as writing"). */
    text: string;
}

const STREAK_THRESHOLD = 3;

/** Display name lookup that tolerates unknown/legacy ids. */
function nameOf(log: CompanyLog, agentId: string): string {
    const m = companyRoster(log).find(r => r.agentId === agentId);
    return m?.displayName ?? agentId;
}

/**
 * Derive growth moments from the full log, newest first. Deterministic:
 * the same log always renders the same feed.
 */
export function growthMoments(log: CompanyLog, limit = 20): GrowthMoment[] {
    const events = log.readAll();
    const moments: GrowthMoment[] = [];
    const accepted = new Map<string, number>();          // owner → accepted count
    const streak = new Map<string, number>();            // owner → current streak
    const taskOwner = new Map<string, string>();         // taskRef → owner

    for (const e of events) {
        const p = e.payload as Record<string, unknown>;
        switch (e.kind) {
            case 'agent.hired': {
                const id = String(p.agentId);
                moments.push({
                    ts: e.ts, kind: 'hired', agentId: id,
                    text: `${String(p.displayName ?? id)} joined the company as ${String(p.role ?? 'a specialist')}`,
                });
                break;
            }
            case 'agent.retired': {
                const id = String(p.agentId);
                moments.push({
                    ts: e.ts, kind: 'retired', agentId: id,
                    text: `${nameOf(log, id)} wrapped up — ${String(p.reason ?? 'assignment complete')}`,
                });
                break;
            }
            case 'brain.entry': {
                if (p.entryKind === 'lesson' && p.scope === 'company') {
                    const text = String(p.text ?? '');
                    moments.push({
                        ts: e.ts, kind: 'lesson', agentId: e.actor,
                        text: `${nameOf(log, e.actor)} learned a pattern: ${text.length > 90 ? `${text.slice(0, 90)}…` : text}`,
                    });
                }
                break;
            }
            case 'task.delegated': {
                // The taskRef IS the delegation event's id (queue fold contract).
                taskOwner.set(e.id, String(p.to ?? ''));
                break;
            }
            case 'task.checked': {
                const ref = String(p.taskRef ?? '');
                const owner = taskOwner.get(ref);
                const verdict = String(p.verdict ?? '');
                if (!owner) break;
                if (verdict === 'accepted') {
                    const n = (accepted.get(owner) ?? 0) + 1;
                    accepted.set(owner, n);
                    const s = (streak.get(owner) ?? 0) + 1;
                    streak.set(owner, s);
                    if (n === 1) {
                        moments.push({
                            ts: e.ts, kind: 'first-accept', agentId: owner,
                            text: `${nameOf(log, owner)} shipped their first accepted task`,
                        });
                    } else if (s === STREAK_THRESHOLD) {
                        moments.push({
                            ts: e.ts, kind: 'streak', agentId: owner,
                            text: `${nameOf(log, owner)} is on a roll — ${STREAK_THRESHOLD} accepted in a row`,
                        });
                    }
                } else {
                    streak.set(owner, 0);
                }
                break;
            }
        }
    }
    return moments.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.min(limit, 100)));
}

// ── Huddle digest ────────────────────────────────────────────────────────

export interface HuddleAgentLine {
    agentId: string;
    displayName: string;
    accepted: number;
    open: number;
    lessons: number;
}

export interface HuddleDigest {
    generatedAt: number;
    windowStartTs: number;
    agents: HuddleAgentLine[];
    freshLessons: Array<{ agentId: string; text: string }>;
    rosterChanges: string[];
    /** Rendered standup-shaped markdown for chat/CLI surfaces. */
    rendered: string;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The huddle: a standup-shaped digest of the last window (default 24h),
 * derived from the log. Deterministic given (log, now, windowMs).
 */
export function huddleDigest(log: CompanyLog, opts: { now?: number; windowMs?: number } = {}): HuddleDigest {
    const now = opts.now ?? Date.now();
    const windowStartTs = now - (opts.windowMs ?? DEFAULT_WINDOW_MS);
    const events = log.readAll();
    const recent = events.filter(e => e.ts >= windowStartTs);
    const fold = foldBrain(events);
    const roster = companyRoster(log);

    const lines = new Map<string, HuddleAgentLine>();
    const line = (agentId: string): HuddleAgentLine => {
        let l = lines.get(agentId);
        if (!l) {
            l = {
                agentId,
                displayName: roster.find(r => r.agentId === agentId)?.displayName ?? agentId,
                accepted: 0, open: 0, lessons: 0,
            };
            lines.set(agentId, l);
        }
        return l;
    };

    const taskOwner = new Map<string, string>();
    for (const e of events) {
        if (e.kind === 'task.delegated') {
            // The taskRef IS the delegation event's id (queue fold contract).
            taskOwner.set(e.id, String((e.payload as Record<string, unknown>).to ?? ''));
        }
    }
    const checked = new Set<string>();
    for (const e of events) {
        if (e.kind === 'task.checked') checked.add(String((e.payload as Record<string, unknown>).taskRef ?? ''));
    }
    // Open = delegated-but-unchecked, attributed to owner (whole log, not window).
    for (const [ref, owner] of taskOwner) {
        if (owner && !checked.has(ref)) line(owner).open++;
    }

    const freshLessons: HuddleDigest['freshLessons'] = [];
    const rosterChanges: string[] = [];
    for (const e of recent) {
        const p = e.payload as Record<string, unknown>;
        switch (e.kind) {
            case 'task.checked': {
                const owner = taskOwner.get(String(p.taskRef ?? ''));
                if (owner && String(p.verdict ?? '') === 'accepted') line(owner).accepted++;
                break;
            }
            case 'brain.entry': {
                if (p.entryKind === 'lesson' && p.scope === 'company') {
                    line(e.actor).lessons++;
                    const entry = fold.entries.get(e.id);
                    if (entry && !entry.tombstoned) {
                        freshLessons.push({ agentId: e.actor, text: String(p.text ?? '').slice(0, 140) });
                    }
                }
                break;
            }
            case 'agent.hired':
                rosterChanges.push(`+ ${String(p.displayName ?? p.agentId)} (${String(p.role ?? '')})`);
                break;
            case 'agent.retired':
                rosterChanges.push(`− ${String(p.agentId)} (${String(p.reason ?? '')})`);
                break;
        }
    }

    const agents = [...lines.values()]
        .filter(l => l.accepted > 0 || l.open > 0 || l.lessons > 0)
        .sort((a, b) => b.accepted - a.accepted || b.open - a.open || a.agentId.localeCompare(b.agentId));

    const parts: string[] = ['## Huddle'];
    if (agents.length === 0 && freshLessons.length === 0 && rosterChanges.length === 0) {
        parts.push('Quiet day — no accepted work, open tasks, or new lessons in the window.');
    } else {
        for (const a of agents) {
            const bits: string[] = [];
            if (a.accepted) bits.push(`${a.accepted} accepted`);
            if (a.open) bits.push(`${a.open} open`);
            if (a.lessons) bits.push(`${a.lessons} lesson${a.lessons > 1 ? 's' : ''}`);
            parts.push(`- **${a.displayName}** — ${bits.join(', ')}`);
        }
        if (freshLessons.length > 0) {
            parts.push('', 'Fresh lessons:');
            for (const l of freshLessons.slice(0, 5)) parts.push(`- ${l.agentId}: ${l.text}`);
        }
        if (rosterChanges.length > 0) {
            parts.push('', `Roster: ${rosterChanges.join(' · ')}`);
        }
    }
    return {
        generatedAt: now, windowStartTs, agents, freshLessons, rosterChanges,
        rendered: parts.join('\n'),
    };
}

// Referenced for type completeness of the fold import (tombstone filtering).
export type { CompanyEvent };
