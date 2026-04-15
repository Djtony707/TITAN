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
import { initAgents, routeMessage, listAgents, spawnAgent, stopAgent, getAgentCapacity, getAgent } from '../agent/multiAgent.js';
import { createOpenAICompatRouter } from '../gateway/openai-compat.js';
import type { ChannelAdapter, InboundMessage } from '../channels/base.js';
import logger, { initFileLogger } from '../utils/logger.js';
import { TITAN_VERSION, TITAN_NAME, TITAN_LOGS_DIR, TITAN_HOME } from '../utils/constants.js';
import { getUpdateInfo } from '../utils/updater.js';
import { getMissionControlHTML } from './dashboard.js';
import { serializePrometheus, getMetricsSummary, titanRequestsTotal, titanRequestDuration, titanErrorsTotal, titanActiveSessions, titanToolCallsTotal, titanTokensTotal, titanModelRequestsTotal } from './metrics.js';
import { initSlashCommands, handleSlashCommand } from './slashCommands.js';
import { initMcpServers, listMcpServers, addMcpServer, removeMcpServer, setMcpServerEnabled, getMcpStatus, BUILTIN_PRESETS } from '../mcp/registry.js';
import { connectMcpServer, testMcpServer } from '../mcp/client.js';
import { mountMcpHttpEndpoints, getMcpServerStatus } from '../mcp/server.js';
import { initMonitors, setMonitorTriggerHandler } from '../agent/monitor.js';
import { seedBuiltinRecipes, listRecipes, getRecipe, saveRecipe, deleteRecipe, getBuiltinRecipes, importRecipeYaml } from '../recipes/store.js';
import { parseSlashCommand, runRecipe } from '../recipes/runner.js';
import { getCostStatus } from '../agent/costOptimizer.js';
import { initLearning, getLearningStats } from '../memory/learning.js';
import { initGraph, getGraphData, getGraphStats, clearGraph, cleanupGraph, flushGraph, getEntity, listEntities, getEntityEpisodes } from '../memory/graph.js';
import { getLogFilePath } from '../utils/logger.js';
import { closeSession, renameSession } from '../agent/session.js';
import { initCronScheduler } from '../skills/builtin/cron.js';
import { checkAndSendBriefing } from '../memory/briefing.js';
import { initPersistentWebhooks } from '../skills/builtin/webhook.js';
import { invalidateCacheForModel } from '../agent/responseCache.js';
import { initAutopilot, stopAutopilot, runAutopilotNow, getAutopilotStatus, getRunHistory, setAutopilotDryRun } from '../agent/autopilot.js';
import { initDaemon, stopDaemon, getDaemonStatus, pauseDaemonManual, resumeDaemon, titanEvents } from '../agent/daemon.js';
import { initCommandPost, shutdownCommandPost, getDashboard as getCPDashboard, getRegisteredAgents, reportHeartbeat, removeAgent, checkoutTask, checkinTask, getActiveCheckouts, getBudgetPolicies, createBudgetPolicy, updateBudgetPolicy, deleteBudgetPolicy, getActivity, getGoalTree, getAncestryChain, validateGoalAncestry, validateGoalParentAssignment, sweepExpiredCheckoutsManual, getStaleAgents, enforceBudgetForAgent, getBudgetPolicyForAgent, createIssue, updateIssue, getIssue, listIssues, checkoutIssue, deleteIssue, addIssueComment, getIssueComments, createApproval, approveApproval, rejectApproval, listApprovals, getApproval, startRun, endRun, listRuns, getOrgTree, updateRegisteredAgent } from '../agent/commandPost.js';
import { initWakeupSystem, getAgentInbox, queueWakeup, getWakeupRequest, cancelWakeup, drainPendingResults } from '../agent/agentWakeup.js';
import { auditLog, queryAuditLog, getAuditStats } from '../agent/auditLog.js';
import { listGoals, createGoal, getGoal, deleteGoal, completeSubtask, addSubtask } from '../agent/goals.js';
import { startTunnel, stopTunnel, getTunnelStatus } from '../utils/tunnel.js';
import { getConsentUrl, exchangeCode, isGoogleConnected, getGoogleEmail, disconnectGoogle } from '../auth/google.js';
import { createTeam, getTeam, listTeams, deleteTeam, updateTeam, addMember, removeMember, updateMemberRole, createInvite, acceptInvite, getEffectivePermissions, setRolePermissions, getTeamStats, isToolAllowed, getUserRole } from '../security/teams.js';
import { TITAN_WORKSPACE } from '../utils/constants.js';
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
let activeLlmRequests = 0;
let maxConcurrentOverride: number | null = null;

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

/** Active session tokens (in-memory, cleared on restart) */
const authTokens = new Map<string, { createdAt: number; userId: string }>();

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
setInterval(() => {
    const now = Date.now();
    for (const [id, controller] of sessionAborts) {
        if (controller.signal.aborted || (now - (sessionAbortTimes.get(id) || 0)) > 300_000) {
            sessionAborts.delete(id);
            sessionAbortTimes.delete(id);
        }
    }
}, 60_000).unref();

// Clean expired tokens every 10 minutes
tokenCleanupInterval = setInterval(() => {
    const now = Date.now();
    const ttlMs = 24 * 60 * 60 * 1000;
    for (const [tok, entry] of authTokens) {
        if (now - entry.createdAt > ttlMs) authTokens.delete(tok);
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
    const ttlMs = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - entry.createdAt > ttlMs) {
        authTokens.delete(token);
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
onAgentEvent((event) => {
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
    broadcast({ type: 'error', message: (error as Error).message });
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

  // ── Stale session cleanup: mark orphaned active sessions as idle ──
  cleanupStaleSessions();

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
  app.use(express.json({ limit: '1mb' }));

  // OpenAI API compatibility layer (/v1/models, /v1/chat/completions, /v1/embeddings)
  app.use('/v1', createOpenAICompatRouter());

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
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self' ws: wss: https: http:",
          "media-src 'self' blob: mediastream:",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
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
    // Skip public endpoints (login, messenger webhook)
    if (req.path === '/login') { next(); return; }
    if (req.path === '/messenger/webhook') { next(); return; }
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string);
    if (isValidToken(token, cfg)) { next(); return; }
    res.status(401).json({ error: 'Unauthorized' });
  });

  // ── Serve React SPA (Mission Control v2) ──────────────────
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const uiDistPath = join(__dirname, '../../ui/dist');
  const uiIndexPath = join(uiDistPath, 'index.html');
  const hasReactUI = fs.existsSync(uiIndexPath);
  if (hasReactUI) {
    app.use(express.static(uiDistPath, { index: false }));
  }

  // Legacy dashboard (kept during migration, also fallback if React UI not built)
  app.get('/legacy', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(getMissionControlHTML());
  });

  // Root route: React SPA or legacy dashboard
  app.get('/', (_req, res) => {
    if (hasReactUI) {
      res.sendFile(uiIndexPath);
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
    });
  });

  // ── Tracing API ─────────────────────────────────────────────────
  app.get('/api/traces', async (_req, res) => {
    try {
      const { listTraces, getTraceStats } = await import('../agent/tracer.js');
      const limit = parseInt(_req.query.limit as string || '50', 10);
      const session = _req.query.session as string | undefined;
      res.json({ traces: listTraces(limit, session), stats: getTraceStats() });
    } catch { res.json({ traces: [], stats: {} }); }
  });

  app.get('/api/traces/:traceId', async (req, res) => {
    try {
      const { getTrace } = await import('../agent/tracer.js');
      const trace = getTrace(req.params.traceId);
      if (!trace) { res.status(404).json({ error: 'Trace not found' }); return; }
      res.json(trace);
    } catch { res.status(500).json({ error: 'Tracer unavailable' }); }
  });

  // ── Checkpoints API ────────────────────────────────────────────
  app.get('/api/checkpoints', async (_req, res) => {
    try {
      const { listCheckpoints } = await import('../agent/checkpoint.js');
      res.json({ checkpoints: listCheckpoints() });
    } catch { res.json({ checkpoints: [] }); }
  });

  app.get('/api/checkpoints/:sessionId', async (req, res) => {
    try {
      const { loadCheckpoint } = await import('../agent/checkpoint.js');
      const round = req.query.round ? parseInt(req.query.round as string, 10) : undefined;
      const cp = loadCheckpoint(req.params.sessionId, round);
      if (!cp) { res.status(404).json({ error: 'Checkpoint not found' }); return; }
      res.json(cp);
    } catch { res.status(500).json({ error: 'Checkpoint unavailable' }); }
  });

  app.delete('/api/checkpoints/:sessionId', async (req, res) => {
    try {
      const { clearCheckpoints } = await import('../agent/checkpoint.js');
      clearCheckpoints(req.params.sessionId);
      res.json({ success: true });
    } catch { res.status(500).json({ error: 'Failed to clear checkpoints' }); }
  });

  // ── Company API (Paperclip-style) ─────────────────────────────
  app.get('/api/companies', async (_req, res) => {
    try {
      const { listCompanies, getActiveRunners } = await import('../agent/company.js');
      const includeArchived = _req.query.archived === 'true';
      const companies = listCompanies(includeArchived);
      const runners = getActiveRunners();
      res.json({ companies: companies.map(c => ({ ...c, runnerActive: runners.includes(c.id) })) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/companies', async (req, res) => {
    try {
      const { createCompany } = await import('../agent/company.js');
      const company = createCompany(req.body);
      res.json(company);
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.get('/api/companies/:id', async (req, res) => {
    try {
      const { getCompany, isRunnerActive } = await import('../agent/company.js');
      const company = getCompany(req.params.id);
      if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json({ ...company, runnerActive: isRunnerActive(company.id) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.patch('/api/companies/:id', async (req, res) => {
    try {
      const { updateCompany } = await import('../agent/company.js');
      const company = updateCompany(req.params.id, req.body);
      if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json(company);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.delete('/api/companies/:id', async (req, res) => {
    try {
      const { deleteCompany, stopCompanyRunner } = await import('../agent/company.js');
      stopCompanyRunner(req.params.id);
      const ok = deleteCompany(req.params.id);
      res.json({ success: ok });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Start/stop company heartbeat runner
  app.post('/api/companies/:id/start', async (req, res) => {
    try {
      const { startCompanyRunner } = await import('../agent/company.js');
      const interval = parseInt(req.body?.intervalMs || '60000', 10);
      const ok = startCompanyRunner(req.params.id, interval);
      res.json({ success: ok, message: ok ? 'Runner started' : 'Already running or company not active' });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/companies/:id/stop', async (req, res) => {
    try {
      const { stopCompanyRunner } = await import('../agent/company.js');
      const ok = stopCompanyRunner(req.params.id);
      res.json({ success: ok });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Add agent/goal to company
  app.post('/api/companies/:id/agents', async (req, res) => {
    try {
      const { addAgentToCompany } = await import('../agent/company.js');
      const agent = addAgentToCompany(req.params.id, req.body);
      if (!agent) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json(agent);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/companies/:id/goals', async (req, res) => {
    try {
      const { addGoalToCompany } = await import('../agent/company.js');
      const goal = addGoalToCompany(req.params.id, req.body);
      if (!goal) { res.status(404).json({ error: 'Company not found' }); return; }
      res.json(goal);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

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

  app.get('/api/sessions', (_req, res) => {
    const sessions = listSessions();
    res.json(sessions);
  });

  // Create a new session explicitly (for "New chat" button)
  app.post('/api/sessions', async (req, res) => {
    try {
      const { createNewSession } = await import('../agent/session.js');
      const channel = req.body?.channel || 'webchat';
      const userId = req.body?.userId || 'api-user';
      const session = createNewSession(channel, userId);
      res.json({ id: session.id, channel: session.channel, userId: session.userId });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Conversation search — full-text search across all sessions
  app.get('/api/sessions/search', (req, res) => {
    const query = (req.query.q as string || '').toLowerCase().trim();
    if (!query || query.length < 2) { res.status(400).json({ error: 'Query must be at least 2 characters' }); return; }
    try {
      const sessions = listSessions();
      const results: Array<{ sessionId: string; sessionName: string; role: string; content: string; timestamp: string }> = [];
      const limit = parseInt(req.query.limit as string) || 50;

      for (const session of sessions) {
        const history = getHistory(session.id, 1000);
        for (const msg of history) {
          if (msg.content.toLowerCase().includes(query)) {
            results.push({
              sessionId: session.id,
              sessionName: session.name || session.id.slice(0, 8),
              role: msg.role,
              content: msg.content.slice(0, 200),
              timestamp: (msg as { createdAt?: string }).createdAt || '',
            });
            if (results.length >= limit) break;
          }
        }
        if (results.length >= limit) break;
      }
      res.json({ query, results, total: results.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Conversation export — download session as JSON or markdown
  app.get('/api/sessions/:id/export', (req, res) => {
    const sessionId = req.params.id;
    const format = (req.query.format as string) || 'json';
    try {
      const history = getHistory(sessionId, 10000);
      if (!history || history.length === 0) { res.status(404).json({ error: 'Session not found or empty' }); return; }

      if (format === 'markdown' || format === 'md') {
        const sessions = listSessions();
        const session = sessions.find(s => s.id === sessionId);
        const title = session?.name || sessionId.slice(0, 8);
        let md = `# ${title}\n\nExported: ${new Date().toISOString()}\n\n---\n\n`;
        for (const msg of history) {
          const role = msg.role === 'user' ? '**You**' : '**TITAN**';
          md += `${role} (${(msg as { createdAt?: string }).createdAt || ''}):\n\n${msg.content}\n\n---\n\n`;
        }
        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', `attachment; filename="titan-${sessionId.slice(0, 8)}.md"`);
        res.send(md);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="titan-${sessionId.slice(0, 8)}.json"`);
        res.json({ sessionId, exportedAt: new Date().toISOString(), messages: history });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/sessions/:id', (req, res) => {
    const sessionId = req.params.id;
    try {
      // getHistory looks up messages for a given session ID
      const history = getHistory(sessionId);
      res.json(history);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/sessions/:id/messages', (req, res) => {
    const sessionId = req.params.id;
    try {
      const history = getHistory(sessionId);
      // history may be an array of messages or an object with a messages field
      const messages = Array.isArray(history) ? history : (history as any).messages || [];
      if (messages.length === 0) {
        // Check if the session actually exists
        const allSessions = listSessions();
        const sessionExists = allSessions.some((s) => s.id === sessionId);
        if (!sessionExists) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
      }
      res.json(messages);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/sessions/:id/close', (req, res) => {
    try {
      closeSession(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.delete('/api/sessions/:id', (req, res) => {
    try {
      closeSession(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.patch('/api/sessions/:id', (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const ok = renameSession(req.params.id, name);
      if (!ok) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/skills', (_req, res) => {
    const skills = getSkills();
    res.json(skills);
  });

  app.post('/api/skills/:name/toggle', (req, res) => {
    try {
      const { name } = req.params;
      const enabled = toggleSkill(name);
      const tools = getSkillTools(name);
      res.json({ ok: true, skill: name, enabled, tools });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // ─── Marketplace API ──────────────────────────────────────────
  app.get('/api/marketplace', async (_req, res) => {
    try {
      const skills = await listMarketplaceSkills();
      const installed = listInstalledMarketplace();
      res.json({ skills: skills.map(s => ({ ...s, installed: installed.includes(s.file.replace('.js', '')) })), installed });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/marketplace/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const results = await marketplaceSearch(q, 50);
      const installed = listInstalledMarketplace();
      res.json({ ...results, skills: results.skills.map(s => ({ ...s, installed: installed.includes(s.file.replace('.js', '')) })) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/marketplace/install', async (req, res): Promise<void> => {
    try {
      const { skill } = req.body as { skill: string };
      if (!skill) { res.status(400).json({ error: 'Missing "skill" field' }); return; }
      const result = await installSkill(skill);
      res.json(result);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/marketplace/uninstall', (req, res): void => {
    try {
      const { skill } = req.body as { skill: string };
      if (!skill) { res.status(400).json({ error: 'Missing "skill" field' }); return; }
      const result = uninstallSkill(skill);
      res.json(result);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // ── Personas ──────────────────────────────────────────────────
  app.get('/api/personas', (_req, res) => {
    try {
      const cfg = loadConfig();
      res.json({ personas: listPersonas(), active: cfg.agent.persona || 'default' });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/persona/switch', (req, res): void => {
    try {
      const { persona } = req.body as { persona: string };
      if (!persona || typeof persona !== 'string') { res.status(400).json({ error: 'Missing persona ID' }); return; }
      if (persona !== 'default' && !getPersona(persona)) { res.status(404).json({ error: `Persona "${persona}" not found` }); return; }
      const cfg = loadConfig();
      updateConfig({ agent: { ...cfg.agent, persona } });
      invalidatePersonaCache();
      res.json({ ok: true, active: persona });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/tools', (_req, res) => {
    const tools = getRegisteredTools().map((t) => ({
      name: t.name,
      description: t.description,
    }));
    res.json(tools);
  });

  app.get('/api/channels', (_req, res) => {
    const statuses = Array.from(channels.values()).map((ch) => ch.getStatus());
    res.json(statuses);
  });

  app.get('/api/security', (_req, res) => {
    const audit = auditSecurity();
    res.json(audit);
  });

  app.get('/api/providers', async (_req, res) => {
    const health = await healthCheckAll();
    res.json(health);
  });

  app.get('/api/health', (_req, res) => {
    const cfg = loadConfig();
    res.json({ status: 'ok', version: TITAN_VERSION, uptime: process.uptime(), onboarded: cfg.onboarded });
  });

  // Lightweight first-run readiness check used by Mission Control's banner.
  // Returns whether the user has at least one usable provider configured,
  // plus a counts/suggestion that the UI can render directly.
  app.get('/api/doctor/quick', async (_req, res) => {
    try {
      const { hasUsableProvider } = await import('../config/config.js');
      const usable = await hasUsableProvider();
      const cfg = loadConfig();
      const providers = (cfg.providers as Record<string, unknown> | undefined) || {};
      let configured = 0;
      for (const p of Object.values(providers)) {
        const key = (p as { apiKey?: string } | undefined)?.apiKey;
        if (key && key.trim().length > 0) configured++;
      }
      res.json({
        ready: usable.ok,
        details: usable.details,
        providersConfigured: configured,
        suggestion: usable.ok
          ? null
          : 'Run `titan onboard` (terminal) or open Settings → Providers to configure an AI provider.',
        action: usable.ok ? null : { type: 'open', target: '/settings', label: 'Open settings' },
      });
    } catch (e) {
      res.status(500).json({ ready: false, error: (e as Error).message });
    }
  });

  // ── VRAM API ────────────────────────────────────────────────
  app.get('/api/vram', async (_req, res) => {
    try {
      const { getVRAMOrchestrator } = await import('../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const snapshot = await orch.getSnapshot();
      if (!snapshot) {
        res.json({ error: 'GPU state unavailable' });
        return;
      }
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/vram/acquire', async (req, res) => {
    try {
      const { service, requiredMB, leaseDurationMs } = req.body as {
        service?: string; requiredMB?: number; leaseDurationMs?: number;
      };
      if (!service || !requiredMB) {
        res.status(400).json({ error: 'service and requiredMB required' });
        return;
      }
      if (typeof requiredMB !== 'number' || !Number.isFinite(requiredMB) || requiredMB <= 0) {
        res.status(400).json({ error: 'requiredMB must be a positive number' });
        return;
      }
      const { getVRAMOrchestrator } = await import('../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const result = await orch.acquire(service, requiredMB, leaseDurationMs || 300_000);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/vram/release', async (req, res) => {
    try {
      const { leaseId, restoreModel } = req.body as { leaseId?: string; restoreModel?: boolean };
      if (!leaseId) {
        res.status(400).json({ error: 'leaseId required' });
        return;
      }
      const { getVRAMOrchestrator } = await import('../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const result = await orch.release(leaseId, restoreModel ?? true);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/vram/check', async (req, res) => {
    try {
      const mb = parseInt(req.query.mb as string, 10);
      if (!mb || mb <= 0) {
        res.status(400).json({ error: 'mb query param required (positive integer)' });
        return;
      }
      const { getVRAMOrchestrator } = await import('../vram/orchestrator.js');
      const orch = getVRAMOrchestrator();
      const result = await orch.canAcquire(mb);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Cloud mode config endpoint ──────────────────────────────
  app.get('/api/cloud/config', (_req, res) => {
    const isCloud = process.env.TITAN_CLOUD_MODE === 'true';
    if (!isCloud) {
      return res.json({ cloud: false });
    }
    return res.json({
      cloud: true,
      apiUrl: process.env.TITAN_CLOUD_API || '',
      userId: process.env.TITAN_USER_ID || '',
      userEmail: process.env.TITAN_USER_EMAIL || '',
    });
  });

  // ── Onboarding API ──────────────────────────────────────────
  app.get('/api/onboarding/status', (_req, res) => {
    const cfg = loadConfig();
    // In cloud mode, auto-onboard if not already done
    const isCloud = process.env.TITAN_CLOUD_MODE === 'true';
    if (isCloud && !cfg.onboarded) {
      try {
        // Auto-configure for cloud: use openrouter provider pointed at SaaS gateway
        const cloudApi = process.env.TITAN_CLOUD_API || 'https://titan-api.djtony707.workers.dev';
        const openrouterKey = process.env.OPENROUTER_API_KEY || '';
        updateConfig({
          onboarded: true,
          agent: {
            ...cfg.agent,
            model: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
          },
          providers: {
            ...cfg.providers,
            openrouter: {
              ...((cfg.providers as { openrouter?: ProviderConfig }).openrouter ?? { authProfiles: [], rotationStrategy: 'priority' as const, credentialCooldownMs: 60000 }),
              apiKey: openrouterKey,
              baseUrl: cloudApi + '/api/v1',
            }
          }
        });
        broadcast({ type: 'config_updated' });
        logger.info('gateway', 'Cloud mode: auto-onboarded with SaaS API');
      } catch (e) {
        logger.error('gateway', `Cloud auto-onboard failed: ${(e as Error).message}`);
      }
      return res.json({ onboarded: true, version: TITAN_VERSION, cloud: true });
    }
    return res.json({ onboarded: cfg.onboarded, version: TITAN_VERSION, cloud: isCloud });
  });

  app.post('/api/onboarding/complete', (req, res) => {
    try {
      const { provider, apiKey, model, agentName, personality } = req.body;

      // Build config updates
      const updates: Record<string, unknown> = { onboarded: true };

      // Set provider API key
      if (provider && apiKey) {
        const providerKey = provider.toLowerCase();
        const cfg = loadConfig();
        const providers = { ...cfg.providers } as Record<string, Record<string, unknown>>;
        if (!providers[providerKey]) providers[providerKey] = {};
        providers[providerKey].apiKey = apiKey;
        updates.providers = providers;
      }

      // Set model
      if (model) {
        updates.agent = { model };
      }

      // Set agent name / personality via soul
      if (agentName || personality) {
        const soulParts: string[] = [];
        if (agentName) soulParts.push(`Your name is ${agentName}.`);
        if (personality) soulParts.push(personality);
        updates.soul = soulParts.join(' ');
      }

      updateConfig(updates);
      broadcast({ type: 'config_updated' });
      res.json({ ok: true, message: 'Onboarding complete! Welcome to TITAN.' });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Prometheus metrics endpoint (behind /api/ auth prefix)
  app.get('/api/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(serializePrometheus());
  });

  // JSON metrics summary for dashboard
  app.get('/api/metrics/summary', (_req, res) => {
    res.json(getMetricsSummary());
  });

  // MCP server status
  app.get('/api/mcp/server', (_req, res) => {
    res.json(getMcpServerStatus());
  });

  // MCP client management
  app.get('/api/mcp/clients', (_req, res) => {
    const servers = listMcpServers();
    const status = getMcpStatus();
    const merged = servers.map(s => {
      const live = status.find(st => st.server.id === s.id);
      return { ...s, status: live?.status || 'disconnected', toolCount: live?.toolCount || 0 };
    });
    res.json({ servers: merged });
  });

  app.post('/api/mcp/clients', async (req, res) => {
    try {
      const { presetId, ...serverConfig } = req.body;
      let server;
      if (presetId) {
        const preset = BUILTIN_PRESETS.find(p => p.id === presetId);
        if (!preset) { res.status(400).json({ error: `Unknown preset: ${presetId}` }); return; }
        server = addMcpServer(preset as Parameters<typeof addMcpServer>[0]);
      } else {
        server = addMcpServer(serverConfig);
      }
      if (server.enabled) {
        await connectMcpServer(server).catch(() => { /* connect errors are non-fatal */ });
      }
      res.json({ ok: true, server });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/mcp/clients/:id', (req, res) => {
    try {
      removeMcpServer(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mcp/clients/:id/toggle', (req, res) => {
    try {
      const { enabled } = req.body;
      setMcpServerEnabled(req.params.id, !!enabled);
      if (enabled) {
        const servers = listMcpServers();
        const server = servers.find(s => s.id === req.params.id);
        if (server) connectMcpServer(server).catch(() => {});
      }
      res.json({ ok: true, enabled: !!enabled });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/mcp/clients/:id/test', async (req, res) => {
    try {
      const servers = listMcpServers();
      const server = servers.find(s => s.id === req.params.id);
      if (!server) { res.status(404).json({ error: 'Server not found' }); return; }
      const result = await testMcpServer(server);
      res.json(result);
    } catch (err) {
      res.json({ ok: false, tools: 0, error: (err as Error).message });
    }
  });

  app.get('/api/mcp/presets', (_req, res) => {
    res.json({ presets: BUILTIN_PRESETS });
  });

  // Multi-agent endpoints
  app.get('/api/agents', (_req, res) => {
    res.json({ agents: listAgents(), capacity: getAgentCapacity() });
  });

  app.post('/api/agents/spawn', (req, res) => {
    const { name, model, systemPrompt } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const result = spawnAgent({ name, model, systemPrompt });
    res.json(result);
  });

  app.post('/api/agents/stop', (req, res) => {
    const { agentId } = req.body;
    if (!agentId) { res.status(400).json({ error: 'agentId is required' }); return; }
    const result = stopAgent(agentId);
    res.json(result);
  });

  // Agent message endpoint (uses multi-agent routing)
  // Supports SSE streaming when Accept: text/event-stream header is present
  app.post('/api/message', rateLimit(defaultRateLimitWindowMs, defaultRateLimitMax), concurrencyGuard(MAX_CONCURRENT_MESSAGES), async (req, res) => {
    const { content, channel: rawChannel, userId = 'api-user', agentId, sessionId: requestedSessionId, model: requestedModel } = req.body;
    // Default channel to 'webchat' for browser-based Mission Control clients.
    // This enables the interactive plan approval flow (show plan → user approves/denies).
    // Programmatic API callers can explicitly pass channel: 'api' to auto-approve plans.
    const channel = rawChannel || (req.headers.accept === 'text/event-stream' ? 'webchat' : 'api');
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a non-empty string' });
      return;
    }

    const safeUserId = channel === 'api' ? 'api-user' : (userId || 'api-user');

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
          onToken: (token) => {
            safeWrite(`event: token\ndata: ${JSON.stringify({ text: token })}\n\n`);
          },
          onToolCall: (name, args) => {
            safeWrite(`event: tool_call\ndata: ${JSON.stringify({ name, args, timestamp: Date.now() })}\n\n`);
          },
          onToolResult: (name, result, durationMs, success) => {
            safeWrite(`event: tool_end\ndata: ${JSON.stringify({ name, result: result.slice(0, 500), durationMs, success, timestamp: Date.now() })}\n\n`);
          },
          onThinking: () => {
            safeWrite(`event: thinking\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
          },
          onRound: (round, maxRounds) => {
            safeWrite(`event: round\ndata: ${JSON.stringify({ round, maxRounds, timestamp: Date.now() })}\n\n`);
          },
        }, agentId, abortController.signal, requestedSessionId, requestedModel);
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
        const response = await routeMessage(content, channel, safeUserId, undefined, agentId, abortController.signal, requestedSessionId, requestedModel);
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

  // Abort a running session
  app.post('/api/sessions/:id/abort', (req, res) => {
    const { id } = req.params;
    const controller = sessionAborts.get(id);
    if (controller) {
      controller.abort();
      sessionAborts.delete(id);
      res.json({ ok: true, message: 'Session aborted' });
    } else {
      res.json({ ok: true, message: 'No active session to abort' });
    }
  });

  // SSE streaming endpoint — real token-by-token delivery
  app.post('/api/chat/stream', rateLimit(60000, 30), async (req, res) => {
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
      res.write(`data: ${JSON.stringify({ type: 'error', error: (error as Error).message })}\n\n`);
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
    const restart = req.body?.restart === true;

    let command = 'npm update -g titan-agent';
    if (isLocalDev) {
      command = 'git pull && npm run build';
    }

    logger.info(COMPONENT, `Triggering update: ${command} (restart=${restart})`);

    exec(command, { timeout: 120_000 }, (error, stdout, _stderr) => {
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
        const scriptPath = '/tmp/titan-restart.sh';
        fs.writeFileSync(scriptPath, [
          '#!/bin/bash',
          'sleep 2',
          `cd "${cwd}"`,
          'nohup node dist/cli/index.js gateway >> /tmp/titan-gateway.log 2>&1 &',
        ].join('\n'), { mode: 0o755 });

        spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();

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
        ttsEngine: cfg.voice?.ttsEngine || 'orpheus',
        ttsUrl: cfg.voice?.ttsUrl || 'http://localhost:5005',
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
        openrouter: { configured: Boolean(cfg.providers.openrouter?.apiKey) },
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
      commandPost: {
        enabled: Boolean((cfg as Record<string, any>).commandPost?.enabled),
        heartbeatIntervalMs: (cfg as Record<string, any>).commandPost?.heartbeatIntervalMs ?? 30000,
        maxConcurrentAgents: (cfg as Record<string, any>).commandPost?.maxConcurrentAgents ?? 10,
        checkoutTimeoutMs: (cfg as Record<string, any>).commandPost?.checkoutTimeoutMs ?? 300000,
      },
    });
  });

  app.post('/api/config', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const cfg = loadConfig();
      // Clone config to avoid mutating live state before validation succeeds
      const draft = JSON.parse(JSON.stringify(cfg)) as typeof cfg;

      // Track which config fields are being changed for restart detection
      const changedFields: string[] = [];

      if (body.model) { draft.agent.model = body.model as string; changedFields.push('agent.model'); }
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
      if (body.openrouterKey !== undefined) { draft.providers.openrouter.apiKey = body.openrouterKey as string; changedFields.push('providers.openrouter.apiKey'); }
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
      if (changedFields.length === 0) {
        const validFields = ['model', 'autonomyMode', 'sandboxMode', 'logLevel', 'anthropicKey', 'openaiKey',
          'googleKey', 'ollamaUrl', 'groqKey', 'mistralKey', 'openrouterKey', 'fireworksKey', 'xaiKey',
          'togetherKey', 'deepseekKey', 'perplexityKey', 'maxTokens', 'temperature', 'systemPrompt',
          'shieldEnabled', 'shieldMode', 'deniedTools', 'networkAllowlist', 'gatewayPort', 'gatewayAuthMode',
          'gatewayPassword', 'gatewayToken', 'channels', 'googleOAuthClientId', 'googleOAuthClientSecret',
          'homeAssistantUrl', 'homeAssistantToken', 'voice', 'nvidia'];
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

  app.post('/api/model/switch', async (req, res) => {
    try {
      const { model } = req.body as { model?: string };
      if (!model) { res.status(400).json({ error: 'model is required' }); return; }
      // Hunt Finding #25 (2026-04-14): validate input SHAPE before anything else.
      // Prevents writing bogus strings to config.
      if (typeof model !== 'string' || model.length === 0 || model.length > 200) {
        res.status(400).json({ error: 'model must be a non-empty string up to 200 chars' });
        return;
      }
      if (!/^[a-zA-Z0-9._:\-/]+$/.test(model)) {
        res.status(400).json({ error: 'model contains invalid characters (allowed: alnum, ._:-/)' });
        return;
      }
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
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Learning stats endpoint
  app.get('/api/learning', (_req, res) => {
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
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Mesh Networking Endpoints ─────────────────────────────────
  app.get('/api/mesh/hello', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ titan: false, enabled: false }); return; }
    const { getOrCreateNodeId } = await import('../mesh/identity.js');
    const { getActiveRemoteTaskCount } = await import('../mesh/transport.js');
    const { discoverAllModels: discoverModels } = await import('../providers/router.js');
    const models = await discoverModels();
    const { listAgents: meshListAgents } = await import('../agent/multiAgent.js');
    const cpuLoad = getCpuLoad();
    const activeTasks = getActiveRemoteTaskCount();
    // Load score: 0.0 (idle) to 1.0 (maxed). Blend CPU + task saturation.
    const taskLoad = activeTasks / Math.max(cfg.mesh.maxRemoteTasks, 1);
    const load = Math.min(1, cpuLoad * 0.4 + taskLoad * 0.6);
    res.json({
      titan: true,
      nodeId: getOrCreateNodeId(),
      version: TITAN_VERSION,
      models: models.map(m => m.id),
      agentCount: meshListAgents().length,
      load: Math.round(load * 100) / 100,
    });
  });

  app.get('/api/mesh/peers', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ peers: [], enabled: false }); return; }
    const { getPeers } = await import('../mesh/discovery.js');
    res.json({ peers: getPeers(), enabled: true });
  });

  app.get('/api/mesh/models', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ models: [] }); return; }
    const { getMeshModels } = await import('../mesh/registry.js');
    res.json({ models: getMeshModels() });
  });

  app.get('/api/mesh/pending', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ pending: [], enabled: false }); return; }
    const { getPendingPeers } = await import('../mesh/discovery.js');
    res.json({ pending: getPendingPeers(), enabled: true });
  });

  app.post('/api/mesh/approve/:nodeId', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.status(400).json({ error: 'Mesh not enabled' }); return; }
    const { approvePeer } = await import('../mesh/discovery.js');
    const peer = approvePeer(req.params.nodeId);
    if (peer) {
      broadcast({ type: 'mesh_peer_approved', peer });
      res.json({ approved: true, peer });
    } else {
      res.status(404).json({ error: 'Peer not found in pending list or at max capacity' });
    }
  });

  app.post('/api/mesh/reject/:nodeId', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.status(400).json({ error: 'Mesh not enabled' }); return; }
    const { rejectPeer } = await import('../mesh/discovery.js');
    const rejected = rejectPeer(req.params.nodeId);
    res.json({ rejected });
  });

  app.post('/api/mesh/revoke/:nodeId', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.status(400).json({ error: 'Mesh not enabled' }); return; }
    const { revokePeer } = await import('../mesh/discovery.js');
    const revoked = revokePeer(req.params.nodeId);
    if (revoked) {
      broadcast({ type: 'mesh_peer_revoked', nodeId: req.params.nodeId });
    }
    res.json({ revoked });
  });

  // ── Mesh Health / Status Endpoint ─────────────────────────────
  app.get('/api/mesh/status', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ enabled: false, status: 'disabled' }); return; }

    const { getOrCreateNodeId } = await import('../mesh/identity.js');
    const { getPeers, getPendingPeers } = await import('../mesh/discovery.js');
    const { getConnectedPeerCount } = await import('../mesh/transport.js');
    const { getOrCreateNodeId: localNodeId } = await import('../mesh/identity.js');

    const nodeId = getOrCreateNodeId();
    const approvedPeers = getPeers();
    const pendingPeers = getPendingPeers();
    const connectedCount = getConnectedPeerCount();
    const connectedPeerIds = new Set<string>();

    // Collect per-peer connection detail from approved list + transport
    const peerDetails = approvedPeers.map(p => {
      const isConnected = p.lastSeen > Date.now() - 10_000; // Consider connected if seen in last 10s
      if (isConnected) connectedPeerIds.add(p.nodeId);
      return {
        nodeId: p.nodeId,
        hostname: p.hostname,
        address: p.address,
        port: p.port,
        discoveredVia: p.discoveredVia,
        lastSeen: p.lastSeen,
        models: p.models,
        agentCount: p.agentCount,
        load: p.load,
        isConnected,
      };
    });

    // Composite health score
    const totalApproved = approvedPeers.length;
    const unreachableCount = totalApproved - connectedCount;
    const healthScore = totalApproved > 0
      ? Math.round(((totalApproved - unreachableCount) / totalApproved) * 100) / 100
      : 1.0;

    // Discovery mode detection
    const discoveryModes: string[] = [];
    if (cfg.mesh.mdns) discoveryModes.push('mdns');
    if (cfg.mesh.tailscale) discoveryModes.push('tailscale');
    if ((cfg.mesh.staticPeers || []).length > 0) discoveryModes.push('manual');

    const status = unreachableCount === 0 && totalApproved > 0
      ? 'healthy'
      : unreachableCount > 0 && connectedCount > 0
        ? 'degraded'
        : totalApproved === 0
          ? 'empty'
          : 'unreachable';

    res.json({
      enabled: true,
      status,
      nodeId,
      discoveryModes,
      peers: {
        total: totalApproved,
        connected: connectedCount,
        unreachable: unreachableCount,
        pending: pendingPeers.length,
      },
      peerDetails,
      healthScore,
      maxPeers: cfg.mesh.maxPeers,
      autoApprove: cfg.mesh.autoApprove,
    });
  });

  // ── Mesh Routes Endpoint ───────────────────────────────────────
  app.get('/api/mesh/routes', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ enabled: false, routes: [] }); return; }
    const { getRoutingTable } = await import('../mesh/transport.js');
    res.json({ routes: getRoutingTable() });
  });

  // ── Teams RBAC API ─────────────────────────────────────────────

  app.get('/api/teams', (_req, res) => {
    res.json({ teams: listTeams().map(t => ({ id: t.id, name: t.name, description: t.description, memberCount: t.members.filter(m => m.status === 'active').length, createdAt: t.createdAt })) });
  });

  app.post('/api/teams', (req, res) => {
    try {
      const { name, description, ownerId = 'api-user' } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const team = createTeam(name, ownerId, description);
      res.status(201).json({ team: { id: team.id, name: team.name } });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.get('/api/teams/:teamId', (req, res) => {
    const team = getTeam(req.params.teamId);
    if (!team) { res.status(404).json({ error: 'Team not found' }); return; }
    res.json({ team, stats: getTeamStats(req.params.teamId) });
  });

  app.patch('/api/teams/:teamId', (req, res) => {
    try {
      const { name, description, actorId = 'api-user' } = req.body;
      const team = updateTeam(req.params.teamId, actorId, { name, description });
      res.json({ team: { id: team.id, name: team.name, description: team.description } });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.delete('/api/teams/:teamId', (req, res) => {
    try {
      const actorId = (req.query.actorId as string) || 'api-user';
      const deleted = deleteTeam(req.params.teamId, actorId);
      res.json({ deleted });
    } catch (e) { res.status(403).json({ error: (e as Error).message }); }
  });

  app.get('/api/teams/:teamId/members', (req, res) => {
    const team = getTeam(req.params.teamId);
    if (!team) { res.status(404).json({ error: 'Team not found' }); return; }
    res.json({ members: team.members });
  });

  app.post('/api/teams/:teamId/members', (req, res) => {
    try {
      const { userId, role = 'operator', displayName, actorId = 'api-user' } = req.body;
      if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
      const member = addMember(req.params.teamId, actorId, userId, role, displayName);
      res.status(201).json({ member });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.delete('/api/teams/:teamId/members/:userId', (req, res) => {
    try {
      const actorId = (req.query.actorId as string) || 'api-user';
      const removed = removeMember(req.params.teamId, actorId, req.params.userId);
      res.json({ removed });
    } catch (e) { res.status(403).json({ error: (e as Error).message }); }
  });

  app.patch('/api/teams/:teamId/members/:userId/role', (req, res) => {
    try {
      const { role, actorId = 'api-user' } = req.body;
      if (!role) { res.status(400).json({ error: 'role is required' }); return; }
      const member = updateMemberRole(req.params.teamId, actorId, req.params.userId, role);
      res.json({ member });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.post('/api/teams/:teamId/invites', (req, res) => {
    try {
      const { role = 'operator', expiresInHours = 48, actorId = 'api-user' } = req.body;
      const code = createInvite(req.params.teamId, actorId, role, expiresInHours);
      res.status(201).json({ code, expiresInHours });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.post('/api/teams/join', (req, res) => {
    try {
      const { code, userId, displayName } = req.body;
      if (!code || !userId) { res.status(400).json({ error: 'code and userId are required' }); return; }
      const result = acceptInvite(code, userId, displayName);
      res.json({ teamId: result.team.id, teamName: result.team.name, role: result.member.role });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.get('/api/teams/:teamId/permissions/:userId', (req, res) => {
    const perms = getEffectivePermissions(req.params.teamId, req.params.userId);
    const role = getUserRole(req.params.teamId, req.params.userId);
    res.json({ role, permissions: perms });
  });

  app.put('/api/teams/:teamId/roles/:role/permissions', (req, res) => {
    try {
      const { actorId = 'api-user', ...perms } = req.body;
      setRolePermissions(req.params.teamId, actorId, req.params.role as 'admin' | 'operator' | 'viewer', perms);
      res.json({ updated: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.get('/api/teams/:teamId/tools/:toolName/check/:userId', (req, res) => {
    const allowed = isToolAllowed(req.params.teamId, req.params.userId, req.params.toolName);
    res.json({ allowed, tool: req.params.toolName, userId: req.params.userId });
  });

  // ── Recipes / Workflow API ──────────────────────────────────────

  app.get('/api/recipes', (_req, res) => {
    res.json({ recipes: listRecipes() });
  });

  app.get('/api/recipes/:id', (req, res) => {
    const recipe = getRecipe(req.params.id);
    if (!recipe) { res.status(404).json({ error: 'Recipe not found' }); return; }
    res.json({ recipe });
  });

  app.post('/api/recipes', (req, res) => {
    const recipe = req.body;
    if (!recipe.id || !recipe.name || !recipe.steps) {
      res.status(400).json({ error: 'id, name, and steps are required' }); return;
    }
    if (!recipe.createdAt) recipe.createdAt = new Date().toISOString();
    saveRecipe(recipe);
    res.status(201).json({ recipe });
  });

  app.put('/api/recipes/:id', (req, res) => {
    const existing = getRecipe(req.params.id);
    if (!existing) { res.status(404).json({ error: 'Recipe not found' }); return; }
    const updated = { ...existing, ...req.body, id: req.params.id };
    saveRecipe(updated);
    res.json({ recipe: updated });
  });

  app.delete('/api/recipes/:id', (req, res) => {
    if (!getRecipe(req.params.id)) { res.status(404).json({ error: 'Recipe not found' }); return; }
    deleteRecipe(req.params.id);
    res.json({ deleted: true });
  });

  app.get('/api/recipes/builtin/templates', (_req, res) => {
    res.json({ templates: getBuiltinRecipes() });
  });

  app.post('/api/recipes/import', express.text({ type: 'text/*' }), (req, res) => {
    try {
      const recipe = importRecipeYaml(req.body);
      saveRecipe(recipe);
      res.status(201).json({ recipe });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // ── Plugins API ────────────────────────────────────────────────
  app.get('/api/plugins', async (_req, res) => {
    const { getPlugins } = await import('../plugins/registry.js');
    const plugins = getPlugins().map((p: { name: string; version: string }) => ({
      name: p.name,
      version: p.version,
    }));
    res.json({ plugins });
  });

  // Native Memory Graph endpoint (replaces Neo4j/Graphiti)
  app.get('/api/graphiti', (_req, res) => {
    try {
      const { nodes, edges } = getGraphData();
      const { episodeCount } = getGraphStats();
      res.json({
        graphReady: true,
        episodeCount,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes,
        edges,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Clear memory graph
  app.delete('/api/graphiti', (_req, res) => {
    try {
      clearGraph();
      logger.info(COMPONENT, 'Memory graph cleared via API');
      res.json({ success: true, message: 'Graph cleared' });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/graphiti/cleanup', (_req, res) => {
    try {
      const result = cleanupGraph();
      logger.info(COMPONENT, `Graph cleanup: removed ${result.removedEntities} entities, ${result.removedEdges} edges`);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Memory Wiki API — browseable knowledge base
  app.get('/api/wiki/entities', (req, res) => {
    try {
      const type = req.query.type as string | undefined;
      const q = req.query.q as string | undefined;
      let entities = listEntities(type || undefined);
      if (q) {
        const query = q.toLowerCase();
        entities = entities.filter(e =>
          e.name.toLowerCase().includes(query) ||
          e.facts.some(f => f.toLowerCase().includes(query)) ||
          (e.summary || '').toLowerCase().includes(query)
        );
      }
      res.json(entities.map(e => ({
        id: e.id,
        name: e.name,
        type: e.type,
        summary: e.summary,
        factCount: e.facts.length,
        aliases: e.aliases,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      })));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/wiki/entity/:name', (req, res) => {
    try {
      const entity = getEntity(decodeURIComponent(req.params.name));
      if (!entity) { res.status(404).json({ error: 'Entity not found' }); return; }
      // Get related entities via edges
      const graphData = getGraphData();
      const relatedEdges = graphData.edges.filter(e => e.from === entity.id || e.to === entity.id);
      const relatedIds = new Set(relatedEdges.map(e => e.from === entity.id ? e.to : e.from));
      const related = graphData.nodes.filter(n => relatedIds.has(n.id)).map(n => ({
        id: n.id,
        name: n.label,
        type: n.type,
        relation: relatedEdges.find(e => (e.from === entity.id && e.to === n.id) || (e.to === entity.id && e.from === n.id))?.label || 'co_mentioned',
      }));
      // Get episodes
      const episodes = getEntityEpisodes(entity.id, 20).map(ep => ({
        id: ep.id,
        content: ep.content.slice(0, 300),
        source: ep.source,
        createdAt: ep.createdAt,
      }));
      res.json({ ...entity, related, episodes });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Agent Templates (marketplace)
  app.get('/api/agent-templates', async (_req, res) => {
    try {
      const { listTemplates, BUILTIN_TEMPLATES } = await import('../skills/agentTemplates.js');
      const installed = listTemplates();
      res.json({ builtin: BUILTIN_TEMPLATES, installed });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/agent-templates', async (req, res) => {
    try {
      const { saveTemplate } = await import('../skills/agentTemplates.js');
      saveTemplate(req.body);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Training data (RL trajectory capture)
  app.get('/api/training/stats', async (_req, res) => {
    try {
      const { getTrainingStats } = await import('../agent/trajectoryCapture.js');
      res.json(getTrainingStats());
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/training/export', async (_req, res) => {
    try {
      const { exportTrainingData } = await import('../agent/trajectoryCapture.js');
      res.setHeader('Content-Type', 'application/jsonl');
      res.setHeader('Content-Disposition', 'attachment; filename="titan-training-data.jsonl"');
      res.send(exportTrainingData());
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Dreaming memory (sleep-cycle consolidation)
  app.get('/api/dreaming/status', async (_req, res) => {
    try {
      const { getDreamingStatus } = await import('../memory/dreaming.js');
      res.json(getDreamingStatus());
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/dreaming/run', async (_req, res) => {
    try {
      const { runConsolidation } = await import('../memory/dreaming.js');
      const result = await runConsolidation();
      res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/dreaming/history', async (_req, res) => {
    try {
      const { getConsolidationHistory } = await import('../memory/dreaming.js');
      res.json(getConsolidationHistory());
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Backup system
  app.post('/api/backup/create', async (_req, res) => {
    try {
      const { createBackup } = await import('../storage/backup.js');
      const info = await createBackup();
      res.json({ success: true, ...info });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get('/api/backup/list', async (_req, res) => {
    try {
      const { listBackups } = await import('../storage/backup.js');
      res.json(listBackups());
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.post('/api/backup/verify', async (req, res) => {
    try {
      const { verifyBackup, listBackups } = await import('../storage/backup.js');
      const path = req.body?.path || listBackups()[0]?.path;
      if (!path) { res.status(400).json({ error: 'No backup path specified and no backups found' }); return; }
      const result = await verifyBackup(path);
      res.json(result);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
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
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Autopilot ───────────────────────────────────────────────
  app.get('/api/autopilot/status', (_req, res) => {
    res.json(getAutopilotStatus());
  });

  app.get('/api/autopilot/history', (req, res) => {
    const limit = parseInt(req.query.limit as string, 10) || 30;
    res.json(getRunHistory(limit));
  });

  app.post('/api/autopilot/run', async (req, res) => {
    try {
      const dryRun = typeof req.body?.dryRun === 'boolean' ? req.body.dryRun : undefined;
      const result = await runAutopilotNow({ dryRun });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/autopilot/toggle', (req, res) => {
    try {
      const cfg = loadConfig();
      const enable = typeof req.body.enabled === 'boolean' ? req.body.enabled : !cfg.autopilot.enabled;
      const dryRun = typeof req.body.dryRun === 'boolean' ? req.body.dryRun : undefined;

      cfg.autopilot.enabled = enable;
      if (typeof dryRun === 'boolean') {
        (cfg.autopilot as Record<string, unknown>).dryRun = dryRun;
        setAutopilotDryRun(dryRun);
      }

      if (enable) {
        initAutopilot(cfg);
      } else {
        stopAutopilot();
      }
      const status = getAutopilotStatus();
      res.json({ enabled: enable, dryRun: status.dryRun });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Goals API ─────────────────────────────────────────────

  app.get('/api/goals', (_req, res) => {
    res.json({ goals: listGoals() });
  });

  app.post('/api/goals', (req, res) => {
    const { title, description, subtasks, priority, tags } = req.body;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const goal = createGoal({
      title,
      description: description || '',
      subtasks: subtasks || [],
      priority,
      tags,
    });
    res.status(201).json({ goal });
  });

  app.get('/api/goals/:id', (req, res) => {
    const goal = getGoal(req.params.id);
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json({ goal });
  });

  app.delete('/api/goals/:id', (req, res) => {
    const deleted = deleteGoal(req.params.id);
    if (!deleted) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json({ deleted: true });
  });

  app.post('/api/goals/:id/subtasks', (req, res) => {
    const { title, description } = req.body;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const subtask = addSubtask(req.params.id, title, description || '');
    if (!subtask) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.status(201).json({ subtask });
  });

  app.post('/api/goals/:id/subtasks/:sid/complete', (req, res) => {
    const ok = completeSubtask(req.params.id, req.params.sid, req.body.result || 'Completed via UI');
    if (!ok) { res.status(404).json({ error: 'Goal or subtask not found' }); return; }
    res.json({ completed: true });
  });

  // ── Daemon API ────────────────────────────────────────────

  app.get('/api/daemon/status', (_req, res) => {
    res.json(getDaemonStatus());
  });

  app.post('/api/daemon/stop', (_req, res) => {
    pauseDaemonManual();
    res.json({ paused: true });
  });

  app.post('/api/daemon/resume', (_req, res) => {
    resumeDaemon();
    res.json({ resumed: true });
  });

  app.get('/api/daemon/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const onEvent = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    const events = ['daemon:started', 'daemon:stopped', 'daemon:paused', 'daemon:resumed',
                     'daemon:heartbeat', 'goal:subtask:ready', 'health:ollama:down',
                     'health:ollama:degraded', 'cron:stuck',
                     'initiative:start', 'initiative:complete', 'initiative:no_progress',
                     'initiative:tool_call', 'initiative:tool_result', 'initiative:round'];

    // Store per-client listener references so we only remove THIS client's listeners on disconnect
    const listeners = new Map<string, (data: unknown) => void>();
    for (const evt of events) {
      const handler = (data: unknown) => onEvent(evt, data);
      listeners.set(evt, handler);
      titanEvents.on(evt, handler);
    }

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* client gone */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      for (const [evt, handler] of listeners) {
        titanEvents.removeListener(evt, handler);
      }
    });
  });

  // ── Command Post API (Agent Governance) ───────────────────

  app.get('/api/command-post/dashboard', async (_req, res) => {
    const dashboard = getCPDashboard();
    // Inject companies into dashboard
    try {
      const { listCompanies, getActiveRunners } = await import('../agent/company.js');
      const companies = listCompanies();
      const runners = getActiveRunners();
      (dashboard as Record<string, unknown>).companies = companies.map(c => ({
        ...c,
        runnerActive: runners.includes(c.id),
      }));
    } catch { (dashboard as Record<string, unknown>).companies = []; }
    res.json(dashboard);
  });

  app.get('/api/command-post/agents', (_req, res) => {
    res.json(getRegisteredAgents());
  });

  app.post('/api/command-post/agents/:id/heartbeat', (req, res) => {
    const ok = reportHeartbeat(req.params.id);
    res.json({ success: ok });
  });

  app.delete('/api/command-post/agents/:id', (req, res) => {
    const ok = removeAgent(req.params.id);
    if (!ok) { res.status(400).json({ error: 'Cannot remove agent (not found or is the primary agent)' }); return; }
    res.json({ success: true });
  });

  app.post('/api/command-post/tasks/:goalId/:subtaskId/checkout', (req, res) => {
    const agentId = (req.body as { agentId?: string }).agentId || 'manual';
    const lock = checkoutTask(req.params.goalId, req.params.subtaskId, agentId);
    if (!lock) { res.status(409).json({ error: 'Task already checked out by another agent' }); return; }
    res.json(lock);
  });

  app.post('/api/command-post/tasks/:goalId/:subtaskId/checkin', (req, res) => {
    const runId = (req.body as { runId?: string }).runId || '';
    const ok = checkinTask(req.params.subtaskId, runId);
    if (!ok) { res.status(404).json({ error: 'No matching checkout found' }); return; }
    res.json({ success: true });
  });

  app.get('/api/command-post/checkouts', (_req, res) => {
    res.json(getActiveCheckouts());
  });

  app.get('/api/command-post/budgets', (_req, res) => {
    res.json(getBudgetPolicies());
  });

  app.post('/api/command-post/budgets', (req, res) => {
    try {
      const body = req.body as { name: string; scope: { type: 'agent' | 'goal' | 'global'; targetId?: string }; period: 'daily' | 'weekly' | 'monthly'; limitUsd: number; warningThresholdPercent?: number; action?: 'warn' | 'pause' | 'stop'; enabled?: boolean };
      const policy = createBudgetPolicy({
        name: body.name,
        scope: body.scope,
        period: body.period,
        limitUsd: body.limitUsd,
        warningThresholdPercent: body.warningThresholdPercent ?? 80,
        action: body.action ?? 'pause',
        enabled: body.enabled ?? true,
      });
      res.status(201).json(policy);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/command-post/budgets/:id', (req, res) => {
    const updated = updateBudgetPolicy(req.params.id, req.body as Record<string, unknown>);
    if (!updated) { res.status(404).json({ error: 'Budget policy not found' }); return; }
    res.json(updated);
  });

  app.delete('/api/command-post/budgets/:id', (req, res) => {
    const ok = deleteBudgetPolicy(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Budget policy not found' }); return; }
    res.json({ success: true });
  });

  app.get('/api/command-post/activity', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const type = req.query.type as string | undefined;
    res.json(getActivity({ limit, type }));
  });

  app.get('/api/command-post/goals/tree', (_req, res) => {
    res.json(getGoalTree());
  });

  app.get('/api/command-post/goals/:id/ancestry', (req, res) => {
    const chain = getAncestryChain(req.params.id);
    if (chain.length === 0) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json(chain);
  });

  // ── Ancestry Validation ───────────────────────────────
  app.post('/api/command-post/goals/:id/validate', (req, res) => {
    const { parentGoalId } = req.body as { parentGoalId?: string | null };
    if (parentGoalId !== undefined) {
      // Validate potential parent assignment
      const result = validateGoalParentAssignment(req.params.id, parentGoalId || null);
      if (!result.valid) {
        res.status(422).json({ valid: false, errors: result.errors });
        return;
      }
      res.json({ valid: true });
    } else {
      // Validate existing ancestry chain
      const result = validateGoalAncestry(req.params.id);
      if (!result.valid) {
        res.status(422).json({ valid: false, errors: result.errors });
        return;
      }
      res.json({ valid: true });
    }
  });

  // ── Checkout Sweep ────────────────────────────────────
  app.post('/api/command-post/checkouts/sweep', (_req, res) => {
    const result = sweepExpiredCheckoutsManual();
    res.json(result);
  });

  app.get('/api/command-post/checkouts/expired', (_req, res) => {
    const result = sweepExpiredCheckoutsManual();
    res.json({ expired: result.swept, details: result.details });
  });

  // ── Stale Agents ──────────────────────────────────────
  app.get('/api/command-post/agents/stale', (_req, res) => {
    const stale = getStaleAgents();
    res.json({ stale, total: stale.length });
  });

  // ── Budget Enforcement per Agent ──────────────────────
  app.post('/api/command-post/budgets/:agentId/enforce', (req, res) => {
    const result = enforceBudgetForAgent(req.params.agentId);
    if (!result.budgetOk) {
      res.status(403).json({ budgetOk: false, policies: result.policies, message: 'Budget exceeded — agent paused' });
      return;
    }
    res.json({ budgetOk: true, policies: result.policies });
  });

  app.get('/api/command-post/budgets/agent/:agentId', (req, res) => {
    const budgetInfo = getBudgetPolicyForAgent(req.params.agentId);
    res.json(budgetInfo);
  });

  // Command Post SSE stream
  app.get('/api/command-post/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const onEvent = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    const cpEvents = [
      'commandpost:activity', 'commandpost:task:checkout', 'commandpost:task:checkin',
      'commandpost:task:expired', 'commandpost:budget:warning', 'commandpost:budget:exceeded',
      'commandpost:agent:heartbeat', 'commandpost:agent:status',
    ];

    const listeners = new Map<string, (data: unknown) => void>();
    for (const evt of cpEvents) {
      const handler = (data: unknown) => onEvent(evt, data);
      listeners.set(evt, handler);
      titanEvents.on(evt, handler);
    }

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* client gone */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      for (const [evt, handler] of listeners) {
        titanEvents.removeListener(evt, handler);
      }
    });
  });

  // ── Deliberation Plan Events (SSE) ──────────────────────────
  app.get('/api/deliberation/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const handler = (data: unknown) => {
      try { res.write(`event: plan\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };
    titanEvents.on('plan:event', handler);

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* client gone */ }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      titanEvents.removeListener('plan:event', handler);
    });
  });

  // ── Paperclip: Org Chart ──────────────────────────────────
  app.get('/api/command-post/org', async (_req, res) => {
    const org = getOrgTree();
    // Append company agents to org tree
    try {
      const { listCompanies } = await import('../agent/company.js');
      const companies = listCompanies();
      const companyNodes = companies.map(c => ({
        id: c.id,
        name: c.name,
        role: 'Company',
        title: c.description,
        status: c.status,
        model: '',
        reports: c.agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          title: a.template,
          status: a.status,
          model: '',
          reports: [],
        })),
      }));
      if (Array.isArray(org)) {
        org.push(...companyNodes);
      } else if (org && typeof org === 'object') {
        (org as Record<string, unknown>).companies = companyNodes;
      }
    } catch { /* non-critical */ }
    res.json(org);
  });

  // ── Paperclip: Issues/Tickets ────────────────────────────
  app.get('/api/command-post/issues', (req, res) => {
    const filters = {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assignee as string | undefined,
      goalId: req.query.goalId as string | undefined,
    };
    res.json(listIssues(filters));
  });

  app.post('/api/command-post/issues', (req, res) => {
    const { title, description, priority, assigneeAgentId, goalId, parentId } = req.body;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const issue = createIssue({ title, description, priority, assigneeAgentId, goalId, parentId, createdByUser: 'board' });
    res.status(201).json(issue);
  });

  app.get('/api/command-post/issues/:id', (req, res) => {
    const issue = getIssue(req.params.id);
    if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
    const issueComments = getIssueComments(req.params.id);
    res.json({ ...issue, comments: issueComments });
  });

  app.patch('/api/command-post/issues/:id', (req, res) => {
    const { title, description, status, priority, assigneeAgentId, goalId } = req.body;
    const updated = updateIssue(req.params.id, { title, description, status, priority, assigneeAgentId, goalId });
    if (!updated) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.json(updated);
  });

  app.delete('/api/command-post/issues/:id', (req, res) => {
    const ok = deleteIssue(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.json({ success: true });
  });

  app.post('/api/command-post/issues/:id/checkout', (req, res) => {
    const { agentId } = req.body;
    if (!agentId) { res.status(400).json({ error: 'agentId is required' }); return; }
    const result = checkoutIssue(req.params.id, agentId);
    if (!result) { res.status(409).json({ error: 'Issue already checked out by another agent' }); return; }
    res.json(result);
  });

  app.post('/api/command-post/issues/:id/comments', (req, res) => {
    const { body: commentBody, agentId } = req.body;
    if (!commentBody) { res.status(400).json({ error: 'body is required' }); return; }
    const comment = addIssueComment(req.params.id, commentBody, { agentId, user: agentId ? undefined : 'board' });
    if (!comment) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.status(201).json(comment);
  });

  // ── Paperclip: Approvals ─────────────────────────────────
  app.get('/api/command-post/approvals', (req, res) => {
    const status = req.query.status as string | undefined;
    res.json(listApprovals(status));
  });

  app.post('/api/command-post/approvals', (req, res) => {
    const { type, requestedBy, payload, linkedIssueIds } = req.body;
    if (!type) { res.status(400).json({ error: 'type is required' }); return; }
    const approval = createApproval({ type, requestedBy: requestedBy || 'board', payload: payload || {}, linkedIssueIds });
    res.status(201).json(approval);
  });

  app.post('/api/command-post/approvals/:id/approve', (req, res) => {
    const { decidedBy, note } = req.body;
    const result = approveApproval(req.params.id, decidedBy || 'board', note);
    if (!result) { res.status(404).json({ error: 'Approval not found or already decided' }); return; }
    res.json(result);
  });

  app.post('/api/command-post/approvals/:id/reject', (req, res) => {
    const { decidedBy, note } = req.body;
    const result = rejectApproval(req.params.id, decidedBy || 'board', note);
    if (!result) { res.status(404).json({ error: 'Approval not found or already decided' }); return; }
    res.json(result);
  });

  // ── Paperclip: Runs ──────────────────────────────────────
  app.get('/api/command-post/runs', (req, res) => {
    const agentId = req.query.agentId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(listRuns(agentId, limit));
  });

  // ── Paperclip: Agent Updates (org chart fields) ──────────
  app.patch('/api/command-post/agents/:id', (req, res) => {
    const { reportsTo, role, title, name } = req.body;
    const updated = updateRegisteredAgent(req.params.id, { reportsTo, role, title, name });
    if (!updated) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json(updated);
  });

  // ── Wakeup System (async sub-agent delegation) ────────────

  app.get('/api/command-post/agents/:agentId/inbox', (req, res) => {
    const items = getAgentInbox(req.params.agentId);
    res.json({ items, total: items.length });
  });

  app.post('/api/command-post/wakeup', (req, res) => {
    const { issueId, agentId, agentName, task, templateName } = req.body;
    if (!issueId || !agentId || !task) {
      res.status(400).json({ error: 'issueId, agentId, and task are required' });
      return;
    }
    const wakeup = queueWakeup({
      issueId,
      issueIdentifier: issueId,
      agentId,
      agentName: agentName || 'Agent',
      parentSessionId: null,
      task,
      templateName: templateName || '',
    });
    res.json({ wakeupRequestId: wakeup.id, status: wakeup.status });
  });

  app.get('/api/command-post/wakeup/:requestId', (req, res) => {
    const request = getWakeupRequest(req.params.requestId);
    if (!request) { res.status(404).json({ error: 'Wakeup request not found' }); return; }
    res.json(request);
  });

  app.delete('/api/command-post/wakeup/:requestId', (req, res) => {
    const cancelled = cancelWakeup(req.params.requestId);
    if (!cancelled) { res.status(409).json({ error: 'Request already running or completed' }); return; }
    res.json({ cancelled: true });
  });

  app.get('/api/command-post/sessions/:sessionId/pending-results', (req, res) => {
    const results = drainPendingResults(req.params.sessionId);
    res.json({ results, count: results.length });
  });

  // ── Files API (Full file manager with configurable roots) ────────────────────

  // Helper: resolve configured root directories
  function getFileRoots(): Array<{ label: string; path: string }> {
    const cfg = loadConfig();
    const fmCfg = (cfg as Record<string, unknown>).fileManager as { roots?: string[]; blockedPatterns?: string[] } | undefined;
    const roots = fmCfg?.roots || ['~/.titan'];
    return roots.map(r => {
      const expanded = r.replace(/^~/, homedir());
      const abs = resolve(expanded);
      // Label: last dir component or full path for short ones
      const label = abs.split('/').filter(Boolean).pop() || abs;
      return { label, path: abs };
    });
  }

  // Helper: validate a path is within an allowed root and not blocked
  function validateFilePath(reqPath: string, rootParam?: string): { valid: boolean; fullPath: string; basePath: string; error?: string } {
    const roots = getFileRoots();
    if (roots.length === 0) return { valid: false, fullPath: '', basePath: '', error: 'No file roots configured' };

    // Select root: by index, by label, or default to first
    let selectedRoot = roots[0];
    if (rootParam) {
      const byIndex = roots[parseInt(rootParam, 10)];
      const byLabel = roots.find(r => r.label === rootParam || r.path === rootParam);
      selectedRoot = byIndex || byLabel || roots[0];
    }

    const basePath = selectedRoot.path;
    const fullPath = resolve(basePath, reqPath.replace(/^\//, ''));

    // Security: must stay within root.
    // Hunt Finding #34 (2026-04-14): previous `fullPath.startsWith(basePath)`
    // let siblings through — e.g. if basePath=/home/dj/workspace and the
    // attacker supplies path=/home/dj/workspace-evil/file, resolve() returns
    // /home/dj/workspace-evil/file which startsWith('/home/dj/workspace')
    // is TRUE, granting access to a directory outside the configured root.
    // Check for exact match or path-separator boundary.
    const basePathWithSep = basePath.endsWith('/') ? basePath : basePath + '/';
    if (fullPath !== basePath && !fullPath.startsWith(basePathWithSep)) {
      return { valid: false, fullPath, basePath, error: 'Access denied: path outside allowed root' };
    }

    // Security: check blocked patterns
    const cfg = loadConfig();
    const fmCfg = (cfg as Record<string, unknown>).fileManager as { blockedPatterns?: string[] } | undefined;
    const blocked = fmCfg?.blockedPatterns || ['.ssh', '.env', '.aws', '.gnupg', 'node_modules', '.git/objects'];
    for (const pattern of blocked) {
      if (fullPath.includes(`/${pattern}`) || fullPath.endsWith(`/${pattern}`)) {
        return { valid: false, fullPath, basePath, error: `Access denied: blocked pattern "${pattern}"` };
      }
    }

    return { valid: true, fullPath, basePath };
  }

  // GET /api/files/roots — list configured root directories
  app.get('/api/files/roots', (_req, res) => {
    res.json({ roots: getFileRoots() });
  });

  // GET /api/files — list directory contents
  app.get('/api/files', (req, res) => {
    const reqPath = (req.query.path as string) || '';
    const rootParam = req.query.root as string | undefined;
    const { valid, fullPath, basePath, error } = validateFilePath(reqPath, rootParam);

    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'Path not found' }); return; }
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) { res.status(400).json({ error: 'Not a directory. Use /api/files/read for files.' }); return; }

      const entries = fs.readdirSync(fullPath).map(name => {
        try {
          const entryPath = join(fullPath, name);
          const entryStat = fs.statSync(entryPath);
          return {
            name,
            path: reqPath ? `${reqPath}/${name}` : name,
            type: entryStat.isDirectory() ? 'directory' as const : 'file' as const,
            size: entryStat.size,
            modified: entryStat.mtime.toISOString(),
          };
        } catch {
          return { name, path: reqPath ? `${reqPath}/${name}` : name, type: 'file' as const, size: 0, modified: '' };
        }
      });
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: reqPath || '/', entries, basePath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/files/read — read file contents
  app.get('/api/files/read', (req, res) => {
    const reqPath = req.query.path as string;
    if (!reqPath) { res.status(400).json({ error: 'path parameter required' }); return; }
    const rootParam = req.query.root as string | undefined;
    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);

    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'File not found' }); return; }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) { res.status(400).json({ error: 'Path is a directory' }); return; }

      const MAX_SIZE = 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, MAX_SIZE);
        res.json({ path: reqPath, content, truncated: true, size: stat.size, modified: stat.mtime.toISOString() });
        return;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      res.json({ path: reqPath, content, truncated: false, size: stat.size, modified: stat.mtime.toISOString() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/files/write — create or overwrite a file
  app.post('/api/files/write', express.json(), (req, res) => {
    const { path: reqPath, content, root: rootParam } = req.body as { path?: string; content?: string; root?: string };
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }
    if (content === undefined) { res.status(400).json({ error: 'content required' }); return; }

    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      const dir = dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      const stat = fs.statSync(fullPath);
      res.json({ success: true, path: reqPath, size: stat.size, modified: stat.mtime.toISOString() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/files/mkdir — create a directory
  app.post('/api/files/mkdir', express.json(), (req, res) => {
    const { path: reqPath, root: rootParam } = req.body as { path?: string; root?: string };
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }

    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (fs.existsSync(fullPath)) { res.status(409).json({ error: 'Path already exists' }); return; }
      fs.mkdirSync(fullPath, { recursive: true });
      res.json({ success: true, path: reqPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/files/rename — rename or move a file/directory
  app.post('/api/files/rename', express.json(), (req, res) => {
    const { oldPath, newPath, root: rootParam } = req.body as { oldPath?: string; newPath?: string; root?: string };
    if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }

    const oldValidation = validateFilePath(oldPath, rootParam);
    const newValidation = validateFilePath(newPath, rootParam);
    if (!oldValidation.valid) { res.status(403).json({ error: oldValidation.error }); return; }
    if (!newValidation.valid) { res.status(403).json({ error: newValidation.error }); return; }

    try {
      if (!fs.existsSync(oldValidation.fullPath)) { res.status(404).json({ error: 'Source not found' }); return; }
      if (fs.existsSync(newValidation.fullPath)) { res.status(409).json({ error: 'Destination already exists' }); return; }
      fs.renameSync(oldValidation.fullPath, newValidation.fullPath);
      res.json({ success: true, oldPath, newPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/files/delete — delete a file or empty directory
  app.delete('/api/files/delete', (req, res) => {
    const reqPath = req.query.path as string;
    const rootParam = req.query.root as string | undefined;
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }

    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'Not found' }); return; }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const contents = fs.readdirSync(fullPath);
        if (contents.length > 0) { res.status(400).json({ error: 'Directory not empty. Delete contents first.' }); return; }
        fs.rmdirSync(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
      res.json({ success: true, path: reqPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── File Upload API ─────────────────────────────────────
  const UPLOADS_DIR = join(homedir(), '.titan', 'uploads');

  app.post('/api/files/upload', express.raw({ type: ['application/octet-stream', 'multipart/form-data', 'image/*', 'audio/*', 'video/*', 'application/pdf', 'application/zip'], limit: '50mb' }), (req, res) => {
    try {
      const fileName = (req.headers['x-filename'] as string) || `upload-${Date.now()}`;
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      const sessionId = (req.headers['x-session-id'] as string) || 'default';

      // Handle both raw Buffer and JSON-parsed body
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      if (!body || body.length === 0) {
        res.status(400).json({ error: 'Empty upload body' });
        return;
      }

      // Create session-specific upload dir
      const sessionDir = join(UPLOADS_DIR, sessionId);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      const filePath = join(sessionDir, safeName);
      fs.writeFileSync(filePath, body);

      const stat = fs.statSync(filePath);
      logger.info(COMPONENT, `File uploaded: ${safeName} (${(stat.size / 1024).toFixed(0)}KB) → session ${sessionId}`);

      res.json({
        ok: true,
        file: {
          name: safeName,
          path: filePath,
          size: stat.size,
          session: sessionId,
          uploadedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/files/uploads', (req, res) => {
    try {
      const sessionId = (req.query.session as string) || 'default';
      const sessionDir = join(UPLOADS_DIR, sessionId);
      if (!fs.existsSync(sessionDir)) { res.json({ files: [] }); return; }

      const files = fs.readdirSync(sessionDir).map(name => {
        const stat = fs.statSync(join(sessionDir, name));
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      });
      res.json({ files, session: sessionId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/files/uploads/:name', (req, res) => {
    try {
      const sessionId = (req.query.session as string) || 'default';
      const filePath = join(UPLOADS_DIR, sessionId, req.params.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
      if (!filePath.startsWith(UPLOADS_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Audit API ────────────────────────────────────────────

  app.get('/api/audit', (req, res) => {
    const query = {
      since: req.query.since as string | undefined,
      until: req.query.until as string | undefined,
      action: req.query.action as string | undefined,
      source: req.query.source as string | undefined,
      tool: req.query.tool as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 100,
    };
    res.json({ entries: queryAuditLog(query) });
  });

  app.get('/api/audit/stats', (req, res) => {
    const hours = req.query.hours ? parseInt(req.query.hours as string, 10) : 24;
    res.json(getAuditStats(hours));
  });

  // ── Cron API ──────────────────────────────────────────────

  app.get('/api/cron', (_req, res) => {
    const store = getDb();
    res.json({ jobs: store.cronJobs });
  });

  app.post('/api/cron', (req, res) => {
    const { name, schedule, command } = req.body;
    if (!name || !schedule || !command) {
      res.status(400).json({ error: 'name, schedule, and command are required' }); return;
    }
    const store = getDb();
    const id = crypto.randomUUID();
    store.cronJobs.push({ id, name, schedule, command, enabled: true, created_at: new Date().toISOString() });
    res.status(201).json({ job: { id, name, schedule, command, enabled: true } });
  });

  app.post('/api/cron/:id/toggle', (req, res) => {
    const store = getDb();
    const job = store.cronJobs.find(j => j.id === req.params.id);
    if (!job) { res.status(404).json({ error: 'Cron job not found' }); return; }
    job.enabled = typeof req.body.enabled === 'boolean' ? req.body.enabled : !job.enabled;
    res.json({ job });
  });

  app.delete('/api/cron/:id', (req, res) => {
    const store = getDb();
    const idx = store.cronJobs.findIndex(j => j.id === req.params.id);
    if (idx === -1) { res.status(404).json({ error: 'Cron job not found' }); return; }
    store.cronJobs.splice(idx, 1);
    res.json({ deleted: true });
  });

  // ── Self-Improvement API ────────────────────────────────────
  app.get('/api/self-improve/history', async (_req, res) => {
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../utils/constants.js');
      const historyPath = join(TITAN_HOME, 'self-improve', 'history.jsonl');
      if (!existsSync(historyPath)) {
        res.json({ sessions: [] });
        return;
      }
      const lines = readFileSync(historyPath, 'utf-8').split('\n').filter((l: string) => l.trim());
      const sessions = lines.map((l: string) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      res.json({ sessions });
    } catch (e) {
      res.json({ sessions: [] });
    }
  });

  app.get('/api/self-improve/config', (_req, res) => {
    const cfg = loadConfig();
    res.json((cfg as Record<string, unknown>).selfImprove || {});
  });

  // ── Training Progress SSE Stream ─────────────────────────────────
  app.get('/api/training/stream', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected","message":"Training progress stream connected"}\n\n');

    // Import training events emitter
    let handler: ((event: unknown) => void) | null = null;
    try {
      const { trainingEvents } = await import('../skills/builtin/model_trainer.js');
      handler = (event: unknown) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch { /* client disconnected */ }
      };
      trainingEvents.on('progress', handler);
    } catch { /* model_trainer not loaded */ }

    // Send recent progress log as catch-up (last 50 entries)
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../utils/constants.js');
      const logPath = join(TITAN_HOME, 'training-progress.jsonl');
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l: string) => l.trim());
        const recent = lines.slice(-50);
        for (const line of recent) {
          try { res.write(`data: ${line}\n\n`); } catch { break; }
        }
      }
    } catch { /* best-effort */ }

    // Keep alive
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      if (handler) {
        import('../skills/builtin/model_trainer.js')
          .then(m => m.trainingEvents.off('progress', handler!))
          .catch(() => {});
      }
    });
  });

  // ── Training Progress Log (poll fallback) ──────────────────────
  app.get('/api/training/progress', async (req, res) => {
    try {
      const { existsSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../utils/constants.js');
      const logPath = join(TITAN_HOME, 'training-progress.jsonl');
      if (!existsSync(logPath)) {
        res.json({ events: [] });
        return;
      }
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l: string) => l.trim());
      const since = req.query.since as string | undefined;
      let events = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (since) {
        events = events.filter((e: { timestamp?: string }) => e.timestamp && e.timestamp > since);
      }
      // Return last 100
      res.json({ events: events.slice(-100) });
    } catch {
      res.json({ events: [] });
    }
  });

  // ── Clear training progress log ────────────────────────────────
  app.delete('/api/training/progress', async (_req, res) => {
    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../utils/constants.js');
      writeFileSync(join(TITAN_HOME, 'training-progress.jsonl'), '', 'utf-8');
      res.json({ cleared: true });
    } catch {
      res.status(500).json({ error: 'Failed to clear' });
    }
  });

  app.get('/api/training/runs', async (_req, res) => {
    try {
      const { existsSync, readdirSync, readFileSync } = await import('fs');
      const { join } = await import('path');
      const { TITAN_HOME } = await import('../utils/constants.js');
      const runsDir = join(TITAN_HOME, 'training-runs');
      if (!existsSync(runsDir)) {
        res.json({ runs: [] });
        return;
      }
      const dirs = readdirSync(runsDir, { withFileTypes: true })
        .filter((d: { isDirectory: () => boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
      const runs = dirs.map((dir: string) => {
        const metaPath = join(runsDir, dir, 'meta.json');
        const resultsPath = join(runsDir, dir, 'results.json');
        if (!existsSync(metaPath)) return null;
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        if (existsSync(resultsPath)) {
          const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
          meta.status = results.status || 'completed';
          meta.finalLoss = results.final_loss;
        }
        return meta;
      }).filter(Boolean);
      res.json({ runs });
    } catch {
      res.json({ runs: [] });
    }
  });

  // ── Autoresearch API ──────────────────────────────────────────
  app.get('/api/autoresearch/results', (req, res) => {
    try {
      const type = req.query.type as string || 'tool_router';
      const resultsFile = type === 'agent' ? 'agent_results.json' : 'results.json';
      const resultsPath = join(TITAN_HOME, 'autoresearch', 'output', resultsFile);
      if (!fs.existsSync(resultsPath)) {
        res.json({ runs: [] });
        return;
      }
      const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
      res.json({ runs: Array.isArray(data) ? data : [] });
    } catch {
      res.json({ runs: [] });
    }
  });

  app.get('/api/autoresearch/performance', (req, res) => {
    try {
      const type = req.query.type as string || 'tool_router';
      const resultsFile = type === 'agent' ? 'agent_results.json' : 'results.json';
      const resultsPath = join(TITAN_HOME, 'autoresearch', 'output', resultsFile);
      if (!fs.existsSync(resultsPath)) {
        res.json({ totalRuns: 0, bestScore: 0, avgImprovement: 0, baseline: 78.0 });
        return;
      }
      const runs = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
      if (!Array.isArray(runs) || runs.length === 0) {
        res.json({ totalRuns: 0, bestScore: 0, avgImprovement: 0, baseline: 78.0 });
        return;
      }
      const baseline = 78.0;
      const bestScore = Math.max(...runs.map((r: any) => r.val_score || 0));
      const avgImprovement = runs.reduce((sum: number, r: any) => sum + ((r.val_score || 0) - baseline), 0) / runs.length;
      res.json({
        totalRuns: runs.length,
        bestScore: Math.round(bestScore * 100) / 100,
        avgImprovement: Math.round(avgImprovement * 100) / 100,
        baseline,
        lastRun: runs[runs.length - 1],
      });
    } catch {
      res.json({ totalRuns: 0, bestScore: 0, avgImprovement: 0, baseline: 78.0 });
    }
  });

  app.get('/api/autoresearch/status', (_req, res) => {
    res.json({ status: 'idle' });
  });

  app.get('/api/autoresearch/benchmark', (_req, res) => {
    try {
      const benchPath = join(TITAN_HOME, 'autoresearch', 'output', 'benchmark_results.json');
      if (!fs.existsSync(benchPath)) {
        res.json({ benchmark: null });
        return;
      }
      res.json({ benchmark: JSON.parse(fs.readFileSync(benchPath, 'utf-8')) });
    } catch {
      res.json({ benchmark: null });
    }
  });

  app.post('/api/autoresearch/trigger', async (req, res) => {
    try {
      const type = req.body?.type || 'tool_router';
      const config = req.body?.config || {};
      const prompt = type === 'agent'
        ? `Run an agent model training experiment using train_start with baseModel="${config.baseModel || 'qwen2.5:32b'}" method="lora" epochs=${config.epochs || 2} budgetMinutes=${config.timeBudgetMin || 60}. This is for the Main Agent model, use the agent training pipeline (train_agent.py on Titan PC).`
        : 'Run an autoresearch training experiment. Use the train_start tool with default settings.';
      const response = await processMessage(
        prompt,
        `autoresearch-trigger-${type}`,
        'system',
        {}
      );
      res.json({ success: true, content: response.content?.slice(0, 500) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/autoresearch/generate-data', async (req, res) => {
    try {
      const type = req.body?.type || 'tool_router';
      const trainHost = process.env.TITAN_TRAIN_HOST || 'localhost';
      const trainUser = process.env.TITAN_TRAIN_USER || process.env.USER || 'user';
      const prompt = type === 'agent'
        ? `Generate training data for the Main Agent model. Run the generate_agent_data.py script via SSH: ssh ${trainUser}@${trainHost} "~/.titan/venv/bin/python3 ~/.titan/autoresearch/generate_agent_data.py --no-llm"`
        : `Generate training data for the tool router model. Run the generate_data.py script via SSH: ssh ${trainUser}@${trainHost} "~/.titan/venv/bin/python3 ~/.titan/autoresearch/generate_data.py"`;
      const response = await processMessage(prompt, `autoresearch-gendata-${type}`, 'system', {});
      res.json({ success: true, content: response.content?.slice(0, 500) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/autoresearch/deploy', async (req, res) => {
    try {
      const type = req.body?.type || 'tool_router';
      const modelName = type === 'agent' ? 'titan-agent' : 'titan-qwen';
      const prompt = `Deploy the best trained ${type === 'agent' ? 'agent' : 'tool router'} model to Ollama as "${modelName}". Run the deploy script on Titan PC via SSH.`;
      const response = await processMessage(prompt, `autoresearch-deploy-${type}`, 'system', {});
      res.json({ success: true, content: response.content?.slice(0, 500) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Recipe Run API ────────────────────────────────────────

  app.post('/api/recipes/:id/run', async (req, res) => {
    const recipe = getRecipe(req.params.id);
    if (!recipe) { res.status(404).json({ error: 'Recipe not found' }); return; }
    try {
      const params = req.body.params || {};
      const steps: Array<{ stepIndex: number; prompt: string }> = [];
      for await (const step of runRecipe(req.params.id, params)) {
        steps.push({ stepIndex: step.stepIndex, prompt: step.prompt });
      }
      res.json({ recipe: recipe.name, stepsExecuted: steps.length, steps });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

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

  // Voice health check (checks all voice services)
  app.get('/api/voice/health', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.voice?.enabled) {
      res.json({ livekit: false, stt: false, tts: false, agent: false, overall: false, ttsEngine: cfg.voice?.ttsEngine || 'orpheus' });
      return;
    }
    const engine = cfg.voice.ttsEngine || 'orpheus';
    const results = { livekit: false, stt: false, tts: false, agent: false, overall: false, ttsEngine: engine };
    const sttUrl = cfg.voice.sttUrl || 'http://localhost:48421';
    const ttsUrl = cfg.voice.ttsUrl || 'http://localhost:5005';
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
    // TTS health check — /health endpoint or speech probe fallback
    try {
      const ttsBase = engine === 'f5-tts' ? 'http://localhost:5006' : ttsUrl;
      const healthUrl = engine === 'edge' ? `http://localhost:5007/health` : `${ttsBase}/health`;
      let resp = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!resp || resp.status >= 400) {
        // No /health endpoint — try a lightweight speech probe
        const voice = cfg.voice.ttsVoice || 'default';
        const model = engine === 'f5-tts' ? 'f5-tts' : 'mlx-community/orpheus-3b-0.1-ft-4bit';
        resp = await fetch(`${ttsBase}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: '.', voice, response_format: 'pcm' }),
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

  // Voice preview — synthesize a short sample via TTS server (engine-aware)
  app.post('/api/voice/preview', async (req, res) => {
    const cfg = loadConfig();
    const engine = cfg.voice?.ttsEngine || 'orpheus';
    const voiceId = req.body?.voice || cfg.voice?.ttsVoice || 'tara';
    const rawText = req.body?.text || 'Hey! I\'m TITAN, your AI assistant.';
    const text = rawText.length > 500 ? rawText.slice(0, 497) + '...' : rawText;
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5005';
    logger.info('Gateway', `TTS [${engine}] request: voice=${voiceId}, text=${text.slice(0, 80)}...`);

    // Browser engine — no server call, client handles it
    if (engine === 'browser') {
      res.json({ engine: 'browser', text, voice: voiceId });
      return;
    }

    // Resolve TTS URL and model based on engine
    const previewTtsUrl = engine === 'edge' ? `http://localhost:5007`
      : engine === 'f5-tts' ? `http://localhost:${5006}` : ttsUrl;
    const previewTtsModel = engine === 'edge' ? 'edge-tts'
      : engine === 'f5-tts' ? 'f5-tts-mlx' : 'mlx-community/orpheus-3b-0.1-ft-4bit';

    try {
      const ttsRes = await fetch(`${previewTtsUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: previewTtsModel, input: text, voice: voiceId, response_format: 'wav' }),
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
  app.post('/api/voice/stream', rateLimit(60000, 30), async (req, res) => {
    const { content, sessionId: requestedSessionId, voice: reqVoice } = req.body || {};
    if (!content) { res.status(400).json({ error: 'content is required' }); return; }

    const cfg = loadConfig();
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5005';
    const ttsEngine = cfg.voice?.ttsEngine || 'orpheus';
    const voiceId = reqVoice || cfg.voice?.ttsVoice || 'tara';
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
    if (requestedSessionId) sessionAborts.set(requestedSessionId, abortController);

    // Auto-detect TTS availability — probe the active TTS engine once at stream start
    let effectiveTtsEngine = ttsEngine;
    let effectiveTtsUrl = ttsUrl;
    let effectiveTtsModel = 'mlx-community/orpheus-3b-0.1-ft-4bit';

    if (ttsEngine === 'f5-tts') {
      effectiveTtsUrl = `http://localhost:${5006}`;
      effectiveTtsModel = 'f5-tts-mlx';
      try {
        const probe = await fetch(`${effectiveTtsUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (!probe.ok) effectiveTtsEngine = 'browser';
      } catch {
        effectiveTtsEngine = 'browser';
        logger.warn(COMPONENT, `Voice clone TTS unreachable at ${effectiveTtsUrl} — falling back to browser TTS`);
      }
    } else if (ttsEngine === 'orpheus') {
      try {
        const probe = await fetch(`${ttsUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: effectiveTtsModel, input: '.', voice: voiceId, response_format: 'wav' }),
          signal: AbortSignal.timeout(60000),
        });
        if (!probe.ok) effectiveTtsEngine = 'browser';
      } catch {
        effectiveTtsEngine = 'browser';
        logger.warn(COMPONENT, `Orpheus TTS unreachable at ${ttsUrl} — falling back to browser TTS`);
      }
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

    // Sequential TTS queue — processes one sentence at a time to avoid overwhelming Orpheus
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
      if (effectiveTtsEngine === 'browser') return;

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
        onToken: (token) => {
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
        onToolCall: (name) => {
          // Notify client that tools are running (shows "Thinking..." state)
          safeWrite(`event: tool\ndata: ${JSON.stringify({ name })}\n\n`);
        },
      }, undefined, abortController.signal);

      // Flush remaining buffer
      if (tokenBuffer.trim()) {
        flushSentence(tokenBuffer);
        tokenBuffer = '';
      }

      // F5-TTS: generate audio in chunks of ~120 chars after LLM finishes.
      // Short enough for quality, long enough for voice consistency.
      if (isF5TTS && f5Sentences.length > 0 && effectiveTtsEngine !== 'browser') {
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
      const POISON_PATTERNS = [
        /i completed the tool operations/i,
        /i wasn't able to execute tools/i,
        /i completed the operations/i,
        /let me know if you need anything else\.?\s*$/i,
      ];
      const responseText = response.content || '';
      if (POISON_PATTERNS.some(p => p.test(responseText)) || (response.durationMs > 60000 && responseText.length < 50)) {
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
    const engine = cfg.voice?.ttsEngine || 'orpheus';
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5005';

    const ORPHEUS_VOICES = ['tara', 'leah', 'jess', 'mia', 'zoe', 'leo', 'dan', 'zac'];

    if (engine === 'browser') {
      res.json({ voices: [], engine: 'browser' });
      return;
    }

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

    // Orpheus (default)
    try {
      const ttsRes = await fetch(`${ttsUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(3000) });
      if (!ttsRes.ok) { res.json({ voices: ORPHEUS_VOICES, engine: 'orpheus' }); return; }
      const data = await ttsRes.json() as { voices?: string[] };
      res.json({ ...data, engine: 'orpheus' });
    } catch {
      res.json({ voices: ORPHEUS_VOICES, engine: 'orpheus' });
    }
  });

  // ── Orpheus TTS Auto-Installer ─────────────────────────────
  app.get('/api/voice/orpheus/status', async (_req, res) => {
    const cfg = loadConfig();
    const venvPath = join(homedir(), '.titan', 'orpheus-venv');
    const installed = fs.existsSync(join(venvPath, 'bin', 'python'));
    let running = false;
    try {
      const probe = await fetch(`${cfg.voice?.ttsUrl || 'http://localhost:5005'}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      running = probe.ok;
    } catch { /* not running */ }
    res.json({ installed, running, venvPath });
  });

  app.post('/api/voice/orpheus/install', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const send = (step: string, status: 'running' | 'done' | 'error', detail?: string) => {
      res.write(`data: ${JSON.stringify({ step, status, detail })}\n\n`);
    };

    const venvPath = join(homedir(), '.titan', 'orpheus-venv');
    const isMac = process.platform === 'darwin';

    try {
      // Step 1: Create venv
      send('venv', 'running', 'Creating Python virtual environment...');
      if (!fs.existsSync(join(venvPath, 'bin', 'python'))) {
        execSync(`python3 -m venv "${venvPath}"`, { timeout: 60000 });
      }
      send('venv', 'done');

      // Step 2: Install dependencies
      const pip = join(venvPath, 'bin', 'pip');
      if (isMac) {
        send('install', 'running', 'Installing mlx-audio (this may take 2-3 minutes)...');
        execSync(`"${pip}" install "mlx-audio[server]" "setuptools<81" webrtcvad`, { timeout: 600000 });
      } else {
        send('install', 'running', 'Installing orpheus-speech + dependencies...');
        execSync(`"${pip}" install orpheus-speech fastapi uvicorn`, { timeout: 600000 });
      }
      send('install', 'done');

      // Step 3: Start the server
      send('start', 'running', 'Starting Orpheus TTS server on port 5005...');
      const python = join(venvPath, 'bin', 'python');
      const pidFile = join(homedir(), '.titan', 'orpheus.pid');

      if (isMac) {
        const child = spawn(python, ['-m', 'mlx_audio.server', '--host', '127.0.0.1', '--port', '5005'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
        });
        child.unref();
        fs.writeFileSync(pidFile, String(child.pid));

        // Wait for server to come up (model download + load can take a while)
        send('model', 'running', 'Downloading Orpheus model (~1.9GB, first time only)...');
        let ready = false;
        for (let i = 0; i < 120; i++) { // up to 4 minutes
          await new Promise(r => setTimeout(r, 2000));
          try {
            const probe = await fetch('http://localhost:5005/v1/audio/speech', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'mlx-community/orpheus-3b-0.1-ft-4bit', input: 'test', voice: 'tara', response_format: 'wav' }),
              signal: AbortSignal.timeout(10000),
            });
            if (probe.ok) { ready = true; break; }
          } catch { /* still loading */ }
        }
        if (ready) {
          send('model', 'done');
          send('complete', 'done', 'Orpheus TTS is ready!');
        } else {
          send('model', 'error', 'Server started but model loading timed out. It may still be downloading — try again in a few minutes.');
        }
      } else {
        // Linux: orpheus-speech server
        const child = spawn(python, ['-m', 'uvicorn', 'orpheus_speech.server:app', '--host', '127.0.0.1', '--port', '5005'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
        });
        child.unref();
        fs.writeFileSync(pidFile, String(child.pid));

        send('model', 'running', 'Waiting for Orpheus server to start...');
        let ready = false;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const probe = await fetch('http://localhost:5005/v1/audio/speech', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'mlx-community/orpheus-3b-0.1-ft-4bit', input: 'test', voice: 'tara', response_format: 'wav' }),
              signal: AbortSignal.timeout(10000),
            });
            if (probe.ok) { ready = true; break; }
          } catch { /* still loading */ }
        }
        if (ready) {
          send('model', 'done');
          send('complete', 'done', 'Orpheus TTS is ready!');
        } else {
          send('model', 'error', 'Server started but timed out waiting for readiness. Check logs.');
        }
      }
    } catch (e) {
      send('error', 'error', (e as Error).message);
    }
    res.end();
  });

  app.post('/api/voice/orpheus/stop', (_req, res) => {
    const pidFile = join(homedir(), '.titan', 'orpheus.pid');
    try {
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(pidFile);
      }
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/voice/orpheus/start', async (_req, res) => {
    const cfg = loadConfig();
    const venvPath = join(homedir(), '.titan', 'orpheus-venv');
    const python = join(venvPath, 'bin', 'python');
    const pidFile = join(homedir(), '.titan', 'orpheus.pid');
    const isMac = process.platform === 'darwin';

    if (!fs.existsSync(python)) {
      res.status(400).json({ ok: false, error: 'Orpheus not installed. Use POST /api/voice/orpheus/install first.' });
      return;
    }

    // Check if already running
    try {
      const probe = await fetch(`${cfg.voice?.ttsUrl || 'http://localhost:5005'}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (probe.ok) {
        res.json({ ok: true, message: 'Orpheus is already running' });
        return;
      }
    } catch { /* not running, start it */ }

    try {
      if (isMac) {
        const child = spawn(python, ['-m', 'mlx_audio.server', '--host', '127.0.0.1', '--port', '5005'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
        });
        child.unref();
        fs.writeFileSync(pidFile, String(child.pid));
      } else {
        const child = spawn(python, ['-m', 'uvicorn', 'orpheus_speech.server:app', '--host', '127.0.0.1', '--port', '5005'], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
        });
        child.unref();
        fs.writeFileSync(pidFile, String(child.pid));
      }
      res.json({ ok: true, message: 'Orpheus server starting — model loading may take a minute.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // ── Voice Cloning Auto-Installer (F5-TTS via MLX) ──────────────────
  const QWEN3_PORT = 5006;
  const QWEN3_MODEL = 'f5-tts-mlx';
  let qwen3Pid: number | null = null;

  app.get('/api/voice/qwen3tts/status', async (_req, res) => {
    const venvPath = join(homedir(), '.titan', 'qwen3tts-venv');
    const installed = fs.existsSync(join(venvPath, 'bin', 'python'));
    let running = false;
    try {
      const probe = await fetch(`http://localhost:${QWEN3_PORT}/health`, { signal: AbortSignal.timeout(3000) });
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
    res.json({ installed, running, voices, port: QWEN3_PORT, model: QWEN3_MODEL });
  });

  app.post('/api/voice/qwen3tts/install', async (_req, res) => {
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

      const child = spawn(python, [scriptPath, '--host', '127.0.0.1', '--port', String(QWEN3_PORT)], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
      });
      child.unref();
      qwen3Pid = child.pid ?? null;
      const pidFile = join(homedir(), '.titan', 'qwen3tts.pid');
      if (child.pid) fs.writeFileSync(pidFile, String(child.pid));

      // Wait for server to come up (model download + load)
      send('model', 'running', 'Downloading F5-TTS model (~500MB, first time only)...');
      let ready = false;
      for (let i = 0; i < 120; i++) { // up to 4 minutes
        await new Promise(r => setTimeout(r, 2000));
        try {
          const probe = await fetch(`http://localhost:${QWEN3_PORT}/health`, { signal: AbortSignal.timeout(5000) });
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

  app.post('/api/voice/qwen3tts/stop', (_req, res) => {
    const pidFile = join(homedir(), '.titan', 'qwen3tts.pid');
    try {
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(pidFile);
      }
      qwen3Pid = null;
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/voice/qwen3tts/start', async (_req, res) => {
    const venvPath = join(homedir(), '.titan', 'qwen3tts-venv');
    const python = join(venvPath, 'bin', 'python');
    const pidFile = join(homedir(), '.titan', 'qwen3tts.pid');

    if (!fs.existsSync(python)) {
      res.status(400).json({ ok: false, error: 'Qwen3-TTS not installed. Use POST /api/voice/qwen3tts/install first.' });
      return;
    }

    // Check if already running
    try {
      const probe = await fetch(`http://localhost:${QWEN3_PORT}/health`, { signal: AbortSignal.timeout(3000) });
      if (probe.ok) {
        res.json({ ok: true, message: 'Qwen3-TTS is already running' });
        return;
      }
    } catch { /* not running, start it */ }

    try {
      const serverScript = join(__dirname, '..', 'scripts', 'f5-tts-server.py');
      const scriptPath = fs.existsSync(serverScript)
        ? serverScript
        : join(__dirname, '..', '..', 'scripts', 'f5-tts-server.py');

      const child = spawn(python, [scriptPath, '--host', '127.0.0.1', '--port', String(QWEN3_PORT)], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
      });
      child.unref();
      qwen3Pid = child.pid ?? null;
      if (child.pid) fs.writeFileSync(pidFile, String(child.pid));
      res.json({ ok: true, message: 'Qwen3-TTS server starting — model loading may take a minute.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
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
      res.status(500).json({ error: (e as Error).message });
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

  // ── Tunnel ─────────────────────────────────────────────────
  app.get('/api/tunnel/status', (_req, res) => {
    res.json(getTunnelStatus());
  });

  // ── Google OAuth Endpoints ───────────────────────────────
  function getGoogleRedirectUri(): string {
    const cfg = loadConfig();
    const publicUrl = (cfg.gateway as Record<string, unknown>).publicUrl as string | undefined;
    return publicUrl
      ? `${publicUrl}/api/auth/google/callback`
      : `http://localhost:${port}/api/auth/google/callback`;
  }

  app.get('/api/auth/google/status', (_req, res) => {
    res.json({ connected: isGoogleConnected(), email: getGoogleEmail() });
  });

  app.get('/api/auth/google/start', (req, res) => {
    try {
      const url = getConsentUrl(getGoogleRedirectUri());
      res.redirect(url);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    const code = req.query.code as string;
    if (!code) { res.status(400).send('Missing authorization code'); return; }
    try {
      await exchangeCode(code, getGoogleRedirectUri());
      // Redirect back to dashboard
      res.redirect('/?google_connected=1');
    } catch (err) {
      res.status(500).send(`OAuth failed: ${(err as Error).message}`);
    }
  });

  app.post('/api/auth/google/disconnect', (_req, res) => {
    disconnectGoogle();
    res.json({ ok: true });
  });

  // ── SOUL.md Endpoints ───────────────────────────────────
  app.get('/api/soul', (_req, res) => {
    try {
      const cfg = loadConfig();
      const soulPath = join(cfg.agent.workspace || TITAN_WORKSPACE, 'SOUL.md');
      if (fs.existsSync(soulPath)) {
        res.json({ content: fs.readFileSync(soulPath, 'utf-8') });
      } else {
        res.json({ content: '' });
      }
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/api/soul', (req, res) => {
    try {
      const cfg = loadConfig();
      const workspace = cfg.agent.workspace || TITAN_WORKSPACE;
      const soulPath = join(workspace, 'SOUL.md');

      // Ensure workspace directory exists
      if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });

      const { content, aboutMe, personality } = req.body as {
        content?: string;
        aboutMe?: string;
        personality?: string;
      };

      if (content !== undefined) {
        // Raw content save (from Settings editor)
        fs.writeFileSync(soulPath, content, 'utf-8');
      } else if (aboutMe || personality) {
        // Generate from onboarding template
        const soulContent = [
          '# SOUL.md - Who You Are',
          '',
          '## About Your Human',
          aboutMe || '(Not yet described)',
          '',
          '## Your Personality',
          personality || '(Not yet defined)',
          '',
          '## Core Principles',
          '- Be genuinely helpful, not performatively helpful',
          '- Have opinions and preferences',
          '- Be resourceful before asking',
          '- Earn trust through competence',
          '',
          '## Boundaries',
          '- Private things stay private',
          '- Ask before acting externally',
          '- Never send half-baked replies to messaging surfaces',
          '',
          `_This file evolves as you learn. Update it when you discover new preferences._`,
        ].join('\n');
        fs.writeFileSync(soulPath, soulContent, 'utf-8');
      } else {
        res.status(400).json({ error: 'Provide either "content" or "aboutMe"/"personality"' });
        return;
      }

      logger.info(COMPONENT, 'SOUL.md updated via API');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Activity Feed ────────────────────────────────────────

  app.get('/api/activity/recent', (req, res) => {
    try {
      const logPath = getLogFilePath();
      if (!logPath || !fs.existsSync(logPath)) {
        res.json({ events: [] });
        return;
      }
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
      const filter = (req.query.filter as string) || 'all';
      const stats = fs.statSync(logPath);
      const readSize = Math.min(stats.size, 200000); // Read last 200KB
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stats.size - readSize));
      fs.closeSync(fd);
      const content = buf.toString('utf-8');
      const rawLines = content.split('\n').filter(Boolean);
      const lines = stats.size > readSize ? rawLines.slice(1) : rawLines;

      // Classify log lines into activity event types
      const classifyEvent = (message: string, component: string): string => {
        const lc = message.toLowerCase();
        const cc = component.toLowerCase();
        if (cc.includes('toolrunner') || lc.includes('executing tool') || lc.includes('tool:')) return 'tool';
        if (cc.includes('agent') || lc.includes('processing message') || lc.includes('response')) return 'agent';
        if (cc.includes('autopilot')) return 'autopilot';
        if (cc.includes('goal')) return 'goal';
        if (cc.includes('websearch') || cc.includes('browse') || lc.includes('search')) return 'search';
        if (cc.includes('autonomy') || lc.includes('autonomy')) return 'autonomy';
        if (cc.includes('router') || cc.includes('provider')) return 'router';
        if (cc.includes('graph') || cc.includes('memory')) return 'graph';
        if (lc.includes('error') || lc.includes('fail')) return 'error';
        return 'system';
      };

      const events = lines
        .map((line) => {
          const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(DEBUG|INFO|WARN|ERROR)\s+(?:\[([^\]]+)\]\s+)?(.*)$/);
          if (!match) return null;
          const [, timestamp, level, component = 'System', message] = match;
          const type = classifyEvent(message, component);
          return { timestamp, level: level.toLowerCase(), component, message, type };
        })
        .filter((e): e is NonNullable<typeof e> => {
          if (!e) return false;
          if (e.level === 'debug') return false; // Skip debug noise
          if (filter === 'all') return true;
          if (filter === 'errors') return e.level === 'error' || e.level === 'warn';
          return e.type === filter;
        })
        .slice(-limit)
        .reverse(); // Newest first

      res.json({ events });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/api/activity/summary', (_req, res) => {
    try {
      const cfg = loadConfig();
      const sessions = listSessions();
      const usage = getUsageStats();
      const autopilot = getAutopilotStatus();
      const goals = listGoals();

      // Count tool calls from usage stats
      const toolCalls = (usage as Record<string, unknown>).toolCalls ?? (usage as Record<string, unknown>).totalToolCalls ?? 0;

      // Determine current status
      let status: 'idle' | 'processing' | 'autopilot' = 'idle';
      if (activeLlmRequests > 0) status = 'processing';
      if (autopilot.isRunning) status = 'autopilot';

      // Get last activity from log
      let lastActivity: string | null = null;
      try {
        const logPath = getLogFilePath();
        if (logPath && fs.existsSync(logPath)) {
          const stat = fs.statSync(logPath);
          lastActivity = stat.mtime.toISOString();
        }
      } catch { /* ignore */ }

      // Graph stats
      let graphStats = { entities: 0, edges: 0 };
      try {
        const gd = getGraphData();
        graphStats = { entities: gd.nodes.length, edges: gd.edges.length };
      } catch { /* graph may not be initialized */ }

      const activeGoals = goals.filter((g) => g.status !== 'completed' && g.status !== 'failed');

      res.json({
        activeSessions: sessions.length,
        toolCallsLast24h: toolCalls,
        autopilotRunsToday: autopilot.totalRuns ?? 0,
        autopilotEnabled: autopilot.enabled ?? false,
        autopilotNextRun: autopilot.nextRunEstimate ?? null,
        activeGoals: activeGoals.length,
        goals: activeGoals.slice(0, 5).map((g) => ({
          id: g.id,
          title: g.title,
          progress: g.progress ?? (g.subtasks
            ? Math.round((g.subtasks.filter((s) => s.status === 'done').length / Math.max(g.subtasks.length, 1)) * 100)
            : 0),
        })),
        lastActivity,
        currentModel: cfg.agent.model,
        autonomyMode: cfg.autonomy?.mode ?? 'supervised',
        status,
        graphStats,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── API Documentation ────────────────────────────────────
  // ── Browser automation endpoints ─────────────────────────
  app.post('/api/browser/form-fill', async (req, res) => {
    const { url, data, submit, postClicks } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'url is required (string)' });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, error: 'data is required (Record<string, string>)' });
    }
    try {
      const { getPage, releasePage } = await import('../browsing/browserPool.js');
      const { fillFormSmart } = await import('../skills/builtin/web_browse_llm.js');
      const page = await getPage();
      const session = { page, lastUsed: Date.now(), elements: new Map<number, string>() };
      try {
        // If postClicks are specified, defer submit to after clicks
        const deferSubmit = Array.isArray(postClicks) && postClicks.length > 0 && submit;
        const result = await fillFormSmart(session as any, url, data as Record<string, string>, deferSubmit ? false : (submit ?? false));

        // Post-fill clicks: click elements by text content or CSS selector after form is filled
        const clickResults: string[] = [];
        if (Array.isArray(postClicks)) {
          for (const click of postClicks) {
            try {
              if (typeof click === 'string') {
                // Try text-based click first (button, radio, label), then CSS selector
                const clicked = await page.evaluate((text: string) => {
                  const els = Array.from(document.querySelectorAll('button, input[type="radio"], label, [role="button"], [role="radio"]'));
                  for (const el of els) {
                    const elText = (el as HTMLElement).textContent?.trim() || '';
                    if (elText.toLowerCase() === text.toLowerCase() || elText.toLowerCase().includes(text.toLowerCase())) {
                      (el as HTMLElement).click();
                      return elText;
                    }
                  }
                  return null;
                }, click);
                if (clicked) {
                  clickResults.push(`✅ Clicked "${clicked}"`);
                } else {
                  // Fallback: try as CSS selector
                  try {
                    await page.click(click, { timeout: 3000 });
                    clickResults.push(`✅ Clicked selector: ${click}`);
                  } catch {
                    clickResults.push(`❌ Could not find: "${click}"`);
                  }
                }
                await page.waitForTimeout(500);
              }
            } catch (e) {
              clickResults.push(`❌ Error clicking "${click}": ${(e as Error).message?.split('\n')[0]}`);
            }
          }
        }

        // Now solve CAPTCHA and submit if deferred
        if (deferSubmit) {
          try {
            const { solveCaptcha } = await import('../browsing/captchaSolver.js');
            const solveResult = await solveCaptcha(page as unknown as import('playwright').Page);
            if (solveResult.solved) {
              clickResults.push(`✅ ${solveResult.type} solved via CapSolver`);
            } else if (solveResult.error) {
              clickResults.push(`⚠️ CAPTCHA: ${solveResult.error}`);
            }
          } catch { /* CapSolver not available */ }

          // Click submit button
          try {
            const submitClicked = await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button, [type="submit"], [role="button"]'));
              for (const btn of btns) {
                const text = (btn as HTMLElement).textContent?.trim().toLowerCase() || '';
                if (text.includes('submit') || text.includes('apply')) {
                  (btn as HTMLElement).click();
                  return (btn as HTMLElement).textContent?.trim();
                }
              }
              return null;
            });
            if (submitClicked) {
              clickResults.push(`✅ Clicked submit: "${submitClicked}"`);
              // Wait for navigation/response
              await page.waitForTimeout(3000);
              // Check if page changed (success indicator)
              const finalUrl = page.url();
              const finalTitle = await page.evaluate(() => document.title);
              clickResults.push(`📄 Final page: "${finalTitle}" — ${finalUrl}`);
            } else {
              clickResults.push(`❌ Could not find submit button`);
            }
          } catch (e) {
            clickResults.push(`❌ Submit error: ${(e as Error).message?.split('\n')[0]}`);
          }
        }

        const fullResult = clickResults.length > 0
          ? result + '\n\nPost-fill clicks:\n' + clickResults.join('\n')
          : result;
        const lines = fullResult.split('\n');
        const fieldsMatched = lines.filter((l: string) => l.startsWith('✅')).length;
        const fieldsFailed = lines.filter((l: string) => l.startsWith('❌'))
          .map((l: string) => l.replace(/^❌\s*/, '').split(':')[0]?.trim() || '');
        return res.json({ success: fieldsFailed.length === 0, result: fullResult, fieldsMatched, fieldsFailed });
      } finally {
        await releasePage(page);
      }
    } catch (e) {
      logger.error(COMPONENT, `form-fill error: ${(e as Error).message}`);
      return res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  app.post('/api/browser/solve-captcha', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ solved: false, error: 'url is required (string)' });
    }
    try {
      const { getPage, releasePage } = await import('../browsing/browserPool.js');
      const { solveCaptcha } = await import('../browsing/captchaSolver.js');
      const page = await getPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(3000);
        const result = await solveCaptcha(page);
        return res.json(result);
      } finally {
        await releasePage(page);
      }
    } catch (e) {
      logger.error(COMPONENT, `solve-captcha error: ${(e as Error).message}`);
      return res.status(500).json({ solved: false, error: (e as Error).message });
    }
  });

  app.get('/api/docs', (_req, res) => {
    const spec = {
      openapi: '3.0.0',
      info: {
        title: 'TITAN Gateway API',
        version: TITAN_VERSION,
        description: 'REST API for the TITAN autonomous AI agent framework.',
      },
      paths: {
        '/login':                  { get:  { summary: 'Login page',                             tags: ['Auth'] } },
        '/api/login':              { post: { summary: 'Authenticate with password',             tags: ['Auth'],     requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string' } } } } } } } },
        '/':                       { get:  { summary: 'Dashboard UI',                           tags: ['System'] } },
        '/api/stats':              { get:  { summary: 'System stats (version, uptime, memory)', tags: ['System'] } },
        '/api/health':             { get:  { summary: 'Provider health check',                  tags: ['System'] } },
        '/api/update':             { get:  { summary: 'Check for updates',                      tags: ['System'] },
                                     post: { summary: 'Trigger update',                         tags: ['System'] } },
        '/api/costs':              { get:  { summary: 'Cost optimizer status',                  tags: ['System'] } },
        '/api/sessions':           { get:  { summary: 'List active sessions',                   tags: ['Sessions'] } },
        '/api/sessions/{id}':      { get:  { summary: 'Get session history by ID',              tags: ['Sessions'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
        '/api/sessions/{id}/close':{ post: { summary: 'Close/drop a session',                   tags: ['Sessions'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
        '/api/agents':             { get:  { summary: 'List agents and capacity',               tags: ['Agents'] } },
        '/api/agents/spawn':       { post: { summary: 'Spawn new agent',                        tags: ['Agents'],   requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, model: { type: 'string' } } } } } } } },
        '/api/agents/stop':        { post: { summary: 'Stop an agent',                          tags: ['Agents'],   requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } },
        '/api/skills':             { get:  { summary: 'List loaded skills',                     tags: ['Skills'] } },
        '/api/tools':              { get:  { summary: 'List registered tools',                  tags: ['Skills'] } },
        '/api/channels':           { get:  { summary: 'List channel statuses',                  tags: ['Channels'] } },
        '/api/message':            { post: { summary: 'Send a message',                         tags: ['Channels'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' }, channel: { type: 'string' }, userId: { type: 'string' } } } } } } } },
        '/api/chat/stream':        { post: { summary: 'Stream chat via SSE',                    tags: ['Channels'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' }, model: { type: 'string' } } } } } } } },
        '/api/config':             { get:  { summary: 'Get current config',                     tags: ['Config'] },
                                     post: { summary: 'Update config',                          tags: ['Config'] } },
        '/api/security':           { get:  { summary: 'Security audit results',                 tags: ['Config'] } },
        '/api/providers':          { get:  { summary: 'List configured providers',              tags: ['Config'] } },
        '/api/models':             { get:  { summary: 'List available models',                  tags: ['Models'] } },
        '/api/models/discover':    { get:  { summary: 'Discover models from all providers',     tags: ['Models'] } },
        '/api/model/switch':       { post: { summary: 'Switch active model',                    tags: ['Models'],   requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { model: { type: 'string' } } } } } } } },
        '/api/profile':            { get:  { summary: 'Get personal profile',                   tags: ['Memory'] },
                                     post: { summary: 'Update personal profile',                tags: ['Memory'] } },
        '/api/learning':           { get:  { summary: 'Learning engine stats',                  tags: ['Memory'] } },
        '/api/graphiti':           { get:  { summary: 'Memory graph data',                      tags: ['Memory'] },
                                     delete: { summary: 'Clear memory graph',                     tags: ['Memory'] } },
        '/api/data':               { delete: { summary: 'Full data reset (graph+knowledge+memory)', tags: ['Memory'] } },
        '/api/mesh/hello':         { get:  { summary: 'Mesh hello/handshake',                   tags: ['Mesh'] } },
        '/api/mesh/peers':         { get:  { summary: 'List connected mesh peers',              tags: ['Mesh'] } },
        '/api/mesh/models':        { get:  { summary: 'List mesh models',                       tags: ['Mesh'] } },
        '/api/mesh/pending':       { get:  { summary: 'List peers awaiting approval',           tags: ['Mesh'] } },
        '/api/mesh/approve/:nodeId': { post: { summary: 'Approve a discovered peer',            tags: ['Mesh'] } },
        '/api/mesh/reject/:nodeId': { post: { summary: 'Reject a pending peer',                 tags: ['Mesh'] } },
        '/api/mesh/revoke/:nodeId': { post: { summary: 'Disconnect and revoke a peer',          tags: ['Mesh'] } },
        '/api/mesh/status':        { get:  { summary: 'Mesh health status and connectivity',    tags: ['Mesh'] } },
        '/api/mesh/routes':        { get:  { summary: 'Mesh routing table (multi-hop routes)',  tags: ['Mesh'] } },
        '/api/teams':              { get:  { summary: 'List all teams',                          tags: ['Teams'] },
                                     post: { summary: 'Create a new team',                        tags: ['Teams'] } },
        '/api/teams/{teamId}':     { get:  { summary: 'Get team details',                        tags: ['Teams'] },
                                     patch: { summary: 'Update team settings',                    tags: ['Teams'] },
                                     delete: { summary: 'Delete a team',                          tags: ['Teams'] } },
        '/api/teams/{teamId}/members':  { get:  { summary: 'List team members',                   tags: ['Teams'] },
                                          post: { summary: 'Add a team member',                    tags: ['Teams'] } },
        '/api/teams/{teamId}/members/{userId}': { delete: { summary: 'Remove a team member',      tags: ['Teams'] } },
        '/api/teams/{teamId}/members/{userId}/role': { patch: { summary: 'Update member role',    tags: ['Teams'] } },
        '/api/teams/{teamId}/invites':  { post: { summary: 'Create invite code',                  tags: ['Teams'] } },
        '/api/teams/join':         { post: { summary: 'Join team via invite code',                tags: ['Teams'] } },
        '/api/teams/{teamId}/permissions/{userId}': { get: { summary: 'Get user permissions',     tags: ['Teams'] } },
        '/api/teams/{teamId}/roles/{role}/permissions': { put: { summary: 'Set role permissions', tags: ['Teams'] } },
        '/api/sessions/search':    { get:  { summary: 'Search conversations',                   tags: ['Sessions'], parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }] } },
        '/api/sessions/{id}/export': { get: { summary: 'Export session (JSON or Markdown)',      tags: ['Sessions'], parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'markdown'] } }] } },
        '/api/files/upload':       { post: { summary: 'Upload file (raw body, X-Filename header)', tags: ['Files'] } },
        '/api/files/uploads':      { get:  { summary: 'List uploaded files',                     tags: ['Files'], parameters: [{ name: 'session', in: 'query', schema: { type: 'string' } }] } },
        '/api/files/uploads/{name}': { delete: { summary: 'Delete uploaded file',                tags: ['Files'] } },
        '/api/usage':              { get:  { summary: 'Usage tracking per model (tokens, costs)', tags: ['System'], parameters: [{ name: 'hours', in: 'query', schema: { type: 'integer' } }] } },
        '/api/logs':               { get:  { summary: 'Read log file',                          tags: ['Logs'], parameters: [{ name: 'lines', in: 'query', schema: { type: 'integer' } }] } },
        '/api/voice/status':       { get:  { summary: 'Voice server status and availability',    tags: ['Voice'] } },
        '/api/voice/config':       { get:  { summary: 'Voice configuration',                    tags: ['Voice'] } },
        '/api/tunnel/status':      { get:  { summary: 'Cloudflare tunnel status',               tags: ['Tunnel'] } },
        '/api/autopilot/status':   { get:  { summary: 'Autopilot status',                      tags: ['Autopilot'] } },
        '/api/autopilot/history':  { get:  { summary: 'Autopilot run history',                 tags: ['Autopilot'] } },
        '/api/autopilot/run':      { post: { summary: 'Trigger autopilot run',                 tags: ['Autopilot'] } },
        '/metrics':                { get:  { summary: 'Prometheus metrics endpoint',            tags: ['Telemetry'] } },
        '/api/metrics/summary':    { get:  { summary: 'Metrics summary (JSON)',                 tags: ['Telemetry'] } },
        '/api/docs':               { get:  { summary: 'OpenAPI spec (JSON)',                    tags: ['Docs'] } },
        '/docs':                   { get:  { summary: 'API documentation page',                 tags: ['Docs'] } },
      },
    };
    res.json(spec);
  });

  app.get('/docs', (_req, res) => {
    const endpoints = [
      { cat: 'Auth',     routes: [
        { method: 'GET',  path: '/login',               desc: 'Login page' },
        { method: 'POST', path: '/api/login',            desc: 'Authenticate (body: {password})' },
      ]},
      { cat: 'System',   routes: [
        { method: 'GET',  path: '/',                     desc: 'Dashboard UI' },
        { method: 'GET',  path: '/api/stats',            desc: 'System stats (version, uptime, memory, tokens, requests)' },
        { method: 'GET',  path: '/api/health',           desc: 'Provider health check' },
        { method: 'GET',  path: '/api/costs',            desc: 'Cost optimizer status' },
        { method: 'GET',  path: '/api/update',           desc: 'Check for updates' },
        { method: 'POST', path: '/api/update',           desc: 'Trigger update' },
      ]},
      { cat: 'Sessions', routes: [
        { method: 'GET',  path: '/api/sessions',         desc: 'List active sessions' },
        { method: 'GET',  path: '/api/sessions/:id',     desc: 'Get session history by ID' },
        { method: 'GET',  path: '/api/sessions/search',  desc: 'Search conversations (query: q, limit)' },
        { method: 'GET',  path: '/api/sessions/:id/export', desc: 'Export session (query: format=json|markdown)' },
        { method: 'POST', path: '/api/sessions/:id/close', desc: 'Close/drop a session' },
      ]},
      { cat: 'Files',    routes: [
        { method: 'GET',  path: '/api/files',             desc: 'Browse TITAN home directory' },
        { method: 'GET',  path: '/api/files/read',        desc: 'Read file contents (query: path)' },
        { method: 'POST', path: '/api/files/upload',      desc: 'Upload file (raw body, X-Filename header)' },
        { method: 'GET',  path: '/api/files/uploads',     desc: 'List uploaded files (query: session)' },
        { method: 'DELETE', path: '/api/files/uploads/:name', desc: 'Delete uploaded file' },
      ]},
      { cat: 'Usage',    routes: [
        { method: 'GET',  path: '/api/usage',             desc: 'Usage tracking per model (query: hours)' },
        { method: 'GET',  path: '/api/costs',             desc: 'Cost optimizer status' },
      ]},
      { cat: 'Agents',   routes: [
        { method: 'GET',  path: '/api/agents',           desc: 'List agents + capacity' },
        { method: 'POST', path: '/api/agents/spawn',     desc: 'Spawn new agent (body: {name, model?})' },
        { method: 'POST', path: '/api/agents/stop',      desc: 'Stop agent (body: {id})' },
      ]},
      { cat: 'Skills',   routes: [
        { method: 'GET',  path: '/api/skills',           desc: 'List loaded skills' },
        { method: 'GET',  path: '/api/tools',            desc: 'List registered tools' },
      ]},
      { cat: 'Channels', routes: [
        { method: 'GET',  path: '/api/channels',         desc: 'List channel statuses' },
        { method: 'POST', path: '/api/message',          desc: 'Send message (body: {content, channel?, userId?})' },
        { method: 'POST', path: '/api/chat/stream',      desc: 'Stream chat (SSE, body: {message, model?})' },
      ]},
      { cat: 'Config',   routes: [
        { method: 'GET',  path: '/api/config',           desc: 'Get config' },
        { method: 'POST', path: '/api/config',           desc: 'Update config' },
        { method: 'GET',  path: '/api/security',         desc: 'Security audit results' },
        { method: 'GET',  path: '/api/providers',        desc: 'List configured providers' },
      ]},
      { cat: 'Models',   routes: [
        { method: 'GET',  path: '/api/models',           desc: 'List available models' },
        { method: 'GET',  path: '/api/models/discover',  desc: 'Discover models from all providers' },
        { method: 'POST', path: '/api/model/switch',     desc: 'Switch model (body: {model})' },
      ]},
      { cat: 'Mesh',     routes: [
        { method: 'GET',  path: '/api/mesh/hello',       desc: 'Mesh hello/handshake' },
        { method: 'GET',  path: '/api/mesh/peers',       desc: 'List connected peers' },
        { method: 'GET',  path: '/api/mesh/models',      desc: 'List mesh models' },
        { method: 'GET',  path: '/api/mesh/pending',     desc: 'List peers awaiting approval' },
        { method: 'POST', path: '/api/mesh/approve/:id', desc: 'Approve a discovered peer' },
        { method: 'POST', path: '/api/mesh/reject/:id',  desc: 'Reject a pending peer' },
        { method: 'POST', path: '/api/mesh/revoke/:id',  desc: 'Disconnect & revoke a peer' },
        { method: 'GET',  path: '/api/mesh/status',       desc: 'Mesh health status and connectivity' },
        { method: 'GET',  path: '/api/mesh/routes',       desc: 'Mesh routing table (multi-hop)' },
      ]},
      { cat: 'Teams',    routes: [
        { method: 'GET',  path: '/api/teams',                    desc: 'List all teams' },
        { method: 'POST', path: '/api/teams',                    desc: 'Create a new team' },
        { method: 'GET',  path: '/api/teams/:id',                desc: 'Get team details' },
        { method: 'PATCH',path: '/api/teams/:id',                desc: 'Update team settings' },
        { method: 'DELETE',path: '/api/teams/:id',               desc: 'Delete a team' },
        { method: 'GET',  path: '/api/teams/:id/members',        desc: 'List team members' },
        { method: 'POST', path: '/api/teams/:id/members',        desc: 'Add a member' },
        { method: 'DELETE',path: '/api/teams/:id/members/:uid',  desc: 'Remove a member' },
        { method: 'PATCH',path: '/api/teams/:id/members/:uid/role', desc: 'Change member role' },
        { method: 'POST', path: '/api/teams/:id/invites',        desc: 'Create invite code' },
        { method: 'POST', path: '/api/teams/join',               desc: 'Join via invite code' },
        { method: 'GET',  path: '/api/teams/:id/permissions/:uid', desc: 'Get user permissions' },
      ]},
      { cat: 'Memory',   routes: [
        { method: 'GET',  path: '/api/profile',          desc: 'Get personal profile' },
        { method: 'POST', path: '/api/profile',          desc: 'Update profile' },
        { method: 'GET',  path: '/api/learning',         desc: 'Learning engine stats' },
        { method: 'GET',    path: '/api/graphiti',         desc: 'Memory graph data' },
        { method: 'DELETE', path: '/api/graphiti',         desc: 'Clear memory graph' },
        { method: 'DELETE', path: '/api/data',             desc: 'Full data reset' },
      ]},
      { cat: 'Autopilot', routes: [
        { method: 'GET',  path: '/api/autopilot/status', desc: 'Autopilot status' },
        { method: 'GET',  path: '/api/autopilot/history', desc: 'Autopilot run history' },
        { method: 'POST', path: '/api/autopilot/run',    desc: 'Trigger autopilot run' },
      ]},
      { cat: 'Telemetry', routes: [
        { method: 'GET',  path: '/metrics',              desc: 'Prometheus text exposition format' },
        { method: 'GET',  path: '/api/metrics/summary',  desc: 'Metrics summary (JSON)' },
      ]},
      { cat: 'Voice',    routes: [
        { method: 'GET',  path: '/api/voice/status',     desc: 'Voice server status and availability' },
        { method: 'GET',  path: '/api/voice/config',     desc: 'Voice configuration' },
      ]},
      { cat: 'Tunnel',   routes: [
        { method: 'GET',  path: '/api/tunnel/status',    desc: 'Cloudflare tunnel status' },
      ]},
      { cat: 'Logs',     routes: [
        { method: 'GET',  path: '/api/logs',             desc: 'Read log file (query: lines)' },
      ]},
      { cat: 'Docs',     routes: [
        { method: 'GET',  path: '/api/docs',             desc: 'OpenAPI spec (JSON)' },
        { method: 'GET',  path: '/docs',                 desc: 'API documentation page (this page)' },
      ]},
    ];

    let rows = '';
    for (const group of endpoints) {
      rows += `<tr class="cat-row"><td colspan="3">${group.cat}</td></tr>\n`;
      for (const r of group.routes) {
        const badge = r.method === 'GET'
          ? '<span class="badge get">GET</span>'
          : '<span class="badge post">POST</span>';
        rows += `<tr><td>${badge}</td><td class="path">${r.path}</td><td>${r.desc}</td></tr>\n`;
      }
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TITAN API Docs</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter','Segoe UI',system-ui,sans-serif;background:#0a0e1a;color:#e2e8f0;padding:40px 20px;line-height:1.6}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:28px;font-weight:700;color:#06b6d4;margin-bottom:4px;letter-spacing:2px}
.sub{color:#94a3b8;font-size:14px;margin-bottom:32px}
.sub a{color:#06b6d4;text-decoration:none}
.sub a:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse}
tr{border-bottom:1px solid rgba(42,48,80,0.4)}
tr:hover:not(.cat-row){background:rgba(6,182,212,0.04)}
td{padding:10px 12px;font-size:14px;vertical-align:middle}
.cat-row td{font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1.5px;color:#06b6d4;padding-top:28px;padding-bottom:8px;border-bottom:1px solid rgba(6,182,212,0.15)}
.badge{display:inline-block;padding:2px 10px;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:0.5px;min-width:52px;text-align:center}
.badge.get{background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.3)}
.badge.post{background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3)}
.path{font-family:'Fira Code','SF Mono',monospace;color:#e2e8f0;font-size:13px}
.footer{margin-top:40px;text-align:center;color:#475569;font-size:13px}
</style>
</head>
<body>
<div class="wrap">
  <h1>TITAN API</h1>
  <div class="sub">v${TITAN_VERSION} &mdash; <a href="/api/docs">OpenAPI JSON</a></div>
  <table>${rows}</table>
  <div class="footer">All /api/* routes require authentication (Bearer token) unless noted.</div>
</div>
</body>
</html>`);
  });

  // ── SPA fallback (must be after all API routes) ──────────
  if (hasReactUI) {
    app.get('*', (req, res, next) => {
      // Don't intercept API, WebSocket, metrics, webhooks, or legacy routes
      if (req.path.startsWith('/api/') || req.path.startsWith('/messenger/') || req.path === '/ws' || req.path === '/metrics' || req.path === '/legacy' || req.path === '/login') {
        return next();
      }
      res.sendFile(uiIndexPath);
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
      const allowedOrigins = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
        /^https?:\/\/\[::1\](:\d+)?$/,
        /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,      // LAN
        /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,        // LAN
        /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/, // LAN
        /^https?:\/\/.*\.ts\.net(:\d+)?$/,               // Tailscale
        /^https?:\/\/.*\.trycloudflare\.com$/,           // Cloudflare tunnels
      ];
      const wsAllowlist = (cfg.gateway as Record<string, unknown>).wsOriginAllowlist as string[] | undefined;
      if (wsAllowlist?.length) {
        for (const o of wsAllowlist) allowedOrigins.push(new RegExp(`^${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      }
      if (!allowedOrigins.some(p => p.test(origin))) {
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
                onToken: (token) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'token', data: token }));
                  }
                },
                onToolCall: (name, args) => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'tool_call', name, args }));
                  }
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
    logger.info(COMPONENT, 'Command Post governance layer initialized (wakeup system active)');
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

    // Check TTS
    try {
      const resp = await fetch(`${ttsBaseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mlx-community/orpheus-3b-0.1-ft-4bit', input: 'test', voice: 'tara', response_format: 'wav' }),
        signal: AbortSignal.timeout(5000),
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
    const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapMB > 1500) {
      logger.warn(COMPONENT, `Health monitor: High heap usage — ${heapMB}MB`);
    }

    // Keep primary agent heartbeat alive for Command Post
    try { reportHeartbeat('default'); } catch { /* non-critical */ }
    } catch (err) {
      logger.error(COMPONENT, `Health monitor error: ${(err as Error).message}`);
    }
    })();
  }, 60_000);
  healthMonitorInterval.unref();

  logger.info(COMPONENT, 'Health monitor started (60s interval)');

  // Catch unhandled promise rejections to prevent silent crashes
  process.on('unhandledRejection', (reason) => {
    logger.error(COMPONENT, `Unhandled rejection: ${reason}`);
  });

  // ── Graceful Shutdown ───────────────────────────────────────────
  const gracefulShutdown = async (signal: string) => {
    logger.info(COMPONENT, `Received ${signal} — shutting down gracefully...`);
    // Stop Orpheus TTS server if we started it
    try {
      const orpheusPid = join(homedir(), '.titan', 'orpheus.pid');
      if (fs.existsSync(orpheusPid)) {
        const pid = parseInt(fs.readFileSync(orpheusPid, 'utf-8').trim());
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(orpheusPid);
        logger.info(COMPONENT, 'Stopped Orpheus TTS server');
      }
    } catch { /* already stopped */ }
    // Stop Qwen3-TTS server if we started it
    try {
      const qwen3PidFile = join(homedir(), '.titan', 'qwen3tts.pid');
      if (fs.existsSync(qwen3PidFile)) {
        const pid = parseInt(fs.readFileSync(qwen3PidFile, 'utf-8').trim());
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(qwen3PidFile);
        logger.info(COMPONENT, 'Stopped Qwen3-TTS server');
      }
    } catch { /* already stopped */ }
    stopAutopilot();
    stopDaemon();
    shutdownCommandPost();
    stopTunnel();
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

    // Start Cloudflare Tunnel if enabled
    if (config.tunnel?.enabled) {
      startTunnel(port, config.tunnel).catch((e) => {
        logger.error(COMPONENT, `Tunnel start failed: ${(e as Error).message}`);
      });
    }
  });
}
