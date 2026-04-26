/**
 * TITAN — Conflict Resolver
 * Detects and proposes resolutions for goal, agent, resource, file, and config conflicts.
 */
import { listGoals } from './goals.js';
import { listAgents } from './multiAgent.js';
import logger from '../utils/logger.js';

const COMPONENT = 'ConflictResolver';

export interface ConflictProposal {
    status: 'resolved' | 'needs_approval' | 'unresolvable' | 'no_conflict';
    summary: string;
    type: string;
    resolution?: 'merge' | 'prioritize' | 'sequentialize' | 'reject' | 'escalate' | 'none';
    details?: string[];
    needsApproval: boolean;
    approvalPayload?: {
        kind: string;
        goalId?: string;
        agentId?: string;
        title: string;
        description: string;
    };
}

export const conflictResolver = {
    async generateProposal(opts: {
        entities: string[];
        type: string;
        description: string;
        metadata?: Record<string, unknown>;
    }): Promise<ConflictProposal> {
        const { entities, type, description, metadata } = opts;

        switch (type) {
            case 'goal':
                return resolveGoalConflict(entities, description, metadata);
            case 'agent':
                return resolveAgentConflict(entities, description, metadata);
            case 'resource':
                return resolveResourceConflict(entities, description, metadata);
            case 'file':
                return resolveFileConflict(entities, description, metadata);
            case 'config':
                return resolveConfigConflict(entities, description, metadata);
            default:
                return {
                    status: 'unresolvable',
                    summary: `Unclassified conflict: ${description}`,
                    type,
                    needsApproval: true,
                    approvalPayload: {
                        kind: 'conflict_resolution',
                        title: 'Unclassified conflict detected',
                        description,
                    },
                };
        }
    },

    formatProposal(proposal: ConflictProposal): string {
        const lines: string[] = [];
        lines.push(`## Conflict Report — ${proposal.type.toUpperCase()}`);
        lines.push('');
        lines.push(`**Status:** ${proposal.status}`);
        lines.push('');
        lines.push(`**Summary:** ${proposal.summary}`);
        if (proposal.resolution && proposal.resolution !== 'none') {
            lines.push('');
            lines.push(`**Proposed Resolution:** ${proposal.resolution}`);
        }
        if (proposal.details?.length) {
            lines.push('');
            lines.push('**Details:**');
            for (const d of proposal.details) lines.push(`- ${d}`);
        }
        if (proposal.needsApproval) {
            lines.push('');
            lines.push('⚠️ **Human approval required** before this resolution is applied.');
        }
        return lines.join('\n');
    },
};

// ─── Domain-specific resolvers ───────────────────────────────────────────

function resolveGoalConflict(
    entities: string[],
    description: string,
    _metadata?: Record<string, unknown>,
): ConflictProposal {
    const goals = listGoals('active');
    const involved = goals.filter(g => entities.includes(g.id) || entities.includes(g.title));

    // Pattern 1: Duplicate active titles
    const titles = involved.map(g => g.title.trim().toLowerCase());
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    if (dupes.length > 0) {
        const keep = involved[0];
        const drop = involved.slice(1);
        return {
            status: 'resolved',
            summary: `Duplicate active goals detected: "${keep.title}". Proposing merge.`,
            type: 'goal',
            resolution: 'merge',
            details: [
                `Keep: ${keep.id} (${keep.title})`,
                ...drop.map(g => `Merge into keep: ${g.id} (${g.title})`),
            ],
            needsApproval: false,
        };
    }

    // Pattern 2: Budget overrun
    const overBudget = involved.filter(g => g.budgetLimit && g.totalCost >= g.budgetLimit);
    if (overBudget.length > 0) {
        return {
            status: 'needs_approval',
            summary: `Goal(s) over budget: ${overBudget.map(g => g.title).join(', ')}.`,
            type: 'goal',
            resolution: 'escalate',
            details: overBudget.map(g => `"${g.title}" $${g.totalCost.toFixed(2)} / $${g.budgetLimit!.toFixed(2)}`),
            needsApproval: true,
            approvalPayload: {
                kind: 'conflict_resolution',
                goalId: overBudget[0].id,
                title: 'Goal budget exceeded',
                description: `Goal "${overBudget[0].title}" has exceeded its $${overBudget[0].budgetLimit} budget.`,
            },
        };
    }

    return {
        status: 'no_conflict',
        summary: `No actionable goal conflict detected for: ${description}`,
        type: 'goal',
        resolution: 'none',
        needsApproval: false,
    };
}

function resolveAgentConflict(
    entities: string[],
    description: string,
    _metadata?: Record<string, unknown>,
): ConflictProposal {
    const agents = listAgents();

    // Pattern 1: Max agents hit
    if (agents.length >= 5) {
        return {
            status: 'needs_approval',
            summary: 'Maximum agent limit (5) reached. Cannot spawn new agent.',
            type: 'agent',
            resolution: 'reject',
            details: [`Current agents: ${agents.map(a => a.name).join(', ')}`],
            needsApproval: true,
            approvalPayload: {
                kind: 'conflict_resolution',
                title: 'Agent limit reached',
                description: 'Cannot spawn a new agent — max 5 agents are already running.',
            },
        };
    }

    // Pattern 2: Stale agents
    const stale = agents.filter(a => a.status === 'stopped');
    if (stale.length > 0) {
        return {
            status: 'resolved',
            summary: `Stale agents detected: ${stale.map(a => a.name).join(', ')}. Recommending removal.`,
            type: 'agent',
            resolution: 'reject',
            details: stale.map(a => `${a.id} status=${a.status}`),
            needsApproval: false,
        };
    }

    return {
        status: 'no_conflict',
        summary: `No actionable agent conflict detected for: ${description}`,
        type: 'agent',
        resolution: 'none',
        needsApproval: false,
    };
}

function resolveResourceConflict(
    entities: string[],
    description: string,
    metadata?: Record<string, unknown>,
): ConflictProposal {
    const writeTools = (metadata?.writeTools as string[]) || [];
    if (writeTools.length > 1) {
        return {
            status: 'resolved',
            summary: `Multiple write tools (${writeTools.length}) requested in parallel. Sequentializing.`,
            type: 'resource',
            resolution: 'sequentialize',
            details: writeTools.map(t => `- ${t}`),
            needsApproval: false,
        };
    }

    return {
        status: 'no_conflict',
        summary: `No actionable resource conflict detected for: ${description}`,
        type: 'resource',
        resolution: 'none',
        needsApproval: false,
    };
}

function resolveFileConflict(
    entities: string[],
    description: string,
    _metadata?: Record<string, unknown>,
): ConflictProposal {
    if (entities.length > 1) {
        return {
            status: 'needs_approval',
            summary: `Multiple goals are writing to the same file(s): ${entities.join(', ')}.`,
            type: 'file',
            resolution: 'merge',
            details: entities.map(p => `- ${p}`),
            needsApproval: true,
            approvalPayload: {
                kind: 'conflict_resolution',
                title: 'File write conflict detected',
                description: `The following files have competing staged writes: ${entities.join(', ')}.`,
            },
        };
    }

    return {
        status: 'no_conflict',
        summary: `No actionable file conflict detected for: ${description}`,
        type: 'file',
        resolution: 'none',
        needsApproval: false,
    };
}

function resolveConfigConflict(
    entities: string[],
    description: string,
    _metadata?: Record<string, unknown>,
): ConflictProposal {
    if (entities.length >= 2) {
        return {
            status: 'needs_approval',
            summary: `Conflicting configuration values for key "${entities[0]}": ${description}`,
            type: 'config',
            resolution: 'escalate',
            details: entities,
            needsApproval: true,
            approvalPayload: {
                kind: 'conflict_resolution',
                title: 'Configuration conflict',
                description,
            },
        };
    }
    return {
        status: 'no_conflict',
        summary: `No actionable config conflict detected for: ${description}`,
        type: 'config',
        resolution: 'none',
        needsApproval: false,
    };
}
