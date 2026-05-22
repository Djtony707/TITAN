/**
 * TITAN — Learning Curator
 *
 * Ported from the MIT-licensed Hermes Agent background review / curator pattern:
 * https://github.com/NousResearch/hermes-agent
 *
 * Copyright (c) 2025 Nous Research
 * MIT License. See THIRD_PARTY_NOTICES.md for attribution.
 *
 * Hermes runs a background review pass over recent work and updates memory or
 * skills when durable learning appears. This TITAN-native port keeps the same
 * operational shape but writes into TITAN's existing trajectory and
 * per-agent lesson systems instead of introducing a parallel skill store.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';
import { getRecentTrajectories, getSequenceSignature, type TaskTrajectory } from './trajectoryLogger.js';
import { recordLesson } from './agentLessons.js';
import { loadConfig } from '../config/config.js';

/**
 * v6.4.0 — read curator knobs from `learningCurator` config section, with
 * fallback to constants when config is unavailable (e.g. during unit
 * tests that don't initialize a TitanConfig). The shape mirrors the Zod
 * schema in src/config/schema.ts.
 */
interface CuratorConfig {
    enabled: boolean;
    intervalHours: number;
    minTrajectories: number;
    staleAfterDays: number;
    archiveAfterDays: number;
}

function loadCuratorConfig(): CuratorConfig {
    try {
        const cfg = loadConfig() as unknown as { learningCurator?: Partial<CuratorConfig> };
        const lc = cfg.learningCurator ?? {};
        return {
            enabled: lc.enabled ?? true,
            intervalHours: lc.intervalHours ?? DEFAULT_INTERVAL_HOURS,
            minTrajectories: lc.minTrajectories ?? DEFAULT_MIN_TRAJECTORIES,
            staleAfterDays: lc.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS,
            archiveAfterDays: lc.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS,
        };
    } catch {
        return {
            enabled: true,
            intervalHours: DEFAULT_INTERVAL_HOURS,
            minTrajectories: DEFAULT_MIN_TRAJECTORIES,
            staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
            archiveAfterDays: DEFAULT_ARCHIVE_AFTER_DAYS,
        };
    }
}

const COMPONENT = 'LearningCurator';
const STATE_PATH = join(TITAN_HOME, 'learning-curator-state.json');
const REPORTS_DIR = join(TITAN_HOME, 'logs', 'learning-curator');
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_MIN_TRAJECTORIES = 3;
const DEFAULT_STALE_AFTER_DAYS = 30;
const DEFAULT_ARCHIVE_AFTER_DAYS = 90;

export type LearningPatternLifecycleState = 'active' | 'watch' | 'stale' | 'archived';

export interface LearningPatternState {
    taskType: string;
    signature: string;
    toolSequence: string[];
    successes: number;
    failures: number;
    transientFailures: number;
    state: LearningPatternLifecycleState;
    firstSeenAt: string;
    lastSeenAt: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    commonFailureTool: string | null;
}

export interface LearningPatternTransitionCounts {
    checked: number;
    markedStale: number;
    archived: number;
    reactivated: number;
}

export interface LearningCuratorState {
    lastRunAt: string | null;
    lastRunDurationMs?: number | null;
    lastRunSummary: string | null;
    lastReportPath?: string | null;
    runCount: number;
    paused: boolean;
    patterns: Record<string, LearningPatternState>;
}

export interface CuratorReviewResult {
    shouldRun: boolean;
    lessonsRecorded: number;
    summary: string;
    reportPath: string | null;
    transitions: LearningPatternTransitionCounts;
}

function defaultState(): LearningCuratorState {
    return {
        lastRunAt: null,
        lastRunDurationMs: null,
        lastRunSummary: null,
        lastReportPath: null,
        runCount: 0,
        paused: false,
        patterns: {},
    };
}

export function loadLearningCuratorState(): LearningCuratorState {
    if (!existsSync(STATE_PATH)) return defaultState();
    try {
        const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as Partial<LearningCuratorState>;
        return { ...defaultState(), ...parsed };
    } catch {
        return defaultState();
    }
}

export function saveLearningCuratorState(state: LearningCuratorState): void {
    try {
        mkdirSync(dirname(STATE_PATH), { recursive: true });
        atomicWriteText(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (err) {
        logger.warn(COMPONENT, `Failed to save curator state: ${(err as Error).message}`);
    }
}

function atomicWriteText(path: string, content: string): void {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, 'utf-8');
    try {
        renameSync(tmp, path);
    } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore cleanup */ }
        throw err;
    }
}

export function shouldRunLearningReview(now: Date = new Date(), intervalHours = DEFAULT_INTERVAL_HOURS): boolean {
    const state = loadLearningCuratorState();
    if (state.paused) return false;

    if (!state.lastRunAt) {
        saveLearningCuratorState({
            ...state,
            lastRunAt: now.toISOString(),
            lastRunDurationMs: 0,
            lastRunSummary: 'Seeded learning curator; first review deferred until interval elapses.',
        });
        return false;
    }

    const lastRun = Date.parse(state.lastRunAt);
    if (!Number.isFinite(lastRun)) return true;
    return now.getTime() - lastRun >= intervalHours * 60 * 60 * 1000;
}

export function runLearningReview(
    trigger: TaskTrajectory,
    now: Date = new Date(),
    minTrajectories = DEFAULT_MIN_TRAJECTORIES,
): CuratorReviewResult {
    const started = Date.now();
    const emptyTransitions: LearningPatternTransitionCounts = {
        checked: 0,
        markedStale: 0,
        archived: 0,
        reactivated: 0,
    };

    if (!shouldRunLearningReview(now)) {
        return {
            shouldRun: false,
            lessonsRecorded: 0,
            summary: 'Learning review deferred by interval gate.',
            reportPath: null,
            transitions: emptyTransitions,
        };
    }

    const recent = getRecentTrajectories(200, { taskType: trigger.taskType });
    if (recent.length < minTrajectories) {
        const summary = `Skipped ${trigger.taskType}: only ${recent.length}/${minTrajectories} trajectories.`;
        const reportPath = writeLearningReviewReport(now, {
            taskType: trigger.taskType,
            summary,
            lessons: [],
            transitions: emptyTransitions,
            recentCount: recent.length,
            durationMs: Date.now() - started,
        });
        persistReview(now, summary, reportPath, Date.now() - started);
        return {
            shouldRun: true,
            lessonsRecorded: 0,
            summary: 'Not enough trajectory history to curate.',
            reportPath,
            transitions: emptyTransitions,
        };
    }

    const transitions = applyLearningPatternTransitions(now);
    const lessons = deriveLessons(trigger, recent);
    for (const lesson of lessons) {
        recordLesson('default', {
            kind: lesson.kind,
            topic: lesson.topic,
            sessionId: trigger.sessionId,
            text: lesson.text,
        });
    }

    const summary = lessons.length > 0
        ? `Recorded ${lessons.length} ${trigger.taskType} learning lesson(s).`
        : `Reviewed ${recent.length} ${trigger.taskType} trajectories; nothing durable to save.`;
    const durationMs = Date.now() - started;
    const reportPath = writeLearningReviewReport(now, {
        taskType: trigger.taskType,
        summary,
        lessons,
        transitions,
        recentCount: recent.length,
        durationMs,
    });
    persistReview(now, summary, reportPath, durationMs);
    return { shouldRun: true, lessonsRecorded: lessons.length, summary, reportPath, transitions };
}

function persistReview(now: Date, summary: string, reportPath: string | null, durationMs: number): void {
    const state = loadLearningCuratorState();
    saveLearningCuratorState({
        ...state,
        lastRunAt: now.toISOString(),
        lastRunDurationMs: durationMs,
        lastRunSummary: summary,
        lastReportPath: reportPath,
        runCount: state.runCount + 1,
    });
}

interface DerivedLesson {
    kind: 'fail' | 'win';
    topic: string;
    text: string;
}

interface LearningReviewReportInput {
    taskType: string;
    summary: string;
    lessons: DerivedLesson[];
    transitions: LearningPatternTransitionCounts;
    recentCount: number;
    durationMs: number;
}

export function writeLearningReviewReport(now: Date, report: LearningReviewReportInput): string | null {
    try {
        const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const dir = join(REPORTS_DIR, stamp);
        mkdirSync(dir, { recursive: true });
        const jsonPath = join(dir, 'run.json');
        const mdPath = join(dir, 'REPORT.md');
        atomicWriteText(jsonPath, JSON.stringify({
            generatedAt: now.toISOString(),
            taskType: report.taskType,
            summary: report.summary,
            recentCount: report.recentCount,
            lessons: report.lessons,
            transitions: report.transitions,
            durationMs: report.durationMs,
        }, null, 2));
        atomicWriteText(mdPath, renderLearningReviewReport(now, report));
        return mdPath;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to write curator report: ${(err as Error).message}`);
        return null;
    }
}

function renderLearningReviewReport(now: Date, report: LearningReviewReportInput): string {
    const lessons = report.lessons.length > 0
        ? report.lessons.map(lesson => `- ${lesson.kind.toUpperCase()} / ${lesson.topic}: ${lesson.text}`).join('\n')
        : '- No durable lessons recorded.';

    return `# TITAN Learning Curator Report

- Generated: ${now.toISOString()}
- Task type: ${report.taskType}
- Recent trajectories checked: ${report.recentCount}
- Duration: ${report.durationMs}ms
- Summary: ${report.summary}

## Pattern Transitions
- Checked: ${report.transitions.checked}
- Marked stale: ${report.transitions.markedStale}
- Archived: ${report.transitions.archived}
- Reactivated: ${report.transitions.reactivated}

## Lessons
${lessons}
`;
}

function deriveLessons(trigger: TaskTrajectory, recent: TaskTrajectory[]): DerivedLesson[] {
    const lessons: DerivedLesson[] = [];
    const signature = getSequenceSignature(trigger.toolSequence);
    const sameSequence = recent.filter(t => getSequenceSignature(t.toolSequence) === signature);
    const successes = sameSequence.filter(t => t.success);
    const failures = sameSequence.filter(t => !t.success && isDurableLearningFailure(t));

    if (successes.length >= DEFAULT_MIN_TRAJECTORIES) {
        lessons.push({
            kind: 'win',
            topic: trigger.taskType,
            text: `For ${trigger.taskType} tasks, the tool sequence ${signature} is proven across ${successes.length} successful trajectories; prefer it before inventing a new flow, then verify the final artifact before reporting done.`,
        });
    }

    if (failures.length >= 2) {
        const failedTool = mostCommonFailureTool(failures);
        lessons.push({
            kind: 'fail',
            topic: trigger.taskType,
            text: `For ${trigger.taskType} tasks, repeated failures happened in the ${signature} flow${failedTool ? ` around ${failedTool}` : ''}; inspect the last tool result and change approach instead of retrying the same sequence blindly.`,
        });
    }

    const recentFailure = recent.find(t => !t.success && t.timestamp < trigger.timestamp);
    if (trigger.success && recentFailure && signature !== getSequenceSignature(recentFailure.toolSequence)) {
        lessons.push({
            kind: 'win',
            topic: trigger.taskType,
            text: `When a ${trigger.taskType} attempt stalls or fails, switching to ${signature} has produced a successful recovery path; use this as the first fallback candidate for similar work.`,
        });
    }

    return lessons;
}

export function ingestTrajectoryLearningSignal(trajectory: TaskTrajectory): LearningPatternState {
    const state = loadLearningCuratorState();
    const now = trajectory.timestamp || new Date().toISOString();
    const signature = getSequenceSignature(trajectory.toolSequence);
    const key = patternKey(trajectory.taskType, signature);
    const existing = state.patterns[key];
    const transientFailure = !trajectory.success && !isDurableLearningFailure(trajectory);
    const failureTool = !trajectory.success && !transientFailure ? mostCommonFailureTool([trajectory]) : '';

    const pattern: LearningPatternState = {
        taskType: trajectory.taskType,
        signature,
        toolSequence: trajectory.toolSequence,
        successes: existing?.successes ?? 0,
        failures: existing?.failures ?? 0,
        transientFailures: existing?.transientFailures ?? 0,
        state: existing?.state ?? 'active',
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastFailureAt: existing?.lastFailureAt ?? null,
        commonFailureTool: existing?.commonFailureTool ?? null,
    };

    if (trajectory.success) {
        pattern.successes += 1;
        pattern.lastSuccessAt = now;
        pattern.state = 'active';
    } else if (transientFailure) {
        pattern.transientFailures += 1;
    } else {
        pattern.failures += 1;
        pattern.lastFailureAt = now;
        pattern.commonFailureTool = failureTool || pattern.commonFailureTool;
        if (pattern.failures >= 2) pattern.state = 'watch';
    }

    state.patterns[key] = pattern;
    saveLearningCuratorState(state);
    return pattern;
}

export function applyLearningPatternTransitions(
    now: Date = new Date(),
    staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
    archiveAfterDays = DEFAULT_ARCHIVE_AFTER_DAYS,
): LearningPatternTransitionCounts {
    const state = loadLearningCuratorState();
    const counts: LearningPatternTransitionCounts = {
        checked: 0,
        markedStale: 0,
        archived: 0,
        reactivated: 0,
    };
    const staleCutoff = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;
    const archiveCutoff = now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000;

    for (const pattern of Object.values(state.patterns)) {
        counts.checked += 1;
        const lastSeen = Date.parse(pattern.lastSeenAt);
        if (!Number.isFinite(lastSeen)) continue;

        if (lastSeen <= archiveCutoff && pattern.state !== 'archived') {
            pattern.state = 'archived';
            counts.archived += 1;
        } else if (lastSeen <= staleCutoff && pattern.state === 'active') {
            pattern.state = 'stale';
            counts.markedStale += 1;
        } else if (lastSeen > staleCutoff && pattern.state === 'stale') {
            pattern.state = 'active';
            counts.reactivated += 1;
        }
    }

    if (counts.markedStale > 0 || counts.archived > 0 || counts.reactivated > 0) {
        saveLearningCuratorState(state);
    }
    return counts;
}

export function renderLearningPatternGuidance(taskType: string, limit = 3): string | null {
    const state = loadLearningCuratorState();
    const patterns = Object.values(state.patterns)
        .filter(pattern => pattern.taskType === taskType && pattern.state !== 'archived')
        .sort((a, b) => patternSortScore(b) - patternSortScore(a))
        .slice(0, limit);

    if (patterns.length === 0) return null;

    const lines = ['Continuous learning patterns from recent TITAN trajectories:'];
    for (const pattern of patterns) {
        if (pattern.state === 'watch') {
            const failureDetail = pattern.commonFailureTool ? ` around ${pattern.commonFailureTool}` : '';
            lines.push(`- Watch ${pattern.signature}: ${pattern.failures} durable failure(s)${failureDetail}; inspect the failed tool result before repeating this flow.`);
        } else {
            lines.push(`- Prefer ${pattern.signature}: ${pattern.successes} win(s), ${pattern.failures} durable failure(s); verify the final artifact before reporting done.`);
        }
    }
    return lines.join('\n');
}

function patternSortScore(pattern: LearningPatternState): number {
    const stateBoost = pattern.state === 'watch' ? 1000 : pattern.state === 'active' ? 500 : 0;
    return stateBoost + pattern.successes * 10 - pattern.failures;
}

function patternKey(taskType: string, signature: string): string {
    return `${taskType}:${signature}`;
}

function isDurableLearningFailure(trajectory: TaskTrajectory): boolean {
    if (trajectory.success) return false;
    const text = trajectory.toolDetails
        .map(detail => `${detail.name}\n${detail.resultSnippet ?? ''}`)
        .join('\n')
        .toLowerCase();

    return ![
        'command not found',
        'module not found',
        'cannot find module',
        'no such file or directory',
        'not configured',
        'missing api key',
        'missing token',
        'invalid api key',
        'credentials are not configured',
        'authentication required',
        'unauthorized',
        'rate limit',
        'temporarily unavailable',
        'network error',
        'econnreset',
        'etimedout',
    ].some(marker => text.includes(marker));
}

function mostCommonFailureTool(failures: TaskTrajectory[]): string {
    const counts = new Map<string, number>();
    for (const trajectory of failures) {
        for (const detail of trajectory.toolDetails) {
            if (!detail.success) counts.set(detail.name, (counts.get(detail.name) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

export function processTrajectoryForLearningReview(trajectory: TaskTrajectory): void {
    try {
        // v6.4.0 — respect the config-level enable flag so operators who
        // turn the curator off in titan.json don't pay any cost per task.
        const cfg = loadCuratorConfig();
        if (!cfg.enabled) return;
        ingestTrajectoryLearningSignal(trajectory);
        const result = runLearningReview(trajectory, new Date(), cfg.minTrajectories);
        if (result.shouldRun) logger.info(COMPONENT, result.summary);
    } catch (err) {
        logger.warn(COMPONENT, `Learning review failed: ${(err as Error).message}`);
    }
}
