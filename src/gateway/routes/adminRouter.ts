/**
 * Admin Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates audit, vulnerabilities, auth, soul, activity, browser, and docs routes.
 */

import { Router, type Request, type Response } from 'express';
import { join } from 'path';
import fs from 'fs';
import { loadConfig } from '../../config/config.js';
import {
  queryAuditLog,
  getAuditStats,
} from '../../agent/auditLog.js';
import {
  getConsentUrl,
  exchangeCode,
  isGoogleConnected,
  getGoogleEmail,
  disconnectGoogle,
} from '../../auth/google.js';
import { TITAN_VERSION, TITAN_WORKSPACE } from '../../utils/constants.js';
import logger, { getLogFilePath } from '../../utils/logger.js';
import { listSessions } from '../../agent/session.js';
import { getUsageStats } from '../../memory/memory.js';
import { getAutopilotStatus } from '../../agent/autopilot.js';
import { listGoals } from '../../agent/goals.js';
import { getGraphData } from '../../memory/graph.js';
import { getActiveLlmRequests } from '../server.js';

const COMPONENT = 'AdminRouter';

export function createAdminRouter(): Router {
  const router = Router();

  // ── Audit API ────────────────────────────────────────────
  router.get('/audit', (req, res) => {
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

  router.get('/audit/stats', (req, res) => {
    const hours = req.query.hours ? parseInt(req.query.hours as string, 10) : 24;
    res.json(getAuditStats(hours));
  });

  // ── Vulnerability Scan API ────────────────────────────────
  router.get('/vulnerabilities', (_req, res) => {
    try {
      const reportPath = join(process.cwd(), 'dependency-scan-report.json');
      if (!fs.existsSync(reportPath)) {
        res.json({
          timestamp: new Date().toISOString(),
          vulnerabilities: { total: 0, critical: 0, high: 0, moderate: 0, low: 0 },
          outdated: [],
          deprecated: [],
          licenseIssues: [],
          totalDependencies: 0,
          directDependencies: 0,
          errors: ['No scan report found. Run: npm run scan:deps'],
        });
        return;
      }
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/vulnerabilities/scan', async (_req, res) => {
    try {
      const scanScript = join(process.cwd(), 'scripts', 'dependency-scan.cjs');
      if (!fs.existsSync(scanScript)) {
        res.status(404).json({ error: 'Scan script not found' });
        return;
      }

      const { exec } = await import('child_process');
      exec(`node ${scanScript}`, (error, stdout, stderr) => {
        if (error) {
          res.status(500).json({ error: error.message, output: stderr });
          return;
        }
        res.json({ success: true, output: stdout });
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Google OAuth Endpoints ───────────────────────────────
  function getGoogleRedirectUri(): string {
    const cfg = loadConfig();
    const publicUrl = (cfg.gateway as Record<string, unknown>).publicUrl as string | undefined;
    const port = cfg.gateway.port || 48420;
    return publicUrl
      ? `${publicUrl}/api/auth/google/callback`
      : `http://localhost:${port}/api/auth/google/callback`;
  }

  router.get('/auth/google/status', (_req, res) => {
    res.json({ connected: isGoogleConnected(), email: getGoogleEmail() });
  });

  router.get('/auth/google/start', (req, res) => {
    try {
      const url = getConsentUrl(getGoogleRedirectUri());
      res.redirect(url);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/auth/google/callback', async (req, res) => {
    const code = req.query.code as string;
    if (!code) { res.status(400).send('Missing authorization code'); return; }
    try {
      await exchangeCode(code, getGoogleRedirectUri());
      res.redirect('/?google_connected=1');
    } catch (err) {
      res.status(500).send(`OAuth failed: ${(err as Error).message}`);
    }
  });

  router.post('/auth/google/disconnect', (_req, res) => {
    disconnectGoogle();
    res.json({ ok: true });
  });

  // ── SOUL.md Endpoints ───────────────────────────────────
  router.get('/soul', (_req, res) => {
    try {
      const cfg = loadConfig();
      const soulPath = join(cfg.agent.workspace || TITAN_WORKSPACE, 'SOUL.md');
      if (fs.existsSync(soulPath)) {
        res.json({ content: fs.readFileSync(soulPath, 'utf-8') });
      } else {
        res.json({ content: '' });
      }
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/soul', (req, res) => {
    try {
      const cfg = loadConfig();
      const workspace = cfg.agent.workspace || TITAN_WORKSPACE;
      const soulPath = join(workspace, 'SOUL.md');

      if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });

      const { content, aboutMe, personality } = req.body as {
        content?: string;
        aboutMe?: string;
        personality?: string;
      };

      if (content !== undefined) {
        fs.writeFileSync(soulPath, content, 'utf-8');
      } else if (aboutMe || personality) {
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
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── Activity Feed ───────────────────────────────────────
  router.get('/activity/recent', (req, res) => {
    try {
      const logPath = getLogFilePath();
      if (!logPath || !fs.existsSync(logPath)) {
        res.json({ events: [] });
        return;
      }
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
      const filter = (req.query.filter as string) || 'all';
      const stats = fs.statSync(logPath);
      const readSize = Math.min(stats.size, 200000);
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stats.size - readSize));
      fs.closeSync(fd);
      const content = buf.toString('utf-8');
      const rawLines = content.split('\n').filter(Boolean);
      const lines = stats.size > readSize ? rawLines.slice(1) : rawLines;

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
          if (e.level === 'debug') return false;
          if (filter === 'all') return true;
          if (filter === 'errors') return e.level === 'error' || e.level === 'warn';
          return e.type === filter;
        })
        .slice(-limit)
        .reverse();

      res.json({ events });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/activity/summary', (_req, res) => {
    try {
      const cfg = loadConfig();
      const sessions = listSessions();
      const usage = getUsageStats();
      const autopilot = getAutopilotStatus();
      const goals = listGoals();

      const toolCalls = (usage as Record<string, unknown>).toolCalls ?? (usage as Record<string, unknown>).totalToolCalls ?? 0;

      let status: 'idle' | 'processing' | 'autopilot' = 'idle';
      if (getActiveLlmRequests() > 0) status = 'processing';
      if (autopilot.isRunning) status = 'autopilot';

      let lastActivity: string | null = null;
      try {
        const logPath = getLogFilePath();
        if (logPath && fs.existsSync(logPath)) {
          const stat = fs.statSync(logPath);
          lastActivity = stat.mtime.toISOString();
        }
      } catch { /* ignore */ }

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
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`);
      res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // ── Browser automation endpoints ─────────────────────────
  router.post('/browser/form-fill', async (req, res) => {
    const { url, data, submit, postClicks } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ success: false, error: 'url is required (string)' });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, error: 'data is required (Record<string, string>)' });
    }
    try {
      const { getPage, releasePage } = await import('../../browsing/browserPool.js');
      const { fillFormSmart } = await import('../../skills/builtin/web_browse_llm.js');
      const page = await getPage();
      const session = { page, lastUsed: Date.now(), elements: new Map<number, string>() };
      try {
        const deferSubmit = Array.isArray(postClicks) && postClicks.length > 0 && submit;
        const result = await fillFormSmart(session as any, url, data as Record<string, string>, deferSubmit ? false : (submit ?? false));

        const clickResults: string[] = [];
        if (Array.isArray(postClicks)) {
          for (const click of postClicks) {
            try {
              if (typeof click === 'string') {
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

        if (deferSubmit) {
          try {
            const { solveCaptcha } = await import('../../browsing/captchaSolver.js');
            const solveResult = await solveCaptcha(page as unknown as import('playwright').Page);
            if (solveResult.solved) {
              clickResults.push(`✅ ${solveResult.type} solved via CapSolver`);
            } else if (solveResult.error) {
              clickResults.push(`⚠️ CAPTCHA: ${solveResult.error}`);
            }
          } catch { /* CapSolver not available */ }

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
              await page.waitForTimeout(3000);
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

  router.post('/browser/solve-captcha', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ solved: false, error: 'url is required (string)' });
    }
    try {
      const { getPage, releasePage } = await import('../../browsing/browserPool.js');
      const { solveCaptcha } = await import('../../browsing/captchaSolver.js');
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

  // ── API Documentation ────────────────────────────────────
  router.get('/docs', (_req, res) => {
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

  return router;
}
