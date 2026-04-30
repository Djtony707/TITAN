/**
 * Sessions Router
 *
 * Extracted from gateway/server.ts v5.5.0.
 */

import { Router } from 'express';
import { homedir } from 'os';
import { dirname, join } from 'path';
import fs from 'fs';
import logger from '../../utils/logger.js';
import { listSessions, closeSession, renameSession, sweepSessions } from '../../agent/session.js';
import { getHistory } from '../../memory/memory.js';

const COMPONENT = 'SessionsRouter';

export function createSessionsRouter(sessionAborts: Map<string, AbortController>): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const sessions = listSessions();
    res.json(sessions);
  });

  // Create a new session explicitly
  router.post('/', async (req, res) => {
    try {
      const { createNewSession } = await import('../../agent/session.js');
      const channel = req.body?.channel || 'webchat';
      const userId = req.body?.userId || 'api-user';
      const session = createNewSession(channel, userId);
      res.json({ id: session.id, channel: session.channel, userId: session.userId });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // Conversation search — full-text search across all sessions
  router.get('/search', (req, res) => {
    const query = (req.query.q as string || '').toLowerCase().trim();
    if (!query || query.length < 2) { res.status(400).json({ error: 'Query must be at least 2 characters' }); return; }
    try {
      const sessions = listSessions();
      const results: Array<{ sessionId: string; sessionName: string; role: string; content: string; timestamp: string }> = [];
      const limit = parseInt(req.query.limit as string) || 50;

      for (const session of sessions) {
        const history = getHistory(session.id, 1000);
        for (const msg of history as Array<{ content: string; role: string; createdAt?: string }>) {
          if (msg.content.toLowerCase().includes(query)) {
            results.push({
              sessionId: session.id,
              sessionName: (session as { name?: string }).name || session.id.slice(0, 8),
              role: msg.role,
              content: msg.content.slice(0, 200),
              timestamp: msg.createdAt || '',
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

  // Conversation export
  router.get('/:id/export', (req, res) => {
    const sessionId = req.params.id;
    const format = (req.query.format as string) || 'json';
    try {
      const history = getHistory(sessionId, 10000);
      if (!history || (history as unknown[]).length === 0) { res.status(404).json({ error: 'Session not found or empty' }); return; }

      if (format === 'markdown' || format === 'md') {
        const sessions = listSessions();
        const session = sessions.find(s => s.id === sessionId);
        const title = (session as { name?: string })?.name || sessionId.slice(0, 8);
        let md = `# ${title}\n\nExported: ${new Date().toISOString()}\n\n---\n\n`;
        for (const msg of history as Array<{ role: string; content: string; createdAt?: string }>) {
          const role = msg.role === 'user' ? '**You**' : '**TITAN**';
          md += `${role} (${msg.createdAt || ''}):\n\n${msg.content}\n\n---\n\n`;
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

  router.get('/:id', (req, res) => {
    try {
      const history = getHistory(req.params.id);
      res.json(history);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/:id/messages', (req, res) => {
    try {
      const history = getHistory(req.params.id);
      const messages = Array.isArray(history) ? history : ((history as Record<string, unknown>).messages || []);
      if ((messages as unknown[]).length === 0) {
        const allSessions = listSessions();
        const sessionExists = allSessions.some(s => s.id === req.params.id);
        if (!sessionExists) { res.status(404).json({ error: 'Session not found' }); return; }
      }
      res.json(messages);
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/:id/close', (req, res) => {
    try {
      closeSession(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      closeSession(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/sweep', (req, res) => {
    try {
      const { channel, channelPrefix, idleMs, force } = (req.body ?? {}) as {
        channel?: unknown; channelPrefix?: unknown; idleMs?: unknown; force?: unknown;
      };
      const opts: Parameters<typeof sweepSessions>[0] = {};
      if (typeof channel === 'string' && channel.length <= 64) opts.channel = channel;
      if (typeof channelPrefix === 'string' && channelPrefix.length <= 64) opts.channelPrefix = channelPrefix;
      if (typeof idleMs === 'number' && Number.isFinite(idleMs) && idleMs >= 0) opts.idleMs = idleMs;
      if (typeof force === 'boolean') opts.force = force;
      const result = sweepSessions(opts);
      res.json({ ok: true, ...result });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name || typeof name !== 'string') { res.status(400).json({ error: 'name is required' }); return; }
      const ok = renameSession(req.params.id, name);
      if (!ok) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json({ ok: true });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // v5.0: Steer
  router.post('/:id/steer', async (req, res) => {
    try {
      const { message } = req.body as { message?: string };
      if (!message || typeof message !== 'string') { res.status(400).json({ error: 'message is required' }); return; }
      const { pushSteer } = await import('../../agent/agentLoop.js');
      pushSteer(req.params.id, message);
      res.json({ ok: true, sessionId: req.params.id });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // v5.0: Checkpoints
  router.get('/:id/checkpoints', async (req, res) => {
    try {
      const { listCheckpoints } = await import('../../checkpoint/manager.js');
      const checkpoints = listCheckpoints(req.params.id);
      res.json({ checkpoints });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/:id/checkpoints/:checkpointId/restore', async (req, res) => {
    try {
      const { restoreCheckpoint } = await import('../../checkpoint/manager.js');
      const result = restoreCheckpoint(req.params.id, req.params.checkpointId);
      res.json({ ok: result.success, restored: result.restored, errors: result.errors });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // v5.0: Abort
  router.post('/:id/abort', (req, res) => {
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

  return router;
}
