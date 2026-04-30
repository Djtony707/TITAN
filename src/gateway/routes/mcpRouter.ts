/**
 * MCP Router
 *
 * Extracted from gateway/server.ts.
 * Consolidates MCP server status, client management, and presets routes.
 */

import { Router } from 'express';
import { listMcpServers, addMcpServer, removeMcpServer, setMcpServerEnabled, getMcpStatus, BUILTIN_PRESETS } from '../../mcp/registry.js';
import { connectMcpServer, testMcpServer } from '../../mcp/client.js';
import { getMcpServerStatus } from '../../mcp/server.js';

export function createMcpRouter(): Router {
  const router = Router();

  // MCP server status
  router.get('/mcp/server', (_req, res) => {
    res.json(getMcpServerStatus());
  });

  // MCP client management
  router.get('/mcp/clients', (_req, res) => {
    const servers = listMcpServers();
    const status = getMcpStatus();
    const merged = servers.map(s => {
      const live = status.find(st => st.server.id === s.id);
      return { ...s, status: live?.status || 'disconnected', toolCount: live?.toolCount || 0 };
    });
    res.json({ servers: merged });
  });

  router.post('/mcp/clients', async (req, res) => {
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

  router.delete('/mcp/clients/:id', (req, res) => {
    try {
      removeMcpServer(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/mcp/clients/:id/toggle', (req, res) => {
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

  router.post('/mcp/clients/:id/test', async (req, res) => {
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

  router.get('/mcp/presets', (_req, res) => {
    res.json({ presets: BUILTIN_PRESETS });
  });

  return router;
}
