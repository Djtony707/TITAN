/**
 * TITAN — Approval headline extractor (shared)
 *
 * Produces a human-readable headline + detail for each approval card
 * based on the approval type + payload kind. Used by both CPApprovals
 * and CommandPostHub's inline ApprovalsTab so every approval card is
 * actionable at a glance — no more blank rows where the user has to
 * click "Show full payload" to guess what they're approving.
 */
import type { CPApproval } from '@/api/types';

export interface ApprovalPayload {
    kind?: string;
    question?: string;
    goalTitle?: string;
    title?: string;
    reason?: string;
    finding?: string;
    suggestedAction?: string;
    target?: string;
    description?: string;
    urgency?: string;
    severity?: string;
    subtaskKind?: string;
    goalId?: string;
    rationale?: string;
    name?: string;
    role?: string;
    metric?: string;
    delta?: number;
    evidence?: Record<string, unknown>;
    // canary_regression shape
    regressions?: Array<{ taskId: string; baseline: number; current: number }>;
    model?: string;
}

export interface HeadlineInfo {
    kindLabel: string;
    headline: string;
    detail?: string;
    urgency?: 'high' | 'medium' | 'low';
}

/**
 * Build a headline + detail for an approval. Never returns empty —
 * falls through to any human-readable field, then to a synthesized
 * default based on the approval type.
 */
export function extractApprovalHeadline(a: CPApproval): HeadlineInfo {
    const p = (a.payload as unknown as ApprovalPayload) || {};
    const kind = p.kind;

    if (kind === 'driver_blocked') {
        return {
            kindLabel: 'Driver blocked',
            headline: p.question || 'Specialist needs clarification',
            detail: p.goalTitle ? `Goal: ${p.goalTitle}${p.subtaskKind ? ` · ${p.subtaskKind}` : ''}` : undefined,
            urgency: 'high',
        };
    }
    if (kind === 'self_mod_pr') {
        const pp = a.payload as unknown as Record<string, unknown>;
        const fileCount = pp.initialFileCount as number | undefined;
        const firstFile = pp.firstFile as string | undefined;
        const proposedBy = pp.proposedBy as string | undefined;
        const detailParts: string[] = [];
        if (typeof fileCount === 'number' && fileCount > 0) {
            detailParts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
        }
        if (firstFile) detailParts.push(firstFile.split('/').slice(-2).join('/'));
        if (p.target) detailParts.push(`→ ${p.target}`);
        if (proposedBy) detailParts.push(`by ${proposedBy}`);
        return {
            kindLabel: 'Self-mod PR',
            headline: p.goalTitle ? `Code changes for: ${p.goalTitle}` : 'Code changes pending review',
            detail: detailParts.length > 0 ? detailParts.join(' · ') : p.suggestedAction,
            urgency: 'medium',
        };
    }
    if (kind === 'self_repair') {
        const ev = (p.evidence || {}) as Record<string, unknown>;
        const driveId = ev.driveId as string | undefined;
        const findingKind = p.finding || 'finding';
        return {
            kindLabel: 'Self-repair',
            headline: p.reason || `${findingKind}${driveId ? ` (${driveId})` : ''}`,
            detail: p.suggestedAction,
            urgency: (p.severity as 'high' | 'medium' | 'low') || 'medium',
        };
    }
    if (kind === 'canary_regression') {
        const regs = p.regressions || [];
        const summary = regs.length > 0
            ? regs.map(r => `${r.taskId} ${(r.baseline * 100).toFixed(0)}%→${(r.current * 100).toFixed(0)}%`).join(', ')
            : null;
        return {
            kindLabel: 'Canary regression',
            headline: summary
                ? `Quality drop on ${regs.length} task(s): ${summary}`
                : (p.reason || 'Model quality regression detected'),
            detail: p.suggestedAction || (p.model ? `Model: ${p.model}` : undefined),
            urgency: 'high',
        };
    }
    if (a.type === 'goal_proposal' || a.type === 'soma_proposal' || kind === 'goal_proposal') {
        return {
            kindLabel: a.type === 'soma_proposal' ? 'Soma proposal' : 'New goal proposal',
            headline: p.title || p.goalTitle || 'Goal proposal',
            detail: p.description?.slice(0, 180) || p.rationale?.slice(0, 180),
            urgency: 'medium',
        };
    }
    if (a.type === 'hire_agent') {
        return {
            kindLabel: 'Hire agent',
            headline: p.name ? `Hire "${p.name}" as ${p.role || 'agent'}` : 'Hire new agent',
            urgency: 'medium',
        };
    }
    if (a.type === 'budget_override') {
        return {
            kindLabel: 'Budget override',
            headline: 'Agent requesting budget continuation',
            detail: p.reason,
            urgency: 'medium',
        };
    }

    // Generic fallback — use any human-readable field we can find
    const headline =
        p.question ||
        p.title ||
        p.goalTitle ||
        p.reason ||
        p.finding ||
        p.description ||
        p.rationale ||
        `${a.type.replace(/_/g, ' ')} from ${a.requestedBy}`;
    return {
        kindLabel: (kind || a.type).replace(/_/g, ' '),
        headline: String(headline).slice(0, 200),
        urgency: (p.urgency as 'high' | 'medium' | 'low') || 'low',
    };
}

export function approvalUrgencyColor(u?: 'high' | 'medium' | 'low'): string {
    if (u === 'high') return 'text-red-300 bg-red-500/10 border-red-500/30';
    if (u === 'medium') return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
    return 'text-white/40 bg-white/[0.04] border-white/10';
}
