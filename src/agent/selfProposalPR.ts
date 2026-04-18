/**
 * TITAN — Self-Proposal PR Creator (v4.8.0+)
 *
 * Takes an approved self-proposal and opens a GitHub PR with the
 * captured files. Tony is ALWAYS the merge gate — TITAN can open
 * PRs but never merges its own changes.
 *
 * Safety rails:
 *   1. Requires git checkout present next to package.json (detects
 *      installed-via-npm case and degrades gracefully to "export
 *      bundle" mode).
 *   2. Branch name is ALWAYS `self/<drive>-<short-id>` — makes
 *      self-mod PRs impossible to confuse with normal work.
 *   3. Never forces, never amends, never touches main directly.
 *   4. Uses stored GitHub token (gh CLI config) — never asks for
 *      one interactively.
 *   5. All writes go through a git worktree or temp branch so the
 *      user's uncommitted work can't be clobbered.
 */
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getProposal, getProposalFileContent, updateStatus, type SelfProposal } from './selfProposals.js';
import logger from '../utils/logger.js';

const COMPONENT = 'SelfProposalPR';

// ── Repo detection ───────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Find the TITAN repo root (containing package.json + .git). Walks up
 * from this module's dirname. Returns null when running from an npm
 * install (no .git sibling of package.json).
 */
export function findRepoRoot(): string | null {
    let cur = resolve(__dirname);
    for (let i = 0; i < 6; i++) {
        const pkg = join(cur, 'package.json');
        const gitDir = join(cur, '.git');
        if (existsSync(pkg) && existsSync(gitDir)) return cur;
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return null;
}

/** Confirm the repo we found is actually TITAN (belt-and-suspenders). */
function isTitanRepo(repoRoot: string): boolean {
    try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
        return pkg.name === 'titan-agent';
    } catch { return false; }
}

// ── Branch naming ────────────────────────────────────────────────

function branchName(proposal: SelfProposal): string {
    const drive = proposal.drive || 'auto';
    const shortId = proposal.id.split('-')[0];
    const safeSlug = proposal.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return `self/${drive}-${safeSlug}-${shortId}`.slice(0, 80);
}

// ── Git ops ──────────────────────────────────────────────────────

function run(repoRoot: string, args: string[]): { stdout: string; stderr: string; code: number } {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', timeout: 60_000 });
    return {
        stdout: (r.stdout || '').trim(),
        stderr: (r.stderr || '').trim(),
        code: r.status ?? 1,
    };
}

function currentBranch(repoRoot: string): string {
    return run(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
}

// ── Mapping proposal files → target paths ────────────────────────

/**
 * Decide where an autonomous write should live in the TITAN repo.
 * TITAN often writes to `/home/<user>/biological-model/...` or
 * `/tmp/...` — we need to map that to a stable location inside the
 * repo (default: `self-proposals-staging/<proposalId>/<path>`).
 *
 * The staging area is intentionally NOT in src/ — even if merged,
 * the proposals don't auto-activate. Tony can move them into src/
 * deliberately after inspection.
 */
function targetPathInRepo(proposal: SelfProposal, relCapturedPath: string): string {
    return join('self-proposals', proposal.id.slice(0, 8), relCapturedPath);
}

// ── PR creation ──────────────────────────────────────────────────

export interface PRCreationResult {
    success: boolean;
    prUrl?: string;
    prNumber?: number;
    bundlePath?: string;   // when git/gh isn't available, a zip export path
    errorMessage?: string;
}

export async function createProposalPR(proposalId: string): Promise<PRCreationResult> {
    const proposal = getProposal(proposalId);
    if (!proposal) return { success: false, errorMessage: `proposal ${proposalId} not found` };
    if (proposal.status !== 'approved') {
        return { success: false, errorMessage: `proposal status is '${proposal.status}' — must be 'approved' to open PR` };
    }

    const repoRoot = findRepoRoot();
    if (!repoRoot || !isTitanRepo(repoRoot)) {
        // Degrade gracefully — export a bundle path and let Tony apply it manually.
        logger.warn(COMPONENT, 'No TITAN git checkout detected — PR creation degraded to bundle export');
        const bundlePath = await exportBundle(proposal);
        updateStatus(proposalId, 'error', {
            errorMessage: 'No git checkout — exported bundle instead. Apply manually: ' + bundlePath,
        });
        return { success: false, bundlePath, errorMessage: 'no git checkout; bundle exported' };
    }

    // Ensure `gh` is installed and authenticated — fail fast if not.
    try {
        execFileSync('gh', ['auth', 'status'], { encoding: 'utf-8', timeout: 10_000 });
    } catch (err) {
        updateStatus(proposalId, 'error', { errorMessage: 'gh CLI not authenticated: ' + (err as Error).message });
        return { success: false, errorMessage: 'gh CLI not authenticated' };
    }

    const origBranch = currentBranch(repoRoot);
    const newBranch = branchName(proposal);

    // Safety: refuse to operate if origBranch is already `self/*` (prevents
    // accidental chain-building from an earlier self-mod branch).
    if (origBranch.startsWith('self/')) {
        return { success: false, errorMessage: `refusing to create PR from existing self/* branch '${origBranch}' — return to main first` };
    }

    // Refuse if working tree is dirty — don't clobber Tony's in-progress work.
    const statusOut = run(repoRoot, ['status', '--porcelain']).stdout;
    if (statusOut) {
        return {
            success: false,
            errorMessage: `working tree has ${statusOut.split('\n').length} uncommitted changes — commit or stash before creating self-proposal PR`,
        };
    }

    try {
        // Make sure we branch off the tip of main (or whatever the default is).
        run(repoRoot, ['fetch', 'origin', 'main']);
        const checkout = run(repoRoot, ['checkout', '-b', newBranch, 'origin/main']);
        if (checkout.code !== 0) {
            throw new Error(`git checkout failed: ${checkout.stderr}`);
        }

        // Write each captured file into its target path
        for (const f of proposal.files) {
            const content = getProposalFileContent(proposalId, f.capturedPath);
            if (content === null) continue;
            const target = join(repoRoot, targetPathInRepo(proposal, f.capturedPath));
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, content, 'utf-8');
            run(repoRoot, ['add', target]);
        }

        // Commit
        const pr = buildPRDescription(proposal);
        const commit = run(repoRoot, ['commit', '-m', pr.title, '-m', pr.body]);
        if (commit.code !== 0) {
            // Could happen if hooks reject or nothing to commit
            throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
        }

        // Push
        const push = run(repoRoot, ['push', '-u', 'origin', newBranch]);
        if (push.code !== 0) {
            throw new Error(`git push failed: ${push.stderr}`);
        }

        // Create PR via gh
        const ghResult = spawnSync('gh', ['pr', 'create', '--title', pr.title, '--body', pr.body, '--head', newBranch, '--base', 'main'], {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: 30_000,
        });
        if (ghResult.status !== 0) {
            throw new Error(`gh pr create failed: ${ghResult.stderr}`);
        }
        const prUrl = (ghResult.stdout || '').trim();
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
        const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

        // Return to original branch so Tony's editor stays where he left it
        run(repoRoot, ['checkout', origBranch]);

        updateStatus(proposalId, 'pr_open', { prUrl, prNumber });
        logger.info(COMPONENT, `Opened PR for proposal ${proposalId.slice(0, 8)}: ${prUrl}`);
        return { success: true, prUrl, prNumber };
    } catch (err) {
        // Clean up — get back to the original branch
        try { run(repoRoot, ['checkout', origBranch]); } catch { /* best-effort */ }
        try { run(repoRoot, ['branch', '-D', newBranch]); } catch { /* best-effort */ }
        updateStatus(proposalId, 'error', { errorMessage: (err as Error).message });
        return { success: false, errorMessage: (err as Error).message };
    }
}

// ── PR description ───────────────────────────────────────────────

function buildPRDescription(proposal: SelfProposal): { title: string; body: string } {
    const writerVerdict = proposal.verdicts.find(v => v.specialistId === 'writer');
    const analystVerdict = proposal.verdicts.find(v => v.specialistId === 'analyst');

    // Prefer Writer's PR title/body if available
    const writerTitle = writerVerdict?.details?.pr_title as string | undefined;
    const writerBody = writerVerdict?.details?.pr_body as string | undefined;

    const title = writerTitle || `[self-proposal] ${proposal.title}`.slice(0, 100);

    const analystGap = analystVerdict?.details?.gap_addressed as string | undefined;
    const specVerdictLines = proposal.verdicts.map(v =>
        `- **${v.specialistId}**: ${v.vote} — ${v.rationale.slice(0, 160)}`,
    ).join('\n');

    const body = [
        '## Self-proposal from TITAN autonomous run',
        '',
        '> **This PR was generated autonomously by TITAN.**',
        '> The human (Tony) is the final merge gate. Review carefully.',
        '',
        writerBody || `TITAN's specialist panel approved this change. See verdicts below.`,
        '',
        '### Origin',
        `- Drive: **${proposal.drive ?? 'unknown'}**`,
        `- Goal: ${proposal.goalTitle ?? '(none)'}`,
        `- Proposal ID: \`${proposal.id}\``,
        `- Files: ${proposal.files.length}`,
        '',
        '### Gap addressed (Analyst)',
        analystGap || '_(not provided)_',
        '',
        '### Specialist verdicts',
        specVerdictLines,
        '',
        '### Safety notes',
        '- Files are staged under `self-proposals/<id>/` — NOT yet wired into TITAN runtime.',
        '- To activate: manually move files into their intended `src/` locations in a follow-up PR.',
        '- Rollback: `git revert` this PR. Nothing auto-activates.',
        '',
        '---',
        '🤖 Generated by TITAN self-modification pipeline (v4.8.0+)',
    ].join('\n');

    return { title, body };
}

// ── Bundle export (fallback when no git checkout) ────────────────

async function exportBundle(proposal: SelfProposal): Promise<string> {
    const { TITAN_HOME } = await import('../utils/constants.js');
    const exportDir = join(TITAN_HOME, 'self-proposals-exports');
    mkdirSync(exportDir, { recursive: true });
    const bundleDir = join(exportDir, `${proposal.id.slice(0, 8)}-${Date.now()}`);
    mkdirSync(bundleDir, { recursive: true });

    // Copy all files + proposal.json + PR description
    for (const f of proposal.files) {
        const content = getProposalFileContent(proposal.id, f.capturedPath);
        if (content === null) continue;
        const target = join(bundleDir, f.capturedPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf-8');
    }
    const pr = buildPRDescription(proposal);
    writeFileSync(join(bundleDir, 'PR_TITLE.txt'), pr.title, 'utf-8');
    writeFileSync(join(bundleDir, 'PR_BODY.md'), pr.body, 'utf-8');
    writeFileSync(join(bundleDir, 'proposal.json'), JSON.stringify(proposal, null, 2), 'utf-8');
    return bundleDir;
}

// ── PR merge-status polling (for drive learning) ─────────────────

/**
 * Poll GitHub for a proposal's PR merge/close status. Returns null if
 * status is unchanged, or the new status if the PR was merged or closed.
 * Requires `gh` auth.
 */
export async function pollPRStatus(proposalId: string): Promise<'merged' | 'closed_unmerged' | null> {
    const proposal = getProposal(proposalId);
    if (!proposal || proposal.status !== 'pr_open' || !proposal.prNumber) return null;
    try {
        const result = spawnSync('gh', ['pr', 'view', String(proposal.prNumber), '--json', 'state,mergedAt'], {
            encoding: 'utf-8',
            timeout: 15_000,
        });
        if (result.status !== 0) return null;
        const { state, mergedAt } = JSON.parse(result.stdout);
        if (state === 'MERGED') return 'merged';
        if (state === 'CLOSED' && !mergedAt) return 'closed_unmerged';
        return null;
    } catch (err) {
        logger.debug(COMPONENT, `pollPRStatus failed: ${(err as Error).message}`);
        return null;
    }
}
