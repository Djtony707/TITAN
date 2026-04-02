/**
 * TITAN — Agent Wakeup System
 *
 * Async sub-agent delegation via Command Post. When `spawn_agent` is called
 * with Command Post enabled, instead of blocking the parent for 1-15s, we:
 * 1. Create a CP issue + queue a wakeup request
 * 2. Return immediately to the parent
 * 3. Execute the sub-agent in the background
 * 4. Post results as CP comment, store for parent injection, emit SSE
 *
 * Gated behind config.commandPost.enabled — when disabled, the sync path
 * in agent.ts is used instead (zero regression risk).
 */
import { v4 as uuid } from 'uuid';
import { titanEvents } from './daemon.js';
import { spawnSubAgent, SUB_AGENT_TEMPLATES, type SubAgentResult } from './subAgent.js';
import { routeMessage } from './multiAgent.js';
import { getAdapter } from './adapters/index.js';
import { addIssueComment, updateIssue, startRun, endRun } from './commandPost.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'AgentWakeup';

// ── Types ─────────────────────────────────────────────────────────────

export type WakeupStatus = 'queued' | 'running' | 'completed' | 'failed';

export type WakeupMode = 'sub-agent' | 'multi-agent' | 'external';

export interface WakeupRequest {
    id: string;
    issueId: string;
    issueIdentifier: string;   // e.g. "TIT-42"
    agentId: string;
    agentName: string;
    parentSessionId: string | null;
    task: string;
    templateName: string;
    model?: string;
    mode: WakeupMode;          // 'sub-agent' = spawnSubAgent, 'multi-agent' = routeMessage, 'external' = adapter
    adapterType?: string;      // For external mode: 'claude-code', 'codex', 'bash'
    cwd?: string;              // Working directory for external adapters
    status: WakeupStatus;
    createdAt: number;
    completedAt: number | null;
    error: string | null;
}

export interface PendingResult {
    issueId: string;
    issueIdentifier: string;
    agentName: string;
    result: SubAgentResult;
    completedAt: number;
}

// ── In-Memory State ───────────────────────────────────────────────────

const wakeupQueue = new Map<string, WakeupRequest>();
const pendingResults = new Map<string, PendingResult[]>();  // key: parentSessionId
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;

// ── Public API ────────────────────────────────────────────────────────

/**
 * Initialize the wakeup system. Call once from gateway startup.
 * Registers the event listener on titanEvents.
 */
export function initWakeupSystem(): void {
    if (initialized) return;
    initialized = true;

    titanEvents.on('agent:wakeup', (data: { wakeupRequestId: string }) => {
        // Use setImmediate so queueWakeup() returns before we start executing
        setImmediate(() => {
            handleWakeup(data.wakeupRequestId).catch(err => {
                logger.error(COMPONENT, `Wakeup handler failed: ${(err as Error).message}`);
            });
        });
    });

    // TTL cleanup: sweep stale requests every 60s
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [id, req] of wakeupQueue) {
            if (req.status === 'queued' && now - req.createdAt > 3600_000) {
                // Queued for over 1 hour — cancel
                req.status = 'failed';
                req.error = 'TTL expired (queued > 1 hour)';
                req.completedAt = now;
                logger.warn(COMPONENT, `[TTL] Wakeup ${id} expired (queued > 1h)`);
            }
            if (req.status === 'running' && now - req.createdAt > 300_000) {
                // Running for over 5 minutes — mark failed
                req.status = 'failed';
                req.error = 'Timeout (running > 5 minutes)';
                req.completedAt = now;
                logger.warn(COMPONENT, `[TTL] Wakeup ${id} timed out (running > 5m)`);
            }
            // Clean up completed/failed requests older than 30 minutes
            if ((req.status === 'completed' || req.status === 'failed') && req.completedAt && now - req.completedAt > 1800_000) {
                wakeupQueue.delete(id);
            }
        }
    }, 60_000);
    cleanupInterval.unref();

    logger.info(COMPONENT, 'Agent wakeup system initialized');
}

/**
 * Queue a wakeup request. Creates the request, stores it, and emits the event.
 * Returns immediately — actual execution happens in the background.
 */
export function queueWakeup(opts: {
    issueId: string;
    issueIdentifier: string;
    agentId: string;
    agentName: string;
    parentSessionId: string | null;
    task: string;
    templateName: string;
    model?: string;
    mode?: WakeupMode;
    adapterType?: string;
    cwd?: string;
}): WakeupRequest {
    const request: WakeupRequest = {
        id: `wake_${uuid().slice(0, 8)}`,
        issueId: opts.issueId,
        issueIdentifier: opts.issueIdentifier,
        agentId: opts.agentId,
        agentName: opts.agentName,
        parentSessionId: opts.parentSessionId,
        task: opts.task,
        templateName: opts.templateName,
        model: opts.model,
        mode: opts.mode || 'sub-agent',
        adapterType: opts.adapterType,
        cwd: opts.cwd,
        status: 'queued',
        createdAt: Date.now(),
        completedAt: null,
        error: null,
    };

    wakeupQueue.set(request.id, request);
    logger.info(COMPONENT, `Queued wakeup ${request.id} for agent "${opts.agentName}" — issue ${opts.issueIdentifier}`);

    titanEvents.emit('agent:wakeup', { wakeupRequestId: request.id });
    titanEvents.emit('commandpost:activity', {
        id: uuid().slice(0, 8),
        timestamp: new Date().toISOString(),
        type: 'agent_status_change',
        agentId: opts.agentId,
        message: `Wakeup queued: ${opts.task.slice(0, 80)}`,
        metadata: { wakeupRequestId: request.id, issueId: opts.issueId },
    });

    return request;
}

/**
 * Drain completed async results for a session. Returns and clears them.
 * Called by agentLoop at the start of processMessage to inject context.
 */
export function drainPendingResults(sessionId: string): PendingResult[] {
    const results = pendingResults.get(sessionId);
    if (!results || results.length === 0) return [];
    pendingResults.delete(sessionId);
    return results;
}

/**
 * Get all wakeup requests for an agent (the "inbox").
 */
export function getAgentInbox(agentId: string): WakeupRequest[] {
    return [...wakeupQueue.values()].filter(
        r => r.agentId === agentId && (r.status === 'queued' || r.status === 'running')
    );
}

/**
 * Get a wakeup request by ID.
 */
export function getWakeupRequest(requestId: string): WakeupRequest | null {
    return wakeupQueue.get(requestId) || null;
}

/**
 * Cancel a queued wakeup request. Returns false if already running/completed.
 */
export function cancelWakeup(requestId: string): boolean {
    const req = wakeupQueue.get(requestId);
    if (!req || req.status !== 'queued') return false;
    req.status = 'failed';
    req.error = 'Cancelled';
    req.completedAt = Date.now();
    logger.info(COMPONENT, `Cancelled wakeup ${requestId}`);
    return true;
}

/**
 * Shutdown: cancel all queued requests and clear state.
 */
export function shutdownWakeupSystem(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
    // Cancel all queued requests
    for (const [, req] of wakeupQueue) {
        if (req.status === 'queued') {
            req.status = 'failed';
            req.error = 'System shutdown';
            req.completedAt = Date.now();
        }
    }
    titanEvents.removeAllListeners('agent:wakeup');
    initialized = false;
    logger.info(COMPONENT, 'Agent wakeup system shut down');
}

// ── Internal ──────────────────────────────────────────────────────────

/**
 * Handle a wakeup event. Claims the request, runs the sub-agent in
 * the background, and handles completion.
 */
async function handleWakeup(wakeupRequestId: string): Promise<void> {
    const req = wakeupQueue.get(wakeupRequestId);
    if (!req) {
        logger.warn(COMPONENT, `Wakeup ${wakeupRequestId} not found in queue`);
        return;
    }
    if (req.status !== 'queued') {
        logger.warn(COMPONENT, `Wakeup ${wakeupRequestId} already ${req.status}, skipping`);
        return;
    }

    // Claim
    req.status = 'running';
    logger.info(COMPONENT, `[Wakeup] Claimed ${wakeupRequestId} — running sub-agent "${req.agentName}" for issue ${req.issueIdentifier}`);

    // Transition CP issue to in_progress
    updateIssue(req.issueId, { status: 'in_progress' });

    // Start a CP run for tracking
    const run = startRun(req.agentId, 'assignment', req.issueId);

    // Emit SSE event
    titanEvents.emit('agent:wakeup:running', {
        wakeupRequestId,
        issueId: req.issueId,
        agentId: req.agentId,
    });

    try {
        let result: SubAgentResult;

        if (req.mode === 'multi-agent') {
            // ── Multi-agent path: route through the full agent system ──
            logger.info(COMPONENT, `[Wakeup] Multi-agent delegation to "${req.agentName}" (${req.agentId})`);
            const startMs = Date.now();
            const agentResponse = await routeMessage(req.task, 'delegation', req.agentId, undefined, req.agentId);
            result = {
                content: agentResponse.content,
                toolsUsed: agentResponse.toolsUsed || [],
                success: !agentResponse.content.toLowerCase().includes('error'),
                durationMs: Date.now() - startMs,
                rounds: 1,
                validated: true,
            };
        } else if (req.mode === 'external') {
            // ── External adapter path: spawn CLI process ──
            const adapter = getAdapter(req.adapterType || 'bash');
            if (!adapter) throw new Error(`Unknown adapter type: ${req.adapterType}`);

            logger.info(COMPONENT, `[Wakeup] External adapter "${adapter.displayName}" for issue ${req.issueIdentifier}`);
            const config = loadConfig();
            const port = (config.gateway as Record<string, unknown>).port as number || 48420;
            const adapterResult = await adapter.execute({
                task: req.task,
                cwd: req.cwd,
                titanApiUrl: `http://localhost:${port}`,
                titanRunId: run.id,
                titanIssueId: req.issueId,
                timeoutMs: 300_000,
            });
            result = {
                content: adapterResult.content,
                toolsUsed: adapterResult.toolsUsed,
                success: adapterResult.success,
                durationMs: adapterResult.durationMs,
                rounds: 1,
                validated: true,
            };
        } else {
            // ── Sub-agent path: isolated sub-agent execution ──
            const template = SUB_AGENT_TEMPLATES[req.templateName] || {};
            const config = loadConfig();
            const modelAliases = (config.agent as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
            const tier = (template as Record<string, unknown>).tier as string | undefined;
            let model = req.model;
            if (!model && modelAliases && tier) {
                model = modelAliases[tier] || modelAliases.fast;
            }
            result = await spawnSubAgent({
                name: req.agentName,
                task: req.task,
                tools: template.tools,
                systemPrompt: template.systemPrompt,
                model,
                depth: 0,
            });
        }

        // Complete the CP run
        endRun(run.id, {
            status: result.success ? 'succeeded' : 'failed',
            toolsUsed: result.toolsUsed,
        });

        await handleCompletion(wakeupRequestId, result);
    } catch (err) {
        const error = (err as Error).message;
        req.status = 'failed';
        req.error = error;
        req.completedAt = Date.now();

        endRun(run.id, { status: 'error', error });

        // Post failure comment on issue
        addIssueComment(req.issueId, `**Sub-agent failed**: ${error}`, { agentId: req.agentId });
        updateIssue(req.issueId, { status: 'todo' }); // Back to todo for retry

        titanEvents.emit('agent:task:failed', {
            wakeupRequestId,
            issueId: req.issueId,
            agentId: req.agentId,
            error,
        });

        logger.error(COMPONENT, `[Wakeup] ${wakeupRequestId} failed: ${error}`);
    }
}

/**
 * Handle successful sub-agent completion.
 */
async function handleCompletion(wakeupRequestId: string, result: SubAgentResult): Promise<void> {
    const req = wakeupQueue.get(wakeupRequestId);
    if (!req) return;

    req.status = 'completed';
    req.completedAt = Date.now();

    const durationSec = ((req.completedAt - req.createdAt) / 1000).toFixed(1);
    logger.info(COMPONENT, `[Wakeup] ${wakeupRequestId} completed in ${durationSec}s — ${result.success ? 'SUCCESS' : 'FAILED'}`);

    // 1. Post result as CP issue comment
    const commentBody = [
        `**Sub-agent result** (${result.rounds} rounds, ${result.durationMs}ms)`,
        `Status: ${result.success ? 'SUCCESS' : 'FAILED'}${result.validated ? '' : ' [UNVALIDATED]'}`,
        `Tools: ${result.toolsUsed.join(', ') || 'none'}`,
        '',
        result.content,
    ].join('\n');
    addIssueComment(req.issueId, commentBody, { agentId: req.agentId });

    // 2. Transition issue status
    updateIssue(req.issueId, { status: result.success ? 'done' : 'todo' });

    // 3. Store pending result for parent session injection
    if (req.parentSessionId) {
        const existing = pendingResults.get(req.parentSessionId) || [];
        existing.push({
            issueId: req.issueId,
            issueIdentifier: req.issueIdentifier,
            agentName: req.agentName,
            result,
            completedAt: Date.now(),
        });
        pendingResults.set(req.parentSessionId, existing);
    }

    // 4. Emit SSE event for UI
    titanEvents.emit('agent:task:completed', {
        wakeupRequestId,
        issueId: req.issueId,
        issueIdentifier: req.issueIdentifier,
        agentId: req.agentId,
        agentName: req.agentName,
        success: result.success,
        summary: result.content.slice(0, 200),
        durationMs: result.durationMs,
        rounds: result.rounds,
    });
}
