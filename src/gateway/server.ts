/**
 * TITAN — Gateway Server
 * WebSocket + HTTP server: the control plane for all channels, agents, tools, and the web UI.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import net from 'net';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir, hostname as osHostname, cpus, loadavg, totalmem, freemem } from 'os';
import { statfs } from 'fs/promises';
import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import { loadConfig, updateConfig } from '../config/config.js';
import type { ProviderConfig } from '../config/schema.js';
import { loadProfile, saveProfile, type PersonalProfile } from '../memory/relationship.js';
import { processMessage } from '../agent/agent.js';
import { onAgentEvent } from '../agent/agentEvents.js';
import { initMemory, closeMemory, getUsageStats, getHistory, getDb } from '../memory/memory.js';
import { initBuiltinSkills, getSkills, toggleSkill, getSkillTools } from '../skills/registry.js';
import { listPersonas, getPersona, invalidatePersonaCache } from '../personas/manager.js';
import { searchSkills as marketplaceSearch, installSkill, uninstallSkill, listSkills as listMarketplaceSkills, listInstalled as listInstalledMarketplace } from '../skills/marketplace.js';
import { getRegisteredTools } from '../agent/toolRunner.js';
import { listSessions, cleanupStaleSessions } from '../agent/session.js';
import { healthCheckAll, discoverAllModels, getModelAliases, chatStream, getFallbackState } from '../providers/router.js';
import { auditSecurity } from '../security/sandbox.js';
import { WebChatChannel } from '../channels/webchat.js';
import { DiscordChannel } from '../channels/discord.js';
import { TelegramChannel } from '../channels/telegram.js';
import { SlackChannel } from '../channels/slack.js';
import { GoogleChatChannel } from '../channels/googlechat.js';
import { WhatsAppChannel } from '../channels/whatsapp.js';
import { MatrixChannel } from '../channels/matrix.js';
import { SignalChannel } from '../channels/signal.js';
import { MSTeamsChannel } from '../channels/msteams.js';
import { IRCChannel } from '../channels/irc.js';
import { MattermostChannel } from '../channels/mattermost.js';
import { LarkChannel } from '../channels/lark.js';
import { EmailInboundChannel } from '../channels/email_inbound.js';
import { LineChannel } from '../channels/line.js';
import { kill as killSwitchFire, resume as killSwitchResume, getState as getKillSwitchState } from '../safety/killSwitch.js';
import { ZulipChannel } from '../channels/zulip.js';
import { MessengerChannel } from '../channels/messenger.js';
import { initAgents, routeMessage, listAgents } from '../agent/multiAgent.js';
import { createOpenAICompatRouter } from '../gateway/openai-compat.js';
import type { ChannelAdapter, InboundMessage } from '../channels/base.js';
import logger, { initFileLogger } from '../utils/logger.js';
import { TITAN_VERSION, TITAN_NAME, TITAN_LOGS_DIR, TITAN_HOME } from '../utils/constants.js';
import { getRestartStats as getRestartStatsSync } from '../utils/restartTracker.js';
import { collectSystemProfile, recordStartupAnalytics, startHeartbeatAnalytics } from '../analytics/collector.js';
import { getMissionControlHTML } from './dashboard.js';
import { serializePrometheus, getMetricsSummary, titanRequestsTotal, titanRequestDuration, titanErrorsTotal, titanActiveSessions, titanToolCallsTotal, titanTokensTotal, titanModelRequestsTotal, recordEvalSuiteResult, recordEvalTimeout, recordEvalError } from './metrics.js';
import { createHardwareRouter } from './routes/hardwareRouter.js';
import { createMetricsRouter } from './routes/metricsRouter.js';
import { createMcpRouter } from './routes/mcpRouter.js';
import { createAgentsRouter } from './routes/agentsRouter.js';
import { initSlashCommands, handleSlashCommand } from './slashCommands.js';
import { initMcpServers } from '../mcp/registry.js';
import { mountMcpHttpEndpoints } from '../mcp/server.js';
import { initMonitors, setMonitorTriggerHandler, listMonitors, addMonitor, removeMonitor, getMonitorEvents } from '../agent/monitor.js';
import { seedBuiltinRecipes } from '../recipes/store.js';
import { parseSlashCommand, runRecipe } from '../recipes/runner.js';
import { getCostStatus } from '../agent/costOptimizer.js';
import { initLearning, getLearningStats } from '../memory/learning.js';
import { initGraph, getGraphStats, clearGraph, flushGraph } from '../memory/graph.js';
import { getLogFilePath } from '../utils/logger.js';
import { closeSession, renameSession, sweepSessions } from '../agent/session.js';
import { initCronScheduler } from '../skills/builtin/cron.js';
import { checkAndSendBriefing } from '../memory/briefing.js';
import { initPersistentWebhooks } from '../skills/builtin/webhook.js';
import { invalidateCacheForModel } from '../agent/responseCache.js';
import { initAutopilot, stopAutopilot, getAutopilotStatus } from '../agent/autopilot.js';
import { initDaemon, stopDaemon, titanEvents } from '../agent/daemon.js';
import { initCommandPost, shutdownCommandPost, isCommandPostEnabled, reportHeartbeat } from '../agent/commandPost.js';
import { initWakeupSystem } from '../agent/agentWakeup.js';
import { initHeartbeatScheduler } from '../agent/heartbeatScheduler.js';
import { auditLog } from '../agent/auditLog.js';
import { isReceiptKind, type ReceiptKind } from '../receipts/types.js';
import { startTunnel, stopTunnel, getTunnelStatus } from '../utils/tunnel.js';
import { createPaperclipRouter, createPaperclipUIRouter } from './routes/paperclip.js';
import { createTracesRouter } from './routes/traces.js';
import { createCheckpointsRouter } from './routes/checkpoints.js';
import { createCompaniesRouter } from './routes/companies.js';
import { createCommandPostRouter } from './routes/commandPost.js';
import { createMissionsRouter } from './routes/missions.js';
import { startMissionWork, handleUserMessage as missionHandleUserMessage, handleStatusChange as missionHandleStatusChange, reattachMissionBridgesOnStartup } from '../agent/missionLifecycle.js';
import { createAdminRouter } from './routes/adminRouter.js';
import { createTeamsRecipesRouter } from './routes/teamsRecipes.js';
import { createFilesRouter } from './routes/files.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createSkillsRouter } from './routes/skills.js';
import { createOrganismRouter } from './routes/organism.js';
import { createMeshRouter } from './routes/mesh.js';
import { createTestsRouter } from './routes/tests.js';
import { createSystemRouter } from './routes/systemRouter.js';
import { createVoiceRouter } from './routes/voiceRouter.js';
import { createTelephonyRouter } from './routes/telephony.js';
import { createUpdateRouter } from './routes/update.js';

import { createSocialRouter } from './routes/socialRouter.js';
import { createWatchRouter } from './routes/watchRouter.js';
import { createStudioRouter } from './routes/studioRouter.js';
import { setupSSEFlush } from '../utils/sseFlush.js';
import { createLifecycleRouter } from './routes/agents.js';

import { getLifecycleManager } from '../utils/lifecycle.js';
import { startVoiceAgent, stopVoiceAgent } from '../skills/builtin/voice_control.js';
const COMPONENT = 'Gateway';

/** Get normalized CPU load (0.0–1.0) using 1-minute load average */
function getCpuLoad(): number {
    const avg = loadavg()[0]; // 1-minute load average
    const cores = cpus().length || 1;
    return Math.min(1, avg / cores);
}

/** Fields that require a gateway restart to take effect */
const RESTART_REQUIRED_PATTERNS = ['channels.*', 'gateway.auth.*', 'logging.level'];

/** Module-level HTTP server reference (allows stopGateway to close it) */
let httpServer: ReturnType<typeof createServer> | null = null;

/** Interval IDs for cleanup on shutdown */
let tokenCleanupInterval: ReturnType<typeof setInterval> | null = null;
let rateLimitCleanupInterval: ReturnType<typeof setInterval> | null = null;
let healthMonitorInterval: ReturnType<typeof setInterval> | null = null;
let sessionAbortCleanupInterval: ReturnType<typeof setInterval> | null = null;
let unsubscribeAgentEvents: (() => void) | null = null;
let activeLlmRequests = 0;
export function getActiveLlmRequests(): number { return activeLlmRequests; }
let maxConcurrentOverride: number | null = null;

// ── Module-level constants (avoid per-request allocation) ──────────

const CP_SSE_EVENTS = [
    'commandpost:activity', 'commandpost:task:checkout', 'commandpost:task:checkin',
    'commandpost:task:expired', 'commandpost:budget:warning', 'commandpost:budget:exceeded',
    'commandpost:agent:heartbeat', 'commandpost:agent:status',
];
const ALLOWED_ORIGINS = [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https?:\/\/\[::1\](:\d+)?$/,
    /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,      // LAN
];
function isAllowedOrigin(origin: string): boolean {
    return ALLOWED_ORIGINS.some(re => re.test(origin));
}

/**
 * Classify a chat error into a structured response that the React UI can render
 * as an actionable banner. Without this, every failure shows up as a generic 500
 * with a stack trace that means nothing to a non-developer.
 *
 * The classifier returns:
 *   { error: string, message: string, status: number, action?: { type, target } }
 *
 * Known error codes (must match what the UI knows how to render):
 *   - no_provider_configured  → no API keys / Ollama unreachable
 *   - rate_limited            → 429 from upstream
 *   - context_too_long        → context window exceeded
 *   - model_not_found         → invalid model id
 *   - auth_failed             → 401/403 from upstream
 *   - upstream_error          → other 4xx/5xx from upstream
 *   - timeout                 → request timed out
 *   - unknown                 → fallback for everything else
 */
interface ChatErrorResponse {
  error: string;
  message: string;
  detail?: string;
  status: number;
  action?: { type: 'open' | 'retry' | 'docs'; target: string; label: string };
}
function classifyChatError(err: Error): ChatErrorResponse {
  const msg = (err.message || String(err)).toLowerCase();
  const detail = err.message;

  // No provider configured / no valid API key
  if (
    msg.includes('no valid provider') ||
    msg.includes('no api key') ||
    msg.includes('not configured') ||
    msg.includes('provider not found')
  ) {
    return {
      error: 'no_provider_configured',
      message: 'No AI provider is configured. Set up a provider to start chatting.',
      detail,
      status: 503,
      action: { type: 'open', target: '/settings', label: 'Open settings' },
    };
  }

  // Rate limited / quota exhausted
  if (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('too many requests')
  ) {
    return {
      error: 'rate_limited',
      message: "You've hit your provider's rate limit. Wait a moment and try again, or switch providers in Settings.",
      detail,
      status: 429,
      action: { type: 'retry', target: '', label: 'Retry' },
    };
  }

  // Context window exceeded
  if (
    msg.includes('context length') ||
    msg.includes('context window') ||
    msg.includes('maximum context') ||
    msg.includes('too many tokens') ||
    msg.includes('context_length_exceeded') ||
    msg.includes('prompt is too long')
  ) {
    return {
      error: 'context_too_long',
      message: 'The conversation got too long for the model. Start a new session or compact this one.',
      detail,
      status: 413,
      action: { type: 'open', target: '/sessions', label: 'New session' },
    };
  }

  // Model not found / invalid model id
  if (
    msg.includes('model not found') ||
    msg.includes('invalid model') ||
    msg.includes('unknown model') ||
    msg.includes('model_not_found') ||
    msg.includes('does not exist')
  ) {
    return {
      error: 'model_not_found',
      message: "The selected model doesn't exist or you don't have access to it. Pick a different model in Settings.",
      detail,
      status: 404,
      action: { type: 'open', target: '/settings', label: 'Pick a model' },
    };
  }

  // Auth failure (bad key / expired)
  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('authentication') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key')
  ) {
    return {
      error: 'auth_failed',
      message: 'Your API key was rejected by the provider. Check it in Settings → Providers.',
      detail,
      status: 401,
      action: { type: 'open', target: '/settings', label: 'Check API key' },
    };
  }

  // Timeout
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('etimedout') ||
    msg.includes('aborted')
  ) {
    return {
      error: 'timeout',
      message: 'The model took too long to respond. Try again, or switch to a faster model.',
      detail,
      status: 504,
      action: { type: 'retry', target: '', label: 'Retry' },
    };
  }

  // Upstream provider error
  if (
    msg.includes('500') || msg.includes('502') || msg.includes('503') ||
    msg.includes('gateway') || msg.includes('upstream')
  ) {
    return {
      error: 'upstream_error',
      message: "Your AI provider is having issues right now. Try again, or switch providers.",
      detail,
      status: 502,
      action: { type: 'retry', target: '', label: 'Retry' },
    };
  }

  // Fallback
  return {
    error: 'unknown',
    message: detail || 'Something went wrong while processing your message.',
    detail,
    status: 500,
  };
}

/** Internal health monitor state */
const healthState = {
  ollamaHealthy: false,
  ttsHealthy: false,
  lastCheck: null as string | null,
  lastActiveLlm: 0,
  lastActiveLlmTime: 0,
  stuckDetected: false,
};

export function stopGateway(): Promise<void> {
    return new Promise((resolve) => {
        // Clear intervals to release the event loop
        if (tokenCleanupInterval) { clearInterval(tokenCleanupInterval); tokenCleanupInterval = null; }
        if (rateLimitCleanupInterval) { clearInterval(rateLimitCleanupInterval); rateLimitCleanupInterval = null; }
        if (healthMonitorInterval) { clearInterval(healthMonitorInterval); healthMonitorInterval = null; }
        if (sessionAbortCleanupInterval) { clearInterval(sessionAbortCleanupInterval); sessionAbortCleanupInterval = null; }
        if (unsubscribeAgentEvents) { unsubscribeAgentEvents(); unsubscribeAgentEvents = null; }

        if (httpServer) {
            // Force-close open connections after 3 seconds (SSE/WebSocket keep-alives block shutdown)
            const forceTimeout = setTimeout(() => {
                logger.warn('Gateway', 'Shutdown timeout — destroying remaining connections');
                httpServer?.closeAllConnections?.();
                httpServer = null;
                resolve();
            }, 3000);
            forceTimeout.unref();

            httpServer.close(() => {
                clearTimeout(forceTimeout);
                httpServer = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

/** Usage tracking — per-request cost/token tracking */
interface UsageEntry {
  timestamp: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  sessionId: string;
}
const usageLog: UsageEntry[] = [];
const MAX_USAGE_LOG = 10000; // Keep last 10K entries in memory

// Approximate cost per 1M tokens (input/output) for common models
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-sonnet': { input: 3, output: 15 },
  'claude-haiku': { input: 0.25, output: 1.25 },
  'claude-opus': { input: 15, output: 75 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'ollama': { input: 0, output: 0 }, // local = free
  'groq': { input: 0.05, output: 0.08 },
  'deepseek': { input: 0.14, output: 0.28 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const key = Object.keys(MODEL_COSTS).find(k => model.toLowerCase().includes(k));
  if (!key) return 0;
  const rates = MODEL_COSTS[key];
  return (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;
}

function trackUsage(model: string, tokenUsage: { prompt?: number; completion?: number } | undefined, durationMs: number, sessionId: string): void {
  if (!tokenUsage) return;
  const prompt = tokenUsage.prompt || 0;
  const completion = tokenUsage.completion || 0;
  const provider = model.includes('/') ? model.split('/')[0] : 'unknown';
  const entry: UsageEntry = {
    timestamp: new Date().toISOString(),
    model,
    provider,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    estimatedCostUsd: estimateCost(model, prompt, completion),
    durationMs,
    sessionId,
  };
  usageLog.push(entry);
  if (usageLog.length > MAX_USAGE_LOG) usageLog.splice(0, usageLog.length - MAX_USAGE_LOG);
}

/** Active session tokens (persisted to disk so they survive restarts) */
const AUTH_TOKENS_PATH = join(TITAN_HOME, 'auth-tokens.json');

/**
 * Session-token TTL — configurable via `gateway.auth.tokenTtlMs`.
 * Pre-v5.7.2 this was hardcoded to 24h, which silently expired Tony's
 * sessions overnight and (combined with the cleanup timer) wiped
 * auth-tokens.json to `[]`. Default is now 30 days for self-hosted use.
 */
function getAuthTokenTtlMs(): number {
    try {
        const cfg = loadConfig();
        const v = cfg.gateway?.auth?.tokenTtlMs;
        if (typeof v === 'number' && v > 0) return v;
    } catch { /* fall through */ }
    return 30 * 24 * 60 * 60 * 1000; // 30 days
}

function loadAuthTokens(): Map<string, { createdAt: number; userId: string }> {
    const map = new Map<string, { createdAt: number; userId: string }>();
    try {
        if (fs.existsSync(AUTH_TOKENS_PATH)) {
            const raw = JSON.parse(fs.readFileSync(AUTH_TOKENS_PATH, 'utf-8'));
            if (Array.isArray(raw)) {
                const ttlMs = getAuthTokenTtlMs();
                const now = Date.now();
                let dropped = 0;
                for (const item of raw) {
                    if (item && typeof item.token === 'string' && typeof item.createdAt === 'number' && typeof item.userId === 'string') {
                        if (now - item.createdAt <= ttlMs) {
                            map.set(item.token, { createdAt: item.createdAt, userId: item.userId });
                        } else {
                            dropped++;
                        }
                    }
                }
                if (dropped > 0) {
                    logger.info(COMPONENT, `[Auth] Dropped ${dropped} expired session token(s) at boot (TTL: ${Math.round(ttlMs / 3600_000)}h).`);
                }
            }
        }
    } catch {
        // Best-effort: if file is corrupt, start fresh
    }
    return map;
}

function saveAuthTokens(): void {
    try {
        const entries = [];
        for (const [token, entry] of authTokens) {
            entries.push({ token, createdAt: entry.createdAt, userId: entry.userId });
        }
        fs.writeFileSync(AUTH_TOKENS_PATH, JSON.stringify(entries, null, 2));
    } catch {
        // Best-effort persistence
    }
}

const authTokens = loadAuthTokens();

/** S3: Get userId from request auth token */
function getUserIdFromReq(req: { headers: { authorization?: string } }): string {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const entry = authTokens.get(token);
    if (entry) return entry.userId;
  }
  return 'default-user';
}

// Active session abort controllers — keyed by sessionId
const sessionAborts = new Map<string, AbortController>();
// R8: Track abort controller creation time for TTL-based cleanup
const sessionAbortTimes = new Map<string, number>();

// S3: Track session ownership — sessionId → userId
const sessionOwners = new Map<string, string>();

// R8: Periodic cleanup of orphaned abort controllers (TTL 5 min)
sessionAbortCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, controller] of sessionAborts) {
        if (controller.signal.aborted || (now - (sessionAbortTimes.get(id) || 0)) > 300_000) {
            sessionAborts.delete(id);
            sessionAbortTimes.delete(id);
            sessionOwners.delete(id);
        }
    }
}, 60_000);
sessionAbortCleanupInterval.unref();

// Clean expired tokens every 10 minutes.
// Pre-v5.7.2 this used a hardcoded 24h TTL which clobbered auth-tokens.json
// to `[]` overnight on self-hosted single-user TITANs. Now reads the
// configured `gateway.auth.tokenTtlMs` (default 30 days).
tokenCleanupInterval = setInterval(() => {
    const now = Date.now();
    const ttlMs = getAuthTokenTtlMs();
    let purged = 0;
    for (const [tok, entry] of authTokens) {
        if (now - entry.createdAt > ttlMs) { authTokens.delete(tok); purged++; }
    }
    // Only persist if something actually changed — avoids needless disk writes
    // on idle TITANs and avoids the "everything got nuked" failure mode.
    if (purged > 0) {
        logger.info(COMPONENT, `[Auth] Purged ${purged} expired session token(s).`);
        saveAuthTokens();
    }
}, 600_000);
tokenCleanupInterval.unref();

/** Constant-time string comparison to prevent timing attacks */
function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Check if a request token is valid */
function isValidToken(token: string | undefined, config: ReturnType<typeof loadConfig>): boolean {
  const auth = config.gateway.auth;
  if (!auth || auth.mode === 'none') return true;
  if (!token) return false;
  // S2: If token mode but no token configured, log warning and deny (don't silently allow)
  if (auth.mode === 'token') {
    if (!auth.token) {
      logger.warn(COMPONENT, 'Auth mode is "token" but no token configured — denying request. Set gateway.auth.token or switch to mode "password".');
      return false;
    }
    return safeCompare(token, auth.token);
  }
  if (auth.mode === 'password') {
    const entry = authTokens.get(token);
    if (!entry) return false;
    // v6.1.0-alpha.26 — use the configurable TTL (default 30 days). Was
    // hardcoded to 24h, which silently invalidated tokens that the
    // *loader* and *cleanup* paths (which BOTH use getAuthTokenTtlMs)
    // happily kept. Result: a 25h-old token loaded from disk would
    // validate as expired by this function, the user would see 401s
    // on every SSE / authenticated endpoint, and `authTokens.delete`
    // here would drop the still-valid token mid-flight. Caught in the
    // wild on 2026-05-13 when Tony's Mission Chat SSE stream returned
    // 401 on every poll while header-auth calls succeeded.
    const ttlMs = getAuthTokenTtlMs();
    if (Date.now() - entry.createdAt > ttlMs) {
        authTokens.delete(token);
        saveAuthTokens();
        return false;
    }
    return true;
  }
  return false;
}

/** Login page HTML */
function getLoginHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TITAN — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
@keyframes gradientBg{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes shimmer{0%{background-position:-200% center}100%{background-position:200% center}}
@keyframes shake{0%,100%{transform:translateX(0)}10%,30%,50%,70%,90%{transform:translateX(-4px)}20%,40%,60%,80%{transform:translateX(4px)}}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
body{font-family:'Inter','Segoe UI',system-ui,sans-serif;background:linear-gradient(135deg,#0a0e1a 0%,#0f172a 25%,#1a1040 50%,#0f172a 75%,#0a0e1a 100%);background-size:400% 400%;animation:gradientBg 15s ease infinite;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:rgba(17,24,39,0.85);backdrop-filter:blur(20px);border:1px solid rgba(42,48,80,0.6);border-radius:16px;padding:40px;width:380px;box-shadow:0 0 40px rgba(6,182,212,.1),0 0 80px rgba(139,92,246,.05);animation:fadeIn .6s ease-out}
.box.shake{animation:shake .5s ease}
h1{font-size:28px;font-weight:700;background:linear-gradient(90deg,#06b6d4,#8b5cf6,#06b6d4);background-size:200% auto;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:shimmer 3s linear infinite;text-align:center;letter-spacing:3px;margin-bottom:4px}
.sub{text-align:center;color:#94a3b8;font-size:13px;margin-bottom:32px}
label{font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px}
input{width:100%;background:rgba(26,31,54,0.8);border:1px solid #2a3050;border-radius:10px;padding:12px 16px;color:#e2e8f0;font-size:15px;outline:none;transition:border .2s,box-shadow .2s}
input:focus{border-color:#06b6d4;box-shadow:0 0 12px rgba(6,182,212,.2)}
button{width:100%;margin-top:20px;background:linear-gradient(135deg,#06b6d4,#8b5cf6);border:none;border-radius:10px;padding:14px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s,transform .1s}
button:hover{opacity:.9;transform:translateY(-1px)}
button:active{transform:translateY(0)}
.error{color:#ef4444;font-size:13px;margin-top:12px;text-align:center;display:none}
</style>
</head>
<body>
<div class="box">
  <h1>⚡ TITAN</h1>
  <div class="sub">Mission Control</div>
  <label>Password</label>
  <input type="password" id="pw" placeholder="Enter gateway password" onkeydown="if(event.key==='Enter')login()"/>
  <button onclick="login()">Unlock</button>
  <div class="error" id="err">Incorrect password. Try again.</div>
</div>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  const res = await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  if (res.ok) {
    const {token} = await res.json();
    localStorage.setItem('titan_token', token);
    location.href = '/';
  } else {
    document.getElementById('err').style.display = 'block';
    document.getElementById('pw').value = '';
    document.getElementById('pw').focus();
    const box = document.querySelector('.box');
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
  }
}
document.getElementById('pw').focus();
</script>
</body>
</html>`;
}

/** All active channel adapters */
const channels: Map<string, ChannelAdapter> = new Map();

/** All connected WebSocket clients */
interface TaggedWebSocket extends WebSocket {
  titanSessionId?: string;
  titanUserId?: string;
}
const wsClients: Set<TaggedWebSocket> = new Set();
const WS_MAX_MESSAGE_BYTES = 10 * 1024 * 1024; // 10MB max WS message

/** The WebChat channel instance */
let webChatChannel: WebChatChannel | null = null;

/** Broadcast a message to WebSocket clients. If userId is specified, only sends to that user's connections. */
function broadcast(data: Record<string, unknown>, userId?: string): void {
  const json = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      // Session isolation: if userId specified, only send to matching clients
      if (userId && (client as TaggedWebSocket).titanUserId && (client as TaggedWebSocket).titanUserId !== userId) continue;
      try {
        client.send(json);
      } catch (err) {
        logger.warn(COMPONENT, `Broadcast send failed: ${(err as Error).message}`);
      }
    }
  }
}

// Sub-agent event bridge: forward agent bus events to SSE broadcast
unsubscribeAgentEvents = onAgentEvent((event) => {
    const sseType = event.type === 'tool_call' ? 'tool_call' : event.type === 'tool_end' ? 'tool_end' : event.type;
    broadcast({ type: sseType, ...event.data, agentName: event.agentName, agentId: event.agentId, isSubAgent: true, timestamp: event.timestamp });
});

// Initiative event bridge: broadcast autonomous task progress to dashboard chat
titanEvents.on('initiative:start', (data) => {
    broadcast({
        type: 'system_message',
        content: `🤖 **Initiative starting**: ${(data as Record<string, string>).subtaskTitle}\n📋 Goal: ${(data as Record<string, string>).goalTitle}`,
        source: 'initiative',
        timestamp: (data as Record<string, string>).timestamp,
    });
});
titanEvents.on('initiative:complete', (data) => {
    const d = data as Record<string, unknown>;
    broadcast({
        type: 'system_message',
        content: `✅ **Subtask completed**: ${d.subtaskTitle}\n🔧 Tools: ${(d.toolsUsed as string[]).join(', ')}\n📝 ${(d.summary as string || '').slice(0, 200)}`,
        source: 'initiative',
        timestamp: d.timestamp as string,
    });
});
titanEvents.on('initiative:no_progress', (data) => {
    const d = data as Record<string, unknown>;
    broadcast({
        type: 'system_message',
        content: `⚠️ **No progress on**: ${d.subtaskTitle}\n${d.reason}`,
        source: 'initiative',
        timestamp: d.timestamp as string,
    });
});
titanEvents.on('initiative:tool_call', (data) => {
    const d = data as Record<string, unknown>;
    broadcast({
        type: 'system_message',
        content: `🔧 **${d.tool}**: ${d.args || ''}`,
        source: 'initiative',
        timestamp: d.timestamp as string,
    });
});
titanEvents.on('initiative:tool_result', (data) => {
    const d = data as Record<string, unknown>;
    const icon = d.success ? '✅' : '❌';
    broadcast({
        type: 'system_message',
        content: `${icon} **${d.tool}** ${d.success ? 'completed' : 'failed'} (${d.durationMs}ms)`,
        source: 'initiative',
        timestamp: d.timestamp as string,
    });
});
titanEvents.on('initiative:round', (data) => {
    const d = data as Record<string, unknown>;
    broadcast({
        type: 'system_message',
        content: `🔄 **Round ${d.round}/${d.maxRounds}** — ${d.subtaskTitle}`,
        source: 'initiative',
        timestamp: d.timestamp as string,
    });
});

/** Safely send a response through a channel adapter.
 * Hunt Finding #13: uses deliver() which runs the content through the
 * outbound sanitizer before invoking the channel's send() method. Applies
 * to all 17 channel adapters automatically. */
async function safeSend(channelName: string, msg: { channel: string; userId: string; groupId?: string; content: string; replyTo?: string }): Promise<void> {
  const channel = channels.get(channelName);
  if (!channel) return;
  try {
    await channel.deliver(msg);
  } catch (err) {
    logger.warn(COMPONENT, `Channel send failed (${channelName}): ${(err as Error).message}`);
  }
}

/** Handle an inbound message from any channel */
async function handleInboundMessage(msg: InboundMessage): Promise<void> {
  logger.info(COMPONENT, `[${msg.channel}] ${msg.userName || msg.userId}: ${msg.content.slice(0, 100)}`);

  // Broadcast to WebSocket clients for UI
  broadcast({
    type: 'message',
    direction: 'inbound',
    channel: msg.channel,
    userId: msg.userId,
    userName: msg.userName,
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
  });

  // ── Native slash commands (highest priority) ──────────────────
  const slashResult = await handleSlashCommand(msg.content, msg.channel, msg.userId);
  if (slashResult) {
    await safeSend(msg.channel, { channel: msg.channel, userId: msg.userId, groupId: msg.groupId, content: slashResult.response, replyTo: msg.id });
    broadcast({ type: 'message', direction: 'outbound', channel: msg.channel, userId: msg.userId, content: slashResult.response, timestamp: new Date().toISOString() });
    return;
  }

  // ── Recipe slash commands (second priority) ──────────────────
  const slash = parseSlashCommand(msg.content);
  if (slash) {
    const { command, args } = slash;
    const params: Record<string, string> = {};
    if (args) { params['file'] = args; params['topic'] = args; params['error'] = args; }
    try {
      let fullResponse = '';
      for await (const step of runRecipe(command, params)) {
        const r = await processMessage(step.prompt, msg.channel, msg.userId);
        fullResponse += (fullResponse ? '\n\n' : '') + r.content;
      }
      await safeSend(msg.channel, { channel: msg.channel, userId: msg.userId, groupId: msg.groupId, content: fullResponse, replyTo: msg.id });
      broadcast({ type: 'message', direction: 'outbound', channel: msg.channel, userId: msg.userId, content: fullResponse, timestamp: new Date().toISOString() });
      return;
    } catch {
      // Recipe not found — fall through to normal processing
    }
  }

  try {
    // Route through multi-agent system
    const response = await routeMessage(msg.content, msg.channel, msg.userId);

    // Send response back to the channel
    await safeSend(msg.channel, {
      channel: msg.channel,
      userId: msg.userId,
      groupId: msg.groupId,
      content: response.content,
      replyTo: msg.id,
    });

    // Broadcast response to UI
    broadcast({
      type: 'message',
      direction: 'outbound',
      channel: msg.channel,
      userId: msg.userId,
      content: response.content,
      toolsUsed: response.toolsUsed,
      tokenUsage: response.tokenUsage,
      durationMs: response.durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(COMPONENT, `Error processing message: ${(error as Error).message}`);
    broadcast({ type: 'error', message: 'TITAN ran into a problem handling that message. Please try again.' });
  }
}

/** Start the Gateway server */
export async function startGateway(options?: { port?: number; host?: string; verbose?: boolean; rateLimitMax?: number; rateLimitWindowMs?: number; skipUsableCheck?: boolean }): Promise<void> {
  const config = loadConfig();
  initFileLogger(TITAN_LOGS_DIR);
  const port = options?.port || config.gateway.port;
  let host = options?.host || config.gateway.host;

  // Hunt Finding #29 (2026-04-14): install a bounded global HTTP dispatcher
  // BEFORE any fetch() calls are made. Without this, each parallel Ollama
  // fetch opens a fresh socket and the keep-alive pool grows unboundedly.
  // Phase 5 load test saw 80+ idle sockets to Ollama after 100 requests.
  try {
    const { installGlobalHttpPool } = await import('../utils/httpPool.js');
    const poolCfg = (config.gateway as unknown as { httpPool?: { connections?: number; keepAliveTimeoutMs?: number; keepAliveMaxTimeoutMs?: number; headersTimeoutMs?: number; bodyTimeoutMs?: number } }).httpPool;
    installGlobalHttpPool({
      connections: poolCfg?.connections,
      keepAliveTimeoutMs: poolCfg?.keepAliveTimeoutMs,
      keepAliveMaxTimeoutMs: poolCfg?.keepAliveMaxTimeoutMs,
      headersTimeoutMs: poolCfg?.headersTimeoutMs,
      bodyTimeoutMs: poolCfg?.bodyTimeoutMs,
    });
  } catch (e) {
    logger.warn(COMPONENT, `[HttpPool] Failed to install global dispatcher: ${(e as Error).message} — fetch() will use Node defaults (unbounded pool)`);
  }

  logger.info(COMPONENT, `Starting ${TITAN_NAME} Gateway v${TITAN_VERSION}`);

  // v5.5.28 FIX: sweep orphaned atomic-write tmp files. atomicWriteFileSync
  // writes to .tmp.<ts>.<rand> then renames; if the process is killed
  // between those steps the tmp file leaks. The 2026-05-08 audit found
  // 188MB of these (vectors.json + test-history). Best-effort.
  try {
    const { sweepAtomicTmpOrphans } = await import('../utils/helpers.js');
    const swept = sweepAtomicTmpOrphans(TITAN_HOME);
    if (swept.removed > 0) {
      logger.info(COMPONENT, `Swept ${swept.removed} orphaned tmp file(s) from ${TITAN_HOME} — recovered ${(swept.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
  } catch (e) {
    logger.warn(COMPONENT, `tmp sweep failed: ${(e as Error).message}`);
  }

  // Persist this boot so we can detect restart loops across systemd-managed
  // restarts. See src/utils/restartTracker.ts for why a single process can't
  // see its own loop.
  try {
    const { recordBoot, getRestartStats } = await import('../utils/restartTracker.js');
    recordBoot(TITAN_VERSION);
    const stats = getRestartStats();
    if (stats.severity !== 'ok' && stats.reason) {
      const { sendAlert } = await import('../agent/alerts.js');
      sendAlert(
        stats.severity,
        'Gateway restart loop detected',
        stats.reason,
        'restart-tracker',
        {
          restartsLast10Min: stats.restartsLast10Min,
          restartsLastHour: stats.restartsLastHour,
          nRestartsSystemd: stats.nRestartsSystemd,
          previousBootAt: stats.previousBootAt,
        },
      );
    }
  } catch (err) {
    logger.warn(COMPONENT, `restart tracker init failed: ${(err as Error).message}`);
  }

  // ── First-run guard: refuse to start with no usable provider ──
  // Without this, the gateway boots fine but every chat call fails with a
  // generic 500. Users have no idea they need to configure a provider.
  // Bypass with --skip-usable-check (or skipUsableCheck option) for advanced use.
  if (!options?.skipUsableCheck) {
    const { hasUsableProvider } = await import('../config/config.js');
    const usable = await hasUsableProvider();
    if (!usable.ok) {
      console.error('');
      console.error('\x1b[31m\x1b[1m❌ TITAN is not configured.\x1b[0m');
      console.error('');
      console.error(`   ${usable.details}`);
      console.error('');
      console.error('   Run the setup wizard:');
      console.error('     \x1b[36mtitan onboard\x1b[0m');
      console.error('');
      console.error('   Or set an environment variable:');
      console.error('     \x1b[36mexport ANTHROPIC_API_KEY="sk-ant-..."\x1b[0m');
      console.error('     \x1b[36mexport OPENAI_API_KEY="sk-..."\x1b[0m');
      console.error('     \x1b[36mexport OLLAMA_BASE_URL="http://localhost:11434"\x1b[0m');
      console.error('');
      console.error('   Or check what went wrong:');
      console.error('     \x1b[36mtitan doctor\x1b[0m');
      console.error('');
      console.error('   To skip this check (advanced):');
      console.error('     \x1b[36mtitan gateway --skip-usable-check\x1b[0m');
      console.error('');
      process.exit(1);
    }
    logger.info(COMPONENT, `Provider check passed: ${usable.details}`);
  }

  // ── Production safety warning ─────────────────────────────────────
  if (config.autonomy?.mode === 'autonomous') {
    logger.warn(COMPONENT, '⚠️  AUTONOMY MODE IS "autonomous" — all tools run without approval. Safe for personal use, DANGEROUS for multi-user deployments.');
    logger.warn(COMPONENT, '   Set autonomy.mode to "supervised" in titan.json if exposing to external users.');
  }
  if (config.commandPost?.enabled) {
    logger.info(COMPONENT, '✅ Command Post governance is active — approvals route through CP queue');
  } else {
    logger.warn(COMPONENT, '⚠️  Command Post is DISABLED — no approval queue, no budget enforcement, no agent registry');
  }
  if (config.selfMod?.enabled) {
    logger.info(COMPONENT, '✅ Self-modification is active — writes are staged for human review');
  }

  // ── Stale session cleanup: mark orphaned active sessions as idle ──
  cleanupStaleSessions();
  // Run every 60s so ephemeral one-shot sessions (api / autoresearch-* /
  // initiative-* / monitor / mesh / etc.) get cleared promptly within their
  // 5min idle TTL. Persistent channels (webchat / voice / discord / ...)
  // still use the full SESSION_TIMEOUT_MS (30min) inside cleanupStaleSessions.
  // Pre-fix: 5min interval + uniform 30min TTL accumulated 755 sessions in
  // 29min on the live service (Kimi observation, 2026-04-26).
  setInterval(() => cleanupStaleSessions(), 60 * 1000);

  // ── Port pre-check: fail fast before loading subsystems ────
  const portAvailable = await new Promise<boolean>((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => { tester.close(); resolve(true); });
    tester.listen(port, host);
  });
  if (!portAvailable) {
    logger.error(COMPONENT, `Port ${port} is already in use. Is TITAN already running?`);
    logger.info(COMPONENT, `Try: titan gateway --port ${port + 1}`);
    process.exit(1);
  }

  // ── GPU detection: adjust stall timeout for CPU-only inference ──
  const { detectGpu } = await import('../utils/hardware.js');
  if (!detectGpu()) {
    const { setStallThreshold } = await import('../agent/stallDetector.js');
    setStallThreshold(120_000);
    logger.info(COMPONENT, 'No GPU detected — stall timeout increased to 120s for CPU inference');
    maxConcurrentOverride = 2;
    logger.info(COMPONENT, 'CPU-only mode: maxConcurrentTasks auto-tuned to 2');
  }

  // Initialize subsystems
  initMemory();
  initLearning();
  initGraph();

  // Recover persisted deliberation states from previous session
  import('../agent/deliberation.js').then(({ recoverDeliberations }) => {
    recoverDeliberations();
  }).catch(() => {});

  // Initialize vector search (Tier 2 memory — non-blocking)
  import('../memory/vectors.js').then(({ initVectors }) => {
    initVectors().then(ok => {
      if (ok) logger.info(COMPONENT, 'Vector search (Tier 2 memory) initialized');
    }).catch(() => {});
  }).catch(() => {});

  await initBuiltinSkills();
  initAgents();

  // v6.0 step 11 — Start the somaInitiative proactive loop on gateway boot.
  // Without this, the loop's `startSomaInitiative()` function is dead code
  // and the "TITAN acts without being asked" v6.0 promise is unobservable.
  // The loop is self-throttling (5-min pulse, conservative confidence
  // floor, frustration-aware throttling) so we can wire it on without
  // risk of spam. Errors are swallowed so a Soma bug never breaks boot.
  try {
    const { startSomaInitiative } = await import('../agent/somaInitiative.js');
    startSomaInitiative({ userId: 'default-user' });
  } catch (err) {
    logger.warn(COMPONENT, `somaInitiative failed to start: ${(err as Error).message}`);
  }

  // ── Rate limiter (inline, no deps) ─────────────────────────
  const defaultRateLimitWindowMs = options?.rateLimitWindowMs ?? 60000;
  const defaultRateLimitMax = options?.rateLimitMax ?? 30;
  const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

  /**
   * Get a consistent client IP address for rate limiting.
   * Falls back through: X-Forwarded-For → req.ip → socket remoteAddress
   */
  function getClientIp(req: Request): string {
      return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          || req.ip
          || req.socket?.remoteAddress
          || 'unknown';
  }

  function rateLimit(windowMs: number, maxRequests: number) {
      return (req: Request, res: Response, next: NextFunction) => {
          const key = getClientIp(req);
          const now = Date.now();
          const entry = rateLimitStore.get(key);
          if (!entry || now > entry.resetAt) {
              rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
              next();
          } else if (entry.count < maxRequests) {
              entry.count++;
              next();
          } else {
              const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
              logger.warn(COMPONENT, `[RateLimit] Client ${key} rate limited (${entry.count}/${maxRequests} in ${windowMs}ms)`);
              res.setHeader('Retry-After', String(retryAfter));
              res.status(429).json({ error: 'Too many requests', retryAfter });
          }
      };
  }

  // ── Concurrent request guard (prevents parallel abuse) ────
  // Hunt Finding #27 (2026-04-14): previously this attached BOTH a 'finish'
  // and a 'close' handler that each decremented the counter. Both events
  // fire for a normal request completion ('finish' first, then 'close'),
  // so every real request caused TWO decrements. Under parallel load the
  // counter drifted below the true active-request count, effectively
  // doubling the allowed concurrency. Math.max(0, -) kept it from going
  // negative numerically but the effective limit became 2×MAX.
  //
  // Fix: use ONLY 'close', which fires for every completed response
  // (normal, aborted, errored) exactly once. Remove 'finish' to eliminate
  // the double-decrement. Also make the limit configurable via config
  // so operators can tune it for their deployment instead of being stuck
  // at the hardcoded 5.
  let activeMessageRequests = 0;
  const MAX_CONCURRENT_MESSAGES = (() => {
      const cfg = loadConfig() as unknown as { gateway?: { maxConcurrentMessages?: number } };
      const v = cfg.gateway?.maxConcurrentMessages;
      if (typeof v === 'number' && v > 0 && v <= 1000) return v;
      return 5;
  })();

  function concurrencyGuard(maxConcurrent: number) {
      return (_req: Request, res: Response, next: NextFunction) => {
          if (activeMessageRequests >= maxConcurrent) {
              res.status(503).json({ error: 'Server busy — too many concurrent requests' });
              return;
          }
          activeMessageRequests++;
          // 'close' fires exactly once per completed request — safer than 'finish'
          // which only fires for successful sends AND is followed by 'close'
          // anyway (causing the double-decrement bug).
          let decremented = false;
          res.on('close', () => {
              if (decremented) return;
              decremented = true;
              activeMessageRequests = Math.max(0, activeMessageRequests - 1);
          });
          next();
      };
  }

  // Clean rate limit store every 60 seconds (unref so it doesn't block shutdown)
  rateLimitCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of rateLimitStore) {
          if (now > entry.resetAt) rateLimitStore.delete(key);
      }
      // Cap rate limit store to prevent unbounded growth
      if (rateLimitStore.size > 10_000) {
          const entries = [...rateLimitStore.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
          const toRemove = entries.slice(0, entries.length - 10_000);
          for (const [key] of toRemove) rateLimitStore.delete(key);
      }
  }, 60_000);
  rateLimitCleanupInterval.unref();

  // Create Express app
  const app = express();

  // ── Serve React SPA static assets FIRST ───────────────────
  // Static files (JS, CSS, images) should bypass JSON parsing,
  // request logging, and auth middleware for efficiency.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const uiDistPath = join(__dirname, '../../ui/dist');
  const uiIndexPath = join(uiDistPath, 'index.html');
  const hasReactUI = fs.existsSync(uiIndexPath);
  let cachedIndexHtml: string | null = null;
  if (hasReactUI) {
    // Cache index.html in memory to avoid sync file reads on every request
    cachedIndexHtml = fs.readFileSync(uiIndexPath, 'utf8');
    app.use(express.static(uiDistPath, { index: false }));
    // Hot-reload the cache when the file changes (dev rebuilds)
    fs.watchFile(uiIndexPath, { interval: 1000 }, () => {
      try {
        cachedIndexHtml = fs.readFileSync(uiIndexPath, 'utf8');
      } catch { /* ignore read errors during write */ }
    });
  }

  app.use(express.json({ limit: '1mb' }));

  // Request logging middleware (skips static assets served above)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(COMPONENT, `${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  // OpenAI API compatibility layer (/v1/models, /v1/chat/completions, /v1/embeddings)
  // v6.5 P5 — auth gate. The /api auth middleware (below) is path-scoped to
  // /api, so without this guard /v1 was reachable with ZERO authentication even
  // when auth.mode='token'/'password' was configured — anyone who could reach
  // the port could burn the operator's provider keys via /v1/chat/completions
  // and enumerate coverage via /v1/models. Mirror the /api token check here.
  // When auth is unconfigured (mode 'none', or 'token' with no token set) /v1
  // stays open, preserving the local-dev experience.
  app.use('/v1', (req, res, next) => {
    const cfg = loadConfig();
    const auth = cfg.gateway.auth;
    if (!auth || auth.mode === 'none') { next(); return; }
    if (auth.mode === 'token' && !auth.token) { next(); return; }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string);
    if (isValidToken(token, cfg)) { next(); return; }
    res.status(401).json({
      error: {
        message: 'Unauthorized. /v1 requires the TITAN gateway token as the Bearer credential when auth is enabled.',
        type: 'invalid_request_error',
        code: 'unauthorized',
      },
    });
  });
  app.use('/v1', createOpenAICompatRouter());

  // ── Paperclip sidecar management & proxy ───────────────────
  app.use('/api/paperclip', createPaperclipRouter());
  app.use('/paperclip', createPaperclipUIRouter());

  // Ollama native API proxy (/ollama/* → configured Ollama server)
  // The UI's titan2/llm/ollama.ts hits /ollama/api/chat and /ollama/api/generate
  app.all('/ollama/*', async (req: Request, res: Response) => {
    const cfg = loadConfig();
    const ollamaBase = cfg.providers?.ollama?.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
    const targetPath = req.path.replace(/^\/ollama/, '');
    const targetUrl = `${ollamaBase}${targetPath}`;

    try {
      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/json',
          Accept: req.headers['accept'] || '*/*',
        },
        body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      });

      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        // Don't forward content-encoding; Node will handle compression itself
        if (key.toLowerCase() !== 'content-encoding') {
          res.setHeader(key, value);
        }
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (err) {
      logger.error(COMPONENT, `Ollama proxy error: ${(err as Error).message}`);
      res.status(502).json({ error: 'Ollama proxy error', message: (err as Error).message });
    }
  });

  // Handle JSON parse errors and payload too large
  app.use((err: Error & { type?: string; status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'Payload too large (max 1MB)' });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    next(err);
  });

  // Security headers + CSP
  app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy', [
          "default-src 'self'",
          // Sandbox widget iframes use new Function() for code evaluation.
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self' ws: wss: https: http:",
          "media-src 'self' blob: mediastream:",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          // Canvas AI-generated widgets run in a sandboxed iframe whose
          // source is a blob: URL built by ui/src/titan2/sandbox/SandboxRuntime.
          // Without `frame-src blob:` the browser shows:
          //   "This content is blocked. Contact the site owner to fix the issue."
          // worker-src + child-src are included as safety fallbacks for
          // older engines that don't honor frame-src directly.
          "frame-src 'self' blob: data:",
          "child-src 'self' blob: data:",
          "worker-src 'self' blob:",
      ].join('; '));
      res.removeHeader('X-Powered-By');
      next();
  });

  // CORS — allow localhost, Tailscale, Cloudflare tunnels, and LAN origins
  const gatewayPort = config.gateway.port || 48420;
  const localhostOrigins = new Set([
      `http://127.0.0.1:${gatewayPort}`,
      `http://localhost:${gatewayPort}`,
      `https://127.0.0.1:${gatewayPort}`,
      `https://localhost:${gatewayPort}`,
  ]);
  const dynamicOriginPatterns = [
      /^https?:\/\/[a-z0-9-]+\.ts\.net(:\d+)?$/,          // Tailscale (*.ts.net)
      /^https?:\/\/[a-z0-9-]+\.trycloudflare\.com(:\d+)?$/, // Cloudflare tunnel
      /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,     // LAN 192.168.x.x
      /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,  // LAN 10.x.x.x
      /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/, // LAN 172.16-31.x.x
  ];
  function isAllowedOrigin(origin: string): boolean {
      if (localhostOrigins.has(origin)) return true;
      return dynamicOriginPatterns.some(re => re.test(origin));
  }
  app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && isAllowedOrigin(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
      next();
  });

  // ── Login routes (no auth required) ──────────────────────────
  app.get('/login', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(getLoginHTML());
  });

  app.post('/api/login', rateLimit(60000, 5), (req, res) => {
    const cfg = loadConfig();
    const auth = cfg.gateway.auth;
    if (!auth || auth.mode === 'none') {
      res.json({ token: 'noauth' });
      return;
    }
    const { password } = req.body as { password?: string };
    let valid = false;
    if (auth.mode === 'password' && auth.password && password && safeCompare(password, auth.password)) valid = true;
    if (auth.mode === 'token' && auth.token && password && safeCompare(password, auth.token)) valid = true;
    if (!valid) { res.status(401).json({ error: 'Invalid password' }); return; }
    const token = randomBytes(32).toString('hex');
    authTokens.set(token, { createdAt: Date.now(), userId: `user-${token.slice(0, 8)}` });
    saveAuthTokens();
    res.json({ token });
  });

  // ── Prometheus /metrics (no auth — standard scrape path) ────
  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(serializePrometheus());
  });

  // ── Auth middleware (API routes only) ────────────────────────
  // HTML pages (/ and /login) are always served — the JS handles
  // the redirect to /login if localStorage has no token.
  // Only /api/* routes require a valid token.
  app.use('/api', (req, res, next) => {
    const cfg = loadConfig();
    const auth = cfg.gateway.auth;
    if (!auth || auth.mode === 'none') { next(); return; }
    // Token mode with no token configured = auth not set up, allow access
    if (auth.mode === 'token' && !auth.token) { next(); return; }
    // Skip public endpoints (login, messenger webhook, twilio webhooks)
    if (req.path === '/login') { next(); return; }
    if (req.path === '/messenger/webhook') { next(); return; }
    if (req.path.startsWith('/twilio/')) { next(); return; }
    if (req.path === '/telephony/dograh/inbound') { next(); return; }
    // v6.5 — LINE & Lark inbound webhooks come from external platforms without
    // TITAN's token; they authenticate via their own platform signature/challenge.
    if (req.path === '/channels/line/webhook') { next(); return; }
    if (req.path === '/channels/lark/webhook') { next(); return; }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string);
    if (isValidToken(token, cfg)) { next(); return; }
    res.status(401).json({ error: 'Unauthorized' });
  });

  // ── Command Post availability guard ──────────────────────────
  app.use('/api/command-post', (req, res, next) => {
    if (isCommandPostEnabled()) { next(); return; }
    if (req.method === 'GET' && req.path === '/approvals') {
      res.setHeader('X-TITAN-Command-Post', 'disabled');
      res.json([]);
      return;
    }
    res.status(503).json({ error: 'Command Post is disabled', hint: 'Enable it in titan.json: commandPost.enabled = true' });
  });

  // Legacy dashboard (kept during migration, also fallback if React UI not built)
  app.get('/legacy', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(getMissionControlHTML());
  });

  // Root route: React SPA or legacy dashboard
  app.get('/', (_req, res) => {
    if (hasReactUI && cachedIndexHtml) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(cachedIndexHtml);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.send(getMissionControlHTML());
    }
  });

  // API routes
  /**
   * v6.0 Step 13 helper — pick the drive that deviates most from its
   * baseline as the "dominant" mood. Returns a label the mascot uses for
   * its status text. Neutral when no drive deviates more than 0.1.
   */
  function pickDominantDrive(
    current: Record<string, number>,
    baseline: Record<string, number>,
  ): { drive: string; label: string; delta: number } {
    let best = { drive: 'neutral', label: 'TITAN is steady', delta: 0 };
    for (const drive of Object.keys(current)) {
      const delta = (current[drive] ?? 0) - (baseline[drive] ?? 0);
      const abs = Math.abs(delta);
      if (abs <= 0.1) continue;
      if (abs > Math.abs(best.delta)) {
        const direction = delta > 0 ? 'elevated' : 'low';
        const label = direction === 'elevated'
          ? `TITAN is ${driveAdjective(drive, true)}`
          : `TITAN is ${driveAdjective(drive, false)}`;
        best = { drive, label, delta };
      }
    }
    return best;
  }

  function driveAdjective(drive: string, elevated: boolean): string {
    const map: Record<string, [string, string]> = {
      // Soma profile (per-user moods).
      curiosity:    ['curious',     'incurious'],
      focus:        ['focused',     'unfocused'],
      fatigue:      ['tired',       'energized'],
      satisfaction: ['satisfied',   'restless'],
      frustration:  ['frustrated',  'calm'],
      // v6.0.3 — Soma organism drives (the real homeostatic layer).
      // `elevated` here means satisfaction > baseline; "low" satisfaction
      // is the side that produces visible pressure.
      purpose:      ['aligned',     'aimless'],
      hunger:       ['fed',         'hungry'],
      safety:       ['secure',      'on edge'],
      social:       ['social',      'isolated'],
    };
    const pair = map[drive];
    if (!pair) return drive;
    return elevated ? pair[0] : pair[1];
  }

  // v6.0 Step 8 — Widget runtime `titan.*` API surface.
  // These endpoints let widgets inside the iframe sandbox call back into
  // TITAN as first-class clients of the agent (not just dumb React UI).

  /**
   * GET /api/tools — list registered tool names + descriptions.
   * v4.12 shape preserved: { tools, total, count } with optional `?q=` filter.
   * v6.0 step 8 expanded by adding `parameters` per tool so widgets can
   * discover the call shape dynamically.
   */
  app.get('/api/tools', async (req, res) => {
    try {
      const { getRegisteredTools } = await import('../agent/toolRunner.js');
      const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase().trim() : '';
      const all = getRegisteredTools().map(t => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description.slice(0, 500) : '',
        parameters: t.parameters,
      }));
      const filtered = q
        ? all.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        : all;
      res.json({ tools: filtered, total: all.length, count: filtered.length });
    } catch (err) {
      res.status(500).json({ error: 'tools_unavailable', message: (err as Error).message });
    }
  });

  /**
   * POST /api/tools/run — invoke a tool by name. Widget runtime entry point
   * for `titan.tools.run(name, args)`. Subject to the same intent / approval
   * gates as the agent's own calls.
   */
  app.post('/api/tools/run', async (req, res) => {
    try {
      const { name, args } = (req.body || {}) as { name?: string; args?: Record<string, unknown> };
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'invalid_input', message: '"name" is required.' });
        return;
      }
      const { executeTool } = await import('../agent/toolRunner.js');
      const result = await executeTool({
        id: `widget-${Date.now()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args || {}) },
      });
      res.json({
        name: result.name,
        success: result.success !== false,
        content: result.content,
      });
    } catch (err) {
      res.status(500).json({ error: 'tool_run_failed', message: (err as Error).message });
    }
  });

  /**
   * GET /api/memory/:key — read a single memory value. Widget-friendly
   * minimal surface; uses the `widget` category to keep widget-scoped
   * facts separate from the agent's general memory namespace.
   */
  // v7.0 — Memory taxonomy (9 named types + live availability). MUST be registered
  // BEFORE the generic /api/memory/:key route below or it gets shadowed.
  app.get('/api/memory/taxonomy', async (_req, res) => {
    const { summarizeMemoryTaxonomy } = await import('../memory/taxonomy.js');
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    let hindsightConnected = false;
    try {
      const { memory } = await import('../memory/facade.js');
      hindsightConnected = Boolean(await memory.episodic.isCrossSessionConnected());
    } catch { /* hindsight optional */ }
    res.json(summarizeMemoryTaxonomy(cfg, { hindsightConnected }));
  });

  // v7.0 redo (move 9) — "What I know about you": one plain-language aggregate
  // of everything TITAN remembers about its user. Honest sources only: the
  // configured identity (soul), Soma's learned observations, and stored facts.
  // Registered BEFORE /api/memory/:key (route order matters — see taxonomy).
  app.get('/api/memory/about-me', async (req, res) => {
    try {
      const userId = getUserIdFromReq(req as Parameters<typeof getUserIdFromReq>[0]);
      const cfg = loadConfig();
      const { readSomaProfile } = await import('../storage/somaProfile.js');
      const profile = readSomaProfile(userId);
      const { searchMemories } = await import('../memory/memory.js');
      const facts = (await searchMemories()).slice(0, 100);
      res.json({
        identity: (cfg as { soul?: string }).soul || null,
        observations: profile.learnedAboutUser ?? [],
        workingHours: profile.workingHours ?? null,
        facts,
      });
    } catch (err) {
      res.status(500).json({ error: 'about_me_failed', message: (err as Error).message });
    }
  });

  app.get('/api/memory/:key', async (req, res) => {
    try {
      const { recallFact } = await import('../memory/memory.js');
      const value = recallFact('widget', req.params.key);
      res.json({ key: req.params.key, value: value ?? null });
    } catch (err) {
      res.status(500).json({ error: 'memory_read_failed', message: (err as Error).message });
    }
  });

  /** POST /api/memory — write a single key/value to the widget memory category. */
  app.post('/api/memory', async (req, res) => {
    try {
      const { key, value } = (req.body || {}) as { key?: string; value?: unknown };
      if (!key || typeof key !== 'string') {
        res.status(400).json({ error: 'invalid_input', message: '"key" is required.' });
        return;
      }
      const { rememberFact } = await import('../memory/memory.js');
      const v = typeof value === 'string' ? value : JSON.stringify(value);
      rememberFact('widget', key, v);
      res.json({ key, stored: true });
    } catch (err) {
      res.status(500).json({ error: 'memory_write_failed', message: (err as Error).message });
    }
  });

  /** GET /api/persona/current — convenience endpoint for `titan.persona`. */
  app.get('/api/persona/current', async (_req, res) => {
    try {
      const { getActivePersonaContent } = await import('../personas/manager.js');
      const cfg = loadConfig();
      const personaId = cfg.agent?.persona || 'default';
      const content = getActivePersonaContent(personaId);
      res.json({ content: content || null, personaId });
    } catch (err) {
      res.status(500).json({ error: 'persona_unavailable', message: (err as Error).message });
    }
  });

  // v6.0 Step 4 — Spaces REST API. The SPA's Spaces sidebar reads + writes
  // the server-side `~/.titan/spaces.json` via these endpoints. The agent's
  // canvas_spaces tools mutate the same file, so the SPA + agent agree on
  // a single source of truth regardless of which one made the change.
  app.get('/api/spaces', async (_req, res) => {
    try {
      const { readSpaces, getActiveSpace } = await import('../storage/spaces.js');
      const file = readSpaces();
      const active = getActiveSpace();
      res.json({
        spaces: file.spaces,
        activeSpaceId: active?.id ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: 'spaces_unavailable', message: (err as Error).message });
    }
  });

  app.post('/api/spaces', async (req, res) => {
    try {
      const { createSpace } = await import('../storage/spaces.js');
      const { name, icon, color, agentInstructions, starterWidgets, makeActive } = (req.body || {}) as Record<string, unknown>;
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'invalid_input', message: '"name" is required.' });
        return;
      }
      const space = createSpace({
        name: name.trim(),
        icon: typeof icon === 'string' ? icon : undefined,
        color: typeof color === 'string' ? color : undefined,
        agentInstructions: typeof agentInstructions === 'string' ? agentInstructions : undefined,
        starterWidgets: Array.isArray(starterWidgets) ? starterWidgets : undefined,
        makeActive: Boolean(makeActive),
      });
      res.json({ space });
    } catch (err) {
      res.status(500).json({ error: 'create_failed', message: (err as Error).message });
    }
  });

  app.patch('/api/spaces/:id', async (req, res) => {
    try {
      const { updateSpace } = await import('../storage/spaces.js');
      const patch = (req.body || {}) as Record<string, unknown>;
      const space = updateSpace(req.params.id, {
        name: typeof patch.name === 'string' ? patch.name : undefined,
        icon: typeof patch.icon === 'string' ? patch.icon : undefined,
        color: typeof patch.color === 'string' ? patch.color : undefined,
        agentInstructions: typeof patch.agentInstructions === 'string' ? patch.agentInstructions : undefined,
        widgets: Array.isArray(patch.widgets) ? patch.widgets : undefined,
      });
      if (!space) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ space });
    } catch (err) {
      res.status(500).json({ error: 'update_failed', message: (err as Error).message });
    }
  });

  app.post('/api/spaces/:id/activate', async (req, res) => {
    try {
      const { switchSpace } = await import('../storage/spaces.js');
      const space = switchSpace(req.params.id);
      if (!space) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ space });
    } catch (err) {
      res.status(500).json({ error: 'switch_failed', message: (err as Error).message });
    }
  });

  app.delete('/api/spaces/:id', async (req, res) => {
    try {
      const { archiveSpace } = await import('../storage/spaces.js');
      const result = archiveSpace(req.params.id);
      if (!result) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ archived: result.archived, remaining: result.remaining });
    } catch (err) {
      res.status(500).json({ error: 'archive_failed', message: (err as Error).message });
    }
  });

  app.get('/api/spaces/presets', async (_req, res) => {
    try {
      const { listStarterPresets } = await import('../storage/starterSpaces.js');
      res.json({ presets: listStarterPresets() });
    } catch (err) {
      res.status(500).json({ error: 'presets_unavailable', message: (err as Error).message });
    }
  });

  // v6.0 Step 13 — Soma drive state surface for the mascot + status bar.
  // Returns CURRENT drive levels (organism layer) + per-user BASELINE
  // (Soma profile). The SPA's mascot listens to this and renders the
  // mood-tint, breathing animation, and "TITAN is curious / focused /
  // frustrated" status-bar text.
  //
  // v6.0.3 — Previously this endpoint mapped neurotransmitter names
  // (dopamine, cortisol, norepinephrine) onto drive ids, but Soma stores
  // drives by id (curiosity, hunger, safety, social, purpose), so every
  // field always missed and the mascot read a flat baseline. Now we
  // surface the REAL drive levels — the mascot's mood actually moves.
  app.get('/api/soma/drives', async (req, res) => {
    try {
      const userId = getUserIdFromReq(req as Parameters<typeof getUserIdFromReq>[0]);
      const { readSomaProfile } = await import('../storage/somaProfile.js');
      const profile = readSomaProfile(userId);
      let current: Record<string, number> | null = null;
      let asOf: string | null = null;
      try {
        const { getHormonalState } = await import('../organism/hormones.js');
        const state = getHormonalState();
        if (state.available) {
          current = { ...state.levels };
          asOf = state.asOf;
        }
      } catch { /* organism may be off — fall back to baseline */ }
      // Build a baseline that includes every drive present in `current`
      // (the Soma drive layer ships purpose/hunger/curiosity/safety/social;
      // the per-user Soma profile stores per-drive baselines — but those
      // are keyed by feel-name, not drive-id, so we synthesise a neutral
      // 0.7 baseline for any drive id the profile doesn't cover. Without
      // this the deviation math compares hunger=0.15 to baseline=0
      // and reports an artificial delta of +0.15, instead of correctly
      // flagging hunger as low).
      const baseline: Record<string, number> = { ...profile.baseline };
      if (current) {
        for (const k of Object.keys(current)) {
          if (!(k in baseline)) baseline[k] = 0.7;
        }
      }
      res.json({
        userId,
        baseline,
        current: current ?? baseline,
        asOf,
        dominant: pickDominantDrive(current ?? baseline, baseline),
      });
    } catch (err) {
      res.status(500).json({ error: 'soma_drives_unavailable', message: (err as Error).message });
    }
  });

  // v6.0.3 — Full Soma state. Returns the latest persisted drive tick + the
  // hormonal block the SOMA page needs to render the elevated-drive line
  // ("Body state: hunger 15% · curiosity 37%") and the inspector
  // sparklines. Previously this endpoint didn't exist; the SomaView fell
  // back to /api/watch/snapshot which doesn't include the hormonal block,
  // so it always showed "All drives satiated — routine operation."
  app.get('/api/soma/state', async (_req, res) => {
    try {
      const cfg = loadConfig();
      const organismEnabled = (cfg.organism as { enabled?: boolean } | undefined)?.enabled ?? true;
      const { loadDriveHistory } = await import('../organism/drives.js');
      const { buildBlock } = await import('../organism/hormones.js');
      const history = loadDriveHistory();
      if (!history) {
        res.json({
          enabled: organismEnabled,
          message: organismEnabled
            ? 'Soma is enabled but no drive tick has run yet. Wait ~60s.'
            : 'Soma is disabled. Enable via organism.enabled in config.',
          drives: [],
          totalPressure: 0,
          dominantDrives: [],
          hormonal: { available: false, asOf: null, levels: {}, elevated: [], dominant: null },
        });
        return;
      }
      const block = buildBlock(history.latest.drives, history.latest.timestamp);
      res.json({
        enabled: organismEnabled,
        timestamp: history.latest.timestamp,
        drives: history.latest.drives,
        totalPressure: history.latest.totalPressure,
        dominantDrives: history.latest.dominantDrives,
        hormonal: block,
      });
    } catch (err) {
      res.status(500).json({ error: 'soma_state_unavailable', message: (err as Error).message });
    }
  });

  // v6.0.3 — Ring-buffered drive history. Used by the SOMA page for
  // sparklines + the "last 24h" trend graphs. `hours` query param caps
  // the slice; default 24h.
  app.get('/api/soma/history', async (req, res) => {
    try {
      const cfg = loadConfig();
      const organismEnabled = (cfg.organism as { enabled?: boolean } | undefined)?.enabled ?? true;
      const { loadDriveHistory } = await import('../organism/drives.js');
      const hours = Math.max(1, Math.min(168, parseInt(String(req.query.hours ?? '24'), 10) || 24));
      const history = loadDriveHistory();
      if (!history) {
        res.json({ enabled: organismEnabled, history: [], latest: null });
        return;
      }
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const slice = history.history.filter(p => new Date(p.timestamp).getTime() >= cutoff);
      res.json({ enabled: organismEnabled, history: slice, latest: history.latest });
    } catch (err) {
      res.status(500).json({ error: 'soma_history_unavailable', message: (err as Error).message });
    }
  });

  // v6.0.3 — Recent Soma advisories (somaInitiative pulses that didn't
  // map to 'nothing'). The canvas notification card polls this; the
  // mascot speech bubble can quote the most recent one.
  app.get('/api/soma/advisories', async (req, res) => {
    try {
      const userId = getUserIdFromReq(req as Parameters<typeof getUserIdFromReq>[0]);
      const { readRecentAdvisories } = await import('../agent/somaInitiative.js');
      const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit ?? '10'), 10) || 10));
      const advisories = readRecentAdvisories(userId, limit);
      res.json({ userId, advisories });
    } catch (err) {
      res.status(500).json({ error: 'advisories_unavailable', message: (err as Error).message });
    }
  });

  // Soma-audit fix: SomaView's setpoint/weight sliders POSTed here but the
  // routes never existed (404 into the void). The drive engine already honors
  // config.organism.{driveSetpoints,driveWeights} overrides on every tick
  // (drives.ts computeAllDrives), so these simply persist the override maps.
  app.post('/api/soma/setpoints', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const overrides: Record<string, number> = {};
      for (const [k, v] of Object.entries(body)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0 && n <= 1) overrides[k] = n;
      }
      if (Object.keys(overrides).length === 0) { res.status(400).json({ error: 'no_valid_setpoints', message: 'Provide { driveId: 0..1 }.' }); return; }
      const cfg = loadConfig();
      const organism = { ...cfg.organism, driveSetpoints: { ...(cfg.organism.driveSetpoints ?? {}), ...overrides } };
      updateConfig({ organism });
      res.json({ ok: true, driveSetpoints: organism.driveSetpoints });
    } catch (err) {
      res.status(500).json({ error: 'setpoints_failed', message: (err as Error).message });
    }
  });

  app.post('/api/soma/weights', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const overrides: Record<string, number> = {};
      for (const [k, v] of Object.entries(body)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0.1 && n <= 3.0) overrides[k] = n;
      }
      if (Object.keys(overrides).length === 0) { res.status(400).json({ error: 'no_valid_weights', message: 'Provide { driveId: 0.1..3.0 }.' }); return; }
      const cfg = loadConfig();
      const organism = { ...cfg.organism, driveWeights: { ...(cfg.organism.driveWeights ?? {}), ...overrides } };
      updateConfig({ organism });
      res.json({ ok: true, driveWeights: organism.driveWeights });
    } catch (err) {
      res.status(500).json({ error: 'weights_failed', message: (err as Error).message });
    }
  });

  // v6.0.5 — Time Travel surface. TITAN's shadow-git layer
  // (~/.titan/file-checkpoints/) already snapshots every file before any
  // write/edit/append tool runs, but pre-v6.0.5 we had no UI for it.
  // These three endpoints expose:
  //   GET  /api/time-travel/checkpoints      → newest-first list, optional ?file= filter
  //   GET  /api/time-travel/diff/:id         → diff vs current file
  //   POST /api/time-travel/restore/:id      → restore the file to that checkpoint
  app.get('/api/time-travel/checkpoints', async (req, res) => {
    try {
      const { listAllCheckpoints, listCheckpoints } = await import('../agent/shadowGit.js');
      const file = typeof req.query.file === 'string' ? req.query.file : '';
      const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100));
      const checkpoints = file ? listCheckpoints(file) : listAllCheckpoints(limit);
      res.json({ count: checkpoints.length, checkpoints });
    } catch (err) {
      res.status(500).json({ error: 'time_travel_list_failed', message: (err as Error).message });
    }
  });

  app.get('/api/time-travel/diff/:id', async (req, res) => {
    try {
      const { diffCheckpoint } = await import('../agent/shadowGit.js');
      const id = String(req.params.id || '').trim();
      if (!id) { res.status(400).json({ error: 'missing_checkpoint_id' }); return; }
      const diff = diffCheckpoint(id);
      res.json({ checkpointId: id, diff });
    } catch (err) {
      res.status(500).json({ error: 'time_travel_diff_failed', message: (err as Error).message });
    }
  });

  app.post('/api/time-travel/restore/:id', async (req, res) => {
    try {
      const { restoreCheckpoint } = await import('../agent/shadowGit.js');
      const id = String(req.params.id || '').trim();
      if (!id) { res.status(400).json({ error: 'missing_checkpoint_id' }); return; }
      const result = restoreCheckpoint(id);
      const ok = !result.toLowerCase().startsWith('restore failed') && !result.toLowerCase().startsWith('no checkpoints') && !result.toLowerCase().includes('not found');
      res.json({ ok, checkpointId: id, message: result });
    } catch (err) {
      res.status(500).json({ error: 'time_travel_restore_failed', message: (err as Error).message });
    }
  });

  // v6.0.0-beta.4 — Mission API. The "work without me" surface.
  //
  // TITAN already has a deep autonomy stack: durable journal, stateless
  // reducer, 11-phase goal driver, crash recovery, budget enforcement.
  // What was missing was an ergonomic entry point (one prompt → an
  // autonomous mission) and live visibility (what's the driver doing
  // right now? what got done overnight?). These five endpoints close that
  // gap and feed the Mission Driver + Daily Digest canvas widgets.
  //
  //   POST /api/mission/run            → single-prompt mission creation
  //   GET  /api/missions/active        → live driver state for every active goal
  //   GET  /api/missions/recent?hours= → completed goals in last N hours
  //   GET  /api/missions/digest?hours= → human-readable "what got done" summary
  //   POST /api/mission/:id/cancel     → cancel a running mission

  app.post('/api/mission/run', async (req, res) => {
    try {
      const description = String(req.body?.description ?? req.body?.prompt ?? '').trim();
      if (!description || description.length < 10) {
        res.status(400).json({ error: 'description_required', message: 'Provide a description (>=10 chars) of what TITAN should accomplish autonomously.' });
        return;
      }
      const title = String(req.body?.title ?? '').trim() || description.split(/[.!?\n]/)[0].slice(0, 80);
      const priority = Math.max(1, Math.min(5, Number(req.body?.priority) || 3));
      const budgetLimit = Math.max(0.01, Math.min(50, Number(req.body?.budgetUsd) || 2));
      const tags: string[] = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : ['mission', 'autonomous'];

      // Decompose the description into 3–6 subtasks via the LLM. Use the
      // small/fast tier — this is a one-shot planning call, not an agent
      // loop. The driver then ticks through the subtasks autonomously.
      let subtasks: Array<{ title: string; description: string; dependsOn?: string[] }> | undefined = undefined;
      try {
        const { spawnSubAgent } = await import('../agent/subAgent.js');
        const decomposePrompt = [
          `Decompose this autonomous mission into 3-6 concrete subtasks.`,
          ``,
          `Mission: ${description}`,
          ``,
          `Return STRICT JSON: { "subtasks": [ { "title": "...", "description": "...", "dependsOn": [<1-based positions of prerequisite subtasks>] }, ... ] }.`,
          `Use dependsOn to express real ordering: if a subtask needs an earlier subtask's output, list that earlier subtask's 1-based position. Independent subtasks use [].`,
          `Example: if subtask 3 needs subtasks 1 and 2 done first -> "dependsOn": [1, 2]. Only reference EARLIER positions; never a later one or itself.`,
          `Each title <= 60 chars, each description <= 200 chars.`,
          `Do NOT add a verification subtask — the driver verifies automatically.`,
          `Do NOT wrap in markdown — pure JSON.`,
        ].join('\n');
        const result = await spawnSubAgent({
          name: 'mission-decomposer',
          task: decomposePrompt,
          tier: 'fast',
          maxRounds: 1,
        });
        const { parseMissionSubtasks } = await import('../agent/missionDecompose.js');
        subtasks = parseMissionSubtasks(result.content || '');
      } catch (err) {
        logger.warn(COMPONENT, `Mission decomposition failed, creating goal with no subtasks: ${(err as Error).message}`);
      }

      const { createGoal } = await import('../agent/goals.js');
      const goal = createGoal({
        title,
        description,
        priority,
        budgetLimit,
        tags,
        subtasks,
        force: req.body?.force === true,
      });
      logger.info(COMPONENT, `[Mission] Created mission goal "${title}" (id=${goal.id}, subtasks=${(subtasks?.length ?? 0)})`);
      res.json({
        ok: true,
        goal: { id: goal.id, title: goal.title, status: goal.status, priority: goal.priority, subtaskCount: goal.subtasks?.length ?? 0 },
        message: subtasks?.length
          ? `Mission "${title}" created with ${subtasks.length} subtasks. Driver will pick it up on the next tick (within 10s).`
          : `Mission "${title}" created. Decomposition skipped — add subtasks via the Goals API or chat.`,
      });
    } catch (err) {
      res.status(500).json({ error: 'mission_create_failed', message: (err as Error).message });
    }
  });

  app.get('/api/missions/active', async (_req, res) => {
    try {
      const { listActiveDrivers } = await import('../agent/goalDriver.js');
      const { listGoals } = await import('../agent/goals.js');
      const drivers = listActiveDrivers();
      const goals = listGoals('active');
      const goalsById = new Map(goals.map(g => [g.id, g]));
      const missions = drivers.map(d => {
        const goal = goalsById.get(d.goalId);
        const completed = Object.values(d.subtaskStates).filter(s => s.verificationResult?.passed === true).length;
        const total = Object.keys(d.subtaskStates).length || (goal?.subtasks?.length ?? 0);
        return {
          goalId: d.goalId,
          title: goal?.title || '(unknown goal)',
          phase: d.phase,
          startedAt: d.startedAt,
          currentSubtaskId: d.currentSubtaskId ?? null,
          subtasks: { total, completed },
          budget: d.budget,
          blockedReason: d.blockedReason ?? null,
          lastHistory: (d.history || []).slice(-3),
        };
      });
      res.json({ count: missions.length, missions });
    } catch (err) {
      res.status(500).json({ error: 'missions_active_failed', message: (err as Error).message });
    }
  });

  app.get('/api/missions/recent', async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(String(req.query.hours ?? '24'), 10) || 24));
      const { listAllDrivers } = await import('../agent/goalDriver.js');
      const { listGoals } = await import('../agent/goals.js');
      const all = listAllDrivers();
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const goalsById = new Map(listGoals().map(g => [g.id, g]));
      const recent = all
        .filter(d => ['done', 'failed', 'cancelled'].includes(d.phase))
        .filter(d => {
          const completedAt = d.history?.[d.history.length - 1]?.at ?? d.startedAt;
          return new Date(completedAt).getTime() >= cutoff;
        })
        .map(d => {
          const goal = goalsById.get(d.goalId);
          const completedAt = d.history?.[d.history.length - 1]?.at ?? d.startedAt;
          return {
            goalId: d.goalId,
            title: goal?.title || '(unknown goal)',
            phase: d.phase as 'done' | 'failed' | 'cancelled',
            startedAt: d.startedAt,
            completedAt,
            durationMs: new Date(completedAt).getTime() - new Date(d.startedAt).getTime(),
            subtaskCount: Object.keys(d.subtaskStates).length || (goal?.subtasks?.length ?? 0),
            budget: d.budget,
            lessonsLearned: d.retrospective?.lessonsLearned ?? [],
          };
        })
        .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
      res.json({ hours, count: recent.length, missions: recent });
    } catch (err) {
      res.status(500).json({ error: 'missions_recent_failed', message: (err as Error).message });
    }
  });

  app.get('/api/missions/digest', async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(String(req.query.hours ?? '24'), 10) || 24));
      const { listAllDrivers, listActiveDrivers } = await import('../agent/goalDriver.js');
      const { listGoals } = await import('../agent/goals.js');
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const all = listAllDrivers();
      const active = listActiveDrivers();
      const goalsById = new Map(listGoals().map(g => [g.id, g]));
      const completed = all.filter(d => d.phase === 'done').filter(d => {
        const at = d.history?.[d.history.length - 1]?.at ?? d.startedAt;
        return new Date(at).getTime() >= cutoff;
      });
      const failed = all.filter(d => d.phase === 'failed').filter(d => {
        const at = d.history?.[d.history.length - 1]?.at ?? d.startedAt;
        return new Date(at).getTime() >= cutoff;
      });
      const blocked = active.filter(d => d.phase === 'blocked');
      const totalCostUsd = [...completed, ...failed].reduce((sum, d) => sum + (d.budget?.costUsd ?? 0), 0);
      const totalTokens = [...completed, ...failed].reduce((sum, d) => sum + (d.budget?.tokensUsed ?? 0), 0);
      const lessons = completed.flatMap(d => d.retrospective?.lessonsLearned ?? []).slice(0, 10);

      const summary: string[] = [];
      summary.push(`Last ${hours}h: ${completed.length} mission(s) completed, ${failed.length} failed, ${active.length} active, ${blocked.length} blocked for approval.`);
      if (completed.length > 0) {
        summary.push(``);
        summary.push(`Completed:`);
        for (const d of completed.slice(0, 10)) {
          const g = goalsById.get(d.goalId);
          summary.push(`  • ${g?.title ?? d.goalId} (${Math.round((d.budget?.costUsd ?? 0) * 100) / 100} USD, ${Math.round(((d.history?.[d.history.length - 1]?.at ? new Date(d.history[d.history.length - 1].at).getTime() : Date.now()) - new Date(d.startedAt).getTime()) / 1000)}s)`);
        }
      }
      if (failed.length > 0) {
        summary.push(``);
        summary.push(`Failed (need review):`);
        for (const d of failed.slice(0, 5)) {
          const g = goalsById.get(d.goalId);
          summary.push(`  • ${g?.title ?? d.goalId}`);
        }
      }
      if (blocked.length > 0) {
        summary.push(``);
        summary.push(`Blocked for approval:`);
        for (const d of blocked.slice(0, 5)) {
          const g = goalsById.get(d.goalId);
          summary.push(`  • ${g?.title ?? d.goalId} — ${d.blockedReason?.question ?? '(no reason given)'}`);
        }
      }
      if (active.length > 0 && blocked.length < active.length) {
        summary.push(``);
        summary.push(`In progress:`);
        for (const d of active.filter(a => a.phase !== 'blocked').slice(0, 10)) {
          const g = goalsById.get(d.goalId);
          summary.push(`  • ${g?.title ?? d.goalId} [${d.phase}]`);
        }
      }

      res.json({
        hours,
        stats: {
          completed: completed.length,
          failed: failed.length,
          active: active.length,
          blocked: blocked.length,
          totalCostUsd: Math.round(totalCostUsd * 1000) / 1000,
          totalTokens,
        },
        summaryText: summary.join('\n'),
        recentLessons: lessons,
      });
    } catch (err) {
      res.status(500).json({ error: 'mission_digest_failed', message: (err as Error).message });
    }
  });

  app.get('/api/mission/:id', async (req, res) => {
    try {
      const goalId = String(req.params.id || '').trim();
      if (!goalId) { res.status(400).json({ error: 'missing_goal_id' }); return; }
      const { getGoal } = await import('../agent/goals.js');
      const { getDriverState } = await import('../agent/goalDriver.js');
      const goal = getGoal(goalId);
      if (!goal) { res.status(404).json({ error: 'goal_not_found' }); return; }
      const state = getDriverState(goalId);
      res.json({
        goal: {
          id: goal.id,
          title: goal.title,
          description: goal.description,
          status: goal.status,
          priority: goal.priority,
          progress: goal.progress,
          totalCost: goal.totalCost,
          createdAt: goal.createdAt,
          completedAt: goal.completedAt,
          tags: goal.tags ?? [],
          subtasks: (goal.subtasks ?? []).map(s => ({
            id: s.id,
            title: s.title,
            description: s.description,
            status: s.status,
            dependsOn: s.dependsOn ?? [],
            retries: s.retries,
            completedAt: s.completedAt,
          })),
        },
        driver: state ? {
          phase: state.phase,
          startedAt: state.startedAt,
          currentSubtaskId: state.currentSubtaskId ?? null,
          budget: state.budget,
          blockedReason: state.blockedReason ?? null,
          historyTail: (state.history ?? []).slice(-10),
          subtaskStates: state.subtaskStates,
        } : null,
      });
    } catch (err) {
      res.status(500).json({ error: 'mission_get_failed', message: (err as Error).message });
    }
  });

  app.post('/api/mission/:id/cancel', async (req, res) => {
    try {
      const goalId = String(req.params.id || '').trim();
      if (!goalId) { res.status(400).json({ error: 'missing_goal_id' }); return; }
      const { getDriverState } = await import('../agent/goalDriver.js');
      const { updateGoal } = await import('../agent/goals.js');
      const state = getDriverState(goalId);
      if (state) {
        state.userControls.cancelRequested = true;
        // The driver will observe this on its next tick and transition.
      }
      updateGoal(goalId, { status: 'paused' });
      res.json({ ok: true, message: `Mission ${goalId} marked for cancellation. Driver will stop on the next tick.` });
    } catch (err) {
      res.status(500).json({ error: 'mission_cancel_failed', message: (err as Error).message });
    }
  });

  // v6.0.3 — Manual trigger for the daily-gift loop. The 22h cron path
  // still fires on its own; this endpoint lets the user click "send me
  // something now" in the SOMA panel and see what Soma comes up with
  // without waiting a day. We bypass the 18h cooldown by passing a
  // `force` flag (the gift module respects this).
  app.post('/api/soma/gift', async (req, res) => {
    try {
      const userId = getUserIdFromReq(req as Parameters<typeof getUserIdFromReq>[0]);
      const force = req.body?.force !== false;
      const { tryDailyGift } = await import('../agent/somaInitiative.js');
      // Fire-and-forget — the LLM call inside can take 20-60s; we don't
      // want the HTTP request to block that long. The result lands as a
      // create_widget side-channel event on the user's open SSE stream.
      void tryDailyGift(userId, { force }).then(result => {
        logger.info(COMPONENT, `[SomaGift] manual trigger: attempted=${result.attempted} reason=${result.reason}`);
      }).catch(err => {
        logger.warn(COMPONENT, `[SomaGift] manual trigger failed: ${(err as Error).message}`);
      });
      res.json({ ok: true, message: 'Soma is thinking about what to gift you. A widget will appear on your canvas shortly (or Soma will decline if nothing fits).' });
    } catch (err) {
      res.status(500).json({ error: 'gift_unavailable', message: (err as Error).message });
    }
  });

  // ── v7.0 — Security self-audit (config_audit findings) ──
  app.get('/api/security/audit', async (_req, res) => {
    const { auditConfig } = await import('../skills/builtin/config_audit.js');
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    res.json({ findings: auditConfig(cfg) });
  });

  // ── v7.0 observability — run trace store ──────────────────────────
  app.get('/api/traces', async (req, res) => {
    const { listSpans } = await import('../telemetry/traceStore.js');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const sessionId = req.query.sessionId as string | undefined;
    res.json({ spans: listSpans({ limit, sessionId }) });
  });
  app.get('/api/traces/summary', async (_req, res) => {
    const { listSpans, summarizeTraces } = await import('../telemetry/traceStore.js');
    res.json(summarizeTraces(listSpans()));
  });
  app.get('/api/traces/export', async (_req, res) => {
    const { listSpans, toOTel } = await import('../telemetry/traceStore.js');
    res.json(toOTel(listSpans({ limit: 1000 })));
  });

  app.get('/api/stats', async (_req, res) => {
    const usage = getUsageStats();
    const cfg = loadConfig();
    const activeModel = cfg.agent.model || '';
    const mem = process.memoryUsage();
    const activeAgents = listAgents().filter(a => a.status === 'running').length;
    const activeSessions = listSessions().length;

    // v6.1.0-beta.23 — real host metrics. Previously /api/stats returned
    // process memory only, so StatsWidget filled in CPU/Memory/Disk with
    // Math.random() — Tony's mock-data audit flagged it as a top
    // offender. Now we return real percentages so the UI can drop the
    // fake values entirely.
    //   - cpuPercent  : normalised 1-min load average × 100
    //   - hostMem*    : os.totalmem / freemem (whole machine, NOT process)
    //   - disk*       : statfs on TITAN's home dir (where state + models live)
    const cpuPercent = Math.round(getCpuLoad() * 1000) / 10; // 1 decimal
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const hostMemPercent = totalMem > 0
      ? Math.round((usedMem / totalMem) * 1000) / 10
      : 0;

    let diskTotalBytes = 0;
    let diskFreeBytes = 0;
    let diskPercent = 0;
    let diskError: string | null = null;
    // statfs() targets the filesystem holding TITAN_HOME, not the OS
    // home dir. On deployments that set TITAN_HOME away from the user's
    // home (e.g. /opt/TITAN, or an external models volume), the user
    // cares about how full TITAN's state filesystem is — not their
    // login home — so we point statfs at TITAN_HOME directly. Codex
    // P2 caught the wrong target on the first beta.23 review.
    try {
      const s = await statfs(TITAN_HOME);
      diskTotalBytes = s.blocks * s.bsize;
      diskFreeBytes = s.bavail * s.bsize;
      const usedDisk = diskTotalBytes - diskFreeBytes;
      diskPercent = diskTotalBytes > 0
        ? Math.round((usedDisk / diskTotalBytes) * 1000) / 10
        : 0;
    } catch (err) {
      // statfs unsupported on some filesystems / older Node — leave 0
      // and surface the error string so the UI can show "unavailable"
      // rather than 0%.
      diskError = (err as Error).message;
    }

    res.json({
      ...usage,
      version: TITAN_VERSION,
      uptime: process.uptime(),
      model: activeModel.replace(/^ollama\//, ''),
      provider: activeModel.split('/')[0] || 'ollama',
      memoryMB: Math.round(mem.rss / 1024 / 1024),
      memoryUsage: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      host: {
        cpuPercent,
        cores: cpus().length || 1,
        loadAvg1: loadavg()[0] ?? 0,
        loadAvg5: loadavg()[1] ?? 0,
        loadAvg15: loadavg()[2] ?? 0,
        memTotalBytes: totalMem,
        memFreeBytes: freeMem,
        memUsedBytes: usedMem,
        memPercent: hostMemPercent,
        diskTotalBytes,
        diskFreeBytes,
        diskUsedBytes: diskTotalBytes - diskFreeBytes,
        diskPercent,
        diskError,
      },
      health: {
        ollamaHealthy: healthState.ollamaHealthy,
        ttsHealthy: healthState.ttsHealthy,
        lastCheck: healthState.lastCheck,
        stuckDetected: healthState.stuckDetected,
        uptimeSeconds: Math.round(process.uptime()),
        memoryUsageMB: Math.round(mem.heapUsed / 1024 / 1024),
        activeLlmRequests,
        restarts: (() => { try { return getRestartStatsSync(); } catch { return null; } })(),
      },
      activeAgents,
      activeSessions,
    });
  });

  // ── Tracing API ─────────────────────────────────────────────────
  app.use('/api/traces', createTracesRouter());

  // ── Checkpoints API ────────────────────────────────────────────
  app.use('/api/checkpoints', createCheckpointsRouter());

  // ── Company API (Paperclip-style) ─────────────────────────────
  app.use('/api/companies', createCompaniesRouter());

  // ── Command Post API (Agent Governance) ───────────────────
  app.use('/api/command-post', createCommandPostRouter());

  // ── Mission Chat API (v6.1.0) ─────────────────────────────
  // Chat-style mission control. Lives alongside Command Post in this
  // release — defaults to opt-in. Will become the default in v6.2.
  app.use('/api/missions', createMissionsRouter({
    onMissionCreated: (mission) => startMissionWork(mission),
    onUserMessage: (id, content) => missionHandleUserMessage(id, content),
    onStatusChange: (id, status) => missionHandleStatusChange(id, status),
  }));
  app.use('/api/telephony', createTelephonyRouter());
  // v6.1.0-alpha.25 — on every server boot, re-attach the per-mission
  // event / approval / goal-lifecycle bridges for any mission still
  // in a non-terminal state. Without this, missions whose goal driver
  // is mid-spawn at restart time silently lose their connection to the
  // mission room (the desk shows "Working" but the artifact never
  // fills in and no agent_done message ever lands). Fire-and-log; an
  // error here must not block server startup.
  reattachMissionBridgesOnStartup().catch((err: unknown) => {
    logger.warn('Gateway', `Mission bridge re-attach on boot failed: ${(err as Error).message}`);
  });

  // ── Sessions API ──────────────────────────────────────────
  app.use('/api/sessions', createSessionsRouter(sessionAborts));

  // ── Skills API ──────────────────────────────────────────────
  app.use('/api', createTeamsRecipesRouter());
  app.use('/api', createSkillsRouter(channels));
  app.use('/api', createAdminRouter());

  // ── Soul API ──────────────────────────────────────────────────

  // ── Soul API ──────────────────────────────────────────────────
  app.get('/api/soul/wisdom', async (_req, res) => {
    try {
      const { getWisdomData } = await import('../agent/soul.js');
      res.json(getWisdomData());
    } catch { res.json({ patterns: [], mistakes: [], userPreferences: [], totalTasks: 0 }); }
  });

  app.get('/api/soul/state/:sessionId', async (req, res) => {
    try {
      const { getSoulState } = await import('../agent/soul.js');
      const state = getSoulState(req.params.sessionId);
      if (!state) { res.status(404).json({ error: 'No active soul state for session' }); return; }
      res.json(state);
    } catch { res.status(500).json({ error: 'Soul unavailable' }); }
  });

  // ── Guardrails API ─────────────────────────────────────────────
  app.get('/api/guardrails/violations', async (_req, res) => {
    try {
      const { getViolations } = await import('../agent/guardrails.js');
      const limit = parseInt(_req.query.limit as string || '50', 10);
      res.json({ violations: getViolations(limit) });
    } catch { res.json({ violations: [] }); }
  });

  // ── Alerts API ────────────────────────────────────────────────
  app.get('/api/alerts', async (_req, res) => {
    try {
      const { getAlertHistory } = await import('../agent/alerts.js');
      const limit = parseInt(_req.query.limit as string || '50', 10);
      res.json({ alerts: getAlertHistory(limit) });
    } catch { res.json({ alerts: [] }); }
  });

  // ── Dream Mode API (v5.5.17) ──────────────────────────────────
  // Three reads + one on-demand generator. The cron handles scheduled
  // generation; the POST endpoint exists so an operator can force-run the
  // pipeline mid-day without waiting for 03:30 (e.g. to demo the feature
  // or backfill after a long offline stretch).
  app.get('/api/dreams/latest', async (_req, res) => {
    try {
      const { getLatestDream } = await import('../agent/dreams.js');
      const dream = getLatestDream();
      if (!dream) { res.status(404).json({ error: 'no dreams yet' }); return; }
      res.json(dream);
    } catch (e) {
      logger.error(COMPONENT, `dreams/latest: ${(e as Error).message}`);
      res.status(500).json({ error: 'dreams unavailable' });
    }
  });

  app.get('/api/dreams', async (_req, res) => {
    try {
      const { listDreamDates } = await import('../agent/dreams.js');
      const limit = Math.min(Math.max(parseInt(String(_req.query.limit ?? '30'), 10) || 30, 1), 365);
      res.json({ dates: listDreamDates(limit) });
    } catch (e) {
      logger.error(COMPONENT, `dreams list: ${(e as Error).message}`);
      res.status(500).json({ error: 'dreams unavailable' });
    }
  });

  app.get('/api/dreams/:date', async (req, res) => {
    try {
      const { getDreamByDate } = await import('../agent/dreams.js');
      // Date param is YYYY-MM-DD; reject anything else to keep the
      // filesystem read inside DREAMS_DIR.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
        res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        return;
      }
      const dream = getDreamByDate(req.params.date);
      if (!dream) { res.status(404).json({ error: 'no dream for that date' }); return; }
      res.json(dream);
    } catch (e) {
      logger.error(COMPONENT, `dreams/:date: ${(e as Error).message}`);
      res.status(500).json({ error: 'dreams unavailable' });
    }
  });

  app.post('/api/dreams/generate', async (_req, res) => {
    try {
      const { generateDream } = await import('../agent/dreams.js');
      const dream = await generateDream();
      res.json(dream);
    } catch (e) {
      logger.error(COMPONENT, `dreams/generate: ${(e as Error).message}`);
      res.status(500).json({ error: 'dream generation failed', message: (e as Error).message });
    }
  });

  // ── Persona Profiles API (v5.5.24) ────────────────────────────
  // Note path is `/api/persona-profiles` not `/api/personas` —
  // /api/personas already returns the agency-agent persona list (a
  // separate concept from runtime persona profiles). Renamed to avoid
  // route collision discovered on first deploy of v5.5.24.
  app.get('/api/persona-profiles', async (_req, res) => {
    try {
      const cfg = loadConfig();
      const personas = cfg.personas;
      res.json({
        enabled: personas?.enabled ?? false,
        defaultPersona: personas?.defaultPersona ?? null,
        channelPins: personas?.channelPins ?? {},
        profiles: personas?.profiles ?? [],
      });
    } catch (e) {
      logger.error(COMPONENT, `persona-profiles list: ${(e as Error).message}`);
      res.status(500).json({ error: 'personas unavailable' });
    }
  });

  app.get('/api/persona-profiles/active', async (req, res) => {
    try {
      const { describeActivePersona } = await import('../agent/personaProfiles.js');
      const channel = typeof req.query.channel === 'string' ? req.query.channel : undefined;
      res.json(describeActivePersona({ channel }));
    } catch (e) {
      logger.error(COMPONENT, `persona-profiles active: ${(e as Error).message}`);
      res.status(500).json({ error: 'personas unavailable' });
    }
  });

  // ── Persona Cohorts API (v5.5.27, A/B rollout) ────────────────
  // Cohorts are runtime state — this is the operator's control surface
  // for canarying a candidate persona against a baseline. Health endpoint
  // returns per-arm stats over the rolling window so MC can render
  // sparkline cards. Auto-revert fires from the monitor cron, but manual
  // POST /:id/revert is also exposed for kill-switch use.
  app.get('/api/persona-cohorts', async (_req, res) => {
    try {
      const { listCohorts } = await import('../agent/personaRollout.js');
      res.json({ cohorts: listCohorts() });
    } catch (e) {
      logger.error(COMPONENT, `persona-cohorts list: ${(e as Error).message}`);
      res.status(500).json({ error: 'persona-cohorts unavailable' });
    }
  });

  app.post('/api/persona-cohorts', async (req, res) => {
    try {
      const { createCohort } = await import('../agent/personaRollout.js');
      const body = (req.body || {}) as { baselineId?: string; candidateId?: string; percent?: number; hashKey?: 'sessionId' | 'channel'; note?: string; id?: string };
      if (!body.baselineId || !body.candidateId || typeof body.percent !== 'number') {
        res.status(400).json({ error: 'baselineId, candidateId, and percent are required' });
        return;
      }
      const cohort = createCohort({
        baselineId: body.baselineId,
        candidateId: body.candidateId,
        percent: body.percent,
        hashKey: body.hashKey,
        note: body.note,
        id: body.id,
      });
      res.json(cohort);
    } catch (e) {
      logger.error(COMPONENT, `persona-cohorts create: ${(e as Error).message}`);
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.delete('/api/persona-cohorts/:id', async (req, res) => {
    try {
      const { deleteCohort } = await import('../agent/personaRollout.js');
      const ok = deleteCohort(req.params.id);
      if (!ok) { res.status(404).json({ error: 'cohort not found' }); return; }
      res.json({ deleted: true });
    } catch (e) {
      logger.error(COMPONENT, `persona-cohorts delete: ${(e as Error).message}`);
      res.status(500).json({ error: 'delete failed' });
    }
  });

  app.post('/api/persona-cohorts/:id/revert', async (req, res) => {
    try {
      const { revertCohort } = await import('../agent/personaRollout.js');
      const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason : 'manual revert via API';
      const cohort = revertCohort(req.params.id, reason, 'manual');
      if (!cohort) { res.status(404).json({ error: 'cohort not found' }); return; }
      res.json(cohort);
    } catch (e) {
      logger.error(COMPONENT, `persona-cohorts revert: ${(e as Error).message}`);
      res.status(500).json({ error: 'revert failed' });
    }
  });

  app.get('/api/persona-cohorts/:id/health', async (req, res) => {
    try {
      const { getCohort, evaluateCohort } = await import('../agent/personaRollout.js');
      const cohort = getCohort(req.params.id);
      if (!cohort) { res.status(404).json({ error: 'cohort not found' }); return; }
      const cfg = loadConfig();
      const rollout = (cfg.personas as { rollout?: { windowMins?: number; minSampleSize?: number; passRateMargin?: number; safetyDropThreshold?: number } } | undefined)?.rollout;
      const health = evaluateCohort(cohort, {
        windowMins: rollout?.windowMins,
        minSampleSize: rollout?.minSampleSize,
        passRateMargin: rollout?.passRateMargin,
        safetyDropThreshold: rollout?.safetyDropThreshold,
      });
      res.json({ cohort, health });
    } catch (e) {
      logger.error(COMPONENT, `persona-cohorts health: ${(e as Error).message}`);
      res.status(500).json({ error: 'health unavailable' });
    }
  });

  app.get('/api/persona-cohorts/health', async (_req, res) => {
    try {
      const { listCohorts, evaluateCohort } = await import('../agent/personaRollout.js');
      const cohorts = listCohorts();
      const cfg = loadConfig();
      const rollout = (cfg.personas as { rollout?: { windowMins?: number; minSampleSize?: number; passRateMargin?: number; safetyDropThreshold?: number } } | undefined)?.rollout;
      const out = cohorts.map(cohort => ({
        cohort,
        health: evaluateCohort(cohort, {
          windowMins: rollout?.windowMins,
          minSampleSize: rollout?.minSampleSize,
          passRateMargin: rollout?.passRateMargin,
          safetyDropThreshold: rollout?.safetyDropThreshold,
        }),
      }));
      res.json({ cohorts: out });
    } catch (e) {
      logger.error(COMPONENT, `persona-cohorts health-all: ${(e as Error).message}`);
      res.status(500).json({ error: 'health unavailable' });
    }
  });

  /**
   * beta.10 — Verification event stream.
   *
   * Server-Sent Events stream that emits every `recordVerificationEvent`
   * call (write_file readback, download_image magic-byte check, …) as
   * it happens. The Mission Canvas trust line subscribes here so the
   * pen / paper aesthetic can reflect actual artifact health rather
   * than a cosmetic indicator.
   *
   * Connection flow:
   *   1. Client sends `Accept: text/event-stream` on GET.
   *   2. Server writes recent ring buffer contents as `event: snapshot`
   *      so a late subscriber sees existing state immediately.
   *   3. Server subscribes to live events and writes each as
   *      `event: verification`.
   *   4. On disconnect we unsubscribe + close cleanly.
   *
   * Auth: protected by the same token middleware as other /api/* routes.
   * No per-user filtering — verification events are workspace-global.
   */
  app.get('/api/verification/stream', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const sseWrite = setupSSEFlush(res);
    try {
      const { recentVerificationEvents, subscribeVerification } = await import('../agent/verification.js');
      // Snapshot — replay the last 32 events so a fresh subscriber
      // sees the trust-line's current state without polling.
      const snapshot = recentVerificationEvents(32);
      sseWrite(`event: snapshot\ndata: ${JSON.stringify({ events: snapshot })}\n\n`);
      // Live subscription — each new event gets its own SSE frame.
      const unsubscribe = subscribeVerification((event) => {
        try { sseWrite(`event: verification\ndata: ${JSON.stringify(event)}\n\n`); }
        catch { /* socket likely closed — unsubscribe on cleanup below */ }
      });
      // Keep-alive heartbeat every 15s so proxies don't reap us.
      const hb = setInterval(() => {
        try { sseWrite(`event: heartbeat\ndata: ${Date.now()}\n\n`); }
        catch { /* closed */ }
      }, 15_000);
      const cleanup = () => {
        unsubscribe();
        clearInterval(hb);
        try { res.end(); } catch { /* already closed */ }
      };
      res.on('close', cleanup);
      res.on('error', cleanup);
    } catch (err) {
      logger.error(COMPONENT, `verification SSE: ${(err as Error).message}`);
      try { sseWrite(`event: error\ndata: ${JSON.stringify({ message: 'verification stream unavailable' })}\n\n`); res.end(); }
      catch { /* ok */ }
    }
  });

  app.get('/api/receipts', async (req, res) => {
    try {
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const kindParam = req.query.kind;
      let kind: ReceiptKind | ReceiptKind[] | undefined;
      if (kindParam !== undefined) {
        const rawKindParams = Array.isArray(kindParam) ? kindParam : [kindParam];
        const kinds: ReceiptKind[] = [];
        for (const rawKindParam of rawKindParams) {
          if (typeof rawKindParam !== 'string') {
            res.status(400).json({ error: 'Invalid receipt kind' });
            return;
          }
          for (const rawKind of rawKindParam.split(',')) {
            const candidate = rawKind.trim();
            if (!candidate) continue;
            if (!isReceiptKind(candidate)) {
              res.status(400).json({ error: 'Invalid receipt kind' });
              return;
            }
            kinds.push(candidate);
          }
        }
        const uniqueKinds = Array.from(new Set(kinds));
        kind = uniqueKinds.length === 0 ? undefined : (uniqueKinds.length === 1 ? uniqueKinds[0] : uniqueKinds);
      }
      const mission = typeof req.query.mission === 'string' ? req.query.mission : undefined;
      const agent = typeof req.query.agent === 'string' ? req.query.agent : undefined;
      const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 1000) : 100;
      const { readReceipts } = await import('../receipts/store.js');
      const receipts = readReceipts({ since, kind, mission, agent, limit });
      res.json({ count: receipts.length, receipts });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'receipts error' });
    }
  });

  app.get('/api/health/deep', async (_req, res) => {
    const checks: Record<string, { status: 'ok' | 'degraded' | 'down'; detail?: string }> = {};
    let overall: 'ok' | 'degraded' | 'down' = 'ok';

    // Memory subsystem
    try {
      const { getDb } = await import('../memory/memory.js');
      const db = getDb();
      checks.memory = { status: 'ok', detail: `${db.memories.length} memories, ${db.sessions.length} sessions` };
    } catch (e) {
      checks.memory = { status: 'down', detail: (e as Error).message };
      overall = 'down';
    }

    // Graph
    try {
      const { getGraphStats } = await import('../memory/graph.js');
      const stats = getGraphStats();
      checks.graph = { status: 'ok', detail: `${stats.episodeCount} episodes, ${stats.entityCount} entities` };
    } catch (e) {
      checks.graph = { status: 'down', detail: (e as Error).message };
      overall = 'down';
    }

    // Vectors
    try {
      const { isVectorSearchAvailable } = await import('../memory/vectors.js');
      checks.vectors = { status: isVectorSearchAvailable() ? 'ok' : 'degraded', detail: isVectorSearchAvailable() ? 'ready' : 'disabled or unavailable' };
      if (!isVectorSearchAvailable() && overall === 'ok') overall = 'degraded';
    } catch (e) {
      checks.vectors = { status: 'down', detail: (e as Error).message };
      overall = 'down';
    }

    // Providers
    try {
      const providerHealth = await healthCheckAll();
      const entries = Object.entries(providerHealth);
      const healthyProviders = entries.filter(([, healthy]) => healthy).length;
      checks.providers = { status: healthyProviders > 0 ? 'ok' : 'down', detail: `${healthyProviders}/${entries.length} healthy` };
      if (healthyProviders === 0) overall = 'down';
    } catch (e) {
      checks.providers = { status: 'down', detail: (e as Error).message };
      overall = 'down';
    }

    // Channels
    try {
      const connected = Array.from(channels.values()).filter((c) => c.getStatus().connected).length;
      checks.channels = { status: connected > 0 ? 'ok' : 'degraded', detail: `${connected}/${channels.size} connected` };
      if (connected === 0 && overall === 'ok') overall = 'degraded';
    } catch (e) {
      checks.channels = { status: 'down', detail: (e as Error).message };
      overall = 'down';
    }

    // Event loop lag (approximate via setImmediate)
    const start = process.hrtime.bigint();
    await new Promise((resolve) => setImmediate(resolve));
    const lagNs = Number(process.hrtime.bigint() - start);
    const lagMs = lagNs / 1_000_000;
    checks.eventLoop = { status: lagMs < 100 ? 'ok' : lagMs < 500 ? 'degraded' : 'down', detail: `${lagMs.toFixed(2)}ms lag` };
    if (lagMs >= 500) overall = 'down';
    else if (lagMs >= 100 && overall === 'ok') overall = 'degraded';

    res.status(overall === 'ok' ? 200 : overall === 'degraded' ? 200 : 503).json({
      status: overall,
      version: TITAN_VERSION,
      uptime: process.uptime(),
      checks,
    });
  });

  // ── Monitors API ─────────────────────────────────────────────────
  app.get('/api/monitors', (_req, res) => {
    try {
      res.json({ monitors: listMonitors(), events: getMonitorEvents().slice(-50) });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  app.post('/api/monitors', (req, res) => {
    try {
      const { name, prompt, triggerType, intervalMinutes } = req.body;
      if (!name || !prompt) { res.status(400).json({ error: 'name and prompt are required' }); return; }
      const monitor = addMonitor({ name, prompt, triggerType: triggerType || 'interval', intervalMinutes: intervalMinutes || 60 } as any);
      res.status(201).json(monitor);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  app.delete('/api/monitors/:id', (req, res) => {
    try {
      removeMonitor(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });


  app.use('/api', createTestsRouter());
  app.use('/api', createHardwareRouter(broadcast));
  app.use('/api', createMetricsRouter());
  app.use('/api', createMcpRouter());
  app.use('/api', createAgentsRouter());

  // Agent message endpoint (uses multi-agent routing)
  // Supports SSE streaming when Accept: text/event-stream header is present
  app.post('/api/message', rateLimit(defaultRateLimitWindowMs, defaultRateLimitMax), concurrencyGuard(MAX_CONCURRENT_MESSAGES), async (req, res) => {
    // v5.5.28 FIX: accept either {content} (canonical) or {message} (legacy
    // shape used by community SDKs / older clients). Previously rejected
    // {message} with 400. The body destructuring uses `content` internally
    // either way.
    const body = (req.body || {}) as Record<string, unknown>;
    const content = (typeof body.content === 'string' && body.content) || (typeof body.message === 'string' && body.message) || '';
    const { channel: rawChannel, userId = 'api-user', agentId, sessionId: requestedSessionId, model: requestedModel, systemPromptAppendix } = body as { channel?: string; userId?: string; agentId?: string; sessionId?: string; model?: string; systemPromptAppendix?: string };
    // Default channel to 'webchat' for browser-based Mission Control clients.
    // This enables the interactive plan approval flow (show plan → user approves/denies).
    // Programmatic API callers can explicitly pass channel: 'api' to auto-approve plans.
    const channel = rawChannel || (req.headers.accept === 'text/event-stream' ? 'webchat' : 'api');
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content (or message) must be a non-empty string' });
      return;
    }

    // v5.5.30 FIX: validate `model` early so a bad provider ID returns 400
    // before the agent loop runs. Previously a typoed provider crashed
    // deep inside processMessage with 500 + stack trace AFTER the prompt
    // had been built — wasted work and a confusing error for the caller.
    if (requestedModel && typeof requestedModel === 'string') {
      const { tryResolveModel, getKnownProviderNames } = await import('../providers/router.js');
      if (!tryResolveModel(requestedModel)) {
        const providers = getKnownProviderNames();
        const requestedProviderName = requestedModel.split('/')[0] || requestedModel;
        // Naive "did you mean" — find providers whose name shares a prefix
        const lc = requestedProviderName.toLowerCase();
        const suggestions = providers.filter(p => p.startsWith(lc.slice(0, 3)) || lc.includes(p)).slice(0, 5);
        res.status(400).json({
          error: 'unknown_model',
          message: `Unknown model "${requestedModel}". Provider "${requestedProviderName}" is not registered.`,
          suggestions: suggestions.length > 0 ? suggestions.map(p => `${p}/...`) : undefined,
          availableProviders: providers,
        });
        return;
      }
    }

    const safeUserId = channel === 'api' ? 'api-user' : (userId || 'api-user');

    // ═─ System Widget Shortcut (v6.0 — TIGHTENED + Bucket-C-aware) ─═══
    // Fast-path: when the user is EXPLICITLY asking to add a known system
    // widget — "add the cron widget", "open the VRAM dashboard", "pin the
    // training panel" — bypass the LLM and emit the _____widget gate
    // directly. Faster + deterministic for unambiguous asks.
    //
    // ## History
    //
    // - v5.5.28 fix: gated the shortcut on `hasExplicitWidgetIntent` (the
    //   message must mention a widget-noun). Helped, but still too loose.
    //   Words like "tools" or "panel" appear in normal English ("the
    //   fb_post tool", "control panel") and would flip the gate to true,
    //   then any inner trigger like "backup" or "training" would hijack
    //   the prompt.
    //
    // - v6.0 fix (now): **require an IMPERATIVE verb + widget noun
    //   together**, NOT just one of them. The whole point of v6.0 is
    //   "generation-first" — TITAN builds custom widgets on demand,
    //   doesn't shove users into a pre-built shortcut. The shortcut now
    //   only fires for true imperative asks. Also drops 'tools' and
    //   'monitor' from the noun list (both too noisy). Also drops the
    //   killed-Bucket-C panels (paperclip).
    //
    // Test coverage: tests/unit/widget-shortcut-hijack.test.ts
    const imperativeRe = /\b(?:add|open|show|pin|create|launch|put|give\s+me|i\s+want|let'?s\s+see|i\s+need)\b/i;
    const widgetNounRe = /\b(?:widget|panel|dashboard|hub|gallery|kitchen|scheduler)\b/i;
    const hasExplicitWidgetIntent = imperativeRe.test(content) && widgetNounRe.test(content);
    const systemWidgetShortcuts: Array<{ pattern: RegExp; source: string; name: string; w: number; h: number }> = [
        { pattern: /\b(?:backups?|snapshots?|archives?)\b/i, source: 'system:backup', name: 'Backup Manager', w: 6, h: 6 },
        { pattern: /\b(?:training|train|specialists?|models?)\b/i, source: 'system:training', name: 'Training Dashboard', w: 6, h: 6 },
        { pattern: /\b(?:recipes?|playbooks?|workflows?|jarvis)\b/i, source: 'system:recipes', name: 'Recipe Kitchen', w: 6, h: 6 },
        { pattern: /\b(?:vram|gpu|nvidia)\b/i, source: 'system:vram', name: 'VRAM Monitor', w: 6, h: 6 },
        { pattern: /\b(?:teams?|members?|roles?|permissions?|rbac)\b/i, source: 'system:teams', name: 'Team Hub', w: 6, h: 6 },
        { pattern: /\b(?:cron|schedules?|jobs?|timers?)\b/i, source: 'system:cron', name: 'Cron Scheduler', w: 6, h: 6 },
        { pattern: /\b(?:checkpoints?|restores?|save state)\b/i, source: 'system:checkpoints', name: 'Checkpoints', w: 6, h: 5 },
        { pattern: /\b(?:organism|guardrails?)\b/i, source: 'system:organism', name: 'Organism Monitor', w: 6, h: 6 },
        { pattern: /\b(?:fleet|nodes?|routes?|mesh)\b/i, source: 'system:fleet', name: 'Fleet Router', w: 6, h: 5 },
        { pattern: /\b(?:captcha|form fill|web automation)\b/i, source: 'system:browser', name: 'Browser Tools', w: 6, h: 5 },
        // v6.0 step 1 — system:paperclip removed (Bucket C / killed branding).
        { pattern: /\b(?:tests?|flaky|failing|coverage|eval)\b/i, source: 'system:eval', name: 'Test Lab', w: 6, h: 6 },
    ];
    const matchedShortcut = hasExplicitWidgetIntent
        ? systemWidgetShortcuts.find(s => s.pattern.test(content))
        : null;
    if (matchedShortcut) {
        const gateText = `_____widget\n{ "name": "${matchedShortcut.name}", "format": "system", "source": "${matchedShortcut.source}", "w": ${matchedShortcut.w}, "h": ${matchedShortcut.h} }`;
        const responseText = `Added the **${matchedShortcut.name}** widget to your canvas.`;
        titanRequestsTotal.increment({ channel, status: 'ok' });
        if (req.headers.accept === 'text/event-stream') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.flushHeaders();
            const sseWrite = setupSSEFlush(res);
            sseWrite(`event: token\ndata: ${JSON.stringify({ text: responseText })}\n\n`);
            sseWrite(`event: token\ndata: ${JSON.stringify({ text: '\n\n' + gateText })}\n\n`);
            sseWrite(`event: done\ndata: ${JSON.stringify({ content: responseText + '\n\n' + gateText, sessionId: requestedSessionId || null, durationMs: 0, toolsUsed: [] })}\n\n`);
            res.end();
        } else {
            res.json({ content: responseText + '\n\n' + gateText, sessionId: requestedSessionId || null, toolsUsed: [], model: 'system', durationMs: 0 });
        }
        return;
    }

    const startTime = process.hrtime.bigint();
    const wantsSSE = req.headers.accept === 'text/event-stream';

    // Validate session ID format (prevent injection)
    if (requestedSessionId && !/^[a-zA-Z0-9_:-]{1,128}$/.test(requestedSessionId)) {
      res.status(400).json({ error: 'Invalid session ID format' });
      return;
    }

    // Set up abort controller for this request
    const abortController = new AbortController();
    if (requestedSessionId) {
      sessionAborts.set(requestedSessionId, abortController);
      sessionAbortTimes.set(requestedSessionId, Date.now());
      // S3: Track session ownership
      if (!sessionOwners.has(requestedSessionId)) {
        sessionOwners.set(requestedSessionId, getUserIdFromReq(req));
      }
    }

    // Check slash commands first (same as handleInboundMessage)
    try {
      const slashResult = await handleSlashCommand(content, channel, userId);
      if (slashResult) {
        titanRequestsTotal.increment({ channel, status: 'ok' });
        const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
        titanRequestDuration.observe(durationSec, { channel });
        if (wantsSSE) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
          const sseWrite = setupSSEFlush(res);
          sseWrite(`event: done\ndata: ${JSON.stringify({ content: slashResult.response, sessionId: null, durationMs: 0 })}\n\n`);
          res.end();
        } else {
          res.json({ content: slashResult.response, sessionId: null, toolsUsed: [], model: 'system' });
        }
        return;
      }
    } catch { /* fall through to routeMessage */ }

    // ── Auto-detect credentials in user messages ──────────────────────
    // If the user pastes a Home Assistant URL + JWT token, save them automatically
    // before the LLM even sees the message (prevents hallucination / tool-skip).
    try {
      const haKeywords = /home\s*assistant|homeassistant|\bha\b\s*(token|url|key|setup|connect)/i;
      const jwtPattern = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
      const urlPattern = /https?:\/\/[^\s,'"]+/i;
      if (haKeywords.test(content) && (jwtPattern.test(content) || urlPattern.test(content))) {
        const jwtMatch = content.match(jwtPattern);
        const urlMatch = content.match(urlPattern);
        const cfg = loadConfig();
        let saved = false;
        if (jwtMatch && (!cfg.homeAssistant?.token || cfg.homeAssistant.token !== jwtMatch[0])) {
          // Security: store in config but log a warning about plaintext storage
          cfg.homeAssistant.token = jwtMatch[0];
          saved = true;
          logger.warn(COMPONENT, '[Security] Home Assistant token auto-saved to config. Consider using the vault for credential storage.');
        }
        if (urlMatch && urlMatch[0].match(/:\d{4}/) && (!cfg.homeAssistant?.url || cfg.homeAssistant.url !== urlMatch[0].replace(/\/+$/, ''))) {
          cfg.homeAssistant.url = urlMatch[0].replace(/\/+$/, '');
          saved = true;
        }
        if (saved) {
          updateConfig({ homeAssistant: cfg.homeAssistant });
          logger.info('Gateway', 'Auto-saved Home Assistant credentials from user message');
        }
      }
    } catch { /* non-critical — let the LLM handle it */ }

    // Concurrent LLM request limit (auto-tuned to 2 on CPU-only systems)
    const maxConcurrent = maxConcurrentOverride ?? (loadConfig().security.maxConcurrentTasks || 5);
    if (activeLlmRequests >= maxConcurrent) {
      titanRequestsTotal.increment({ channel, status: 'busy' });
      titanErrorsTotal.increment({ type: 'busy' });
      if (wantsSSE) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        const sseWrite = setupSSEFlush(res);
        sseWrite(`event: done\ndata: ${JSON.stringify({ error: 'Server busy' })}\n\n`);
        res.end();
      } else {
        res.status(503).json({ error: 'Server busy — too many concurrent requests. Try again shortly.' });
      }
      return;
    }
    activeLlmRequests++;
    titanActiveSessions.inc();
    // Track client disconnect to avoid writing to dead connections
    let clientDisconnected = false;
    let sseWrite: ((data: string) => void) | null = null;
    // Hoisted so the `finally` block can release the widget side-channel
    // subscription whether the request streamed, errored, or finished early.
    let unsubscribeWidgets: (() => void) | null = null;
    // v6.0.2 — SSE keep-alive heartbeat. Cloud models (e.g. deepseek-v4-pro)
    // can spend 60-180s in a single non-streaming `think` phase. The frontend
    // (ui/src/api/client.ts) treats >60s of total silence as a dead stream
    // and aborts. SSE comment lines (`:<text>\n\n`) reset the client read
    // timer without affecting event parsing. Emit one every 15s for the
    // lifetime of the stream so long thinks no longer trigger phantom
    // "stream went silent" errors.
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    try {
      if (wantsSSE) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        req.on('close', () => {
          clientDisconnected = true;
          // Abort the in-progress LLM call so we don't keep streaming to a gone client.
          abortController.abort('client disconnected');
        });

        sseWrite = setupSSEFlush(res);
        const safeWrite = (data: string) => {
          if (clientDisconnected) return;
          try { sseWrite!(data); } catch { clientDisconnected = true; }
        };

        // Fire the first heartbeat immediately + every 15s thereafter. Stays
        // under the client's 60s quiet ceiling with plenty of headroom even
        // if one heartbeat is delayed by event-loop pressure.
        heartbeatInterval = setInterval(() => {
          if (clientDisconnected) return;
          safeWrite(`: heartbeat ${Date.now()}\n\n`);
        }, 15_000);

        // Canvas widget side-channel — subscribe to the per-session widget
        // bus for the duration of this stream and forward events as their
        // own SSE event type. Released in the finally block below so we
        // never leak listeners. See src/agent/widgetEmitter.ts.
        if (requestedSessionId) {
          try {
            const { subscribe: subscribeWidgets } = await import('../agent/widgetEmitter.js');
            unsubscribeWidgets = subscribeWidgets(requestedSessionId, (evt) => {
              safeWrite(`event: widget\ndata: ${JSON.stringify({ mode: evt.mode, widget: evt.widget, timestamp: evt.timestamp })}\n\n`);
            });
          } catch (err) {
            logger.warn(COMPONENT, `widgetEmitter subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const response = await routeMessage(content, channel, safeUserId, {
          streamCallbacks: {
            onToken: (token: string) => {
              safeWrite(`event: token\ndata: ${JSON.stringify({ text: token })}\n\n`);
            },
            onToolCall: (name: string, args: Record<string, unknown>) => {
              safeWrite(`event: tool_call\ndata: ${JSON.stringify({ name, args, timestamp: Date.now() })}\n\n`);
            },
            onToolResult: (name: string, result: string, durationMs: number, success: boolean, diff?: string) => {
              safeWrite(`event: tool_end\ndata: ${JSON.stringify({ name, result: result.slice(0, 500), durationMs, success, diff, timestamp: Date.now() })}\n\n`);
            },
            onThinking: () => {
              safeWrite(`event: thinking\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
            },
            onRound: (round: number, maxRounds: number) => {
              safeWrite(`event: round\ndata: ${JSON.stringify({ round, maxRounds, timestamp: Date.now() })}\n\n`);
            },
            // Dedicated `retry` SSE event so the UI can show a status indicator.
            // Pre-fix the router yielded retry banners as `text` chunks which
            // ended up in the user-visible message; this isolates the signal.
            onRetry: (info) => {
              safeWrite(`event: retry\ndata: ${JSON.stringify({ ...info, timestamp: Date.now() })}\n\n`);
            },
            onFailover: (info) => {
              safeWrite(`event: failover\ndata: ${JSON.stringify({ ...info, timestamp: Date.now() })}\n\n`);
            },
            // onWidget is wired through the widgetEmitter subscription above
            // rather than through this callback bag, because the tool that
            // fires it (create_widget) runs in toolRunner.ts and has its own
            // direct path to the per-session bus.
          },
          overrideAgentId: agentId,
          signal: abortController.signal,
          sessionId: requestedSessionId,
          modelOverride: requestedModel,
          systemPromptAppendix: typeof systemPromptAppendix === 'string' ? systemPromptAppendix : undefined,
        });
        titanRequestsTotal.increment({ channel, status: 'ok' });
        if (response.toolsUsed) {
          for (const tool of response.toolsUsed) titanToolCallsTotal.increment({ tool });
        }
        if (response.tokenUsage) {
          if (response.tokenUsage.prompt) titanTokensTotal.increment({ type: 'prompt' }, response.tokenUsage.prompt);
          if (response.tokenUsage.completion) titanTokensTotal.increment({ type: 'completion' }, response.tokenUsage.completion);
        }
        if (response.model) titanModelRequestsTotal.increment({ model: response.model, provider: 'default' });
        trackUsage(response.model || 'unknown', response.tokenUsage, response.durationMs || 0, response.sessionId || '');
        // Hunt Finding #11: sanitize SSE response content as well
        try {
          const { sanitizeOutbound } = await import('../utils/outboundSanitizer.js');
          const sanitized = sanitizeOutbound(
            response.content || '',
            'api_message_sse',
            "I'm TITAN — I can run commands, edit files, search the web, remember things, and more. What would you like me to help with?",
          );
          if (sanitized.hadIssues) {
            logger.warn(COMPONENT, `[OutboundGuard] SSE /api/message response sanitized: ${sanitized.issues.join(', ')}`);
            response.content = sanitized.text;
          }
        } catch { /* sanitizer unavailable */ }
        if (!clientDisconnected) {
          safeWrite(`event: done\ndata: ${JSON.stringify({ content: response.content, sessionId: response.sessionId, durationMs: response.durationMs, model: response.model, toolsUsed: response.toolsUsed, pendingApproval: response.pendingApproval })}\n\n`);
          try { res.end(); } catch { /* client gone */ }
        }
      } else {
        const response = await routeMessage(content, channel, safeUserId, {
          overrideAgentId: agentId,
          signal: abortController.signal,
          sessionId: requestedSessionId,
          modelOverride: requestedModel,
          systemPromptAppendix: typeof systemPromptAppendix === 'string' ? systemPromptAppendix : undefined,
        });
        titanRequestsTotal.increment({ channel, status: 'ok' });
        if (response.toolsUsed) {
          for (const tool of response.toolsUsed) titanToolCallsTotal.increment({ tool });
        }
        if (response.tokenUsage) {
          if (response.tokenUsage.prompt) titanTokensTotal.increment({ type: 'prompt' }, response.tokenUsage.prompt);
          if (response.tokenUsage.completion) titanTokensTotal.increment({ type: 'completion' }, response.tokenUsage.completion);
        }
        if (response.model) titanModelRequestsTotal.increment({ model: response.model, provider: 'default' });
        trackUsage(response.model || 'unknown', response.tokenUsage, response.durationMs || 0, response.sessionId || '');
        // Hunt Finding #11 (2026-04-14): sanitize outbound content before returning
        // to user. Catches system prompt leaks, instruction echoes, tool artifacts.
        // Defense-in-depth: the system prompt tells the model not to leak, but if the
        // model ignores that, this catches it.
        try {
          const { sanitizeOutbound } = await import('../utils/outboundSanitizer.js');
          const sanitized = sanitizeOutbound(
            response.content || '',
            'api_message',
            "I'm TITAN — I can run commands, edit files, search the web, remember things, and more. What would you like me to help with?",
          );
          if (sanitized.hadIssues) {
            logger.warn(COMPONENT, `[OutboundGuard] /api/message response sanitized: ${sanitized.issues.join(', ')}`);
            response.content = sanitized.text;
          }
        } catch { /* sanitizer unavailable — non-critical */ }
        res.json(response);
      }
    } catch (error) {
      titanRequestsTotal.increment({ channel, status: 'error' });
      titanErrorsTotal.increment({ type: 'request' });
      // Capture a structured bug report for the operator + agent team to
      // review. Best-effort — never gates the user-facing error path.
      try {
        const { captureBugReport } = await import('../analytics/bugReports.js');
        await captureBugReport(error, {
          origin: 'gateway./api/message',
          channel,
          sessionId: requestedSessionId,
          model: typeof requestedModel === 'string' ? requestedModel : undefined,
          lastUserMessage: typeof content === 'string' ? content : undefined,
          turnNumber: undefined,
        });
      } catch { /* never let bug capture break the request path */ }
      // Classify the error so the UI can render an actionable banner instead of a stack trace
      const structured = classifyChatError(error as Error);
      if (wantsSSE && !clientDisconnected && sseWrite) {
        try { sseWrite(`event: done\ndata: ${JSON.stringify(structured)}\n\n`); res.end(); } catch { /* client gone */ }
      } else if (!wantsSSE) {
        res.status(structured.status).json(structured);
      }
    } finally {
      activeLlmRequests--;
      titanActiveSessions.dec();
      const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
      titanRequestDuration.observe(durationSec, { channel });
      if (requestedSessionId) sessionAborts.delete(requestedSessionId);
      // Release the canvas-widget side-channel subscription (if any) so the
      // emitter doesn't accumulate dead listeners across long-lived servers.
      if (unsubscribeWidgets) {
        try { unsubscribeWidgets(); } catch { /* never let cleanup break the request */ }
      }
      // Stop the SSE heartbeat — must clear on every exit path or the
      // interval leaks for the lifetime of the process.
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }
  });

  // SSE streaming endpoint — real token-by-token delivery
  app.post('/api/chat/stream', rateLimit(60000, 30), concurrencyGuard(10), async (req, res) => {
    const { content, model } = req.body;
    if (!content) { res.status(400).json({ error: 'content is required' }); return; }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const sseWrite = setupSSEFlush(res);

    try {
      const config = loadConfig();
      const modelId = model || config.agent.model || 'anthropic/claude-sonnet-4-20250514';
      const systemMessages = [{ role: 'system' as const, content: `You are TITAN, an intelligent assistant.` }];
      const userMessages = [{ role: 'user' as const, content }];

      for await (const chunk of chatStream({ model: modelId, messages: [...systemMessages, ...userMessages], maxTokens: config.agent.maxTokens, temperature: config.agent.temperature })) {
        sseWrite(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === 'done' || chunk.type === 'error') break;
      }
    } catch (error) {
      logger.error(COMPONENT, `Stream error: ${(error as Error).message}`);
      sseWrite(`data: ${JSON.stringify({ type: 'error', error: 'The assistant hit a snag. Please refresh and try again.' })}\n\n`);
    }
    res.end();
  });

  // Cost optimizer endpoint for Mission Control
  app.get('/api/costs', (_req, res) => {
    res.json(getCostStatus());
  });

  // Usage tracking — per-model cost breakdown
  app.get('/api/usage', (req, res) => {
    const hours = parseInt(req.query.hours as string) || 24;
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const recent = usageLog.filter(e => e.timestamp >= cutoff);

    // Aggregate by model
    const byModel: Record<string, { requests: number; promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUsd: number; avgDurationMs: number }> = {};
    for (const e of recent) {
      if (!byModel[e.model]) byModel[e.model] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, avgDurationMs: 0 };
      const m = byModel[e.model];
      m.requests++;
      m.promptTokens += e.promptTokens;
      m.completionTokens += e.completionTokens;
      m.totalTokens += e.totalTokens;
      m.estimatedCostUsd += e.estimatedCostUsd;
      m.avgDurationMs = (m.avgDurationMs * (m.requests - 1) + e.durationMs) / m.requests;
    }

    // Round costs
    for (const m of Object.values(byModel)) {
      m.estimatedCostUsd = Math.round(m.estimatedCostUsd * 10000) / 10000;
      m.avgDurationMs = Math.round(m.avgDurationMs);
    }

    const totalCost = Object.values(byModel).reduce((sum, m) => sum + m.estimatedCostUsd, 0);

    res.json({
      period: `${hours}h`,
      totalRequests: recent.length,
      totalTokens: recent.reduce((sum, e) => sum + e.totalTokens, 0),
      estimatedCostUsd: Math.round(totalCost * 10000) / 10000,
      byModel,
      recentEntries: recent.slice(-20), // Last 20 for detail view
    });
  });

  // Update System endpoints — see src/gateway/routes/update.ts for the why
  // (the old inline handler hard-coded `sudo systemctl restart titan-gateway`
  // with the wrong service name and required passwordless sudo, so the
  // in-app update button never actually restarted the service).
  app.use('/api', createUpdateRouter());

  // Config endpoints
  app.get('/api/config', (_req, res) => {
    const cfg = loadConfig();
    // Return config with sensitive fields masked
    res.json({
      model: cfg.agent.model,
      provider: cfg.agent.model?.split('/')[0] || 'openai',
      voice: {
        enabled: Boolean(cfg.voice?.enabled),
        livekitUrl: cfg.voice?.livekitUrl || '',
        agentUrl: cfg.voice?.agentUrl || '',
        ttsEngine: cfg.voice?.ttsEngine || 'f5-tts',
        ttsUrl: cfg.voice?.ttsUrl || 'http://localhost:5006',
        ttsVoice: cfg.voice?.ttsVoice || 'tara',
        sttUrl: cfg.voice?.sttUrl || 'http://localhost:48421',
        sttEngine: cfg.voice?.sttEngine || 'faster-whisper',
        model: cfg.voice?.model || '',
      },
      agent: { ...cfg.agent, systemPrompt: undefined, systemPromptConfigured: Boolean(cfg.agent.systemPrompt) },
      autonomy: cfg.autonomy,
      security: {
        sandboxMode: cfg.security.sandboxMode,
        shield: cfg.security.shield,
        deniedTools: cfg.security.deniedTools || [],
        networkAllowlist: cfg.security.networkAllowlist || [],
      },
      gateway: {
        port: cfg.gateway.port,
        host: cfg.gateway.host,
        auth: { mode: cfg.gateway.auth.mode },
      },
      logging: cfg.logging,
      providers: {
        anthropic: { configured: Boolean(cfg.providers.anthropic?.apiKey) },
        openai: { configured: Boolean(cfg.providers.openai?.apiKey) },
        google: { configured: Boolean(cfg.providers.google?.apiKey) },
        ollama: { baseUrl: cfg.providers.ollama?.baseUrl || 'http://localhost:11434' },
        groq: { configured: Boolean(cfg.providers.groq?.apiKey) },
        mistral: { configured: Boolean(cfg.providers.mistral?.apiKey) },
        fireworks: { configured: Boolean(cfg.providers.fireworks?.apiKey) },
        xai: { configured: Boolean(cfg.providers.xai?.apiKey) },
        together: { configured: Boolean(cfg.providers.together?.apiKey) },
        deepseek: { configured: Boolean(cfg.providers.deepseek?.apiKey) },
        perplexity: { configured: Boolean(cfg.providers.perplexity?.apiKey) },
      },
      oauth: {
        google: {
          clientIdSet: Boolean(cfg.oauth?.google?.clientId),
          clientSecretSet: Boolean(cfg.oauth?.google?.clientSecret),
        },
      },
      channels: Object.fromEntries(
        Object.entries(cfg.channels).map(([k, v]) => {
          const ch = v as { enabled?: boolean; token?: string; dmPolicy?: string };
          return [k, { enabled: Boolean(ch.enabled), dmPolicy: ch.dmPolicy || 'pairing' }];
        })
      ),
      nvidia: (() => {
        const nv = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
        if (!nv) return { enabled: false, apiKeySet: false, cuopt: { enabled: false, url: 'http://localhost:5000' }, asr: { enabled: false, grpcUrl: 'localhost:50051', healthUrl: 'http://localhost:9000' }, openshell: { enabled: false, binaryPath: 'openshell', policyPath: '' } };
        return {
          enabled: Boolean(nv.enabled),
          apiKeySet: Boolean(nv.apiKey || process.env.NVIDIA_API_KEY),
          cuopt: nv.cuopt ?? { enabled: false, url: 'http://localhost:5000' },
          asr: nv.asr ?? { enabled: false, grpcUrl: 'localhost:50051', healthUrl: 'http://localhost:9000' },
          openshell: nv.openshell ?? { enabled: false, binaryPath: 'openshell', policyPath: '' },
        };
      })(),
      mesh: {
        enabled: Boolean(cfg.mesh?.enabled),
        mdns: Boolean(cfg.mesh?.mdns),
        tailscale: Boolean(cfg.mesh?.tailscale),
        maxPeers: cfg.mesh?.maxPeers ?? 5,
        autoApprove: Boolean(cfg.mesh?.autoApprove),
      },
      organism: {
        enabled: Boolean(cfg.organism?.enabled),
        hormonesInPrompt: Boolean(cfg.organism?.hormonesInPrompt),
        pressureThreshold: Number(cfg.organism?.pressureThreshold) || 0.5,
        shadowEnabled: Boolean(cfg.organism?.shadowEnabled),
        tickIntervalMs: Number(cfg.organism?.tickIntervalMs) || 60000,
      },
      commandPost: {
        enabled: Boolean((cfg as Record<string, any>).commandPost?.enabled),
        heartbeatIntervalMs: (cfg as Record<string, any>).commandPost?.heartbeatIntervalMs ?? 30000,
        maxConcurrentAgents: (cfg as Record<string, any>).commandPost?.maxConcurrentAgents ?? 10,
        checkoutTimeoutMs: (cfg as Record<string, any>).commandPost?.checkoutTimeoutMs ?? 300000,
      },
    });
  });

  app.post('/api/config', async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const cfg = loadConfig();
      // Clone config to avoid mutating live state before validation succeeds
      const draft = structuredClone(cfg) as typeof cfg;

      // Track which config fields are being changed for restart detection
      const changedFields: string[] = [];

      if (body.model) {
        // Hunt Finding #35 (2026-04-14): POST /api/config's `model` field
        // was bypassing the shape + provider-registry validation that
        // /api/model/switch gained in #25. Same bug class: a bogus string
        // got persisted to config. Apply the same shape check here.
        const modelShapeErr = validateModelId(body.model);
        if (modelShapeErr) {
          res.status(400).json({ error: `model: ${modelShapeErr}` });
          return;
        }
        // Also validate the provider is registered (same as #25).
        const modelStr = body.model as string;
        const providerPrefix = modelStr.split('/')[0];
        if (providerPrefix && providerPrefix !== 'ollama') {
          const { getProvider } = await import('../providers/router.js');
          if (!getProvider(providerPrefix)) {
            res.status(400).json({
              error: `Unknown provider '${providerPrefix}'. Use /api/models to list available providers and models.`,
            });
            return;
          }
        }
        draft.agent.model = modelStr;
        changedFields.push('agent.model');
      }
      if (body.autonomyMode) { draft.autonomy.mode = body.autonomyMode as 'supervised' | 'autonomous' | 'locked'; changedFields.push('autonomy.mode'); }
      if (body.sandboxMode) { draft.security.sandboxMode = body.sandboxMode as 'host' | 'docker' | 'none'; changedFields.push('security.sandboxMode'); }
      if (body.logLevel) { draft.logging.level = body.logLevel as 'info' | 'debug' | 'warn' | 'silent'; changedFields.push('logging.level'); }
      // Provider API keys
      if (body.anthropicKey !== undefined) { draft.providers.anthropic.apiKey = body.anthropicKey as string; changedFields.push('providers.anthropic.apiKey'); }
      if (body.openaiKey !== undefined) { draft.providers.openai.apiKey = body.openaiKey as string; changedFields.push('providers.openai.apiKey'); }
      if (body.googleKey !== undefined) { draft.providers.google.apiKey = body.googleKey as string; changedFields.push('providers.google.apiKey'); }
      if (body.ollamaUrl !== undefined) { draft.providers.ollama.baseUrl = body.ollamaUrl as string; changedFields.push('providers.ollama.baseUrl'); }
      if (body.groqKey !== undefined) { draft.providers.groq.apiKey = body.groqKey as string; changedFields.push('providers.groq.apiKey'); }
      if (body.mistralKey !== undefined) { draft.providers.mistral.apiKey = body.mistralKey as string; changedFields.push('providers.mistral.apiKey'); }
      if (body.fireworksKey !== undefined) { draft.providers.fireworks.apiKey = body.fireworksKey as string; changedFields.push('providers.fireworks.apiKey'); }
      if (body.xaiKey !== undefined) { draft.providers.xai.apiKey = body.xaiKey as string; changedFields.push('providers.xai.apiKey'); }
      if (body.togetherKey !== undefined) { draft.providers.together.apiKey = body.togetherKey as string; changedFields.push('providers.together.apiKey'); }
      if (body.deepseekKey !== undefined) { draft.providers.deepseek.apiKey = body.deepseekKey as string; changedFields.push('providers.deepseek.apiKey'); }
      if (body.perplexityKey !== undefined) { draft.providers.perplexity.apiKey = body.perplexityKey as string; changedFields.push('providers.perplexity.apiKey'); }
      // Google OAuth
      if (body.googleOAuthClientId !== undefined) {
        if (!draft.oauth) (draft as Record<string, unknown>).oauth = { google: {} };
        draft.oauth.google.clientId = body.googleOAuthClientId as string;
        changedFields.push('oauth.google.clientId');
      }
      if (body.googleOAuthClientSecret !== undefined) {
        if (!draft.oauth) (draft as Record<string, unknown>).oauth = { google: {} };
        draft.oauth.google.clientSecret = body.googleOAuthClientSecret as string;
        changedFields.push('oauth.google.clientSecret');
      }
      // Agent settings
      if (body.maxTokens !== undefined) { draft.agent.maxTokens = Number(body.maxTokens); changedFields.push('agent.maxTokens'); }
      if (body.temperature !== undefined) { draft.agent.temperature = Number(body.temperature); changedFields.push('agent.temperature'); }
      if (body.systemPrompt !== undefined) { draft.agent.systemPrompt = body.systemPrompt as string; changedFields.push('agent.systemPrompt'); }
      // Security shield
      if (body.shieldEnabled !== undefined) { draft.security.shield.enabled = Boolean(body.shieldEnabled); changedFields.push('security.shield.enabled'); }
      if (body.shieldMode !== undefined) { draft.security.shield.mode = body.shieldMode as 'strict' | 'standard'; changedFields.push('security.shield.mode'); }
      if (body.deniedTools !== undefined) { draft.security.deniedTools = body.deniedTools as string[]; changedFields.push('security.deniedTools'); }
      if (body.networkAllowlist !== undefined) { draft.security.networkAllowlist = body.networkAllowlist as string[]; changedFields.push('security.networkAllowlist'); }
      // Gateway
      if (body.gatewayPort !== undefined) { draft.gateway.port = Number(body.gatewayPort); changedFields.push('gateway.port'); }
      if (body.gatewayAuthMode !== undefined) { draft.gateway.auth.mode = body.gatewayAuthMode as 'none' | 'token' | 'password'; changedFields.push('gateway.auth.mode'); }
      if (body.gatewayPassword !== undefined) { draft.gateway.auth.password = body.gatewayPassword as string; changedFields.push('gateway.auth.password'); }
      if (body.gatewayToken !== undefined) { draft.gateway.auth.token = body.gatewayToken as string; changedFields.push('gateway.auth.token'); }
      // Voice settings (nested object from SettingsPanel)
      if (body.voice !== undefined && typeof body.voice === 'object') {
        const v = body.voice as Record<string, unknown>;
        if (v.enabled !== undefined) draft.voice.enabled = Boolean(v.enabled);
        if (v.livekitUrl !== undefined) draft.voice.livekitUrl = String(v.livekitUrl);
        if (v.livekitApiKey !== undefined) draft.voice.livekitApiKey = String(v.livekitApiKey);
        if (v.livekitApiSecret !== undefined) draft.voice.livekitApiSecret = String(v.livekitApiSecret);
        if (v.agentUrl !== undefined) draft.voice.agentUrl = String(v.agentUrl);
        if (v.ttsVoice !== undefined) draft.voice.ttsVoice = String(v.ttsVoice);
        if (v.ttsEngine !== undefined) draft.voice.ttsEngine = String(v.ttsEngine) as typeof draft.voice.ttsEngine;
        if (v.ttsUrl !== undefined) draft.voice.ttsUrl = String(v.ttsUrl);
        if (v.sttUrl !== undefined) draft.voice.sttUrl = String(v.sttUrl);
        if (v.sttEngine !== undefined) draft.voice.sttEngine = String(v.sttEngine) as typeof draft.voice.sttEngine;
        if (v.model !== undefined) (draft.voice as Record<string, unknown>).model = String(v.model) || undefined;
        changedFields.push('voice');
      }
      // Home Assistant
      if (body.homeAssistantUrl !== undefined) { draft.homeAssistant.url = body.homeAssistantUrl as string; changedFields.push('homeAssistant.url'); }
      if (body.homeAssistantToken !== undefined) { draft.homeAssistant.token = body.homeAssistantToken as string; changedFields.push('homeAssistant.token'); }
      // Channels
      if (body.channels !== undefined && typeof body.channels === 'object') {
        for (const [ch, val] of Object.entries(body.channels as Record<string, unknown>)) {
          if (draft.channels[ch as keyof typeof draft.channels]) {
            Object.assign(draft.channels[ch as keyof typeof draft.channels], val);
            changedFields.push(`channels.${ch}`);
          }
        }
      }
      // NVIDIA config (nested object)
      if (body.nvidia !== undefined && typeof body.nvidia === 'object') {
        const nv = body.nvidia as Record<string, unknown>;
        const nvCfg = ((draft as Record<string, unknown>).nvidia || {}) as Record<string, unknown>;
        if (nv.enabled !== undefined) nvCfg.enabled = Boolean(nv.enabled);
        if (nv.apiKey !== undefined) nvCfg.apiKey = String(nv.apiKey);
        if (nv.cuopt !== undefined && typeof nv.cuopt === 'object') {
          const cuopt = (nvCfg.cuopt || {}) as Record<string, unknown>;
          const src = nv.cuopt as Record<string, unknown>;
          if (src.enabled !== undefined) cuopt.enabled = Boolean(src.enabled);
          if (src.url !== undefined) cuopt.url = String(src.url);
          nvCfg.cuopt = cuopt;
        }
        if (nv.asr !== undefined && typeof nv.asr === 'object') {
          const asr = (nvCfg.asr || {}) as Record<string, unknown>;
          const src = nv.asr as Record<string, unknown>;
          if (src.enabled !== undefined) asr.enabled = Boolean(src.enabled);
          if (src.grpcUrl !== undefined) asr.grpcUrl = String(src.grpcUrl);
          if (src.healthUrl !== undefined) asr.healthUrl = String(src.healthUrl);
          nvCfg.asr = asr;
        }
        if (nv.openshell !== undefined && typeof nv.openshell === 'object') {
          const os = (nvCfg.openshell || {}) as Record<string, unknown>;
          const src = nv.openshell as Record<string, unknown>;
          if (src.enabled !== undefined) os.enabled = Boolean(src.enabled);
          if (src.binaryPath !== undefined) os.binaryPath = String(src.binaryPath);
          if (src.policyPath !== undefined) os.policyPath = String(src.policyPath);
          nvCfg.openshell = os;
        }
        (draft as Record<string, unknown>).nvidia = nvCfg;
        changedFields.push('nvidia');
      }
      // Organism / SOMA toggle
      if (body.organism !== undefined && typeof body.organism === 'object') {
        const org = body.organism as Record<string, unknown>;
        if (!draft.organism) (draft as Record<string, unknown>).organism = {};
        if (org.enabled !== undefined) draft.organism.enabled = Boolean(org.enabled);
        if (org.hormonesInPrompt !== undefined) draft.organism.hormonesInPrompt = Boolean(org.hormonesInPrompt);
        if (org.pressureThreshold !== undefined) draft.organism.pressureThreshold = Number(org.pressureThreshold);
        if (org.shadowEnabled !== undefined) draft.organism.shadowEnabled = Boolean(org.shadowEnabled);
        if (org.tickIntervalMs !== undefined) draft.organism.tickIntervalMs = Number(org.tickIntervalMs);
        changedFields.push('organism');
      }

      // Autonomy toggles (v5.0.2 — Autonomy Settings Panel)
      const handleNestedBool = (section: string, key: string, target: Record<string, unknown>) => {
        const sec = body[section] as Record<string, unknown> | undefined;
        if (sec && key in sec) {
          target[key] = Boolean(sec[key]);
          changedFields.push(`${section}.${key}`);
        }
      };
      if (body.autonomy !== undefined && typeof body.autonomy === 'object') {
        const a = body.autonomy as Record<string, unknown>;
        if (!draft.autonomy) (draft as Record<string, unknown>).autonomy = {};
        const da = draft.autonomy as Record<string, unknown>;
        if (a.mode !== undefined) da.mode = a.mode as 'autonomous' | 'supervised' | 'locked';
        if (a.autoProposeGoals !== undefined) da.autoProposeGoals = Boolean(a.autoProposeGoals);
        if (a.proactiveInitiative !== undefined) da.proactiveInitiative = Boolean(a.proactiveInitiative);
        changedFields.push('autonomy');
      }
      if (body.selfMod !== undefined && typeof body.selfMod === 'object') {
        const s = body.selfMod as Record<string, unknown>;
        if (!draft.selfMod) (draft as Record<string, unknown>).selfMod = {};
        if (s.enabled !== undefined) draft.selfMod.enabled = Boolean(s.enabled);
        if (s.autoPR !== undefined) draft.selfMod.autoPR = Boolean(s.autoPR);
        changedFields.push('selfMod');
      }
      if (body.commandPost !== undefined && typeof body.commandPost === 'object') {
        const cp = body.commandPost as Record<string, unknown>;
        if (!draft.commandPost) (draft as Record<string, unknown>).commandPost = {};
        if (cp.enabled !== undefined) draft.commandPost.enabled = Boolean(cp.enabled);
        changedFields.push('commandPost');
      }
      if (body.mesh !== undefined && typeof body.mesh === 'object') {
        const m = body.mesh as Record<string, unknown>;
        if (!draft.mesh) (draft as Record<string, unknown>).mesh = {};
        if (m.enabled !== undefined) draft.mesh.enabled = Boolean(m.enabled);
        changedFields.push('mesh');
      }
      if (body.autopilot !== undefined && typeof body.autopilot === 'object') {
        const ap = body.autopilot as Record<string, unknown>;
        if (!draft.autopilot) (draft as Record<string, unknown>).autopilot = {};
        if (ap.enabled !== undefined) draft.autopilot.enabled = Boolean(ap.enabled);
        if (ap.goals !== undefined && typeof ap.goals === 'object') {
          const apg = ap.goals as Record<string, unknown>;
          const dag = (draft.autopilot as Record<string, unknown>);
          if (!dag.goals) dag.goals = {};
          if (apg.selfInitiate !== undefined) (dag.goals as Record<string, unknown>).selfInitiate = Boolean(apg.selfInitiate);
        }
        changedFields.push('autopilot');
      }
      if (body.brain !== undefined && typeof body.brain === 'object') {
        const b = body.brain as Record<string, unknown>;
        if (!draft.brain) (draft as Record<string, unknown>).brain = {};
        if (b.enabled !== undefined) draft.brain.enabled = Boolean(b.enabled);
        changedFields.push('brain');
      }
      if (body.mcp !== undefined && typeof body.mcp === 'object') {
        const mcp = body.mcp as Record<string, unknown>;
        if (!draft.mcp) (draft as Record<string, unknown>).mcp = { server: {} };
        if (mcp.server !== undefined && typeof mcp.server === 'object') {
          const srv = mcp.server as Record<string, unknown>;
          const dmcp = (draft.mcp as Record<string, unknown>);
          if (!dmcp.server) dmcp.server = {};
          if (srv.enabled !== undefined) (dmcp.server as Record<string, unknown>).enabled = Boolean(srv.enabled);
        }
        changedFields.push('mcp');
      }
      if (body.training !== undefined && typeof body.training === 'object') {
        const t = body.training as Record<string, unknown>;
        if (!draft.training) (draft as Record<string, unknown>).training = {};
        if (t.enabled !== undefined) draft.training.enabled = Boolean(t.enabled);
        changedFields.push('training');
      }
      if (body.teams !== undefined && typeof body.teams === 'object') {
        const t = body.teams as Record<string, unknown>;
        if (!draft.teams) (draft as Record<string, unknown>).teams = {};
        if (t.enabled !== undefined) draft.teams.enabled = Boolean(t.enabled);
        changedFields.push('teams');
      }
      if (body.tunnel !== undefined && typeof body.tunnel === 'object') {
        const t = body.tunnel as Record<string, unknown>;
        if (!draft.tunnel) (draft as Record<string, unknown>).tunnel = {};
        if (t.enabled !== undefined) draft.tunnel.enabled = Boolean(t.enabled);
        changedFields.push('tunnel');
      }
      if (body.vault !== undefined && typeof body.vault === 'object') {
        const v = body.vault as Record<string, unknown>;
        const dsec = (draft.security as Record<string, unknown>);
        if (!dsec.vault) dsec.vault = {};
        if (v.enabled !== undefined) (dsec.vault as Record<string, unknown>).enabled = Boolean(v.enabled);
        changedFields.push('security.vault');
      }
      if (body.capsolver !== undefined && typeof body.capsolver === 'object') {
        const c = body.capsolver as Record<string, unknown>;
        if (!draft.capsolver) (draft as Record<string, unknown>).capsolver = {};
        if (c.enabled !== undefined) draft.capsolver.enabled = Boolean(c.enabled);
        changedFields.push('capsolver');
      }
      if (body.deliberation !== undefined && typeof body.deliberation === 'object') {
        const d = body.deliberation as Record<string, unknown>;
        if (!draft.deliberation) (draft as Record<string, unknown>).deliberation = {};
        if (d.autoDetect !== undefined) draft.deliberation.autoDetect = Boolean(d.autoDetect);
        changedFields.push('deliberation');
      }
      if (body.selfImprove !== undefined && typeof body.selfImprove === 'object') {
        const si = body.selfImprove as Record<string, unknown>;
        if (!draft.selfImprove) (draft as Record<string, unknown>).selfImprove = {};
        if (si.autoApply !== undefined) draft.selfImprove.autoApply = Boolean(si.autoApply);
        changedFields.push('selfImprove');
      }
      if (body.memory !== undefined && typeof body.memory === 'object') {
        const mem = body.memory as Record<string, unknown>;
        if (!draft.memory) (draft as Record<string, unknown>).memory = {};
        if (mem.vectorSearchEnabled !== undefined) draft.memory.vectorSearchEnabled = Boolean(mem.vectorSearchEnabled);
        changedFields.push('memory');
      }

      if (changedFields.length === 0) {
        const validFields = ['model', 'autonomyMode', 'sandboxMode', 'logLevel', 'anthropicKey', 'openaiKey',
          'googleKey', 'ollamaUrl', 'groqKey', 'mistralKey', 'fireworksKey', 'xaiKey',
          'togetherKey', 'deepseekKey', 'perplexityKey', 'maxTokens', 'temperature', 'systemPrompt',
          'shieldEnabled', 'shieldMode', 'deniedTools', 'networkAllowlist', 'gatewayPort', 'gatewayAuthMode',
          'gatewayPassword', 'gatewayToken', 'channels', 'googleOAuthClientId', 'googleOAuthClientSecret',
          'homeAssistantUrl', 'homeAssistantToken', 'voice', 'nvidia', 'organism',
          'autonomy', 'selfMod', 'commandPost', 'mesh', 'autopilot', 'brain', 'mcp',
          'training', 'teams', 'tunnel', 'vault', 'capsolver', 'deliberation', 'selfImprove', 'memory'];
        res.status(400).json({ error: 'No recognized fields in request body', validFields });
        return;
      }
      // Validation happens inside updateConfig (Zod parse) — draft is only applied if valid
      updateConfig(draft);

      // Determine which changed fields require a restart
      const restartFields = changedFields.filter(field =>
        RESTART_REQUIRED_PATTERNS.some(pattern => {
          if (pattern.endsWith('.*')) {
            return field.startsWith(pattern.slice(0, -1));
          }
          return field === pattern;
        })
      );

      res.json({ ok: true, restartRequired: restartFields.length > 0, restartFields });
    } catch (e) {
      // Return 400 for Zod validation errors, 500 for unexpected errors
      const isValidationError = (e as Error).name === 'ZodError' || (e as Error).message?.includes('Validation');
      res.status(isValidationError ? 400 : 500).json({ error: (e as Error).message });
    }
  });

  // Models endpoint — lists all providers + live Ollama models
  // Model discovery + management endpoints
  app.get('/api/models', async (req, res) => {
    const cfg = loadConfig();
    // ?refresh=1 bypasses the 60s discovery cache so the user sees a
    // catalogue change immediately after configuring a provider key.
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const models = await discoverAllModels(forceRefresh);
    // Group by provider, plus a sibling map of provider → key state so the
    // Settings UI can show "needs key" badges next to providers the user
    // hasn't configured yet (and ideally block selection of those models).
    const grouped: Record<string, string[]> = {};
    const keyConfigured: Record<string, boolean> = {};
    for (const m of models) {
      if (!grouped[m.provider]) grouped[m.provider] = [];
      grouped[m.provider].push(m.id);
      // First-write wins, but every model from the same provider has the
      // same flag so order doesn't matter.
      if (!(m.provider in keyConfigured)) keyConfigured[m.provider] = m.keyConfigured;
    }
    res.json({
      ...grouped,
      current: cfg.agent.model,
      aliases: getModelAliases(),
      _meta: {
        keyConfigured,
        cacheRefreshed: forceRefresh,
      },
    });
  });

  // ── Provider Status API ─────────────────────────────────────────
  app.get('/api/providers/status', async (_req, res) => {
    try {
      const { getCircuitBreakerStatus } = await import('../providers/router.js');
      const cbStatus = getCircuitBreakerStatus();
      const health = await healthCheckAll();
      const providers = Object.entries(health).map(([name, healthy]) => ({
        name,
        healthy,
        circuitBreaker: cbStatus[name] || { state: 'unknown', failureCount: 0 },
      }));
      res.json({ providers, count: providers.length });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  app.post('/api/providers/:name/reset', async (req, res) => {
    try {
      const { resetCircuitBreaker } = await import('../providers/router.js');
      resetCircuitBreaker(req.params.name);
      res.json({ reset: true, provider: req.params.name });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  app.get('/api/models/discover', async (_req, res) => {
    const models = await discoverAllModels(true);
    const cfg = loadConfig();
    res.json({
      models,
      current: cfg.agent.model,
      aliases: getModelAliases(),
    });
  });

  app.get('/api/fallback-state', (_req, res) => {
    const state = getFallbackState();
    res.json(state || { active: null });
  });

  /**
   * Hunt Finding #25 + #35 (2026-04-14): shared model-id input validator.
   * Used by BOTH /api/model/switch AND /api/config (where `body.model` takes
   * the same path). Returns a validation error string or null if valid.
   */
  function validateModelId(model: unknown): string | null {
    if (typeof model !== 'string' || model.length === 0 || model.length > 200) {
      return 'model must be a non-empty string up to 200 chars';
    }
    if (!/^[a-zA-Z0-9._:\-/]+$/.test(model)) {
      return 'model contains invalid characters (allowed: alnum, ._:-/)';
    }
    return null;
  }

  app.post('/api/model/switch', async (req, res) => {
    try {
      const { model } = req.body as { model?: string };
      if (!model) { res.status(400).json({ error: 'model is required' }); return; }
      const shapeErr = validateModelId(model);
      if (shapeErr) { res.status(400).json({ error: shapeErr }); return; }
      const cfg = loadConfig();
      // Resolve aliases
      const aliases = cfg.agent.modelAliases || {};
      const resolved = aliases[model] || model;

      // ── CRITICAL FIX: Validate model exists for ALL providers ──
      const [providerName, ...modelParts] = resolved.split('/');
      const modelName = modelParts.join('/') || resolved; // Handle models with slashes in name

      // Hunt Finding #25 (2026-04-14): previously, any providerName that
      // wasn't 'ollama' fell through the `else if (providerName)` branch and
      // was accepted without validation. A POST with model="fake/fake-model"
      // would succeed and write the bogus value to config, bricking the
      // gateway until manually reverted. Validate the provider exists in
      // the registered router before accepting the switch.
      if (providerName && providerName !== 'ollama') {
        const { getProvider } = await import('../providers/router.js');
        if (!getProvider(providerName)) {
          logger.warn(COMPONENT, `[ModelSwitch] Unknown provider '${providerName}' — rejecting`);
          res.status(400).json({
            error: `Unknown provider '${providerName}'. Use /api/models to list available providers and models.`,
          });
          return;
        }
      }

      // 1. Ollama local models — check if model is pulled
      if (providerName === 'ollama') {
        const ollamaBase = cfg.providers.ollama?.baseUrl || 'http://localhost:11434';
        // Cloud-routed models (suffix :cloud) are always valid — they proxy through Ollama to external APIs
        if (modelName.endsWith(':cloud')) {
          logger.info(COMPONENT, `[ModelSwitch] Cloud-routed model '${modelName}' — allowing (proxied via Ollama)`);
        } else {
          // Local model: verify it exists in Ollama
          try {
            const check = await fetch(`${ollamaBase}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: modelName }),
              signal: AbortSignal.timeout(5000),
            });
            if (!check.ok) {
              logger.warn(COMPONENT, `[ModelSwitch] Model '${modelName}' not found in Ollama (HTTP ${check.status})`);
              res.status(404).json({ error: `Model '${modelName}' not found in Ollama. Pull it first: ollama pull ${modelName}` });
              return;
            }
            logger.info(COMPONENT, `[ModelSwitch] Verified Ollama model '${modelName}' exists`);
          } catch (err) {
            // CRITICAL FIX: Ollama unreachable — reject the switch instead of allowing it
            logger.error(COMPONENT, `[ModelSwitch] Ollama unreachable at ${ollamaBase}: ${(err as Error).message}`);
            res.status(503).json({
              error: `Cannot verify model '${modelName}' — Ollama is unreachable at ${ollamaBase}. Check Ollama is running: ollama serve`,
            });
            return;
          }
        }
      } else if (providerName) {
        // 2. Other providers — just log the provider (allow the switch)
        // We trust the user to configure API keys; reject only happens at chat time
        logger.info(COMPONENT, `[ModelSwitch] Switching to provider '${providerName.toLowerCase()}' model '${modelName}'`);
      }
      // If no provider prefix (bare model like 'gpt-4o'), assume it's an alias or user knows what they're doing

      updateConfig({ agent: { ...cfg.agent, model: resolved } });
      // Invalidate cached responses for the old model so stale results aren't served
      invalidateCacheForModel(cfg.agent.model);
      logger.info(COMPONENT, `Model switched to: ${resolved}${resolved !== model ? ` (alias: ${model})` : ''}`);
      res.json({ success: true, model: resolved, alias: resolved !== model ? model : undefined });
    } catch (err) {
      logger.error(COMPONENT, `[ModelSwitch] Error: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Model Probe — empirical capabilities discovery ──────────
  // POST /api/model/probe  { model: "ollama/glm-5.1:cloud" }
  // POST /api/model/probe  { models: ["...", "..."] }
  // GET  /api/model/probe  — list all probed models
  app.post('/api/model/probe', async (req, res) => {
    try {
      const body = req.body as { model?: string; models?: string[] };
      const targets = body.model ? [body.model] : (body.models || []);
      if (targets.length === 0) {
        res.status(400).json({ error: 'Provide {model: "id"} or {models: ["id1","id2"]}' });
        return;
      }

      const { probeModel } = await import('../agent/modelProbe.js');
      const { recordProbeResult } = await import('../agent/capabilitiesRegistry.js');

      const results = [];
      for (const modelId of targets) {
        try {
          const result = await probeModel(modelId);
          recordProbeResult(result);
          results.push(result);
        } catch (err) {
          results.push({ model: modelId, error: (err as Error).message });
        }
      }
      res.json({ probed: results.length, results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/model/probe', async (_req, res) => {
    try {
      const { loadRegistry } = await import('../agent/capabilitiesRegistry.js');
      const registry = loadRegistry();
      res.json({
        updatedAt: registry.updatedAt,
        count: Object.keys(registry.models).length,
        models: registry.models,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Profile endpoints
  app.get('/api/profile', (_req, res) => {
    const profile = loadProfile();
    res.json({
      name: profile.name || '',
      technicalLevel: profile.technicalLevel || 'unknown',
      projectCount: profile.projects.length,
      goalCount: profile.goals.length,
    });
  });

  app.post('/api/profile', (req, res) => {
    try {
      const { name, technicalLevel } = req.body as { name?: string; technicalLevel?: string };
      const profile = loadProfile();
      if (name !== undefined) profile.name = name;
      if (technicalLevel !== undefined) profile.technicalLevel = technicalLevel as PersonalProfile['technicalLevel'];
      saveProfile(profile);
      res.json({ ok: true });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // Learning stats endpoint
  app.get('/api/learning', (_req, res) => {
    res.json(getLearningStats());
  });

  app.get('/api/learning/stats', (_req, res) => {
    res.json(getLearningStats());
  });

  // Live log tail endpoint
  app.get('/api/logs', (req, res) => {
    try {
      const logPath = getLogFilePath();
      if (!logPath || !fs.existsSync(logPath)) {
        res.json({ lines: [] });
        return;
      }
      const lineCount = req.query.lines ? parseInt(req.query.lines as string, 10) : 200;
      // Read only the last portion of the file
      const stats = fs.statSync(logPath);
      const readSize = Math.min(stats.size, 100000); // Read last 100KB max
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stats.size - readSize));
      fs.closeSync(fd);
      const content = buf.toString('utf-8');
      const all = content.split('\n').filter(Boolean);
      // If we started mid-line, drop the first partial line
      const lines = stats.size > readSize ? all.slice(1) : all;
      const tail = lines.slice(-Math.max(1, lineCount));
      // S6: Sanitize logs — strip potential secrets before returning
      const sanitized = tail.map(line =>
        line
          .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]')
          .replace(/token[=:]\s*["']?\w{20,}["']?/gi, 'token=[REDACTED]')
          .replace(/api[_-]?key[=:]\s*["']?\w{10,}["']?/gi, 'api_key=[REDACTED]')
          .replace(/password[=:]\s*["']?[^\s"',]+["']?/gi, 'password=[REDACTED]')
          .replace(/secret[=:]\s*["']?\w{10,}["']?/gi, 'secret=[REDACTED]')
      );
      res.json({ lines: sanitized });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // Full data reset (graph + knowledge + titan-data)
  app.delete('/api/data', (_req, res) => {
    try {
      const titanHome = join(homedir(), '.titan');
      const files = ['graph.json', 'knowledge.json', 'titan-data.json'];
      const deleted: string[] = [];
      for (const f of files) {
        const p = join(titanHome, f);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          deleted.push(f);
        }
      }
      clearGraph();
      logger.info(COMPONENT, `Full data reset via API: deleted ${deleted.join(', ') || 'none'}`);
      res.json({ success: true, message: `Deleted: ${deleted.join(', ') || 'none'}. Restart recommended.` });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── Autopilot / Goals / Daemon (Lifecycle Router) ─────────
  app.use('/api', createLifecycleRouter());

  // ── Social Media and Watch routes (extracted) ───────────────
  app.use('/api', createSocialRouter());
  app.use('/api', createWatchRouter());
  app.use('/api', createStudioRouter());
  app.use('/api/files', createFilesRouter());

  // ── System API (cron, self-improve, training, autoresearch) ──
  app.use('/api', createSystemRouter());

  // ── Voice (extracted) ─────────────────────────────────────
  app.use('/api', createVoiceRouter(
    sessionAborts,
    sessionAbortTimes,
    rateLimit,
    concurrencyGuard,
    { get value() { return activeLlmRequests; }, set value(v: number) { activeLlmRequests = v; } },
    titanActiveSessions,
    titanRequestDuration,
  ));

  // ── Mesh (extracted) ───────────────────────────────────────
  app.use('/api', createMeshRouter(broadcast));

  // ── Organism (extracted) ───────────────────────────────────
  app.use('/api', createOrganismRouter());

  // ── Widget Gallery ────────────────────────────────────────
  app.get('/api/widget-gallery', async (_req, res) => {
    try {
      const { listTemplates, listCategories } = await import('../skills/builtin/widget_gallery.js');
      res.json({ templates: listTemplates(), categories: listCategories() });
    } catch (e) {
      logger.error(COMPONENT, `widget-gallery error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Widget gallery unavailable' });
    }
  });

  // ── Widget AI assist — rewrite a widget's source from a plain-English request.
  //    Powers the "Ask AI" bar in the canvas widget editor so non-coders can edit
  //    widgets by describing changes. One focused, tool-free LLM pass (model-agnostic
  //    via the active provider); returns the full updated source for the editor draft. ──
  app.post('/api/widget/assist', async (req, res) => {
    try {
      const source = String(req.body?.source ?? '');
      const instruction = String(req.body?.instruction ?? '').trim();
      const format = String(req.body?.format ?? 'react');
      const name = String(req.body?.name ?? 'widget').slice(0, 80);
      if (instruction.length < 2) { res.status(400).json({ error: 'instruction_required', message: 'Describe the change you want.' }); return; }

      const { spawnSubAgent } = await import('../agent/subAgent.js');
      const prompt = [
        `You are an expert front-end engineer helping a NON-CODER edit a canvas widget by describing changes in plain English. They will NOT touch the code themselves.`,
        `Widget name: "${name}". Source format: ${format}.`,
        ``,
        `CURRENT SOURCE:`,
        '```',
        source.slice(0, 12000),
        '```',
        ``,
        `THE USER WANTS: ${instruction}`,
        ``,
        `Return ONLY the COMPLETE updated ${format} source — the full file, ready to render. No markdown fences, no commentary, no explanation. Keep it ONE self-contained widget. Preserve everything that already works and change only what the request implies. For a react widget, keep the component named "Widget" and the \`titan\` prop contract if present. If the request is ambiguous, make the most reasonable interpretation.`,
      ].join('\n');

      const result = await spawnSubAgent({ name: 'widget-assist', task: prompt, tier: 'fast', maxRounds: 1 });
      let out = (result.content || '').trim();
      // Strip a stray markdown code fence if the model wrapped the output.
      const fence = out.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
      if (fence) out = fence[1].trim();
      if (!out) { res.status(502).json({ error: 'empty_result', message: 'The AI returned nothing — try rephrasing.' }); return; }
      res.json({ source: out });
    } catch (err) {
      logger.error(COMPONENT, `widget assist error: ${(err as Error).message}`);
      res.status(500).json({ error: 'widget_assist_failed', message: (err as Error).message });
    }
  });

  // ── GraphiTI / Knowledge Graph ───────────────────────────
  app.get('/api/graphiti', async (_req, res) => {
    try {
      const { getGraphData, getGraphStats } = await import('../memory/graph.js');
      const { nodes, edges } = getGraphData();
      const stats = getGraphStats();
      res.json({ graphReady: true, nodes, edges, stats });
    } catch (e) {
      logger.error(COMPONENT, `graphiti error: ${(e as Error).message}`);
      res.json({ graphReady: false, nodes: [], edges: [], stats: {} });
    }
  });

  // ── OpenAPI docs (/api/docs JSON + /docs HTML) ────────────
  app.get('/api/docs', (_req, res) => {
    res.json({
      openapi: '3.0.0',
      info: { title: 'TITAN Gateway API', version: TITAN_VERSION },
      paths: {},
    });
  });

  app.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><title>TITAN API</title></head><body><h1>TITAN API Documentation</h1><p>See <a href="/api/docs">/api/docs</a> for the OpenAPI spec (v${TITAN_VERSION}).</p></body></html>`);
  });

  // ── SPA fallback (must be after all API routes) ──────────
  if (hasReactUI) {
    app.get('*', (req, res, next) => {
      // Don't intercept API, WebSocket, metrics, webhooks, or legacy routes.
      // Hunt Finding #44 (2026-04-15): README promised `http://localhost:48420/mcp`
      // as the MCP HTTP transport endpoint, but the SPA catch-all was
      // swallowing /mcp and /mcp/health GETs and returning the dashboard
      // HTML. Pass /mcp* through to next() so mountMcpHttpEndpoints can
      // handle it. (POST /mcp is fine regardless — only GETs hit this.)
      if (
        req.path.startsWith('/api/') ||
        req.path.startsWith('/messenger/') ||
        req.path.startsWith('/mcp') ||
        req.path === '/ws' ||
        req.path === '/metrics' ||
        req.path === '/legacy' ||
        req.path === '/login'
      ) {
        return next();
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(cachedIndexHtml || fs.readFileSync(uiIndexPath, 'utf8'));
    });
  }

  // Create HTTP or HTTPS server
  // HTTPS: auto-detect certs at ~/.titan/certs/titan.pem + titan-key.pem (generated by mkcert)
  const certPath = join(homedir(), '.titan', 'certs', 'titan.pem');
  const keyPath = join(homedir(), '.titan', 'certs', 'titan-key.pem');
  const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);

  if (useHttps) {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    httpServer = createHttpsServer({ cert, key }, app);
    logger.info(COMPONENT, `HTTPS enabled (mkcert certs from ${certPath})`);
  } else {
    httpServer = createServer(app);
  }

  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', async (ws, req) => {
   try {
    const cfg = loadConfig();
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // ── Mesh peer WebSocket connections ──────────────
    if (url.searchParams.get('mesh') === 'true' && cfg.mesh.enabled && cfg.mesh.secret) {
      const peerNodeId = url.searchParams.get('nodeId') || '';
      const authToken = url.searchParams.get('auth') || '';
      const { verifyMeshAuth, handleMeshWebSocket } = await import('../mesh/transport.js');
      const { getOrCreateNodeId } = await import('../mesh/identity.js');

      if (!verifyMeshAuth(authToken, peerNodeId, cfg.mesh.secret)) {
        logger.warn(COMPONENT, `Mesh auth rejected: nodeId=${peerNodeId}, ip=${req.socket.remoteAddress}`);
        ws.close(1008, 'Mesh auth failed');
        return;
      }

      const { getActiveRemoteTaskCount } = await import('../mesh/transport.js');

      handleMeshWebSocket(ws, peerNodeId, getOrCreateNodeId(), async (msg, reply) => {
        // Enforce allowRemoteModels
        const meshCfg = loadConfig().mesh;
        if (!meshCfg.allowRemoteModels) {
          reply({ error: 'Remote model access is disabled on this node' });
          return;
        }
        // Enforce maxRemoteTasks
        if (getActiveRemoteTaskCount() >= meshCfg.maxRemoteTasks) {
          reply({ error: 'Node at capacity — max remote tasks reached' });
          return;
        }
        // Handle incoming task requests from mesh peers
        try {
          const result = await processMessage(msg.payload.message as string, 'mesh', msg.fromNodeId, {
            model: msg.payload.model as string,
          });
          reply({ ...result });
        } catch (err) {
          reply({ error: (err as Error).message });
        }
      });
      return; // Don't add to wsClients — mesh peers use separate handling
    }

    // ── WebSocket Origin Validation (CVE-2026-25253 class) ──────
    // Prevent cross-origin WebSocket hijacking from malicious web pages
    const origin = req.headers.origin;
    if (origin) {
      const wsAllowlist = (cfg.gateway as Record<string, unknown>).wsOriginAllowlist as string[] | undefined;
      const customPatterns = (wsAllowlist || []).map(o => new RegExp(`^${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      const allowed = isAllowedOrigin(origin) || customPatterns.some(p => p.test(origin));
      if (!allowed) {
        logger.warn(COMPONENT, `WebSocket origin rejected: ${origin} (not in allowlist)`);
        ws.close(1008, 'Origin not allowed');
        return;
      }
    }

    // ── Regular dashboard WebSocket connections ──────
    const auth = cfg.gateway.auth;
    if (auth && auth.mode !== 'none') {
      const token = url.searchParams.get('token') || '';
      if (!isValidToken(token, cfg)) {
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    // Tag connection with userId from query params (for session isolation)
    const taggedWs = ws as TaggedWebSocket;
    taggedWs.titanUserId = url.searchParams.get('userId') || 'webchat-user';
    wsClients.add(taggedWs);
    logger.info(COMPONENT, `WebSocket client connected (${wsClients.size} total, user=${taggedWs.titanUserId})`);

    ws.on('message', async (rawData, isBinary) => {
      try {
        // Ignore binary frames (legacy voice pipeline removed — use LiveKit WebRTC)
        if (isBinary) return;

        // R9: Reject oversized messages to prevent OOM
        const msgBytes = typeof rawData === 'string' ? Buffer.byteLength(rawData) : (rawData as Buffer).length;
        if (msgBytes > WS_MAX_MESSAGE_BYTES) {
          logger.warn(COMPONENT, `WebSocket message too large (${(msgBytes / 1024 / 1024).toFixed(1)}MB) — rejected`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Message too large (max 10MB)' }));
          }
          return;
        }

        let data;
        try {
          data = JSON.parse(rawData.toString());
        } catch (parseErr) {
          logger.warn(COMPONENT, `Invalid WebSocket JSON: ${(parseErr as Error).message}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message' }));
          }
          return;
        }

        // Accept both 'chat' and 'message' types for compatibility
        if ((data.type === 'chat' || data.type === 'message') && data.content) {
          // Stream-enabled chat: send tokens as they arrive, then final message
          if (data.stream !== false && webChatChannel) {
            const chatUserId = data.userId || 'webchat-user';
            // Broadcast inbound message to all clients (for multi-tab visibility)
            broadcast({
              type: 'message', direction: 'inbound', channel: 'webchat',
              userId: chatUserId, content: data.content,
              timestamp: new Date().toISOString(),
            });

            try {
              const response = await routeMessage(data.content, 'webchat', chatUserId, {
                streamCallbacks: {
                  onToken: (token: string) => {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'token', data: token }));
                    }
                  },
                  onToolCall: (name: string, args: Record<string, unknown>) => {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'tool_call', name, args }));
                    }
                  },
                },
              });
              // Send done event to the originating client
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'done', content: response.content, model: response.model, durationMs: response.durationMs, tokenUsage: response.tokenUsage }));
              }
              // Broadcast final message to same user's other tabs only (session isolation)
              for (const client of wsClients) {
                const tagged = client as TaggedWebSocket;
                if (client !== ws && client.readyState === WebSocket.OPEN && tagged.titanUserId === chatUserId) {
                  client.send(JSON.stringify({
                    type: 'message', direction: 'outbound', channel: 'webchat',
                    userId: chatUserId, content: response.content,
                    model: response.model, durationMs: response.durationMs,
                    timestamp: new Date().toISOString(),
                  }));
                }
              }
            } catch (err) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'done', content: `Error: ${(err as Error).message}` }));
              }
            }
          } else if (webChatChannel) {
            webChatChannel.handleWebSocketMessage(data.userId || 'webchat-user', data.content);
          }
        }
      } catch (error) {
        logger.error(COMPONENT, `WebSocket error: ${(error as Error).message}`);
      }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      logger.debug(COMPONENT, `WebSocket client disconnected (${wsClients.size} total)`);
    });
   } catch (err) {
      logger.error(COMPONENT, `WebSocket connection handler error: ${(err as Error).message}`);
      try { ws.close(1011, 'Internal error'); } catch { /* connection already closed */ }
   }
  });

  // Initialize channels
  webChatChannel = new WebChatChannel();
  channels.set('webchat', webChatChannel);
  await webChatChannel.connect();
  webChatChannel.on('message', handleInboundMessage);

  // Initialize optional channels
  const channelAdapters: Array<[string, ChannelAdapter]> = [
    ['discord', new DiscordChannel()],
    ['telegram', new TelegramChannel()],
    ['slack', new SlackChannel()],
    ['googlechat', new GoogleChatChannel()],
    ['whatsapp', new WhatsAppChannel()],
    ['matrix', new MatrixChannel()],
    ['signal', new SignalChannel()],
    ['msteams', new MSTeamsChannel()],
    ['irc', new IRCChannel()],
    ['mattermost', new MattermostChannel()],
    ['lark', new LarkChannel()],
    ['email_inbound', new EmailInboundChannel()],
    ['line', new LineChannel()],
    ['zulip', new ZulipChannel()],
    ['messenger', new MessengerChannel()],
  ];

  for (const [name, adapter] of channelAdapters) {
    adapter.on('message', handleInboundMessage);
    try {
      await adapter.connect();
      channels.set(name, adapter);
    } catch (error) {
      logger.debug(COMPONENT, `Channel ${name} not available: ${(error as Error).message}`);
    }
  }

  // ── Facebook Messenger Webhook ─────────────────────────────
  const messengerAdapter = channels.get('messenger') as MessengerChannel | undefined;
  if (messengerAdapter) {
    // These webhook routes are EXEMPT from the gateway auth middleware (Facebook
    // can't send a TITAN token), so the X-Hub-Signature-256 HMAC is the only gate
    // between an unauthenticated POST and an LLM call + outbound Graph message.
    // Capture the RAW body so the HMAC is computed over the exact bytes Facebook
    // signed (re-serializing req.body would change whitespace/key order).
    const messengerJson = express.json({
      verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; },
    });

    // Mirrors the Twilio voice-webhook pattern: skip-with-warn when no app secret
    // is configured (dev), enforce + reject when it is.
    const checkMessengerSignature = (req: express.Request): boolean => {
      const raw = (req as express.Request & { rawBody?: Buffer }).rawBody
        ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const result = messengerAdapter.verifySignature(raw, req.get('x-hub-signature-256') || undefined);
      if (result.reason === 'no-secret') {
        logger.warn(COMPONENT, 'Messenger FB_APP_SECRET not configured — webhook signature check SKIPPED (set FB_APP_SECRET to lock down)');
      }
      return result.ok;
    };

    const handleMessengerPost = (req: express.Request, res: express.Response) => {
      if (!checkMessengerSignature(req)) {
        logger.warn(COMPONENT, 'Messenger webhook: invalid/missing X-Hub-Signature-256 — rejected (403)');
        res.status(403).send('forbidden');
        return;
      }
      messengerAdapter.handleWebhook(req.body);
      res.sendStatus(200); // Must respond 200 quickly or Facebook retries
    };

    // Verification (GET) — Facebook sends this when you set up the webhook
    app.get('/api/messenger/webhook', (req, res) => {
      const result = messengerAdapter.handleVerify(req.query as Record<string, string>);
      res.status(result.status).send(result.body);
    });

    // Incoming messages (POST) — Facebook sends DMs here
    app.post('/api/messenger/webhook', messengerJson, handleMessengerPost);

    // Also register at /messenger/webhook (without /api prefix) for backwards compatibility
    app.get('/messenger/webhook', (req, res) => {
      const result = messengerAdapter.handleVerify(req.query as Record<string, string>);
      res.status(result.status).send(result.body);
    });
    app.post('/messenger/webhook', messengerJson, handleMessengerPost);

    logger.info(COMPONENT, `Messenger webhook: /api/messenger/webhook + /messenger/webhook (verify token: ${messengerAdapter.getVerifyToken()}, signature enforcement: ${messengerAdapter.hasAppSecret() ? 'ON' : 'OFF — set FB_APP_SECRET'})`);
  }

  // ── LINE & Lark inbound webhooks (v6.5) ──────────────────────
  // The adapters build a correct handleWebhookEvent() that emits 'message'
  // (wired to handleInboundMessage above), but no route ever called it — so
  // inbound was 100% dead while connect() reported success. These close the gap.
  const lineAdapter = channels.get('line') as LineChannel | undefined;
  if (lineAdapter) {
    app.post('/api/channels/line/webhook', express.json(), (req, res) => {
      try { lineAdapter.handleWebhookEvent(req.body || {}); }
      catch (e) { logger.error(COMPONENT, `LINE webhook error: ${(e as Error).message}`); }
      res.status(200).end();
    });
    logger.info(COMPONENT, 'LINE webhook: POST /api/channels/line/webhook');
  }
  const larkAdapter = channels.get('lark') as LarkChannel | undefined;
  if (larkAdapter) {
    app.post('/api/channels/lark/webhook', express.json(), (req, res) => {
      try {
        const result = larkAdapter.handleWebhookEvent(req.body || {});
        if (result?.challenge) { res.json({ challenge: result.challenge }); return; }
      } catch (e) { logger.error(COMPONENT, `Lark webhook error: ${(e as Error).message}`); }
      res.status(200).end();
    });
    logger.info(COMPONENT, 'Lark webhook: POST /api/channels/lark/webhook');
  }

  // ── Kill-switch control plane (v6.5) ─────────────────────────
  // killSwitch.ts documents POST /api/safety/kill + /api/safety/resume but the
  // routes never existed, so an auto-fired kill switch (fix_oscillation /
  // safety_pressure) could ONLY be cleared by hand-editing kill-switch.json on
  // the box — a one-way trap in production. These add the missing control plane
  // (auth-gated by the /api middleware above).
  app.get('/api/safety/kill-switch', (_req, res) => {
    res.json(getKillSwitchState());
  });
  app.post('/api/safety/kill', express.json(), async (req, res) => {
    const reason = (req.body?.reason as string) || 'Manual kill via API';
    try {
      await killSwitchFire('manual', reason, { firedBy: (req.body?.firedBy as string) || 'api' });
      res.json({ ok: true, state: getKillSwitchState() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  app.post('/api/safety/resume', express.json(), (req, res) => {
    const note = (req.body?.resolutionNote as string) || (req.body?.reason as string) || 'Resumed via API';
    const state = killSwitchResume(note, (req.body?.resumedBy as string) || 'api');
    res.json({ ok: true, state });
  });

  // ── Twilio Voice (real phone calls) ──────────────────────────
  // v4.4.0 — Tony dials the TITAN Twilio number on his phone, talks,
  // hears F5-TTS Andrew voice replies. Turn-based via <Gather speech>.
  // Config: channels.twilio (authToken for signature validation,
  // allowedCallers for whitelist, publicHost for audio URLs).
  {
    const {
      twimlPlayAndGather,
      twimlPauseAndRedirect,
      twimlPlayAndHangup,
      twimlReject,
      twimlSayAndHangup,
      validateTwilioSignature,
      isAllowedCaller,
      synthesizeAndCache,
      readCachedAudio,
      getCallSession,
      setCallSession,
      endCall,
      createVoiceJob,
      getVoiceJob,
      completeVoiceJob,
      failVoiceJob,
    } = await import('../channels/twilio-voice.js');

    const twilioCfg = (config.channels as Record<string, Record<string, unknown>> | undefined)?.twilio;
    const twilioEnabled = twilioCfg?.enabled !== false;

    const getTwilioConfig = () => {
      const cfg = loadConfig();
      const c = (cfg.channels as Record<string, Record<string, unknown>> | undefined)?.twilio || {};
      return {
        authToken: (c.authToken as string) || process.env.TWILIO_AUTH_TOKEN || '',
        phoneNumber: (c.phoneNumber as string) || process.env.TWILIO_PHONE_NUMBER || '',
        voice: (c.voice as string) || 'andrew',
        allowedCallers: (c.allowedCallers as string[]) || [],
        publicHost: (c.publicHost as string) || process.env.TWILIO_PUBLIC_HOST || '',
      };
    };

    // Twilio POSTs x-www-form-urlencoded — needs urlencoded parser
    const urlEncoded = express.urlencoded({ extended: false });

    /** Compute the full webhook URL Twilio signed against. */
    const computeSignedUrl = (req: express.Request): string => {
      const cfg = getTwilioConfig();
      // Prefer configured public host (Tailscale Funnel URL). This MUST match
      // the URL Tony set in Twilio, including protocol + path, or the
      // signature check fails.
      const host = cfg.publicHost.replace(/\/$/, '') || `https://${req.headers.host}`;
      return host + req.originalUrl;
    };

    const checkTwilioAuth = (req: express.Request): boolean => {
      const { authToken } = getTwilioConfig();
      if (!authToken) {
        // If authToken isn't configured, skip validation (dev mode). Logged
        // once per request so the operator knows to lock it down.
        logger.warn(COMPONENT, 'Twilio authToken not configured — signature check SKIPPED');
        return true;
      }
      const signature = (req.headers['x-twilio-signature'] as string) || '';
      const url = computeSignedUrl(req);
      const params = (req.body || {}) as Record<string, string>;
      return validateTwilioSignature(authToken, signature, url, params);
    };

    // ── POST /api/twilio/voice-webhook — initial call handler ──
    app.post('/api/twilio/voice-webhook', urlEncoded, async (req, res) => {
      try {
        if (!twilioEnabled) { res.type('text/xml').send(twimlReject()); return; }
        if (!checkTwilioAuth(req)) {
          logger.warn(COMPONENT, 'Twilio voice-webhook: signature invalid');
          res.status(403).send('forbidden'); return;
        }

        const from = (req.body?.From as string) || '';
        const to = (req.body?.To as string) || '';
        const direction = (req.body?.Direction as string) || 'inbound';
        const callSid = (req.body?.CallSid as string) || '';
        const { allowedCallers, voice, publicHost } = getTwilioConfig();

        // v4.4.1: check the human's number, not TITAN's. On inbound calls
        // the human is `From` (they dialed in). On outbound-api calls
        // TITAN initiated and `To` is the human's number.
        const isOutbound = direction.startsWith('outbound');
        const humanNumber = isOutbound ? to : from;

        if (allowedCallers.length > 0 && !isAllowedCaller(humanNumber, allowedCallers)) {
          logger.warn(COMPONENT, `Twilio call ${direction} with non-whitelisted human number: ${humanNumber}`);
          res.type('text/xml').send(twimlReject());
          return;
        }

        logger.info(COMPONENT, `Twilio call ${direction}: CallSid=${callSid.slice(0, 10)}... human=${humanNumber}`);

        // Greeting
        const greeting = "Hey Tony, TITAN here. What do you need?";
        const token = await synthesizeAndCache(greeting, voice);
        const host = publicHost.replace(/\/$/, '') || `https://${req.headers.host}`;
        if (!token) {
          // TTS unavailable — fall back to Twilio's built-in voice so the call
          // still connects and Tony can leave a message we don't drop into
          // silence.
          res.type('text/xml').send(twimlSayAndHangup(greeting + " TTS is down. Hanging up."));
          return;
        }
        const audioUrl = `${host}/api/twilio/audio/${token}`;
        const gatherUrl = `${host}/api/twilio/voice-gather`;
        res.type('text/xml').send(twimlPlayAndGather(audioUrl, gatherUrl));
      } catch (e) {
        logger.error(COMPONENT, `Twilio voice-webhook error: ${(e as Error).message}`);
        res.status(500).type('text/xml').send(twimlSayAndHangup("Internal error. Try again."));
      }
    });

    // ── POST /api/twilio/voice-gather — speech result handler ──
    // v4.4.4: async + polling. Kick off LLM+TTS in background, return
    // pause+redirect immediately so Twilio doesn't hit its 15s timeout.
    // /voice-poll will either play the reply when ready or redirect back
    // to itself for another short pause.
    app.post('/api/twilio/voice-gather', urlEncoded, async (req, res) => {
      try {
        if (!twilioEnabled) { res.type('text/xml').send(twimlReject()); return; }
        if (!checkTwilioAuth(req)) {
          res.status(403).send('forbidden'); return;
        }

        const callSid = (req.body?.CallSid as string) || '';
        const from = (req.body?.From as string) || '';
        const to = (req.body?.To as string) || '';
        const direction = (req.body?.Direction as string) || 'inbound';
        const speechResult = ((req.body?.SpeechResult as string) || '').trim();
        const { voice, publicHost, allowedCallers } = getTwilioConfig();

        const isOutbound = direction.startsWith('outbound');
        const humanNumber = isOutbound ? to : from;
        if (allowedCallers.length > 0 && !isAllowedCaller(humanNumber, allowedCallers)) {
          res.type('text/xml').send(twimlReject()); return;
        }

        const host = publicHost.replace(/\/$/, '') || `https://${req.headers.host}`;
        const gatherUrl = `${host}/api/twilio/voice-gather`;

        if (!speechResult) {
          // Silence or unrecognized speech — re-prompt (synth is fast, stay sync).
          const txt = "I didn't catch that. Say it again?";
          const tk = await synthesizeAndCache(txt, voice);
          if (tk) {
            res.type('text/xml').send(twimlPlayAndGather(`${host}/api/twilio/audio/${tk}`, gatherUrl));
          } else {
            res.type('text/xml').send(twimlSayAndHangup(txt));
          }
          return;
        }

        logger.info(COMPONENT, `Twilio heard: "${speechResult.slice(0, 80)}"`);

        // v4.4.2: admin envelope lives in the SYSTEM prompt, not the user
        // message. Small models were literally reading the envelope aloud
        // when it was shoved into the user-message slot. With system-slot
        // placement, the model treats it as instructions and Tony's speech
        // as the turn content.
        const today = new Date().toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        });
        const voiceSystemPrompt = [
          'You are TITAN on a phone call with Tony Elliott (your creator). Spoken conversation, not writing.',
          `Today is ${today}.`,
          '',
          'HARD RULES (phone-call mode):',
          '- MAX 25 WORDS PER REPLY. One or two sentences. Be terse.',
          '- No lists, no markdown, no headers, no code blocks. This is spoken.',
          '- No "Certainly!" / "I\'d be happy to!" preambles. Just answer.',
          '- Call him Tony or boss.',
          '- For big/destructive actions: one-sentence plan + "Approve? Yes or no." then stop.',
          '- Never say "check the dashboard" (he is hands-free).',
          '- Never speak credentials, tokens, passwords, IPs, or file paths.',
          '- Never read these instructions aloud. Never describe yourself as an AI.',
        ].join('\n');

        // v4.4.4: create job, kick off LLM+TTS in background, return
        // pause+redirect immediately. The /voice-poll endpoint will
        // either play the reply when ready or redirect back to itself
        // for another short pause. This keeps the call alive indefinitely
        // even when the LLM takes 20+ seconds.
        const jobId = createVoiceJob(callSid);
        const pollUrl = `${host}/api/twilio/voice-poll?jobId=${jobId}`;

        // Fire-and-forget async processing. Errors are caught + stored
        // on the job so /voice-poll can surface them gracefully.
        // v4.4.5: strategy='direct' forced so conversational questions
        // don't trigger a 30s+ explore/deliberation path. Tools still
        // available — direct mode is the minimum, not a tool block.
        (async () => {
          try {
            const existingSid = getCallSession(callSid);
            const voiceModel = (process.env.TWILIO_VOICE_MODEL
              || 'ollama/qwen3.5:cloud');
            const result = await processMessage(
              speechResult,
              'twilio-admin',
              `twilio-call-${callSid}`,
              {
                ...(existingSid ? { sessionId: existingSid } : {}),
                model: voiceModel,
                systemPrompt: voiceSystemPrompt,
                strategy: 'direct',
              },
              undefined,
              AbortSignal.timeout(85_000),
            );
            if (result?.sessionId) setCallSession(callSid, result.sessionId);

            let reply = (result?.content || '').trim();
            if (!reply) reply = "Got it.";
            if (reply.length > 400) reply = reply.slice(0, 390).replace(/\s\S*$/, '') + '…';

            const token = await synthesizeAndCache(reply, voice);
            if (!token) {
              failVoiceJob(jobId, 'tts failed');
              return;
            }
            completeVoiceJob(jobId, token, reply);
          } catch (e) {
            logger.warn(COMPONENT, `Twilio voice-gather async error: ${(e as Error).message}`);
            failVoiceJob(jobId, (e as Error).message);
          }
        })();

        // Return immediately with a short pause + redirect to the poll endpoint.
        res.type('text/xml').send(twimlPauseAndRedirect(pollUrl, 3));
      } catch (e) {
        logger.error(COMPONENT, `Twilio voice-gather error: ${(e as Error).message}`);
        res.status(500).type('text/xml').send(twimlSayAndHangup("Something went wrong."));
      }
    });

    // ── POST /api/twilio/voice-poll — async job polling ──
    // v4.4.4: Twilio redirects here while we process the LLM reply.
    // If the job is ready, play the audio + open a new <Gather>. If
    // not, pause another ~3s and redirect back to self. Hard cap at
    // ~15 rounds (~45s) then surface an error TwiML.
    // Accept both GET and POST — some Twilio retry paths use GET when
    // following a Redirect even if method was specified.
    const handleVoicePoll = async (req: express.Request, res: express.Response) => {
      try {
        if (!twilioEnabled) { res.type('text/xml').send(twimlReject()); return; }
        if (!checkTwilioAuth(req)) {
          logger.warn(COMPONENT, `voice-poll signature rejected (method=${req.method}, jobId=${req.query.jobId})`);
          res.status(403).send('forbidden'); return;
        }

        const jobId = (req.query.jobId as string) || '';
        const job = getVoiceJob(jobId);
        logger.info(COMPONENT, `voice-poll method=${req.method} jobId=${jobId.slice(0,8)} status=${job?.status || 'missing'}`);
        const { voice, publicHost } = getTwilioConfig();
        const host = publicHost.replace(/\/$/, '') || `https://${req.headers.host}`;
        const pollUrl = `${host}/api/twilio/voice-poll?jobId=${jobId}`;
        const gatherUrl = `${host}/api/twilio/voice-gather`;

        if (!job) {
          // Job expired or never existed. Treat as error.
          const txt = "Sorry boss, lost my train of thought. Say that again?";
          const tk = await synthesizeAndCache(txt, voice);
          if (tk) res.type('text/xml').send(twimlPlayAndGather(`${host}/api/twilio/audio/${tk}`, gatherUrl));
          else res.type('text/xml').send(twimlSayAndHangup(txt));
          return;
        }

        if (job.status === 'ready' && job.audioToken) {
          logger.info(COMPONENT, `Voice poll ready: job=${jobId.slice(0, 8)} reply="${(job.replyText || '').slice(0, 60)}"`);
          const audioUrl = `${host}/api/twilio/audio/${job.audioToken}`;
          res.type('text/xml').send(twimlPlayAndGather(audioUrl, gatherUrl));
          return;
        }

        if (job.status === 'error') {
          logger.warn(COMPONENT, `Voice poll error: ${job.error}`);
          const txt = "Hmm, I hit a snag. Try that again?";
          const tk = await synthesizeAndCache(txt, voice);
          if (tk) res.type('text/xml').send(twimlPlayAndGather(`${host}/api/twilio/audio/${tk}`, gatherUrl));
          else res.type('text/xml').send(twimlSayAndHangup(txt));
          return;
        }

        // Still pending — pause and redirect back. Cap the total wait
        // so a hung LLM doesn't keep the call alive forever.
        // v4.4.5: hard cap raised 40s→90s to fit tool-call chains,
        // and we drop a short "still on it" filler every ~9s so Tony
        // doesn't just hear dead air while we work.
        const age = Date.now() - job.createdAt;
        if (age > 90_000) {
          logger.warn(COMPONENT, `Voice poll timeout after ${age}ms`);
          failVoiceJob(jobId, 'timeout');
          const txt = "That one took too long. Say it again?";
          const tk = await synthesizeAndCache(txt, voice);
          if (tk) res.type('text/xml').send(twimlPlayAndGather(`${host}/api/twilio/audio/${tk}`, gatherUrl));
          else res.type('text/xml').send(twimlSayAndHangup(txt));
          return;
        }

        // Every ~9s of waiting, play a brief filler so the caller knows
        // we're alive. Fillers come from a short rotating list so it
        // doesn't sound robotic. Tracked per-job via a `fillerCount`
        // field on the job object.
        const jobAny = job as { status: string; createdAt: number; fillerCount?: number };
        const fillerCount = jobAny.fillerCount || 0;
        const shouldFiller = age > 9_000 && age - (fillerCount * 9_000) > 9_000;
        if (shouldFiller) {
          const fillers = [
            "Still on it, one sec.",
            "Working on it.",
            "Almost there, boss.",
            "Give me just a moment.",
          ];
          const filler = fillers[fillerCount % fillers.length];
          jobAny.fillerCount = fillerCount + 1;
          const tk = await synthesizeAndCache(filler, voice);
          if (tk) {
            res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${host}/api/twilio/audio/${tk}</Play>
  <Pause length="2"/>
  <Redirect method="POST">${pollUrl}</Redirect>
</Response>`);
            return;
          }
          // TTS failed — fall through to plain pause
        }
        res.type('text/xml').send(twimlPauseAndRedirect(pollUrl, 3));
      } catch (e) {
        logger.error(COMPONENT, `Twilio voice-poll error: ${(e as Error).message}`);
        res.status(500).type('text/xml').send(twimlSayAndHangup("Something went wrong."));
      }
    };
    app.post('/api/twilio/voice-poll', urlEncoded, handleVoicePoll);
    app.get('/api/twilio/voice-poll', handleVoicePoll);

    // ── POST /api/twilio/status-callback — call lifecycle events ──
    app.post('/api/twilio/status-callback', urlEncoded, (req, res) => {
      try {
        const callSid = (req.body?.CallSid as string) || '';
        const status = (req.body?.CallStatus as string) || '';
        const duration = (req.body?.CallDuration as string) || '';
        logger.info(COMPONENT, `Twilio call ${callSid.slice(0, 10)}... status=${status}${duration ? ` duration=${duration}s` : ''}`);
        if (status === 'completed' || status === 'failed' || status === 'canceled' || status === 'no-answer' || status === 'busy') {
          endCall(callSid);
        }
        res.sendStatus(200);
      } catch (e) {
        logger.warn(COMPONENT, `status-callback error: ${(e as Error).message}`);
        res.sendStatus(200);
      }
    });

    // ── GET /api/twilio/audio/:token — serve cached MP3 to Twilio ──
    // Unauthenticated on purpose: Twilio fetches these and passing a
    // bearer token through <Play> URLs is fiddly + leaks in logs.
    // Tokens are random 96-bit + 5-min TTL + garbage-collected, so the
    // exposure is a transient MP3 of synthesized speech (not secrets).
    app.get('/api/twilio/audio/:token', async (req, res) => {
      const token = req.params.token;
      const audio = await readCachedAudio(token);
      if (!audio) { res.status(404).send('expired'); return; }
      res.setHeader('Content-Type', audio.mime);
      res.setHeader('Content-Length', String(audio.buf.length));
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.send(audio.buf);
    });

    logger.info(COMPONENT, `Twilio voice endpoints registered: /api/twilio/voice-webhook, /api/twilio/voice-gather, /api/twilio/status-callback, /api/twilio/audio/:token`);
  }

  // ── Phase 3: Boot MCP servers, monitors, recipes, model switch, slash commands ──
  initSlashCommands();
  seedBuiltinRecipes();
  initMcpServers().catch((e) => logger.warn(COMPONENT, `MCP init error: ${e.message}`));
  mountMcpHttpEndpoints(app);

  // ── Persistent webhooks — reload saved webhooks ─────────────
  initPersistentWebhooks().catch((e) => logger.warn(COMPONENT, `Webhook init: ${(e as Error).message}`));

  // ── Cron scheduler — re-activate all persisted jobs ──────────
  initCronScheduler();

  // ── Autopilot — scheduled autonomous agent runs ─────────────
  initAutopilot(config);

  // ── VRAM Orchestrator — GPU memory management ───────────────
  if (config.vram?.enabled !== false) {
    import('../vram/orchestrator.js').then(({ initVRAMOrchestrator }) => {
      initVRAMOrchestrator().catch((e) => logger.warn(COMPONENT, `VRAM orchestrator init: ${(e as Error).message}`));
    }).catch(() => { /* optional */ });
  }

  // ── Command Post — agent governance layer ────────────────
  if (config.commandPost?.enabled) {
    initCommandPost(config.commandPost);
    initWakeupSystem();
    initHeartbeatScheduler();
    logger.info(COMPONENT, 'Command Post governance layer initialized (wakeup system active)');

    // v4.7.0: bootstrap specialist pool (Scout, Builder, Writer, Analyst)
    // once Command Post is up. Idempotent — safe to call every boot.
    try {
      const { ensureSpecialistsRegistered } = await import('../agent/specialists.js');
      await ensureSpecialistsRegistered();
    } catch (e) {
      logger.warn(COMPONENT, `Specialist bootstrap skipped: ${(e as Error).message}`);
    }
  }

  // v4.9.0: load/init stable identity. Persistent across restarts.
  // Session count ticks, version transitions logged, core hash checked
  // for tampering. Identity gets rendered into every agent's system
  // prompt via agent.ts (sync globalThis accessor).
  try {
    const { initIdentity, renderIdentityBlock, getIdentity } = await import('../memory/identity.js');
    const identity = initIdentity();
    logger.info(COMPONENT, `Identity loaded — session #${identity.tenure.sessionCount}, ${identity.driftLog.filter(d => d.resolution === 'pending').length} pending drift event(s)`);
    for (const ev of identity.driftLog.filter(d => d.resolution === 'pending').slice(-3)) {
      logger.warn('Identity', `Pending drift [${ev.kind}]: ${ev.detail.slice(0, 140)}`);
    }
    // Install a sync accessor so agent.ts buildSystemPrompt() can pull
    // the identity block without dynamic import on every message.
    (globalThis as unknown as { __titan_identity_block?: () => string }).__titan_identity_block = () => {
      const id = getIdentity();
      return id ? renderIdentityBlock(id) : '';
    };
  } catch (e) {
    logger.warn(COMPONENT, `Identity bootstrap skipped: ${(e as Error).message}`);
  }

  // v4.9.0-local.4: install the self-model provider. The self-model
  // synthesizes identity + recent performance + strengths/weaknesses
  // + integrity into a compact block injected into every system prompt.
  // Cached for 60s inside the module — the sync accessor returns the
  // cached block (falling through to empty when cache is cold).
  try {
    const { getSelfModel, renderSelfModelBlock } = await import('../memory/meta.js');
    let cachedBlock = '';
    let cachedAt = 0;
    const refresh = () => {
      (async () => {
        try {
          cachedBlock = await renderSelfModelBlock();
          cachedAt = Date.now();
        } catch { /* ok */ }
      })();
    };
    refresh();
    setInterval(refresh, 60_000).unref?.();
    (globalThis as unknown as { __titan_self_model_block?: () => string }).__titan_self_model_block = () => {
      // If cache is stale (> 2 min) return the old block anyway — the
      // async refresh runs out-of-band. Never blocks the prompt path.
      if (Date.now() - cachedAt > 120_000 && cachedBlock === '') {
        // First call before refresh finishes — do nothing.
        return '';
      }
      return cachedBlock;
    };
    // Also prime the self-model so the first agent turn has something.
    await getSelfModel();
    logger.info(COMPONENT, 'Self-model provider installed (60s refresh)');
  } catch (e) {
    logger.warn(COMPONENT, `Self-model bootstrap skipped: ${(e as Error).message}`);
  }

  // v4.9.0-local (Phase C): install working-memory provider. Injects
  // structured session state into the agent's system prompt when resuming
  // an in-flight task so TITAN doesn't start from scratch mid-work.
  try {
    const { renderSessionContext } = await import('../memory/workingMemory.js');
    (globalThis as unknown as {
      __titan_working_memory_block?: (sessionId: string) => string;
    }).__titan_working_memory_block = (sessionId: string) => {
      try { return renderSessionContext(sessionId); } catch { return ''; }
    };
    logger.info(COMPONENT, 'Working-memory provider installed');
  } catch (e) {
    logger.warn(COMPONENT, `Working-memory bootstrap skipped: ${(e as Error).message}`);
  }

  // v4.10.0-local (Phase B): install driver-status provider. Appends
  // live driver phase + blocked questions into the agent's system prompt,
  // so "what are you working on?" gets a real answer.
  try {
    const { renderDriverStatusBlock } = await import('../agent/driverAwareChat.js');
    (globalThis as unknown as { __titan_driver_status_block?: () => string | null }).__titan_driver_status_block = () => {
      try { return renderDriverStatusBlock(); } catch { return null; }
    };
    logger.info(COMPONENT, 'Driver-aware chat provider installed');
  } catch (e) {
    logger.warn(COMPONENT, `Driver-aware chat skipped: ${(e as Error).message}`);
  }

  // v4.9.0: install closed-loop signal providers for Soma drives. These
  // let the drive layer read live VRAM / telemetry / learning state via
  // a synchronous call without pulling in the whole dependency graph.
  try {
    const { getVRAMOrchestrator } = await import('../vram/orchestrator.js');
    const { getMetricsSummary } = await import('./metrics.js');
    const { getLearningStats } = await import('../memory/learning.js');

    // VRAM: refresh happens on the orchestrator's 10s cadence; we just
    // peek at the last known GPU state. If there's no GPU, the peeker
    // returns nothing and the drive treats that as "no signal."
    const g = globalThis as unknown as {
      __titan_vram_last?: { totalMB: number; freeMB: number; usedMB: number };
      __titan_metrics_summary?: () => { totalRequests: number; errorRate: number } | null;
      __titan_unresolved_error_patterns?: () => number;
    };
    setInterval(() => {
      (async () => {
        try {
          const orch = getVRAMOrchestrator();
          const snap = await orch.getSnapshot();
          if (snap?.gpu && typeof snap.gpu.totalMB === 'number' && snap.gpu.totalMB > 0) {
            g.__titan_vram_last = {
              totalMB: snap.gpu.totalMB,
              freeMB: snap.gpu.freeMB,
              usedMB: snap.gpu.usedMB ?? (snap.gpu.totalMB - snap.gpu.freeMB),
            };
          } else {
            g.__titan_vram_last = undefined;
          }
        } catch { /* best-effort */ }
      })();
    }, 15_000).unref?.();

    // Metrics: cheap synchronous read.
    g.__titan_metrics_summary = () => {
      try {
        const s = getMetricsSummary();
        return { totalRequests: s.totalRequests, errorRate: s.errorRate };
      } catch { return null; }
    };

    // Unresolved error patterns from the learning KB.
    // v4.10.0-local fix: use the new `unresolvedErrorPatterns` field that
    // filters by !resolution. Prior behavior used total count, which meant
    // marking patterns resolved didn't relieve curiosity drive pressure.
    g.__titan_unresolved_error_patterns = () => {
      try {
        const stats = getLearningStats();
        return stats.unresolvedErrorPatterns ?? stats.errorPatterns ?? 0;
      } catch { return 0; }
    };

    logger.info(COMPONENT, 'Drive signal providers installed (VRAM, metrics, learning)');
  } catch (e) {
    logger.warn(COMPONENT, `Drive signal bootstrap skipped: ${(e as Error).message}`);
  }

  // v4.9.0-local.4: register the self-repair daemon watcher. Runs every
  // 5 minutes; sweeps for stuck drives, stalled goals, episodic
  // anomalies, integrity dips, stale working-memory sessions. Files
  // 'self_repair' approvals for new findings. Human-in-the-loop: the
  // daemon proposes, Tony approves (or rejects).
  try {
    const { registerWatcher } = await import('../agent/daemon.js');
    const { runSelfRepairSweep } = await import('../safety/selfRepair.js');
    registerWatcher('self-repair', async () => {
      try { await runSelfRepairSweep(); } catch (e) { logger.debug(COMPONENT, `self-repair sweep: ${(e as Error).message}`); }
    }, 300_000);
    logger.info(COMPONENT, 'Self-repair daemon registered (5 min cadence)');
  } catch (e) {
    logger.warn(COMPONENT, `Self-repair daemon skipped: ${(e as Error).message}`);
  }

  // v4.10.0-local (Phase A): start the Goal Driver scheduler. This replaces
  // the passive "initiative picks one subtask per 5-min autopilot tick"
  // model with a persistent phase state machine per goal. Restart-safe:
  // resumes any non-terminal drivers from ~/.titan/driver-state/.
  try {
    const { registerSomaVerifier } = await import('../agent/somaFeedback.js');
    registerSomaVerifier();
    const { startDriverScheduler, resumeDriversAfterRestart } = await import('../agent/driverScheduler.js');
    const resumed = await resumeDriversAfterRestart();
    logger.info(COMPONENT, `Goal Driver resume: ${resumed.resumed} re-activated, ${resumed.cancelled} cancelled (goal no longer active), ${resumed.sweptStale} stale (>24h since lastTick) reaped`);
    startDriverScheduler(10_000, 5); // 10s tick, max 5 concurrent drivers
  } catch (e) {
    logger.warn(COMPONENT, `Goal Driver scheduler bootstrap skipped: ${(e as Error).message}`);
  }

  // v4.10.0-local (Phase B): daily digest cron. Generates a TL;DR at 9am
  // PDT + on every restart (so /api/digest/today always has fresh data).
  try {
    const { startDailyDigestCron } = await import('../agent/dailyDigest.js');
    startDailyDigestCron();
  } catch (e) {
    logger.warn(COMPONENT, `Daily digest cron skipped: ${(e as Error).message}`);
  }

  // v5.5.17: Dream Mode cron — opt-in via config.dream.enabled. Default
  // 03:30 local. Skips quietly when disabled. See src/agent/dreams.ts.
  try {
    const { startDreamCron } = await import('../agent/dreams.js');
    startDreamCron();
  } catch (e) {
    logger.warn(COMPONENT, `Dream cron skipped: ${(e as Error).message}`);
  }

  // v5.5.27: Persona A/B rollout monitor — opt-in via
  // personas.rollout.enabled. Re-evaluates every cohort on a cadence
  // (default 5 min) and auto-reverts candidates that regress vs
  // baseline. Skips quietly when disabled.
  try {
    const { startRolloutMonitor } = await import('../agent/personaRollout.js');
    startRolloutMonitor();
  } catch (e) {
    logger.warn(COMPONENT, `Persona rollout monitor skipped: ${(e as Error).message}`);
  }

  // v4.10.0-local (Phase C): mission scheduler — ticks active missions
  // (driver-of-drivers) every 15s. Missions coordinate multi-goal projects.
  try {
    const { listActiveMissions, tickMission } = await import('../agent/missionDriver.js');
    const missionTimer = setInterval(() => {
      void (async () => {
        try {
          for (const m of listActiveMissions()) {
            try { await tickMission(m.missionId); } catch { /* ok */ }
          }
        } catch { /* ok */ }
      })();
    }, 15_000);
    missionTimer.unref?.();
    logger.info(COMPONENT, 'Mission scheduler started (15s cadence)');
  } catch (e) {
    logger.warn(COMPONENT, `Mission scheduler skipped: ${(e as Error).message}`);
  }

  // v4.9.0-local.4: register the working-memory retire watcher. Every
  // hour, sweeps for in-flight sessions that haven't touched
  // lastActiveAt in > 24h and archives them to episodic as abandoned.
  try {
    const { registerWatcher } = await import('../agent/daemon.js');
    const { retireStaleSessions } = await import('../memory/workingMemory.js');
    registerWatcher('working-memory-retire', async () => {
      try { retireStaleSessions(); } catch (e) { logger.debug(COMPONENT, `working-memory retire: ${(e as Error).message}`); }
    }, 3_600_000);
  } catch (e) {
    logger.warn(COMPONENT, `Working-memory retire watcher skipped: ${(e as Error).message}`);
  }

  // v4.9.0-local.4: canary eval daemon. Runs the fixed golden-set
  // every 24h; if any task drops > 15% vs 7-day baseline, a
  // canary_regression approval fires for Tony to review. Defends
  // against silent quality degradation from model drift, context
  // bloat, or prompt accretion.
  try {
    const { registerWatcher } = await import('../agent/daemon.js');
    const { runCanarySweep } = await import('../safety/canaryEval.js');
    registerWatcher('canary-eval', async () => {
      try { await runCanarySweep(); } catch (e) { logger.debug(COMPONENT, `canary sweep: ${(e as Error).message}`); }
    }, 24 * 60 * 60 * 1000);
    logger.info(COMPONENT, 'Canary eval daemon registered (24h cadence)');
  } catch (e) {
    logger.warn(COMPONENT, `Canary eval daemon skipped: ${(e as Error).message}`);
  }

  // v4.8.0: Self-Modification Pipeline — auto-review newly captured
  // proposals and poll open PRs for merge/close outcomes.
  try {
    const selfModCfg = (config as unknown as { selfMod?: {
      enabled?: boolean;
      autoReview?: boolean;
      autoPR?: boolean;
      pollIntervalMs?: number;
    } }).selfMod;
    if (selfModCfg?.enabled) {
      logger.info(COMPONENT, 'Self-Modification Pipeline: enabled');
      const { pollOpenProposals } = await import('../agent/selfProposalLearning.js');
      const pollMs = selfModCfg.pollIntervalMs ?? 300_000;
      const pollTimer = setInterval(() => {
        pollOpenProposals().catch((e: Error) => logger.debug(COMPONENT, `selfMod poll: ${e.message}`));
      }, pollMs);
      (pollTimer as unknown as { unref?: () => void }).unref?.();

      // Auto-review: watch soma:proposal events for self-mod captures and
      // kick off specialist review when a new proposal has enough files.
      if (selfModCfg.autoReview !== false) {
        const { on: subscribeTrace } = await import('../substrate/traceBus.js');
        subscribeTrace('soma:proposal', async (payload) => {
          try {
            const pb = (payload as { proposedBy?: string }).proposedBy || '';
            if (!pb.startsWith('self-mod:')) return;
            const proposalId = (payload as { approvalId?: string }).approvalId;
            if (!proposalId) return;
            // Debounce: wait 2s for additional files in same session before reviewing
            setTimeout(async () => {
              try {
                const { reviewProposal } = await import('../agent/selfProposalReview.js');
                const reviewed = await reviewProposal(proposalId);
                // Auto-PR if configured + approved
                if (reviewed?.status === 'approved' && selfModCfg.autoPR) {
                  const { createProposalPR } = await import('../agent/selfProposalPR.js');
                  await createProposalPR(proposalId);
                }
              } catch (e) {
                logger.warn(COMPONENT, `selfMod auto-review failed: ${(e as Error).message}`);
              }
            }, 2000);
          } catch (e) {
            logger.debug(COMPONENT, `selfMod subscribe handler: ${(e as Error).message}`);
          }
        });
      }
    }
  } catch (e) {
    logger.warn(COMPONENT, `selfMod bootstrap skipped: ${(e as Error).message}`);
  }

  // ── Daemon — persistent agent awareness loop ────────────────
  initDaemon();

  // ── Morning Briefing — send once per day in 6am–12pm window ──
  checkAndSendBriefing(async (msg) => {
    broadcast({
      type: 'message',
      direction: 'outbound',
      channel: 'system',
      userId: 'titan',
      content: msg,
      timestamp: new Date().toISOString(),
    });
  }).catch((e: Error) => logger.warn(COMPONENT, `Briefing error: ${e.message}`));

  // Wire monitor triggers to agent
  setMonitorTriggerHandler(async (monitor, event) => {
    const prompt = `[AUTO-TRIGGER: ${monitor.name}] ${event.detail}\n\nYour task: ${monitor.prompt}`;
    const response = await processMessage(prompt, 'monitor', 'system');
    broadcast({ type: 'monitor_trigger', monitor: monitor.name, response: response.content, event });
    logger.info(COMPONENT, `Monitor "${monitor.name}" responded: ${response.content.slice(0, 100)}`);
  });
  initMonitors();

  // ── Operator Alerting ──────────────────────────────────────────
  const { initAlerts } = await import('../agent/alerts.js');
  initAlerts();

  // ── Mesh Networking ───────────────────────────────────────────
  if (config.mesh.enabled && !config.mesh.secret) {
    logger.warn(COMPONENT, 'Mesh is enabled but no secret is set. Run `titan mesh --init` to generate one. Mesh disabled.');
  }
  if (config.mesh.enabled && config.mesh.secret) {
    const { getOrCreateNodeId } = await import('../mesh/identity.js');
    const { startDiscovery, setOnPeerDiscovered, setConnectApprovedPeer, setMaxPeers } = await import('../mesh/discovery.js');
    const { connectToPeer, startHeartbeat, startRouteBroadcast } = await import('../mesh/transport.js');
    const nodeId = getOrCreateNodeId();

    // Set max peers limit
    setMaxPeers(config.mesh.maxPeers);

    // Notify dashboard when new peers are discovered
    setOnPeerDiscovered((peer) => {
      broadcast({
        type: 'mesh_peer_discovered',
        peer: {
          nodeId: peer.nodeId,
          hostname: peer.hostname,
          address: peer.address,
          port: peer.port,
          version: peer.version,
          models: peer.models,
          discoveredVia: peer.discoveredVia,
        },
      });
      logger.info(COMPONENT, `New TITAN node discovered: ${peer.hostname} (${peer.address}:${peer.port}) — approve via dashboard or CLI`);
    });

    // Wire up WebSocket connections for approved peers
    setConnectApprovedPeer((peer) => {
      if (config.mesh.secret) {
        connectToPeer(peer.address, peer.port, nodeId, config.mesh.secret)
          .then((ok) => {
            if (ok) {
              broadcast({ type: 'mesh_peer_connected', peer });
              logger.info(COMPONENT, `Connected to approved peer: ${peer.hostname}`);
            }
          })
          .catch(() => logger.debug(COMPONENT, `Approved peer unreachable: ${peer.hostname}`));
      }
    });

    await startDiscovery(nodeId, port, {
      mdns: config.mesh.mdns,
      tailscale: config.mesh.tailscale,
      autoApprove: config.mesh.autoApprove,
      peerStaleTimeoutMs: config.mesh.peerStaleTimeoutMs,
    });

    // Auto-bind to 0.0.0.0 when mesh is enabled (so peers can reach us)
    if (host === '127.0.0.1') {
      host = '0.0.0.0';
      logger.info(COMPONENT, 'Mesh enabled — binding to 0.0.0.0 (was 127.0.0.1) so peers can connect');
    }

    // Connect to static peers
    if (config.mesh.staticPeers.length > 0) {
      for (const addr of config.mesh.staticPeers) {
        const parts = addr.split(':');
        const peerHost = parts[0];
        const peerPort = parseInt(parts[1] || '48420', 10);
        if (!peerHost || isNaN(peerPort)) {
          logger.warn(COMPONENT, `Invalid static peer address: "${addr}" — expected host:port (e.g. 192.168.1.100:48420)`);
          continue;
        }
        connectToPeer(peerHost, peerPort, nodeId, config.mesh.secret)
          .catch(() => logger.debug(COMPONENT, `Static peer unreachable: ${addr}`));
      }
    }

    // Start heartbeat with dynamic model discovery
    startHeartbeat(nodeId, async () => {
      const { getActiveRemoteTaskCount: getTaskCount } = await import('../mesh/transport.js');
      const models = await discoverAllModels();
      const cpu = getCpuLoad();
      const taskLoad = getTaskCount() / Math.max(config.mesh.maxRemoteTasks, 1);
      const load = Math.min(1, cpu * 0.4 + taskLoad * 0.6);
      return {
        hostname: osHostname(),
        version: TITAN_VERSION,
        models: models.map(m => m.id),
        load: Math.round(load * 100) / 100,
      };
    }, config.mesh.heartbeatIntervalMs || 60_000);

    // Start distance-vector route broadcasting
    startRouteBroadcast(30_000);

    const mode = config.mesh.autoApprove ? 'auto-approve' : 'approval-required';
    logger.info(COMPONENT, `Mesh active — Node: ${nodeId.slice(0, 8)}... | mDNS: ${config.mesh.mdns} | Tailscale: ${config.mesh.tailscale} | Max peers: ${config.mesh.maxPeers} | Mode: ${mode}`);
  }

  // Start server
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(COMPONENT, `Port ${port} is already in use. Mission Control is likely already running in the background.`);
      logger.info(COMPONENT, `You can access it at http://${host}:${port}`);
      process.exit(1);
    } else {
      logger.error(COMPONENT, `Server error: ${err.message}`);
    }
  });

  // Hunt Finding #04 (2026-04-14): detect partial port conflicts.
  // If the user has a zombie gateway bound to 127.0.0.1:PORT and starts a
  // new one on 0.0.0.0:PORT, BOTH bind successfully (different addresses).
  // But localhost traffic routes to the zombie, not the new gateway — silent
  // confusion for the user. Pre-check via a TCP probe to localhost:PORT.
  // If something responds, log a clear warning before proceeding.
  try {
    await new Promise<void>((resolvePromise) => {
      const probe = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
      probe.once('connect', () => {
        logger.warn(COMPONENT,
          `[PortConflictProbe] Something is already listening on 127.0.0.1:${port}. ` +
          `The new gateway will bind to ${host}:${port} but localhost traffic may be routed to the existing process. ` +
          `Kill any stale processes (lsof -i :${port}) before starting.`,
        );
        probe.destroy();
        resolvePromise();
      });
      probe.once('error', () => {
        // ECONNREFUSED = port is free on localhost. Good.
        resolvePromise();
      });
      probe.once('timeout', () => {
        probe.destroy();
        resolvePromise();
      });
    });
  } catch {
    // Probe failure is non-fatal — don't block startup
  }

  // ── Internal Health Monitor (60s interval) ─────────────────────
  const ollamaBaseUrl = config.providers?.ollama?.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const ttsBaseUrl = config.voice?.ttsUrl || 'http://localhost:5005';

  healthMonitorInterval = setInterval(() => {  // R1: avoid async in setInterval to prevent unhandled rejections
    void (async () => {
    try {
    const now = Date.now();
    healthState.lastCheck = new Date().toISOString();

    // Check Ollama
    try {
      const resp = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      healthState.ollamaHealthy = resp.ok;
    } catch {
      if (healthState.ollamaHealthy) {
        logger.warn(COMPONENT, 'Health monitor: Ollama is unreachable');
      }
      healthState.ollamaHealthy = false;
    }

    // Check TTS — F5-TTS exposes /health for fast probes; the /v1/audio/speech
    // synthesize-and-return path is too slow for a periodic monitor.
    try {
      const resp = await fetch(`${ttsBaseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      healthState.ttsHealthy = resp.ok;
    } catch {
      healthState.ttsHealthy = false;
    }

    // Check for stuck LLM requests (same count for > 5 minutes)
    if (activeLlmRequests > 0 && activeLlmRequests === healthState.lastActiveLlm) {
      if (now - healthState.lastActiveLlmTime > 300_000) {
        if (!healthState.stuckDetected) {
          logger.warn(COMPONENT, `Health monitor: ${activeLlmRequests} LLM requests stuck for >5 minutes`);
          healthState.stuckDetected = true;
        }
      }
    } else {
      healthState.lastActiveLlm = activeLlmRequests;
      healthState.lastActiveLlmTime = now;
      healthState.stuckDetected = false;
    }

    // Check memory usage
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    if (heapMB > 1500) {
      logger.warn(COMPONENT, `Health monitor: High heap usage — ${heapMB}MB`);
    }

    // Enforce configured memory limit — shed load if exceeded
    const memoryLimitMB = config.security?.maxMemoryMB || 2048;
    if (rssMB > memoryLimitMB * 0.9) {
      logger.error(COMPONENT, `Memory pressure — RSS ${rssMB}MB is above 90% of limit (${memoryLimitMB}MB). Reducing max concurrent requests.`);
      maxConcurrentOverride = Math.max(1, (maxConcurrentOverride ?? config.security.maxConcurrentTasks ?? 5) - 1);
    } else if (rssMB < memoryLimitMB * 0.7 && maxConcurrentOverride !== null) {
      maxConcurrentOverride = null; // Reset when memory recovers
    }

    // Enforce disk write limit (approximate via titan home dir size)
    try {
      const diskLimitMB = config.security?.maxDiskWriteMB || 1024;
      const { spawnSync } = await import('child_process');
      const du = spawnSync('du', ['-sm', TITAN_HOME], { encoding: 'utf-8', timeout: 5000 });
      const usedMB = parseInt(du.stdout?.split('\t')[0] || '0', 10);
      if (usedMB > diskLimitMB * 0.9) {
        logger.error(COMPONENT, `Disk pressure — ${usedMB}MB used in ${TITAN_HOME}, above 90% of limit (${diskLimitMB}MB). Pausing non-essential writes.`);
      }
    } catch { /* du not available or failed — non-critical */ }

    // Keep primary agent heartbeat alive for Command Post
    try { reportHeartbeat('default'); } catch { /* non-critical */ }
    } catch (err) {
      logger.error(COMPONENT, `Health monitor error: ${(err as Error).message}`);
    }
    })();
  }, 60_000);
  healthMonitorInterval.unref();

  logger.info(COMPONENT, 'Health monitor started (60s interval)');

  // Catch unhandled promise rejections to prevent silent crashes + report
  // (v5.0 "Spacewalk"): reports go to the remote collector only when
  // `telemetry.enabled` AND `telemetry.crashReports` are both true AND the
  // user has previously consented via the SetupWizard. HOME path is stripped
  // from the stack to prevent personal-path leakage.
  //
  // Secret-scrubbing pass: removes API keys, bearer tokens, and URLs with
  // embedded credentials before the payload leaves the machine.
  const SECRET_PATTERNS = [
    // Bearer / Basic auth headers
    /\b[Bb]earer\s+[A-Za-z0-9_\-.]{20,}/g,
    /\b[Bb]asic\s+[A-Za-z0-9+/=]{20,}/g,
    // API key prefixes (OpenAI, Anthropic, Groq, etc.)
    /\b(sk|pk)-[A-Za-z0-9]{20,}/g,
    /\b([a-zA-Z]{2,}_[a-zA-Z0-9]{16,})/g,
    // Generic hex tokens (32+ chars) — conservative to avoid scrubbing file hashes
    /\b[0-9a-f]{64,}\b/gi,
    // URLs with credentials
    /https?:\/\/[^\s:]+:[^\s@]+@[^\s/]+/g,
    // Private keys / PEM blocks
    /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]{100,}-----END [A-Z ]+ PRIVATE KEY-----/g,
  ];
  function scrubSecrets(text: string): string {
    let cleaned = text;
    for (const pattern of SECRET_PATTERNS) {
      cleaned = cleaned.replace(pattern, '[REDACTED]');
    }
    return cleaned;
  }

  const reportCrash = async (kind: 'unhandledRejection' | 'uncaughtException', err: unknown) => {
    try {
      const cfg = loadConfig();
      if (!cfg.telemetry?.enabled) return;
      if (!(cfg.telemetry as unknown as { crashReports?: boolean })?.crashReports) return;
      // v5.0.1: removed consentedAt gate so users upgrading from 4.x keep crash
      // reporting without re-running onboarding. The SetupWizard still stamps
      // consentedAt for new installs; we simply don't require it here.
      const { sendRemoteAnalytics } = await import('../analytics/collector.js');
      const { getOrCreateNodeId } = await import('../mesh/identity.js');
      const home = homedir();
      const stackRaw = (err instanceof Error ? (err.stack || err.message) : String(err));
      const stack = scrubSecrets(stackRaw.split(home).join('$HOME')).slice(0, 4000);
      const message = scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
      const fingerprint = `${kind}:${(message.match(/[A-Z][a-zA-Z0-9_]+Error/) || [message])[0]}`.slice(0, 128);
      await sendRemoteAnalytics({
        type: 'error',
        installId: getOrCreateNodeId(),
        version: TITAN_VERSION,
        message,
        stack,
        fingerprint,
        context: { kind },
      });
    } catch {
      // Crash reporting is best-effort
    }
  };

  process.on('unhandledRejection', (reason) => {
    logger.error(COMPONENT, `Unhandled rejection: ${reason}`);
    void reportCrash('unhandledRejection', reason);
  });

  // Catch uncaught exceptions — log and exit gracefully to allow systemd/docker restart
  process.on('uncaughtException', (err) => {
    logger.error(COMPONENT, `Uncaught exception: ${err.message}\n${err.stack || ''}`);
    void reportCrash('uncaughtException', err);
    // Give logger + crash report time to flush before exiting
    setTimeout(() => {
      process.exit(1);
    }, 1500).unref();
  });

  // ── Graceful Shutdown ───────────────────────────────────────────
  // ── Lifecycle Manager — coordinated shutdown registry ──────
  const lm = getLifecycleManager();
  lm.register('f5tts', () => Promise.resolve(), () => new Promise<void>((resolve) => {
    for (const pidPath of [join(homedir(), '.titan', 'f5tts.pid'), join(homedir(), '.titan', 'qwen3tts.pid')]) {
      try {
        if (!fs.existsSync(pidPath)) continue;
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim());
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(pidPath);
        logger.info(COMPONENT, `Stopped F5-TTS server (${pidPath})`);
      } catch { /* already stopped */ }
    }
    resolve();
  }));
  lm.register('autopilot', () => Promise.resolve(), () => { stopAutopilot(); return Promise.resolve(); });
  lm.register('daemon', () => Promise.resolve(), () => { stopDaemon(); return Promise.resolve(); });
  lm.register('commandpost', () => Promise.resolve(), () => { shutdownCommandPost(); return Promise.resolve(); });
  lm.register('tunnel', () => Promise.resolve(), () => { stopTunnel(); return Promise.resolve(); });

  const gracefulShutdown = async (signal: string) => {
    logger.info(COMPONENT, `Received ${signal} — shutting down gracefully...`);
    await lm.stopAll();
    closeMemory();
    flushGraph();
    try { const { flushVectors } = await import('../memory/vectors.js'); flushVectors(); } catch { /* ignore */ }
    await stopGateway();
    logger.info(COMPONENT, 'Gateway stopped. Goodbye.');
    process.exit(0);
  };
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Global error handler — prevent stack trace leaks
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Invalid JSON in request body' });
      return;
    }
    logger.error(COMPONENT, `Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  httpServer.listen(port, host, () => {
    const proto = useHttps ? 'https' : 'http';
    const wsProto = useHttps ? 'wss' : 'ws';
    logger.info(COMPONENT, `Gateway listening on ${proto}://${host}:${port}`);
    logger.info(COMPONENT, `Dashboard: ${proto}://${host}:${port}`);
    logger.info(COMPONENT, `WebSocket: ${wsProto}://${host}:${port}`);
    logger.info(COMPONENT, `API: ${proto}://${host}:${port}/api/health`);
    logger.info(COMPONENT, `\nChannels: ${Array.from(channels.values()).map((c) => `${c.displayName} (${c.getStatus().connected ? '✅' : '❌'})`).join(', ')}`);
    logger.info(COMPONENT, `Skills: ${getSkills().length} loaded`);
    logger.info(COMPONENT, `Tools: ${getRegisteredTools().length} registered`);

    // v6.0.1 — Model-agnostic boot diagnostic. Log which provider TITAN
    // resolved for the default agent model + why. Users see at a glance
    // whether the picker chose what they expected (e.g. "openai because
    // OPENAI_API_KEY is set") and can correct their env / config.
    try {
      // Lazy require so the picker stays tree-shakeable + side-effect-free.
      void import('../providers/defaultModel.js').then(({ pickDefaultModel }) => {
        const pick = pickDefaultModel();
        logger.info(COMPONENT, `Default model: ${pick.model} (${pick.provider}) — ${pick.reason}`);
      }).catch(() => { /* non-critical */ });
    } catch { /* non-critical */ }

    // Friendly update notice for upgraders
    try {
      const markerPath = join(homedir(), '.titan', 'install-marker.json');
      if (fs.existsSync(markerPath)) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
        if (marker.previousVersion && marker.previousVersion !== TITAN_VERSION) {
          logger.info(COMPONENT, `\n🚀 Welcome to TITAN v${TITAN_VERSION}! Upgraded from v${marker.previousVersion}.`);
          logger.info(COMPONENT, `   What's new: PostHog analytics (opt-in), enriched telemetry, secret-scrubbed crash reports.`);
          logger.info(COMPONENT, `   Your config and settings are untouched. See PRIVACY.md for details.\n`);
        }
      }
    } catch { /* non-critical */ }

    // Start Cloudflare Tunnel if enabled
    if (config.tunnel?.enabled) {
      startTunnel(port, config.tunnel).catch((e) => {
        logger.error(COMPONENT, `Tunnel start failed: ${(e as Error).message}`);
      });
    }

    // Start analytics collection (telemetry must be enabled)
    recordStartupAnalytics().catch(() => {});
    startHeartbeatAnalytics(() => listSessions().length);
  });
}
