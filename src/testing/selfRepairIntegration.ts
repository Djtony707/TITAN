/**
 * TITAN — Self-Repair Test Health Integration
 *
 * Bridges the test runner to the self-repair sweep. Called by
 * safety/selfRepair.ts::checkTestHealth() during each sweep.
 *
 * Returns findings when tests are failing, stale, or missing coverage.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'SelfRepairIntegration';

export interface SelfRepairFinding {
    kind:
        | 'drive_stuck_high'
        | 'goal_stuck_active'
        | 'memory_shape_drift'
        | 'episodic_anomaly'
        | 'integrity_low'
        | 'working_memory_stale';
    reason: string;
    evidence: Record<string, unknown>;
    suggestedAction: string;
    firstSeenAt: string;
    severity: 'low' | 'medium' | 'high';
}

/** Check test health and return findings for the self-repair sweep. */
export async function checkTestHealth(): Promise<SelfRepairFinding[]> {
    const findings: SelfRepairFinding[] = [];
    const now = new Date().toISOString();

    try {
        // Check if test runner state exists
        const testStatePath = join(TITAN_HOME, 'test-state.json');
        if (!existsSync(testStatePath)) {
            findings.push({
                kind: 'episodic_anomaly',
                reason: 'No test state found — test suite has never been run or state was lost',
                evidence: { testStatePath },
                suggestedAction: 'Run `titan test` to establish a baseline, then enable canary eval daemon',
                firstSeenAt: now,
                severity: 'medium',
            });
            return findings;
        }

        // Try to load test state and check for failures
        const { readFileSync } = await import('fs');
        const raw = readFileSync(testStatePath, 'utf-8');
        const state = JSON.parse(raw) as {
            lastRun?: string;
            totalTests?: number;
            failedTests?: number;
            passRate?: number;
        };

        const lastRun = state.lastRun ? new Date(state.lastRun) : null;
        const hoursSinceLastRun = lastRun ? (Date.now() - lastRun.getTime()) / 3600000 : Infinity;

        if (hoursSinceLastRun > 168) {
            findings.push({
                kind: 'working_memory_stale',
                reason: `Tests haven't run in ${Math.round(hoursSinceLastRun)}h — health signal is stale`,
                evidence: { lastRun: state.lastRun, hoursSinceLastRun },
                suggestedAction: 'Run `titan test` to refresh the health baseline',
                firstSeenAt: now,
                severity: 'low',
            });
        }

        if ((state.failedTests ?? 0) > 0 && (state.passRate ?? 1) < 0.95) {
            findings.push({
                kind: 'episodic_anomaly',
                reason: `Test pass rate is ${((state.passRate ?? 0) * 100).toFixed(1)}% with ${state.failedTests} failures`,
                evidence: { totalTests: state.totalTests, failedTests: state.failedTests, passRate: state.passRate },
                suggestedAction: 'Review failing tests with `titan test --verbose` and file fixes',
                firstSeenAt: now,
                severity: state.passRate && state.passRate < 0.8 ? 'high' : 'medium',
            });
        }

        if ((state.totalTests ?? 0) === 0) {
            findings.push({
                kind: 'working_memory_stale',
                reason: 'Test suite reports 0 tests — coverage may be missing or runner misconfigured',
                evidence: { totalTests: state.totalTests },
                suggestedAction: 'Verify test discovery paths in titan.json and run `titan test`',
                firstSeenAt: now,
                severity: 'medium',
            });
        }
    } catch (err) {
        logger.warn(COMPONENT, `Test health check failed: ${(err as Error).message}`);
        findings.push({
            kind: 'episodic_anomaly',
            reason: 'Test health check threw an exception — test infrastructure may be broken',
            evidence: { error: (err as Error).message },
            suggestedAction: 'Investigate test runner state file and fix any JSON corruption',
            firstSeenAt: now,
            severity: 'low',
        });
    }

    return findings;
}
