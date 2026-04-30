/**
 * Skills & Meta Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates all /api/skills, /api/specialists, /api/marketplace,
 * /api/personas, /api/widget-gallery, /api/tools, /api/channels,
 * /api/security, /api/providers, /api/health, /api/bug-reports,
 * and /api/sandbox routes.
 */

import { Router, type Request, type Response } from 'express';
import logger from '../../utils/logger.js';
import { loadConfig, updateConfig } from '../../config/config.js';
import { getSkills, toggleSkill, getSkillTools } from '../../skills/registry.js';
import { listPersonas, getPersona, invalidatePersonaCache } from '../../personas/manager.js';
import {
  searchSkills as marketplaceSearch,
  installSkill,
  uninstallSkill,
  listSkills as listMarketplaceSkills,
  listInstalled as listInstalledMarketplace,
} from '../../skills/marketplace.js';
import { getRegisteredTools } from '../../agent/toolRunner.js';
import { auditSecurity } from '../../security/sandbox.js';
import { healthCheckAll } from '../../providers/router.js';
import { TITAN_VERSION } from '../../utils/constants.js';
import type { ChannelAdapter } from '../../channels/base.js';

const COMPONENT = 'SkillsRouter';

export function createSkillsRouter(channels: Map<string, ChannelAdapter>): Router {
  const router = Router();

  // ── Skills ──────────────────────────────────────────────────
  router.get('/skills', (_req, res) => {
    const skills = getSkills();
    res.json(skills);
  });

  router.post('/skills/:name/toggle', (req, res) => {
    try {
      const { name } = req.params;
      const enabled = toggleSkill(name);
      const tools = getSkillTools(name);
      res.json({ ok: true, skill: name, enabled, tools });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // ── Specialists ─────────────────────────────────────────────
  router.get('/specialists', async (_req, res) => {
    try {
      const { SPECIALISTS } = await import('../../agent/specialists.js');
      const cfg = loadConfig();
      const overrides = (cfg as unknown as { specialists?: { overrides?: Record<string, { model?: string }> } }).specialists?.overrides || {};
      const out = SPECIALISTS.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        title: s.title,
        defaultModel: s.model,
        activeModel: overrides[s.id]?.model || s.model,
        overridden: Boolean(overrides[s.id]?.model && overrides[s.id].model !== s.model),
        templateMatches: s.templateMatches,
        reportsTo: s.reportsTo,
      }));
      res.json(out);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.patch('/specialists/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { model } = (req.body || {}) as { model?: string | null };
      const { SPECIALISTS } = await import('../../agent/specialists.js');
      const specialist = SPECIALISTS.find((s) => s.id === id);
      if (!specialist) { res.status(404).json({ error: `Unknown specialist: ${id}` }); return; }
      const cfg = loadConfig();
      const cfgAny = cfg as unknown as { specialists?: { overrides?: Record<string, { model?: string }> } };
      const overrides = { ...(cfgAny.specialists?.overrides || {}) };
      if (model === null || model === '' || model === undefined) {
        delete overrides[id];
      } else if (typeof model === 'string') {
        overrides[id] = { model };
      } else {
        res.status(400).json({ error: 'model must be a string or null' });
        return;
      }
      updateConfig({ specialists: { overrides } } as unknown as Parameters<typeof updateConfig>[0]);
      res.json({ ok: true, id, activeModel: overrides[id]?.model || specialist.model });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── Marketplace ─────────────────────────────────────────────
  router.get('/marketplace', async (_req, res) => {
    try {
      const skills = await listMarketplaceSkills();
      const installed = listInstalledMarketplace();
      res.json({ skills: skills.map(s => ({ ...s, installed: installed.includes(s.file.replace('.js', '')) })), installed });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/marketplace/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const results = await marketplaceSearch(q, 50);
      const installed = listInstalledMarketplace();
      res.json({ ...results, skills: results.skills.map(s => ({ ...s, installed: installed.includes(s.file.replace('.js', '')) })) });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/marketplace/install', async (req, res): Promise<void> => {
    try {
      const { skill } = req.body as { skill: string };
      if (!skill) { res.status(400).json({ error: 'Missing "skill" field' }); return; }
      const result = await installSkill(skill);
      res.json(result);
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/marketplace/uninstall', (req, res): void => {
    try {
      const { skill } = req.body as { skill: string };
      if (!skill) { res.status(400).json({ error: 'Missing "skill" field' }); return; }
      const result = uninstallSkill(skill);
      res.json(result);
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // ── Personas ──────────────────────────────────────────────────
  router.get('/personas', (_req, res) => {
    try {
      const cfg = loadConfig();
      res.json({ personas: listPersonas(), active: cfg.agent.persona || 'default' });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/persona/switch', (req, res): void => {
    try {
      const { persona } = req.body as { persona: string };
      if (!persona || typeof persona !== 'string') { res.status(400).json({ error: 'Missing persona ID' }); return; }
      if (persona !== 'default' && !getPersona(persona)) { res.status(404).json({ error: `Persona "${persona}" not found` }); return; }
      const cfg = loadConfig();
      updateConfig({ agent: { ...cfg.agent, persona } });
      invalidatePersonaCache();
      res.json({ ok: true, active: persona });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // ── Widget Gallery ──────────────────────────────────────────
  router.get('/widget-gallery', async (_req, res) => {
    try {
      const { listTemplates, listCategories } = await import('../../skills/builtin/widget_gallery.js');
      const templates = listTemplates();
      const categories = listCategories();
      res.json({ count: templates.length, categories, templates });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // ── Tools ───────────────────────────────────────────────────
  router.get('/tools', (req, res) => {
    const includeSchema = req.query.include === 'schema';
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    let tools = getRegisteredTools().map((t) => {
      const item: Record<string, unknown> = {
        name: t.name,
        description: t.description,
      };
      if (includeSchema) {
        item.parameters = t.parameters;
      }
      return item;
    });

    if (q) {
      tools = tools.filter((t) =>
        (t.name as string).toLowerCase().includes(q) ||
        (t.description as string).toLowerCase().includes(q),
      );
    }

    const total = tools.length;
    const paginated = tools.slice(offset, offset + limit);

    res.json({
      total,
      count: paginated.length,
      offset,
      tools: paginated,
    });
  });

  // ── Channels ──────────────────────────────────────────────
  router.get('/channels', (_req, res) => {
    const statuses = Array.from(channels.values()).map((ch) => ch.getStatus());
    res.json(statuses);
  });

  // ── Security ────────────────────────────────────────────────
  router.get('/security', (_req, res) => {
    const audit = auditSecurity();
    res.json(audit);
  });

  // ── Providers ─────────────────────────────────────────────
  router.get('/providers', async (_req, res) => {
    const health = await healthCheckAll();
    res.json(health);
  });

  // ── Health ──────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    const cfg = loadConfig();
    res.json({ status: 'ok', version: TITAN_VERSION, uptime: process.uptime(), onboarded: cfg.onboarded });
  });

  // ── Bug Reports ─────────────────────────────────────────────
  router.get('/bug-reports', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
      const { listRecentBugReports } = await import('../../analytics/bugReports.js');
      const reports = listRecentBugReports(limit);
      res.json({ count: reports.length, reports });
    } catch (err) {
      res.status(500).json({ error: 'bug_reports_unavailable', message: (err as Error).message });
    }
  });

  router.get('/bug-reports/:id', async (req, res) => {
    try {
      const { getBugReport } = await import('../../analytics/bugReports.js');
      const r = getBugReport(req.params.id);
      if (!r) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: 'bug_report_unavailable', message: (err as Error).message });
    }
  });

  // ── Sandbox ─────────────────────────────────────────────────
  router.post('/sandbox/execute', async (req, res) => {
    try {
      const { code, language, timeoutMs } = req.body;
      if (!code || typeof code !== 'string') {
        res.status(400).json({ error: 'code is required' });
        return;
      }
      const { executeInSandbox } = await import('../../agent/sandbox.js');
      const result = await executeInSandbox(code, language || 'javascript', timeoutMs || 60000);
      res.json(result);
    } catch (err) {
      logger.error(COMPONENT, `Sandbox execute error: ${(err as Error).message}`);
      res.status(500).json({ error: 'Sandbox execution failed', message: (err as Error).message });
    }
  });

  router.get('/sandbox/status', async (_req, res) => {
    try {
      const { getSandboxStatus } = await import('../../agent/sandbox.js');
      res.json(getSandboxStatus());
    } catch (err) {
      res.status(500).json({ error: 'Sandbox status unavailable', message: (err as Error).message });
    }
  });

  return router;
}
