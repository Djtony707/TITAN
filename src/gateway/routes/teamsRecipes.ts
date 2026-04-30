/**
 * Teams, Recipes, Plugins, and Graph Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates all /api/teams/*, /api/recipes/*, /api/plugins, and /api/graphiti/* routes.
 */
import { Router, type Request, type Response } from 'express';
import express from 'express';
import logger from '../../utils/logger.js';

import {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  getTeamStats,
  addMember,
  removeMember,
  updateMemberRole,
  createInvite,
  acceptInvite,
  getEffectivePermissions,
  getUserRole,
  setRolePermissions,
  isToolAllowed,
} from '../../security/teams.js';

import {
  listRecipes,
  getRecipe,
  saveRecipe,
  deleteRecipe,
  getBuiltinRecipes,
  importRecipeYaml,
} from '../../recipes/store.js';

import { runRecipe } from '../../recipes/runner.js';

import {
  getGraphData,
  getGraphStats,
  clearGraph,
  cleanupGraph,
  listEntities,
} from '../../memory/graph.js';

const COMPONENT = 'TeamsRecipesRouter';

export function createTeamsRecipesRouter(): Router {
  const router = Router();

  // ── Teams RBAC API ──────────────────────────────────────────
  router.get('/teams', (_req, res) => {
    res.json({ teams: listTeams().map(t => ({ id: t.id, name: t.name, description: t.description, memberCount: t.members.filter(m => m.status === 'active').length, createdAt: t.createdAt })) });
  });

  router.post('/teams', (req, res) => {
    try {
      const { name, description, ownerId = 'api-user' } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const team = createTeam(name, ownerId, description);
      res.status(201).json({ team: { id: team.id, name: team.name } });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/teams/:teamId', (req, res) => {
    const team = getTeam(req.params.teamId);
    if (!team) { res.status(404).json({ error: 'Team not found' }); return; }
    res.json({ team, stats: getTeamStats(req.params.teamId) });
  });

  router.patch('/teams/:teamId', (req, res) => {
    try {
      const { name, description, actorId = 'api-user' } = req.body;
      const team = updateTeam(req.params.teamId, actorId, { name, description });
      res.json({ team: { id: team.id, name: team.name, description: team.description } });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.delete('/teams/:teamId', (req, res) => {
    try {
      const actorId = (req.query.actorId as string) || 'api-user';
      const deleted = deleteTeam(req.params.teamId, actorId);
      res.json({ deleted });
    } catch (e) { res.status(403).json({ error: (e as Error).message }); }
  });

  router.get('/teams/:teamId/members', (req, res) => {
    const team = getTeam(req.params.teamId);
    if (!team) { res.status(404).json({ error: 'Team not found' }); return; }
    res.json({ members: team.members });
  });

  router.post('/teams/:teamId/members', (req, res) => {
    try {
      const { userId, role = 'operator', displayName, actorId = 'api-user' } = req.body;
      if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
      const member = addMember(req.params.teamId, actorId, userId, role, displayName);
      res.status(201).json({ member });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.delete('/teams/:teamId/members/:userId', (req, res) => {
    try {
      const actorId = (req.query.actorId as string) || 'api-user';
      const removed = removeMember(req.params.teamId, actorId, req.params.userId);
      res.json({ removed });
    } catch (e) { res.status(403).json({ error: (e as Error).message }); }
  });

  router.patch('/teams/:teamId/members/:userId/role', (req, res) => {
    try {
      const { role, actorId = 'api-user' } = req.body;
      if (!role) { res.status(400).json({ error: 'role is required' }); return; }
      const member = updateMemberRole(req.params.teamId, actorId, req.params.userId, role);
      res.json({ member });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/teams/:teamId/invites', (req, res) => {
    try {
      const { role = 'operator', expiresInHours = 48, actorId = 'api-user' } = req.body;
      const code = createInvite(req.params.teamId, actorId, role, expiresInHours);
      res.status(201).json({ code, expiresInHours });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/teams/join', (req, res) => {
    try {
      const { code, userId, displayName } = req.body;
      if (!code || !userId) { res.status(400).json({ error: 'code and userId are required' }); return; }
      const result = acceptInvite(code, userId, displayName);
      res.json({ teamId: result.team.id, teamName: result.team.name, role: result.member.role });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/teams/:teamId/permissions/:userId', (req, res) => {
    const perms = getEffectivePermissions(req.params.teamId, req.params.userId);
    const role = getUserRole(req.params.teamId, req.params.userId);
    res.json({ role, permissions: perms });
  });

  router.put('/teams/:teamId/roles/:role/permissions', (req, res) => {
    try {
      const { actorId = 'api-user', ...perms } = req.body;
      setRolePermissions(req.params.teamId, actorId, req.params.role as 'admin' | 'operator' | 'viewer', perms);
      res.json({ updated: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.get('/teams/:teamId/tools/:toolName/check/:userId', (req, res) => {
    const allowed = isToolAllowed(req.params.teamId, req.params.userId, req.params.toolName);
    res.json({ allowed, tool: req.params.toolName, userId: req.params.userId });
  });

  // ── Recipes / Workflow API ───────────────────────────────────
  router.get('/recipes', (_req, res) => {
    res.json({ recipes: listRecipes() });
  });

  router.get('/recipes/:id', (req, res) => {
    const recipe = getRecipe(req.params.id);
    if (!recipe) { res.status(404).json({ error: 'Recipe not found' }); return; }
    res.json({ recipe });
  });

  router.post('/recipes', (req, res) => {
    const recipe = req.body;
    if (!recipe.id || !recipe.name || !recipe.steps) {
      res.status(400).json({ error: 'id, name, and steps are required' }); return;
    }
    if (!recipe.createdAt) recipe.createdAt = new Date().toISOString();
    saveRecipe(recipe);
    res.status(201).json({ recipe });
  });

  router.put('/recipes/:id', (req, res) => {
    const existing = getRecipe(req.params.id);
    if (!existing) { res.status(404).json({ error: 'Recipe not found' }); return; }
    const updated = { ...existing, ...req.body, id: req.params.id };
    saveRecipe(updated);
    res.json({ recipe: updated });
  });

  router.delete('/recipes/:id', (req, res) => {
    if (!getRecipe(req.params.id)) { res.status(404).json({ error: 'Recipe not found' }); return; }
    deleteRecipe(req.params.id);
    res.json({ deleted: true });
  });

  router.get('/recipes/builtin/templates', (_req, res) => {
    res.json({ templates: getBuiltinRecipes() });
  });

  router.post('/recipes/import', express.text({ type: 'text/*' }), (req, res) => {
    try {
      const recipe = importRecipeYaml(req.body);
      saveRecipe(recipe);
      res.status(201).json({ recipe });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  router.post('/recipes/:id/run', async (req, res) => {
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
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── Plugins API ─────────────────────────────────────────────
  router.get('/plugins', async (_req, res) => {
    const { getPlugins } = await import('../../plugins/registry.js');
    const plugins = getPlugins().map((p: { name: string; version: string }) => ({
      name: p.name,
      version: p.version,
    }));
    res.json({ plugins });
  });

  // ── Graph API ─────────────────────────────────────────────────
  router.get('/graphiti', (_req, res) => {
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
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/graph/entities', (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const type = (req.query.type as string) || undefined;
      const entities = listEntities(type);
      const filtered = q
        ? entities.filter(e => e.name.toLowerCase().includes(q.toLowerCase()) || (e.type || '').toLowerCase().includes(q.toLowerCase()))
        : entities;
      res.json(filtered);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.delete('/graphiti', (_req, res) => {
    try {
      clearGraph();
      logger.info(COMPONENT, 'Memory graph cleared via API');
      res.json({ success: true, message: 'Graph cleared' });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/graphiti/cleanup', (_req, res) => {
    try {
      const result = cleanupGraph();
      logger.info(COMPONENT, `Graph cleanup: removed ${result.removedEntities} entities, ${result.removedEdges} edges`);
      res.json({ success: true, ...result });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  return router;
}
