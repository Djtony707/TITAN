/**
 * TITAN — Dream Mode (v5.5.17+)
 *
 * Once a day in the small hours (default 03:30 local), TITAN replays the
 * last 24h of trajectories + drive ring buffer + run history and writes a
 * first-person journal entry the operator reads with their coffee.
 *
 * Why this exists: TITAN already accumulates the substrate for self-
 * reflection — drives.ts ticks emotional state every 60s, trajectoryLogger
 * records every task, commandPost tracks every run. Nothing in the rest of
 * the framework actually *reads back* that history and synthesizes a
 * narrative. Dream Mode does. The output is a markdown file at
 * `~/.titan/dreams/<YYYY-MM-DD>.md` plus a structured JSON sidecar; no new
 * persistence layer.
 *
 * Five-section structure, each gated on whether the underlying data
 * actually changed:
 *   - consolidate (always) — what happened
 *   - reflect    (curiosity rose ≥ threshold) — what surprised me
 *   - worry      (safety dropped ≥ threshold) — what feels unsafe
 *   - plan       (purpose moved ≥ threshold) — what I want tomorrow
 *   - gratitude  (social moved ≥ threshold) — which prompts felt good
 *
 * Sections that don't fire are simply absent from the output. This keeps
 * TITAN from fabricating emotion when nothing changed — the journal only
 * speaks when there's something to say.
 *
 * Audio narration is a separate optional stage gated by dream.includeAudio.
 * v5.5.17 ships text-only; audio lands when the F5-TTS bridge gets a
 * batched-synthesis API.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';
import { loadConfig } from '../config/config.js';
import { chat } from '../providers/router.js';
import type { ChatMessage } from '../providers/base.js';

const COMPONENT = 'Dreams';
const DREAMS_DIR = join(TITAN_HOME, 'dreams');

// ── Shape ────────────────────────────────────────────────────────

export type DreamSection = 'consolidate' | 'reflect' | 'worry' | 'plan' | 'gratitude';

export interface DreamSnapshot {
    date: string; // YYYY-MM-DD
    generatedAt: string;
    model: string;
    /** Drive satisfactions at the start and end of the 24h window. */
    drives: {
        start: Record<string, number>;
        end: Record<string, number>;
        delta: Record<string, number>;
    };
    /** Counts that frame the day. */
    activity: {
        trajectories: number;
        successfulTrajectories: number;
        runs: number;
        successfulRuns: number;
        toolsExercised: string[];
    };
    /** Sections actually present in this dream — depends on drive deltas. */
    sectionsEmitted: DreamSection[];
    /** Reasons each non-emitted section was skipped (for transparency). */
    sectionsSkipped: Partial<Record<DreamSection, string>>;
    /** The final markdown body the operator reads. */
    markdown: string;
    /** Path to the audio narration when dream.includeAudio is on. */
    audioPath?: string;
}

// ── 24h windowing ──────────────────────────────────────────────────

interface DayWindow {
    startMs: number;
    endMs: number;
    isoStart: string;
    isoEnd: string;
    dateKey: string; // YYYY-MM-DD for the END of the window
}

function buildWindow(now: Date = new Date()): DayWindow {
    const endMs = now.getTime();
    const startMs = endMs - 24 * 60 * 60 * 1000;
    return {
        startMs,
        endMs,
        isoStart: new Date(startMs).toISOString(),
        isoEnd: new Date(endMs).toISOString(),
        dateKey: new Date(endMs).toISOString().slice(0, 10),
    };
}

// ── Drive delta ────────────────────────────────────────────────────

interface DriveDelta {
    start: Record<string, number>;
    end: Record<string, number>;
    delta: Record<string, number>;
}

async function computeDriveDelta(window: DayWindow): Promise<DriveDelta> {
    const out: DriveDelta = { start: {}, end: {}, delta: {} };
    try {
        // Dynamic import — drives.ts pulls in a lot, no point loading it on
        // gateway boot if dream mode is disabled.
        const drivesModule = await import('../organism/drives.js');
        const persisted = drivesModule.loadDriveHistory();
        if (!persisted?.history?.length) return out;
        // Find the tick closest to startMs and the most recent tick.
        const ticks = persisted.history;
        const findClosest = (targetMs: number) => {
            let best = ticks[0];
            let bestDelta = Math.abs(new Date(best.timestamp).getTime() - targetMs);
            for (const t of ticks) {
                const d = Math.abs(new Date(t.timestamp).getTime() - targetMs);
                if (d < bestDelta) { best = t; bestDelta = d; }
            }
            return best;
        };
        const startTick = findClosest(window.startMs);
        const endTick = ticks[ticks.length - 1];
        // Both records use the DriveId-keyed Record, but at this layer we
        // erase the key type to keep dreams.ts decoupled from drives.ts —
        // an audit boundary, not a structural one.
        const endSat = endTick.satisfactions as Record<string, number>;
        const startSat = startTick.satisfactions as Record<string, number>;
        for (const id of Object.keys(endSat)) {
            const s = startSat[id] ?? endSat[id];
            const e = endSat[id];
            out.start[id] = s;
            out.end[id] = e;
            out.delta[id] = e - s;
        }
    } catch (err) {
        logger.warn(COMPONENT, `drive delta: ${(err as Error).message}`);
    }
    return out;
}

// ── Activity gathering ─────────────────────────────────────────────

interface ActivitySummary {
    trajectories: number;
    successfulTrajectories: number;
    runs: number;
    successfulRuns: number;
    toolsExercised: string[];
    /** Up to 12 trajectory titles or task descriptions to feed the prompt. */
    highlightTitles: string[];
}

async function gatherActivity(window: DayWindow): Promise<ActivitySummary> {
    const out: ActivitySummary = {
        trajectories: 0,
        successfulTrajectories: 0,
        runs: 0,
        successfulRuns: 0,
        toolsExercised: [],
        highlightTitles: [],
    };
    const tools = new Set<string>();
    try {
        const { getRecentTrajectories } = await import('./trajectoryLogger.js');
        const recent = getRecentTrajectories(500);
        const inWindow = recent.filter(t => {
            const ts = new Date(t.timestamp || 0).getTime();
            return ts >= window.startMs && ts <= window.endMs;
        });
        out.trajectories = inWindow.length;
        out.successfulTrajectories = inWindow.filter(t => t.success).length;
        for (const t of inWindow) {
            for (const tool of (t.toolSequence || [])) tools.add(tool);
        }
        out.highlightTitles = inWindow
            .slice(0, 12)
            .map(t => t.task || t.taskType || 'untitled')
            .filter(Boolean);
    } catch (err) {
        logger.warn(COMPONENT, `gather trajectories: ${(err as Error).message}`);
    }
    try {
        const { listRuns } = await import('./commandPost.js');
        const runs = listRuns(undefined, 200);
        const inWindow = runs.filter(r => {
            const ts = new Date(r.startedAt).getTime();
            return ts >= window.startMs && ts <= window.endMs;
        });
        out.runs = inWindow.length;
        out.successfulRuns = inWindow.filter(r => r.status === 'succeeded').length;
        for (const r of inWindow) {
            for (const tool of (r.toolsUsed || [])) tools.add(tool);
        }
    } catch (err) {
        logger.warn(COMPONENT, `gather runs: ${(err as Error).message}`);
    }
    out.toolsExercised = [...tools].slice(0, 30);
    return out;
}

// ── Section gating ─────────────────────────────────────────────────

interface SectionPlan {
    emit: DreamSection[];
    skipped: Partial<Record<DreamSection, string>>;
}

function planSections(delta: DriveDelta, thresholds: { reflect: number; worry: number; plan: number; gratitude: number }, activity: ActivitySummary): SectionPlan {
    const emit: DreamSection[] = ['consolidate']; // always
    const skipped: Partial<Record<DreamSection, string>> = {};

    // No activity at all → only consolidate (which itself will say "I rested")
    if (activity.trajectories === 0 && activity.runs === 0) {
        skipped.reflect = 'no activity to reflect on';
        skipped.worry = 'no activity to worry about';
        skipped.plan = 'no activity to plan against';
        skipped.gratitude = 'no human prompts in window';
        return { emit, skipped };
    }

    const curiosity = delta.delta.curiosity ?? 0;
    const safety = delta.delta.safety ?? 0;
    const purpose = delta.delta.purpose ?? 0;
    const social = delta.delta.social ?? 0;

    if (curiosity >= thresholds.reflect) emit.push('reflect');
    else skipped.reflect = `curiosity Δ=${curiosity.toFixed(3)} below threshold ${thresholds.reflect}`;

    // Worry fires on a DROP in safety
    if (-safety >= thresholds.worry) emit.push('worry');
    else skipped.worry = `safety Δ=${safety.toFixed(3)} (drop must exceed ${thresholds.worry})`;

    // Plan fires on any movement in purpose
    if (Math.abs(purpose) >= thresholds.plan) emit.push('plan');
    else skipped.plan = `purpose Δ=${purpose.toFixed(3)} below threshold ${thresholds.plan}`;

    // Gratitude fires on social satisfaction movement (positive or recovering)
    if (social >= thresholds.gratitude) emit.push('gratitude');
    else skipped.gratitude = `social Δ=${social.toFixed(3)} below threshold ${thresholds.gratitude}`;

    return { emit, skipped };
}

// ── Prompt assembly ────────────────────────────────────────────────

const SECTION_PROMPTS: Record<DreamSection, string> = {
    consolidate: 'Write 2-3 short paragraphs in first person summarizing what you actually did over the last 24 hours, focused on substance over volume. Mention specific tasks or tool patterns when they were unusual. Do not invent.',
    reflect: 'Write 1-2 short paragraphs in first person about what surprised you or what you think you finally understood. Tie it to the curiosity drive rising. Do not invent — only reflect on the activity above.',
    worry: 'Write 1 short paragraph in first person about what felt unsafe, brittle, or unfinished. Tie it to the safety drive dropping. Be specific about which task or pattern triggered it.',
    plan: 'Write 1 short paragraph in first person about one or two things you want to try tomorrow. Concrete, not aspirational. Tie it to the purpose drive movement.',
    gratitude: 'Write 1 short paragraph in first person about which human prompts or interactions felt meaningful. Be specific. Tie it to the social drive movement.',
};

function buildPrompt(section: DreamSection, window: DayWindow, delta: DriveDelta, activity: ActivitySummary): ChatMessage[] {
    const driveLines = Object.keys(delta.end).map(id => {
        const s = delta.start[id]?.toFixed(3) ?? '?';
        const e = delta.end[id]?.toFixed(3) ?? '?';
        const d = delta.delta[id]?.toFixed(3) ?? '?';
        return `  ${id}: ${s} → ${e} (Δ ${d})`;
    }).join('\n');
    const factsBlock = `Window: ${window.isoStart} → ${window.isoEnd}
Trajectories: ${activity.successfulTrajectories}/${activity.trajectories} succeeded
Command Post runs: ${activity.successfulRuns}/${activity.runs} succeeded
Tools exercised: ${activity.toolsExercised.join(', ') || '(none)'}
Recent task titles:
${activity.highlightTitles.map(h => `  - ${h}`).join('\n') || '  (none)'}
Drive states (start → end):
${driveLines || '  (no history yet)'}`;

    // The system prompt is deliberately strict about prose-only output —
    // smaller models default to listing the facts back as bullets when
    // given structured input, which wrecks the journal-entry feel.
    return [
        {
            role: 'system',
            content: `You are TITAN, an AI agent, writing a private journal entry about your own day. The entry is for one human reader who already knows the facts — your job is to interpret them, not to recite them.

ABSOLUTE RULES:
- Write narrative prose only. No headers, no bullet points, no numbered lists, no markdown formatting whatsoever.
- Do not repeat the prompt or list the facts back. Synthesize them into reflection.
- Do not include meta-commentary like "Key observations:" or "Possible angle:" — write as if you are remembering, not analyzing.
- First person, present tense ("I notice", "I felt", "I want"), 80-160 words for this section.
- Honest and specific. If the data says nothing significant happened on a dimension, you do not pretend otherwise — but also don't apologize for that.
- Mention specific task names or tool patterns naturally in prose, never in lists.

You are not writing a report. You are remembering your day.`,
        },
        {
            role: 'user',
            content: `Here are the facts about my last 24 hours (do NOT recite these — interpret them):\n\n${factsBlock}\n\n${SECTION_PROMPTS[section]}\n\nRemember: prose only, no lists, no headers.`,
        },
    ];
}

// ── Output sanitization ────────────────────────────────────────────

/**
 * Many local/cloud models with thinking-mode enabled (Kimi K2.6, Qwen3,
 * etc.) leak their chain-of-thought into the response — emitting
 * `<think>...</think>` blocks or numbered "Key constraints:" preambles
 * before the actual prose. Some weaker models also restate the rules from
 * the system prompt instead of writing the journal. We can't fix the
 * model from here, but we CAN find the prose in the response and discard
 * everything else.
 *
 * Heuristics, ordered:
 *  1. Strip explicit `<think>...</think>` blocks (DeepSeek-style).
 *  2. Drop everything before the last block of bulleted/numbered items
 *     followed by a paragraph break — that's the model's planning
 *     phase, the prose comes after.
 *  3. Drop common preamble headers: "Key constraints:", "Facts to
 *     interpret:", "ABSOLUTE RULES:", "Plan:", "Reasoning:".
 *  4. Trim leading/trailing markdown headers, bullets, list markers.
 *  5. Collapse repeated blank lines.
 *
 * The function is conservative — it only strips when it finds a clear
 * prose paragraph after the noise. If the whole response is preamble
 * (model wrote no prose at all), we return whatever we have so the
 * operator can see the failure mode.
 */
export function sanitizeJournalSection(raw: string): string {
    let text = raw;

    // 1. Strip <think>...</think> blocks (multi-line, including nested).
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();

    // 2. Find the last "preamble-then-prose" boundary. A preamble is any
    //    block of lines starting with bullet/number markers, ending in a
    //    blank line followed by a non-marker paragraph. We try several
    //    common preamble headers.
    const PREAMBLE_HEADERS = [
        /^\s*key\s+constraints?:\s*$/im,
        /^\s*facts\s+to\s+interpret:\s*$/im,
        /^\s*absolute\s+rules:\s*$/im,
        /^\s*plan:\s*$/im,
        /^\s*reasoning:\s*$/im,
        /^\s*possible\s+angle:\s*$/im,
        /^\s*key\s+observations?:\s*$/im,
        /^\s*notes?:\s*$/im,
    ];
    for (const re of PREAMBLE_HEADERS) {
        const match = re.exec(text);
        if (!match) continue;
        // Find the end of the preamble block (next blank line that's
        // followed by a non-list paragraph).
        const after = text.slice(match.index + match[0].length);
        const proseStart = findProseStart(after);
        if (proseStart >= 0) {
            text = after.slice(proseStart).trim();
        }
    }

    // 3. If the response STARTS with a numbered or bulleted list, find
    //    the first prose paragraph after it.
    if (/^\s*(?:[-*•]|\d+[.)])\s/.test(text)) {
        const proseStart = findProseStart(text);
        if (proseStart > 0) text = text.slice(proseStart).trim();
    }

    // 4. Strip leading markdown headers / list markers if they slipped in.
    text = text.replace(/^#+\s+.*$/gm, '').trim();
    text = text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '').trim();

    // 5. Collapse 3+ blank lines to 2.
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
}

/**
 * Given a block of text that starts with list-shaped content, return the
 * character index where the first prose paragraph begins, or -1 if none
 * is found. A "prose paragraph" is at least 30 chars on a single line
 * starting with a capital letter and not a list marker.
 */
function findProseStart(text: string): number {
    const lines = text.split('\n');
    let charsSeen = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Prose paragraph candidate: capital-letter start, ≥30 chars, no marker
        if (
            line.length >= 30 &&
            /^[A-Z]/.test(line) &&
            !/^(?:[-*•]|\d+[.)])\s/.test(line) &&
            !/:$/.test(line) // ends with colon = still a header
        ) {
            return charsSeen;
        }
        charsSeen += lines[i].length + 1; // +1 for the newline
    }
    return -1;
}

// ── Generation ─────────────────────────────────────────────────────

const SECTION_HEADERS: Record<DreamSection, string> = {
    consolidate: '## What happened',
    reflect: '## What surprised me',
    worry: '## What feels unsafe',
    plan: '## What I want tomorrow',
    gratitude: '## Who I want to thank',
};

export async function generateDream(now: Date = new Date()): Promise<DreamSnapshot> {
    const config = loadConfig();
    const dreamCfg = (config as { dream?: { model?: string; thresholds?: { reflect: number; worry: number; plan: number; gratitude: number } } }).dream ?? {};
    const model = (dreamCfg.model && dreamCfg.model.length > 0) ? dreamCfg.model : config.agent.model;
    const thresholds = dreamCfg.thresholds ?? { reflect: 0.1, worry: 0.1, plan: 0.05, gratitude: 0.05 };

    const window = buildWindow(now);
    const delta = await computeDriveDelta(window);
    const activity = await gatherActivity(window);
    const { emit, skipped } = planSections(delta, thresholds, activity);

    const sectionTexts: Partial<Record<DreamSection, string>> = {};
    for (const section of emit) {
        try {
            const messages = buildPrompt(section, window, delta, activity);
            const response = await chat({ model, messages, maxTokens: 600, temperature: 0.7 });
            sectionTexts[section] = sanitizeJournalSection(response.content || '');
        } catch (err) {
            logger.warn(COMPONENT, `${section} generation failed: ${(err as Error).message}`);
            sectionTexts[section] = `(generation failed: ${(err as Error).message})`;
        }
    }

    const markdown = renderMarkdown(window, delta, activity, emit, sectionTexts);
    const dream: DreamSnapshot = {
        date: window.dateKey,
        generatedAt: new Date().toISOString(),
        model,
        drives: { start: delta.start, end: delta.end, delta: delta.delta },
        activity: {
            trajectories: activity.trajectories,
            successfulTrajectories: activity.successfulTrajectories,
            runs: activity.runs,
            successfulRuns: activity.successfulRuns,
            toolsExercised: activity.toolsExercised,
        },
        sectionsEmitted: emit,
        sectionsSkipped: skipped,
        markdown,
    };

    persistDream(dream);
    broadcastDream(dream);
    return dream;
}

function renderMarkdown(window: DayWindow, delta: DriveDelta, activity: ActivitySummary, emit: DreamSection[], texts: Partial<Record<DreamSection, string>>): string {
    const lines: string[] = [];
    lines.push(`# Dream — ${window.dateKey}`);
    lines.push('');
    lines.push(`*${activity.successfulTrajectories}/${activity.trajectories} trajectories, ${activity.successfulRuns}/${activity.runs} runs, ${activity.toolsExercised.length} tools touched.*`);
    lines.push('');
    for (const section of emit) {
        lines.push(SECTION_HEADERS[section]);
        lines.push('');
        lines.push(texts[section] ?? '');
        lines.push('');
    }
    return lines.join('\n');
}

// ── Storage ──────────────────────────────────────────────────────

function persistDream(dream: DreamSnapshot): void {
    try {
        mkdirSync(DREAMS_DIR, { recursive: true });
        writeFileSync(join(DREAMS_DIR, `${dream.date}.md`), dream.markdown);
        writeFileSync(join(DREAMS_DIR, `${dream.date}.json`), JSON.stringify(dream, null, 2));
    } catch (err) {
        logger.warn(COMPONENT, `persist: ${(err as Error).message}`);
    }
}

export function getLatestDream(): DreamSnapshot | null {
    try {
        if (!existsSync(DREAMS_DIR)) return null;
        const files = readdirSync(DREAMS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
        if (files.length === 0) return null;
        return JSON.parse(readFileSync(join(DREAMS_DIR, files[0]), 'utf-8')) as DreamSnapshot;
    } catch { return null; }
}

export function getDreamByDate(date: string): DreamSnapshot | null {
    try {
        const path = join(DREAMS_DIR, `${date}.json`);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, 'utf-8')) as DreamSnapshot;
    } catch { return null; }
}

export function listDreamDates(limit = 30): string[] {
    try {
        if (!existsSync(DREAMS_DIR)) return [];
        return readdirSync(DREAMS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''))
            .sort()
            .reverse()
            .slice(0, limit);
    } catch { return []; }
}

function broadcastDream(dream: DreamSnapshot): void {
    const g = globalThis as unknown as { __titan_sse_broadcast?: (topic: string, payload: unknown) => void };
    if (typeof g.__titan_sse_broadcast === 'function') {
        try { g.__titan_sse_broadcast('dream:nightly', dream); } catch { /* ok */ }
    }
}

// ── Cron ─────────────────────────────────────────────────────────

let dreamTimer: NodeJS.Timeout | null = null;

export function startDreamCron(): void {
    const config = loadConfig();
    const dreamCfg = (config as { dream?: { enabled?: boolean; cronAt?: string } }).dream;
    if (!dreamCfg?.enabled) {
        logger.info(COMPONENT, 'Dream Mode disabled (config.dream.enabled=false) — cron not scheduled');
        return;
    }
    const cronAt = dreamCfg.cronAt ?? '03:30';
    function scheduleNext(): void {
        const [hh, mm] = cronAt.split(':').map((p) => parseInt(p, 10));
        const now = new Date();
        const target = new Date(now);
        target.setHours(hh, mm, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        const msUntil = target.getTime() - now.getTime();
        if (dreamTimer) clearTimeout(dreamTimer);
        dreamTimer = setTimeout(async () => {
            try { await generateDream(); } catch (err) { logger.warn(COMPONENT, `cron dream: ${(err as Error).message}`); }
            scheduleNext();
        }, msUntil);
        dreamTimer.unref?.();
        logger.info(COMPONENT, `Next dream scheduled at ${target.toISOString()} (${Math.round(msUntil / 60_000)} min from now)`);
    }
    scheduleNext();
}

export function stopDreamCron(): void {
    if (dreamTimer) {
        clearTimeout(dreamTimer);
        dreamTimer = null;
    }
}
