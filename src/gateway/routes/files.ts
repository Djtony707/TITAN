/**
 * Files Router
 *
 * Extracted from gateway/server.ts v5.5.0.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { homedir } from 'os';
import { join, relative, resolve } from 'path';
import logger from '../../utils/logger.js';
import { loadConfig } from '../../config/config.js';
import { listEditedFiles, readEditedFileContent } from '../../agent/editedFiles.js';
import { runConfinedFileOperation } from '../../security/confinedFiles.js';
import type { FileOperationResult } from '../../security/confinedFiles.js';

const COMPONENT = 'FilesRouter';

function uploadSessionId(value: unknown): string | null {
  if (value === undefined) return 'default';
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) ? value : null;
}

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
  if (typeof reqPath !== 'string' || reqPath.includes('\0') || (rootParam !== undefined && typeof rootParam !== 'string')) {
    return { valid: false, fullPath: '', basePath: '', error: 'Invalid file path' };
  }
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

function failed(res: Response, result: FileOperationResult): boolean {
  if (result.ok) return false;
  res.status(result.status ?? 500).json({ error: result.error ?? 'File operation failed' });
  return true;
}

export function createFilesRouter(): Router {
  const router = Router();
  // Anchor uploads at the trusted home, so an uploads/session symlink is never a trusted root.
  const uploadHome = homedir();
  const uploadPath = (session: string, name?: string) => join('.titan', 'uploads', session, ...(name ? [name] : []));

  router.get('/edited', (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 1000);
    res.json({ files: listEditedFiles(limit) });
  });

  router.get('/content', (req, res) => {
    const filePath = req.query.path;
    if (typeof filePath !== 'string' || !filePath) { res.status(400).json({ error: 'path parameter required' }); return; }
    const result = readEditedFileContent(filePath);
    if ('error' in result) { res.status(404).json(result); return; }
    res.json(result);
  });

  router.get('/roots', (_req, res) => {
    res.json({ roots: getFileRoots() });
  });

  router.get('/', (req, res) => {
    const reqPath = (req.query.path as string) || '';
    const { valid, fullPath, basePath, error } = validateFilePath(reqPath, req.query.root as string | undefined);
    if (!valid) { res.status(403).json({ error }); return; }
    const result = runConfinedFileOperation(basePath, { operation: 'list', path: relative(basePath, fullPath) });
    if (failed(res, result)) return;
    const entries = (result.entries ?? []).map(entry => ({ ...entry, path: reqPath ? `${reqPath}/${entry.name}` : entry.name }));
    entries.sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name));
    res.json({ path: reqPath || '/', entries, basePath });
  });

  router.get('/read', (req, res) => {
    const reqPath = req.query.path as string;
    if (!reqPath) { res.status(400).json({ error: 'path parameter required' }); return; }
    const { valid, fullPath, basePath, error } = validateFilePath(reqPath, req.query.root as string | undefined);
    if (!valid) { res.status(403).json({ error }); return; }
    const result = runConfinedFileOperation(basePath, { operation: 'read', path: relative(basePath, fullPath) });
    if (failed(res, result)) return;
    res.json({ path: reqPath, content: Buffer.from(result.dataBase64!, 'base64').toString('utf8'), truncated: result.truncated, size: result.size, modified: result.modified });
  });

  router.post('/write', (req, res) => {
    const { path: reqPath, content, root: rootParam } = (req.body ?? {}) as { path?: string; content?: string; root?: string };
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }
    if (typeof content !== 'string') { res.status(400).json({ error: 'string content required' }); return; }
    const { valid, fullPath, basePath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }
    const result = runConfinedFileOperation(basePath, { operation: 'write', path: relative(basePath, fullPath), dataBase64: Buffer.from(content).toString('base64') });
    if (failed(res, result)) return;
    res.json({ success: true, path: reqPath, size: result.size, modified: result.modified });
  });

  router.post('/mkdir', (req, res) => {
    const { path: reqPath, root: rootParam } = (req.body ?? {}) as { path?: string; root?: string };
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }
    const { valid, fullPath, basePath, error } = validateFilePath(reqPath, rootParam);
    if (!valid) { res.status(403).json({ error }); return; }
    const result = runConfinedFileOperation(basePath, { operation: 'mkdir', path: relative(basePath, fullPath) });
    if (failed(res, result)) return;
    res.json({ success: true, path: reqPath });
  });

  router.post('/rename', (req, res) => {
    const { oldPath, newPath, root: rootParam } = (req.body ?? {}) as { oldPath?: string; newPath?: string; root?: string };
    if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }
    const oldValidation = validateFilePath(oldPath, rootParam);
    const newValidation = validateFilePath(newPath, rootParam);
    if (!oldValidation.valid) { res.status(403).json({ error: oldValidation.error }); return; }
    if (!newValidation.valid) { res.status(403).json({ error: newValidation.error }); return; }
    const result = runConfinedFileOperation(oldValidation.basePath, { operation: 'rename', path: relative(oldValidation.basePath, oldValidation.fullPath), newPath: relative(newValidation.basePath, newValidation.fullPath) });
    if (failed(res, result)) return;
    res.json({ success: true, oldPath, newPath });
  });

  router.delete('/delete', (req, res) => {
    const reqPath = req.query.path as string;
    if (!reqPath) { res.status(400).json({ error: 'path required' }); return; }
    const { valid, fullPath, basePath, error } = validateFilePath(reqPath, req.query.root as string | undefined);
    if (!valid) { res.status(403).json({ error }); return; }
    const result = runConfinedFileOperation(basePath, { operation: 'delete', path: relative(basePath, fullPath) });
    if (failed(res, result)) return;
    res.json({ success: true, path: reqPath });
  });

  router.post('/upload', (req, res) => {
    const fileName = req.headers['x-filename'] ?? `upload-${Date.now()}`;
    if (typeof fileName !== 'string') { res.status(400).json({ error: 'Invalid filename' }); return; }
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    if (!safeName || safeName === '.' || safeName === '..') { res.status(400).json({ error: 'Invalid filename' }); return; }
    const sessionId = uploadSessionId(req.headers['x-session-id']);
    if (sessionId === null) { res.status(400).json({ error: 'Invalid upload session' }); return; }
    if (req.body === undefined) { res.status(400).json({ error: 'Empty upload body' }); return; }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    if (body.length === 0) { res.status(400).json({ error: 'Empty upload body' }); return; }
    const path = uploadPath(sessionId, safeName);
    const result = runConfinedFileOperation(uploadHome, { operation: 'write', path, dataBase64: body.toString('base64') });
    if (failed(res, result)) return;
    logger.info(COMPONENT, `File uploaded: ${safeName} (${(result.size! / 1024).toFixed(0)}KB) → session ${sessionId}`);
    res.json({ ok: true, file: { name: safeName, path: join(uploadHome, path), size: result.size, session: sessionId, uploadedAt: new Date().toISOString() } });
  });

  router.get('/uploads', (req, res) => {
    const sessionId = uploadSessionId(req.query.session);
    if (sessionId === null) { res.status(400).json({ error: 'Invalid upload session' }); return; }
    const result = runConfinedFileOperation(uploadHome, { operation: 'list', path: uploadPath(sessionId) });
    if (!result.ok && result.status === 404) { res.json({ files: [], session: sessionId }); return; }
    if (failed(res, result)) return;
    const files = (result.entries ?? []).filter(entry => entry.type === 'file').map(({ name, size, modified }) => ({ name, size, modified }));
    res.json({ files, session: sessionId });
  });

  router.delete('/uploads/:name', (req, res) => {
    const sessionId = uploadSessionId(req.query.session);
    if (sessionId === null) { res.status(400).json({ error: 'Invalid upload session' }); return; }
    const name = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!name || name === '.' || name === '..' || name.length > 100) { res.status(400).json({ error: 'Invalid filename' }); return; }
    const result = runConfinedFileOperation(uploadHome, { operation: 'delete', path: uploadPath(sessionId, name) });
    if (!result.ok && result.status !== 404 && failed(res, result)) return;
    res.json({ ok: true });
  });

  return router;
}
