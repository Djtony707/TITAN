/**
 * TITAN — Shadow Rehearsal (Soma prefrontal cortex)
 *
 * Before a Soma-generated proposal reaches an approval queue, we ask a cheap
 * model to predict: how reversible is this? what will it cost? what could
 * break? This is *pre-commitment intuition*, not a formal simulation — the
 * verdict arrives as structured JSON so the Approvals UI can surface it
 * alongside Accept/Reject.
 *
 * Design: one LLM call via the `fast` alias (or configured shadowModel).
 * Output guardrails strip chain-of-thought. JSON extraction tolerates code
 * fences and surrounding prose. On any failure → conservative default
 * verdict (low reversibility, unknown cost, "shadow unavailable" risk) so
 * a human approver is never given false confidence.
 */
import { chat } from '../providers/router.js';
import { loadConfig } from '../config/config.js';
import { applyOutputGuardrails } from '../agent/outputGuardrails.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Shadow';

// ── Types ────────────────────────────────────────────────────────

export interface ShadowVerdict {
    /** 0 = irreversible (touches external state, sends messages, etc.),
     *  1 = fully reversible (in-memory only, easily undone). */
    reversibilityScore: number;
    /** Predicted cost in USD — LLM tokens + any external API calls it implies. */
    estimatedCostUsd: number;
    /** Non-empty list of things that could plausibly break. Keep ≤ 5. */
    breakRisks: string[];
    /** Systems the action will touch (filesystem, git, an external API, etc.). */
    affectedSystems: string[];
    /** True when the verdict is synthesised fallback rather than model output. */
    fallback: boolean;
}

export interface ProposalForRehearsal {
    title: string;
    description: string;
    rationale: string;
}

// ── Default (conservative fallback) ──────────────────────────────

const CONSERVATIVE_FALLBACK: ShadowVerdict = {
    reversibilityScore: 0.3,
    estimatedCostUsd: 0.5,
    breakRisks: ['shadow rehearsal unavailable — verdict is conservative default'],
    affectedSystems: ['unknown'],
    fallback: true,
};

// ── Prompt ───────────────────────────────────────────────────────

function buildShadowPrompt(proposal: ProposalForRehearsal): string {
    return [
        'A TITAN agent is about to attempt the following action. Predict what will happen.',
        '',
        '## Proposed Action',
        `Title: ${proposal.title}`,
        `Description: ${proposal.description}`,
        `Rationale: ${proposal.rationale}`,
        '',
        '## Your Task',
        'Return ONLY a JSON object with these fields. No prose, no code fences.',
        '{',
        '  "reversibilityScore": <number 0.0 to 1.0 — 1.0 means fully undoable, 0.0 means irreversible>,',
        '  "estimatedCostUsd": <number — expected dollar cost including LLM tokens and any external APIs>,',
        '  "breakRisks": [<1-5 short strings describing specific things that could break>],',
        '  "affectedSystems": [<strings naming systems touched: "filesystem", "git", "external-api", "command-post", etc.>]',
        '}',
    ].join('\n');
}

// ── JSON extraction ──────────────────────────────────────────────

function extractJSONObject(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    const candidates: string[] = [trimmed];
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (stripped !== trimmed) candidates.push(stripped);
    const match = trimmed.match(/\{[\s\S]*?\}/);
    if (match) candidates.push(match[0]);
    // If the non-greedy match didn't capture enough (nested braces),
    // try a balanced extraction that finds the outermost JSON object.
    if (!match) {
        let depth = 0;
        let start = -1;
        for (let i = 0; i < trimmed.length; i++) {
            if (trimmed[i] === '{') {
                if (depth === 0) start = i;
                depth++;
            } else if (trimmed[i] === '}') {
                depth--;
                if (depth === 0 && start !== -1) {
                    candidates.push(trimmed.slice(start, i + 1));
                    break;
                }
            }
        }
    }
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch { /* next candidate */ }
    }
    return null;
}

function normalizeVerdict(raw: Record<string, unknown>): ShadowVerdict | null {
    const scoreRaw = Number(raw.reversibilityScore);
    const costRaw = Number(raw.estimatedCostUsd);
    if (!Number.isFinite(scoreRaw) || !Number.isFinite(costRaw)) return null;
    const risks = Array.isArray(raw.breakRisks)
        ? raw.breakRisks.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).slice(0, 5)
        : [];
    const systems = Array.isArray(raw.affectedSystems)
        ? raw.affectedSystems.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 8)
        : [];
    const reversibilityScore = Math.max(0, Math.min(1, scoreRaw));
    const estimatedCostUsd = Math.max(0, costRaw);
    return {
        reversibilityScore,
        estimatedCostUsd,
        breakRisks: risks.length > 0 ? risks : ['no specific risks identified'],
        affectedSystems: systems.length > 0 ? systems : ['unknown'],
        fallback: false,
    };
}

// ── Main entry ───────────────────────────────────────────────────

/**
 * Rehearse a proposal. Always returns a verdict — never throws. On any
 * failure the returned verdict is the conservative fallback with
 * `fallback: true` so callers and the UI can flag it explicitly.
 *
 * @param modelAlias Optional override; defaults to 'fast' alias.
 */
export async function rehearseShadow(
    proposal: ProposalForRehearsal,
    modelAlias = 'fast',
): Promise<ShadowVerdict> {
    if (!proposal.title || !proposal.description) {
        logger.debug(COMPONENT, 'Shadow skipped: proposal missing title or description');
        return CONSERVATIVE_FALLBACK;
    }
    const config = loadConfig();
    const resolvedModel = config.agent.modelAliases[modelAlias] || modelAlias || config.agent.model;

    let raw = '';
    try {
        const response = await chat({
            model: resolvedModel,
            messages: [
                { role: 'system', content: 'You are a careful systems analyst. Output ONLY valid JSON.' },
                { role: 'user', content: buildShadowPrompt(proposal) },
            ],
            temperature: 0.2,
            maxTokens: 400,
        });
        raw = response.content || '';
    } catch (err) {
        logger.warn(COMPONENT, `Shadow LLM call failed: ${(err as Error).message}`);
        return CONSERVATIVE_FALLBACK;
    }

    const guarded = applyOutputGuardrails(raw, { type: 'sub_agent' });
    const parsed = extractJSONObject(guarded.content || raw);
    if (!parsed) {
        logger.debug(COMPONENT, 'Shadow verdict malformed — falling back');
        return CONSERVATIVE_FALLBACK;
    }
    const verdict = normalizeVerdict(parsed);
    if (!verdict) {
        logger.debug(COMPONENT, 'Shadow verdict failed normalization — falling back');
        return CONSERVATIVE_FALLBACK;
    }
    return verdict;
}
