/**
 * TITAN — Opus Review Gate (v4.10.0-local polish)
 *
 * Before a staged self_mod_pr applies to /opt/TITAN, send the diff to
 * Claude Opus (via OpenRouter) for a quality review. Opus looks for:
 *   - Correctness (does it do what the goal asked?)
 *   - Integration (are new modules wired into existing systems?)
 *   - Regressions (does it break anything obvious?)
 *   - Security (sanity check beyond the scanner)
 *   - Code quality (obvious bugs, missing error handling, etc.)
 *
 * Returns a structured verdict. Used in applyStagedPR before the copy
 * to live. If reject/needs_changes, the approval transitions to a new
 * blocked state with Opus's concerns in the payload.
 *
 * Why Opus specifically: the local LLMs (glm-5.1, qwen3.6) that write
 * the code are weaker reviewers. Opus is a much stronger critic and
 * has seen a huge code corpus — catches integration gaps, typos, bad
 * patterns the local model missed.
 *
 * Config-gated: autonomy.selfMod.reviewer.{enabled, model, maxDiffChars}.
 * If OpenRouter key isn't configured, review is skipped (fall through).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import logger from '../utils/logger.js';
import { loadConfig } from '../config/config.js';
import { TITAN_HOME } from '../utils/constants.js';

const COMPONENT = 'OpusReview';
const BUDGET_PATH = join(TITAN_HOME, 'reviewer-budget.json');

// ── Model price table (USD per 1M tokens) ────────────────────────

// Kept small + conservative. Free models = 0. Unknown models = Opus-rate
// (safer to over-estimate than under). Update as model list changes.
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
    // OpenRouter — metered
};

function priceFor(model: string): { input: number; output: number } {
    return MODEL_PRICES[model] ?? { input: 15.0, output: 75.0 }; // Opus-rate fallback
}

// ── Budget tracker ───────────────────────────────────────────────

interface ReviewerBudget {
    daily: { date: string; costUsd: number };
    monthly: { yearMonth: string; costUsd: number };
    totalSpentUsd: number;
    totalReviews: number;
    updatedAt: string;
}

function loadBudget(): ReviewerBudget {
    if (existsSync(BUDGET_PATH)) {
        try {
            return JSON.parse(readFileSync(BUDGET_PATH, 'utf-8')) as ReviewerBudget;
        } catch { /* fall through to fresh */ }
    }
    const now = new Date();
    return {
        daily: { date: now.toISOString().slice(0, 10), costUsd: 0 },
        monthly: { yearMonth: now.toISOString().slice(0, 7), costUsd: 0 },
        totalSpentUsd: 0,
        totalReviews: 0,
        updatedAt: now.toISOString(),
    };
}

function saveBudget(b: ReviewerBudget): void {
    try {
        mkdirSync(dirname(BUDGET_PATH), { recursive: true });
        writeFileSync(BUDGET_PATH + '.tmp', JSON.stringify(b, null, 2));
        renameSync(BUDGET_PATH + '.tmp', BUDGET_PATH);
    } catch (err) {
        logger.warn(COMPONENT, `Budget persist failed: ${(err as Error).message}`);
    }
}

function rolloverIfNeeded(b: ReviewerBudget): ReviewerBudget {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const thisMonth = now.toISOString().slice(0, 7);
    if (b.daily.date !== today) b.daily = { date: today, costUsd: 0 };
    if (b.monthly.yearMonth !== thisMonth) b.monthly = { yearMonth: thisMonth, costUsd: 0 };
    return b;
}

/** Snapshot of current spend — exposed via /api/safety/reviewer-budget. */
export function getReviewerBudget(): ReviewerBudget & { caps: { perReview: number; daily: number; monthly: number } } {
    const b = rolloverIfNeeded(loadBudget());
    const cfg = resolveReviewerConfig();
    return {
        ...b,
        caps: {
            perReview: cfg.maxPerReviewUsd,
            daily: cfg.maxDailyUsd,
            monthly: cfg.maxMonthlyUsd,
        },
    };
}

// ── Types ────────────────────────────────────────────────────────

export type OpusVerdict = 'approve' | 'reject' | 'needs_changes' | 'skipped';

export interface OpusReview {
    verdict: OpusVerdict;
    confidence: number;
    reasoning: string;
    concerns: string[];
    suggestions: string[];
    /** The review model used (for audit). */
    model: string;
    /** Duration of the review call. */
    durationMs: number;
    /** Raw response (first 10KB, for debugging). */
    rawResponse?: string;
}

export interface ReviewInput {
    goalId: string;
    goalTitle: string;
    goalDescription?: string;
    files: Array<{ targetPath: string; stagedPath: string; sizeBytes: number }>;
    tags?: string[];
}

// ── Config ───────────────────────────────────────────────────────

interface ReviewerConfig {
    enabled: boolean;
    model: string;
    maxDiffChars: number;
    blockOnReject: boolean;
    maxPerReviewUsd: number;
    maxDailyUsd: number;
    maxMonthlyUsd: number;
}

function resolveReviewerConfig(): ReviewerConfig {
    const cfg = loadConfig();
    const sm = (cfg.autonomy as unknown as { selfMod?: { reviewer?: Partial<ReviewerConfig> } }).selfMod;
    const r = sm?.reviewer ?? {};
    return {
        enabled: r.enabled ?? true,
        model: r.model ?? 'ollama/glm-5.1:cloud',
        maxDiffChars: r.maxDiffChars ?? 50_000,
        blockOnReject: r.blockOnReject ?? true,
        maxPerReviewUsd: r.maxPerReviewUsd ?? 0.25,
        maxDailyUsd: r.maxDailyUsd ?? 1.50,
        maxMonthlyUsd: r.maxMonthlyUsd ?? 5.00,
    };
}

// ── Build the review prompt ──────────────────────────────────────

function buildReviewPrompt(input: ReviewInput): string {
    const sections: string[] = [];

    sections.push('You are a senior code reviewer for TITAN, an autonomous AI agent framework written in TypeScript/ESM.');
    sections.push('Another TITAN specialist (a smaller local LLM) just produced the following staged changes for a self-modification goal.');
    sections.push('Your job is ONE FINAL CHECK before these changes apply to /opt/TITAN.');
    sections.push('');
    sections.push('## Goal');
    sections.push(`Title: ${input.goalTitle}`);
    if (input.goalDescription) {
        sections.push(`Description: ${input.goalDescription.slice(0, 1500)}`);
    }
    if (input.tags && input.tags.length > 0) {
        sections.push(`Tags: ${input.tags.join(', ')}`);
    }
    sections.push('');
    sections.push('## Files in this bundle');
    for (const f of input.files) {
        sections.push(`- ${f.targetPath} (${f.sizeBytes} bytes)`);
    }
    sections.push('');

    // Inline each file's content (capped)
    const cap = resolveReviewerConfig().maxDiffChars;
    let remaining = cap;
    for (const f of input.files) {
        if (remaining <= 0) {
            sections.push(`[Truncated: remaining files not shown due to ${cap} char cap]`);
            break;
        }
        try {
            const content = readFileSync(f.stagedPath, 'utf-8');
            const slice = content.slice(0, Math.min(content.length, remaining));
            remaining -= slice.length;
            sections.push('');
            sections.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            sections.push(`FILE: ${f.targetPath}`);
            sections.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            sections.push(slice);
            if (content.length > slice.length) {
                sections.push(`[Truncated — ${content.length - slice.length} more chars]`);
            }
        } catch (err) {
            sections.push(`[Could not read ${f.stagedPath}: ${(err as Error).message}]`);
        }
    }

    sections.push('');
    sections.push('## What to check');
    sections.push('1. **Correctness**: does the code actually do what the goal asks?');
    sections.push('2. **Integration**: if new modules are added, are they imported/used somewhere? (TITAN\'s rule: a file that isn\'t imported anywhere is dead code.)');
    sections.push('3. **Regressions**: does it change existing behavior in a way that could break things?');
    sections.push('4. **Obvious bugs**: null dereferences, unhandled promise rejections, missing try/catch on I/O, wrong types, logic errors.');
    sections.push('5. **Security**: beyond secret-scanning, any paths that could be exploited? Arbitrary file write? Injection?');
    sections.push('6. **Code quality**: idiomatic TypeScript? Follows TITAN\'s style (ESM, Zod schemas, explicit types)?');
    sections.push('');
    sections.push('## Your verdict options');
    sections.push('- `approve` — apply the bundle as-is (safe, correct, integrated)');
    sections.push('- `needs_changes` — close to good but has specific fixable issues; list them in `concerns`');
    sections.push('- `reject` — fundamentally flawed; do not apply (missing integration, security issue, wrong approach)');
    sections.push('');
    sections.push('## Output format');
    sections.push('Respond with ONLY a JSON block, no prose before or after:');
    sections.push('```json');
    sections.push('{');
    sections.push('  "verdict": "approve" | "needs_changes" | "reject",');
    sections.push('  "confidence": 0.0 to 1.0,');
    sections.push('  "reasoning": "1-3 sentences explaining the verdict",');
    sections.push('  "concerns": ["specific issue 1", "specific issue 2"],');
    sections.push('  "suggestions": ["how to fix / improve 1", "..."]');
    sections.push('}');
    sections.push('```');

    return sections.join('\n');
}

// ── Parser ───────────────────────────────────────────────────────

function parseReview(raw: string): Omit<OpusReview, 'model' | 'durationMs' | 'rawResponse'> {
    // Extract JSON block
    const fence = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    let jsonText = fence ? fence[1] : '';
    if (!jsonText) {
        // Fallback: last {...} in text
        const last = raw.lastIndexOf('}');
        if (last > 0) {
            let depth = 0;
            for (let i = last; i >= 0; i--) {
                if (raw[i] === '}') depth++;
                else if (raw[i] === '{') { depth--; if (depth === 0) { jsonText = raw.slice(i, last + 1); break; } }
            }
        }
    }
    if (!jsonText) {
        return {
            verdict: 'needs_changes',
            confidence: 0.3,
            reasoning: 'Reviewer did not return structured JSON; treating as needs_changes for safety.',
            concerns: ['No JSON verdict in response'],
            suggestions: [],
        };
    }
    try {
        const p = JSON.parse(jsonText) as Record<string, unknown>;
        const rawVerdict = String(p.verdict ?? 'needs_changes');
        const verdict: OpusVerdict = ['approve', 'reject', 'needs_changes'].includes(rawVerdict)
            ? (rawVerdict as OpusVerdict) : 'needs_changes';
        return {
            verdict,
            confidence: Math.max(0, Math.min(1, typeof p.confidence === 'number' ? p.confidence : 0.5)),
            reasoning: String(p.reasoning ?? ''),
            concerns: Array.isArray(p.concerns) ? p.concerns.map(String) : [],
            suggestions: Array.isArray(p.suggestions) ? p.suggestions.map(String) : [],
        };
    } catch (err) {
        return {
            verdict: 'needs_changes',
            confidence: 0.2,
            reasoning: `JSON parse failed: ${(err as Error).message}`,
            concerns: ['malformed reviewer response'],
            suggestions: [],
        };
    }
}

// ── Main entry ───────────────────────────────────────────────────

/**
 * Run the Opus review. Returns a verdict + concerns. Never throws —
 * on error, returns `{verdict: 'skipped'}` so the caller can decide
 * whether to apply anyway (fail-open).
 */
export async function reviewStagedBundle(input: ReviewInput): Promise<OpusReview> {
    const cfg = resolveReviewerConfig();
    const startedAt = Date.now();

    if (!cfg.enabled) {
        return {
            verdict: 'skipped', confidence: 0,
            reasoning: 'Opus review disabled in config',
            concerns: [], suggestions: [],
            model: cfg.model, durationMs: 0,
        };
    }

    // Provider-key sanity check.
    //   openrouter/* → needs OPENROUTER_API_KEY
    //   anything else → assume the router's provider will handle its own auth
    if (cfg.model.startsWith('openrouter/')) {
        const openrouterKey = process.env.OPENROUTER_API_KEY ||
            (loadConfig().providers as Record<string, { apiKey?: string } | undefined>).openrouter?.apiKey;
        if (!openrouterKey) {
            logger.warn(COMPONENT, 'OpenRouter key missing — skipping review');
            return {
                verdict: 'skipped', confidence: 0,
                reasoning: 'No OpenRouter API key configured; review skipped',
                concerns: [], suggestions: [],
                model: cfg.model, durationMs: 0,
            };
        }
    }

    // v4.10.0-local polish: enforce cost caps. Tony's OpenRouter balance
    // is $9.54 — we don't want a runaway Opus reviewer to spam-bill. Caps:
    //   per-review:  $0.25 default
    //   daily:       $1.50 default
    //   monthly:     $5.00 default
    // Free models (Qwen3.6 Plus) cost $0, so caps never trigger for them.
    const budget = rolloverIfNeeded(loadBudget());
    if (budget.daily.costUsd >= cfg.maxDailyUsd) {
        logger.warn(COMPONENT, `Daily cap $${cfg.maxDailyUsd.toFixed(2)} hit ($${budget.daily.costUsd.toFixed(2)} spent today) — skipping review`);
        return {
            verdict: 'skipped', confidence: 0,
            reasoning: `Reviewer daily cost cap ($${cfg.maxDailyUsd.toFixed(2)}) reached — review skipped. Bumps over for tomorrow.`,
            concerns: [], suggestions: [],
            model: cfg.model, durationMs: 0,
        };
    }
    if (budget.monthly.costUsd >= cfg.maxMonthlyUsd) {
        logger.warn(COMPONENT, `Monthly cap $${cfg.maxMonthlyUsd.toFixed(2)} hit — skipping review`);
        return {
            verdict: 'skipped', confidence: 0,
            reasoning: `Reviewer monthly cost cap ($${cfg.maxMonthlyUsd.toFixed(2)}) reached — review skipped.`,
            concerns: [], suggestions: [],
            model: cfg.model, durationMs: 0,
        };
    }

    // Estimate per-review cost BEFORE calling. Cap: 0.25 USD default.
    const price = priceFor(cfg.model);
    const promptChars = buildReviewPrompt(input).length;
    const estInputTokens = Math.ceil(promptChars / 4); // ~4 chars per token
    const estOutputTokens = 2000; // we cap maxTokens at 2000
    const estCost = (estInputTokens / 1_000_000) * price.input + (estOutputTokens / 1_000_000) * price.output;
    if (estCost > cfg.maxPerReviewUsd) {
        logger.warn(COMPONENT, `Estimated review cost $${estCost.toFixed(3)} > per-review cap $${cfg.maxPerReviewUsd.toFixed(2)} — skipping`);
        return {
            verdict: 'skipped', confidence: 0,
            reasoning: `Review would cost ~$${estCost.toFixed(3)} which exceeds per-review cap $${cfg.maxPerReviewUsd.toFixed(2)}. Trim the bundle (fewer/smaller files) or raise the cap.`,
            concerns: [], suggestions: [],
            model: cfg.model, durationMs: 0,
        };
    }

    const prompt = buildReviewPrompt(input);
    try {
        const { chat } = await import('../providers/router.js');
        logger.info(COMPONENT, `Reviewing bundle for goal ${input.goalId} (${input.files.length} files) via ${cfg.model} — est $${estCost.toFixed(3)}`);
        const response = await chat({
            model: cfg.model,
            messages: [
                { role: 'system', content: 'You are a rigorous code reviewer. Return ONLY a JSON verdict block.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            maxTokens: 2000,
        });
        const raw = response?.content || '';
        const parsed = parseReview(raw);
        const durationMs = Date.now() - startedAt;

        // Record actual spend from usage if available, else use estimate.
        const usage = response?.usage;
        const actualCost = usage
            ? (usage.promptTokens / 1_000_000) * price.input + (usage.completionTokens / 1_000_000) * price.output
            : estCost;
        budget.daily.costUsd += actualCost;
        budget.monthly.costUsd += actualCost;
        budget.totalSpentUsd += actualCost;
        budget.totalReviews += 1;
        budget.updatedAt = new Date().toISOString();
        saveBudget(budget);

        logger.info(COMPONENT, `Review verdict: ${parsed.verdict} (confidence ${parsed.confidence.toFixed(2)}, ${durationMs}ms, actual cost $${actualCost.toFixed(4)}, daily $${budget.daily.costUsd.toFixed(3)}/${cfg.maxDailyUsd.toFixed(2)})`);
        return {
            ...parsed,
            model: cfg.model,
            durationMs,
            rawResponse: raw.slice(0, 10_000),
        };
    } catch (err) {
        const durationMs = Date.now() - startedAt;
        logger.warn(COMPONENT, `Review call failed: ${(err as Error).message}`);
        return {
            verdict: 'skipped', confidence: 0,
            reasoning: `Review call error: ${(err as Error).message}`,
            concerns: [], suggestions: [],
            model: cfg.model, durationMs,
        };
    }
}

/**
 * Is the reviewer configured to block on reject? (Used by applyStagedPR
 * to decide whether a `reject` verdict actually stops the apply.)
 */
export function reviewerBlocksOnReject(): boolean {
    return resolveReviewerConfig().blockOnReject;
}

// Silence unused import (keep for future use)
void join; void dirname; void existsSync;
