/**
 * TITAN — Goal Retrospectives (v4.10.0-local, Phase B)
 *
 * After every goal driver reaches a terminal phase (done/failed/cancelled),
 * we write a retrospective to `experiments.ts` capturing:
 *   - what we tried (hypothesis + approach)
 *   - what worked (outcome + artifacts)
 *   - what didn't (lessons, specialists that failed)
 *   - how expensive it was (tokens, cost, elapsed, retries)
 *
 * Next time the proposer considers a similar goal, it reads these
 * retrospectives via `findSimilarExperiments()` → avoids repeating known
 * failure patterns and reuses proven approaches.
 *
 * Closes SOMA's learning loop at the long-term layer: drives satisfy,
 * proposer learns, next goal is smarter.
 */
import logger from '../utils/logger.js';
import type { Goal } from './goals.js';
import type { DriverState } from './goalDriverTypes.js';

const COMPONENT = 'Retrospectives';

export interface GoalRetrospective {
    goalId: string;
    goalTitle: string;
    success: boolean;
    durationMs: number;
    tokensUsed: number;
    costUsd: number;
    totalRetries: number;
    subtaskCount: number;
    specialists: string[];
    phaseHistory: string[]; // compact form: ['planning', 'delegating', 'blocked', ...]
    kinds: string[];
    lessons: string[];
    tags: string[];
}

export function summarizeRetrospective(goal: Goal, state: DriverState): GoalRetrospective {
    const specialists = [...new Set(
        Object.values(state.subtaskStates).map(s => s.specialist).filter((x): x is string => !!x),
    )];
    const kinds = [...new Set(Object.values(state.subtaskStates).map(s => s.kind))];
    const phaseHistory = state.history
        .map(h => h.phase)
        .filter((p, i, arr) => i === 0 || p !== arr[i - 1]); // dedupe consecutive same-phase entries

    const lessons: string[] = [];
    const success = state.phase === 'done';
    if (success) {
        lessons.push(
            `${kinds.join('+')} goal completed in ${Math.round(state.budget.elapsedMs / 1000)}s across ${specialists.length} specialist(s)`,
        );
        if (state.budget.totalRetries > 0) {
            lessons.push(`Required ${state.budget.totalRetries} retries — fallback chain necessary`);
        }
    } else {
        const failedSubs = Object.entries(state.subtaskStates)
            .filter(([, s]) => s.verificationResult?.passed === false)
            .map(([id, s]) => `${id} (${s.kind}): ${s.verificationResult?.reason.slice(0, 60)}`);
        if (failedSubs.length > 0) {
            lessons.push(`Failed subtasks: ${failedSubs.join('; ')}`);
        }
        const lastHist = state.history[state.history.length - 1];
        if (lastHist) lessons.push(`Final phase: ${lastHist.phase} — ${lastHist.note.slice(0, 100)}`);
    }

    return {
        goalId: goal.id,
        goalTitle: goal.title,
        success,
        durationMs: state.budget.elapsedMs,
        tokensUsed: state.budget.tokensUsed,
        costUsd: state.budget.costUsd,
        totalRetries: state.budget.totalRetries,
        subtaskCount: Object.keys(state.subtaskStates).length,
        specialists,
        phaseHistory,
        kinds,
        lessons,
        tags: goal.tags || [],
    };
}

/**
 * Write the retrospective into experiments.ts so future goal proposals
 * can learn from it. The experiment's `lesson` field is used by the
 * proposer's "don't-redo" logic.
 */
export async function saveRetrospective(goal: Goal, state: DriverState): Promise<void> {
    try {
        const retro = summarizeRetrospective(goal, state);
        const { recordExperiment, completeExperiment } = await import('../memory/experiments.js');

        // Map driver state's drive source to experiment driver enum
        const proposedBy = goal.tags?.find(t => t.startsWith('soma:'))?.slice(5);
        const driverKey = ['curiosity', 'hunger', 'purpose', 'safety', 'social'].includes(proposedBy ?? '')
            ? proposedBy as 'curiosity' | 'hunger' | 'purpose' | 'safety' | 'social'
            : 'other';

        // 1. Record the experiment (hypothesis + approach)
        const hypothesisText = `Goal "${goal.title}" — driven by ${retro.specialists.join(', ') || 'main agent'}`;
        const exp = recordExperiment({
            hypothesis: hypothesisText,
            approach: `Phases: ${retro.phaseHistory.join(' → ')}. Kinds: ${retro.kinds.join(', ')}.`,
            driver: driverKey,
            tags: ['goal-driver', ...retro.tags],
        });

        // 2. Complete it immediately with the outcome + lesson so the
        //    proposer's similarity check picks it up right away.
        if (exp?.id) {
            const lesson = retro.lessons.join('\n');
            completeExperiment(
                exp.id,
                retro.success ? 'succeeded' : 'failed',
                lesson,
            );
        }

        logger.info(COMPONENT, `Recorded retrospective for ${goal.id}: success=${retro.success}, specialists=[${retro.specialists.join(',')}]`);
    } catch (err) {
        logger.warn(COMPONENT, `Could not save retrospective: ${(err as Error).message}`);
    }
}
