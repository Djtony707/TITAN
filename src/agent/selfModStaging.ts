/**
 * TITAN — Self-Modification Staging (v4.9.0-local.8)
 *
 * When a goal is tagged with a self-mod tag (see config.autonomy.selfMod.tags),
 * file mutations targeting the self-mod root (config.autonomy.selfMod.target)
 * are diverted into a per-goal staging directory instead of landing on the
 * live tree. The staged files surface as a single `self_mod_pr` approval the
 * human reviews and either applies or rejects.
 *
 * This exists because on 2026-04-18 TITAN completed 100% of a "self-healing
 * framework" goal by writing to `/home/dj/titan-saas/` — an unrelated Next.js
 * app. Not a single byte landed in `/opt/TITAN/`. The v4.8.0 self-proposal
 * pipeline never fired because the writes weren't even trying to reach TITAN's
 * source tree. The fix is three-layered:
 *
 *   1. Scope lock    — refuse writes outside `target` when the goal is tagged
 *   2. Goal rewriter — resolve ambiguous "framework" to explicit target path
 *   3. Staging gate  — redirect writes inside `target` to a staging dir + PR
 *
 * This module implements #3.
 *
 * Flow:
 *   - toolRunner calls `maybeStageWrite(sessionId, args)` before executing
 *   - If the active goal is self-mod tagged AND staging is enabled AND path
 *     is inside target, we rewrite `args.path` to the staging path and
 *     return the original target so the caller can attach it to the PR
 *   - After the write succeeds, toolRunner calls `recordStagedWrite(...)`
 *     which appends the file to the goal's PR bundle (creating the approval
 *     if it doesn't exist, or updating the `files[]` field if it does)
 *   - Tony views the approval, accepts → `applyStagedPR` copies files to
 *     live target under a shadow-git commit; rejects → the staging dir is
 *     archived and the approval resolved.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative, isAbsolute, dirname } from 'path';
import { loadConfig } from '../config/config.js';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { getSessionGoal } from './autonomyContext.js';

const COMPONENT = 'SelfModStaging';

// ── Config resolution ────────────────────────────────────────────

export interface SelfModConfig {
    target: string;
    tags: string[];
    staging: boolean;
    stagingDir: string;
}

export function resolveSelfModConfig(): SelfModConfig {
    const cfg = loadConfig();
    const sm = (cfg.autonomy as unknown as { selfMod?: Partial<SelfModConfig> }).selfMod ?? {};
    return {
        target: sm.target ?? '/opt/TITAN',
        tags: sm.tags ?? ['self-healing', 'self-repair', 'framework', 'architecture', 'core'],
        staging: sm.staging ?? true,
        stagingDir: sm.stagingDir ?? 'self-mod-staging',
    };
}

function absStagingRoot(sm: SelfModConfig = resolveSelfModConfig()): string {
    return isAbsolute(sm.stagingDir)
        ? sm.stagingDir
        : join(TITAN_HOME, sm.stagingDir);
}

// ── Tag match ────────────────────────────────────────────────────

/**
 * v4.10.0-local polish: patterns that indicate a goal is about TITAN
 * itself (vs an external project). If ANY tag matches one of these
 * patterns OR the goal title contains a matching phrase, the goal is
 * self-mod.
 *
 * Observed 2026-04-19 morning: TITAN drifted into ~/titan-saas writing
 * "pr-auto-assignment", "self-merge-prevention", "homelab-hardware-
 * abstraction" code because those tags didn't match the old literal
 * self-mod tag list. These patterns catch them.
 */
const SELF_MOD_TAG_PATTERNS = [
    /^soma:/i,                                  // any soma-driven goal
    /^self[-_\s]/i,                             // self-healing, self-repair, self-mod, self-merge
    /^(framework|architecture|core|autonomy)$/i, // the canonical ones
    /^(governance|process|reliability|stability|maintenance)$/i,  // organizational/infra goals
    /-framework$/i, /-governance$/i,            // *-framework, *-governance
    /^(security|observability)$/i,              // security scanning / telemetry for TITAN
    /^(hardware-?abstraction|homelab)$/i,       // homelab-hardware-abstraction → self-mod
    /^(pr-?assignment|pr-?auto|merge-?prevention)$/i, // repo/PR governance
    /^(testing|autonomous-?testing|test-?framework)$/i, // auto-testing framework
    /^(dependency|deps?|module-?lifecycle)$/i,  // dep management
];

function tagHintsSelfMod(tag: string): boolean {
    return SELF_MOD_TAG_PATTERNS.some(p => p.test(tag));
}

function titleHintsSelfMod(title: string | undefined): boolean {
    if (!title) return false;
    const t = title.toLowerCase();
    // Phrases that clearly indicate TITAN-internal work
    return /\b(titan|core framework|core module|titan['']?s?\s+(own|core|source|runtime|framework)|self-repair|self-heal|self-mod|autonomous (testing|patch|update|monitoring|security))/i.test(t);
}

export function goalMatchesSelfModTags(tags: string[] | undefined, sm: SelfModConfig = resolveSelfModConfig()): boolean {
    if (!tags || tags.length === 0) return false;
    const lowered = tags.map(t => t.toLowerCase());
    // v4.10.0-local fix: ANY soma-proposed goal is inherently about TITAN
    // itself (drives = internal signals, fixes should land in TITAN source).
    // Treat all `soma:*` tags as self-mod triggers so scope-lock + staging
    // kick in. Prevents the titan-saas drift pattern where TITAN "fixes" its
    // own curiosity pressure by writing utility code in an unrelated Next.js app.
    if (lowered.some(t => t.startsWith('soma:'))) return true;
    // v4.10.0-local polish: pattern matching covers all the cases the
    // literal list misses (hardware-abstraction, pr-assignment, etc).
    if (lowered.some(tagHintsSelfMod)) return true;
    const tagSet = new Set(lowered);
    return sm.tags.some(t => tagSet.has(t.toLowerCase()));
}

/**
 * Full check including title hints — used by decideScope so a goal with
 * vague tags but a clearly TITAN-focused title still gets scope-locked.
 */
export function goalMatchesSelfModContext(
    goalTitle: string | undefined,
    tags: string[] | undefined,
    sm: SelfModConfig = resolveSelfModConfig(),
): boolean {
    return goalMatchesSelfModTags(tags, sm) || titleHintsSelfMod(goalTitle);
}

// ── Path policy ──────────────────────────────────────────────────

/** Returns true when `filePath` is inside `sm.target` (after resolve). */
export function isInsideTarget(filePath: string, sm: SelfModConfig = resolveSelfModConfig()): boolean {
    const absTarget = resolve(sm.target);
    const absFile = resolve(filePath);
    if (absFile === absTarget) return true;
    return absFile.startsWith(absTarget + '/');
}

export interface ScopeDecision {
    action: 'allow' | 'reject' | 'stage';
    /** For `stage`: the path the tool should actually write to (inside staging dir). */
    stagedPath?: string;
    /** For `stage`: the final target path the file would land at after approval. */
    targetPath?: string;
    /** For `reject`: human-readable reason. */
    reason?: string;
}

/**
 * Decide whether a file mutation is allowed under the current session's goal.
 *
 * - If session has no goal context OR goal has no self-mod tags → `allow`
 * - If path is outside self-mod target → `reject` (scope lock)
 * - If staging disabled → `allow` (writes land directly on target)
 * - If staging enabled → `stage` (write redirected to staging dir)
 */
export function decideScope(sessionId: string | null, filePath: string): ScopeDecision {
    const goalCtx = getSessionGoal(sessionId);
    if (!goalCtx) return { action: 'allow' };
    const sm = resolveSelfModConfig();
    // v4.10.0-local polish: also check title — goals with vague tags but
    // TITAN-focused titles ("Add SSE driver-phase broadcasts to goalDriver")
    // should still scope-lock to /opt/TITAN.
    if (!goalMatchesSelfModContext(goalCtx.goalTitle, goalCtx.tags, sm)) return { action: 'allow' };

    // Goal is self-mod tagged — apply scope lock.
    const insideTarget = isInsideTarget(filePath, sm);
    if (!insideTarget) {
        return {
            action: 'reject',
            reason: `Goal "${goalCtx.goalTitle}" (tags: ${goalCtx.tags.join(', ')}) is self-modification-tagged. File writes MUST target ${sm.target} (the TITAN source tree). Refusing write to ${filePath}.`,
        };
    }

    if (!sm.staging) return { action: 'allow' };

    // Staging enabled — redirect to staging dir.
    const absTarget = resolve(sm.target);
    const absFile = resolve(filePath);
    const rel = relative(absTarget, absFile);
    const stagingRoot = absStagingRoot(sm);
    const stagedPath = join(stagingRoot, goalCtx.goalId, rel);
    return { action: 'stage', stagedPath, targetPath: absFile };
}

// ── Staged-write tracking + approval management ──────────────────

export interface StagedFileEntry {
    toolName: string;
    /** Path the human would see on disk if they apply the PR. */
    targetPath: string;
    /** Path the file actually lives at right now. */
    stagedPath: string;
    /** ISO timestamp of the write. */
    writtenAt: string;
    /** Byte size of the staged file, for the UI summary. */
    sizeBytes: number;
}

export interface SelfModPRBundle {
    goalId: string;
    goalTitle: string;
    proposedBy: string;
    tags: string[];
    files: StagedFileEntry[];
    createdAt: string;
    updatedAt: string;
}

/** In-memory map of goalId → approvalId (to update the same approval as new
 * files get staged, rather than creating a new approval per write). */
const approvalByGoalId = new Map<string, string>();

function readStagedSize(stagedPath: string): number {
    try { return statSync(stagedPath).size; } catch { return 0; }
}

/**
 * Record a write that just landed in the staging dir. Creates (or updates)
 * the goal's self_mod_pr approval so the human sees the accumulating bundle.
 */
export async function recordStagedWrite(input: {
    sessionId: string | null;
    toolName: string;
    stagedPath: string;
    targetPath: string;
}): Promise<void> {
    const goalCtx = getSessionGoal(input.sessionId);
    if (!goalCtx) return; // lost context — shouldn't happen but safe

    const entry: StagedFileEntry = {
        toolName: input.toolName,
        targetPath: input.targetPath,
        stagedPath: input.stagedPath,
        writtenAt: new Date().toISOString(),
        sizeBytes: readStagedSize(input.stagedPath),
    };

    // Load or create the bundle on disk (under the staging dir as bundle.json).
    // Previous code computed a bundlePath via regex replacement that was
    // immediately shadowed by actualBundlePath; removed the dead line —
    // also resolved Hunt Finding #18 (template-literal escape regex lint).
    const bundleDir = join(absStagingRoot(), goalCtx.goalId);
    const actualBundlePath = join(bundleDir, 'bundle.json');
    try { mkdirSync(bundleDir, { recursive: true }); } catch { /* ok */ }

    let bundle: SelfModPRBundle;
    if (existsSync(actualBundlePath)) {
        try {
            bundle = JSON.parse(readFileSync(actualBundlePath, 'utf-8')) as SelfModPRBundle;
        } catch {
            bundle = {
                goalId: goalCtx.goalId,
                goalTitle: goalCtx.goalTitle,
                proposedBy: goalCtx.proposedBy,
                tags: goalCtx.tags,
                files: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
        }
    } else {
        bundle = {
            goalId: goalCtx.goalId,
            goalTitle: goalCtx.goalTitle,
            proposedBy: goalCtx.proposedBy,
            tags: goalCtx.tags,
            files: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
    }
    // Dedup by targetPath — if the same file is written twice we keep the latest.
    bundle.files = bundle.files.filter(f => f.targetPath !== entry.targetPath);
    bundle.files.push(entry);
    bundle.updatedAt = entry.writtenAt;
    writeFileSync(actualBundlePath, JSON.stringify(bundle, null, 2));

    // Create the approval on first write for this goal. Subsequent writes
    // only update bundle.json; the approval payload points at that file as
    // source of truth, so the UI reads it lazily and we don't need a
    // commandPost updateApproval primitive. The bundle grows as TITAN
    // continues working; Tony sees the latest state whenever he opens it.
    const existingApprovalId = approvalByGoalId.get(goalCtx.goalId);
    if (existingApprovalId) {
        logger.debug(COMPONENT, `Appended to self_mod_pr bundle for goal ${goalCtx.goalId}: +${entry.targetPath} (approval ${existingApprovalId})`);
        return;
    }
    try {
        const cp = await import('./commandPost.js');
        const approval = cp.createApproval({
            type: 'custom',
            requestedBy: `self-mod:${bundle.proposedBy}`,
            payload: {
                kind: 'self_mod_pr',
                goalId: bundle.goalId,
                goalTitle: bundle.goalTitle,
                proposedBy: bundle.proposedBy,
                tags: bundle.tags,
                // Pointer to bundle.json which has the latest file list —
                // the approval handler reads this at apply-time.
                bundlePath: actualBundlePath,
                initialFileCount: bundle.files.length,
                firstFile: bundle.files[0]?.targetPath,
                target: resolveSelfModConfig().target,
            },
            linkedIssueIds: [],
        });
        if (approval?.id) {
            approvalByGoalId.set(goalCtx.goalId, approval.id);
            logger.info(COMPONENT, `Created self_mod_pr approval ${approval.id} for goal "${bundle.goalTitle}" (${bundle.files.length} file(s))`);
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to file self_mod_pr approval: ${(err as Error).message}`);
    }
}

/**
 * Apply a staged PR to the live target. Called by the approval handler
 * when the human approves. Each file is copied to its targetPath, with
 * the parent directory created as needed. A shadow-git checkpoint is
 * taken before each write so rollback is trivial.
 *
 * Returns the list of files successfully applied (for audit logging).
 */
export interface ApplyResult {
    applied: string[];
    failed: Array<{ path: string; error: string }>;
    bundle: SelfModPRBundle | null;
    /** v4.10.0-local polish: Opus review outcome, when it ran. */
    opusReview?: {
        verdict: string;
        confidence: number;
        reasoning: string;
        concerns: string[];
        suggestions: string[];
        model: string;
    };
    /** If opus rejected and blockOnReject is true, apply was skipped. */
    blockedByReview?: boolean;
}

export async function applyStagedPR(goalId: string): Promise<ApplyResult> {
    const applied: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const bundleDir = join(absStagingRoot(), goalId);
    const bundlePath = join(bundleDir, 'bundle.json');
    if (!existsSync(bundlePath)) {
        return { applied, failed: [{ path: bundlePath, error: 'bundle.json missing' }], bundle: null };
    }
    let bundle: SelfModPRBundle;
    try {
        bundle = JSON.parse(readFileSync(bundlePath, 'utf-8')) as SelfModPRBundle;
    } catch (err) {
        return { applied, failed: [{ path: bundlePath, error: `bundle parse failed: ${(err as Error).message}` }], bundle: null };
    }

    // v4.10.0-local (Phase D): security scan the bundle before we apply.
    // Secrets + incompatible licenses block the apply with a clear reason.
    try {
        const { scanBundle } = await import('./stagingScanners.js');
        const scan = scanBundle(bundleDir);
        if (scan.shouldBlock) {
            const summary = scan.findings
                .filter(f => f.severity === 'high')
                .slice(0, 5)
                .map(f => `  - ${f.path}:${f.line} [${f.pattern}] ${f.match}`)
                .join('\n');
            logger.warn(COMPONENT, `[StagingScanner] BLOCKED apply: ${scan.highSeverityCount} high-severity findings`);
            return {
                applied: [],
                failed: bundle.files.map(f => ({
                    path: f.targetPath,
                    error: `Scanner blocked apply — ${scan.highSeverityCount} high-severity findings:\n${summary}`,
                })),
                bundle,
            };
        }
    } catch (err) {
        logger.debug(COMPONENT, `Scanner skipped: ${(err as Error).message}`);
    }

    // v4.10.0-local polish: Opus review gate. After scanners pass, send
    // the bundle to Claude Opus (via OpenRouter) for a final review. If
    // the reviewer says `reject` (and blockOnReject=true), apply is
    // blocked and the concerns surface in the approval payload so the
    // human sees *why*. Scan → Opus → apply is the full safety chain.
    let opusReview: ApplyResult['opusReview'];
    try {
        const { reviewStagedBundle, reviewerBlocksOnReject } = await import('../safety/opusReview.js');
        const review = await reviewStagedBundle({
            goalId: bundle.goalId,
            goalTitle: bundle.goalTitle,
            tags: bundle.tags,
            files: bundle.files.map(f => ({
                targetPath: f.targetPath,
                stagedPath: f.stagedPath,
                sizeBytes: f.sizeBytes,
            })),
        });
        opusReview = {
            verdict: review.verdict,
            confidence: review.confidence,
            reasoning: review.reasoning,
            concerns: review.concerns,
            suggestions: review.suggestions,
            model: review.model,
        };
        if (review.verdict === 'reject' && reviewerBlocksOnReject()) {
            logger.warn(COMPONENT, `[OpusReview] BLOCKED apply: ${review.reasoning}`);
            return {
                applied: [],
                failed: bundle.files.map(f => ({
                    path: f.targetPath,
                    error: `Opus reviewer rejected: ${review.reasoning}\nConcerns:\n${review.concerns.map(c => `  - ${c}`).join('\n')}`,
                })),
                bundle,
                opusReview,
                blockedByReview: true,
            };
        }
        if (review.verdict === 'needs_changes' && reviewerBlocksOnReject()) {
            logger.warn(COMPONENT, `[OpusReview] BLOCKED apply — needs changes: ${review.reasoning}`);
            return {
                applied: [],
                failed: bundle.files.map(f => ({
                    path: f.targetPath,
                    error: `Opus reviewer flagged needs_changes: ${review.reasoning}\nFixes needed:\n${review.suggestions.map(s => `  - ${s}`).join('\n')}`,
                })),
                bundle,
                opusReview,
                blockedByReview: true,
            };
        }
        logger.info(COMPONENT, `[OpusReview] Verdict: ${review.verdict} (confidence ${review.confidence.toFixed(2)}) — proceeding with apply`);
    } catch (err) {
        logger.debug(COMPONENT, `Opus review skipped: ${(err as Error).message}`);
    }

    const { snapshotBeforeWrite } = await import('./shadowGit.js').catch(() => ({ snapshotBeforeWrite: async (_t: string, _p: string) => { /* ok */ } }));
    for (const f of bundle.files) {
        try {
            // Shadow-git snapshot so we can roll back if approval turns out bad.
            await snapshotBeforeWrite('self_mod_pr', f.targetPath).catch(() => { /* best effort */ });
            mkdirSync(dirname(f.targetPath), { recursive: true });
            copyFileSync(f.stagedPath, f.targetPath);
            applied.push(f.targetPath);
        } catch (err) {
            failed.push({ path: f.targetPath, error: (err as Error).message });
        }
    }
    // Archive the staged bundle for audit (rename staging/<goalId> → staging/applied-<goalId>-<ts>)
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveDir = join(absStagingRoot(), `applied-${goalId}-${ts}`);
        mkdirSync(archiveDir, { recursive: true });
        copyBundleDirectory(bundleDir, archiveDir);
        rmSync(bundleDir, { recursive: true, force: true });
        approvalByGoalId.delete(goalId);
    } catch (err) {
        logger.warn(COMPONENT, `Archive of applied bundle failed: ${(err as Error).message}`);
    }
    return { applied, failed, bundle, opusReview };
}

/**
 * Reject a staged PR — archive the bundle without applying.
 */
export function rejectStagedPR(goalId: string, reason: string): { archived: boolean } {
    const bundleDir = join(absStagingRoot(), goalId);
    if (!existsSync(bundleDir)) return { archived: false };
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveDir = join(absStagingRoot(), `rejected-${goalId}-${ts}`);
        mkdirSync(archiveDir, { recursive: true });
        writeFileSync(join(archiveDir, 'REJECTION.txt'), `Rejected at ${new Date().toISOString()}\nReason: ${reason}\n`);
        copyBundleDirectory(bundleDir, archiveDir);
        rmSync(bundleDir, { recursive: true, force: true });
        approvalByGoalId.delete(goalId);
        return { archived: true };
    } catch (err) {
        logger.warn(COMPONENT, `Failed to archive rejected bundle: ${(err as Error).message}`);
        return { archived: false };
    }
}

function copyBundleDirectory(from: string, to: string): void {
    // Simple recursive copy — avoids shelling out.
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
        const src = join(from, entry);
        const dst = join(to, entry);
        const st = statSync(src);
        if (st.isDirectory()) {
            copyBundleDirectory(src, dst);
        } else {
            copyFileSync(src, dst);
        }
    }
}

// ── Test-only helpers ────────────────────────────────────────────

export function _resetSelfModStagingForTests(): void {
    approvalByGoalId.clear();
}
