/**
 * Agents Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates multi-agent list/spawn/stop routes.
 */

import { Router } from 'express';
import { listAgents, spawnAgent, stopAgent, getAgentCapacity } from '../../agent/multiAgent.js';

export function createAgentsRouter(): Router {
  const router = Router();

  router.get('/agents', (_req, res) => {
    res.json({ agents: listAgents(), capacity: getAgentCapacity() });
  });

  router.post('/agents/spawn', (req, res) => {
    const { name, model, systemPrompt } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const result = spawnAgent({ name, model, systemPrompt });
    res.json(result);
  });

  router.post('/agents/stop', (req, res) => {
    const { agentId } = req.body;
    if (!agentId) { res.status(400).json({ error: 'agentId is required' }); return; }
    const result = stopAgent(agentId);
    res.json(result);
  });

  return router;
}
