/**
 * TITAN — Auto-Heal Runner (v4.10.0+)
 *
 * Bridges the 6 repair strategies in src/lib/auto-heal/repair-strategies.ts
 * into the self-repair daemon (src/safety/selfRepair.ts).
 *
 * The strategies were written but never wired — this module is the wiring.
 * On each self-repair sweep tick, `checkAutoHealOpportunities` evaluates
 * recent failures (fix-oscillation events, dependency issues) against each
 * strategy's `canHandle` method. When a strategy matches:
 *
 *   - If the strategy's repair actions would modify /opt/TITAN source files,
 *     we file a `self_mod_pr` approval (human-in-the-loop, per TITAN rules).
 *   - Otherwise, if dryRun is false, we execute the strategy directly and
 *     record the result as an episodic event.
 *   - If dryRun is true, we log the planned actions but skip execution.
 *
 * Architecture integration points (from architecture.ts):
 *   - Import strategy classes from src/lib/auto-heal/repair-strategies.ts
 *   - Call strategy.canHandle(issue) during fix-oscillation evaluation
 *   - If true, call strategy.execute(issue) and record as RepairResult
 *   - Fire a self_mod_pr approval if the strategy modifies /opt/TITAN
 *   - Log every repair attempt via episodic (kind=significant_learning)
 */
import logger from '../utils/logger.js';
import {
    MissingPackageRepair,
    BrokenImportRepair,
    VersionMismatchRepair,
    OrphanModuleRepair,
    ConfigErrorRepair,
    BuildFailureRepair,
} from '../lib/auto-heal/repair-strategies.js';
import type { DependencyIssue, RepairResult, AutoHealConfig, RepairAction } from '../lib/auto-heal/types.js';
import { DEFAULT_AUTO_HEAL_CONFIG } from '../lib/auto-heal/types.js';
import type { SelfRepairFinding } from './selfRepair.js';

const COMPONENT = 'AutoHealRunner';

// ── Strategy registry ────────────────────────────────────────────

interface HealStrategy {
    canHandle(issue: DependencyIssue): boolean;
    planActions(issue: DependencyIssue): RepairAction[];
    execute(issue: DependencyIssue): Promise<RepairResult>;
}

const strategies: HealStrategy[] = [
    new MissingPackageRepair(DEFAULT_AUTO_HEAL_CONFIG),
    new BrokenImportRepair(DEFAULT_AUTO_HEAL_CONFIG),
    new VersionMismatchRepair(DEFAULT_AUTO_HEAL_CONFIG),
    new OrphanModuleRepair(DEFAULT_AUTO_HEAL_CONFIG),
    new ConfigErrorRepair(DEFAULT_AUTO_HEAL_CONFIG),
    new BuildFailureRepair(DEFAULT_AUTO_HEAL_CONFIG),
];

// ── Issue sources ────────────────────────────────────────────────

/**
 * Convert a SelfRepairFinding into candidate DependencyIssues that
 * strategies can evaluate. Not every finding maps to a dependency issue —
 * only findings that suggest a package/build/config problem.
 */
function findingToDependencyIssues(finding: SelfRepairFinding): DependencyIssue[] {
    const issues: DependencyIssue[] = [];
    const now = Date.now();

    switch (finding.kind) {
        case 'episodic_anomaly': {
            // Repeated goal failures often stem from missing packages or
            // broken builds. Emit a generic build_failure issue so
            // BuildFailureRepair can attempt a clean install.
            const evidence = finding.evidence as Record<string, unknown>;
            const count = (evidence.count as number) ?? 0;
            if (count >= 10) {
                issues.push({
                    id: `episodic-build-${now}`,
                    category: 'build_failure',
                    message: `${count} goal_failed episodes in 24h — possible build/dependency issue`,
                    detectedAt: now,
                });
            }
            break;
        }
        case 'integrity_low': {
            // Low integrity ratio may indicate config drift.
            const evidence = finding.evidence as Record<string, unknown>;
            const ratio = (evidence.ratio as number) ?? 0;
            if (ratio < 0.5) {
                issues.push({
                    id: `integrity-config-${now}`,
                    category: 'config_error',
                    message: `Integrity ratio ${(ratio * 100).toFixed(1)}% — possible config corruption`,
                    detectedAt: now,
                });
            }
            break;
        }
        case 'drive_stuck_high':
        case 'goal_stuck_active':
        case 'memory_shape_drift':
        case 'working_memory_stale':
            // These don't map to dependency issues — handled by
            // selfRepair.ts's own suggested actions.
            break;
    }
    return issues;
}

/**
 * Scan fix-oscillation events for dependency-related patterns.
 * When the same file (especially package.json, tsconfig, etc.) is
 * oscillating, it often signals a dependency issue.
 */
async function oscillationEventsToIssues(): Promise<DependencyIssue[]> {
    const issues: DependencyIssue[] = [];
    try {
        const { getAllRecentEvents } = await import('./fixOscillation.js');
        const events = getAllRecentEvents(24 * 60 * 60 * 1000);

        // Group by target to find repeated file oscillations
        const byTarget = new Map<string, number>();
        for (const ev of events) {
            if (ev.kind !== 'file') continue;
            const count = byTarget.get(ev.target) ?? 0;
            byTarget.set(ev.target, count + 1);
        }

        const now = Date.now();
        for (const [target, count] of byTarget) {
            if (count < 2) continue; // need at least 2 fixes on same file

            // package.json oscillation → version mismatch or missing package
            if (target.includes('package.json') || target.includes('package-lock.json')) {
                issues.push({
                    id: `oscillate-version-${now}`,
                    category: 'version_mismatch',
                    packageName: extractPackageName(target),
                    message: `package.json oscillated ${count}x in 24h — likely version mismatch`,
                    detectedAt: now,
                });
            }

            // node_modules or import path oscillation → broken import
            if (target.includes('node_modules') || target.endsWith('.ts')) {
                issues.push({
                    id: `oscillate-import-${now}`,
                    category: 'broken_import',
                    importPath: target,
                    message: `File ${target.split('/').pop()} oscillated ${count}x in 24h — possible broken import`,
                    detectedAt: now,
                });
            }
        }
    } catch {
        // fixOscillation module may not be available
    }
    return issues;
}

function extractPackageName(path: string): string | undefined {
    // Try to extract a package name from a path like
    // /opt/titan/node_modules/some-pkg or /home/user/project/package.json
    const parts = path.split('/');
    const nmIdx = parts.indexOf('node_modules');
    if (nmIdx >= 0 && parts.length > nmIdx + 1) {
        return parts[nmIdx + 1];
    }
    return undefined;
}

// ── Self-mod detection ───────────────────────────────────────────

/**
 * Determine if a strategy's planned actions would modify /opt/TITAN
 * source files. Actions that touch /opt/TITAN require a self_mod_pr
 * approval per TITAN safety rules.
 */
function actionsModifyTitanSource(actions: RepairAction[]): boolean {
    const titanRoot = '/opt/titan';
    for (const action of actions) {
        const target = action.target ?? '';
        const cmd = action.command ?? '';
        // Commands like "rm -rf .next" or "npm ci" run in CWD which
        // is typically /opt/TITAN — those modify the source tree.
        if (target.toLowerCase().startsWith(titanRoot)) return true;
        if (cmd.includes('/opt/TITAN') || cmd.includes('/opt/titan')) return true;
        // "npm install" and "npm ci" modify node_modules inside the
        // project root — if that's /opt/TITAN, it's a self-mod.
        if (cmd.match(/\bnpm\s+(install|ci|uninstall)\b/) || cmd.match(/\brm\s+-rf\s+node_modules\b/) || cmd.match(/\brm\s+-rf\s+\.next\b/)) {
            return true;
        }
    }
    return false;
}

// ── Core: checkAutoHealOpportunities ─────────────────────────────

export interface AutoHealOpportunity {
    issue: DependencyIssue;
    strategy: HealStrategy;
    actions: RepairAction[];
    requiresSelfModPR: boolean;
}

export interface AutoHealCheckResult {
    opportunities: AutoHealOpportunity[];
    executed: Array<{ issueId: string; status: RepairResult['status']; output?: string }>;
    dryRunSkipped: number;
    selfModPRsFiled: number;
}

/**
 * Evaluate recent failures against all registered heal strategies.
 * Called by the self-repair daemon on each sweep tick.
 *
 * @param findings  — current sweep findings from selfRepair
 * @param dryRun    — if true, log planned actions but don't execute
 * @returns summary of what was found and what was done
 */
export async function checkAutoHealOpportunities(
    findings: SelfRepairFinding[],
    dryRun: boolean = true,
): Promise<AutoHealCheckResult> {
    const result: AutoHealCheckResult = {
        opportunities: [],
        executed: [],
        dryRunSkipped: 0,
        selfModPRsFiled: 0,
    };

    // 1. Collect candidate issues from findings
    const candidateIssues: DependencyIssue[] = [];
    for (const finding of findings) {
        candidateIssues.push(...findingToDependencyIssues(finding));
    }

    // 2. Also scan fix-oscillation events for dependency patterns
    const oscillationIssues = await oscillationEventsToIssues();
    candidateIssues.push(...oscillationIssues);

    if (candidateIssues.length === 0) {
        logger.debug(COMPONENT, 'No candidate dependency issues for auto-heal');
        return result;
    }

    // 3. Deduplicate issues by id
    const seen = new Set<string>();
    const uniqueIssues = candidateIssues.filter(i => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
    });

    // 4. Match each issue against strategies
    for (const issue of uniqueIssues) {
        for (const strategy of strategies) {
            if (!strategy.canHandle(issue)) continue;

            const actions = strategy.planActions(issue);
            const requiresPR = actionsModifyTitanSource(actions);

            const opportunity: AutoHealOpportunity = {
                issue,
                strategy,
                actions,
                requiresSelfModPR: requiresPR,
            };
            result.opportunities.push(opportunity);

            logger.info(COMPONENT, `Strategy ${strategy.constructor.name} can handle ${issue.category} [${issue.id}]: ${actions.map(a => a.description).join('; ')}`);

            // 5. Execute or file approval
            if (requiresPR) {
                // Self-mod path: file a self_mod_pr approval
                const filed = await fileSelfModApproval(opportunity);
                if (filed) result.selfModPRsFiled++;
            } else if (dryRun) {
                // Dry-run: log but don't execute
                logger.info(COMPONENT, `DRY RUN — would execute ${strategy.constructor.name} for ${issue.category} [${issue.id}]`);
                result.dryRunSkipped++;
            } else {
                // Live execution
                try {
                    const repairResult = await strategy.execute(issue);
                    result.executed.push({
                        issueId: issue.id,
                        status: repairResult.status,
                        output: repairResult.output?.slice(0, 500),
                    });
                    logger.info(COMPONENT, `Executed ${strategy.constructor.name} for ${issue.id}: ${repairResult.status}`);

                    // Record as episodic event
                    await recordHealEpisode(issue, strategy.constructor.name, repairResult);
                } catch (err) {
                    const msg = (err as Error).message;
                    logger.warn(COMPONENT, `Strategy ${strategy.constructor.name} failed for ${issue.id}: ${msg}`);
                    result.executed.push({ issueId: issue.id, status: 'failed', output: msg });
                }
            }

            // Only use the first matching strategy per issue
            break;
        }
    }

    if (result.opportunities.length > 0) {
        logger.warn(COMPONENT, `Auto-heal check: ${result.opportunities.length} opportunity(ies), ${result.selfModPRsFiled} PR(s) filed, ${result.executed.length} executed, ${result.dryRunSkipped} dry-run skipped`);
    }

    return result;
}

// ── File self_mod_pr approval ────────────────────────────────────

async function fileSelfModApproval(opportunity: AutoHealOpportunity): Promise<boolean> {
    try {
        const cp = await import('../agent/commandPost.js');

        // Dedupe: check for existing pending self_mod_pr for same issue
        const approvals = cp.listApprovals?.() ?? [];
        const existing = approvals.find((a: { status?: string; type?: string; payload?: Record<string, unknown> }) => {
            if (a.status !== 'pending' || a.type !== 'custom') return false;
            const payload = a.payload ?? {};
            if (payload.kind !== 'self_mod_pr') return false;
            if (payload.autoHealIssueId !== opportunity.issue.id) return false;
            return true;
        });
        if (existing) {
            logger.debug(COMPONENT, `Skipping duplicate self_mod_pr for issue ${opportunity.issue.id}`);
            return false;
        }

        // v4.13: consult sage before filing an auto-heal self_mod_pr.
        // If the advisor thinks the proposed fix is wrong for this issue,
        // don't bother Tony — log and wait for a better signal.
        try {
            const { peerAdvise } = await import('../agent/peerAdvise.js');
            const advice = await peerAdvise({
                kind: 'auto_heal_proposal',
                concern: `Auto-heal proposes ${opportunity.strategy.constructor.name} for ${opportunity.issue.category}: ${opportunity.issue.message}`,
                context: `Planned actions: ${opportunity.actions.map(a => `${a.type}: ${a.command || a.description}`).join(' | ')}`,
                advisor: 'sage',
                timeoutMs: 20000,
            });
            if (advice && advice.verdict !== 'escalate') {
                logger.info(COMPONENT, `auto-heal proposal ${advice.verdict} by sage: ${advice.reason.slice(0, 120)}`);
                return false;
            }
        } catch (peerErr) {
            logger.debug(COMPONENT, `peerAdvise failed: ${(peerErr as Error).message} — escalating`);
        }

        cp.createApproval({
            type: 'custom',
            requestedBy: 'auto-heal-runner',
            payload: {
                kind: 'self_mod_pr',
                source: 'auto-heal',
                autoHealIssueId: opportunity.issue.id,
                issueCategory: opportunity.issue.category,
                strategyName: opportunity.strategy.constructor.name,
                plannedActions: opportunity.actions.map(a => ({
                    type: a.type,
                    description: a.description,
                    command: a.command,
                    target: a.target,
                })),
                reason: `Auto-heal strategy ${opportunity.strategy.constructor.name} proposes repair for ${opportunity.issue.category}: ${opportunity.issue.message}`,
                severity: 'medium',
            },
            linkedIssueIds: [],
        });

        logger.info(COMPONENT, `Filed self_mod_pr approval for ${opportunity.issue.category} [${opportunity.issue.id}]`);

        // Record as episodic event
        const { recordEpisode } = await import('../memory/episodic.js');
        recordEpisode({
            kind: 'significant_learning',
            summary: `Auto-heal: filed self_mod_pr for ${opportunity.issue.category}`,
            detail: `Strategy ${opportunity.strategy.constructor.name} proposes: ${opportunity.actions.map(a => a.description).join('; ')}`,
            tags: ['auto-heal', 'self-mod-pr', opportunity.issue.category],
        });

        return true;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to file self_mod_pr: ${(err as Error).message}`);
        return false;
    }
}

// ── Episodic recording ───────────────────────────────────────────

async function recordHealEpisode(
    issue: DependencyIssue,
    strategyName: string,
    repairResult: RepairResult,
): Promise<void> {
    try {
        const { recordEpisode } = await import('../memory/episodic.js');
        recordEpisode({
            kind: 'significant_learning',
            summary: `Auto-heal: ${strategyName} ${repairResult.status} for ${issue.category}`,
            detail: `Issue: ${issue.message}. Status: ${repairResult.status}. Actions: ${repairResult.actions.map(a => a.description).join('; ')}. Output: ${(repairResult.output ?? '').slice(0, 200)}`,
            tags: ['auto-heal', issue.category, repairResult.status],
        });
    } catch {
        // episodic module may not be available
    }
}

// ── Public helpers ───────────────────────────────────────────────

/** Get the list of registered strategies (for testing/inspection). */
export function getRegisteredStrategies(): string[] {
    return strategies.map(s => s.constructor.name);
}

/** Update the config on all strategies (e.g. toggle dryRun). */
export function updateAutoHealConfig(config: Partial<AutoHealConfig>): void {
    const mergedConfig: AutoHealConfig = { ...DEFAULT_AUTO_HEAL_CONFIG, ...config };
    strategies.length = 0;
    strategies.push(
        new MissingPackageRepair(mergedConfig),
        new BrokenImportRepair(mergedConfig),
        new VersionMismatchRepair(mergedConfig),
        new OrphanModuleRepair(mergedConfig),
        new ConfigErrorRepair(mergedConfig),
        new BuildFailureRepair(mergedConfig),
    );
    logger.info(COMPONENT, `Config updated: dryRun=${mergedConfig.dryRun}, enabledCategories=${mergedConfig.enabledCategories.join(',')}`);
}

/** Test-only: reset strategies to defaults. */
export function _resetAutoHealForTests(): void {
    strategies.length = 0;
    strategies.push(
        new MissingPackageRepair(DEFAULT_AUTO_HEAL_CONFIG),
        new BrokenImportRepair(DEFAULT_AUTO_HEAL_CONFIG),
        new VersionMismatchRepair(DEFAULT_AUTO_HEAL_CONFIG),
        new OrphanModuleRepair(DEFAULT_AUTO_HEAL_CONFIG),
        new ConfigErrorRepair(DEFAULT_AUTO_HEAL_CONFIG),
        new BuildFailureRepair(DEFAULT_AUTO_HEAL_CONFIG),
    );
}
