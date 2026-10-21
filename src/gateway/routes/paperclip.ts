/**
 * Gateway sub-router for /api/paperclip/* and /paperclip/* routes.
 *
 * Extracted from src/gateway/server.ts to decompose the gateway monolith
 * and make the Paperclip sidecar API surface independently testable.
 *
 * Routes:
 *   GET  /api/paperclip/status
 *   POST /api/paperclip/start
 *   POST /api/paperclip/stop
 *   POST /api/paperclip/reset
 *   ALL  /api/paperclip/*        → proxy to Paperclip API
 *   ALL  /paperclip/*            → proxy to Paperclip web UI
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { startPaperclip, stopPaperclip, getPaperclipStatus } from '../../addons/paperclipSidecar.js';
import logger from '../../utils/logger.js';
import { titanEvents } from '../../agent/daemon.js';

const COMPONENT = 'Gateway:Paperclip';
const PAPERCLIP_PORT = 3100;
const PRIVATE_OR_HOP_HEADERS = new Set([
  'host', 'authorization', 'cookie', 'proxy-authorization', 'referer',
  'x-original-url', 'x-original-uri', 'x-rewrite-url', 'x-forwarded-uri', 'x-forwarded-url',
  'connection', 'proxy-connection', 'keep-alive', 'content-length', 'transfer-encoding', 'te', 'trailer', 'upgrade',
]);

/** The gateway credential authenticates TITAN only, not a sidecar or its redirect target. */
function sidecarHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value && !PRIVATE_OR_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, Array.isArray(value) ? value[0] : value);
    }
  }
  return headers;
}

function sidecarQuery(req: Request): string {
  const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
  query.delete('token');
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export function createPaperclipRouter(): Router {
  const router = Router();

  // ── Management routes ──

  router.get('/status', async (_req, res) => {
    try {
      res.json(await getPaperclipStatus());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/start', async (_req, res) => {
    try {
      await startPaperclip({ enabled: true, port: PAPERCLIP_PORT, autoStart: true }, titanEvents);
      res.json({ ok: true });
    } catch (err) {
      logger.error(COMPONENT, `Paperclip start failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/stop', async (_req, res) => {
    try {
      await stopPaperclip();
      res.json({ ok: true });
    } catch (err) {
      logger.error(COMPONENT, `Paperclip stop failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/reset', async (_req, res) => {
    try {
      await stopPaperclip();
      await startPaperclip({ enabled: true, port: PAPERCLIP_PORT, autoStart: true }, titanEvents);
      res.json({ ok: true });
    } catch (err) {
      logger.error(COMPONENT, `Paperclip reset failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── API proxy (/api/paperclip/* → http://localhost:3100/api/*) ──

  router.all('/*', async (req: Request, res: Response) => {
    const targetPath = req.path.replace(/^\/api\/paperclip/, '/api');
    const query = sidecarQuery(req);
    const targetUrl = `http://localhost:${PAPERCLIP_PORT}${targetPath}${query}`;

    try {
      const headers = sidecarHeaders(req);

      const upstream = await fetch(targetUrl, {
        method: req.method,
        redirect: 'error',
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });

      res.status(upstream.status);
      upstream.headers.forEach((v, k) => res.setHeader(k, v));
      const body = await upstream.arrayBuffer();
      res.end(Buffer.from(body));
    } catch (err) {
      logger.error(COMPONENT, `Paperclip API proxy error: ${(err as Error).message}`);
      res.status(502).json({ error: 'Paperclip API proxy error', message: (err as Error).message });
    }
  });

  return router;
}

// ── Web UI proxy (/paperclip/* → http://localhost:3100/*) ──

export function createPaperclipUIRouter(): Router {
  const router = Router();

  router.all('/*', async (req: Request, res: Response) => {
    const targetPath = req.path.replace(/^\/paperclip/, '') || '/';
    const query = sidecarQuery(req);
    const targetUrl = `http://localhost:${PAPERCLIP_PORT}${targetPath}${query}`;

    try {
      const headers = sidecarHeaders(req);

      const upstream = await fetch(targetUrl, {
        method: req.method,
        redirect: 'error',
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      });

      res.status(upstream.status);
      upstream.headers.forEach((v, k) => res.setHeader(k, v));
      const body = await upstream.arrayBuffer();
      res.end(Buffer.from(body));
    } catch (err) {
      logger.error(COMPONENT, `Paperclip UI proxy error: ${(err as Error).message}`);
      res.status(502).json({ error: 'Paperclip UI proxy error', message: (err as Error).message });
    }
  });

  return router;
}
