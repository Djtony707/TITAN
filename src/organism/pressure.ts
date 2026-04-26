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
import { readJsonFile, writeJsonFile } from '../utils/helpers.js';
import { SOMADRIVE_STATE_PATH } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Pressure';

/**
 * v4.6.0: per-drive fire history. Used to damp consecutive proposals for
 * the same drive so we don't spawn duplicate goals every tick.
 * Persisted to disk so damping survives restarts.
 */
const lastFireByDrive = new Map<string, number>();
let lastGlobalFire = 0;

// Load persisted damping state on module init.
(function loadDampingState() {
    const raw = readJsonFile<Record<string, number>>(SOMADRIVE_STATE_PATH);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const now = Date.now();
        const DAMPING_MS = 2 * 60 * 60 * 1000; // v5.0.0: increased to 2h
        for (const [k, v] of Object.entries(raw)) {
            if (typeof v === 'number' && now - v < DAMPING_MS * 2) {
                lastFireByDrive.set(k, v);
            }
        }
    }
})();

function saveDampingState() {
    const obj: Record<string, number> = {};
    for (const [k, v] of lastFireByDrive) obj[k] = v;
    writeJsonFile(SOMADRIVE_STATE_PATH, obj);
}

/**
 * Test-only hook: clear the per-drive damping memory so unit tests that
 * exercise consecutive `runPressureCycle` calls on the same drive don't
 * leak state across `beforeEach` boundaries. Not part of the public API
 * for runtime callers — production never needs to reset this.
 */
export function _resetPressureDampingForTests(): void {
    lastFireByDrive.clear();
    lastGlobalFire = 0;
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

    // v4.9.0: if the kill switch fired, refuse to run the pressure cycle.
    // Goals + specialists already got paused by the kill sequence; we
    // must not propose more work until Tony resumes.
    try {
        const { isKilled } = await import('../safety/killSwitch.js');
        if (isKilled()) {
            const reading = computePressureReading(drives);
            return {
                fired: false,
                reading,
                decision: {
                    should: false, totalPressure: reading.totalPressure, threshold: 0,
                    dominantDrives: reading.dominantDrives, reason: 'kill switch active',
                },
                skipped: 'kill switch active — awaiting human resume',
            };
        }
    } catch { /* safety module unavailable — continue */ }

    // v4.9.0: evaluate sustained Safety pressure so the kill switch
    // can fire if Safety stays > 2.0 for 10 minutes. Best-effort.
    try {
        const safety = drives.find(d => d.id === 'safety');
        if (safety) {
            const { evaluateSafetyPressure } = await import('../safety/killSwitch.js');
            evaluateSafetyPressure(safety.pressure);
        }
    } catch { /* ok */ }
    const threshold = organism.pressureThreshold ?? 1.2;
    const decision = evaluatePressure(drives, threshold);
    const reading = computePressureReading(drives);

    if (!decision.should) {
        return { fired: false, reading, decision };
    }

    // v5.0.0: Global cooldown + per-drive backoff + goal-overload detection.
    const now = Date.now();
    const GLOBAL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour max across ALL drives
    if (now - lastGlobalFire < GLOBAL_COOLDOWN_MS) {
        return {
            fired: false, reading, decision,
            skipped: `global cooldown: last SOMA proposal ${Math.round((now - lastGlobalFire) / 60_000)}m ago (min 60m)`,
        };
    }

    const dominantId = decision.dominantDrives[0];
    if (dominantId) {
        const last = lastFireByDrive.get(dominantId) || 0;
        const DAMPING_MS = 2 * 60 * 60 * 1000; // v5.0.0: 2h per drive
        if (now - last < DAMPING_MS) {
            return {
                fired: false, reading, decision,
                skipped: `drive ${dominantId} fired ${Math.round((now - last) / 60_000)}m ago — damping until 2h elapsed`,
            };
        }
        // Check if the drive already has active goals in flight. If N ≥ 2,
        // give existing work more time before stacking on more.
        try {
            const { listGoals } = await import('../agent/goals.js');
            const allGoals = listGoals();
            const activeCount = allGoals.filter(g => g.status === 'active').length;

            // Goal overload: if there are too many active goals, refuse to add MORE.
            // Instead the organism should focus on completing existing work.
            if (activeCount >= 30) {
                return {
                    fired: false, reading, decision,
                    skipped: `goal overload: ${activeCount} active goals — organism focuses on existing work before proposing more`,
                };
            }

            const activeForDrive = allGoals.filter(g => {
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

    // v5.3.2 Track B: when Social drive is dominant, point the proposer at
    // a concrete `facebook_post` action. Without this hint the proposer
    // sees "social pressure high" and might propose anything (run a sub-
    // agent, generate a status report) — none of which satisfies the
    // actual deficit. The Social drive now blends agent staleness +
    // time-since-last-FB-post; if the dominant cause is the posting
    // drought, propose a post.
    if (decision.dominantDrives[0] === 'social') {
        // perDrive doesn't carry inputs — read them off DriveState directly.
        const socialDrive = drives.find(d => d.id === 'social');
        const hoursSince = (socialDrive?.inputs?.hoursSinceLastPost as number) ?? 0;
        if (hoursSince >= 6) {
            noteLines.push(
                '',
                'PROPOSAL HINT: Social drive deficit is driven by Facebook posting drought.',
                `It has been ~${Math.round(hoursSince)}h since the last FB post.`,
                'Propose a goal of type `facebook_post` with one of these contentTypes:',
                '  - "activity"  — post real TITAN runtime activity from the last 24h',
                '  - "stats"     — post download/install milestones if any crossed today',
                '  - "promo"     — promo a recent feature shipment (only if a release tagged today)',
                'Only propose if there is genuine activity to share — empty/generic posts are worse than none.',
            );
        }
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
        }, 'soma_proposal');

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
                description: (approval.payload as { description?: string })?.description ?? '',
                rationale: (approval.payload as { rationale?: string })?.rationale ?? '',
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

        // v5.0.0: record fire timestamps for damping on next tick.
        lastGlobalFire = Date.now();
        if (dominantId) {
            lastFireByDrive.set(dominantId, Date.now());
            saveDampingState();
        }

        logger.info(COMPONENT, `Soma fired ${approvals.length} proposal(s), primary=${primary.id}: ${decision.reason}`);
        return { fired: true, reading, decision, approvalId, shadow };
    } catch (err) {
        logger.warn(COMPONENT, `Pressure cycle failed: ${(err as Error).message}`);
        return { fired: false, reading, decision, skipped: `error: ${(err as Error).message}` };
    }
}
