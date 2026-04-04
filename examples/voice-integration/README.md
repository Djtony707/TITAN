# Voice Integration Example

A LiveKit WebRTC voice agent that demonstrates TITAN's voice pipeline capabilities including real-time speech recognition, TTS synthesis, and WebRTC audio streaming.

## What This Example Shows

- Connecting to TITAN's LiveKit voice server
- Real-time speech-to-text (STT) input
- Text-to-speech (TTS) synthesis with Orpheus
- WebRTC audio track handling
- Voice session management
- Fallback to browser TTS
- Multi-voice support with Orpheus voice selection

## Prerequisites

- Node.js >= 20
- A running TITAN gateway with voice enabled (`titan dev:gateway`)
- LiveKit server running (included in `docker-compose.voice.yml`)
- Microphone access (for STT input)

## Setup

```bash
npm install
```

## Running

```bash
# Interactive voice session (terminal-based, simulates voice)
npm start

# With a specific voice model
VOICE_NAME=tara npm start

# Test browser TTS fallback
BROWSER_TTS=true npm start
```

## Voice Pipeline Architecture

```
┌──────────────┐     WebRTC      ┌──────────────┐
│  LiveKit     │◄───────────────►│  TITAN       │
│  Room        │   Audio Track   │  Voice Agent │
└──────┬───────┘                  └──────┬───────┘
       │                                 │
       │                          ┌──────▼───────┐
       │                          │  STT/TTS     │
       │                          │  Pipeline    │
       │                          └──────┬───────┘
       │                                 │
       │                          ┌──────▼───────┐
       │                          │  LLM +       │
       │                          │  Tools       │
       │                          └──────────────┘
       │
┌──────▼───────┐
│  Browser /   │
│  Client App  │
└──────────────┘
```

## TTS Voices

TITAN supports multiple TTS backends:

| Backend | Voices | Quality | Latency |
|---------|--------|---------|---------|
| Orpheus | tara, leah, josh, mike, emma, etc. | High | Medium |
| Browser | System default | Medium | Low |
| ElevenLabs | 100+ voices | Highest | High |

Configure in `~/.titan/titan.json`:

```json
{
  "voice": {
    "enabled": true,
    "tts": {
      "provider": "orpheus",
      "voice": "tara"
    }
  }
}
```

## API Reference

```typescript
// Check voice health
const health = await fetch("http://localhost:48420/api/voice/health");

// Start a voice session
const session = await fetch("http://localhost:48420/api/voice/session", {
  method: "POST",
});

// List available voices
const voices = await fetch("http://localhost:48420/api/voice/voices");
```

## Voice Settings in Mission Control

Open Mission Control at `http://localhost:48420` and click the **Voice** button in the header to:
- Toggle voice input on/off
- Select a TTS voice from the dropdown
- Test TTS with a sample phrase
- View voice server health status

## Browser TTS Fallback

When the Orpheus voice server is unavailable, TITAN automatically falls back to the browser's built-in `speechSynthesis` API. The UI shows a microphone indicator with a status badge:
- **Green** — Orpheus connected
- **Yellow** — Browser TTS fallback
- **Red** — Voice unavailable

## Next Steps

- Explore the [voice server source](../../titan-voice-server/) for implementation details
- Check out the [VoiceOverlay component](../../ui/src/components/voice/VoiceOverlay.tsx) for the React UI
- Read about [LiveKit integration](../../titan-voice-agent/README.md) for agent voice handling
