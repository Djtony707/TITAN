/**
 * Files Router
 *
 * Extracted from gateway/server.ts v5.5.0.
 */

import { Router } from 'express';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import fs from 'fs';
import logger from '../../utils/logger.js';
import { loadConfig } from '../../config/config.js';

const COMPONENT = 'FilesRouter';

function getFileRoots(): Array<{ label: string; path: string }> {
  const cfg = loadConfig();
  const fmCfg = (cfg as Record<string, unknown>).fileManager as { roots?: string[]; blockedPatterns?: string[] } | undefined;
  const roots = fmCfg?.roots || ['~/.titan'];
  return roots.map(r => {
    const expanded = r.replace(/^~/, homedir());
    const abs = resolve(expanded);
    const label = abs.split('/').filter(Boolean).pop() || abs;
    return { label, path: abs };
  });
}

function validateFilePath(reqPath: string, rootParam?: string): { valid: boolean; fullPath: string; basePath: string; error?: string } {
  const roots = getFileRoots();
  if (roots.length === 0) return { valid: false, fullPath: '', basePath: '', error: 'No file roots configured' };

  let selectedRoot = roots[0];
  if (rootParam) {
    const byIndex = roots[parseInt(rootParam, 10)];
    const byLabel = roots.find(r => r.label === rootParam || r.path === rootParam);
    selectedRoot = byIndex || byLabel || roots[0];
  }

  const basePath = selectedRoot.path;
  const fullPath = resolve(basePath, reqPath.replace(/^\//, ''));

  const basePathWithSep = basePath.endsWith('/') ? basePath : basePath + '/';
  if (fullPath !== basePath && !fullPath.startsWith(basePathWithSep)) {
    return { valid: false, fullPath, basePath, error: 'Access denied: path outside allowed root' };
  }

  const cfg = loadConfig();
  const fmCfg = (cfg as Record<string, unknown>).fileManager as { blockedPatterns?: string[] } | undefined;
  const blocked = fmCfg?.blockedPatterns || ['.ssh', '.env', '.aws', '.gnupg', 'node_modules', '.git/objects'];
  for (const pattern of blocked) {
    if (fullPath.includes(`/${pattern}`) || fullPath.endsWith(`/${pattern}`)) {
      return { valid: false, fullPath, basePath, error: `Access denied: blocked pattern "${pattern}"` };
    }
  }

  return { valid: true, fullPath, basePath };
}

export function createFilesRouter(): Router {
  const router = Router();
  const UPLOADS_DIR = join(homedir(), '.titan', 'uploads');

  router.get('/roots', (_req, res) => {
    res.json({ roots: getFileRoots() });
  });

  router.get('/', (req, res) => {
    const reqPath = (req.query.path as string) || '';
    const rootParam = req.query.root as string | undefined;
    const { valid, fullPath, basePath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'Path not found' }); return; }
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) { res.status(400).json({ error: 'Not a directory. Use /api/files/read for files.' }); return; }

      const entries = fs.readdirSync(fullPath).map(name => {
        try {
          const entryPath = join(fullPath, name);
          const entryStat = fs.statSync(entryPath);
          return {
            name,
            path: reqPath ? `${reqPath}/${name}` : name,
            type: entryStat.isDirectory() ? 'directory' as const : 'file' as const,
            size: entryStat.size,
            modified: entryStat.mtime.toISOString(),
          };
        } catch {
          return { name, path: reqPath ? `${reqPath}/${name}` : name, type: 'file' as const, size: 0, modified: '' };
        }
      });
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: reqPath || '/', entries, basePath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/read', (req, res) => {
    const reqPath = req.query.path as string;
    if (!reqPath) { res.status(400).json({ error: 'path parameter required' }); return; }
    const rootParam = req.query.root as string | undefined;
    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'File not found' }); return; }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) { res.status(400).json({ error: 'Path is a directory' }); return; }

      const MAX_SIZE = 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, MAX_SIZE);
        res.json({ path: reqPath, content, truncated: true, size: stat.size, modified: stat.mtime.toISOString() });
        return;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      res.json({ path: reqPath, content, truncated: false, size: stat.size, modified: stat.mtime.toISOString() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/write', (req, res) => {
    const { path: reqPath, content, root: rootParam } = req.body as { path?: string; content?: string; root?: string };
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }
    if (content === undefined) { res.status(400).json({ error: 'content required' }); return; }

    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      const dir = dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      const stat = fs.statSync(fullPath);
      res.json({ success: true, path: reqPath, size: stat.size, modified: stat.mtime.toISOString() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/mkdir', (req, res) => {
    const { path: reqPath, root: rootParam } = req.body as { path?: string; root?: string };
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }

    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (fs.existsSync(fullPath)) { res.status(409).json({ error: 'Path already exists' }); return; }
      fs.mkdirSync(fullPath, { recursive: true });
      res.json({ success: true, path: reqPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/rename', (req, res) => {
    const { oldPath, newPath, root: rootParam } = req.body as { oldPath?: string; newPath?: string; root?: string };
    if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }

    const oldValidation = validateFilePath(oldPath, rootParam);
    const newValidation = validateFilePath(newPath, rootParam);
    if (!oldValidation.valid) { res.status(403).json({ error: oldValidation.error }); return; }
    if (!newValidation.valid) { res.status(403).json({ error: newValidation.error }); return; }

    try {
      if (!fs.existsSync(oldValidation.fullPath)) { res.status(404).json({ error: 'Source not found' }); return; }
      if (fs.existsSync(newValidation.fullPath)) { res.status(409).json({ error: 'Destination already exists' }); return; }
      fs.renameSync(oldValidation.fullPath, newValidation.fullPath);
      res.json({ success: true, oldPath, newPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/delete', (req, res) => {
    const reqPath = req.query.path as string;
    const rootParam = req.query.root as string | undefined;
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }

    const { valid, fullPath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }

    try {
      if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'Not found' }); return; }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const contents = fs.readdirSync(fullPath);
        if (contents.length > 0) { res.status(400).json({ error: 'Directory not empty. Delete contents first.' }); return; }
        fs.rmdirSync(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
      res.json({ success: true, path: reqPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Upload
  router.post('/upload', (req, res) => {
    try {
      const fileName = (req.headers['x-filename'] as string) || `upload-${Date.now()}`;
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      const sessionId = (req.headers['x-session-id'] as string) || 'default';

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      if (!body || body.length === 0) { res.status(400).json({ error: 'Empty upload body' }); return; }

      const sessionDir = join(UPLOADS_DIR, sessionId);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      const filePath = join(sessionDir, safeName);
      fs.writeFileSync(filePath, body);

      const stat = fs.statSync(filePath);
      logger.info(COMPONENT, `File uploaded: ${safeName} (${(stat.size / 1024).toFixed(0)}KB) \u2192 session ${sessionId}`);

      res.json({ ok: true, file: { name: safeName, path: filePath, size: stat.size, session: sessionId, uploadedAt: new Date().toISOString() } });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/uploads', (req, res) => {
    try {
      const sessionId = (req.query.session as string) || 'default';
      const sessionDir = join(UPLOADS_DIR, sessionId);
      if (!fs.existsSync(sessionDir)) { res.json({ files: [] }); return; }

      const files = fs.readdirSync(sessionDir).map(name => {
        const stat = fs.statSync(join(sessionDir, name));
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      });
      res.json({ files, session: sessionId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/uploads/:name', (req, res) => {
    try {
      const sessionId = (req.query.session as string) || 'default';
      const filePath = join(UPLOADS_DIR, sessionId, req.params.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
      if (!filePath.startsWith(UPLOADS_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
