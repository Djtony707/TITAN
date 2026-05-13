/**
 * TITAN — Plays (v6.1.0)
 *
 * A "Play" is a saved team configuration tied to a kind of mission:
 * which specialists to bring, in what order they typically work, what
 * the headline artifact looks like, what the success criteria are.
 *
 * Plays are the answer to "how do you compose a team without making
 * the user think like a programmer." For the common cases (draft an
 * update, plan an event, review code), the user types the goal and we
 * match a Play by keyword — no LLM call needed to form the team. For
 * the long tail, the planner falls back to an LLM call that returns
 * one of these Plays (or a custom team) as a structured answer.
 *
 * Plays are NOT a workflow engine. They don't dictate order. The goal
 * driver still owns subtask scheduling. A Play just says "for this kind
 * of mission, here's the right cast."
 *
 * Built-in Plays live in this file. User-saved Plays land in
 * `~/.titan/plays/*.json` (loaded on demand). User Plays take priority
 * over built-ins when both match.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';
import { PLAYS_DIR } from '../utils/constants.js';

const COMPONENT = 'Plays';

// ── Types ──────────────────────────────────────────────────────────

export type ArtifactFormat = 'markdown' | 'plan' | 'list' | 'code-diff' | 'report';

export interface Play {
    /** Stable id. Lowercase, dash-separated. */
    id: string;
    /** Friendly title shown in the banner ("Investor update"). */
    title: string;
    /** One-line description used in tooltips + Play picker. */
    description: string;
    /** Specialist IDs to invite, in the order they typically activate. */
    team: string[];
    /** What kind of artifact this Play produces — drives the rendering
     *  of the inline document card. */
    artifactFormat: ArtifactFormat;
    /** Suggested artifact title — the heading in the live document. */
    artifactTitle?: string;
    /**
     * Keyword/phrase patterns. If ANY pattern (lowercased, substring or
     * regex) matches the goal, this Play matches. Specific Plays should
     * use precise patterns; the generic fallback Play has no patterns
     * and is returned as a last resort.
     */
    patterns: Array<string | RegExp>;
    /**
     * Optional weighting for tiebreakers when multiple Plays match.
     * Higher = preferred. Defaults to 1.
     */
    priority?: number;
    /** Built-in vs user-saved. Set automatically when loaded. */
    source?: 'builtin' | 'user';
}

/** Resolved team member — what missionRoom.createMission expects. */
export interface ResolvedTeamMember {
    agentId: string;
    name: string;
}

// ── Built-in roster (specialist id → display name) ─────────────────
//
// Pulled from src/agent/specialists.ts but flattened here so plays.ts
// doesn't have to load the full specialist module (which pulls in
// config, agent scope, etc — expensive at startup). When SPECIALISTS
// gains a new id, mirror it here.

const KNOWN_AGENTS: Record<string, string> = {
    scout:   'Scout',
    builder: 'Builder',
    writer:  'Writer',
    analyst: 'Analyst',
    sage:    'Sage',
};

// ── Built-in Plays ─────────────────────────────────────────────────

const BUILTIN_PLAYS: Play[] = [
    {
        id: 'investor-update',
        title: 'Investor / stakeholder update',
        description: 'Draft a clean investor or board update with the numbers and a sober risks section.',
        team: ['scout', 'analyst', 'writer', 'sage'],
        artifactFormat: 'markdown',
        artifactTitle: 'Investor Update',
        patterns: [
            /\binvestor\b/i,
            /\bboard\s+(?:update|memo|deck|email)\b/i,
            /\bquarterly\s+(?:update|letter|memo)\b/i,
            /\bstakeholder\s+update\b/i,
            'shareholder update',
        ],
        priority: 3,
    },
    {
        id: 'code-review',
        title: 'Code review',
        description: 'Read a PR or change, flag bugs and security issues, suggest concrete fixes.',
        team: ['scout', 'builder', 'sage'],
        artifactFormat: 'report',
        artifactTitle: 'Code Review',
        patterns: [
            /\bcode\s+review\b/i,
            /\breview\b.{0,40}\bpr\b/i,
            /\breview\s+(?:the\s+)?(?:refactor|change|patch|diff|commit|branch)\b/i,
            /\bpull\s+request\b/i,
            /\bauth\s+refactor\b/i,
        ],
        priority: 3,
    },
    {
        id: 'bug-triage',
        title: 'Bug triage',
        description: 'Investigate a bug, locate the root cause, propose a fix.',
        team: ['scout', 'analyst', 'builder', 'sage'],
        artifactFormat: 'report',
        artifactTitle: 'Bug Triage',
        patterns: [
            /\btriage\b/i,
            /\bdebug\b/i,
            /\bfind\s+(?:the\s+)?bug\b/i,
            /\bwhy\s+is\s+.{2,40}\s+(?:failing|broken|crashing|erroring)\b/i,
            /\broot\s*cause\b/i,
        ],
        priority: 3,
    },
    {
        id: 'sales-email',
        title: 'Sales outreach email',
        description: 'Draft a short, well-targeted outreach email — research the recipient, write, polish.',
        team: ['scout', 'writer'],
        artifactFormat: 'markdown',
        artifactTitle: 'Outreach Email',
        patterns: [
            /\bsales\s+(?:email|outreach|message)\b/i,
            /\bcold\s+email\b/i,
            /\boutreach\b/i,
            /\bprospect(?:ing)?\b/i,
        ],
        priority: 2,
    },
    {
        id: 'thank-you',
        title: 'Thank-you / personal note',
        description: 'A short, warm note — landlord, neighbor, coworker. Single-pass draft + polish.',
        team: ['writer'],
        artifactFormat: 'markdown',
        artifactTitle: 'Note',
        patterns: [
            /\bthank[- ]?you\b/i,
            /\bthank\s+(?:my|the)\b/i,
            /\bappreciate\b/i,
            /\bcondolences?\b/i,
            /\bsorry\s+(?:to|for)\b/i,
        ],
        priority: 2,
    },
    {
        id: 'event-plan',
        title: 'Event / party plan',
        description: 'Build a small plan — guest list, food, timeline — for a personal event.',
        team: ['scout', 'writer'],
        artifactFormat: 'plan',
        artifactTitle: 'Plan',
        patterns: [
            /\b(?:plan|organize|put together)\s+.{0,30}\b(?:party|birthday|wedding|trip|vacation|event|dinner|baby\s+shower)\b/i,
            /\bbirthday\s+(?:party|plan)\b/i,
            /\b(?:bachelor|bachelorette)\b/i,
            /\bweekend\s+getaway\b/i,
        ],
        priority: 2,
    },
    {
        id: 'summarize',
        title: 'Summarize this',
        description: 'Read a long thing and produce a tight summary with the key points.',
        team: ['scout', 'writer'],
        artifactFormat: 'markdown',
        artifactTitle: 'Summary',
        patterns: [
            /\bsummari[sz]e\b/i,
            /\btl;?dr\b/i,
            /\bquick\s+summary\b/i,
            /\bcondense\b/i,
        ],
        priority: 2,
    },
    {
        id: 'market-research',
        title: 'Market / competitive research',
        description: 'Gather facts about a market or competitor, structure them, draw conclusions.',
        team: ['scout', 'analyst', 'writer', 'sage'],
        artifactFormat: 'report',
        artifactTitle: 'Research Report',
        patterns: [
            /\bmarket\s+research\b/i,
            /\bcompetit(?:ive|or)\s+(?:analysis|research|landscape)\b/i,
            /\bwhat\s+(?:does|do)\s+.{2,30}\s+do\b/i,
            /\bresearch\s+(?:the|this|that)\s+(?:company|market|space|industry|product)\b/i,
        ],
        priority: 2,
    },
    {
        id: 'content-post',
        title: 'Social post / short content',
        description: 'Draft a punchy social post or short-form content in matching voice.',
        team: ['writer', 'sage'],
        artifactFormat: 'markdown',
        artifactTitle: 'Post',
        patterns: [
            /\b(?:facebook|twitter|x|linkedin|tiktok|instagram)\s+post\b/i,
            /\bsocial\s+(?:media\s+)?post\b/i,
            /\btweet\b/i,
            /\bdraft\s+a\s+post\b/i,
        ],
        priority: 2,
    },
    {
        id: 'launch-plan',
        title: 'Launch / release plan',
        description: 'Plan a launch — checklist, owners, comms, day-of timeline.',
        team: ['scout', 'analyst', 'writer', 'sage'],
        artifactFormat: 'plan',
        artifactTitle: 'Launch Plan',
        patterns: [
            /\b(?:plan|organize)\s+(?:a\s+)?launch\b/i,
            /\blaunch\s+(?:plan|sequence|checklist)\b/i,
            /\brelease\s+plan\b/i,
            /\bgo[- ]?to[- ]?market\b/i,
        ],
        priority: 2,
    },
    // The generic catch-all. No patterns — only chosen when nothing else
    // matches. Smallest viable team that still produces a decent result.
    {
        id: 'generic',
        title: 'General request',
        description: 'A small, balanced team for any goal that doesn\'t match a specific Play.',
        team: ['scout', 'writer', 'sage'],
        artifactFormat: 'markdown',
        artifactTitle: 'Working Document',
        patterns: [], // never matches by pattern — only used as fallback
        priority: 0,
    },
];

// Mark builtin source for inspection.
for (const p of BUILTIN_PLAYS) p.source = 'builtin';

// ── User-saved Plays loader ────────────────────────────────────────

/** Load user-saved Plays from PLAYS_DIR. Safe to call repeatedly. */
export function loadUserPlays(): Play[] {
    if (!existsSync(PLAYS_DIR)) return [];
    let files: string[];
    try { files = readdirSync(PLAYS_DIR).filter(f => f.endsWith('.json')); }
    catch { return []; }
    const out: Play[] = [];
    for (const f of files) {
        try {
            const parsed = JSON.parse(readFileSync(join(PLAYS_DIR, f), 'utf-8')) as Play;
            if (!parsed.id || !parsed.team || !Array.isArray(parsed.team)) {
                logger.warn(COMPONENT, `Skipping malformed user play ${f}`);
                continue;
            }
            // Rehydrate patterns: stored as strings, we accept regex via a
            // leading "re:" prefix.
            const rawPatterns = (parsed.patterns ?? []) as unknown[];
            const patterns: Array<string | RegExp> = [];
            for (const p of rawPatterns) {
                if (typeof p === 'string') {
                    if (p.startsWith('re:')) {
                        try { patterns.push(new RegExp(p.slice(3), 'i')); }
                        catch { patterns.push(p.slice(3)); }
                    } else {
                        patterns.push(p);
                    }
                }
            }
            parsed.patterns = patterns;
            parsed.source = 'user';
            out.push(parsed);
        } catch (err) {
            logger.warn(COMPONENT, `Failed to load user play ${f}: ${(err as Error).message}`);
        }
    }
    return out;
}

// ── Public API ─────────────────────────────────────────────────────

/** Return all known plays — user plays first, then builtins. */
export function listPlays(): Play[] {
    return [...loadUserPlays(), ...BUILTIN_PLAYS];
}

/** Lookup a play by id, user-first. */
export function getPlay(id: string): Play | null {
    return listPlays().find(p => p.id === id) ?? null;
}

/**
 * Match a goal string to a Play. The matcher is deterministic and fast:
 *
 *   1. For every Play, test each pattern (case-insensitive substring or
 *      regex). A match scores: regex-match = 2, substring-match = 1.
 *   2. Multiply by `priority` (default 1) for the final per-play score.
 *   3. Highest score wins. Ties: user plays beat builtins, then higher
 *      `priority`, then alphabetical id (stable).
 *   4. If no Play scored > 0, return the generic catch-all.
 *
 * The returned Play is never null — there's always a fallback.
 */
export function matchPlay(goal: string): Play {
    const haystack = goal.toLowerCase().trim();
    let best: { play: Play; score: number } | null = null;
    const all = listPlays();
    for (const play of all) {
        if (play.id === 'generic') continue;
        let score = 0;
        for (const pat of play.patterns) {
            if (typeof pat === 'string') {
                if (haystack.includes(pat.toLowerCase())) score += 1;
            } else {
                if (pat.test(goal)) score += 2;
            }
        }
        if (score === 0) continue;
        const weighted = score * (play.priority ?? 1);
        if (!best || weighted > best.score) {
            best = { play, score: weighted };
        } else if (weighted === best.score) {
            // Tiebreak: user > builtin > priority > id
            const aUser = play.source === 'user' ? 1 : 0;
            const bUser = best.play.source === 'user' ? 1 : 0;
            if (aUser !== bUser) {
                if (aUser > bUser) best = { play, score: weighted };
            } else {
                const ap = play.priority ?? 1;
                const bp = best.play.priority ?? 1;
                if (ap !== bp) {
                    if (ap > bp) best = { play, score: weighted };
                } else if (play.id < best.play.id) {
                    best = { play, score: weighted };
                }
            }
        }
    }
    if (best) return best.play;
    // Fall back to the generic Play.
    return all.find(p => p.id === 'generic')!;
}

/** Resolve a Play's team list into the {agentId, name} pairs that
 *  missionRoom.createMission expects. Unknown agent IDs are dropped
 *  with a warning so a typo in a user Play doesn't crash mission
 *  creation. */
export function resolveTeam(play: Play): ResolvedTeamMember[] {
    const resolved: ResolvedTeamMember[] = [];
    for (const agentId of play.team) {
        const name = KNOWN_AGENTS[agentId];
        if (!name) {
            logger.warn(COMPONENT, `Play ${play.id} references unknown agent "${agentId}" — skipping`);
            continue;
        }
        resolved.push({ agentId, name });
    }
    return resolved;
}
