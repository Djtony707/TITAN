/**
 * TITAN — Operator Alerting System
 *
 * Sends webhook notifications when critical events occur:
 * - Daemon paused (error rate too high)
 * - Circuit breaker opened (provider down)
 * - Ollama health degraded/down
 * - Agent task failed
 * - Eval regression detected
 *
 * Supports: Discord webhooks, Slack webhooks, generic JSON webhooks.
 * Config: alerting.webhookUrl, alerting.minSeverity
 */

import { titanEvents } from './daemon.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { TITAN_VERSION } from '../utils/constants.js';

const COMPONENT = 'Alerts';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
    severity: AlertSeverity;
    title: string;
    message: string;
    source: string;
    timestamp: string;
    data?: Record<string, unknown>;
}

// ── Alert History (in-memory ring buffer) ───────────────────────

const MAX_HISTORY = 200;
const alertHistory: Alert[] = [];

export function getAlertHistory(limit = 50): Alert[] {
    return alertHistory.slice(-limit);
}

// ── Severity Filter ─────────────────────────────────────────────

const SEVERITY_LEVEL: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

function shouldSend(severity: AlertSeverity): boolean {
    const config = loadConfig();
    const alerting = (config as Record<string, unknown>).alerting as { minSeverity?: string } | undefined;
    const minSeverity = (alerting?.minSeverity || 'warning') as AlertSeverity;
    return SEVERITY_LEVEL[severity] >= SEVERITY_LEVEL[minSeverity];
}

// ── Webhook Delivery ────────────────────────────────────────────

function getWebhookUrl(): string | null {
    const config = loadConfig();
    const alerting = (config as Record<string, unknown>).alerting as { webhookUrl?: string } | undefined;
    return alerting?.webhookUrl || null;
}

function isDiscordWebhook(url: string): boolean {
    return url.includes('discord.com/api/webhooks');
}

function isSlackWebhook(url: string): boolean {
    return url.includes('hooks.slack.com');
}

function formatDiscordPayload(alert: Alert): Record<string, unknown> {
    const colorMap: Record<AlertSeverity, number> = {
        info: 0x3498db,     // Blue
        warning: 0xf39c12,  // Orange
        critical: 0xe74c3c, // Red
    };
    return {
        embeds: [{
            title: `${alert.severity === 'critical' ? '🚨' : alert.severity === 'warning' ? '⚠️' : 'ℹ️'} ${alert.title}`,
            description: alert.message,
            color: colorMap[alert.severity],
            footer: { text: `TITAN ${TITAN_VERSION} • ${alert.source}` },
            timestamp: alert.timestamp,
        }],
    };
}

function formatSlackPayload(alert: Alert): Record<string, unknown> {
    const emoji = alert.severity === 'critical' ? ':rotating_light:' : alert.severity === 'warning' ? ':warning:' : ':information_source:';
    return {
        text: `${emoji} *${alert.title}*\n${alert.message}\n_TITAN ${TITAN_VERSION} • ${alert.source}_`,
    };
}

function formatGenericPayload(alert: Alert): Record<string, unknown> {
    return { ...alert, version: TITAN_VERSION };
}

async function deliverWebhook(alert: Alert): Promise<void> {
    const url = getWebhookUrl();
    if (!url) return;

    let payload: Record<string, unknown>;
    if (isDiscordWebhook(url)) {
        payload = formatDiscordPayload(alert);
    } else if (isSlackWebhook(url)) {
        payload = formatSlackPayload(alert);
    } else {
        payload = formatGenericPayload(alert);
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            logger.warn(COMPONENT, `Webhook delivery failed: HTTP ${res.status}`);
        } else {
            logger.debug(COMPONENT, `Alert delivered: ${alert.title}`);
        }
    } catch (e) {
        logger.warn(COMPONENT, `Webhook delivery error: ${(e as Error).message}`);
    }
}

// ── Send Alert ──────────────────────────────────────────────────

export function sendAlert(severity: AlertSeverity, title: string, message: string, source: string, data?: Record<string, unknown>): void {
    const alert: Alert = {
        severity,
        title,
        message,
        source,
        timestamp: new Date().toISOString(),
        data,
    };

    // Always record in history
    alertHistory.push(alert);
    if (alertHistory.length > MAX_HISTORY) alertHistory.shift();

    // Log locally
    const logFn = severity === 'critical' ? logger.error : severity === 'warning' ? logger.warn : logger.info;
    logFn.call(logger, COMPONENT, `[${severity.toUpperCase()}] ${title}: ${message}`);

    // Emit event for SSE subscribers
    titanEvents.emit('alert', alert);

    // Deliver webhook if severity meets threshold
    if (shouldSend(severity)) {
        deliverWebhook(alert).catch(() => { /* fire-and-forget */ });
    }
}

// ── Event Listeners ─────────────────────────────────────────────

export function initAlerts(): void {
    logger.info(COMPONENT, `Alert system initialized (webhook: ${getWebhookUrl() ? 'configured' : 'not configured'})`);

    // Daemon paused — critical
    titanEvents.on('daemon:paused', (data: { reason?: string }) => {
        sendAlert('critical', 'Daemon Paused', `TITAN daemon paused: ${data.reason || 'unknown reason'}. Background tasks halted.`, 'daemon', data);
    });

    // Ollama health degraded — warning
    titanEvents.on('health:ollama:degraded', (data: { status: number }) => {
        sendAlert('warning', 'Ollama Degraded', `Ollama health check returned HTTP ${data.status}. Model inference may be slow or failing.`, 'health', data);
    });

    // Ollama down — critical
    titanEvents.on('health:ollama:down', (data: { error: string }) => {
        sendAlert('critical', 'Ollama Down', `Cannot reach Ollama: ${data.error}. All local model inference is unavailable.`, 'health', data);
    });

    // Cron stuck — warning
    titanEvents.on('cron:stuck', (data: { since?: string }) => {
        sendAlert('warning', 'Autopilot Stuck', `Autopilot run appears stuck (running since ${data.since || 'unknown'}). May need manual restart.`, 'cron', data);
    });

    // Agent task failed — warning
    titanEvents.on('agent:task:failed', (data: { agentId?: string; error?: string }) => {
        sendAlert('warning', 'Agent Task Failed', `Agent ${data.agentId || 'unknown'} failed: ${data.error || 'no details'}`, 'agent', data);
    });

    // Budget exceeded — critical
    titanEvents.on('commandpost:budget:exceeded', (data: { agentId?: string; pct?: number; action?: string }) => {
        sendAlert('critical', 'Budget Exceeded', `Agent ${data.agentId} exceeded budget (${data.pct}%). Action: ${data.action || 'none'}`, 'commandpost', data);
    });

    // Circuit breaker opened (listen from provider events if emitted)
    titanEvents.on('provider:circuit:open', (data: { provider?: string }) => {
        sendAlert('warning', 'Circuit Breaker Open', `Provider ${data.provider || 'unknown'} circuit breaker opened — requests will be routed to fallback.`, 'provider', data);
    });
}
