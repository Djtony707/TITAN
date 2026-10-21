/**
 * TITAN — Self-Modification Staging (v4.9.0-local.8)
 *
 * When a goal is tagged with a self-mod tag (see config.autonomy.selfMod.tags),
 * file mutations targeting the self-mod root (config.autonomy.selfMod.target)
 * are diverted into a per-goal staging directory instead of landing on the
 * live tree. The staged files surface as a single `self_mod_pr` approval the
 * human can inspect, export or reject; runtime application is security-held.
 *
 * This exists because on 2026-04-18 TITAN completed 100% of a "self-healing
 * framework" goal by writing to `<sibling-project>/` — an unrelated Next.js
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
 *   - Approval records the decision but cannot bypass the runtime apply hold.
 *     Manual inspection/export remains available; rejecting archives the bundle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
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
 * - If staging disabled → `reject` (runtime self-mod apply is security-held)
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

    if (!sm.staging) return {
        action: 'reject',
        reason: 'Runtime self-modification is under a security hold. Enable staging for candidate inspection/export; direct self-mod writes are disabled.',
    };

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
                // Pointer for manual inspection/export. Runtime application is held.
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
 * Runtime application is held until immutable reviewed bytes, contained targets
 * and human approval are bound to the same candidate revision. Staging and
 * rejection remain available; approving a candidate cannot bypass this hold.
 */
export const SELF_MOD_APPLY_SECURITY_HOLD = 'Runtime self-mod apply is disabled by a security hold pending immutable reviewed bytes, target containment, and revision-bound human approval. The candidate remains staged for manual review and export.';

export interface ApplyResult {
    applied: string[];
    failed: Array<{ path: string; error: string }>;
    bundle: SelfModPRBundle | null;
    blockedBySecurityHold: true;
}

export async function applyStagedPR(goalId: string): Promise<ApplyResult> {
    // Deliberately do not read mutable bundle metadata or start scanners,
    // reviewers, snapshots, copies or archival while this boundary is held.
    return {
        applied: [],
        failed: [{ path: goalId, error: SELF_MOD_APPLY_SECURITY_HOLD }],
        bundle: null,
        blockedBySecurityHold: true,
    };
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
