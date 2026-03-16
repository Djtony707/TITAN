"""
TITAN Voice Server — FastAPI + WebSocket + REST endpoints
Standalone Python service for voice chat (STT + TTS + VAD).
Also exposes OpenAI-compatible REST API for TTS synthesis.
"""
import asyncio
import glob
import io
import logging
import os
import time
import wave
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from config import cfg
from vad import VoiceActivityDetector
from stt import SpeechToText
from tts import create_tts_engine, TTSEngine

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
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "stt": "ready" if _stt else "loading",
        "tts": "ready" if _tts else "loading",
        "sttModel": cfg.STT_MODEL,
        "ttsEngine": cfg.TTS_ENGINE,
        "ttsVoice": cfg.TTS_VOICE,
    }


# ── OpenAI-compatible TTS REST API ──────────────────────────────────────

@app.post("/v1/audio/speech")
async def synthesize_speech(request: Request):
    """OpenAI-compatible TTS endpoint. Accepts {input, voice, response_format}."""
    if not _tts:
        return Response(content="TTS not loaded", status_code=503)

    body = await request.json()
    text = body.get("input", "")
    voice = body.get("voice", cfg.TTS_VOICE)
    # response_format: wav (default) or pcm
    response_format = body.get("response_format", "wav")

    if not text:
        return Response(content="No input text", status_code=400)

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
async def list_voices():
    """List available TTS voices."""
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
    await ws.accept()
    log.info("Voice WebSocket connected: %s", ws.client)

    # Each connection gets its own VAD state
    vad = VoiceActivityDetector()
    pipeline = VoicePipeline(ws, vad, _stt, _tts)

    try:
        while True:
            message = await ws.receive()

            if "bytes" in message and message["bytes"]:
                # Binary frame = PCM audio
                await pipeline.handle_audio(message["bytes"])
            elif "text" in message and message["text"]:
                # JSON control message
                await pipeline.handle_control(message["text"])
    except WebSocketDisconnect:
        log.info("Voice WebSocket disconnected: %s", ws.client)
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
    )
