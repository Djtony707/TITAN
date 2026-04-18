/**
 * TITAN — Twilio Voice Integration (v4.4.0+)
 *
 * Real phone calls. Tony dials the TITAN Twilio number on his phone,
 * talks, and hears back in the Andrew voice via F5-TTS. No browser,
 * no app, no Wi-Fi — just a regular phone call.
 *
 * Flow:
 *   1. Tony dials → Twilio → POST /api/twilio/voice-webhook
 *   2. We greet + ask for speech via <Gather input="speech">
 *   3. Twilio transcribes + POSTs to /api/twilio/voice-gather
 *   4. We run admin processMessage, synthesize reply via F5-TTS,
 *      cache the MP3, return TwiML with <Play> + another <Gather>
 *   5. Loop until Tony hangs up
 *
 * Security:
 *   - X-Twilio-Signature validation on every webhook
 *   - Caller whitelist (only Tony's numbers get through to the agent)
 *   - Signed MP3 URLs expire after 5 min (twilio.audio cache)
 */
import { createHmac, randomBytes, createHash } from 'crypto';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import logger from '../utils/logger.js';
import { synthesizeAudio } from './messenger-voice.js';

const COMPONENT = 'TwilioVoice';
const CACHE_DIR = join(tmpdir(), 'titan-tts-cache');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── TwiML builders ──────────────────────────────────────────────

/**
 * Build a <Gather> containing <Play> so the caller can barge-in over
 * the prompt. Twilio stops playback the moment it detects speech.
 *
 * v4.4.4: <Play> must be INSIDE <Gather> for barge-in to work.
 * Previously they were siblings, which made Twilio wait for playback
 * to finish before listening — caller couldn't interrupt.
 *
 * enhanced="true" + speechModel="phone_call" = Google's better STT
 * model for phone audio. speechTimeout="2" gives slow speakers two
 * full seconds of trailing silence before Twilio posts.
 */
export function twimlPlayAndGather(audioUrl: string, gatherAction: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(gatherAction)}" method="POST" speechTimeout="2" language="en-US" enhanced="true" speechModel="phone_call">
    <Play>${xmlEscape(audioUrl)}</Play>
  </Gather>
  <Redirect method="POST">${xmlEscape(gatherAction)}</Redirect>
</Response>`;
}

/**
 * Short pause + redirect back to the poll URL. Used between Twilio's
 * webhook turn and our async reply being ready. Each round-trip is
 * ~3 seconds; the call stays alive indefinitely because the webhook
 * timeout resets on every response.
 */
export function twimlPauseAndRedirect(pollUrl: string, pauseSec = 3): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="${Math.max(1, Math.min(10, pauseSec))}"/>
  <Redirect method="POST">${xmlEscape(pollUrl)}</Redirect>
</Response>`;
}

/** Speak (no recording — end-of-call message) */
export function twimlSayAndHangup(text: string, voice = 'Polly.Matthew'): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${xmlEscape(text)}</Say>
  <Hangup />
</Response>`;
}

/** Play audio then hang up */
export function twimlPlayAndHangup(audioUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(audioUrl)}</Play>
  <Hangup />
</Response>`;
}

/** Reject an unauthorized caller politely */
export function twimlReject(): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">Sorry, this number is private. Goodbye.</Say>
  <Hangup />
</Response>`;
}

function xmlEscape(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ── Twilio signature validation ─────────────────────────────────

/**
 * Validate Twilio's X-Twilio-Signature header. Per Twilio docs:
 * signature = base64(hmac-sha1(authToken, url + sorted_params_concatenated))
 * See https://www.twilio.com/docs/usage/security#validating-requests
 */
export function validateTwilioSignature(
    authToken: string,
    signature: string,
    url: string,
    params: Record<string, string>,
): boolean {
    if (!authToken || !signature || !url) return false;
    const sortedKeys = Object.keys(params).sort();
    const concat = sortedKeys.reduce((acc, k) => acc + k + params[k], url);
    const expected = createHmac('sha1', authToken).update(concat).digest('base64');
    // Timing-safe compare
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
}

// ── Caller whitelist ────────────────────────────────────────────

/** Normalize E.164 numbers: strip spaces, dashes, parens. Keeps leading +. */
export function normalizePhone(num: string): string {
    if (!num) return '';
    return num.replace(/[\s()\-.]/g, '').trim();
}

export function isAllowedCaller(from: string, allowed: string[]): boolean {
    if (!from) return false;
    const norm = normalizePhone(from);
    return allowed.map(normalizePhone).some(a => a === norm);
}

// ── Audio cache (serve F5-TTS output to Twilio by URL) ──────────

interface CacheEntry { path: string; createdAt: number; }
const audioCache = new Map<string, CacheEntry>();

async function ensureCacheDir(): Promise<void> {
    if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
}

/**
 * Synthesize text via F5-TTS and cache the MP3 on disk. Returns a
 * short token that the caller can embed in a URL; the token maps to
 * a local file that the /api/twilio/audio/:token endpoint serves.
 *
 * Why cache: Twilio's <Play> fetches the URL via HTTP GET. We could
 * stream from F5-TTS directly, but generating ahead + caching means
 * Twilio gets the full file immediately and playback is smoother.
 */
export async function synthesizeAndCache(text: string, voice = 'andrew'): Promise<string | null> {
    const audio = await synthesizeAudio(text, voice);
    if (!audio) return null;

    await ensureCacheDir();
    // Token = first 16 hex chars of a random 24-byte buffer (96 bits of entropy,
    // fits comfortably in a URL, not guessable).
    const token = randomBytes(12).toString('hex');
    const path = join(CACHE_DIR, `${token}.${audio.ext}`);
    await writeFile(path, audio.buf);
    audioCache.set(token, { path, createdAt: Date.now() });

    // Garbage collect old entries on every insert (cheap + bounded).
    for (const [k, v] of audioCache) {
        if (Date.now() - v.createdAt > CACHE_TTL_MS) {
            audioCache.delete(k);
            unlink(v.path).catch(() => {});
        }
    }

    return token;
}

/** Resolve a cache token to disk path. Returns null if expired / unknown. */
export function resolveCachedAudio(token: string): { path: string; mime: string } | null {
    const entry = audioCache.get(token);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
        audioCache.delete(token);
        unlink(entry.path).catch(() => {});
        return null;
    }
    return {
        path: entry.path,
        mime: entry.path.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
    };
}

/**
 * Pull the raw audio bytes for a token. Used by the /audio/:token
 * endpoint. Returns null if the token is unknown or expired.
 */
export async function readCachedAudio(token: string): Promise<{ buf: Buffer; mime: string } | null> {
    const resolved = resolveCachedAudio(token);
    if (!resolved) return null;
    try {
        const buf = await readFile(resolved.path);
        return { buf, mime: resolved.mime };
    } catch {
        return null;
    }
}

// ── Async job state (v4.4.4) ────────────────────────────────────
// Twilio's webhook HTTP timeout is ~15s. Our LLM turn can take 10-30s.
// Instead of awaiting the LLM in the webhook handler, we spawn the
// work in the background, return a "pause + redirect" TwiML immediately,
// and let Twilio poll us until the reply is ready.

export interface VoiceJob {
    callSid: string;
    status: 'pending' | 'ready' | 'error';
    audioToken?: string;
    replyText?: string;
    error?: string;
    createdAt: number;
}

const JOB_TTL_MS = 60 * 1000; // 60 seconds — longest we'll keep a call polling
const voiceJobs = new Map<string, VoiceJob>();

export function createVoiceJob(callSid: string): string {
    const jobId = randomBytes(8).toString('hex');
    voiceJobs.set(jobId, { callSid, status: 'pending', createdAt: Date.now() });
    // GC expired jobs
    for (const [k, v] of voiceJobs) {
        if (Date.now() - v.createdAt > JOB_TTL_MS) voiceJobs.delete(k);
    }
    return jobId;
}

export function getVoiceJob(jobId: string): VoiceJob | undefined {
    const job = voiceJobs.get(jobId);
    if (!job) return undefined;
    if (Date.now() - job.createdAt > JOB_TTL_MS) {
        voiceJobs.delete(jobId);
        return undefined;
    }
    return job;
}

export function completeVoiceJob(jobId: string, audioToken: string, replyText: string): void {
    const job = voiceJobs.get(jobId);
    if (!job) return;
    job.status = 'ready';
    job.audioToken = audioToken;
    job.replyText = replyText;
}

export function failVoiceJob(jobId: string, error: string): void {
    const job = voiceJobs.get(jobId);
    if (!job) return;
    job.status = 'error';
    job.error = error;
}

// ── Call → TITAN session mapping ────────────────────────────────
// Map Twilio CallSid → TITAN sessionId so we get conversation
// continuity across turns within a single phone call.
const callSessions = new Map<string, string>();

export function getCallSession(callSid: string): string | undefined {
    return callSessions.get(callSid);
}

export function setCallSession(callSid: string, sessionId: string): void {
    callSessions.set(callSid, sessionId);
}

export function endCall(callSid: string): void {
    callSessions.delete(callSid);
}

// ── Debug / stable token for signed URLs (if signature-URL approach wanted) ─
export function hashForDebug(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 8);
}
