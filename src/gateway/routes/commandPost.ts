/**
 * Command Post Router
 *
 * Extracted from gateway/server.ts v5.4.5 → v5.5.0.
 * Consolidates all /api/command-post/* routes for agent governance.
 */

import { Router, type Request, type Response } from 'express';
import logger from '../../utils/logger.js';

// Command Post core
import {
  getDashboard as getCPDashboard,
  getRegisteredAgents,
  reportHeartbeat,
  removeAgent,
  checkoutTask,
  checkinTask,
  getActiveCheckouts,
  getBudgetPolicies,
  createBudgetPolicy,
  updateBudgetPolicy,
  deleteBudgetPolicy,
  getActivity,
  getGoalTree,
  getAncestryChain,
  validateGoalAncestry,
  validateGoalParentAssignment,
  sweepExpiredCheckoutsManual,
  getStaleAgents,
  enforceBudgetForAgent,
  getBudgetPolicyForAgent,
  createIssue,
  updateIssue,
  getIssue,
  listIssues,
  searchIssues,
  checkoutIssue,
  deleteIssue,
  addIssueComment,
  getIssueComments,
  createApproval,
  approveApproval,
  rejectApproval,
  listApprovals,
  getApproval,
  replyToApproval,
  snoozeApproval,
  unsnoozeApproval,
  batchApprove,
  batchReject,
  getAgentMessages,
  markAgentMessageRead,
  startRun,
  endRun,
  listRuns,
  getOrgTree,
  updateRegisteredAgent,
} from '../../agent/commandPost.js';

// Agent wakeup
import {
  getAgentInbox,
  queueWakeup,
  getWakeupRequest,
  cancelWakeup,
  drainPendingResults,
} from '../../agent/agentWakeup.js';

// Daemon events (for SSE)
import { titanEvents } from '../../agent/daemon.js';

// Goals
import { createGoal } from '../../agent/goals.js';

const COMPONENT = 'CommandPostRouter';

export function createCommandPostRouter(): Router {
  const router = Router();

  // ── Dashboard ─────────────────────────────────────────────
  router.get('/dashboard', async (_req, res) => {
    const dashboard = getCPDashboard();
    try {
      const { listCompanies, getActiveRunners } = await import('../../agent/company.js');
      const companies = listCompanies();
      const runners = getActiveRunners();
      (dashboard as Record<string, unknown>).companies = companies.map(c => ({
        ...c,
        runnerActive: runners.includes(c.id),
      }));
    } catch { (dashboard as Record<string, unknown>).companies = []; }
    res.json(dashboard);
  });

  // ── Agents ──────────────────────────────────────────────────
  router.get('/agents', (_req, res) => {
    res.json(getRegisteredAgents());
  });

  router.post('/agents/:id/heartbeat', (req, res) => {
    const ok = reportHeartbeat(req.params.id);
    res.json({ success: ok });
  });

  router.post('/agents/:id/fire', async (req, res) => {
    try {
      const { fireHeartbeat } = await import('../../agent/heartbeatScheduler.js');
      await fireHeartbeat(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.delete('/agents/:id', (req, res) => {
    const ok = removeAgent(req.params.id);
    if (!ok) { res.status(400).json({ error: 'Cannot remove agent (not found or is the primary agent)' }); return; }
    res.json({ success: true });
  });

  router.patch('/agents/:id', async (req, res) => {
    const { reportsTo, role, title, name, status, model } = req.body;
    const updated = updateRegisteredAgent(req.params.id, { reportsTo, role, title, name, model });
    if (!updated) { res.status(404).json({ error: 'Agent not found' }); return; }
    if (status && typeof status === 'string') {
      try {
        const { updateAgentStatus } = await import('../../agent/commandPost.js');
        updateAgentStatus(req.params.id, status as 'active' | 'idle' | 'paused' | 'error' | 'stopped');
      } catch { /* ok */ }
    }
    res.json(updated);
  });

  router.patch('/agents/:id/identity', async (req, res) => {
    const { voiceId, personaId, systemPromptOverride, memoryNamespace, characterSummary, model } = req.body || {};
    const coerce = (v: unknown): string | null | undefined => {
      if (v === null) return null;
      if (typeof v === 'string') return v;
      if (v === undefined) return undefined;
      res.status(400).json({ error: `Invalid identity field: expected string or null, got ${typeof v}` });
      return undefined;
    };
    if (res.headersSent) return;
    const { updateAgentIdentity } = await import('../../agent/commandPost.js');
    const updated = updateAgentIdentity(req.params.id, {
      voiceId: coerce(voiceId),
      personaId: coerce(personaId),
      systemPromptOverride: coerce(systemPromptOverride),
      memoryNamespace: coerce(memoryNamespace),
      characterSummary: coerce(characterSummary),
      model: coerce(model),
    });
    if (res.headersSent) return;
    if (!updated) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json(updated);
  });

  router.get('/agents/stale', (_req, res) => {
    const stale = getStaleAgents();
    res.json({ stale, total: stale.length });
  });

  // ── Tasks (checkout/checkin) ────────────────────────────────
  router.post('/tasks/:goalId/:subtaskId/checkout', (req, res) => {
    const agentId = (req.body as { agentId?: string }).agentId || 'manual';
    const lock = checkoutTask(req.params.goalId, req.params.subtaskId, agentId);
    if (!lock) { res.status(409).json({ error: 'Task already checked out by another agent' }); return; }
    res.json(lock);
  });

  router.post('/tasks/:goalId/:subtaskId/checkin', (req, res) => {
    const runId = (req.body as { runId?: string }).runId || '';
    const ok = checkinTask(req.params.subtaskId, runId);
    if (!ok) { res.status(404).json({ error: 'No matching checkout found' }); return; }
    res.json({ success: true });
  });

  // ── Checkouts ───────────────────────────────────────────────
  router.get('/checkouts', (_req, res) => {
    res.json(getActiveCheckouts());
  });

  router.post('/checkouts/sweep', (_req, res) => {
    const result = sweepExpiredCheckoutsManual();
    res.json(result);
  });

  router.get('/checkouts/expired', (_req, res) => {
    const result = sweepExpiredCheckoutsManual();
    res.json({ expired: result.swept, details: result.details });
  });

  // ── Budgets ─────────────────────────────────────────────────
  router.get('/budgets', (_req, res) => {
    res.json(getBudgetPolicies());
  });

  router.get('/budgets/reservations', (_req, res) => {
    res.json([]);
  });

  router.post('/budgets', (req, res) => {
    try {
      const body = req.body as {
        name: string;
        scope: { type: 'agent' | 'goal' | 'global'; targetId?: string };
        period: 'daily' | 'weekly' | 'monthly';
        limitUsd: number;
        warningThresholdPercent?: number;
        action?: 'warn' | 'pause' | 'stop';
        enabled?: boolean;
      };
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

  router.put('/budgets/:id', (req, res) => {
    const updated = updateBudgetPolicy(req.params.id, req.body as Record<string, unknown>);
    if (!updated) { res.status(404).json({ error: 'Budget policy not found' }); return; }
    res.json(updated);
  });

  router.delete('/budgets/:id', (req, res) => {
    const ok = deleteBudgetPolicy(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Budget policy not found' }); return; }
    res.json({ success: true });
  });

  router.post('/budgets/:agentId/enforce', (req, res) => {
    const result = enforceBudgetForAgent(req.params.agentId);
    if (!result.budgetOk) {
      res.status(403).json({ budgetOk: false, policies: result.policies, message: 'Budget exceeded — agent paused' });
      return;
    }
    res.json({ budgetOk: true, policies: result.policies });
  });

  router.get('/budgets/agent/:agentId', (req, res) => {
    const budgetInfo = getBudgetPolicyForAgent(req.params.agentId);
    res.json(budgetInfo);
  });

  // ── Activity ──────────────────────────────────────────────
  router.get('/activity', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const type = req.query.type as string | undefined;
    res.json(getActivity({ limit, type }));
  });

  // ── Audit ───────────────────────────────────────────────────
  router.get('/audit', async (req, res) => {
    try {
      const { queryAudit } = await import('../../agent/auditStore.js');
      const query = {
        agentId: req.query.agentId as string | undefined,
        sessionId: req.query.sessionId as string | undefined,
        type: req.query.type as string | undefined,
        toolName: req.query.toolName as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 100,
      };
      res.json(queryAudit(query));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/audit/costs', async (req, res) => {
    try {
      const { getAgentCostSummary, getDailyCostBreakdown } = await import('../../agent/auditStore.js');
      const groupBy = req.query.groupBy as string || 'agent';
      if (groupBy === 'day') {
        const days = req.query.days ? parseInt(req.query.days as string) : 30;
        res.json(getDailyCostBreakdown(days));
      } else {
        const agentId = req.query.agentId as string | undefined;
        res.json(getAgentCostSummary(agentId));
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Goals ───────────────────────────────────────────────────
  router.post('/goals', (req, res) => {
    const { title, description, subtasks, priority, tags, force } = req.body;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    try {
      const goal = createGoal({
        title,
        description: description || '',
        subtasks: subtasks || [],
        priority,
        tags,
        force: !!force,
      });
      res.status(201).json({ goal });
    } catch (err) {
      res.status(429).json({ error: (err as Error).message });
    }
  });

  router.get('/goals/tree', (_req, res) => {
    res.json(getGoalTree());
  });

  router.get('/goals/:id/ancestry', (req, res) => {
    const chain = getAncestryChain(req.params.id);
    if (chain.length === 0) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json(chain);
  });

  router.post('/goals/:id/validate', (req, res) => {
    const { parentGoalId } = req.body as { parentGoalId?: string | null };
    if (parentGoalId !== undefined) {
      const result = validateGoalParentAssignment(req.params.id, parentGoalId || null);
      if (!result.valid) {
        res.status(422).json({ valid: false, errors: result.errors });
        return;
      }
      res.json({ valid: true });
    } else {
      const result = validateGoalAncestry(req.params.id);
      if (!result.valid) {
        res.status(422).json({ valid: false, errors: result.errors });
        return;
      }
      res.json({ valid: true });
    }
  });

  // ── Conflict Resolution ─────────────────────────────────────
  router.post('/conflicts/propose', async (req, res) => {
    try {
      const { conflictResolver } = await import('../../agent/conflictResolver.js');
      const { entities, type, description, metadata } = req.body;
      if (!entities || !Array.isArray(entities) || entities.length === 0) {
        res.status(400).json({ error: 'entities array is required' }); return;
      }
      if (!type || !['file', 'goal', 'resource', 'agent', 'config', 'other'].includes(type)) {
        res.status(400).json({ error: 'valid type is required (file, goal, resource, agent, config, other)' }); return;
      }
      if (!description || typeof description !== 'string') {
        res.status(400).json({ error: 'description string is required' }); return;
      }
      const proposal = await conflictResolver.generateProposal({ entities, type, description, metadata: metadata || {} });
      res.json(proposal);
    } catch (error) {
      logger.error(COMPONENT, 'Conflict proposal generation error:', error);
      res.status(500).json({ error: 'Failed to generate conflict resolution proposal' });
    }
  });

  router.post('/conflicts/propose/formatted', async (req, res) => {
    try {
      const { conflictResolver } = await import('../../agent/conflictResolver.js');
      const { entities, type, description, metadata } = req.body;
      if (!entities || !Array.isArray(entities) || entities.length === 0) {
        res.status(400).json({ error: 'entities array is required' }); return;
      }
      if (!type || !['file', 'goal', 'resource', 'agent', 'config', 'other'].includes(type)) {
        res.status(400).json({ error: 'valid type is required (file, goal, resource, agent, config, other)' }); return;
      }
      if (!description || typeof description !== 'string') {
        res.status(400).json({ error: 'description string is required' }); return;
      }
      const proposal = await conflictResolver.generateProposal({ entities, type, description, metadata: metadata || {} });
      const formatted = conflictResolver.formatProposal(proposal);
      res.type('text/plain').send(formatted);
    } catch (error) {
      logger.error(COMPONENT, 'Conflict proposal formatting error:', error);
      res.status(500).json({ error: 'Failed to format conflict resolution proposal' });
    }
  });

  router.get('/conflicts/types', (_req, res) => {
    res.json({
      types: [
        { id: 'file', name: 'File Conflict', description: 'Merge conflicts, version conflicts' },
        { id: 'goal', name: 'Goal Conflict', description: 'Competing or conflicting goals' },
        { id: 'resource', name: 'Resource Conflict', description: 'Resource contention (GPU, memory, etc.)' },
        { id: 'agent', name: 'Agent Conflict', description: 'Agent coordination conflicts' },
        { id: 'config', name: 'Configuration Conflict', description: 'Conflicting configuration values' },
        { id: 'other', name: 'Other', description: 'Unclassified conflict type' }
      ]
    });
  });

  // ── SSE Stream ────────────────────────────────────────────
  const CP_SSE_EVENTS = [
    'commandpost:activity', 'commandpost:task:checkout', 'commandpost:task:checkin',
    'commandpost:task:expired', 'commandpost:budget:warning', 'commandpost:budget:exceeded',
    'commandpost:agent:heartbeat', 'commandpost:agent:status',
  ];

  router.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const onEvent = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };

    const listeners = new Map<string, (data: unknown) => void>();
    for (const evt of CP_SSE_EVENTS) {
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

  // ── Org Chart ───────────────────────────────────────────────
  router.get('/org', async (_req, res) => {
    const org = getOrgTree();
    try {
      const { listCompanies } = await import('../../agent/company.js');
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

  // ── Issues ──────────────────────────────────────────────────
  router.get('/issues', (req, res) => {
    const filters = {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assignee as string | undefined,
      goalId: req.query.goalId as string | undefined,
    };
    res.json(listIssues(filters));
  });

  router.get('/issues/search', (req, res) => {
    const q = req.query.q as string | undefined;
    if (!q || q.trim().length < 2) {
      res.status(400).json({ error: 'Query must be at least 2 characters' }); return;
    }
    res.json(searchIssues(q));
  });

  router.post('/issues', (req, res) => {
    const { title, description, priority, assigneeAgentId, goalId, parentId } = req.body;
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    const issue = createIssue({ title, description, priority, assigneeAgentId, goalId, parentId, createdByUser: 'board' });
    res.status(201).json(issue);
  });

  router.get('/issues/:id/context', (req, res) => {
    const issue = getIssue(req.params.id);
    if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.json({ ancestry: issue.goalId || '', issue });
  });

  router.get('/issues/:id', (req, res) => {
    const issue = getIssue(req.params.id);
    if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
    const issueComments = getIssueComments(req.params.id);
    res.json({ ...issue, comments: issueComments });
  });

  router.get('/issues/:id/comments', (req, res) => {
    const issue = getIssue(req.params.id);
    if (!issue) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.json(getIssueComments(req.params.id));
  });

  router.patch('/issues/:id', (req, res) => {
    const { title, description, status, priority, assigneeAgentId, goalId } = req.body;
    const updated = updateIssue(req.params.id, { title, description, status, priority, assigneeAgentId, goalId });
    if (!updated) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.json(updated);
  });

  router.delete('/issues/:id', (req, res) => {
    const ok = deleteIssue(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.json({ success: true });
  });

  router.post('/issues/:id/checkout', (req, res) => {
    const { agentId } = req.body;
    if (!agentId) { res.status(400).json({ error: 'agentId is required' }); return; }
    const result = checkoutIssue(req.params.id, agentId);
    if (!result) { res.status(409).json({ error: 'Issue already checked out by another agent' }); return; }
    res.json(result);
  });

  router.post('/issues/:id/comments', (req, res) => {
    const { body: commentBody, agentId } = req.body;
    if (!commentBody) { res.status(400).json({ error: 'body is required' }); return; }
    const comment = addIssueComment(req.params.id, commentBody, { agentId, user: agentId ? undefined : 'board' });
    if (!comment) { res.status(404).json({ error: 'Issue not found' }); return; }
    res.status(201).json(comment);
  });

  // ── Approvals ─────────────────────────────────────────────
  router.get('/approvals', (req, res) => {
    const status = req.query.status as string | undefined;
    res.json(listApprovals(status));
  });

  router.post('/approvals', (req, res) => {
    const { type, requestedBy, payload, linkedIssueIds } = req.body;
    if (!type) { res.status(400).json({ error: 'type is required' }); return; }
    const approval = createApproval({ type, requestedBy: requestedBy || 'board', payload: payload || {}, linkedIssueIds });
    res.status(201).json(approval);
  });

  router.post('/approvals/:id/approve', async (req, res) => {
    const { decidedBy, note } = req.body;
    const result = await approveApproval(req.params.id, decidedBy || 'board', note);
    if (!result) { res.status(404).json({ error: 'Approval not found or already decided' }); return; }
    res.json(result);
  });

  router.post('/approvals/:id/reject', (req, res) => {
    const { decidedBy, note } = req.body;
    const result = rejectApproval(req.params.id, decidedBy || 'board', note);
    if (!result) { res.status(404).json({ error: 'Approval not found or already decided' }); return; }
    res.json(result);
  });

  router.post('/approvals/:id/reply', (req, res) => {
    const { author, body } = req.body;
    if (!body || typeof body !== 'string') { res.status(400).json({ error: 'body is required' }); return; }
    const result = replyToApproval(req.params.id, author || 'user', body);
    if (!result) { res.status(404).json({ error: 'Approval not found' }); return; }
    res.json(result);
  });

  router.post('/approvals/:id/snooze', (req, res) => {
    const { until } = req.body;
    if (!until) { res.status(400).json({ error: 'until timestamp is required' }); return; }
    const result = snoozeApproval(req.params.id, until);
    if (!result) { res.status(404).json({ error: 'Approval not found or not pending' }); return; }
    res.json(result);
  });

  router.post('/approvals/:id/unsnooze', (req, res) => {
    const result = unsnoozeApproval(req.params.id);
    if (!result) { res.status(404).json({ error: 'Approval not found' }); return; }
    res.json(result);
  });

  router.get('/approvals/:id/thread', (req, res) => {
    const approval = listApprovals().find(a => a.id === req.params.id);
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return; }
    res.json({ approvalId: approval.id, thread: approval.thread || [] });
  });

  router.post('/approvals/batch', async (req, res) => {
    const { ids, action, decidedBy, note } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) { res.status(400).json({ error: 'ids array required' }); return; }
    if (action === 'approve') {
      const result = await batchApprove(ids, decidedBy || 'board', note);
      res.json(result);
    } else if (action === 'reject') {
      const result = batchReject(ids, decidedBy || 'board', note);
      res.json(result);
    } else {
      res.status(400).json({ error: 'action must be approve or reject' });
    }
  });

  router.post('/approvals/sweep', async (_req, res) => {
    const { sweepStaleApprovalsManual } = await import('../../agent/commandPost.js');
    const result = sweepStaleApprovalsManual();
    res.json(result);
  });

  // ── Agent Messages ──────────────────────────────────────────
  router.get('/agent-messages', (req, res) => {
    const agentId = req.query.agentId as string | undefined;
    const userId = req.query.userId as string | undefined;
    const unreadOnly = req.query.unread === 'true';
    res.json(getAgentMessages(agentId, userId, unreadOnly));
  });

  router.post('/agent-messages/:id/read', (req, res) => {
    const ok = markAgentMessageRead(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Message not found' }); return; }
    res.json({ read: true });
  });

  // ── Debates ─────────────────────────────────────────────────
  router.post('/debates', async (req, res) => {
    try {
      const { question, participants, rounds, resolution, judgeModel } = req.body || {};
      if (!question || !Array.isArray(participants) || participants.length < 2) {
        res.status(400).json({ error: 'question + 2-5 participants required' }); return;
      }
      const { runDebate } = await import('../../skills/builtin/agent_debate.js');
      const result = await runDebate({
        question: String(question),
        participants,
        rounds: Math.max(1, Math.min(4, Number(rounds) || 2)),
        resolution: (resolution === 'vote' || resolution === 'synthesize' || resolution === 'judge') ? resolution : 'judge',
        judgeModel: judgeModel ? String(judgeModel) : undefined,
      });
      res.json({ ok: true, id: result.id, winner: result.winner });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/debates', async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const { listDebates } = await import('../../skills/builtin/agent_debate.js');
    res.json({ items: listDebates(limit) });
  });

  router.get('/debates/:id', async (req, res) => {
    const { getDebate } = await import('../../skills/builtin/agent_debate.js');
    const debate = getDebate(req.params.id);
    if (!debate) { res.status(404).json({ error: 'Debate not found' }); return; }
    res.json(debate);
  });

  // ── Runs ────────────────────────────────────────────────────
  router.get('/runs', (req, res) => {
    const agentId = req.query.agentId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(listRuns(agentId, limit));
  });

  router.post('/runs/:id/retry', async (req, res) => {
    const allRuns = listRuns(undefined, 500);
    const run = allRuns.find(r => r.id === req.params.id);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    const agent = getRegisteredAgents().find(a => a.id === run.agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    let task = `Retry failed run (${run.id})`;
    if (run.error) task += `: ${run.error}`;
    let issueDesc = task;
    if (run.issueId) {
      const originalIssue = getIssue(run.issueId);
      if (originalIssue) {
        task = `Retry: ${originalIssue.title}`;
        issueDesc = `${originalIssue.description || ''}\n\nRetrying after failure: ${run.error || 'unknown error'}`;
      }
    }

    const issue = createIssue({ title: task, description: issueDesc, priority: 'high', assigneeAgentId: agent.id, createdByUser: 'board' });
    const newRun = startRun(agent.id, 'manual', issue.id);
    queueWakeup({ issueId: issue.id, issueIdentifier: issue.identifier, agentId: agent.id, agentName: agent.name, parentSessionId: null, task, templateName: agent.role || 'default' });
    res.json({ retried: true, runId: newRun.id, issueId: issue.id });
  });

  // ── Wakeup System ───────────────────────────────────────────
  router.get('/agents/:agentId/inbox', (req, res) => {
    const items = getAgentInbox(req.params.agentId);
    res.json({ items, total: items.length });
  });

  router.post('/wakeup', (req, res) => {
    const { issueId, agentId, agentName, task, templateName } = req.body;
    if (!issueId || !agentId || !task) {
      res.status(400).json({ error: 'issueId, agentId, and task are required' }); return;
    }
    const wakeup = queueWakeup({ issueId, issueIdentifier: issueId, agentId, agentName: agentName || 'Agent', parentSessionId: null, task, templateName: templateName || '' });
    res.json({ wakeupRequestId: wakeup.id, status: wakeup.status });
  });

  router.get('/wakeup/:requestId', (req, res) => {
    const request = getWakeupRequest(req.params.requestId);
    if (!request) { res.status(404).json({ error: 'Wakeup request not found' }); return; }
    res.json(request);
  });

  router.delete('/wakeup/:requestId', (req, res) => {
    const cancelled = cancelWakeup(req.params.requestId);
    if (!cancelled) { res.status(409).json({ error: 'Request already running or completed' }); return; }
    res.json({ cancelled: true });
  });

  router.get('/sessions/:sessionId/pending-results', (req, res) => {
    const results = drainPendingResults(req.params.sessionId);
    res.json({ results, count: results.length });
  });

  return router;
}
