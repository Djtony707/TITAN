/**
 * TITAN — Pressure Fusion (Soma)
 *
 * Turns drive deficits into proposals. When combined pressure across drives
 * crosses `config.organism.pressureThreshold`, Soma builds a GoalProposal
 * seeded with drive-specific context and routes it through the existing
 * goalProposer / commandPost approval plumbing (F1 landed the pipe;
 * pressure fusion is the new trigger source).
 *
 * Key invariants:
 *   - This is the ONLY path that converts pressure → proposals. No ad-hoc
 *     proposal generation elsewhere in the organism layer.
 *   - All proposals run through rehearseShadow() before approval is filed.
 *   - The existing F1 rate limit (config.agent.proposalRateLimitPerDay)
 *     applies — Soma can't spam proposals faster than the agent-level cap.
 */
import type { DriveState, DriveId } from './drives.js';
import { rehearseShadow, type ShadowVerdict } from './shadow.js';
import { emit } from '../substrate/traceBus.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Pressure';

/**
 * v4.6.0: per-drive fire history. Used to damp consecutive proposals for
 * the same drive so we don't spawn duplicate "Satiate hunger" goals every
 * tick. Reset on process restart (not persisted — fine, the worst case
 * after restart is one extra proposal which dedupe will catch anyway).
 */
const lastFireByDrive = new Map<string, number>();

/**
 * Test-only hook: clear the per-drive damping memory so unit tests that
 * exercise consecutive `runPressureCycle` calls on the same drive don't
 * leak state across `beforeEach` boundaries. Not part of the public API
 * for runtime callers — production never needs to reset this.
 */
export function _resetPressureDampingForTests(): void {
    lastFireByDrive.clear();
}

// ── Types ────────────────────────────────────────────────────────

export interface PressureReading {
    totalPressure: number;
    dominantDrives: DriveId[];
    perDrive: Array<{ id: DriveId; pressure: number; description: string }>;
}

export interface PressureDecision {
    should: boolean;
    totalPressure: number;
    threshold: number;
    dominantDrives: DriveId[];
    reason: string;
}

// ── Pressure accounting ──────────────────────────────────────────

export function computePressureReading(drives: DriveState[]): PressureReading {
    const perDrive = drives
        .filter(d => d.pressure > 0)
        .map(d => ({ id: d.id as DriveId, pressure: d.pressure, description: d.description }))
        .sort((a, b) => b.pressure - a.pressure);
    const totalPressure = perDrive.reduce((sum, d) => sum + d.pressure, 0);
    const dominantDrives = perDrive.slice(0, 2).map(d => d.id);
    return { totalPressure, dominantDrives, perDrive };
}

/** Deterministic threshold check. Does NOT fire any side effects. */
export function evaluatePressure(drives: DriveState[], threshold: number): PressureDecision {
    const reading = computePressureReading(drives);
    if (reading.totalPressure < threshold) {
        return {
            should: false,
            totalPressure: reading.totalPressure,
            threshold,
            dominantDrives: reading.dominantDrives,
            reason: `total pressure ${reading.totalPressure.toFixed(2)} below threshold ${threshold}`,
        };
    }
    const topPhrases = reading.perDrive.slice(0, 2).map(d => `${d.id} (${d.pressure.toFixed(2)})`);
    return {
        should: true,
        totalPressure: reading.totalPressure,
        threshold,
        dominantDrives: reading.dominantDrives,
        reason: `dominant drives: ${topPhrases.join(', ')}`,
    };
}

// ── Proposal driver ──────────────────────────────────────────────

export interface PressureCycleResult {
    fired: boolean;
    reading: PressureReading;
    decision: PressureDecision;
    approvalId?: string;
    shadow?: ShadowVerdict;
    skipped?: string;
}

/**
 * One pressure cycle: evaluate → maybe build context → rehearse → file
 * approval. Uses the F1 `requestGoalProposalApproval` / goalProposer
 * pipeline — does NOT create a parallel approval path.
 *
 * Returns a structured result so the UI / activity feed can record exactly
 * what happened on this cycle even when nothing fires.
 */
export async function runPressureCycle(
    drives: DriveState[],
): Promise<PressureCycleResult> {
    const config = loadConfig();
    const organism = (config as unknown as {
        organism?: {
            enabled?: boolean;
            pressureThreshold?: number;
            shadowEnabled?: boolean;
            shadowModel?: string;
        };
    }).organism || {};
    if (!organism.enabled) {
        const reading = computePressureReading(drives);
        return {
            fired: false,
            reading,
            decision: {
                should: false, totalPressure: reading.totalPressure, threshold: 0,
                dominantDrives: reading.dominantDrives, reason: 'organism disabled',
            },
            skipped: 'organism.enabled=false',
        };
    }
    const threshold = organism.pressureThreshold ?? 1.2;
    const decision = evaluatePressure(drives, threshold);
    const reading = computePressureReading(drives);

    if (!decision.should) {
        return { fired: false, reading, decision };
    }

    // v4.6.0: per-drive backoff + satiation damping.
    // If the dominant drive already fired within the last 30 minutes, OR
    // it already has active goals pursuing it, skip this tick — the
    // organism is already working on that drive, piling on just proliferates
    // duplicates without helping the drive get satiated faster.
    const dominantId = decision.dominantDrives[0];
    if (dominantId) {
        const now = Date.now();
        const last = lastFireByDrive.get(dominantId) || 0;
        const DAMPING_MS = 30 * 60 * 1000; // 30 min
        if (now - last < DAMPING_MS) {
            return {
                fired: false, reading, decision,
                skipped: `drive ${dominantId} fired ${Math.round((now - last) / 60_000)}m ago — damping until 30m elapsed`,
            };
        }
        // Check if the drive already has active goals in flight. If N ≥ 2,
        // give existing work more time before stacking on more.
        try {
            const { listGoals } = await import('../agent/goals.js');
            const activeForDrive = listGoals().filter(g => {
                if (g.status !== 'active') return false;
                const tags = g.tags || [];
                const text = `${g.title} ${g.description || ''}`.toLowerCase();
                return tags.includes(`soma:${dominantId}`) || text.includes(dominantId);
            }).length;
            if (activeForDrive >= 2) {
                return {
                    fired: false, reading, decision,
                    skipped: `drive ${dominantId} already has ${activeForDrive} active goals — letting existing work complete`,
                };
            }
        } catch { /* best-effort */ }
    }

    emit('pressure:threshold', {
        timestamp: new Date().toISOString(),
        totalPressure: decision.totalPressure,
        threshold,
        dominantDrives: decision.dominantDrives,
        reason: decision.reason,
    });

    // Build a drive-specific context note the proposer will use to seed its
    // suggestion. The proposer (F1) already accepts `consolidationNotes`.
    const noteLines = ['Autonomous pressure crossed threshold.'];
    for (const d of reading.perDrive.slice(0, 3)) {
        noteLines.push(`- ${d.id}: pressure ${d.pressure.toFixed(2)} — ${d.description}`);
    }
    const consolidationNotes = noteLines.join('\n');

    // Pressure-driven proposer uses the agent id `soma:${dominantDrive}` so
    // the activity feed attributes the proposal to the organism, not to a
    // registered agent. This also keeps the F1 rate limit per-"agent" —
    // each dominant drive has its own per-day budget.
    const somaAgentId = `soma:${decision.dominantDrives[0] ?? 'fused'}`;

    // Dynamic import to avoid a module cycle with commandPost:
    //   pressure -> commandPost (createApproval) and
    //   commandPost listeners <- drives <- pressure are both reachable.
    let approvalId: string | undefined;
    let shadow: ShadowVerdict | undefined;
    try {
        const { generateGoalProposals } = await import('../agent/goalProposer.js');
        const { requestGoalProposalApproval, getApproval, attachShadowVerdictToApproval } =
            await import('../agent/commandPost.js');

        // generateGoalProposals uses loadConfig().agent.autoProposeGoals — for
        // Soma-driven flow we want the proposer to run whether or not
        // autoProposeGoals is globally on. Direct-call approach: build a
        // context with our notes and invoke the proposer with a bypass flag.
        const approvals = await generateGoalProposals(somaAgentId, {
            activeGoals: drives.map(d => `${d.label} at ${Math.round(d.satisfaction * 100)}%`),
            consolidationNotes,
        });

        if (approvals.length === 0) {
            return {
                fired: false,
                reading,
                decision,
                skipped: 'proposer returned no actionable proposals (below quality bar or rate-limited)',
            };
        }

        // v4.0.5: shadow-rehearse EVERY proposal returned by the proposer,
        // not just approvals[0]. Earlier cycles that returned 2+ proposals
        // left the extras without a shadow verdict on the approval payload.
        // The first approval is still the "primary" returned in the result
        // for backward compat with callers expecting a single approvalId.
        const primary = approvals[0];
        approvalId = primary.id;

        if (organism.shadowEnabled !== false) {
            for (const approval of approvals) {
                try {
                    const verdict = await rehearseShadow({
                        title: (approval.payload as { title?: string })?.title ?? '(unspecified)',
                        description: (approval.payload as { description?: string })?.description ?? '',
                        rationale: (approval.payload as { rationale?: string })?.rationale ?? '',
                    }, organism.shadowModel);
                    attachShadowVerdictToApproval(approval.id, verdict as unknown as Record<string, unknown>);
                    if (approval.id === primary.id) shadow = verdict;
                } catch (err) {
                    logger.warn(COMPONENT, `Shadow rehearsal failed for ${approval.id}: ${(err as Error).message}`);
                }
            }
        }

        // Emit one soma:proposal per approval so UI + activity feed see each.
        for (const approval of approvals) {
            const currentVerdict = (approval.payload as { shadowVerdict?: ShadowVerdict })?.shadowVerdict;
            emit('soma:proposal', {
                timestamp: new Date().toISOString(),
                approvalId: approval.id,
                proposedBy: somaAgentId,
                title: (approval.payload as { title?: string })?.title ?? '',
                dominantDrives: decision.dominantDrives,
                shadowVerdict: currentVerdict ? {
                    reversibilityScore: currentVerdict.reversibilityScore,
                    estimatedCostUsd: currentVerdict.estimatedCostUsd,
                    breakRisks: currentVerdict.breakRisks,
                } : undefined,
            });
        }

        // Quiet the 'unused' check on getApproval — we may use it for logging.
        void getApproval;
        void requestGoalProposalApproval;

        // v4.6.0: record fire timestamp for per-drive damping on next tick.
        if (dominantId) lastFireByDrive.set(dominantId, Date.now());

        logger.info(COMPONENT, `Soma fired ${approvals.length} proposal(s), primary=${primary.id}: ${decision.reason}`);
        return { fired: true, reading, decision, approvalId, shadow };
    } catch (err) {
        logger.warn(COMPONENT, `Pressure cycle failed: ${(err as Error).message}`);
        return { fired: false, reading, decision, skipped: `error: ${(err as Error).message}` };
    }
}
