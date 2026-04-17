/**
 * TITAN — Messenger Voice Helper (v4.3.2+)
 *
 * Adds two capabilities to the Messenger channel:
 *   1. Inbound audio transcription — when Tony sends a voice note,
 *      download the FB CDN attachment, run it through local
 *      faster-whisper, and return the transcript as text so the
 *      existing admin-reply pipeline can process it normally.
 *   2. Outbound voice synthesis — take a generated reply, call the
 *      F5-TTS GPU server (already running on localhost:5006, Andrew
 *      voice reference at ~/.titan/voices/andrew.wav), then upload the
 *      resulting WAV to Meta's attachment_upload endpoint and send as
 *      an audio message.
 *
 * Everything here is best-effort: if Whisper is missing, audio attachments
 * fall back to "I heard an audio note but can't transcribe it yet." If
 * F5-TTS is unhealthy, the reply falls back to text. The Messenger channel
 * never dies just because voice is down.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import logger from '../utils/logger.js';

const COMPONENT = 'MessengerVoice';
const GRAPH_API = 'https://graph.facebook.com/v21.0';

// ── Config ──────────────────────────────────────────────────────────
// F5-TTS GPU server (see scripts/f5-tts-gpu-server.py). localhost on
// Titan PC — for local dev, override with F5_TTS_URL env var.
const F5_TTS_URL = process.env.F5_TTS_URL || 'http://localhost:5006';

// faster-whisper is installed inside the voice-venv (see deploy.sh).
// We shell out to a one-shot python invocation so we don't have to
// spawn a long-running server + handle its lifecycle. That's slower
// per-call but simpler and the voice channel isn't high-QPS.
const WHISPER_PYTHON = process.env.WHISPER_PYTHON || '/home/dj/.titan/voice-venv/bin/python3';
const WHISPER_MODEL_SIZE = process.env.WHISPER_MODEL || 'base.en';

/** Extract all audio attachments from a Messenger webhook event */
export function extractAudioAttachments(
    message: Record<string, unknown> | undefined,
): Array<{ url: string; type: string }> {
    if (!message) return [];
    const attachments = message.attachments as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(attachments)) return [];

    const audio: Array<{ url: string; type: string }> = [];
    for (const att of attachments) {
        const type = att.type as string | undefined;
        if (type !== 'audio') continue;
        const payload = att.payload as Record<string, unknown> | undefined;
        const url = payload?.url as string | undefined;
        if (url) audio.push({ url, type });
    }
    return audio;
}

/** Download an audio attachment from the FB CDN to a local tempfile */
async function downloadAudio(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('Empty audio download');
    const tmpPath = join(tmpdir(), `fb-audio-${randomBytes(6).toString('hex')}.m4a`);
    await writeFile(tmpPath, buf);
    logger.info(COMPONENT, `Downloaded ${buf.length} bytes → ${tmpPath}`);
    return tmpPath;
}

/** Transcribe a local audio file with faster-whisper. Returns '' if not available. */
async function transcribeWithWhisper(audioPath: string): Promise<string> {
    return new Promise((resolve) => {
        // One-liner: import, load model, transcribe, print text. Model cache is
        // $XDG_CACHE_HOME/huggingface so re-runs are fast.
        const script = `
import sys
try:
    from faster_whisper import WhisperModel
    model = WhisperModel("${WHISPER_MODEL_SIZE}", device="auto", compute_type="auto")
    segs, _info = model.transcribe(sys.argv[1], vad_filter=True, language="en")
    print("".join(s.text for s in segs).strip())
except ImportError:
    sys.stderr.write("faster_whisper not installed")
    sys.exit(2)
except Exception as e:
    sys.stderr.write(f"transcribe failed: {e}")
    sys.exit(1)
`;
        const proc = spawn(WHISPER_PYTHON, ['-c', script, audioPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
        });
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.stderr.on('data', (d) => { err += d.toString(); });
        proc.on('close', (code) => {
            if (code !== 0) {
                logger.warn(COMPONENT, `Whisper exited ${code}: ${err.trim().slice(0, 200)}`);
                resolve('');
                return;
            }
            resolve(out.trim());
        });
        proc.on('error', (e) => {
            logger.warn(COMPONENT, `Whisper spawn error: ${e.message}`);
            resolve('');
        });
    });
}

/** Transcribe a Messenger audio attachment URL to text. Empty string on failure. */
export async function transcribeMessengerAudio(url: string): Promise<string> {
    let path = '';
    try {
        path = await downloadAudio(url);
        const text = await transcribeWithWhisper(path);
        logger.info(COMPONENT, `Transcribed ${text.length} chars: "${text.slice(0, 80)}"`);
        return text;
    } catch (e) {
        logger.warn(COMPONENT, `Transcription failed: ${(e as Error).message}`);
        return '';
    } finally {
        if (path) await unlink(path).catch(() => {});
    }
}

/**
 * Synthesize text via F5-TTS GPU server. Returns { buf, mime, ext } or null.
 *
 * v4.3.3: switched from WAV 24kHz → MP3 44.1kHz because Messenger's audio
 * player was misinterpreting the 24kHz WAV as 16kHz and playing back 1.5×
 * fast + high-pitched (chipmunk Andrew). MP3 embeds unambiguous sample-rate
 * metadata that every player respects.
 */
export async function synthesizeAudio(
    text: string,
    voice = 'andrew',
): Promise<{ buf: Buffer; mime: string; ext: string } | null> {
    try {
        const res = await fetch(`${F5_TTS_URL}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: text, voice, response_format: 'mp3' }),
            signal: AbortSignal.timeout(180_000), // long texts chunk across multiple inferences
        });
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            logger.warn(COMPONENT, `F5-TTS ${res.status}: ${errBody.slice(0, 200)}`);
            return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) {
            logger.warn(COMPONENT, 'F5-TTS returned empty buffer');
            return null;
        }
        // Honor whatever the server actually returned — it falls back to
        // WAV if ffmpeg transcode fails. Either format plays correctly.
        const contentType = res.headers.get('content-type') || 'audio/mpeg';
        const isMp3 = contentType.includes('mpeg') || contentType.includes('mp3');
        const ext = isMp3 ? 'mp3' : 'wav';
        const mime = isMp3 ? 'audio/mpeg' : 'audio/wav';
        logger.info(COMPONENT, `Synthesized ${buf.length} bytes (voice=${voice}, ${ext})`);
        return { buf, mime, ext };
    } catch (e) {
        logger.warn(COMPONENT, `F5-TTS error: ${(e as Error).message}`);
        return null;
    }
}

/** Back-compat alias; v4.3.3 returns MP3 by default via synthesizeAudio. */
export async function synthesizeToWav(text: string, voice = 'andrew'): Promise<Buffer | null> {
    const r = await synthesizeAudio(text, voice);
    return r?.buf ?? null;
}

/** Upload an audio buffer to Messenger's attachment_upload endpoint, returns attachment_id */
async function uploadMessengerAttachment(
    audio: Buffer,
    pageToken: string,
    mime: string,
    ext: string,
): Promise<string | null> {
    try {
        const form = new FormData();
        form.append('message', JSON.stringify({ attachment: { type: 'audio', payload: { is_reusable: true } } }));
        form.append('filedata', new Blob([new Uint8Array(audio)], { type: mime }), `reply.${ext}`);

        const res = await fetch(`${GRAPH_API}/me/message_attachments?access_token=${encodeURIComponent(pageToken)}`, {
            method: 'POST',
            body: form as unknown as BodyInit,
            signal: AbortSignal.timeout(30_000),
        });
        const bodyText = await res.text();
        if (!res.ok) {
            logger.warn(COMPONENT, `Attachment upload ${res.status}: ${bodyText.slice(0, 300)}`);
            return null;
        }
        const data = JSON.parse(bodyText) as { attachment_id?: string };
        if (!data.attachment_id) {
            logger.warn(COMPONENT, `Upload returned no attachment_id: ${bodyText.slice(0, 200)}`);
            return null;
        }
        return data.attachment_id;
    } catch (e) {
        logger.warn(COMPONENT, `Attachment upload error: ${(e as Error).message}`);
        return null;
    }
}

/** Send a Messenger message referencing an already-uploaded attachment */
async function sendAttachmentMessage(
    recipientId: string,
    attachmentId: string,
    pageToken: string,
): Promise<boolean> {
    try {
        const res = await fetch(`${GRAPH_API}/me/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${pageToken}`,
            },
            body: JSON.stringify({
                recipient: { id: recipientId },
                message: { attachment: { type: 'audio', payload: { attachment_id: attachmentId } } },
                messaging_type: 'RESPONSE',
            }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            const err = await res.text();
            logger.warn(COMPONENT, `Send audio ${res.status}: ${err.slice(0, 200)}`);
            return false;
        }
        return true;
    } catch (e) {
        logger.warn(COMPONENT, `Send audio error: ${(e as Error).message}`);
        return false;
    }
}

/**
 * End-to-end voice reply: synthesize, upload, send. Returns true on success.
 * Any failure along the way returns false and the caller should fall back to text.
 */
export async function sendVoiceReply(
    recipientId: string,
    text: string,
    pageToken: string,
    voice = 'andrew',
): Promise<boolean> {
    if (!recipientId || !text || !pageToken) return false;

    // F5-TTS works best on shortish text (< 500 chars). Longer text
    // chunks fine server-side, but the resulting audio gets long — fine
    // for Messenger, but cap to ~1000 chars anyway to bound latency.
    const trimmed = text.length > 1000 ? text.slice(0, 990) + '…' : text;

    const audio = await synthesizeAudio(trimmed, voice);
    if (!audio) return false;

    const attachmentId = await uploadMessengerAttachment(audio.buf, pageToken, audio.mime, audio.ext);
    if (!attachmentId) return false;

    const ok = await sendAttachmentMessage(recipientId, attachmentId, pageToken);
    if (ok) {
        logger.info(COMPONENT, `Voice reply delivered to ${recipientId} (voice=${voice}, ${audio.buf.length} bytes, ${audio.ext})`);
    }
    return ok;
}

/** Health check: is F5-TTS reachable? */
export async function f5ttsHealth(): Promise<boolean> {
    try {
        const res = await fetch(`${F5_TTS_URL}/health`, {
            signal: AbortSignal.timeout(3_000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

// Keep mkdir import used — intentional side-effect for tests that
// write sample audio into a tmp dir. (No-op at import time.)
void mkdir;
void fs;
