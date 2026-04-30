/**
 * Mesh Router + Misc Routes
 *
 * Extracted from gateway/server.ts.
 * Consolidates /api/mesh/* and several miscellaneous endpoints.
 */

import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { loadavg, cpus } from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { loadConfig } from '../../config/config.js';
import { TITAN_VERSION, TITAN_WORKSPACE, TITAN_HOME } from '../../utils/constants.js';
import logger from '../../utils/logger.js';
import { listEntities, getEntity, getGraphData, getEntityEpisodes } from '../../memory/graph.js';

const COMPONENT = 'MeshRouter';

/** Get normalized CPU load (0.0–1.0) using 1-minute load average */
function getCpuLoad(): number {
    const avg = loadavg()[0]; // 1-minute load average
    const cores = cpus().length || 1;
    return Math.min(1, avg / cores);
}

export function createMeshRouter(broadcast: (data: Record<string, unknown>, userId?: string) => void): Router {
  const router = Router();

  // ── Mesh Networking Endpoints ─────────────────────────────────
  router.get('/mesh/hello', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ titan: false, enabled: false }); return; }
    const { getOrCreateNodeId } = await import('../../mesh/identity.js');
    const { getActiveRemoteTaskCount } = await import('../../mesh/transport.js');
    const { discoverAllModels: discoverModels } = await import('../../providers/router.js');
    const models = await discoverModels();
    const { listAgents: meshListAgents } = await import('../../agent/multiAgent.js');
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

  router.get('/mesh/peers', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ peers: [], enabled: false }); return; }
    const { getPeers } = await import('../../mesh/discovery.js');
    res.json({ peers: getPeers(), enabled: true });
  });

  router.get('/mesh/models', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ models: [] }); return; }
    const { getMeshModels } = await import('../../mesh/registry.js');
    res.json({ models: getMeshModels() });
  });

  router.get('/mesh/pending', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ pending: [], enabled: false }); return; }
    const { getPendingPeers } = await import('../../mesh/discovery.js');
    res.json({ pending: getPendingPeers(), enabled: true });
  });

  router.post('/mesh/approve/:nodeId', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.status(400).json({ error: 'Mesh not enabled' }); return; }
    const { approvePeer } = await import('../../mesh/discovery.js');
    const peer = approvePeer(req.params.nodeId);
    if (peer) {
      broadcast({ type: 'mesh_peer_approved', peer });
      res.json({ approved: true, peer });
    } else {
      res.status(404).json({ error: 'Peer not found in pending list or at max capacity' });
    }
  });

  router.post('/mesh/reject/:nodeId', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.status(400).json({ error: 'Mesh not enabled' }); return; }
    const { rejectPeer } = await import('../../mesh/discovery.js');
    const rejected = rejectPeer(req.params.nodeId);
    res.json({ rejected });
  });

  router.post('/mesh/revoke/:nodeId', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.status(400).json({ error: 'Mesh not enabled' }); return; }
    const { revokePeer } = await import('../../mesh/discovery.js');
    const revoked = revokePeer(req.params.nodeId);
    if (revoked) {
      broadcast({ type: 'mesh_peer_revoked', nodeId: req.params.nodeId });
    }
    res.json({ revoked });
  });

  // ── Mesh Health / Status Endpoint ─────────────────────────────
  router.get('/mesh/status', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ enabled: false, status: 'disabled' }); return; }

    const { getOrCreateNodeId } = await import('../../mesh/identity.js');
    const { getPeers, getPendingPeers } = await import('../../mesh/discovery.js');
    const { getConnectedPeerCount } = await import('../../mesh/transport.js');
    const { getOrCreateNodeId: localNodeId } = await import('../../mesh/identity.js');

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
  router.get('/mesh/routes', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.mesh.enabled) { res.json({ enabled: false, routes: [] }); return; }
    const { getRoutingTable } = await import('../../mesh/transport.js');
    res.json({ routes: getRoutingTable() });
  });

  // ── Homelab machine health (v4.8.4) ───────────────────────────
  router.get('/homelab/machines', async (_req, res) => {
    try {
      const cfg = loadConfig() as unknown as {
        homelab?: { machines?: Array<{ name: string; ip: string; role?: string; port?: number; protocol?: 'http' | 'https'; path?: string }> };
      };
      const machines = cfg.homelab?.machines ?? [
        { name: 'Titan PC', ip: '192.168.1.11', role: 'Primary GPU (RTX 5090)', port: 48420, protocol: 'https' as const, path: '/api/health' },
        { name: 'Mini PC', ip: '192.168.1.95', role: 'Docker Host', port: 48420, protocol: 'https' as const, path: '/api/health' },
        { name: 'T610 Server', ip: '192.168.1.67', role: 'Always-on Backbone', port: 48420, protocol: 'https' as const, path: '/api/health' },
      ];
      const https = await import('https');
      const http = await import('http');
      const probe = (protocol: 'http' | 'https', ip: string, port: number, path: string): Promise<{ ok: boolean; body: string; latencyMs: number }> => {
        return new Promise((resolve, reject) => {
          const started = Date.now();
          const lib = protocol === 'https' ? https : http;
          const req = lib.request({
            host: ip,
            port,
            path,
            method: 'GET',
            timeout: 3000,
            ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
          }, (r) => {
            let body = '';
            r.on('data', (c) => body += c);
            r.on('end', () => resolve({ ok: (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 400, body, latencyMs: Date.now() - started }));
          });
          req.on('timeout', () => { req.destroy(new Error('timeout')); });
          req.on('error', reject);
          req.end();
        });
      };
      const results = await Promise.all(machines.map(async (m) => {
        const protocol = m.protocol ?? 'https';
        const port = m.port ?? 48420;
        const path = m.path ?? '/api/health';
        const started = Date.now();
        try {
          const r = await probe(protocol, m.ip, port, path);
          let version: string | undefined;
          try {
            const parsed = JSON.parse(r.body) as { version?: string };
            version = parsed?.version;
          } catch { /* not JSON — still online */ }
          return { name: m.name, ip: m.ip, role: m.role ?? '', online: r.ok, latencyMs: r.latencyMs, version };
        } catch (err) {
          return { name: m.name, ip: m.ip, role: m.role ?? '', online: false, latencyMs: Date.now() - started, error: (err as Error).message };
        }
      }));
      res.json({ machines: results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Dependency Scan API ────────────────────────────────────────
  router.get('/dependencies/scan', async (_req, res) => {
    try {
      const reportPath = join(TITAN_WORKSPACE, 'dependency-scan-report.json');
      if (fs.existsSync(reportPath)) {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        res.json(report);
      } else {
        res.status(404).json({ error: 'No scan report found. Run a scan first.' });
      }
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.post('/dependencies/scan', async (req, res) => {
    try {
      const { fix = false } = req.body;
      const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/dependency-scan.cjs');

      const proc = spawn('node', [scriptPath, ...(fix ? ['--fix'] : [])], {
        cwd: TITAN_WORKSPACE,
        stdio: 'pipe',
        detached: false,
      });

      let output = '';
      proc.stdout?.on('data', (data) => { output += data.toString(); });
      proc.stderr?.on('data', (data) => { output += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          logger.info(COMPONENT, 'Dependency scan completed successfully');
        } else {
          logger.warn(COMPONENT, `Dependency scan exited with code ${code}`);
        }
      });

      res.json({ success: true, message: 'Dependency scan started in background' });
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  router.get('/dependencies/status', (_req, res) => {
    try {
      const reportPath = join(TITAN_WORKSPACE, 'dependency-scan-report.json');
      if (fs.existsSync(reportPath)) {
        const stats = fs.statSync(reportPath);
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

        const summary = {
          lastScan: report.timestamp,
          lastScanAge: Date.now() - new Date(report.timestamp).getTime(),
          vulnerabilities: report.vulnerabilities.total,
          critical: report.vulnerabilities.critical,
          high: report.vulnerabilities.high,
          outdated: report.outdated?.length || 0,
          deprecated: report.deprecated?.length || 0,
          licenseIssues: report.licenseIssues?.length || 0,
          health: report.vulnerabilities.critical === 0 && report.vulnerabilities.high === 0 ? 'healthy' : 'warning',
        };

        res.json(summary);
      } else {
        res.json({
          lastScan: null,
          health: 'unknown',
          message: 'No scan has been run yet',
        });
      }
    } catch (e) {
      logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' });
    }
  });

  // Memory Wiki API — browseable knowledge base
  router.get('/wiki/entities', (req, res) => {
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
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/wiki/entity/:name', (req, res) => {
    try {
      const entity = getEntity(decodeURIComponent(req.params.name));
      if (!entity) { res.status(404).json({ error: 'Entity not found' }); return; }
      const graphData = getGraphData();
      const relatedEdges = graphData.edges.filter(e => e.from === entity.id || e.to === entity.id);
      const relatedIds = new Set(relatedEdges.map(e => e.from === entity.id ? e.to : e.from));
      const related = graphData.nodes.filter(n => relatedIds.has(n.id)).map(n => ({
        id: n.id,
        name: n.label,
        type: n.type,
        relation: relatedEdges.find(e => (e.from === entity.id && e.to === n.id) || (e.to === entity.id && e.from === n.id))?.label || 'co_mentioned',
      }));
      const episodes = getEntityEpisodes(entity.id, 20).map(ep => ({
        id: ep.id,
        content: ep.content.slice(0, 300),
        source: ep.source,
        createdAt: ep.createdAt,
      }));
      res.json({ ...entity, related, episodes });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // Agent Templates (marketplace)
  router.get('/agent-templates', async (_req, res) => {
    try {
      const { listTemplates, BUILTIN_TEMPLATES } = await import('../../skills/agentTemplates.js');
      const installed = listTemplates();
      res.json({ builtin: BUILTIN_TEMPLATES, installed });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/agent-templates', async (req, res) => {
    try {
      const { saveTemplate } = await import('../../skills/agentTemplates.js');
      saveTemplate(req.body);
      res.json({ success: true });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // Training data (RL trajectory capture)
  router.get('/training/stats', async (_req, res) => {
    try {
      const { getTrainingStats } = await import('../../agent/trajectoryCapture.js');
      res.json(getTrainingStats());
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/training/export', async (_req, res) => {
    try {
      const { exportTrainingData } = await import('../../agent/trajectoryCapture.js');
      res.setHeader('Content-Type', 'application/jsonl');
      res.setHeader('Content-Disposition', 'attachment; filename="titan-training-data.jsonl"');
      res.send(exportTrainingData());
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // Dreaming memory (sleep-cycle consolidation)
  router.get('/dreaming/status', async (_req, res) => {
    try {
      const { getDreamingStatus } = await import('../../memory/dreaming.js');
      res.json(getDreamingStatus());
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/dreaming/run', async (_req, res) => {
    try {
      const { runConsolidation } = await import('../../memory/dreaming.js');
      const result = await runConsolidation();
      res.json({ success: true, ...result });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/dreaming/history', async (_req, res) => {
    try {
      const { getConsolidationHistory } = await import('../../memory/dreaming.js');
      res.json(getConsolidationHistory());
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  // Backup system
  router.post('/backup/create', async (_req, res) => {
    try {
      const { createBackup } = await import('../../storage/backup.js');
      const info = await createBackup();
      res.json({ success: true, ...info });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/backup/list', async (_req, res) => {
    try {
      const { listBackups } = await import('../../storage/backup.js');
      res.json({ backups: listBackups() });
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.post('/backup/verify', async (req, res) => {
    try {
      const { verifyBackup, listBackups } = await import('../../storage/backup.js');
      const path = req.body?.path || listBackups()[0]?.path;
      if (!path) { res.status(400).json({ error: 'No backup path specified and no backups found' }); return; }
      const result = await verifyBackup(path);
      res.json(result);
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  return router;
}
