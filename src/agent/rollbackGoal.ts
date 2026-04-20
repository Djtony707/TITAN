/**
 * TITAN — Goal Rollback (v4.10.0-local, Phase A)
 *
 * One-click revert of every file a goal's driver wrote. Uses shadow-git
 * checkpoints (already captured by toolRunner before every write) to
 * restore each file to its pre-goal state.
 *
 * Flow:
 *   1. Load driver state for goal → collect artifact paths from subtasks
 *   2. For each file, find the EARLIEST checkpoint with a matching goal-id
 *      attribution (so we roll back to before the goal touched it)
 *   3. Restore via shadowGit.restoreCheckpoint
 *   4. Mark goal `closed` + file rollback episode
 *
 * Unlike `rejectStagedPR` (which handles pre-apply staging), this handles
 * goals whose writes already landed live and need to be undone.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'RollbackGoal';

export interface RollbackResult {
    filesReverted: string[];
    failedReverts: Array<{ path: string; error: string }>;
    goalClosed: boolean;
    reason?: string;
}

export async function rollbackGoal(goalId: string): Promise<RollbackResult> {
    const result: RollbackResult = {
        filesReverted: [],
        failedReverts: [],
        goalClosed: false,
    };

    // Load the driver state for this goal to get the artifact list
    let artifacts: string[] = [];
    try {
        const { getDriverState } = await import('./goalDriver.js');
        const state = getDriverState(goalId);
        if (!state) {
            result.reason = `No driver state for goal ${goalId}`;
            return result;
        }
        for (const sub of Object.values(state.subtaskStates)) {
            artifacts.push(...sub.artifacts);
        }
        artifacts = [...new Set(artifacts)];
    } catch (err) {
        result.reason = `Could not load driver state: ${(err as Error).message}`;
        return result;
    }

    // For each file, find the earliest checkpoint that pre-dates the goal
    // (driver writes attribute goalId in the fix-events and shadow-git
    // metadata via channel='initiative'). We pick the EARLIEST checkpoint
    // for the file after the goal started, and restore to the state BEFORE
    // that — i.e., the checkpoint immediately prior.
    const { getGoal } = await import('./goals.js').catch(() => ({ getGoal: () => null as null }));
    const goal = getGoal(goalId);
    if (!goal) {
        result.reason = `Goal ${goalId} not found`;
        return result;
    }
    const goalStartedMs = new Date(goal.createdAt).getTime();

    const { listCheckpoints, restoreCheckpoint } = await import('./shadowGit.js');

    for (const filePath of artifacts) {
        if (!filePath || filePath.startsWith('http') || filePath.startsWith('fact:')) continue;
        try {
            const checkpoints = listCheckpoints(filePath);
            // Sort by timestamp ascending
            checkpoints.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            // Find the LAST checkpoint taken BEFORE the goal started
            const preGoalCheckpoint = checkpoints
                .filter(c => new Date(c.timestamp).getTime() < goalStartedMs)
                .pop();
            if (!preGoalCheckpoint) {
                // File didn't exist before the goal — remove it
                try {
                    const { unlinkSync, existsSync } = await import('fs');
                    if (existsSync(filePath)) {
                        unlinkSync(filePath);
                        result.filesReverted.push(filePath);
                        logger.info(COMPONENT, `Removed (no pre-goal checkpoint): ${filePath}`);
                    }
                } catch (err) {
                    result.failedReverts.push({ path: filePath, error: `No pre-goal checkpoint; remove failed: ${(err as Error).message}` });
                }
                continue;
            }
            // Restore to the pre-goal state
            const msg = restoreCheckpoint(preGoalCheckpoint.id);
            if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('fail')) {
                result.failedReverts.push({ path: filePath, error: msg });
            } else {
                result.filesReverted.push(filePath);
                logger.info(COMPONENT, `Restored ${filePath} to ${preGoalCheckpoint.id}`);
            }
        } catch (err) {
            result.failedReverts.push({ path: filePath, error: (err as Error).message });
        }
    }

    // Mark goal closed
    try {
        const { updateGoal } = await import('./goals.js');
        updateGoal(goalId, { status: 'completed' });
        result.goalClosed = true;
    } catch (err) {
        result.reason = `Close goal failed: ${(err as Error).message}`;
    }

    // Log an episode so the rollback is searchable
    try {
        const { recordEpisode } = await import('../memory/episodic.js');
        recordEpisode({
            kind: 'goal_abandoned',
            summary: `Goal ${goalId} rolled back: ${result.filesReverted.length} file(s) reverted, ${result.failedReverts.length} failed`,
            detail: `Reverted: ${result.filesReverted.join(', ')}\nFailed: ${result.failedReverts.map(f => `${f.path} (${f.error})`).join(', ')}`,
            tags: ['rollback', 'goal-driver', goalId],
        });
    } catch { /* ok */ }

    return result;
}
