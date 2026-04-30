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
import { homedir, hostname as osHostname, cpus, loadavg } from 'os';
import { randomBytes, timingSafeEqual } from 'crypto';
import { exec, execSync, spawn } from 'child_process';
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
import { ZulipChannel } from '../channels/zulip.js';
import { MessengerChannel } from '../channels/messenger.js';
import { initAgents, routeMessage, listAgents } from '../agent/multiAgent.js';
import { createOpenAICompatRouter } from '../gateway/openai-compat.js';
import type { ChannelAdapter, InboundMessage } from '../channels/base.js';
import logger, { initFileLogger } from '../utils/logger.js';
import { TITAN_VERSION, TITAN_NAME, TITAN_LOGS_DIR, TITAN_HOME } from '../utils/constants.js';
import { collectSystemProfile, recordStartupAnalytics, startHeartbeatAnalytics } from '../analytics/collector.js';
import { getUpdateInfo } from '../utils/updater.js';
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
import { startTunnel, stopTunnel, getTunnelStatus } from '../utils/tunnel.js';
import { createPaperclipRouter, createPaperclipUIRouter } from './routes/paperclip.js';
import { createTracesRouter } from './routes/traces.js';
import { createCheckpointsRouter } from './routes/checkpoints.js';
import { createCompaniesRouter } from './routes/companies.js';
import { createCommandPostRouter } from './routes/commandPost.js';
import { createAdminRouter } from './routes/adminRouter.js';
import { createTeamsRecipesRouter } from './routes/teamsRecipes.js';
import { createFilesRouter } from './routes/files.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createSkillsRouter } from './routes/skills.js';
import { createOrganismRouter } from './routes/organism.js';
import { createMeshRouter } from './routes/mesh.js';
import { createTestsRouter } from './routes/tests.js';
import { createSystemRouter } from './routes/systemRouter.js';

import { createSocialRouter } from './routes/socialRouter.js';
import { createWatchRouter } from './routes/watchRouter.js';
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
const VOICE_POISON_PATTERNS = [
    /i completed the tool operations/i,
    /i wasn't able to execute tools/i,
    /i completed the operations/i,
    /let me know if you need anything else\.?\s*$/i,
];
const F5_TTS_DEFAULT_VOICES = ['andrew'];

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

function loadAuthTokens(): Map<string, { createdAt: number; userId: string }> {
    const map = new Map<string, { createdAt: number; userId: string }>();
    try {
        if (fs.existsSync(AUTH_TOKENS_PATH)) {
            const raw = JSON.parse(fs.readFileSync(AUTH_TOKENS_PATH, 'utf-8'));
            if (Array.isArray(raw)) {
                const ttlMs = 24 * 60 * 60 * 1000;
                const now = Date.now();
                for (const item of raw) {
                    if (item && typeof item.token === 'string' && typeof item.createdAt === 'number' && typeof item.userId === 'string') {
                        if (now - item.createdAt <= ttlMs) {
                            map.set(item.token, { createdAt: item.createdAt, userId: item.userId });
                        }
                    }
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

// Clean expired tokens every 10 minutes
tokenCleanupInterval = setInterval(() => {
    const now = Date.now();
    const ttlMs = 24 * 60 * 60 * 1000;
    for (const [tok, entry] of authTokens) {
        if (now - entry.createdAt > ttlMs) authTokens.delete(tok);
    }
    saveAuthTokens();
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
    const ttlMs = 24 * 60 * 60 * 1000; // 24 hours
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
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string);
    if (isValidToken(token, cfg)) { next(); return; }
    res.status(401).json({ error: 'Unauthorized' });
  });

  // ── Command Post availability guard ──────────────────────────
  app.use('/api/command-post', (_req, res, next) => {
    if (isCommandPostEnabled()) { next(); return; }
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
  app.get('/api/stats', (_req, res) => {
    const usage = getUsageStats();
    const cfg = loadConfig();
    const activeModel = cfg.agent.model || '';
    const mem = process.memoryUsage();
    const activeAgents = listAgents().filter(a => a.status === 'running').length;
    const activeSessions = listSessions().length;
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
      health: {
        ollamaHealthy: healthState.ollamaHealthy,
        ttsHealthy: healthState.ttsHealthy,
        lastCheck: healthState.lastCheck,
        stuckDetected: healthState.stuckDetected,
        uptimeSeconds: Math.round(process.uptime()),
        memoryUsageMB: Math.round(mem.heapUsed / 1024 / 1024),
        activeLlmRequests,
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
    const { content, channel: rawChannel, userId = 'api-user', agentId, sessionId: requestedSessionId, model: requestedModel, systemPromptAppendix } = req.body;
    // Default channel to 'webchat' for browser-based Mission Control clients.
    // This enables the interactive plan approval flow (show plan → user approves/denies).
    // Programmatic API callers can explicitly pass channel: 'api' to auto-approve plans.
    const channel = rawChannel || (req.headers.accept === 'text/event-stream' ? 'webchat' : 'api');
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a non-empty string' });
      return;
    }

    const safeUserId = channel === 'api' ? 'api-user' : (userId || 'api-user');

    // ═─ System Widget Shortcut ─═════════════════════════════════════
    // Fast-path: if the user is asking for a known system widget, bypass
    // the LLM entirely and emit the _____widget gate directly. This is
    // reliable, instant, and avoids model tool-call unpredictability.
    const systemWidgetShortcuts: Array<{ pattern: RegExp; source: string; name: string; w: number; h: number }> = [
        { pattern: /\b(?:backups?|snapshots?|archives?)\b/i, source: 'system:backup', name: 'Backup Manager', w: 6, h: 6 },
        { pattern: /\b(?:training|train|specialists?|models?)\b/i, source: 'system:training', name: 'Training Dashboard', w: 6, h: 6 },
        { pattern: /\b(?:recipes?|playbooks?|workflows?|jarvis)\b/i, source: 'system:recipes', name: 'Recipe Kitchen', w: 6, h: 6 },
        { pattern: /\b(?:vram|gpu|memory|nvidia)\b/i, source: 'system:vram', name: 'VRAM Monitor', w: 6, h: 6 },
        { pattern: /\b(?:teams?|members?|roles?|permissions?|rbac)\b/i, source: 'system:teams', name: 'Team Hub', w: 6, h: 6 },
        { pattern: /\b(?:cron|schedules?|jobs?|timers?)\b/i, source: 'system:cron', name: 'Cron Scheduler', w: 6, h: 6 },
        { pattern: /\b(?:checkpoints?|restores?|save state)\b/i, source: 'system:checkpoints', name: 'Checkpoints', w: 6, h: 5 },
        { pattern: /\b(?:organism|drives?|safety|alerts?|guardrails?)\b/i, source: 'system:organism', name: 'Organism Monitor', w: 6, h: 6 },
        { pattern: /\b(?:fleet|nodes?|routes?|mesh)\b/i, source: 'system:fleet', name: 'Fleet Router', w: 6, h: 5 },
        { pattern: /\b(?:captcha|browsers?|form fill|web automation)\b/i, source: 'system:browser', name: 'Browser Tools', w: 6, h: 5 },
        { pattern: /\b(?:paperclip|sidecars?|helpers?)\b/i, source: 'system:paperclip', name: 'Paperclip', w: 6, h: 5 },
        { pattern: /\b(?:tests?|flaky|failing|coverage|eval)\b/i, source: 'system:eval', name: 'Test Lab', w: 6, h: 6 },
    ];
    const matchedShortcut = systemWidgetShortcuts.find(s => s.pattern.test(content));
    if (matchedShortcut) {
        const gateText = `_____widget\n{ "name": "${matchedShortcut.name}", "format": "system", "source": "${matchedShortcut.source}", "w": ${matchedShortcut.w}, "h": ${matchedShortcut.h} }`;
        const responseText = `Added the **${matchedShortcut.name}** widget to your canvas.`;
        titanRequestsTotal.increment({ channel, status: 'ok' });
        if (req.headers.accept === 'text/event-stream') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.flushHeaders();
            res.write(`event: token\ndata: ${JSON.stringify({ text: responseText })}\n\n`);
            res.write(`event: token\ndata: ${JSON.stringify({ text: '\n\n' + gateText })}\n\n`);
            res.write(`event: done\ndata: ${JSON.stringify({ content: responseText + '\n\n' + gateText, sessionId: requestedSessionId || null, durationMs: 0, toolsUsed: [] })}\n\n`);
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
          res.write(`event: done\ndata: ${JSON.stringify({ content: slashResult.response, sessionId: null, durationMs: 0 })}\n\n`);
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
        res.write(`event: done\ndata: ${JSON.stringify({ error: 'Server busy' })}\n\n`);
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
    try {
      if (wantsSSE) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        req.on('close', () => { clientDisconnected = true; });

        const safeWrite = (data: string) => {
          if (clientDisconnected) return;
          try { res.write(data); } catch { clientDisconnected = true; }
        };

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
      if (wantsSSE && !clientDisconnected) {
        try { res.write(`event: done\ndata: ${JSON.stringify(structured)}\n\n`); res.end(); } catch { /* client gone */ }
      } else if (!wantsSSE) {
        res.status(structured.status).json(structured);
      }
    } finally {
      activeLlmRequests--;
      titanActiveSessions.dec();
      const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
      titanRequestDuration.observe(durationSec, { channel });
      if (requestedSessionId) sessionAborts.delete(requestedSessionId);
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

    try {
      const config = loadConfig();
      const modelId = model || config.agent.model || 'anthropic/claude-sonnet-4-20250514';
      const systemMessages = [{ role: 'system' as const, content: `You are TITAN, an intelligent assistant.` }];
      const userMessages = [{ role: 'user' as const, content }];

      for await (const chunk of chatStream({ model: modelId, messages: [...systemMessages, ...userMessages], maxTokens: config.agent.maxTokens, temperature: config.agent.temperature })) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === 'done' || chunk.type === 'error') break;
      }
    } catch (error) {
      logger.error(COMPONENT, `Stream error: ${(error as Error).message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'The assistant hit a snag. Please refresh and try again.' })}\n\n`);
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

  // Update System endpoints
  app.get('/api/update', async (_req, res) => {
    const info = await getUpdateInfo();
    res.json(info);
  });

  app.post('/api/update', (req, res) => {
    const isLocalDev = fs.existsSync(join(process.cwd(), '.git'));
    const isSystemd = fs.existsSync('/run/systemd/system') ||
                      fs.existsSync(join(process.cwd(), '.systemd-service'));
    const restart = req.body?.restart === true;

    let command: string;
    let postCommand: string | null = null;

    if (isLocalDev) {
      // Development checkout — pull source + build
      command = 'git pull && npm run build';
      if (restart) {
        // Write restart script + exit
        postCommand = 'restart';  // handled below
      }
    } else if (isSystemd) {
      // Production systemd deployment — pull from git repo + restart service
      command = 'git pull && npm run build';
      if (restart) {
        postCommand = 'systemctl';
      }
    } else {
      // Global npm install — works only when user has write access to prefix
      command = 'npm update -g titan-agent';
    }

    logger.info(COMPONENT, `Triggering update: ${command} (isDev=${isLocalDev}, isSystemd=${isSystemd}, restart=${restart})`);

    exec(command, { timeout: 180_000 }, (error, stdout, _stderr) => {
      if (error) {
        logger.error(COMPONENT, `Update failed: ${error.message}`);
        if (!res.headersSent) res.json({ ok: false, error: error.message });
        return;
      }

      logger.info(COMPONENT, `Update completed successfully.\\n${stdout}`);
      if (!res.headersSent) {
        res.json({ ok: true, message: 'Update completed', restarting: restart, output: stdout.slice(-500) });
      }

      if (restart) {
        logger.info(COMPONENT, 'Scheduling restart in 2 seconds...');
        const cwd = process.cwd();

        if (postCommand === 'systemctl') {
          // Production: use systemctl to restart (requires user passwordless sudo rights)
          const scriptPath = '/tmp/titan-restart.sh';
          fs.writeFileSync(scriptPath, [
            '#!/bin/bash',
            'sleep 2',
            `cd "${cwd}"`,
            'sudo systemctl restart titan-gateway',
          ].join('\n'), { mode: 0o755 });
          spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
          // Dev or global: spawn node directly
          const scriptPath = '/tmp/titan-restart.sh';
          fs.writeFileSync(scriptPath, [
            '#!/bin/bash',
            'sleep 2',
            `cd "${cwd}"`,
            'nohup node dist/cli/index.js gateway >> /tmp/titan-gateway.log 2>&1 &',
          ].join('\n'), { mode: 0o755 });
          spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
        }

        setTimeout(() => {
          logger.info(COMPONENT, 'Exiting for restart...');
          process.exit(0);
        }, 1000);
      }
    });
  });

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
  app.get('/api/models', async (_req, res) => {
    const cfg = loadConfig();
    const models = await discoverAllModels();
    // Group by provider
    const grouped: Record<string, string[]> = {};
    for (const m of models) {
      if (!grouped[m.provider]) grouped[m.provider] = [];
      grouped[m.provider].push(m.id);
    }
    res.json({
      ...grouped,
      current: cfg.agent.model,
      aliases: getModelAliases(),
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
  app.use('/api/files', createFilesRouter());

  // ── System API (cron, self-improve, training, autoresearch) ──
  app.use('/api', createSystemRouter());

  // ── Voice ──────────────────────────────────────────────────
  app.get('/api/voice/status', async (_req, res) => {
    const cfg = loadConfig();
    const voice = cfg.voice;
    if (!voice.enabled) {
      res.json({ available: false, reason: 'Voice not enabled in config' });
      return;
    }
    try {
      // Ping LiveKit server health endpoint
      const livekitHttp = voice.livekitUrl.replace('ws://', 'http://').replace('wss://', 'https://');
      const resp = await fetch(livekitHttp, { signal: AbortSignal.timeout(3000) });
      res.json({
        available: resp.ok,
        livekitUrl: voice.livekitUrl,
        ttsVoice: voice.ttsVoice,
      });
    } catch {
      res.json({ available: false, livekitUrl: voice.livekitUrl, reason: 'LiveKit server unreachable' });
    }
  });

  app.get('/api/voice/config', (_req, res) => {
    const cfg = loadConfig();
    res.json(cfg.voice);
  });

  // LiveKit token generation (ported from titan-voice-ui)
  app.post('/api/livekit/token', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.voice?.enabled) {
      res.status(404).json({ error: 'Voice not enabled' });
      return;
    }
    if (!cfg.voice.livekitApiKey || !cfg.voice.livekitApiSecret) {
      res.status(503).json({ error: 'LiveKit not configured — set voice.livekitApiKey and voice.livekitApiSecret in titan.json' });
      return;
    }
    try {
      const lkModule = 'livekit-server-sdk';
      const livekitSdk: any = await import(lkModule).catch(() => null);
      if (!livekitSdk?.AccessToken) {
        res.status(503).json({ error: 'livekit-server-sdk not installed. Run: npm install livekit-server-sdk' });
        return;
      }
      const { AccessToken } = livekitSdk;
      const participantIdentity = `voice_user_${Math.floor(Math.random() * 10_000)}`;
      const roomName = `voice_room_${Math.floor(Math.random() * 10_000)}`;
      const at = new AccessToken(cfg.voice.livekitApiKey, cfg.voice.livekitApiSecret, {
        identity: participantIdentity,
        name: 'user',
        ttl: '15m',
      });
      at.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canPublishData: true,
        canSubscribe: true,
      });
      // Use the browser's request hostname so LiveKit URL works over Tailscale / remote
      let serverUrl = cfg.voice.livekitUrl;
      try {
        const reqHost = req.hostname || req.headers.host?.split(':')[0];
        if (reqHost) {
          const parsed = new URL(serverUrl);
          parsed.hostname = reqHost;
          serverUrl = parsed.toString().replace(/\/$/, '');
        }
      } catch { /* keep original */ }
      res.json({
        serverUrl,
        roomName,
        participantName: 'user',
        participantToken: await at.toJwt(),
      });
    } catch (err) {
      logger.error(COMPONENT, `LiveKit token error: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to generate LiveKit token. Is livekit-server-sdk installed?' });
    }
  });

  // Voice health check (F5-TTS only)
  app.get('/api/voice/health', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.voice?.enabled) {
      res.json({ livekit: false, stt: false, tts: false, agent: false, overall: false, ttsEngine: cfg.voice?.ttsEngine || 'f5-tts' });
      return;
    }
    const engine = cfg.voice.ttsEngine || 'f5-tts';
    const results = { livekit: false, stt: false, tts: false, agent: false, overall: false, ttsEngine: engine };
    const sttUrl = cfg.voice.sttUrl || 'http://localhost:48421';
    const ttsUrl = cfg.voice.ttsUrl || 'http://localhost:5006';
    const sttEngine = cfg.voice.sttEngine || 'faster-whisper';
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const asrCfg = nvidia?.asr as Record<string, unknown> | undefined;
    const sttHealthUrl = sttEngine === 'nemotron-asr'
      ? `${(asrCfg?.healthUrl as string) || 'http://localhost:9000'}/v1/health/ready`
      : `${sttUrl}/health`;
    const checks = [
      { key: 'livekit' as const, url: cfg.voice.livekitUrl.replace('ws://', 'http://').replace('wss://', 'https://') },
      { key: 'agent' as const, url: cfg.voice.agentUrl },
      { key: 'stt' as const, url: sttHealthUrl },
    ];
    await Promise.allSettled(checks.map(async ({ key, url }) => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        results[key] = resp.ok || resp.status < 500;
      } catch { results[key] = false; }
    }));
    // TTS health check — F5-TTS only
    try {
      let resp = await fetch(`${ttsUrl}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!resp || resp.status >= 400) {
        // No /health endpoint — try a lightweight speech probe
        const voice = cfg.voice.ttsVoice || 'andrew';
        resp = await fetch(`${ttsUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'f5-tts', input: '.', voice, response_format: 'pcm' }),
          signal: AbortSignal.timeout(10000),
        });
      }
      results.tts = resp ? resp.status < 500 : false;
    } catch { results.tts = false; }
    results.overall = results.tts;
    res.json(results);
  });

  // ── NVIDIA Health Checks ─────────────────────────────────────────────
  app.get('/api/nvidia/health/cuopt', async (_req, res) => {
    const cfg = loadConfig();
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const cuoptUrl = ((nvidia?.cuopt as Record<string, unknown>)?.url as string) || 'http://localhost:5000';
    try {
      const resp = await fetch(`${cuoptUrl}/cuopt/health`, { signal: AbortSignal.timeout(5000) });
      res.json({ healthy: resp.ok, status: resp.status, url: cuoptUrl });
    } catch {
      res.json({ healthy: false, url: cuoptUrl });
    }
  });

  app.get('/api/nvidia/health/asr', async (_req, res) => {
    const cfg = loadConfig();
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const healthUrl = ((nvidia?.asr as Record<string, unknown>)?.healthUrl as string) || 'http://localhost:9000';
    try {
      const resp = await fetch(`${healthUrl}/v1/health/ready`, { signal: AbortSignal.timeout(5000) });
      res.json({ healthy: resp.ok, status: resp.status, url: healthUrl });
    } catch {
      res.json({ healthy: false, url: healthUrl });
    }
  });

  app.get('/api/nvidia/health/nim', async (_req, res) => {
    const cfg = loadConfig();
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const apiKey = (nvidia?.apiKey as string) || process.env.NVIDIA_API_KEY || '';
    if (!apiKey) {
      res.json({ healthy: false, reason: 'No NVIDIA API key configured' });
      return;
    }
    try {
      const resp = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      res.json({ healthy: resp.ok, status: resp.status });
    } catch {
      res.json({ healthy: false, reason: 'NIM API unreachable' });
    }
  });

  // Voice preview — F5-TTS only
  app.post('/api/voice/preview', async (req, res) => {
    const cfg = loadConfig();
    const engine = cfg.voice?.ttsEngine || 'f5-tts';
    const voiceId = req.body?.voice || cfg.voice?.ttsVoice || 'andrew';
    const rawText = req.body?.text || 'Hey! I\'m TITAN, your AI assistant.';
    const text = rawText.length > 500 ? rawText.slice(0, 497) + '...' : rawText;
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';
    logger.info('Gateway', `TTS [${engine}] request: voice=${voiceId}, text=${text.slice(0, 80)}...`);

    try {
      const ttsRes = await fetch(`${ttsUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'f5-tts-mlx', input: text, voice: voiceId, response_format: 'wav' }),
        signal: AbortSignal.timeout(60000),
      });

      if (!ttsRes.ok) {
        res.status(502).json({ error: `TTS service unavailable`, status: ttsRes.status });
        return;
      }
      res.setHeader('Content-Type', 'audio/wav');
      const buffer = Buffer.from(await ttsRes.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      res.status(502).json({ error: `TTS service unavailable` });
    }
  });

  // ── Streaming voice endpoint: LLM → sentence chunking → TTS per sentence ──
  // Returns SSE with interleaved text and audio events for low-latency voice
  app.post('/api/voice/stream', rateLimit(60000, 30), concurrencyGuard(10), async (req, res) => {
    const { content, sessionId: requestedSessionId, voice: reqVoice } = req.body || {};
    if (!content) { res.status(400).json({ error: 'content is required' }); return; }

    const cfg = loadConfig();
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';
    const ttsEngine = cfg.voice?.ttsEngine || 'f5-tts';
    const voiceId = reqVoice || cfg.voice?.ttsVoice || 'andrew';
    const channel = 'voice';
    const userId = 'voice-user';

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let clientDisconnected = false;
    res.on('close', () => { clientDisconnected = true; });
    const safeWrite = (data: string) => {
      if (clientDisconnected) return;
      try { res.write(data); } catch { clientDisconnected = true; }
    };

    // SSE heartbeat — keeps the connection alive during LLM inference
    const heartbeat = setInterval(() => {
      if (clientDisconnected) { clearInterval(heartbeat); return; }
      safeWrite(': heartbeat\n\n');
    }, 2000);

    const abortController = new AbortController();
    if (requestedSessionId) {
        sessionAborts.set(requestedSessionId, abortController);
        sessionAbortTimes.set(requestedSessionId, Date.now());
    }

    // Auto-detect TTS availability — probe F5-TTS once at stream start
    let effectiveTtsEngine: string = ttsEngine;
    const effectiveTtsUrl = ttsUrl;
    const effectiveTtsModel = 'f5-tts-mlx';

    try {
      const probe = await fetch(`${effectiveTtsUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!probe.ok) effectiveTtsEngine = 'unavailable';
    } catch {
      effectiveTtsEngine = 'unavailable';
      logger.warn(COMPONENT, `F5-TTS unreachable at ${effectiveTtsUrl}`);
    }
    // Tell the client which TTS engine is active
    safeWrite(`event: tts_mode\ndata: ${JSON.stringify({ engine: effectiveTtsEngine })}\n\n`);

    // Sentence buffer and sequential TTS queue
    let tokenBuffer = '';
    let sentenceIndex = 0;
    let firstChunkSent = false;
    let totalTtsChars = 0;
    const FIRST_CHUNK_MIN = 60; // chars before forcing first flush (low TTFA)
    const MAX_TTS_SENTENCES = 50; // generous limit — let full responses be spoken
    const MAX_TTS_CHARS = 10000;  // ~5 minutes of speech at 150 WPM

    // Sequential TTS queue — processes one sentence at a time to avoid overwhelming F5-TTS
    const ttsQueue: Array<{ sentence: string; index: number }> = [];
    let ttsRunning = false;
    let ttsResolve: (() => void) = () => {};
    const ttsAllDone = new Promise<void>(resolve => { ttsResolve = resolve; });
    let ttsFinished = false;

    const processTtsQueue = async () => {
      if (ttsRunning) return;
      ttsRunning = true;
      while (ttsQueue.length > 0) {
        if (clientDisconnected) break;
        const item = ttsQueue.shift()!;
        await fireTTSInternal(item.sentence, item.index);
      }
      ttsRunning = false;
      if (ttsFinished && ttsQueue.length === 0) {
        ttsResolve();
      }
    };

    // Strip markdown/emotion/tool narration/TOOLCALL tags for voice display+TTS
    const cleanForVoice = (text: string): string => {
      return text
        .replace(/<TOOLCALL>[\s\S]*?(?:<\/TOOLCALL>|$)/g, '') // strip <TOOLCALL> blocks
        .replace(/<TOOLCALL>\[[\s\S]*?\]/g, '')                // strip <TOOLCALL>[...] format
        .replace(/```[\s\S]*?```/g, '')                        // strip code blocks
        .replace(/`[^`]+`/g, (m) => m.slice(1, -1))           // unwrap inline code (keep text)
        .replace(/\*\*(.*?)\*\*/g, '$1')                       // bold → plain
        .replace(/\*(.*?)\*/g, '$1')                           // italic → plain
        .replace(/^#+\s+/gm, '')                               // headings → plain
        .replace(/^\d+\.\s+/gm, '')                            // numbered lists → plain
        .replace(/^[-*]\s+/gm, '')                             // bullet points → plain
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')               // [links](url) → link text
        .replace(/https?:\/\/\S+/g, '')                        // strip bare URLs
        .replace(/\n{2,}/g, '. ')                              // paragraph breaks → sentence break
        .replace(/\n/g, ' ')                                   // single newlines → space
        .replace(/<(?:laugh|chuckle|sigh|cough|sniffle|groan|yawn|gasp|smile)>/gi, '')
        .replace(/(?:Let me |I'll |I will |I'm going to )(?:use|call|check|run|invoke|execute|try)(?: the)? \w[\w_]*(?: tool)?(?:\s+(?:to|for|and)\b[^.!?]*)?[.!]?\s*/gi, '')
        .replace(/\b(?:Using|Calling|Running|Checking|Invoking|Executing) (?:the )?\w[\w_]*(?: tool)?(?:\s+(?:to|for)\b[^.!?]*)?[.!]?\s*/gi, '')
        .replace(/\s{2,}/g, ' ')
        // TTS cadence fixes — natural breathing pauses for voice
        .replace(/(\w)\s*—\s*(\w)/g, '$1, $2')                 // em dashes between words → comma pause
        .replace(/(\w)\s*–\s*(\w)/g, '$1, $2')                 // en dashes between words → comma pause
        .replace(/;\s*/g, '. ')                                 // semicolons → sentence break
        .replace(/\(([^)]+)\)/g, ', $1,')                      // parentheses → comma-wrapped
        // Break long clauses at major conjunctions (but not inside short lists)
        .replace(/([a-z]{4,}),\s*(but|yet|so|however|although)\s+/gi, '$1. $2 ')  // clause-level breaks
        .replace(/\.\s*\./g, '.')                               // clean up double periods
        .replace(/,\s*\./g, '.')                                // clean up comma-period
        .replace(/\s{2,}/g, ' ')
        .trim();
    };

    // Fire TTS for a single sentence — called sequentially from the queue
    const fireTTSInternal = async (sentence: string, index: number) => {
      const clean = cleanForVoice(sentence);
      if (!clean || clean.length < 3) return;

      // Send text event so client can display it (skip for F5-TTS — already sent during buffering)
      if (!isF5TTS) {
        safeWrite(`event: sentence\ndata: ${JSON.stringify({ text: clean, index })}\n\n`);
      }

      // Skip audio if we've exceeded TTS limits (still display text)
      if (index >= MAX_TTS_SENTENCES || totalTtsChars >= MAX_TTS_CHARS) return;
      totalTtsChars += clean.length;

      try {
        const ttsRes = await fetch(`${effectiveTtsUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: effectiveTtsModel, input: clean, voice: voiceId, response_format: 'wav' }),
          signal: AbortSignal.timeout(60000),
        });
        if (ttsRes.ok && !clientDisconnected) {
          const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
          const audioBase64 = audioBuffer.toString('base64');
          safeWrite(`event: audio\ndata: ${JSON.stringify({ index, audio: audioBase64, format: 'wav' })}\n\n`);
        }
      } catch (e) {
        logger.debug('Gateway', `Voice stream TTS failed for sentence ${index}: ${(e as Error).message}`);
      }
    };

    // For F5-TTS (f5-tts engine): batch ALL sentences into one TTS call after LLM finishes.
    // But cap at ~120 chars per call to avoid quality degradation on long text.
    const isF5TTS = effectiveTtsEngine === 'f5-tts';
    const f5Sentences: string[] = []; // accumulate clean sentences for post-LLM TTS

    // Flush accumulated buffer as a sentence — adds to sequential queue
    const flushSentence = (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length < 3) return;

      if (isF5TTS) {
        // Send text event immediately so client can display in real-time
        const clean = cleanForVoice(trimmed);
        if (clean && clean.length >= 3) {
          safeWrite(`event: sentence\ndata: ${JSON.stringify({ text: clean, index: sentenceIndex++ })}\n\n`);
          f5Sentences.push(clean);
        }
        return;
      }

      const idx = sentenceIndex++;
      ttsQueue.push({ sentence: trimmed, index: idx });
      processTtsQueue(); // kick off processing if not already running
    };

    activeLlmRequests++;
    titanActiveSessions.inc();
    const startTime = process.hrtime.bigint();

    try {
      const response = await routeMessage(content, channel, userId, {
        streamCallbacks: {
          onToken: (token: string) => {
            if (clientDisconnected) return;
            tokenBuffer += token;

            // Force first chunk early for low time-to-first-audio
            if (!firstChunkSent && tokenBuffer.length >= FIRST_CHUNK_MIN) {
              const lastSpace = tokenBuffer.lastIndexOf(' ');
              if (lastSpace > 30) {
                flushSentence(tokenBuffer.slice(0, lastSpace));
                tokenBuffer = tokenBuffer.slice(lastSpace + 1);
                firstChunkSent = true;
                return;
              }
            }

            // Split on newlines first — paragraph/list boundaries are natural sentence breaks
            if (tokenBuffer.includes('\n')) {
              const lines = tokenBuffer.split('\n');
              // Keep last fragment in buffer (may be incomplete)
              tokenBuffer = lines.pop() || '';
              for (const line of lines) {
                if (line.trim().length >= 3) {
                  flushSentence(line);
                  firstChunkSent = true;
                }
              }
              return;
            }

            // Detect sentence boundaries: .!?:; followed by space or end
            // Negative lookbehind avoids splitting on decimals like "PM2.5", "8.8kW", "Dr.", "vs."
            // Loop to drain ALL complete sentences from buffer
            let match: RegExpMatchArray | null;
            while ((match = tokenBuffer.match(/^(.*?(?<!\d)(?<!\b(?:Dr|Mr|Mrs|Ms|vs|etc|e\.g|i\.e))[.!?])(\s+|$)/s)) !== null) {
              flushSentence(match[1]);
              tokenBuffer = tokenBuffer.slice(match[0].length);
              firstChunkSent = true;
            }

            // Also split on colons/semicolons when buffer is getting long (natural pauses)
            if (tokenBuffer.length > 80) {
              const colonMatch = tokenBuffer.match(/^(.*?[:;])\s+/s);
              if (colonMatch && colonMatch[1].length > 20) {
                flushSentence(colonMatch[1]);
                tokenBuffer = tokenBuffer.slice(colonMatch[0].length);
                firstChunkSent = true;
                return;
              }
            }

            // Force flush long runs without punctuation (bullet lists, etc.)
            if (tokenBuffer.length > 200) {
              // Try comma as a natural break point
              const commaPos = tokenBuffer.lastIndexOf(', ', 180);
              if (commaPos > 40) {
                flushSentence(tokenBuffer.slice(0, commaPos + 1));
                tokenBuffer = tokenBuffer.slice(commaPos + 2);
                firstChunkSent = true;
              } else {
                const lastSpace = tokenBuffer.lastIndexOf(' ', 180);
                if (lastSpace > 50) {
                  flushSentence(tokenBuffer.slice(0, lastSpace));
                  tokenBuffer = tokenBuffer.slice(lastSpace + 1);
                  firstChunkSent = true;
                }
              }
            }
          },
          onToolCall: (name: string) => {
            // Notify client that tools are running (shows "Thinking..." state)
            safeWrite(`event: tool\ndata: ${JSON.stringify({ name })}\n\n`);
          },
        },
        signal: abortController.signal,
      });

      // Flush remaining buffer
      if (tokenBuffer.trim()) {
        flushSentence(tokenBuffer);
        tokenBuffer = '';
      }

      // F5-TTS: generate audio in chunks of ~120 chars after LLM finishes.
      // Short enough for quality, long enough for voice consistency.
      if (isF5TTS && f5Sentences.length > 0) {
        const F5_MAX_CHUNK_CHARS = 600; // voice prompt limits to ~50 words; send as single chunk to avoid voice inconsistency
        const chunks: string[] = [];
        let current = '';
        for (const s of f5Sentences) {
          if (current && (current.length + s.length + 1) > F5_MAX_CHUNK_CHARS) {
            chunks.push(current);
            current = s;
          } else {
            current += (current ? ' ' : '') + s;
          }
        }
        if (current) chunks.push(current);

        let audioIdx = 0;
        for (const chunk of chunks) {
          if (clientDisconnected || totalTtsChars >= MAX_TTS_CHARS) break;
          totalTtsChars += chunk.length;
          try {
            const ttsRes = await fetch(`${effectiveTtsUrl}/v1/audio/speech`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: effectiveTtsModel, input: chunk, voice: voiceId, response_format: 'wav' }),
              signal: AbortSignal.timeout(120000),
            });
            if (ttsRes.ok && !clientDisconnected) {
              const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
              const audioBase64 = audioBuffer.toString('base64');
              safeWrite(`event: audio\ndata: ${JSON.stringify({ index: audioIdx++, audio: audioBase64, format: 'wav' })}\n\n`);
            }
          } catch (e) {
            logger.debug('Gateway', `F5-TTS chunk ${audioIdx} failed: ${(e as Error).message}`);
          }
        }
      }

      // Signal no more sentences coming, wait for TTS queue to drain (non-F5 engines)
      ttsFinished = true;
      if (!ttsRunning && ttsQueue.length === 0) {
        ttsResolve();
      }
      if (!isF5TTS) {
        await ttsAllDone;
      }

      // ── Voice session poison detection ──────────────────────
      // If the model returned a canned/useless response, auto-reset the session
      // to prevent the next voice message from getting the same poisoned context.
      const responseText = response.content || '';
      if (VOICE_POISON_PATTERNS.some(p => p.test(responseText)) || (response.durationMs > 60000 && responseText.length < 50)) {
        logger.warn(COMPONENT, `[VoicePoisonGuard] Detected canned/stale response — resetting voice session ${response.sessionId}`);
        try {
          const { closeSession } = await import('../agent/session.js');
          closeSession(response.sessionId);
        } catch { /* session module may not export closeSession */ }
      }

      // Send done event with metadata
      if (!clientDisconnected) {
        safeWrite(`event: done\ndata: ${JSON.stringify({
          sessionId: response.sessionId,
          model: response.model,
          durationMs: response.durationMs,
          toolsUsed: response.toolsUsed,
          fullText: response.content,
        })}\n\n`);
        try { res.end(); } catch { /* client gone */ }
      }
    } catch (error) {
      if (!clientDisconnected) {
        safeWrite(`event: done\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`);
        try { res.end(); } catch { /* client gone */ }
      }
    } finally {
      clearInterval(heartbeat);
      activeLlmRequests--;
      titanActiveSessions.dec();
      const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
      titanRequestDuration.observe(durationSec, { channel });
      if (requestedSessionId) sessionAborts.delete(requestedSessionId);
    }
  });

  // Voice available voices — engine-aware
  app.get('/api/voice/voices', async (_req, res) => {
    const cfg = loadConfig();
    const engine = cfg.voice?.ttsEngine || 'f5-tts';
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';

    if (engine === 'f5-tts') {
      // Return cloned voices from ~/.titan/voices/
      const voicesDir = join(homedir(), '.titan', 'voices');
      try {
        const files = fs.existsSync(voicesDir) ? fs.readdirSync(voicesDir).filter((f: string) => f.endsWith('.wav')) : [];
        const voiceNames = files.map((f: string) => f.replace('.wav', ''));
        // Always include 'default' as fallback
        const voices = voiceNames.length ? voiceNames : ['default'];
        res.json({ voices, engine: 'f5-tts' });
      } catch {
        res.json({ voices: ['default'], engine: 'f5-tts' });
      }
      return;
    }

    // F5-TTS (default)
    try {
      const ttsRes = await fetch(`${ttsUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(3000) });
      if (!ttsRes.ok) { res.json({ voices: F5_TTS_DEFAULT_VOICES, engine: 'f5-tts' }); return; }
      const data = await ttsRes.json() as { voices?: string[] };
      res.json({ ...data, engine: 'f5-tts' });
    } catch {
      res.json({ voices: F5_TTS_DEFAULT_VOICES, engine: 'f5-tts' });
    }
  });

  // v4.3.3: simple GET TTS used by the /call live-voice page.
  // Query: text=..., voice=andrew, format=mp3, token=<bearer>
  // Returns: raw audio bytes. Designed for <audio src="..."> tag usage so
  // the browser can stream + play without a fetch() + Blob dance.
  app.get('/api/voice/tts', async (req, res) => {
    try {
      const text = (req.query.text as string || '').slice(0, 2000);
      const voice = (req.query.voice as string) || 'andrew';
      const format = ((req.query.format as string) || 'mp3').toLowerCase();
      if (!text.trim()) { res.status(400).json({ error: 'text required' }); return; }

      // F5-TTS only as of v5.0 — voice.ttsUrl always points to the F5-TTS
      // server (default :5006). Andrew voice is the default reference clone.
      const cfg = loadConfig();
      const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';

      const ttsRes = await fetch(`${ttsUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, voice, response_format: format }),
        signal: AbortSignal.timeout(180_000),
      });

      if (!ttsRes || !ttsRes.ok) {
        res.status(502).json({ error: 'tts backends unavailable' });
        return;
      }

      const contentType = ttsRes.headers.get('content-type') || (format === 'wav' ? 'audio/wav' : 'audio/mpeg');
      const buf = Buffer.from(await ttsRes.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── F5-TTS Voice Cloning ─────────────────────────────────────────
  // (Orpheus TTS support removed in v5.0 — voice is F5-TTS only.)
  const F5_TTS_PORT = 5006;
  const F5_TTS_MODEL = 'f5-tts-mlx';

  app.get('/api/voice/f5tts/status', async (_req, res) => {
    let running = false;
    try {
      const probe = await fetch(`http://localhost:${F5_TTS_PORT}/health`, { signal: AbortSignal.timeout(3000) });
      running = probe.ok;
    } catch { /* not running */ }
    // List available cloned voices
    const voicesDir = join(homedir(), '.titan', 'voices');
    let voices: string[] = [];
    try {
      if (fs.existsSync(voicesDir)) {
        voices = fs.readdirSync(voicesDir)
          .filter((f: string) => f.endsWith('.wav'))
          .map((f: string) => f.replace('.wav', ''));
      }
    } catch { /* ignore */ }
    res.json({ installed: true, running, voices, port: F5_TTS_PORT, model: F5_TTS_MODEL });
  });

  // Tracks the spawned F5-TTS server pid. Variable is named for the legacy
  // venv directory (~/.titan/qwen3tts-venv) which we keep as a stable
  // on-disk path so existing installs aren't orphaned.
  let f5ttsPid: number | null = null;

  app.post('/api/voice/f5tts/install', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const send = (step: string, status: 'running' | 'done' | 'error', detail?: string) => {
      res.write(`data: ${JSON.stringify({ step, status, detail })}\n\n`);
    };

    const venvPath = join(homedir(), '.titan', 'qwen3tts-venv');
    const voicesDir = join(homedir(), '.titan', 'voices');

    try {
      // Step 1: Create venv
      send('venv', 'running', 'Creating Python virtual environment...');
      if (!fs.existsSync(join(venvPath, 'bin', 'python'))) {
        execSync(`python3 -m venv "${venvPath}"`, { timeout: 60000 });
      }
      send('venv', 'done');

      // Step 2: Install mlx-audio
      const pip = join(venvPath, 'bin', 'pip');
      send('install', 'running', 'Installing F5-TTS + MLX dependencies (this may take 2-3 minutes)...');
      execSync(`"${pip}" install f5-tts-mlx "mlx-audio[server]" "setuptools<81" numpy`, { timeout: 600000 });
      send('install', 'done');

      // Step 3: Create voices directory
      if (!fs.existsSync(voicesDir)) {
        fs.mkdirSync(voicesDir, { recursive: true });
      }

      // Step 4: Start the server
      send('start', 'running', 'Starting voice cloning server on port 5006...');
      const python = join(venvPath, 'bin', 'python');
      const serverScript = join(__dirname, '..', 'scripts', 'f5-tts-server.py');
      // Fall back to source path if dist path doesn't exist
      const scriptPath = fs.existsSync(serverScript)
        ? serverScript
        : join(__dirname, '..', '..', 'scripts', 'f5-tts-server.py');

      const child = spawn(python, [scriptPath, '--host', '127.0.0.1', '--port', String(5006)], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
      });
      child.unref();
      f5ttsPid = child.pid ?? null;
      const pidFile = join(homedir(), '.titan', 'f5tts.pid');
      if (child.pid) fs.writeFileSync(pidFile, String(child.pid));

      // Wait for server to come up (model download + load)
      send('model', 'running', 'Downloading F5-TTS model (~500MB, first time only)...');
      let ready = false;
      for (let i = 0; i < 120; i++) { // up to 4 minutes
        await new Promise(r => setTimeout(r, 2000));
        try {
          const probe = await fetch(`http://localhost:${5006}/health`, { signal: AbortSignal.timeout(5000) });
          if (probe.ok) { ready = true; break; }
        } catch { /* still loading */ }
      }
      if (ready) {
        send('model', 'done');
        send('complete', 'done', 'Voice cloning server is ready! (F5-TTS)');
      } else {
        send('model', 'error', 'Server started but model loading timed out. It may still be downloading — try again in a few minutes.');
      }
    } catch (e) {
      send('error', 'error', (e as Error).message);
    }
    res.end();
  });

  // Canonical F5-TTS lifecycle handlers. Both legacy /qwen3tts/* and the
  // new /f5tts/* routes call the same implementation so existing UIs
  // (which may still POST to /qwen3tts/start|stop) keep working through
  // v5.x. The /qwen3tts/* aliases are deprecated and will be removed in v6.
  const stopF5TTSHandler = (_req: import('express').Request, res: import('express').Response) => {
    // Both legacy and canonical pid-file locations are checked so an upgrade
    // from a v4-era install with .titan/qwen3tts.pid still cleans up.
    const candidates = [
      join(homedir(), '.titan', 'f5tts.pid'),
      join(homedir(), '.titan', 'qwen3tts.pid'),
    ];
    try {
      for (const pidFile of candidates) {
        if (!fs.existsSync(pidFile)) continue;
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
      }
      f5ttsPid = null;
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  };

  const startF5TTSHandler = async (_req: import('express').Request, res: import('express').Response) => {
    const venvPath = join(homedir(), '.titan', 'qwen3tts-venv');
    const python = join(venvPath, 'bin', 'python');
    const pidFile = join(homedir(), '.titan', 'f5tts.pid');

    if (!fs.existsSync(python)) {
      res.status(400).json({ ok: false, error: 'F5-TTS not installed. Use POST /api/voice/f5tts/install first.' });
      return;
    }

    // Check if already running
    try {
      const probe = await fetch(`http://localhost:${5006}/health`, { signal: AbortSignal.timeout(3000) });
      if (probe.ok) {
        res.json({ ok: true, message: 'F5-TTS is already running' });
        return;
      }
    } catch { /* not running, start it */ }

    try {
      const serverScript = join(__dirname, '..', 'scripts', 'f5-tts-server.py');
      const scriptPath = fs.existsSync(serverScript)
        ? serverScript
        : join(__dirname, '..', '..', 'scripts', 'f5-tts-server.py');

      const child = spawn(python, [scriptPath, '--host', '127.0.0.1', '--port', String(5006)], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
      });
      child.unref();
      f5ttsPid = child.pid ?? null;
      if (child.pid) fs.writeFileSync(pidFile, String(child.pid));
      res.json({ ok: true, message: 'F5-TTS server starting — model loading may take a minute.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  };

  // Canonical routes (v5.0+).
  app.post('/api/voice/f5tts/stop', stopF5TTSHandler);
  app.post('/api/voice/f5tts/start', startF5TTSHandler);

  // Deprecated aliases — kept for backward compatibility with v4.x UIs.
  // Will be removed in v6. Logged so we can see if anything still calls them.
  const deprecationWarn = (alias: string, canonical: string) => {
    logger.warn(COMPONENT, `Deprecated route ${alias} called; please switch to ${canonical}.`);
  };
  app.post('/api/voice/qwen3tts/stop', (req, res) => {
    deprecationWarn('/api/voice/qwen3tts/stop', '/api/voice/f5tts/stop');
    return stopF5TTSHandler(req, res);
  });
  app.post('/api/voice/qwen3tts/start', (req, res) => {
    deprecationWarn('/api/voice/qwen3tts/start', '/api/voice/f5tts/start');
    return startF5TTSHandler(req, res);
  });

  // Upload reference audio for voice cloning
  app.post('/api/voice/clone/upload', async (req, res) => {
    try {
      const voicesDir = join(homedir(), '.titan', 'voices');
      if (!fs.existsSync(voicesDir)) fs.mkdirSync(voicesDir, { recursive: true });

      // Accept raw binary with voice name in query/header, or base64 JSON body
      const voiceName = (req.query.name as string) || req.headers['x-voice-name'] as string || 'custom';
      const safeName = voiceName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'custom';
      const transcript = (req.query.transcript as string) || req.headers['x-voice-transcript'] as string || '';

      const contentType = req.headers['content-type'] || '';

      if (contentType.includes('application/json')) {
        // JSON body with base64 audio
        const body = req.body as { audio?: string; name?: string; transcript?: string };
        if (!body.audio) { res.status(400).json({ error: 'audio (base64) is required' }); return; }
        const audioBuffer = Buffer.from(body.audio, 'base64');
        const name = body.name?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || safeName;
        fs.writeFileSync(join(voicesDir, `${name}.wav`), audioBuffer);
        if (body.transcript || transcript) {
          fs.writeFileSync(join(voicesDir, `${name}.txt`), body.transcript || transcript);
        }
        res.json({ ok: true, voice: name, path: join(voicesDir, `${name}.wav`) });
      } else {
        // Raw binary upload
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const audioBuffer = Buffer.concat(chunks);
          fs.writeFileSync(join(voicesDir, `${safeName}.wav`), audioBuffer);
          if (transcript) {
            fs.writeFileSync(join(voicesDir, `${safeName}.txt`), transcript);
          }
          res.json({ ok: true, voice: safeName, path: join(voicesDir, `${safeName}.wav`) });
        });
      }
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // List available cloned voices
  app.get('/api/voice/clone/voices', (_req, res) => {
    const voicesDir = join(homedir(), '.titan', 'voices');
    try {
      if (!fs.existsSync(voicesDir)) { res.json({ voices: [] }); return; }
      const voices = fs.readdirSync(voicesDir)
        .filter((f: string) => f.endsWith('.wav'))
        .map((f: string) => {
          const name = f.replace('.wav', '');
          const hasTranscript = fs.existsSync(join(voicesDir, `${name}.txt`));
          const stat = fs.statSync(join(voicesDir, f));
          return { name, hasTranscript, sizeBytes: stat.size };
        });
      res.json({ voices });
    } catch (e) {
      res.json({ voices: [], error: (e as Error).message });
    }
  });

  // Delete a cloned voice
  app.delete('/api/voice/clone/:name', (req, res) => {
    const voicesDir = join(homedir(), '.titan', 'voices');
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    try {
      const wavPath = join(voicesDir, `${name}.wav`);
      const txtPath = join(voicesDir, `${name}.txt`);
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
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
    // Verification (GET) — Facebook sends this when you set up the webhook
    app.get('/api/messenger/webhook', (req, res) => {
      const result = messengerAdapter.handleVerify(req.query as Record<string, string>);
      res.status(result.status).send(result.body);
    });

    // Incoming messages (POST) — Facebook sends DMs here
    app.post('/api/messenger/webhook', express.json(), (req, res) => {
      messengerAdapter.handleWebhook(req.body);
      res.sendStatus(200); // Must respond 200 quickly or Facebook retries
    });

    // Also register at /messenger/webhook (without /api prefix) for backwards compatibility
    app.get('/messenger/webhook', (req, res) => {
      const result = messengerAdapter.handleVerify(req.query as Record<string, string>);
      res.status(result.status).send(result.body);
    });
    app.post('/messenger/webhook', express.json(), (req, res) => {
      messengerAdapter.handleWebhook(req.body);
      res.sendStatus(200);
    });

    logger.info(COMPONENT, `Messenger webhook: /api/messenger/webhook + /messenger/webhook (verify token: ${messengerAdapter.getVerifyToken()})`);
  }

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
    logger.info(COMPONENT, `Goal Driver resume: ${resumed.resumed} drivers re-activated, ${resumed.cancelled} cancelled (goal no longer active)`);
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

