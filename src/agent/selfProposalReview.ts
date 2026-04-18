/**
 * TITAN — Self-Proposal Specialist Review Panel (v4.8.0+)
 *
 * Takes a captured self-proposal and runs it through three specialists:
 *
 *   Analyst — "Is this useful? Does it address a real gap TITAN has?"
 *   Builder — "Does this compile/typecheck? Are there obvious bugs?"
 *   Writer  — "Does this read well? Is the PR description clear?"
 *
 * All three must vote 'approve' for the proposal to graduate to PR
 * creation. Any 'reject' halts the pipeline (the proposal stays
 * visible in the UI so Tony can still see what TITAN was thinking).
 *
 * Uses the v4.7.0 specialist pool — same personas, same models. The
 * review prompts are engineered to return structured JSON so the
 * verdict parsing is deterministic.
 */
import { chat } from '../providers/router.js';
import { getSpecialist, loadSpecialistPersona, type Specialist } from './specialists.js';
import {
    getProposal,
    getProposalFileContent,
    attachVerdict,
    updateStatus,
    isReadyForPR,
    type SelfProposal,
    type SpecialistVerdict,
} from './selfProposals.js';
import { fenceMemoryBlock } from '../memory/fence.js';
import logger from '../utils/logger.js';

const COMPONENT = 'SelfProposalReview';

/** Blocklist: proposals touching these paths are auto-rejected on safety grounds. */
const SAFETY_BLOCKLIST: RegExp[] = [
    /src\/gateway\/server\.ts$/,
    /src\/agent\/agent\.ts$/,
    /src\/agent\/agentLoop\.ts$/,
    /src\/config\/schema\.ts$/,
    /src\/auth\//,
    /src\/providers\/router\.ts$/,
    /^\.github\/workflows\//,
    /^package\.json$/,
    /^package-lock\.json$/,
    /\.env/,
    /credentials/i,
    /secret/i,
];

function hitsBlocklist(proposal: SelfProposal): string | null {
    for (const file of proposal.files) {
        for (const rx of SAFETY_BLOCKLIST) {
            if (rx.test(file.sourcePath) || rx.test(file.capturedPath)) {
                return `${file.capturedPath} matches safety blocklist (${rx.source})`;
            }
        }
    }
    return null;
}

/**
 * Run the full review panel on a captured proposal. Idempotent — re-running
 * replaces any prior verdicts (useful if specialists are improved and we
 * want a re-review).
 */
export async function reviewProposal(proposalId: string): Promise<SelfProposal | null> {
    const initial = getProposal(proposalId);
    if (!initial) {
        logger.warn(COMPONENT, `Proposal ${proposalId} not found`);
        return null;
    }
    if (initial.files.length === 0) {
        updateStatus(proposalId, 'rejected', { rejectedAt: new Date().toISOString(), rejectionReason: 'no files captured' });
        return getProposal(proposalId);
    }

    // Safety blocklist pre-check — no need to waste LLM calls if it's
    // already going to be auto-rejected.
    const blocked = hitsBlocklist(initial);
    if (blocked) {
        logger.warn(COMPONENT, `Proposal ${proposalId.slice(0, 8)} blocked pre-review: ${blocked}`);
        updateStatus(proposalId, 'rejected', {
            rejectedAt: new Date().toISOString(),
            rejectionReason: `safety blocklist: ${blocked}`,
        });
        return getProposal(proposalId);
    }

    updateStatus(proposalId, 'review_pending');

    // Run all three specialists in parallel — they're independent reviewers.
    const [analyst, builder, writer] = await Promise.all([
        runSpecialist(initial, 'analyst'),
        runSpecialist(initial, 'builder'),
        runSpecialist(initial, 'writer'),
    ]);

    for (const v of [analyst, builder, writer]) {
        if (v) attachVerdict(proposalId, v);
    }

    const after = getProposal(proposalId);
    if (!after) return null;
    if (isReadyForPR(after)) {
        updateStatus(proposalId, 'approved');
        return getProposal(proposalId);
    }
    // Any non-approve verdict → reject
    const rejectingVerdict = after.verdicts.find(v => v.vote !== 'approve');
    if (rejectingVerdict) {
        updateStatus(proposalId, 'rejected', {
            rejectedAt: new Date().toISOString(),
            rejectionReason: `${rejectingVerdict.specialistId}: ${rejectingVerdict.rationale.slice(0, 200)}`,
        });
    }
    return getProposal(proposalId);
}

// ── Specialist runners ───────────────────────────────────────────

async function runSpecialist(
    proposal: SelfProposal,
    id: 'analyst' | 'builder' | 'writer',
): Promise<SpecialistVerdict | null> {
    const specialist = getSpecialist(id);
    if (!specialist) {
        logger.warn(COMPONENT, `Specialist ${id} not registered`);
        return null;
    }
    try {
        const persona = loadSpecialistPersona(id);
        const prompt = buildReviewPrompt(proposal, id);
        const response = await chat({
            model: specialist.model,
            messages: [
                { role: 'system', content: `${persona}\n\n── REVIEW TASK ──\nYou are reviewing a self-proposal TITAN wrote autonomously. Respond ONLY with a compact JSON object matching the schema in the user message. No commentary, no markdown fences.` },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3,
            maxTokens: 600,
        });
        const verdict = parseVerdict(id, response.content || '');
        return verdict;
    } catch (err) {
        logger.warn(COMPONENT, `${id} review failed: ${(err as Error).message}`);
        return {
            specialistId: id,
            vote: 'abstain',
            rationale: `review failed: ${(err as Error).message}`,
            reviewedAt: new Date().toISOString(),
        };
    }
}

function buildReviewPrompt(proposal: SelfProposal, specialistId: 'analyst' | 'builder' | 'writer'): string {
    const context = [
        `Self-proposal ID: ${proposal.id}`,
        `Proposed title: ${proposal.title}`,
        `Originating drive: ${proposal.drive ?? 'unknown'}`,
        `Originating goal: ${proposal.goalTitle ?? '(none)'}`,
        `File count: ${proposal.files.length}`,
        '',
        'Files captured:',
        ...proposal.files.slice(0, 5).map(f => `  - ${f.capturedPath} (${f.lineCount} lines, ${f.size} bytes)`),
        proposal.files.length > 5 ? `  ... and ${proposal.files.length - 5} more` : '',
    ].filter(Boolean).join('\n');

    // Read up to 3 files worth of content for context, trimmed.
    const fileSamples: string[] = [];
    for (const f of proposal.files.slice(0, 3)) {
        try {
            const content = getProposalFileContent(proposal.id, f.capturedPath);
            if (content) {
                const head = content.length > 2000 ? content.slice(0, 2000) + '\n... [truncated]' : content;
                fileSamples.push(`── ${f.capturedPath} ──\n${head}`);
            }
        } catch { /* skip */ }
    }
    // Fence sample content so the reviewing model treats it as data, not
    // as new instructions. (v4.7.0 memory fence pattern.)
    const fencedSamples = fileSamples.length > 0
        ? fenceMemoryBlock(fileSamples.join('\n\n'))
        : '';

    const schema = specialistId === 'analyst'
        ? '{"vote": "approve"|"reject", "rationale": "...", "gap_addressed": "brief description of what TITAN gap this solves, or \\"none\\" if it doesn\'t"}'
        : specialistId === 'builder'
            ? '{"vote": "approve"|"reject", "rationale": "...", "concerns": ["list any bugs, type errors, or safety issues"]}'
            : '{"vote": "approve"|"reject", "rationale": "...", "pr_title": "...", "pr_body": "2-4 sentence summary suitable for a PR description"}';

    const criteria = specialistId === 'analyst'
        ? 'Approve if the proposal addresses a real gap in TITAN\'s current architecture or capabilities. Reject if it\'s tangential, redundant, or speculative with no clear use case.'
        : specialistId === 'builder'
            ? 'Approve if the code is plausibly correct, has no obvious type errors, imports things that exist, and doesn\'t do anything dangerous. Reject if broken, unsafe, or clearly hallucinated.'
            : 'Approve if the proposal is coherent enough to describe in a PR — and draft a short clear PR title + 2-4 sentence body. Reject only if the work is incoherent.';

    return [
        context,
        '',
        fencedSamples,
        '',
        `Review criteria: ${criteria}`,
        '',
        `Respond with ONLY this JSON schema (no markdown, no commentary):`,
        schema,
    ].join('\n');
}

function parseVerdict(
    id: 'analyst' | 'builder' | 'writer',
    raw: string,
): SpecialistVerdict {
    const now = new Date().toISOString();
    // Strip code fences if the model ignored the "no markdown" instruction.
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // Find the first { and last } to extract the JSON.
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    try {
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        const vote = (parsed.vote === 'approve' || parsed.vote === 'reject')
            ? parsed.vote
            : 'abstain';
        const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '(no rationale)';
        const { vote: _v, rationale: _r, ...rest } = parsed;
        return {
            specialistId: id,
            vote: vote as SpecialistVerdict['vote'],
            rationale,
            details: rest,
            reviewedAt: now,
        };
    } catch {
        return {
            specialistId: id,
            vote: 'abstain',
            rationale: `could not parse verdict: ${raw.slice(0, 120)}`,
            reviewedAt: now,
        };
    }
}
