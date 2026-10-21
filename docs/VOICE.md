# TITAN Voice Setup

Real-time voice conversations with TITAN using LiveKit WebRTC. Runs fully locally with customizable voices.

## Architecture

```
Browser mic → LiveKit WebRTC → Voice Agent (Python)
  → STT (faster-whisper) → TITAN Gateway /api/message → LLM
  → TTS (Kokoro) → LiveKit → Browser speaker
```

All components self-hosted. No cloud APIs required.

## Requirements

- Docker with Compose v2
- 4GB+ RAM for voice services
- GPU optional (CUDA for faster-whisper acceleration)
- Node.js 22.23.4+, 24.22.1+, or 26.12.1+ (supported stable lines, for TITAN gateway)

## Quick Start

### 1. Voice Docker Stack

Create `docker-compose.voice.yml`:

```yaml
services:
  livekit-server:
    image: livekit/livekit-server:latest
    command: --dev --bind 0.0.0.0
    ports:
      - "7880:7880"   # WebRTC
      - "7881:7881"   # TCP
    restart: unless-stopped

  faster-whisper:
    image: fedirz/faster-whisper-server:latest-cuda  # or :latest for CPU
    ports:
      - "8300:8000"
    environment:
      WHISPER__MODEL: Systran/faster-whisper-medium
      WHISPER__COMPUTE_TYPE: float16  # use "int8" for CPU
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped

  kokoro-tts:
    image: ghcr.io/remsky/kokoro-fastapi-cpu:latest
    ports:
      - "8880:8880"
    restart: unless-stopped
```

```bash
docker compose -f docker-compose.voice.yml up -d
```

### 2. Voice Agent

The voice agent bridges LiveKit rooms to TITAN's API.

```bash
# Clone or create titan-voice-agent/
pip install livekit-agents livekit-plugins-silero

# .env.local
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
TITAN_API_URL=http://localhost:48420/api/message
STT_BASE_URL=http://localhost:8300/v1
TTS_BASE_URL=http://localhost:8880/v1
```

### 3. Enable Voice in TITAN

Add to `~/.titan/titan.json`:

```json
{
  "voice": {
    "enabled": true,
    "livekitUrl": "ws://localhost:7880",
    "livekitApiKey": "devkey",
    "livekitApiSecret": "secret",
    "agentUrl": "http://localhost:8081",
    "ttsVoice": "af_heart"
  }
}
```

### 4. Install LiveKit SDK (Gateway)

```bash
cd /path/to/titan
npm install livekit-server-sdk
```

Restart the gateway. Voice health check: `GET /api/voice/health`

## Available Voices

TITAN ships with 10 Kokoro voices:

| ID | Name | Style | Gender |
|----|------|-------|--------|
| `af_heart` | Heart | Warm and expressive | Female |
| `af_bella` | Bella | Elegant and clear | Female |
| `af_nova` | Nova | Bright and energetic | Female |
| `af_sky` | Sky | Calm and soothing | Female |
| `af_river` | River | Natural and flowing | Female |
| `bf_emma` | Emma | Refined and composed | Female |
| `am_adam` | Adam | Confident and deep | Male |
| `am_michael` | Michael | Steady and articulate | Male |
| `am_puck` | Puck | Quick and playful | Male |
| `am_fenrir` | Fenrir | Bold and commanding | Male |

Voice selection is saved per-user in the browser and synced to the server config.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/voice/health` | GET | Voice subsystem status |
| `/api/voice/voices` | GET | Available TTS voices |
| `/api/voice/preview` | POST | Generate voice sample |
| `/api/livekit/token` | POST | Get LiveKit room token |

### Voice Preview

```bash
curl -X POST http://localhost:48420/api/voice/preview \
  -H "Content-Type: application/json" \
  -d '{"voice": "af_heart", "text": "Hello from TITAN!"}' \
  --output preview.mp3
```

## GPU Notes

- **faster-whisper**: Works with NVIDIA GPUs via CUDA. Use `float16` compute type.
- **Kokoro TTS**: CPU-only Docker image recommended. GPU image requires CUDA kernel support for your GPU architecture (RTX 5090/Blackwell not yet supported as of March 2026).
- **LiveKit**: CPU only, minimal resource usage.

## Troubleshooting

**"Voice not configured"**: Ensure `voice.enabled: true` in `~/.titan/titan.json`.

**"livekit-server-sdk not installed"**: Run `npm install livekit-server-sdk` in the TITAN directory.

**Voice health shows `livekit: false`**: Check that LiveKit server is running on port 7880.

**Voice health shows `agent: false`**: Check that the voice agent is running and connected to LiveKit.

**No audio output**: Verify Kokoro TTS is running on port 8880 (`curl http://localhost:8880/v1/audio/voices`).

## Credits

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for full attribution. Key voice components:

- **LiveKit** (Apache-2.0) — Real-time WebRTC platform
- **faster-whisper** (MIT) — CTranslate2-based STT by SYSTRAN
- **Kokoro** (Apache-2.0) — 82M parameter TTS model by Hexgrad
- **Kokoro-FastAPI** (MIT) — OpenAI-compatible TTS server by remsky
- **Silero VAD** (MIT) — Voice activity detection by Silero Team
