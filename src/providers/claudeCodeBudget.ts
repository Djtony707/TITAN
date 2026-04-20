/**
 * TITAN — Claude Code quota watchdog (v4.10.0-local polish)
 *
 * Claude Code MAX plan has a rolling 5-hour message quota. If TITAN's
 * automation burns through it, Tony's interactive Claude Code sessions
 * get rate-limited. This module watches usage and:
 *
 *   - Tracks cost (CLI's `total_cost_usd`, which is the API-equivalent
 *     dollar amount MAX absorbs) over a rolling window
 *   - At 60% of the configured cap → returns `throttle` verdict so
 *     ClaudeCodeProvider's caller falls back to a non-claude model
 *   - At 100% → hard block (even more important: reject the call)
 *   - When claude CLI returns a rate-limit error, parse the reset time
 *     and stop all further attempts until that time (reactive backstop)
 *
 * Why a heuristic "cost per window" as the proxy: MAX plan doesn't
 * expose quota directly. The CLI reports `total_cost_usd` per call
 * (what it WOULD cost on metered API). Cumulative that number serves
 * as a reasonable "have I been using a lot" signal.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import logger from '../utils/logger.js';
import { loadConfig } from '../config/config.js';
import { TITAN_HOME } from '../utils/constants.js';

const COMPONENT = 'ClaudeCodeBudget';
const STATE_PATH = join(TITAN_HOME, 'claude-code-budget.json');

// ── Config ───────────────────────────────────────────────────────

interface ClaudeCodeQuotaConfig {
    enabled: boolean;
    /** Rolling window in hours. MAX plan cycle is 5h. */
    windowHours: number;
    /** Conservative "API-equivalent" cost that corresponds to roughly
     *  the MAX plan's 5h quota. Tune if you observe too-early throttling
     *  OR too-late (rate-limit hits without throttle). */
    maxUsdPerWindow: number;
    /** Throttle (fall-back to non-claude) at this % of cap. */
    throttleAtPercent: number;
    /** Hard-block (refuse the call) at this % of cap. */
    hardBlockAtPercent: number;
}

function resolveConfig(): ClaudeCodeQuotaConfig {
    const cfg = loadConfig();
    const cc = (cfg.autonomy as unknown as { claudeCode?: Partial<ClaudeCodeQuotaConfig> }).claudeCode ?? {};
    return {
        enabled: cc.enabled ?? true,
        windowHours: cc.windowHours ?? 5,
        // Default $50/window is a conservative estimate for MAX Pro
        // ($100/mo tier). MAX Ultra ($200/mo) users can raise this via
        // autonomy.claudeCode.maxUsdPerWindow.
        maxUsdPerWindow: cc.maxUsdPerWindow ?? 50.0,
        throttleAtPercent: cc.throttleAtPercent ?? 60,
        hardBlockAtPercent: cc.hardBlockAtPercent ?? 100,
    };
}

// ── State on disk ────────────────────────────────────────────────

interface CallRecord {
    at: string;              // ISO
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    model?: string;
}

export interface ClaudeCodeBudgetState {
    schemaVersion: 1;
    /** Sliding window of recent calls. Pruned older-than-windowHours on each check. */
    calls: CallRecord[];
    /** If set, the next reset time from a rate-limit error. We refuse all calls until then. */
    throttledUntil?: string;
    throttledReason?: string;
    /** Cumulative all-time totals (not used for gating, just telemetry). */
    lifetime: {
        totalCalls: number;
        totalCostUsd: number;
        totalInputTokens: number;
        totalOutputTokens: number;
    };
    updatedAt: string;
}

function freshState(): ClaudeCodeBudgetState {
    return {
        schemaVersion: 1,
        calls: [],
        lifetime: { totalCalls: 0, totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0 },
        updatedAt: new Date().toISOString(),
    };
}

function load(): ClaudeCodeBudgetState {
    if (!existsSync(STATE_PATH)) return freshState();
    try {
        const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as ClaudeCodeBudgetState;
        if (parsed.schemaVersion !== 1) return freshState();
        return parsed;
    } catch (err) {
        logger.warn(COMPONENT, `budget file parse failed: ${(err as Error).message}`);
        return freshState();
    }
}

function save(s: ClaudeCodeBudgetState): void {
    try {
        mkdirSync(dirname(STATE_PATH), { recursive: true });
        s.updatedAt = new Date().toISOString();
        writeFileSync(STATE_PATH + '.tmp', JSON.stringify(s, null, 2));
        renameSync(STATE_PATH + '.tmp', STATE_PATH);
    } catch (err) {
        logger.warn(COMPONENT, `budget save failed: ${(err as Error).message}`);
    }
}

// ── Window math ──────────────────────────────────────────────────

function prune(s: ClaudeCodeBudgetState, windowHours: number): ClaudeCodeBudgetState {
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
    s.calls = s.calls.filter(c => new Date(c.at).getTime() >= cutoff);
    return s;
}

function windowTotals(s: ClaudeCodeBudgetState): { costUsd: number; inputTokens: number; outputTokens: number; callCount: number } {
    return {
        costUsd: s.calls.reduce((acc, c) => acc + c.costUsd, 0),
        inputTokens: s.calls.reduce((acc, c) => acc + c.inputTokens, 0),
        outputTokens: s.calls.reduce((acc, c) => acc + c.outputTokens, 0),
        callCount: s.calls.length,
    };
}

// ── Public API ───────────────────────────────────────────────────

export type BudgetVerdict = 'ok' | 'throttle' | 'block';

export interface BudgetCheck {
    verdict: BudgetVerdict;
    percentUsed: number;
    costUsdInWindow: number;
    capUsd: number;
    callsInWindow: number;
    windowHours: number;
    /** For 'block' via rate-limit backoff, the time we can retry. */
    retryAfter?: string;
    reason?: string;
}

/**
 * Check whether we may make a claude-code call now.
 * Called by ClaudeCodeProvider.chat() before spawning.
 */
export function checkBudget(): BudgetCheck {
    const cfg = resolveConfig();
    const state = prune(load(), cfg.windowHours);
    const totals = windowTotals(state);
    const percentUsed = cfg.maxUsdPerWindow > 0
        ? (totals.costUsd / cfg.maxUsdPerWindow) * 100
        : 0;

    // Hard rate-limit backoff takes precedence
    if (state.throttledUntil) {
        const until = new Date(state.throttledUntil).getTime();
        if (Date.now() < until) {
            return {
                verdict: 'block',
                percentUsed,
                costUsdInWindow: totals.costUsd,
                capUsd: cfg.maxUsdPerWindow,
                callsInWindow: totals.callCount,
                windowHours: cfg.windowHours,
                retryAfter: state.throttledUntil,
                reason: state.throttledReason || 'claude CLI returned rate-limit — waiting for reset',
            };
        }
        // Window expired — clear the backoff
        delete state.throttledUntil;
        delete state.throttledReason;
        save(state);
    }

    if (!cfg.enabled) {
        return {
            verdict: 'ok',
            percentUsed, costUsdInWindow: totals.costUsd,
            capUsd: cfg.maxUsdPerWindow, callsInWindow: totals.callCount,
            windowHours: cfg.windowHours,
        };
    }

    if (percentUsed >= cfg.hardBlockAtPercent) {
        return {
            verdict: 'block',
            percentUsed, costUsdInWindow: totals.costUsd,
            capUsd: cfg.maxUsdPerWindow, callsInWindow: totals.callCount,
            windowHours: cfg.windowHours,
            reason: `Claude Code window budget hard-blocked at ${percentUsed.toFixed(0)}% of $${cfg.maxUsdPerWindow}/${cfg.windowHours}h`,
        };
    }
    if (percentUsed >= cfg.throttleAtPercent) {
        return {
            verdict: 'throttle',
            percentUsed, costUsdInWindow: totals.costUsd,
            capUsd: cfg.maxUsdPerWindow, callsInWindow: totals.callCount,
            windowHours: cfg.windowHours,
            reason: `Claude Code window budget at ${percentUsed.toFixed(0)}% — preferring fallback model to preserve interactive quota`,
        };
    }
    return {
        verdict: 'ok',
        percentUsed, costUsdInWindow: totals.costUsd,
        capUsd: cfg.maxUsdPerWindow, callsInWindow: totals.callCount,
        windowHours: cfg.windowHours,
    };
}

/** Record a successful claude-code call's cost + tokens. */
export function recordSpend(opts: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    model?: string;
}): void {
    const cfg = resolveConfig();
    const state = prune(load(), cfg.windowHours);
    state.calls.push({
        at: new Date().toISOString(),
        costUsd: opts.costUsd,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        model: opts.model,
    });
    state.lifetime.totalCalls += 1;
    state.lifetime.totalCostUsd += opts.costUsd;
    state.lifetime.totalInputTokens += opts.inputTokens;
    state.lifetime.totalOutputTokens += opts.outputTokens;
    save(state);
}

/**
 * Record that claude CLI returned a rate-limit error. We'll block all
 * further calls until the reset time.
 *
 * If `resetAt` is omitted, default to a conservative 1h from now — better
 * to over-wait than to spam-retry.
 */
export function recordRateLimitHit(resetAt?: string | Date, reason?: string): void {
    const state = load();
    const until = resetAt
        ? (resetAt instanceof Date ? resetAt : new Date(resetAt))
        : new Date(Date.now() + 60 * 60 * 1000); // +1h default
    state.throttledUntil = until.toISOString();
    state.throttledReason = reason || 'claude CLI rate-limited';
    save(state);
    logger.warn(COMPONENT, `Rate-limit backoff armed until ${state.throttledUntil} — ${state.throttledReason}`);
}

/** Parse a claude CLI error message for reset time info. Pragmatic: look
 *  for ISO timestamps or "retry after Xs/Xm/Xh" patterns. Returns a Date
 *  if one is found, else undefined. */
export function parseRateLimitResetTime(errorText: string): Date | undefined {
    if (!errorText) return undefined;
    // Pattern: "try again at 2026-04-19T17:00:00Z"
    const isoMatch = errorText.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\b/);
    if (isoMatch) {
        const d = new Date(isoMatch[1]);
        if (!isNaN(d.getTime())) return d;
    }
    // Pattern: "retry after 1h 30m"
    const hMatch = errorText.match(/retry\s+(?:in|after)\s+(\d+)\s*h(?:ours?)?/i);
    if (hMatch) return new Date(Date.now() + Number(hMatch[1]) * 3600 * 1000);
    // Pattern: "retry after 30m" / "30 minutes"
    const mMatch = errorText.match(/retry\s+(?:in|after)\s+(\d+)\s*m(?:in(?:utes?)?)?/i);
    if (mMatch) return new Date(Date.now() + Number(mMatch[1]) * 60 * 1000);
    // Pattern: "retry after 120s"
    const sMatch = errorText.match(/retry\s+(?:in|after)\s+(\d+)\s*s(?:ec(?:onds?)?)?/i);
    if (sMatch) return new Date(Date.now() + Number(sMatch[1]) * 1000);
    return undefined;
}

/** Check if a claude CLI result/error string indicates rate limiting. */
export function looksLikeRateLimit(text: string): boolean {
    if (!text) return false;
    return /\b(rate[- ]?limit|usage[- ]?limit|quota[- ]?exceeded|too many requests|429|5[- ]hour|message limit|please wait|try again (?:later|after|in))\b/i.test(text);
}

// ── Snapshot for UI / API ────────────────────────────────────────

export function getSnapshot(): {
    config: ClaudeCodeQuotaConfig;
    current: BudgetCheck;
    lifetime: ClaudeCodeBudgetState['lifetime'];
    recentCalls: CallRecord[];
} {
    const cfg = resolveConfig();
    const state = prune(load(), cfg.windowHours);
    return {
        config: cfg,
        current: checkBudget(),
        lifetime: state.lifetime,
        recentCalls: state.calls.slice(-10),
    };
}

/** Test-only / manual override: clear rate-limit backoff. */
export function clearRateLimit(): void {
    const state = load();
    delete state.throttledUntil;
    delete state.throttledReason;
    save(state);
    logger.info(COMPONENT, 'Rate-limit backoff manually cleared');
}

/** Test-only: reset all state. */
export function _resetForTests(): void {
    try {
        const fs = require('fs') as typeof import('fs');
        if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
    } catch { /* ok */ }
}
