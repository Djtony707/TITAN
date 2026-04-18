/**
 * TITAN — Self-Modification Pipeline (v4.8.0+)
 *
 * Captures autonomous write_file outputs from Soma-proposed goals,
 * routes them through specialist review, and opens GitHub PRs for human
 * merge. The human is ALWAYS the final gate — TITAN can propose but
 * never merges its own changes.
 *
 * Lifecycle:
 *   captured          — file written by autonomous agent, stored for review
 *   review_pending    — specialist panel queued
 *   approved          — all specialists voted ✅, ready for PR
 *   rejected          — specialist panel voted ❌ (quality/safety/utility)
 *   pr_open           — PR opened on GitHub, awaiting human merge
 *   merged            — human merged — drive gets positive reinforcement
 *   closed_unmerged   — human closed without merge — drive dampens
 *   error             — pipeline failed (PR creation, etc.)
 *
 * Storage: <TITAN_HOME>/self-proposals/<id>/
 *   proposal.json     — full metadata
 *   files/            — captured file tree (mirrors source paths)
 *   verdicts.json     — specialist review output (once reviewed)
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, relative, isAbsolute } from 'path';
import { createHash, randomUUID } from 'crypto';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';
import { loadConfig } from '../config/config.js';
import { emit } from '../substrate/traceBus.js';

const COMPONENT = 'SelfProposals';

/** Tools whose outputs we consider "proposals" when run under autonomy. */
const CAPTURE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'apply_patch']);

export type ProposalStatus =
    | 'captured'
    | 'review_pending'
    | 'approved'
    | 'rejected'
    | 'pr_open'
    | 'merged'
    | 'closed_unmerged'
    | 'error';

export interface SpecialistVerdict {
    specialistId: 'scout' | 'builder' | 'writer' | 'analyst';
    vote: 'approve' | 'reject' | 'abstain';
    rationale: string;
    details?: Record<string, unknown>;
    reviewedAt: string;
}

export interface CapturedFile {
    sourcePath: string;    // absolute path the autonomous agent wrote to
    capturedPath: string;  // relative path under proposal/files/
    size: number;
    sha256: string;
    lineCount: number;
}

export interface SelfProposal {
    id: string;
    createdAt: string;
    updatedAt: string;
    status: ProposalStatus;
    /** Which Soma drive proposed the originating goal (if any). */
    drive: string | null;
    /** Goal title + id if the file write happened under a goal. */
    goalId: string | null;
    goalTitle: string | null;
    /** Which agent (session) wrote the file. */
    sessionId: string | null;
    agentId: string | null;
    /** One-line summary auto-generated from the first file. */
    title: string;
    files: CapturedFile[];
    verdicts: SpecialistVerdict[];
    prUrl?: string;
    prNumber?: number;
    mergedAt?: string;
    rejectedAt?: string;
    rejectionReason?: string;
    /** The drive-learning delta applied when merged/closed. */
    driveLearning?: { deltaSatisfaction: number; appliedAt: string };
    /** Error trace if the pipeline failed partway. */
    errorMessage?: string;
}

// ── Storage layout ───────────────────────────────────────────────

function rootDir(): string {
    return join(TITAN_HOME, 'self-proposals');
}

function proposalDir(id: string): string {
    return join(rootDir(), id);
}

function metaPath(id: string): string {
    return join(proposalDir(id), 'proposal.json');
}

function verdictsPath(id: string): string {
    return join(proposalDir(id), 'verdicts.json');
}

function ensureDir(path: string): void {
    try { mkdirSync(path, { recursive: true }); } catch { /* already exists */ }
}

// ── Heuristics ───────────────────────────────────────────────────

/**
 * Should this write be captured? Requires autonomous mode AND a Soma-linked
 * goal. We explicitly don't capture writes from user-driven chat sessions —
 * only autonomous self-initiated work flows through here.
 */
export function shouldCapture(opts: {
    toolName: string;
    autonomous: boolean;
    goalProposedBy?: string | null;
}): boolean {
    if (!opts.autonomous) return false;
    if (!CAPTURE_TOOLS.has(opts.toolName)) return false;

    // Feature gate: only capture when selfMod.enabled is true.
    try {
        const config = loadConfig() as unknown as { selfMod?: { enabled?: boolean } };
        if (!config.selfMod?.enabled) return false;
    } catch { return false; }

    // Require the originating goal to be Soma-proposed (not a user task).
    // If we can't determine the goal, err on the side of NOT capturing —
    // better to miss some than spam the proposal queue with user work.
    if (!opts.goalProposedBy) return false;
    if (!opts.goalProposedBy.startsWith('soma:')) return false;
    return true;
}

/** Extract the drive id from a Soma-style proposer string like 'soma:curiosity'. */
export function driveFromProposer(proposedBy: string | null | undefined): string | null {
    if (!proposedBy) return null;
    const m = proposedBy.match(/^soma:([a-z0-9_-]+)$/i);
    return m ? m[1].toLowerCase() : null;
}

// ── Capture ──────────────────────────────────────────────────────

interface CaptureInput {
    toolName: string;
    filePath: string;        // where the agent wrote
    content: string;         // what they wrote (if known)
    sessionId: string | null;
    agentId: string | null;
    goalId: string | null;
    goalTitle: string | null;
    goalProposedBy: string | null;
}

/**
 * Capture an autonomous write as a self-proposal. Idempotent per
 * (sessionId, filePath) — subsequent writes to the same file within
 * the same session append to the existing proposal rather than create
 * a new one (handles multi-file goals and iterative refinement).
 */
export function captureWrite(input: CaptureInput): SelfProposal | null {
    try {
        const drive = driveFromProposer(input.goalProposedBy);
        const existing = findOpenProposalForSession(input.sessionId);
        const proposal = existing ?? createProposal({
            drive,
            goalId: input.goalId,
            goalTitle: input.goalTitle,
            sessionId: input.sessionId,
            agentId: input.agentId,
            title: deriveTitle(input.filePath, input.content),
        });

        const captured = writeCapturedFile(proposal.id, input.filePath, input.content);
        // Dedupe by capturedPath (later writes to same file supersede earlier).
        proposal.files = proposal.files.filter(f => f.capturedPath !== captured.capturedPath);
        proposal.files.push(captured);
        proposal.updatedAt = new Date().toISOString();
        saveProposal(proposal);

        emit('soma:proposal', {
            timestamp: proposal.updatedAt,
            approvalId: proposal.id,
            proposedBy: `self-mod:${drive ?? 'unknown'}`,
            title: `self-proposal: ${proposal.title}`,
            dominantDrives: drive ? [drive] : [],
        });

        logger.info(COMPONENT, `Captured ${input.toolName} on ${basename(input.filePath)} → proposal ${proposal.id.slice(0, 8)} (${proposal.files.length} file${proposal.files.length === 1 ? '' : 's'})`);
        return proposal;
    } catch (err) {
        logger.warn(COMPONENT, `Capture failed for ${input.filePath}: ${(err as Error).message}`);
        return null;
    }
}

function deriveTitle(filePath: string, content: string): string {
    const name = basename(filePath);
    // Try to extract a meaningful summary from the file content
    const firstComment = content.match(/\/\*\*?\s*\n?\s*\*?\s*([^\n*]{10,80})/);
    if (firstComment) return `${name}: ${firstComment[1].trim()}`;
    const firstLine = content.split('\n').find(l => l.trim().length > 5 && !l.trim().startsWith('//'));
    if (firstLine) return `${name}: ${firstLine.trim().slice(0, 80)}`;
    return name;
}

function createProposal(seed: {
    drive: string | null;
    goalId: string | null;
    goalTitle: string | null;
    sessionId: string | null;
    agentId: string | null;
    title: string;
}): SelfProposal {
    const now = new Date().toISOString();
    const proposal: SelfProposal = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        status: 'captured',
        drive: seed.drive,
        goalId: seed.goalId,
        goalTitle: seed.goalTitle,
        sessionId: seed.sessionId,
        agentId: seed.agentId,
        title: seed.title,
        files: [],
        verdicts: [],
    };
    ensureDir(proposalDir(proposal.id));
    ensureDir(join(proposalDir(proposal.id), 'files'));
    saveProposal(proposal);
    return proposal;
}

function writeCapturedFile(proposalId: string, sourcePath: string, content: string): CapturedFile {
    // Capture with a path that mirrors the source but is always relative.
    // If the source is absolute, strip leading / and home prefix.
    let rel = sourcePath;
    if (isAbsolute(rel)) {
        rel = rel.replace(/^\/+/, '');
        if (rel.startsWith('home/')) rel = rel.replace(/^home\/[^/]+\//, '');
    }
    const target = join(proposalDir(proposalId), 'files', rel);
    ensureDir(dirname(target));
    writeFileSync(target, content, 'utf-8');
    return {
        sourcePath,
        capturedPath: rel,
        size: Buffer.byteLength(content, 'utf-8'),
        sha256: createHash('sha256').update(content).digest('hex'),
        lineCount: content.split('\n').length,
    };
}

function saveProposal(proposal: SelfProposal): void {
    ensureDir(proposalDir(proposal.id));
    writeFileSync(metaPath(proposal.id), JSON.stringify(proposal, null, 2), 'utf-8');
}

// ── Read / list ──────────────────────────────────────────────────

export function listProposals(limit = 100): SelfProposal[] {
    if (!existsSync(rootDir())) return [];
    const ids = readdirSync(rootDir()).filter(f => {
        try {
            return statSync(join(rootDir(), f)).isDirectory();
        } catch { return false; }
    });
    const out: SelfProposal[] = [];
    for (const id of ids) {
        try {
            const raw = readFileSync(metaPath(id), 'utf-8');
            out.push(JSON.parse(raw) as SelfProposal);
        } catch { /* skip malformed */ }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
}

export function getProposal(id: string): SelfProposal | null {
    try {
        if (!existsSync(metaPath(id))) return null;
        return JSON.parse(readFileSync(metaPath(id), 'utf-8')) as SelfProposal;
    } catch { return null; }
}

export function getProposalFileContent(id: string, relPath: string): string | null {
    try {
        const p = join(proposalDir(id), 'files', relPath);
        // Path traversal guard — must stay within proposal dir.
        const resolved = relative(proposalDir(id), p);
        if (resolved.startsWith('..')) return null;
        if (!existsSync(p)) return null;
        return readFileSync(p, 'utf-8');
    } catch { return null; }
}

function findOpenProposalForSession(sessionId: string | null): SelfProposal | null {
    if (!sessionId) return null;
    const all = listProposals(200);
    return all.find(p =>
        p.sessionId === sessionId
        && (p.status === 'captured' || p.status === 'review_pending')
    ) || null;
}

// ── Status transitions ───────────────────────────────────────────

export function updateStatus(id: string, status: ProposalStatus, patch: Partial<SelfProposal> = {}): SelfProposal | null {
    const p = getProposal(id);
    if (!p) return null;
    Object.assign(p, patch);
    p.status = status;
    p.updatedAt = new Date().toISOString();
    saveProposal(p);
    logger.info(COMPONENT, `Proposal ${id.slice(0, 8)} → ${status}`);
    return p;
}

export function attachVerdict(id: string, verdict: SpecialistVerdict): SelfProposal | null {
    const p = getProposal(id);
    if (!p) return null;
    // Replace any prior verdict from the same specialist (idempotent re-review)
    p.verdicts = p.verdicts.filter(v => v.specialistId !== verdict.specialistId);
    p.verdicts.push(verdict);
    p.updatedAt = new Date().toISOString();
    writeFileSync(verdictsPath(id), JSON.stringify(p.verdicts, null, 2), 'utf-8');
    saveProposal(p);
    return p;
}

/** Is the proposal ready to progress to PR? All 3 reviewers must approve. */
export function isReadyForPR(p: SelfProposal): boolean {
    if (p.status !== 'review_pending' && p.status !== 'approved') return false;
    const required: Array<SpecialistVerdict['specialistId']> = ['analyst', 'builder', 'writer'];
    return required.every(r => p.verdicts.some(v => v.specialistId === r && v.vote === 'approve'));
}
