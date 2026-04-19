/**
 * TITAN — Self-Directed Goal Proposer
 *
 * Runs during the nightly dreaming cycle (Phase 4: Dream) after memory
 * consolidation has happened. Each registered agent examines recent activity,
 * open issues, failed subtasks, and consolidation findings, then proposes
 * 0-3 new goals it thinks would be worth doing.
 *
 * Proposals go into the Command Post approval queue as `type: 'goal_proposal'`.
 * A human (or designated approver agent) accepts or rejects them. On accept,
 * the existing createGoal() pipeline fires and Initiative picks up the work.
 *
 * Opt-in via config.agent.autoProposeGoals (default false).
 * Rate-limited per-agent via config.agent.proposalRateLimitPerDay.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { ensureDir } from '../utils/helpers.js';
import { loadConfig } from '../config/config.js';
import { chat } from '../providers/router.js';
import { applyOutputGuardrails } from './outputGuardrails.js';
import { getActivity, requestGoalProposalApproval, type CPApproval } from './commandPost.js';
import { listGoals } from './goals.js';
import logger from '../utils/logger.js';

const COMPONENT = 'GoalProposer';
const RATE_STATE_PATH = join(TITAN_HOME, 'goal-proposer-state.json');

// ── Types ────────────────────────────────────────────────────────

export interface ProposedGoal {
    title: string;
    description: string;
    rationale: string;
    priority?: number;
    tags?: string[];
    parentGoalId?: string;
    subtasks?: Array<{ title: string; description: string; dependsOn?: string[] }>;
}

export interface GoalProposerContext {
    /** Recent activity feed entries — max last 50. */
    recentActivity?: string[];
    /** Titles of currently active goals so proposals don't duplicate. */
    activeGoals?: string[];
    /** Titles of recently failed subtasks worth retrying or reframing. */
    failedSubtasks?: string[];
    /** Free-form notes from the dreaming consolidation log. */
    consolidationNotes?: string;
    /**
     * v4.9.0-local.4: extra prompt blocks (episodic recall, experiment
     * history, identity) pre-loaded by the caller. Keeps buildPrompt
     * synchronous.
     */
    extraBlocks?: string[];
}

interface RateLimitState {
    /** Map of agentId → ISO timestamps of proposals filed in the last 24h. */
    proposalsByAgent: Record<string, string[]>;
}

// ── Rate Limiting ────────────────────────────────────────────────

function loadRateState(): RateLimitState {
    if (!existsSync(RATE_STATE_PATH)) return { proposalsByAgent: {} };
    try {
        const raw = readFileSync(RATE_STATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<RateLimitState>;
        // v4.9.0-local.6: defensive normalize. A prior bug (+ the goal-
        // reset script) can write `{}` to this file, losing the
        // `proposalsByAgent` key. Without this, every
        // `state.proposalsByAgent[agentId]` access crashes with
        // "Cannot read properties of undefined (reading '<agent>')"
        // and proposals silently fail for hours.
        return {
            proposalsByAgent: parsed?.proposalsByAgent ?? {},
        };
    } catch {
        return { proposalsByAgent: {} };
    }
}

function saveRateState(state: RateLimitState): void {
    try {
        ensureDir(TITAN_HOME);
        writeFileSync(RATE_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `Failed to save rate state: ${(err as Error).message}`);
    }
}

/** Returns how many slots the agent has remaining in the current 24h window. */
export function remainingSlots(agentId: string, limitPerDay: number): number {
    const state = loadRateState();
    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;
    const stamps = (state.proposalsByAgent[agentId] || []).filter(t => now - new Date(t).getTime() < dayMs);
    return Math.max(0, limitPerDay - stamps.length);
}

function recordProposal(agentId: string): void {
    const state = loadRateState();
    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;
    const existing = (state.proposalsByAgent[agentId] || []).filter(t => now - new Date(t).getTime() < dayMs);
    existing.push(new Date().toISOString());
    state.proposalsByAgent[agentId] = existing;
    saveRateState(state);
}

// ── Prompt ───────────────────────────────────────────────────────

function buildPrompt(agentId: string, slotsLeft: number, ctx: GoalProposerContext): string {
    const sections: string[] = [];
    sections.push(`You are agent "${agentId}". You have been given a quiet window to reflect on the system's current state and propose new goals that would meaningfully help.`);
    sections.push(`You may propose 0 to ${slotsLeft} goals. It is OK — often preferable — to propose zero if nothing is clearly worth doing.`);
    sections.push('');

    if (ctx.activeGoals && ctx.activeGoals.length) {
        sections.push('## Currently Active Goals (do not duplicate)');
        for (const title of ctx.activeGoals.slice(0, 20)) sections.push(`- ${title}`);
        sections.push('');
    }
    if (ctx.recentActivity && ctx.recentActivity.length) {
        sections.push('## Recent Activity (last ~50 events)');
        for (const line of ctx.recentActivity.slice(-50)) sections.push(`- ${line}`);
        sections.push('');
    }
    if (ctx.failedSubtasks && ctx.failedSubtasks.length) {
        sections.push('## Recently Failed Subtasks');
        for (const title of ctx.failedSubtasks.slice(0, 20)) sections.push(`- ${title}`);
        sections.push('');
    }
    if (ctx.consolidationNotes) {
        sections.push('## Memory Consolidation Notes');
        sections.push(ctx.consolidationNotes);
        sections.push('');
    }

    // v4.9.0-local.4: extra memory blocks (episodic, experiments,
    // identity) pre-loaded by the async caller and passed through ctx.
    // Keeps buildPrompt synchronous while still giving the proposer
    // full context of what TITAN has already done + who it is.
    if (ctx.extraBlocks && ctx.extraBlocks.length > 0) {
        for (const block of ctx.extraBlocks) {
            if (block && block.trim()) {
                sections.push(block);
                sections.push('');
            }
        }
    }

    sections.push('## Output Format');
    sections.push('Return ONLY a JSON array (no prose, no markdown fences). Each element:');
    sections.push('```');
    sections.push('{');
    sections.push('  "title": "short imperative, under 80 chars",');
    sections.push('  "description": "what success looks like, 1-3 sentences",');
    sections.push('  "rationale": "why this goal is worth doing NOW",');
    sections.push('  "priority": 1-5 (1 = highest),');
    sections.push('  "tags": ["optional", "labels"],');
    sections.push('  "subtasks": [{"title": "...", "description": "..."}]');
    sections.push('}');
    sections.push('```');
    sections.push('If nothing is worth proposing, return `[]`. Never return more than the slot limit.');

    return sections.join('\n');
}

/** JSON schema passed to Ollama's native structured-outputs `format` field.
 *  Constrains the model to emit an array of proposal objects matching the
 *  fields normalizeProposal() accepts. Belt-and-suspenders — the downstream
 *  defensive parser is still the authoritative validator. */
const PROPOSAL_ARRAY_SCHEMA: Record<string, unknown> = {
    type: 'array',
    items: {
        type: 'object',
        required: ['title', 'description', 'rationale'],
        properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            rationale: { type: 'string' },
            priority: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            subtasks: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['title', 'description'],
                    properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                        dependsOn: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        },
    },
};

// ── JSON Extraction ──────────────────────────────────────────────

/** Defensively parse a JSON array from LLM output. Returns [] on failure. */
function extractProposalArray(raw: string): unknown[] {
    const trimmed = raw.trim();
    // Try direct parse first.
    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
    // Strip code fences.
    const fenceStripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
        const parsed = JSON.parse(fenceStripped);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
    // Find the first `[...]` substring.
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
        try {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed)) return parsed;
        } catch { /* give up */ }
    }
    return [];
}

function normalizeProposal(raw: unknown): ProposedGoal | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    const rationale = typeof r.rationale === 'string' ? r.rationale.trim() : '';
    if (!title || !description || !rationale) return null;
    if (title.length > 200 || description.length > 2000 || rationale.length > 2000) return null;

    const priority = typeof r.priority === 'number' && r.priority >= 1 && r.priority <= 5
        ? Math.floor(r.priority)
        : undefined;
    const tags = Array.isArray(r.tags)
        ? r.tags.filter((t): t is string => typeof t === 'string' && t.length < 40).slice(0, 6)
        : undefined;
    const parentGoalId = typeof r.parentGoalId === 'string' ? r.parentGoalId : undefined;

    type Subtask = { title: string; description: string; dependsOn?: string[] };
    let subtasks: Subtask[] | undefined;
    if (Array.isArray(r.subtasks)) {
        const collected: Subtask[] = [];
        for (const s of r.subtasks) {
            if (!s || typeof s !== 'object') continue;
            const rec = s as Record<string, unknown>;
            const t = typeof rec.title === 'string' ? rec.title.trim() : '';
            const d = typeof rec.description === 'string' ? rec.description.trim() : '';
            if (!t || !d) continue;
            const deps = Array.isArray(rec.dependsOn)
                ? rec.dependsOn.filter((x): x is string => typeof x === 'string')
                : undefined;
            collected.push({ title: t, description: d, dependsOn: deps });
            if (collected.length >= 12) break;
        }
        if (collected.length > 0) subtasks = collected;
    }

    return { title, description, rationale, priority, tags, parentGoalId, subtasks };
}

// ── Main Entry Point ─────────────────────────────────────────────

/**
 * Generate goal proposals for a single agent and file them as pending approvals.
 * Returns the list of CPApproval records created (may be empty).
 *
 * Called by the dreaming watcher's Phase 4 (Dream). Safe to call ad-hoc from
 * debug endpoints or tests.
 */
export async function generateGoalProposals(
    agentId: string,
    ctx: GoalProposerContext,
): Promise<CPApproval[]> {
    const config = loadConfig();
    const enabled = config.agent.autoProposeGoals;
    if (!enabled) {
        logger.debug(COMPONENT, `autoProposeGoals disabled — skipping for agent ${agentId}`);
        return [];
    }

    const limit = config.agent.proposalRateLimitPerDay;
    const slotsLeft = remainingSlots(agentId, limit);
    if (slotsLeft <= 0) {
        logger.info(COMPONENT, `Agent ${agentId} has hit daily proposal limit (${limit}) — skipping`);
        return [];
    }

    const modelAlias = config.agent.proposalModel || 'fast';
    const model = config.agent.modelAliases[modelAlias] || modelAlias;

    // v4.9.0-local.4: pre-load extra memory blocks (episodic, experiments,
    // identity) before building the proposer prompt. Closes the repeat-
    // task feedback loop — the proposer now sees what TITAN has recently
    // done and won't re-propose the same ant colony sim three times.
    // Each block is best-effort; silent fallthrough if a module isn't
    // available at proposer time.
    const extraBlocks: string[] = [];
    try {
        const { renderRecallBlock } = await import('../memory/episodic.js');
        const block = renderRecallBlock({ limit: 12, windowHours: 72 });
        if (block) extraBlocks.push(block);
    } catch { /* ok */ }
    try {
        const { renderRecentExperimentsBlock } = await import('../memory/experiments.js');
        const block = renderRecentExperimentsBlock(8);
        if (block) extraBlocks.push(block);
    } catch { /* ok */ }
    try {
        const { getIdentity } = await import('../memory/identity.js');
        const id = getIdentity();
        if (id) {
            extraBlocks.push([
                '## Your identity (persistent)',
                `Mission: ${id.core.mission}`,
                `Non-negotiables: ${id.core.nonNegotiables.slice(0, 3).join('; ')}`,
                'Propose ONLY goals that align with the mission and never violate a non-negotiable.',
            ].join('\n'));
        }
    } catch { /* ok */ }

    const ctxWithBlocks: GoalProposerContext = { ...ctx, extraBlocks };
    const prompt = buildPrompt(agentId, slotsLeft, ctxWithBlocks);

    // Only Ollama honours the `format` JSON-schema constraint today.
    // Other providers would either ignore it or error, so we gate on provider.
    const isOllama = model.toLowerCase().startsWith('ollama/');

    let rawContent: string;
    try {
        const response = await chat({
            model,
            messages: [
                { role: 'system', content: 'You are a careful autonomous agent proposing new work. Output ONLY valid JSON. No explanation, no prose.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.4,
            maxTokens: 1500,
            ...(isOllama ? { format: PROPOSAL_ARRAY_SCHEMA } : {}),
        });
        rawContent = response.content || '';
    } catch (err) {
        logger.warn(COMPONENT, `LLM call failed for agent ${agentId}: ${(err as Error).message}`);
        return [];
    }

    // Strip chain-of-thought leakage before parsing JSON.
    const guarded = applyOutputGuardrails(rawContent, { type: 'sub_agent' });
    const parsed = extractProposalArray(guarded.content);
    if (parsed.length === 0) {
        logger.info(COMPONENT, `Agent ${agentId} proposed no goals (parsed empty array)`);
        return [];
    }

    const proposals: ProposedGoal[] = [];
    for (const item of parsed) {
        const normalized = normalizeProposal(item);
        if (normalized) proposals.push(normalized);
        if (proposals.length >= slotsLeft) break;
    }

    // v4.5.6: dedupe against active goals so Soma doesn't spawn
    // "Satiate hunger" × 3 and "Explore novel X" × 4 variations.
    // If an active goal with a title within 72% similarity already
    // exists, skip the proposal silently — the existing goal will
    // satisfy the drive once its subtasks complete.
    let existingActiveTitles: string[] = [];
    try {
        const { listGoals } = await import('./goals.js');
        existingActiveTitles = listGoals()
            .filter(g => g.status === 'active' || g.status === 'paused')
            .map(g => g.title);
    } catch { /* best-effort */ }

    const approvals: CPApproval[] = [];
    for (const proposal of proposals) {
        const dup = existingActiveTitles.find(t => titleSimilarity(t, proposal.title) >= 0.72);
        if (dup) {
            logger.info(COMPONENT, `Agent ${agentId} skipped duplicate proposal "${proposal.title}" (matches active goal "${dup}")`);
            continue;
        }
        try {
            const approval = requestGoalProposalApproval(agentId, proposal);
            approvals.push(approval);
            recordProposal(agentId);
            existingActiveTitles.push(proposal.title); // prevent intra-batch dupes too
            logger.info(COMPONENT, `Agent ${agentId} filed proposal "${proposal.title}" (approval ${approval.id})`);
        } catch (err) {
            logger.warn(COMPONENT, `Failed to file proposal "${proposal.title}": ${(err as Error).message}`);
        }
    }

    return approvals;
}

/**
 * v4.5.6: simple title similarity for dedupe. Normalizes case, strips
 * filler words, compares token overlap (Jaccard). 0.72 threshold catches
 * "Satiate Hunger" vs "Satiate hunger" vs "Satiate hunger backlog"
 * but not "Satiate Purpose" vs "Satiate hunger" — which is what we want.
 */
function titleSimilarity(a: string, b: string): number {
    const tokenize = (s: string) => new Set(
        s.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    );
    const ta = tokenize(a);
    const tb = tokenize(b);
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const t of ta) if (tb.has(t)) intersection++;
    const union = ta.size + tb.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'new', 'novel', 'build', 'using', 'from',
    'into', 'over', 'onto', 'that', 'this', 'some', 'any',
]);

// ── Context Helpers ──────────────────────────────────────────────

/**
 * Build the default context for a goal proposer run from current TITAN state.
 * Extracted so tests can construct contexts deterministically.
 */
export function buildDefaultContext(): GoalProposerContext {
    const activeGoals = listGoals('active').map(g => g.title);
    const failedSubtasks: string[] = [];
    for (const g of listGoals()) {
        for (const st of g.subtasks || []) {
            if (st.status === 'failed') failedSubtasks.push(`${g.title} → ${st.title}`);
        }
    }
    const recentActivity: string[] = [];
    try {
        const feed = getActivity({ limit: 50 });
        for (const entry of feed) {
            recentActivity.push(`[${entry.type}] ${entry.message}`);
        }
    } catch { /* feed may be unavailable in early boot */ }

    return {
        activeGoals,
        failedSubtasks: failedSubtasks.slice(0, 20),
        recentActivity,
    };
}
