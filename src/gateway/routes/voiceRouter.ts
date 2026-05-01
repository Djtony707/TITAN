/**
 * Voice Router
 *
 * Extracted from gateway/server.ts v5.5.0.
 * Accepts rate-limit / concurrency guards via factory to avoid tight coupling.
 */

import { Router, type Request, type Response } from 'express';
import { homedir } from 'os';
import { join, dirname } from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';
import { processMessage, routeMessage } from '../../agent/agent.js';

const COMPONENT = 'VoiceRouter';

const VOICE_POISON_PATTERNS = [
  /i completed the tool operations/i,
  /i wasn't able to execute tools/i,
  /i completed the operations/i,
  /let me know if you need anything else\.?\s*$/i,
];
const F5_TTS_DEFAULT_VOICES = ['andrew'];
const F5_TTS_PORT = 5006;
const F5_TTS_MODEL = 'f5-tts-mlx';

interface Guard {
  (windowMs: number, maxRequests: number): (req: Request, res: Response, next: import('express').NextFunction) => void;
}

export function createVoiceRouter(
  sessionAborts: Map<string, AbortController>,
  sessionAbortTimes: Map<string, number>,
  rateLimit?: Guard,
  concurrencyGuard?: (maxConcurrent: number) => (req: Request, res: Response, next: import('express').NextFunction) => void,
  // Optional metrics for voice stream
  activeLlmRequestsRef?: { value: number },
  titanActiveSessions?: { inc: () => void; dec: () => void },
  titanRequestDuration?: { observe: (v: number, labels: Record<string, string>) => void },
): Router {
  const router = Router();

  let f5ttsPid: number | null = null;

  router.get('/voice/status', async (_req, res) => {
    const cfg = loadConfig();
    const voice = cfg.voice;
    if (!voice.enabled) { res.json({ available: false, reason: 'Voice not enabled in config' }); return; }
    try {
      const livekitHttp = voice.livekitUrl.replace('ws://', 'http://').replace('wss://', 'https://');
      const resp = await fetch(livekitHttp, { signal: AbortSignal.timeout(3000) });
      res.json({ available: resp.ok, livekitUrl: voice.livekitUrl, ttsVoice: voice.ttsVoice });
    } catch {
      res.json({ available: false, livekitUrl: voice.livekitUrl, reason: 'LiveKit server unreachable' });
    }
  });

  router.get('/voice/config', (_req, res) => {
    res.json(loadConfig().voice);
  });

  router.post('/livekit/token', async (req, res) => {
    const cfg = loadConfig();
    if (!cfg.voice?.enabled) { res.status(404).json({ error: 'Voice not enabled' }); return; }
    if (!cfg.voice.livekitApiKey || !cfg.voice.livekitApiSecret) {
      res.status(503).json({ error: 'LiveKit not configured' }); return;
    }
    try {
      const livekitSdk: any = await import('livekit-server-sdk').catch(() => null);
      if (!livekitSdk?.AccessToken) { res.status(503).json({ error: 'livekit-server-sdk not installed' }); return; }
      const { AccessToken } = livekitSdk;
      const participantIdentity = `voice_user_${Math.floor(Math.random() * 10_000)}`;
      const roomName = `voice_room_${Math.floor(Math.random() * 10_000)}`;
      const at = new AccessToken(cfg.voice.livekitApiKey, cfg.voice.livekitApiSecret, { identity: participantIdentity, name: 'user', ttl: '15m' });
      at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canPublishData: true, canSubscribe: true });
      let serverUrl = cfg.voice.livekitUrl;
      try {
        const reqHost = req.hostname || req.headers.host?.split(':')[0];
        if (reqHost) { const parsed = new URL(serverUrl); parsed.hostname = reqHost; serverUrl = parsed.toString().replace(/\/$/, ''); }
      } catch { /* keep original */ }
      res.json({ serverUrl, roomName, participantName: 'user', participantToken: await at.toJwt() });
    } catch (err) {
      logger.error(COMPONENT, `LiveKit token error: ${(err as Error).message}`);
      res.status(500).json({ error: 'Failed to generate LiveKit token' });
    }
  });

  router.get('/voice/health', async (_req, res) => {
    const cfg = loadConfig();
    if (!cfg.voice?.enabled) { res.json({ livekit: false, stt: false, tts: false, agent: false, overall: false, ttsEngine: cfg.voice?.ttsEngine || 'f5-tts' }); return; }
    const engine = cfg.voice.ttsEngine || 'f5-tts';
    const results = { livekit: false, stt: false, tts: false, agent: false, overall: false, ttsEngine: engine };
    const sttUrl = cfg.voice.sttUrl || 'http://localhost:48421';
    const ttsUrl = cfg.voice.ttsUrl || 'http://localhost:5006';
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const asrCfg = nvidia?.asr as Record<string, unknown> | undefined;
    const sttHealthUrl = (cfg.voice.sttEngine || 'faster-whisper') === 'nemotron-asr'
      ? `${(asrCfg?.healthUrl as string) || 'http://localhost:9000'}/v1/health/ready`
      : `${sttUrl}/health`;
    await Promise.allSettled([
      { key: 'livekit' as const, url: cfg.voice.livekitUrl.replace('ws://', 'http://').replace('wss://', 'https://') },
      { key: 'agent' as const, url: cfg.voice.agentUrl },
      { key: 'stt' as const, url: sttHealthUrl },
    ].map(async ({ key, url }) => {
      try { const resp = await fetch(url, { signal: AbortSignal.timeout(3000) }); results[key] = resp.ok || resp.status < 500; }
      catch { results[key] = false; }
    }));
    try {
      let resp = await fetch(`${ttsUrl}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!resp || resp.status >= 400) {
        const voice = cfg.voice.ttsVoice || 'andrew';
        resp = await fetch(`${ttsUrl}/v1/audio/speech`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'f5-tts', input: '.', voice, response_format: 'pcm' }),
          signal: AbortSignal.timeout(10000),
        });
      }
      results.tts = resp ? resp.status < 500 : false;
    } catch { results.tts = false; }
    results.overall = results.tts;
    res.json(results);
  });

  // NVIDIA Health Checks
  router.get('/nvidia/health/cuopt', async (_req, res) => {
    const cfg = loadConfig();
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const cuoptUrl = ((nvidia?.cuopt as Record<string, unknown>)?.url as string) || 'http://localhost:5000';
    try { const resp = await fetch(`${cuoptUrl}/cuopt/health`, { signal: AbortSignal.timeout(5000) }); res.json({ healthy: resp.ok, status: resp.status, url: cuoptUrl }); }
    catch { res.json({ healthy: false, url: cuoptUrl }); }
  });

  router.get('/nvidia/health/asr', async (_req, res) => {
    const cfg = loadConfig();
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const healthUrl = ((nvidia?.asr as Record<string, unknown>)?.healthUrl as string) || 'http://localhost:9000';
    try { const resp = await fetch(`${healthUrl}/v1/health/ready`, { signal: AbortSignal.timeout(5000) }); res.json({ healthy: resp.ok, status: resp.status, url: healthUrl }); }
    catch { res.json({ healthy: false, url: healthUrl }); }
  });

  router.get('/nvidia/health/nim', async (_req, res) => {
    const cfg = loadConfig();
    const nvidia = (cfg as Record<string, unknown>).nvidia as Record<string, unknown> | undefined;
    const apiKey = (nvidia?.apiKey as string) || process.env.NVIDIA_API_KEY || '';
    if (!apiKey) { res.json({ healthy: false, reason: 'No NVIDIA API key configured' }); return; }
    try { const resp = await fetch('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) }); res.json({ healthy: resp.ok, status: resp.status }); }
    catch { res.json({ healthy: false, reason: 'NIM API unreachable' }); }
  });

  // Voice preview
  router.post('/voice/preview', async (req, res) => {
    const cfg = loadConfig();
    const engine = cfg.voice?.ttsEngine || 'f5-tts';
    const voiceId = req.body?.voice || cfg.voice?.ttsVoice || 'andrew';
    const rawText = req.body?.text || 'Hey! I\'m TITAN, your AI assistant.';
    const text = rawText.length > 500 ? rawText.slice(0, 497) + '...' : rawText;
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';
    try {
      const ttsRes = await fetch(`${ttsUrl}/v1/audio/speech`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'f5-tts-mlx', input: text, voice: voiceId, response_format: 'wav' }),
        signal: AbortSignal.timeout(60000),
      });
      if (!ttsRes.ok) { res.status(502).json({ error: `TTS service unavailable`, status: ttsRes.status }); return; }
      res.setHeader('Content-Type', 'audio/wav');
      res.send(Buffer.from(await ttsRes.arrayBuffer()));
    } catch { res.status(502).json({ error: `TTS service unavailable` }); }
  });

  // Voice stream — complex SSE endpoint with sentence chunking
  router.post('/voice/stream',
    rateLimit ? rateLimit(60000, 30) : (_req, _res, next) => next(),
    concurrencyGuard ? concurrencyGuard(10) : (_req, _res, next) => next(),
    async (req, res) => {
    const { content, sessionId: requestedSessionId, voice: reqVoice } = req.body || {};
    if (!content) { res.status(400).json({ error: 'content is required' }); return; }

    const cfg = loadConfig();
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';
    const ttsEngine = cfg.voice?.ttsEngine || 'f5-tts';
    const voiceId = reqVoice || cfg.voice?.ttsVoice || 'andrew';
    const channel = 'voice';
    const userId = 'voice-user';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let clientDisconnected = false;
    res.on('close', () => { clientDisconnected = true; });
    const safeWrite = (data: string) => { if (!clientDisconnected) { try { res.write(data); } catch { clientDisconnected = true; } } };

    const heartbeat = setInterval(() => { if (clientDisconnected) { clearInterval(heartbeat); return; } safeWrite(': heartbeat\n\n'); }, 2000);

    const abortController = new AbortController();
    if (requestedSessionId) { sessionAborts.set(requestedSessionId, abortController); sessionAbortTimes.set(requestedSessionId, Date.now()); }

    let effectiveTtsEngine = ttsEngine;
    const effectiveTtsUrl = ttsUrl;
    const effectiveTtsModel = 'f5-tts-mlx';

    try {
      const probe = await fetch(`${effectiveTtsUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!probe.ok) effectiveTtsEngine = 'unavailable';
    } catch {
      effectiveTtsEngine = 'unavailable';
      logger.warn(COMPONENT, `F5-TTS unreachable at ${effectiveTtsUrl}`);
    }
    safeWrite(`event: tts_mode\ndata: ${JSON.stringify({ engine: effectiveTtsEngine })}\n\n`);

    let tokenBuffer = '';
    let sentenceIndex = 0;
    let firstChunkSent = false;
    let totalTtsChars = 0;
    const FIRST_CHUNK_MIN = 60;
    const MAX_TTS_SENTENCES = 50;
    const MAX_TTS_CHARS = 10000;
    const ttsQueue: Array<{ sentence: string; index: number }> = [];
    let ttsRunning = false;
    let ttsResolve: (() => void) = () => {};
    const ttsAllDone = new Promise<void>(resolve => { ttsResolve = resolve; });
    let ttsFinished = false;

    const processTtsQueue = async () => { if (ttsRunning) return; ttsRunning = true; while (ttsQueue.length > 0) { if (clientDisconnected) break; const item = ttsQueue.shift()!; await fireTTSInternal(item.sentence, item.index); } ttsRunning = false; if (ttsFinished && ttsQueue.length === 0) ttsResolve(); };

    const cleanForVoice = (text: string): string => text
      .replace(/<TOOLCALL>[\s\S]*?(?:<\/TOOLCALL>|$)/g, '')
      .replace(/<TOOLCALL>\[[\s\S]*?\]/g, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/^[-*]\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/<(?:laugh|chuckle|sigh|cough|sniffle|groan|yawn|gasp|smile)>/gi, '')
      .replace(/(?:Let me |I'll |I will |I'm going to )(?:use|call|check|run|invoke|execute|try)(?: the)? \w[\w_]*(?: tool)?(?:\s+(?:to|for|and)\b[^.!?]*)?[.!?]?\s*/gi, '')
      .replace(/\b(?:Using|Calling|Running|Checking|Invoking|Executing) (?:the )?\w[\w_]*(?: tool)?(?:\s+(?:to|for)\b[^.!?]*)?[.!?]?\s*/gi, '')
      .replace(/(\w)\s*—\s*(\w)/g, '$1, $2')
      .replace(/(\w)\s*–\s*(\w)/g, '$1, $2')
      .replace(/;\s*/g, '. ')
      .replace(/\(([^)]+)\)/g, ', $1,')
      .replace(/([a-z]{4,}),\s*(but|yet|so|however|although)\s+/gi, '$1. $2 ')
      .replace(/\.\s*\./g, '.')
      .replace(/,\s*\./g, '.')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const isF5TTS = effectiveTtsEngine === 'f5-tts';
    const f5Sentences: string[] = [];

    const fireTTSInternal = async (sentence: string, index: number) => {
      const clean = cleanForVoice(sentence);
      if (!clean || clean.length < 3) return;
      if (!isF5TTS) safeWrite(`event: sentence\ndata: ${JSON.stringify({ text: clean, index })}\n\n`);
      if (index >= MAX_TTS_SENTENCES || totalTtsChars >= MAX_TTS_CHARS) return;
      totalTtsChars += clean.length;
      try {
        const ttsRes = await fetch(`${effectiveTtsUrl}/v1/audio/speech`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: effectiveTtsModel, input: clean, voice: voiceId, response_format: 'wav' }),
          signal: AbortSignal.timeout(60000),
        });
        if (ttsRes.ok && !clientDisconnected) {
          const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
          safeWrite(`event: audio\ndata: ${JSON.stringify({ index, audio: audioBuffer.toString('base64'), format: 'wav' })}\n\n`);
        }
      } catch (e) { logger.debug('Gateway', `Voice stream TTS failed for sentence ${index}: ${(e as Error).message}`); }
    };

    const flushSentence = (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length < 3) return;
      if (isF5TTS) {
        const clean = cleanForVoice(trimmed);
        if (clean && clean.length >= 3) {
          safeWrite(`event: sentence\ndata: ${JSON.stringify({ text: clean, index: sentenceIndex++ })}\n\n`);
          f5Sentences.push(clean);
        }
        return;
      }
      const idx = sentenceIndex++;
      ttsQueue.push({ sentence: trimmed, index: idx });
      processTtsQueue();
    };

    const activeRef = activeLlmRequestsRef || { value: 0 };
    activeRef.value++;
    if (titanActiveSessions) titanActiveSessions.inc();
    const startTime = process.hrtime.bigint();

    try {
      const response = await routeMessage(content, channel, userId, {
        streamCallbacks: {
          onToken: (token: string) => {
            if (clientDisconnected) return;
            tokenBuffer += token;
            if (!firstChunkSent && tokenBuffer.length >= FIRST_CHUNK_MIN) {
              const lastSpace = tokenBuffer.lastIndexOf(' ');
              if (lastSpace > 30) { flushSentence(tokenBuffer.slice(0, lastSpace)); tokenBuffer = tokenBuffer.slice(lastSpace + 1); firstChunkSent = true; return; }
            }
            if (tokenBuffer.includes('\n')) {
              const lines = tokenBuffer.split('\n');
              tokenBuffer = lines.pop() || '';
              for (const line of lines) { if (line.trim().length >= 3) { flushSentence(line); firstChunkSent = true; } }
              return;
            }
            let match: RegExpMatchArray | null;
            while ((match = tokenBuffer.match(/^(.*?(?<![\d])\b(?:Dr|Mr|Mrs|Ms|vs|etc|e\.g|i\.e))?([.!?])(\s+|$)/s)) !== null) {
              flushSentence(match[1]);
              tokenBuffer = tokenBuffer.slice(match[0].length);
              firstChunkSent = true;
            }
            if (tokenBuffer.length > 80) {
              const colonMatch = tokenBuffer.match(/^(.*?[:;])\s+/s);
              if (colonMatch && colonMatch[1].length > 20) { flushSentence(colonMatch[1]); tokenBuffer = tokenBuffer.slice(colonMatch[0].length); firstChunkSent = true; return; }
            }
            if (tokenBuffer.length > 200) {
              const commaPos = tokenBuffer.lastIndexOf(', ', 180);
              if (commaPos > 40) { flushSentence(tokenBuffer.slice(0, commaPos + 1)); tokenBuffer = tokenBuffer.slice(commaPos + 2); firstChunkSent = true; }
              else { const lastSpace = tokenBuffer.lastIndexOf(' ', 180); if (lastSpace > 50) { flushSentence(tokenBuffer.slice(0, lastSpace)); tokenBuffer = tokenBuffer.slice(lastSpace + 1); firstChunkSent = true; } }
            }
          },
          onToolCall: (name: string) => { safeWrite(`event: tool\ndata: ${JSON.stringify({ name })}\n\n`); },
        },
        signal: abortController.signal,
      });

      if (tokenBuffer.trim()) { flushSentence(tokenBuffer); tokenBuffer = ''; }

      if (isF5TTS && f5Sentences.length > 0) {
        const F5_MAX_CHUNK_CHARS = 600;
        const chunks: string[] = [];
        let current = '';
        for (const s of f5Sentences) {
          if (current && (current.length + s.length + 1) > F5_MAX_CHUNK_CHARS) { chunks.push(current); current = s; } else { current += (current ? ' ' : '') + s; }
        }
        if (current) chunks.push(current);
        let audioIdx = 0;
        for (const chunk of chunks) {
          if (clientDisconnected || totalTtsChars >= MAX_TTS_CHARS) break;
          totalTtsChars += chunk.length;
          try {
            const ttsRes = await fetch(`${effectiveTtsUrl}/v1/audio/speech`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: effectiveTtsModel, input: chunk, voice: voiceId, response_format: 'wav' }),
              signal: AbortSignal.timeout(120000),
            });
            if (ttsRes.ok && !clientDisconnected) {
              const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
              safeWrite(`event: audio\ndata: ${JSON.stringify({ index: audioIdx++, audio: audioBuffer.toString('base64'), format: 'wav' })}\n\n`);
            }
          } catch (e) { logger.debug('Gateway', `F5-TTS chunk ${audioIdx} failed: ${(e as Error).message}`); }
        }
      }

      ttsFinished = true;
      if (!ttsRunning && ttsQueue.length === 0) ttsResolve();
      if (!isF5TTS) await ttsAllDone;

      const responseText = response.content || '';
      if (VOICE_POISON_PATTERNS.some(p => p.test(responseText)) || (response.durationMs > 60000 && responseText.length < 50)) {
        logger.warn(COMPONENT, `[VoicePoisonGuard] Detected canned/stale response — resetting voice session ${response.sessionId}`);
        try { const { closeSession } = await import('../../agent/session.js'); closeSession(response.sessionId); } catch { /* ok */ }
      }

      if (!clientDisconnected) {
        safeWrite(`event: done\ndata: ${JSON.stringify({ sessionId: response.sessionId, model: response.model, durationMs: response.durationMs, toolsUsed: response.toolsUsed, fullText: response.content })}\n\n`);
        try { res.end(); } catch { /* client gone */ }
      }
    } catch (error) {
      if (!clientDisconnected) {
        safeWrite(`event: done\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`);
        try { res.end(); } catch { /* client gone */ }
      }
    } finally {
      clearInterval(heartbeat);
      activeRef.value--;
      if (titanActiveSessions) titanActiveSessions.dec();
      if (titanRequestDuration) titanRequestDuration.observe(Number(process.hrtime.bigint() - startTime) / 1e9, { channel });
      if (requestedSessionId) sessionAborts.delete(requestedSessionId);
    }
  });

  router.get('/voice/voices', async (_req, res) => {
    const cfg = loadConfig();
    const engine = cfg.voice?.ttsEngine || 'f5-tts';
    const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';
    if (engine === 'f5-tts') {
      const voicesDir = join(homedir(), '.titan', 'voices');
      try { const files = fs.existsSync(voicesDir) ? fs.readdirSync(voicesDir).filter(f => f.endsWith('.wav')) : []; res.json({ voices: files.length ? files.map(f => f.replace('.wav', '')) : ['default'], engine: 'f5-tts' }); } catch { res.json({ voices: ['default'], engine: 'f5-tts' }); }
      return;
    }
    try { const ttsRes = await fetch(`${ttsUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(3000) }); if (!ttsRes.ok) throw new Error(); const data = await ttsRes.json() as { voices?: string[] }; res.json({ ...data, engine: 'f5-tts' }); } catch { res.json({ voices: F5_TTS_DEFAULT_VOICES, engine: 'f5-tts' }); }
  });

  router.get('/voice/tts', async (req, res) => {
    try {
      const text = (req.query.text as string || '').slice(0, 2000);
      const voice = (req.query.voice as string) || 'andrew';
      const format = ((req.query.format as string) || 'mp3').toLowerCase();
      if (!text.trim()) { res.status(400).json({ error: 'text required' }); return; }
      const cfg = loadConfig();
      const ttsUrl = cfg.voice?.ttsUrl || 'http://localhost:5006';
      const ttsRes = await fetch(`${ttsUrl}/v1/audio/speech`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, voice, response_format: format }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!ttsRes || !ttsRes.ok) { res.status(502).json({ error: 'tts backends unavailable' }); return; }
      const contentType = ttsRes.headers.get('content-type') || (format === 'wav' ? 'audio/wav' : 'audio/mpeg');
      const buf = Buffer.from(await ttsRes.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/voice/f5tts/status', async (_req, res) => {
    let running = false;
    try { const probe = await fetch(`http://localhost:${F5_TTS_PORT}/health`, { signal: AbortSignal.timeout(3000) }); running = probe.ok; } catch { /* not running */ }
    const voicesDir = join(homedir(), '.titan', 'voices');
    let voices: string[] = [];
    try { if (fs.existsSync(voicesDir)) voices = fs.readdirSync(voicesDir).filter(f => f.endsWith('.wav')).map(f => f.replace('.wav', '')); } catch { /* ignore */ }
    res.json({ installed: true, running, voices, port: F5_TTS_PORT, model: F5_TTS_MODEL });
  });

  router.post('/voice/f5tts/install', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (step: string, status: 'running' | 'done' | 'error', detail?: string) => { res.write(`data: ${JSON.stringify({ step, status, detail })}\n\n`); };
    const venvPath = join(homedir(), '.titan', 'qwen3tts-venv');
    const voicesDir = join(homedir(), '.titan', 'voices');
    try {
      send('venv', 'running', 'Creating Python virtual environment...');
      if (!fs.existsSync(join(venvPath, 'bin', 'python'))) { execSync(`python3 -m venv "${venvPath}"`, { timeout: 60000 }); }
      send('venv', 'done');
      const pip = join(venvPath, 'bin', 'pip');
      send('install', 'running', 'Installing F5-TTS + MLX dependencies (this may take 2-3 minutes)...');
      execSync(`"${pip}" install f5-tts-mlx "mlx-audio[server]" "setuptools<81" numpy`, { timeout: 600000 });
      send('install', 'done');
      if (!fs.existsSync(voicesDir)) fs.mkdirSync(voicesDir, { recursive: true });
      send('start', 'running', 'Starting voice cloning server on port 5006...');
      const python = join(venvPath, 'bin', 'python');
      const serverScript = join(__dirname, '..', '..', 'scripts', 'f5-tts-server.py');
      const scriptPath = fs.existsSync(serverScript) ? serverScript : join(__dirname, '..', '..', '..', 'scripts', 'f5-tts-server.py');
      const child = spawn(python, [scriptPath, '--host', '127.0.0.1', '--port', String(5006)], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
      });
      child.unref();
      f5ttsPid = child.pid ?? null;
      const pidFile = join(homedir(), '.titan', 'f5tts.pid');
      if (child.pid) fs.writeFileSync(pidFile, String(child.pid));
      send('model', 'running', 'Downloading F5-TTS model (~500MB, first time only)...');
      let ready = false;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try { const probe = await fetch(`http://localhost:${5006}/health`, { signal: AbortSignal.timeout(5000) }); if (probe.ok) { ready = true; break; } } catch { /* still loading */ }
      }
      if (ready) { send('model', 'done'); send('complete', 'done', 'Voice cloning server is ready! (F5-TTS)'); }
      else { send('model', 'error', 'Server started but model loading timed out. It may still be downloading — try again in a few minutes.'); }
    } catch (e) { send('error', 'error', (e as Error).message); }
    res.end();
  });

  const stopF5TTSHandler = (_req: Request, res: Response) => {
    const candidates = [join(homedir(), '.titan', 'f5tts.pid'), join(homedir(), '.titan', 'qwen3tts.pid')];
    try {
      for (const pidFile of candidates) {
        if (!fs.existsSync(pidFile)) continue;
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
      }
      f5ttsPid = null;
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: (e as Error).message }); }
  };

  const startF5TTSHandler = async (_req: Request, res: Response) => {
    const venvPath = join(homedir(), '.titan', 'qwen3tts-venv');
    const python = join(venvPath, 'bin', 'python');
    const pidFile = join(homedir(), '.titan', 'f5tts.pid');
    if (!fs.existsSync(python)) { res.status(400).json({ ok: false, error: 'F5-TTS not installed. Use POST /api/voice/f5tts/install first.' }); return; }
    try { const probe = await fetch(`http://localhost:${5006}/health`, { signal: AbortSignal.timeout(3000) }); if (probe.ok) { res.json({ ok: true, message: 'F5-TTS is already running' }); return; } } catch { /* not running */ }
    try {
      const serverScript = join(__dirname, '..', '..', 'scripts', 'f5-tts-server.py');
      const scriptPath = fs.existsSync(serverScript) ? serverScript : join(__dirname, '..', '..', '..', 'scripts', 'f5-tts-server.py');
      const child = spawn(python, [scriptPath, '--host', '127.0.0.1', '--port', String(5006)], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${join(venvPath, 'bin')}:${process.env.PATH}` },
      });
      child.unref();
      f5ttsPid = child.pid ?? null;
      if (child.pid) fs.writeFileSync(pidFile, String(child.pid));
      res.json({ ok: true, message: 'F5-TTS server starting — model loading may take a minute.' });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  };

  router.post('/voice/f5tts/stop', stopF5TTSHandler);
  router.post('/voice/f5tts/start', startF5TTSHandler);

  const deprecationWarn = (alias: string, canonical: string) => {
    logger.warn(COMPONENT, `Deprecated route ${alias} called; please switch to ${canonical}.`);
  };
  router.post('/voice/qwen3tts/stop', (req, res) => { deprecationWarn('/api/voice/qwen3tts/stop', '/api/voice/f5tts/stop'); return stopF5TTSHandler(req, res); });
  router.post('/voice/qwen3tts/start', (req, res) => { deprecationWarn('/api/voice/qwen3tts/start', '/api/voice/f5tts/start'); return startF5TTSHandler(req, res); });

  router.post('/voice/clone/upload', async (req, res) => {
    try {
      const voicesDir = join(homedir(), '.titan', 'voices');
      if (!fs.existsSync(voicesDir)) fs.mkdirSync(voicesDir, { recursive: true });
      const voiceName = (req.query.name as string) || req.headers['x-voice-name'] as string || 'custom';
      const safeName = voiceName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'custom';
      const transcript = (req.query.transcript as string) || req.headers['x-voice-transcript'] as string || '';
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        const body = req.body as { audio?: string; name?: string; transcript?: string };
        if (!body.audio) { res.status(400).json({ error: 'audio (base64) is required' }); return; }
        const audioBuffer = Buffer.from(body.audio, 'base64');
        const name = body.name?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || safeName;
        fs.writeFileSync(join(voicesDir, `${name}.wav`), audioBuffer);
        if (body.transcript || transcript) fs.writeFileSync(join(voicesDir, `${name}.txt`), body.transcript || transcript);
        res.json({ ok: true, voice: name, path: join(voicesDir, `${name}.wav`) });
      } else {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const audioBuffer = Buffer.concat(chunks);
          fs.writeFileSync(join(voicesDir, `${safeName}.wav`), audioBuffer);
          if (transcript) fs.writeFileSync(join(voicesDir, `${safeName}.txt`), transcript);
          res.json({ ok: true, voice: safeName, path: join(voicesDir, `${safeName}.wav`) });
        });
      }
    } catch (e) { logger.error(COMPONENT, `Endpoint error: ${(e as Error).message}`); res.status(500).json({ error: 'Something went wrong on our end. Please try again in a moment.' }); }
  });

  router.get('/voice/clone/voices', (_req, res) => {
    const voicesDir = join(homedir(), '.titan', 'voices');
    try {
      if (!fs.existsSync(voicesDir)) { res.json({ voices: [] }); return; }
      const voices = fs.readdirSync(voicesDir).filter(f => f.endsWith('.wav')).map(f => {
        const name = f.replace('.wav', '');
        const hasTranscript = fs.existsSync(join(voicesDir, `${name}.txt`));
        const stat = fs.statSync(join(voicesDir, f));
        return { name, hasTranscript, sizeBytes: stat.size };
      });
      res.json({ voices });
    } catch (e) { res.json({ voices: [], error: (e as Error).message }); }
  });

  router.delete('/voice/clone/:name', (req, res) => {
    const voicesDir = join(homedir(), '.titan', 'voices');
    const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
    try {
      const wavPath = join(voicesDir, `${name}.wav`);
      const txtPath = join(voicesDir, `${name}.txt`);
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
      if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: (e as Error).message }); }
  });

  return router;
}
