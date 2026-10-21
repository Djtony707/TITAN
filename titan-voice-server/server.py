"""
TITAN Voice Server — FastAPI + WebSocket + REST endpoints
Standalone Python service for voice chat (STT + TTS + VAD).
Also exposes OpenAI-compatible REST API for TTS synthesis.
"""
import asyncio
import glob
import io
import json
import logging
import os
import time
import wave
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from config import cfg
from auth import authorize_http, authorize_websocket, valid_voice, validate_security_config
from vad import VoiceActivityDetector
from stt import SpeechToText
from tts import create_tts_engine, TTSEngine
from pipeline import VoicePipeline

MAX_BODY_BYTES = 32768
MAX_TEXT_CHARS = 4000
MAX_FRAME_BYTES = 65536
MAX_CONTROL_BYTES = 8192

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("titan-voice")

# Shared model instances (loaded once, shared across connections)
_stt: SpeechToText | None = None
_tts: TTSEngine | None = None


def _load_models():
    global _stt, _tts
    log.info("Loading VAD (Silero)...")
    t0 = time.monotonic()
    from vad import _get_model
    _get_model()  # Pre-load VAD model at startup
    log.info("VAD loaded in %.1fs", time.monotonic() - t0)

    log.info("Loading STT model: %s (device=%s)", cfg.STT_MODEL, cfg.STT_DEVICE)
    t0 = time.monotonic()
    _stt = SpeechToText()
    log.info("STT loaded in %.1fs", time.monotonic() - t0)

    log.info("Loading TTS engine: %s (device=%s)", cfg.TTS_ENGINE, cfg.TTS_DEVICE)
    t0 = time.monotonic()
    _tts = create_tts_engine()
    log.info("TTS loaded in %.1fs", time.monotonic() - t0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup, cleanup on shutdown."""
    validate_security_config()
    _load_models()
    log.info("TITAN Voice Server ready on %s:%d", cfg.HOST, cfg.PORT)
    log.info("  TITAN API: %s", cfg.TITAN_API_URL)
    log.info("  STT: %s (%s)", cfg.STT_MODEL, cfg.STT_DEVICE)
    log.info("  TTS: %s (%s)", cfg.TTS_ENGINE, cfg.TTS_DEVICE)
    yield
    log.info("Shutting down TITAN Voice Server")


app = FastAPI(title="TITAN Voice Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


async def bounded_json(request: Request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "JSON is required.")
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, "Request is too large.")
        raw.extend(chunk)
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "Invalid JSON.") from None
    if not isinstance(body, dict):
        raise HTTPException(400, "A JSON object is required.")
    return body


# ── OpenAI-compatible TTS REST API ──────────────────────────────────────

@app.post("/v1/audio/speech")
async def synthesize_speech(request: Request):
    """OpenAI-compatible TTS endpoint. Accepts {input, voice, response_format}."""
    authorize_http(request)
    if not _tts:
        return Response(content="TTS not loaded", status_code=503)

    body = await bounded_json(request)
    text = body.get("input", "")
    voice = body.get("voice", cfg.TTS_VOICE)
    # response_format: wav (default) or pcm
    response_format = body.get("response_format", "wav")

    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        return Response(content="Input must contain 1-4000 characters", status_code=400)
    if not valid_voice(voice) or not isinstance(response_format, str) or len(response_format) > 16:
        return Response(content="Invalid voice or format", status_code=400)

    t0 = time.monotonic()
    audio = _tts.synthesize(text, voice)
    duration = time.monotonic() - t0
    log.info("TTS synthesized %d samples in %.2fs (voice=%s)", len(audio), duration, voice)

    if response_format == "pcm":
        # Raw 16-bit PCM
        pcm16 = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
        return Response(content=pcm16.tobytes(), media_type="audio/pcm")

    # WAV format (default)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(cfg.TTS_SAMPLE_RATE)
        pcm16 = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
        wf.writeframes(pcm16.tobytes())

    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


@app.get("/v1/audio/voices")
async def list_voices(request: Request):
    """List available TTS voices."""
    authorize_http(request)
    # TADA: scan ~/.titan/voices/ for WAV files
    if hasattr(_tts, "available_voices"):
        return {"voices": _tts.available_voices()}

    # Orpheus: fixed voice set
    if cfg.TTS_ENGINE == "orpheus":
        return {"voices": ["tara", "leah", "jess", "mia", "zoe", "leo", "dan", "zac"]}

    # Kokoro: fixed set (query would need external API)
    if cfg.TTS_ENGINE == "kokoro":
        return {"voices": ["af_heart", "af_bella", "af_nova", "af_sky", "am_adam", "am_michael"]}

    # Fallback: scan voices directory
    voices_dir = os.path.expanduser("~/.titan/voices")
    voices = []
    if os.path.isdir(voices_dir):
        for f in sorted(glob.glob(os.path.join(voices_dir, "*.wav"))):
            name = os.path.splitext(os.path.basename(f))[0]
            voices.append(name)
    return {"voices": voices if voices else ["default"]}


# ── WebSocket voice chat ────────────────────────────────────────────────

@app.websocket("/ws/voice")
async def voice_ws(ws: WebSocket):
    try:
        protocol = authorize_websocket(ws)
    except (RuntimeError, ValueError):
        await ws.close(code=1008)
        return
    await ws.accept(subprotocol=protocol)
    log.info("Voice WebSocket connected: %s", ws.client)

    # Each connection gets its own VAD state
    vad = VoiceActivityDetector()
    pipeline = VoicePipeline(ws, vad, _stt, _tts)

    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                # Binary frame = PCM audio
                if len(message["bytes"]) > MAX_FRAME_BYTES or len(message["bytes"]) % 2:
                    await ws.close(code=1009)
                    break
                await pipeline.handle_audio(message["bytes"])
            elif "text" in message and message["text"]:
                # JSON control message
                if len(message["text"].encode("utf-8")) > MAX_CONTROL_BYTES:
                    await ws.close(code=1009)
                    break
                try:
                    control = json.loads(message["text"])
                    if not isinstance(control, dict) or control.get("type") not in ("config", "interrupt"):
                        raise ValueError("Invalid control.")
                    if "ttsVoice" in control and not valid_voice(control["ttsVoice"]):
                        raise ValueError("Invalid voice.")
                except (ValueError, UnicodeError, RecursionError):
                    await ws.close(code=1008)
                    break
                await pipeline.handle_control(message["text"])
    except WebSocketDisconnect:
        log.info("Voice WebSocket disconnected: %s", ws.client)
    except ValueError:
        await ws.close(code=1009)
    except Exception as e:
        log.error("Voice WebSocket error: %s", e)
    finally:
        pipeline.interrupt()
        vad.reset()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server:app",
        host=cfg.HOST,
        port=cfg.PORT,
        log_level="info",
        ws_ping_interval=30,
        ws_ping_timeout=10,
        ws_max_size=MAX_FRAME_BYTES,
        access_log=False,
    )
