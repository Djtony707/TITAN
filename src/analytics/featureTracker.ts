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

/** Track a tool call outcome. */
export function trackToolCall(tool: string, success: boolean, latencyMs?: number, errorType?: string): void {
    trackEvent('tool_call', {
        tool,
        success,
        latency_ms: latencyMs,
        error_type: errorType,
    }).catch(() => {});
}

/** Track feature toggle changes. */
export function trackFeatureToggle(feature: string, enabled: boolean): void {
    trackEvent('feature_toggle', {
        feature,
        enabled,
    }).catch(() => {});
}

/** Track session end metrics. */
export function trackSessionEnd(messageCount: number, toolRounds: number, errorCount: number, durationMs?: number): void {
    trackEvent('session_end', {
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
