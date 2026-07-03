/**
 * Muscle Memory — trustworthy automatic self-improvement (v7.0).
 *
 * The #1 gap reviewers cite across every agent framework (Jun-Jul 2026):
 * agents don't turn repeated workflows into skills by themselves, and when
 * they try (Hermes), users can't trust the self-evaluation ("it always
 * thinks it did a good job"). Muscle Memory closes both halves:
 *
 *   MINE    repeated successful tool-sequences from real task trajectories
 *   DRAFT   a parameterized recipe (+ slash command) with the LLM
 *   EXAM    replay the draft against the real historical request through the
 *           deterministic eval harness — the skill must reproduce the same
 *           tool path BEFORE a human ever sees it (no self-grading)
 *   PROPOSE surface it: mascot announces, widget card shows evidence + exam
 *   ADOPT   one click → saved recipe + instant /slash-command everywhere
 *
 * Every proposal carries its evidence (which runs taught it) and its exam
 * result. Dismissals are remembered. Nothing auto-adopts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';
import { getRecentTrajectories, getSequenceSignature, type TaskTrajectory } from './trajectoryLogger.js';
import { registerWatcher } from './daemon.js';
import { speakNote } from './heartbeat.js';
import { saveRecipe, getRecipe } from '../recipes/store.js';
import type { Recipe } from '../recipes/types.js';
import { loadConfig } from '../config/config.js';

const COMPONENT = 'MuscleMemory';
const STORE_PATH = join(TITAN_HOME, 'muscle-memory.json');
const SCAN_INTERVAL_MS = 60 * 60 * 1000;       // hourly watcher
const DRAFT_COOLDOWN_MS = 20 * 60 * 60 * 1000; // at most one new draft per 20h
const MAX_PENDING = 3;
const MIN_SEQUENCE_LEN = 2;
/** Sequences containing these are never mined: the replay exam runs tools for
 *  REAL, and a learned workflow must never re-send, re-deploy, or re-delete
 *  anything as a side effect of TITAN examining itself. */
// Segment-based: TITAN tool names put the verb anywhere (email_send, x_post,
// kb_delete, fb_delete_post) — match verb tokens between underscores, not a
// name prefix. Over-blocking is fine; under-blocking is a real re-sent email.
const EXAM_UNSAFE = /(^|_)(shell|exec|execute|run|spawn|kill|delete|remove|destroy|wipe|purge|clear|reset|send|post|reply|forward|publish|deploy|apply|restore|rollback|write|save|create|update|set|schedule|control|click|type|press|submit|upload|install|uninstall|pay|payment|purchase|buy|sell|transfer|trade|tweet|email|sms|call|notify|approve|merge|push|commit)(_|$)/i;
export function isExamSafe(toolSequence: string[]): boolean {
    return toolSequence.every(t => !EXAM_UNSAFE.test(t));
}

export interface LearnedSkill {
    id: string;
    createdAt: string;
    status: 'proposed' | 'adopted' | 'dismissed' | 'failed-exam';
    /** Human-facing */
    name: string;
    description: string;
    slashCommand: string;
    stepPrompt: string;
    parameters: Record<string, { description: string; required: boolean; default?: string }>;
    /** Provenance */
    taskType: string;
    toolSequence: string[];
    signature: string;
    evidence: Array<{ trajectoryId: string; task: string; at: string; durationMs: number; rounds: number }>;
    /** Replay exam */
    exam: { passed: boolean; detail: string; examinedAt: string } | null;
    /** Post-adoption ledger */
    adoptedAt?: string;
    runs?: Array<{ at: string; durationMs: number; totalTokens: number }>;
    baselineDurationMs?: number;
    baselineRounds?: number;
    resolvedAt?: string;
}

interface MuscleStore { skills: LearnedSkill[]; lastDraftAt?: string }

function readStore(): MuscleStore {
    try {
        if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, 'utf-8')) as MuscleStore;
    } catch (e) {
        logger.warn(COMPONENT, `Store unreadable, starting fresh: ${(e as Error).message}`);
    }
    return { skills: [] };
}

function writeStore(store: MuscleStore): void {
    mkdirSync(TITAN_HOME, { recursive: true });
    // Bound the file: drop dismissed/failed older than 60 days
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    store.skills = store.skills.filter(s =>
        s.status === 'adopted' || s.status === 'proposed' || new Date(s.createdAt).getTime() > cutoff);
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function listSkills(): LearnedSkill[] {
    return readStore().skills.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function medianOf(nums: number[]): number {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface MinedCandidate {
    taskType: string;
    signature: string;
    toolSequence: string[];
    occurrences: TaskTrajectory[];
}

/**
 * Find repeated successful workflows worth learning. Pure — unit-testable.
 * Groups successful trajectories by (taskType, exact ordered tool sequence);
 * a group qualifies with >= minOccurrences and a sequence of >= 2 tools that
 * isn't already known (proposed/adopted/dismissed/failed).
 */
export function mineCandidates(
    trajectories: TaskTrajectory[],
    knownSignatures: Set<string>,
    minOccurrences: number,
): MinedCandidate[] {
    const groups = new Map<string, MinedCandidate>();
    for (const t of trajectories) {
        if (!t.success || !Array.isArray(t.toolSequence) || t.toolSequence.length < MIN_SEQUENCE_LEN) continue;
        if (!isExamSafe(t.toolSequence)) continue;
        const signature = `${t.taskType}::${getSequenceSignature(t.toolSequence)}`;
        if (knownSignatures.has(signature)) continue;
        const g = groups.get(signature) || { taskType: t.taskType, signature, toolSequence: t.toolSequence, occurrences: [] };
        g.occurrences.push(t);
        groups.set(signature, g);
    }
    return [...groups.values()]
        .filter(g => g.occurrences.length >= minOccurrences)
        .sort((a, b) => b.occurrences.length - a.occurrences.length);
}

interface DraftResult {
    name: string;
    description: string;
    slashCommand: string;
    stepPrompt: string;
    parameters: Record<string, { description: string; required: boolean; default?: string }>;
}

/** Deterministic fallback when the LLM draft fails. Exported for tests. */
export function draftFallback(candidate: MinedCandidate): DraftResult {
    const newest = candidate.occurrences[0];
    const slug = candidate.taskType.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 24) || 'task';
    return {
        name: `Learned: ${candidate.taskType}`,
        description: `Repeats your proven ${candidate.taskType} workflow (${candidate.toolSequence.join(' → ')}).`,
        slashCommand: slug,
        stepPrompt: `Repeat this proven workflow. Use the tools ${candidate.toolSequence.join(', ')} in that order, adapted to: {{request}}. A previous successful example of this task was: "${newest.task.slice(0, 200)}"`,
        parameters: { request: { description: 'What to apply the workflow to this time', required: false, default: 'same as last time' } },
    };
}

/** LLM-draft a reusable recipe from the mined evidence; falls back deterministically. */
async function draftSkill(candidate: MinedCandidate): Promise<DraftResult> {
    try {
        const { chat } = await import('../providers/router.js');
        const examples = candidate.occurrences.slice(0, 3).map((t, i) =>
            `${i + 1}. "${t.task.slice(0, 180)}" → ${t.toolSequence.join(' → ')}`).join('\n');
        const argsSample = candidate.occurrences[0].toolDetails
            .map(d => `${d.name}(${JSON.stringify(d.args).slice(0, 120)})`).join('; ');
        const response = await chat({
            messages: [{
                role: 'user',
                content: `These ${candidate.occurrences.length} user requests were each solved successfully with the SAME tool workflow:\n${examples}\n\nSample tool arguments: ${argsSample}\n\nWrite a reusable skill definition as STRICT JSON (no markdown fence):\n{"name": "short friendly name", "description": "one sentence: what it does and when to use it", "slashCommand": "/kebab-case-verb", "stepPrompt": "an instruction to an AI agent that reproduces this workflow, using {{param}} placeholders for the parts that varied between the examples", "parameters": {"param": {"description": "...", "required": false, "default": "..."}}}\n\nRules: 0-2 parameters maximum; the stepPrompt MUST name the tools in order (${candidate.toolSequence.join(', ')}); keep everything concise.`,
            }],
        });
        const raw = (response.content || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
        const parsed = JSON.parse(raw) as DraftResult;
        if (!parsed.name || !parsed.stepPrompt || !parsed.slashCommand) throw new Error('missing fields');
        parsed.slashCommand = parsed.slashCommand.replace(/^\/+/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
        parsed.name = parsed.name.slice(0, 60);
        parsed.description = (parsed.description || '').slice(0, 160);
        parsed.parameters = parsed.parameters || {};
        return parsed;
    } catch (e) {
        logger.warn(COMPONENT, `LLM draft failed (${(e as Error).message}) — using deterministic fallback`);
        return draftFallback(candidate);
    }
}

/**
 * The replay exam — the trust layer. The drafted skill's prompt is run
 * through the REAL agent (isolated eval user) against the most recent
 * historical request, and must reproduce the mined tool sequence
 * (ordered-subsequence check via the deterministic eval harness).
 */
async function examineDraft(candidate: MinedCandidate, draft: DraftResult): Promise<{ passed: boolean; detail: string }> {
    try {
        const { runEval } = await import('../eval/harness.js');
        const { processMessage } = await import('./agent.js');
        const newest = candidate.occurrences[0];
        const interpolated = draft.stepPrompt.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
            draft.parameters[key]?.default || newest.task.slice(0, 200));
        const result = await runEval(
            {
                name: `muscle-exam:${candidate.signature.slice(0, 40)}`,
                input: interpolated,
                expectedToolSequence: candidate.toolSequence,
                timeoutMs: 180_000,
            },
            async (input: string) => {
                // Sandbox: the exam binds EXACTLY the mined tools — it cannot
                // execute anything the learned workflow doesn't contain.
                const r = await processMessage(input, 'eval', `eval-muscle-${randomBytes(4).toString('hex')}`, {
                    allowedTools: [...new Set(candidate.toolSequence)],
                });
                // Use the repeats-preserving order (toolsUsed is deduplicated,
                // which would fail sequences like search → browse → search).
                return { content: r.content, toolsUsed: r.orderedToolSequence ?? r.toolsUsed };
            },
        );
        return {
            passed: result.passed,
            detail: result.passed
                ? `Replay exam passed: reproduced ${candidate.toolSequence.join(' → ')}`
                : `Replay exam failed: ${result.errors.join('; ').slice(0, 300)}`,
        };
    } catch (e) {
        return { passed: false, detail: `Exam errored: ${(e as Error).message}` };
    }
}

export interface MuscleConfig { enabled: boolean; minOccurrences: number; verifyBeforePropose: boolean }

function muscleConfig(): MuscleConfig {
    try {
        const cfg = loadConfig() as { muscleMemory?: Partial<MuscleConfig> };
        return {
            enabled: cfg.muscleMemory?.enabled ?? true,
            minOccurrences: cfg.muscleMemory?.minOccurrences ?? 3,
            verifyBeforePropose: cfg.muscleMemory?.verifyBeforePropose ?? true,
        };
    } catch {
        return { enabled: true, minOccurrences: 3, verifyBeforePropose: true };
    }
}

/**
 * One scan: mine → draft → exam → propose. Returns what happened (for the
 * run-now endpoint / demos). Guards: cooldown, pending cap.
 */
export async function runMuscleScan(force = false): Promise<{ action: string; skill?: LearnedSkill }> {
    const cfg = muscleConfig();
    if (!cfg.enabled) return { action: 'disabled' };

    const store = readStore();
    const pending = store.skills.filter(s => s.status === 'proposed');
    if (pending.length >= MAX_PENDING) return { action: 'pending-cap' };
    if (!force && store.lastDraftAt && Date.now() - new Date(store.lastDraftAt).getTime() < DRAFT_COOLDOWN_MS) {
        return { action: 'cooldown' };
    }

    const known = new Set(store.skills.map(s => s.signature));
    const trajectories = getRecentTrajectories(200, { success: true });
    const candidates = mineCandidates(trajectories, known, cfg.minOccurrences);
    if (candidates.length === 0) return { action: 'nothing-to-learn' };

    const candidate = candidates[0];
    logger.info(COMPONENT, `Learning candidate: ${candidate.taskType} × ${candidate.occurrences.length} (${candidate.toolSequence.join(' → ')})`);

    const draft = await draftSkill(candidate);
    const exam = cfg.verifyBeforePropose
        ? await examineDraft(candidate, draft)
        : { passed: true, detail: 'Exam skipped by config (verifyBeforePropose=false)' };

    const skill: LearnedSkill = {
        id: `mm-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
        createdAt: new Date().toISOString(),
        status: exam.passed ? 'proposed' : 'failed-exam',
        name: draft.name,
        description: draft.description,
        slashCommand: draft.slashCommand,
        stepPrompt: draft.stepPrompt,
        parameters: draft.parameters,
        taskType: candidate.taskType,
        toolSequence: candidate.toolSequence,
        signature: candidate.signature,
        evidence: candidate.occurrences.slice(0, 5).map(t => ({
            trajectoryId: t.id, task: t.task.slice(0, 160), at: t.timestamp, durationMs: t.durationMs, rounds: t.rounds,
        })),
        exam: { ...exam, examinedAt: new Date().toISOString() },
        baselineDurationMs: medianOf(candidate.occurrences.map(t => t.durationMs)),
        baselineRounds: medianOf(candidate.occurrences.map(t => t.rounds)),
    };
    // Re-read fresh: the draft+exam awaits can take minutes, during which the
    // user may adopt/dismiss other skills — never clobber those writes.
    const fresh = readStore();
    if (fresh.skills.some(x => x.signature === skill.signature)) return { action: 'duplicate-race' };
    fresh.skills.push(skill);
    fresh.lastDraftAt = new Date().toISOString();
    writeStore(fresh);

    if (skill.status === 'proposed') {
        speakNote(`💪 Check Muscle Memory: I taught myself "${skill.name}" from ${skill.evidence.length} of your tasks — replay exam passed.`);
        logger.info(COMPONENT, `Proposed learned skill "${skill.name}" (${skill.slashCommand}) — exam PASSED`);
        return { action: 'proposed', skill };
    }
    logger.info(COMPONENT, `Draft "${skill.name}" failed its replay exam — filed, not proposed. ${exam.detail}`);
    return { action: 'failed-exam', skill };
}

/** Adopt: persist as a real recipe → instant slash command. */
export function adoptSkill(id: string): LearnedSkill | { error: string } {
    const store = readStore();
    const skill = store.skills.find(s => s.id === id);
    if (!skill) return { error: `No learned skill ${id}` };
    if (skill.status !== 'proposed') return { error: `Skill ${id} is ${skill.status}, not proposed` };
    skill.slashCommand = skill.slashCommand.replace(/^\/+/, '');
    if (getRecipe(skill.slashCommand)) skill.slashCommand = `${skill.slashCommand}-learned`;

    const recipe: Recipe = {
        id: skill.id,
        name: skill.name,
        description: `${skill.description} (learned automatically from your usage; replay-verified)`,
        slashCommand: skill.slashCommand,
        parameters: skill.parameters,
        steps: [{ prompt: skill.stepPrompt }],
        author: 'muscle-memory',
        tags: ['learned'],
        createdAt: new Date().toISOString(),
    };
    saveRecipe(recipe);
    skill.status = 'adopted';
    skill.adoptedAt = new Date().toISOString();
    skill.runs = [];
    writeStore(store);
    speakNote(`🎉 "${skill.name}" adopted — try /${skill.slashCommand} in any channel.`);
    logger.info(COMPONENT, `Adopted "${skill.name}" as recipe ${skill.id} (${skill.slashCommand})`);
    return skill;
}

export function dismissSkill(id: string, reason?: string): boolean {
    const store = readStore();
    const skill = store.skills.find(s => s.id === id);
    if (!skill || skill.status !== 'proposed') return false;
    skill.status = 'dismissed';
    skill.resolvedAt = new Date().toISOString();
    writeStore(store);
    logger.info(COMPONENT, `Dismissed "${skill.name}"${reason ? ` (${reason})` : ''} — signature remembered, won't re-propose`);
    return true;
}

/** Called from the slash-command run path to feed the savings ledger. */
export function recordAdoptedRun(recipeId: string, durationMs: number, totalTokens: number): void {
    try {
        const store = readStore();
        const skill = store.skills.find(s => s.id === recipeId && s.status === 'adopted');
        if (!skill) return;
        skill.runs = skill.runs || [];
        skill.runs.push({ at: new Date().toISOString(), durationMs, totalTokens });
        if (skill.runs.length > 200) skill.runs = skill.runs.slice(-200);
        writeStore(store);
    } catch { /* ledger is best-effort */ }
}

/** Aggregate stats for the dashboard widget. */
export function muscleStats(): { learned: number; adopted: number; totalRuns: number; medianSpeedupMs: number } {
    const skills = readStore().skills;
    const adopted = skills.filter(s => s.status === 'adopted');
    const totalRuns = adopted.reduce((n, s) => n + (s.runs?.length || 0), 0);
    const speedups: number[] = [];
    for (const s of adopted) {
        if (!s.baselineDurationMs || !s.runs?.length) continue;
        speedups.push(s.baselineDurationMs - medianOf(s.runs.map(r => r.durationMs)));
    }
    return {
        learned: skills.filter(s => s.status !== 'failed-exam').length,
        adopted: adopted.length,
        totalRuns,
        medianSpeedupMs: medianOf(speedups),
    };
}

export function registerMuscleWatcher(): void {
    const scan = async () => {
        try {
            await runMuscleScan();
        } catch (e) {
            logger.warn(COMPONENT, `Scan failed: ${(e as Error).message}`);
        }
    };
    registerWatcher('muscle-memory', scan, SCAN_INTERVAL_MS);
    // The daemon is off by default — Muscle Memory has its own enabled flag,
    // so fall back to a self-owned timer when the daemon never starts.
    try {
        const cfg = loadConfig() as { daemon?: { enabled?: boolean } };
        if (cfg.daemon?.enabled !== true) {
            setInterval(scan, SCAN_INTERVAL_MS).unref();
            logger.info(COMPONENT, 'Daemon disabled — Muscle Memory running on its own hourly timer');
        }
    } catch { /* daemon config unreadable — keep the registerWatcher path */ }
    logger.info(COMPONENT, 'Muscle Memory watcher registered (hourly scan, replay-verified proposals)');
}
