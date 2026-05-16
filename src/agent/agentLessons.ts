/**
 * TITAN — Per-agent lessons.md (Reflexion-style failure memory).
 *
 * Why this exists
 * ---------------
 * The audit of TITAN's Command Post (2026-05-11) found that retrospectives
 * were computed in-memory per goal but never persisted as a per-agent
 * lookup. That meant the next time the same agent took on similar work,
 * it walked into the same failure modes blind.
 *
 * This module is the persistence layer for the Reflexion pattern as
 * documented in awesome-agent-harness pattern #6:
 *
 *   "When a step fails, a separate critic LLM writes a 1-3 sentence
 *    verbal lesson ('I forgot to check the schema before inserting')
 *    into lessons.md. Future planner turns read this file first."
 *
 * One file per agent at `~/.titan/agents/<agentId>/lessons.md`. Append-only
 * + dedup-on-content. The top-N most recent / highest-relevance entries
 * are injected into that agent's system prompt at the start of every run
 * via {@link renderAgentLessonsForPrompt}.
 *
 * Reference:
 *   - Shinn et al. "Reflexion: Language agents with verbal reinforcement
 *     learning" (NeurIPS 2023) — https://arxiv.org/abs/2303.11366
 *   - Picrew/awesome-agent-harness pattern #6
 *   - ~/.claude/projects/-Users-michaelelliott/memory/titan-v6-living-canvas.md
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../utils/logger.js';
import { recordJournalEvent } from './durableJournal.js';

const COMPONENT = 'AgentLessons';

/** Lazy path resolution so tests can swap HOME / TITAN_HOME. */
function titanHome(): string {
    const env = process.env.TITAN_HOME;
    if (env) return env.startsWith('~/') ? join(homedir(), env.slice(2)) : env;
    return join(homedir(), '.titan');
}
function lessonsPath(agentId: string): string {
    return join(titanHome(), 'agents', agentId, 'lessons.md');
}

/** A single lesson the agent has learned from a past failure or success. */
export interface AgentLesson {
    /** Short, verbal — the lesson the agent took away (1–3 sentences). */
    text: string;
    /** "fail" lessons come from things that went wrong; "win" lessons from
     *  things that worked surprisingly well. Both are useful. Default fail. */
    kind?: 'fail' | 'win';
    /** Free-form context tag — what kind of task this was about (e.g.
     *  "merge-conflict", "json-extract", "vram-acquire"). Used for fuzzy
     *  lookup later. Optional. */
    topic?: string;
    /** Optional sessionId for traceback. */
    sessionId?: string;
    /** Optional goalId — when set, the lesson is also written into the
     *  goal's durable journal so a resuming process can see it. */
    goalId?: string;
}

/** Cap on lesson count per agent. Older entries roll off the head. */
const LESSONS_PER_AGENT_CAP = 200;
/** Cap on lessons rendered into the system prompt at run time. */
const PROMPT_RENDER_CAP = 12;

/**
 * Append a lesson to the agent's lessons.md. Idempotent on near-duplicate
 * text (lowercased, whitespace-collapsed match) so the same lesson written
 * twice in close succession doesn't pollute the file.
 */
export function recordLesson(agentId: string, lesson: AgentLesson): void {
    if (!agentId || !lesson?.text || !lesson.text.trim()) return;
    try {
        const path = lessonsPath(agentId);
        try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }

        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
        const incomingNorm = norm(lesson.text);

        // Read existing entries to dedup against recent ones.
        const existingRaw = existsSync(path) ? readFileSync(path, 'utf-8') : '';
        const recentNorms = parseLessonTexts(existingRaw)
            .slice(-20) // only dedup against last 20 — older content fades
            .map(norm);
        if (recentNorms.includes(incomingNorm)) {
            return; // already learned this lesson recently
        }

        // Append one entry in the documented format.
        const ts = new Date().toISOString();
        const kind = lesson.kind ?? 'fail';
        const topic = lesson.topic ? ` topic="${escapeAttr(lesson.topic)}"` : '';
        const session = lesson.sessionId ? ` session="${escapeAttr(lesson.sessionId)}"` : '';
        const block = `\n- [${ts}] **${kind}**${topic}${session} — ${lesson.text.trim()}\n`;

        // Make sure the file has a header on first write.
        if (!existsSync(path)) {
            writeFileSync(path, lessonsHeader(agentId), 'utf-8');
        }
        appendFileSync(path, block, 'utf-8');

        // Trim to cap if exceeded.
        trimIfOverCap(path);

        logger.info(COMPONENT, `Recorded ${kind}-lesson for ${agentId}${topic} — "${lesson.text.slice(0, 80)}"`);

        // v6.0 CP upgrade #4 — durable journal: surface lessons in the
        // per-context replay so resuming agents can see what was learned.
        recordJournalEvent(
            { agentId, goalId: lesson.goalId, sessionId: lesson.sessionId },
            'lesson_recorded',
            { text: lesson.text.trim(), kind, topic: lesson.topic },
        );
    } catch (err) {
        logger.warn(COMPONENT, `Failed to write lesson for ${agentId}: ${(err as Error).message}`);
    }
}

function lessonsHeader(agentId: string): string {
    return [
        `# Lessons — ${agentId}`,
        ``,
        `Append-only verbal-reinforcement journal. Each entry is one lesson the`,
        `agent learned from a past attempt (failure or surprising win). The top`,
        `~${PROMPT_RENDER_CAP} most recent entries are injected into this agent's system`,
        `prompt at the start of every run.`,
        ``,
        `Format: \`- [iso-ts] **kind** [topic="…"] [session="…"] — verbal lesson\``,
        ``,
        `---`,
        ``,
    ].join('\n');
}

function escapeAttr(s: string): string {
    return s.replace(/[\\"\n\r]/g, c => c === '\n' ? ' ' : c === '\r' ? ' ' : '\\' + c).slice(0, 80);
}

/** Parse the lesson lines from the raw markdown. Returns text content only. */
function parseLessonTexts(raw: string): string[] {
    const lines = raw.split(/\r?\n/);
    const out: string[] = [];
    for (const l of lines) {
        // Match the documented format. Capture everything after the trailing " — ".
        const m = l.match(/^- \[[^\]]+\]\s+\*\*(fail|win)\*\*(?:[^—]*)—\s+(.+)$/);
        if (m && m[2]) out.push(m[2]);
    }
    return out;
}

function trimIfOverCap(path: string): void {
    try {
        const raw = readFileSync(path, 'utf-8');
        const lines = raw.split(/\r?\n/);
        // Find the entries (lines starting with "- [")
        const entryIdx: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('- [')) entryIdx.push(i);
        }
        if (entryIdx.length <= LESSONS_PER_AGENT_CAP) return;
        // Drop the oldest (LESSONS_PER_AGENT_CAP / 4) when we tip over.
        const dropCount = Math.max(1, Math.floor(LESSONS_PER_AGENT_CAP / 4));
        const cutAt = entryIdx[dropCount] ?? entryIdx[0];
        // Header ends at first "---" line.
        const headerEnd = lines.findIndex(l => l.trim() === '---');
        const header = headerEnd >= 0 ? lines.slice(0, headerEnd + 2).join('\n') : '';
        const kept = lines.slice(cutAt).join('\n');
        writeFileSync(path, header + '\n' + kept, 'utf-8');
        logger.info(COMPONENT, `Trimmed ${dropCount} oldest lessons from ${path}`);
    } catch { /* best-effort */ }
}

/**
 * Render the most relevant lessons for `agentId` as a prompt-ready block.
 * If `topic` is supplied, lessons matching that topic float to the top.
 * Returns empty string when there are no lessons yet (don't add a
 * prompt section with no content).
 */
export function renderAgentLessonsForPrompt(agentId: string, topic?: string): string {
    if (!agentId) return '';
    const path = lessonsPath(agentId);
    if (!existsSync(path)) return '';
    try {
        const raw = readFileSync(path, 'utf-8');
        const lines = raw.split(/\r?\n/);
        // Parse structured entries: kind + topic + text.
        const entries: Array<{ kind: string; topic: string; text: string; ts: string }> = [];
        for (const l of lines) {
            const m = l.match(/^- \[([^\]]+)\]\s+\*\*(fail|win)\*\*(?:\s+topic="([^"]+)")?(?:[^—]*)—\s+(.+)$/);
            if (m) entries.push({ ts: m[1], kind: m[2], topic: m[3] || '', text: m[4] });
        }
        if (entries.length === 0) return '';

        // Sort: most recent first, with topic match boost.
        const wantsTopic = (topic || '').toLowerCase();
        const scored = entries.map(e => ({
            e,
            score: (wantsTopic && e.topic.toLowerCase() === wantsTopic ? 1 : 0)
                 + (wantsTopic && e.topic.toLowerCase().includes(wantsTopic) ? 0.5 : 0),
        }));
        scored.sort((a, b) => b.score - a.score || b.e.ts.localeCompare(a.e.ts));

        const top = scored.slice(0, PROMPT_RENDER_CAP).map(s => s.e);
        if (top.length === 0) return '';

        const out: string[] = [`## Lessons you've learned (top ${top.length})`];
        for (const e of top) {
            const tag = e.topic ? ` *(${e.topic})*` : '';
            out.push(`- **${e.kind}**${tag} — ${e.text}`);
        }
        return out.join('\n');
    } catch {
        return '';
    }
}

/** Convenience helper — read raw lessons.md content (used by tests + UI). */
export function readLessonsMarkdown(agentId: string): string {
    const path = lessonsPath(agentId);
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

/** Test helper — wipe an agent's lessons file. */
export function __resetLessonsForTests(agentId: string): void {
    const path = lessonsPath(agentId);
    if (existsSync(path)) {
        try { unlinkSync(path); } catch { /* fine */ }
    }
}
