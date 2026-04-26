# F5-TTS Voice Setup — TITAN 3.0

TITAN 3.0 uses **F5-TTS** as its sole TTS engine. No Orpheus, no Qwen3-TTS, no Edge TTS, no browser fallback. Just F5-TTS with zero-shot voice cloning.

## Quick Start

### 1. Start the F5-TTS Server

```bash
# Apple Silicon (MLX native — fastest)
python scripts/f5-tts-server.py

# Or GPU version
python scripts/f5-tts-gpu-server.py
```

Runs on `http://127.0.0.1:5006` with an OpenAI-compatible API.

### 2. Add a Cloned Voice

Place reference audio + transcript in `~/.titan/voices/`:

```
~/.titan/voices/
├── andrew.wav       # 3-30 seconds of clean speech
├── andrew.txt       # (optional) transcript of the reference audio
└── default.wav      # fallback if no voice is specified
```

Supported formats: `.wav`, `.mp3`, `.flac`

**Audio requirements:**
- 3–30 seconds of clean speech
- Minimal background noise
- Single speaker
- The server auto-preprocesses: normalizes to -23 LUFS, trims silence, de-esses

### 3. Upload via API

```bash
curl -X POST http://localhost:5006/v1/voices/upload \
  -F "name=myvoice" \
  -F "audio=@reference.wav" \
  -F "transcript=This is my reference voice sample."
```

### 5. Verify

```bash
curl -X POST http://localhost:5006/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello, I am TITAN.", "voice": "andrew"}' \
  --output test.wav
```

## Server Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   TITAN UI      │────▶│  TITAN Server   │────▶│  F5-TTS Server  │
│  (port 5174)    │     │  (port 48421)   │     │  (port 5006)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │
                              ▼
                        ┌─────────────────┐
                        │  ~/.titan/voices│
                        │  (cloned voices)│
                        └─────────────────┘
```

## Voice Configuration

The TypeScript voice server (`server/src/voice/service.ts`) now uses the `F5TTSAdapter` which talks to the F5-TTS server on port 5006. No API keys needed. No cloud dependencies.

Environment variables:
- `F5_TTS_URL` — F5-TTS server URL (default: `http://127.0.0.1:5006`)
- `TTS_VOICE` — Default voice name (default: `default`)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "No voices found" | Check `~/.titan/voices/` exists and has `.wav` files |
| Audio sounds robotic | Use a longer reference (8-15s) with clear speech |
| Voice drifts | Add an `andrew.txt` transcript file |
| Server won't start | Install `f5-tts-mlx`: `pip install f5-tts-mlx` |
| ffmpeg error | Install ffmpeg: `brew install ffmpeg` |
