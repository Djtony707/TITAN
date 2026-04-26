/**
 * TITAN — Feature Usage Tracker
 * Fire one-off analytics events for product insights.
 * All events are anonymized, opt-in gated, and best-effort.
 */
import { getOrCreateNodeId } from '../mesh/identity.js';
import { TITAN_VERSION } from '../utils/constants.js';
import { sendRemoteAnalytics } from './collector.js';

const COMPONENT = 'FeatureTracker';

/** Fire a custom analytics event if telemetry is enabled. */
export async function trackEvent(
    eventName: string,
    properties: Record<string, unknown> = {}
): Promise<void> {
    try {
        await sendRemoteAnalytics({
            type: eventName,
            installId: getOrCreateNodeId(),
            version: TITAN_VERSION,
            timestamp: new Date().toISOString(),
            ...properties,
        });
    } catch {
        // Best-effort — never block user flow for analytics
    }
}

/** Track which model was used for a completion. */
export function trackModelUsage(model: string, provider?: string, success = true, latencyMs?: number): void {
    trackEvent('model_usage', {
        model,
        provider: provider || model.split('/')[0] || 'unknown',
        success,
        latency_ms: latencyMs,
    }).catch(() => {});
}

// ── Per-session tool accumulator (cuts event volume 10-100x) ────────────────
interface ToolStats {
    count: number;
    totalLatencyMs: number;
    errorCount: number;
}

const sessionToolAccumulators = new Map<string, Map<string, ToolStats>>();

/** Accumulate a tool call for later per-session batch emit. */
export function trackToolCall(tool: string, success: boolean, latencyMs?: number, errorType?: string, sessionId?: string): void {
    const sid = sessionId || '__global__';
    let acc = sessionToolAccumulators.get(sid);
    if (!acc) {
        acc = new Map<string, ToolStats>();
        sessionToolAccumulators.set(sid, acc);
    }
    const existing = acc.get(tool);
    if (existing) {
        existing.count += 1;
        existing.totalLatencyMs += latencyMs ?? 0;
        if (!success) existing.errorCount += 1;
    } else {
        acc.set(tool, {
            count: 1,
            totalLatencyMs: latencyMs ?? 0,
            errorCount: success ? 0 : 1,
        });
    }
}

/** Emit accumulated tool_use_summary for a session and clear the buffer. */
export function endToolSession(sessionId: string): void {
    const acc = sessionToolAccumulators.get(sessionId);
    if (!acc || acc.size === 0) return;

    const tools: Record<string, { count: number; total_latency_ms: number; error_count: number }> = {};
    let totalCalls = 0;
    for (const [tool, stats] of acc) {
        tools[tool] = {
            count: stats.count,
            total_latency_ms: stats.totalLatencyMs,
            error_count: stats.errorCount,
        };
        totalCalls += stats.count;
    }

    trackEvent('tool_use_summary', {
        session_id: sessionId,
        tool_count: acc.size,
        total_calls: totalCalls,
        tools,
    }).catch(() => {});

    sessionToolAccumulators.delete(sessionId);
}

/** Track feature toggle changes. */
export function trackFeatureToggle(feature: string, enabled: boolean): void {
    trackEvent('feature_toggle', {
        feature,
        enabled,
    }).catch(() => {});
}

/** Track session end metrics. Flushes any accumulated tool stats. */
export function trackSessionEnd(sessionId: string, messageCount: number, toolRounds: number, errorCount: number, durationMs?: number): void {
    endToolSession(sessionId);
    trackEvent('session_end', {
        session_id: sessionId,
        message_count: messageCount,
        tool_rounds: toolRounds,
        error_count: errorCount,
        duration_ms: durationMs,
    }).catch(() => {});
}

/** Track provider configuration changes (no keys, just counts). */
export function trackProviderChange(provider: string, action: 'added' | 'removed' | 'rotated'): void {
    trackEvent('provider_change', {
        provider,
        action,
    }).catch(() => {});
}

/** Track channel adapter enable/disable. */
export function trackChannelChange(channel: string, enabled: boolean): void {
    trackEvent('channel_change', {
        channel,
        enabled,
    }).catch(() => {});
}

/** Track update check results. */
export function trackUpdateCheck(currentVersion: string, latestVersion: string, isBehind: boolean): void {
    trackEvent('update_check', {
        current_version: currentVersion,
        latest_version: latestVersion,
        is_behind: isBehind,
    }).catch(() => {});
}

/** Track when a user completes onboarding. */
export function trackOnboardingComplete(steps: number, durationMs?: number): void {
    trackEvent('onboarding_complete', {
        steps,
        duration_ms: durationMs,
    }).catch(() => {});
}

/** Track when Soma fires a proposal. */
export function trackSomaProposal(drive: string, pressure: number, approved: boolean): void {
    trackEvent('soma_proposal', {
        drive,
        pressure,
        approved,
    }).catch(() => {});
}

/** Track self-modification PR lifecycle. */
export function trackSelfModPR(action: 'created' | 'approved' | 'merged' | 'rejected', drive?: string): void {
    trackEvent('self_mod_pr', {
        action,
        drive: drive || 'unknown',
    }).catch(() => {});
}

/** Track a bug report with rich context. */
export function trackBugReport(properties: {
    bug_id: string;
    error_name: string;
    error_message: string;
    origin?: string;
    model?: string;
    channel?: string;
    tools_used?: string[];
    prompt_length?: number;
    turn_number?: number;
    os?: string;
    arch?: string;
    node_major?: number;
    ram_gb?: number;
    gpu_vram_gb?: number;
    stack_preview?: string;
}): void {
    trackEvent('bug_report', properties).catch(() => {});
}
