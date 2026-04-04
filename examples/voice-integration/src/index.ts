/**
 * TITAN Voice Integration — LiveKit WebRTC voice agent.
 *
 * Demonstrates:
 * - Connecting to TITAN's LiveKit voice server
 * - Speech-to-text (STT) input handling
 * - Text-to-speech (TTS) synthesis with Orpheus
 * - WebRTC audio track management
 * - Voice session lifecycle
 * - Browser TTS fallback detection
 *
 * Prerequisites:
 *   - titan gateway running (titan gateway)
 *   - LiveKit server running (docker-compose.voice.yml)
 *
 * Run: npx tsx src/index.ts
 */

const TITAN_URL = process.env.TITAN_URL ?? "http://localhost:48420";
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
const VOICE_NAME = process.env.VOICE_NAME ?? "tara";
const USE_BROWSER_TTS = process.env.BROWSER_TTS === "true";

// ============================================================
// Voice Health Check
// ============================================================

interface VoiceHealth {
  status: "healthy" | "degraded" | "unavailable";
  tts: {
    provider: string;
    voice: string;
    connected: boolean;
  };
  stt: {
    provider: string;
    connected: boolean;
  };
  livekit: {
    url: string;
    connected: boolean;
  };
}

async function checkVoiceHealth(): Promise<VoiceHealth> {
  const res = await fetch(`${TITAN_URL}/api/voice/health`);
  if (!res.ok) {
    throw new Error(`Voice health check failed: ${res.status}`);
  }
  return res.json();
}

// ============================================================
// Voice Session
// ============================================================

interface VoiceSession {
  sessionId: string;
  roomName: string;
  token: string;
  participantName: string;
}

async function createVoiceSession(): Promise<VoiceSession> {
  const res = await fetch(`${TITAN_URL}/api/voice/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      voice: VOICE_NAME,
      useBrowserTTS: USE_BROWSER_TTS,
    }),
  });

  if (!res.ok) {
    throw new Error(`Session creation failed: ${res.status}`);
  }

  return res.json();
}

// ============================================================
// List Available Voices
// ============================================================

interface VoiceInfo {
  name: string;
  provider: string;
  language: string;
  gender: string;
}

async function listVoices(): Promise<VoiceInfo[]> {
  const res = await fetch(`${TITAN_URL}/api/voice/voices`);
  if (!res.ok) {
    throw new Error(`List voices failed: ${res.status}`);
  }
  return res.json();
}

// ============================================================
// Simulated Voice Interaction (Terminal Mode)
// ============================================================

import { createInterface } from "node:readline";

async function terminalVoiceDemo() {
  console.log("=== TITAN Voice Integration Demo ===\n");

  // Step 1: Check voice health
  console.log("1. Checking voice system health...");
  const health = await checkVoiceHealth();
  console.log(`   Status: ${health.status}`);
  console.log(`   TTS: ${health.tts.provider} (${health.tts.voice}) — ${health.tts.connected ? "connected" : "disconnected"}`);
  console.log(`   STT: ${health.stt.provider} — ${health.stt.connected ? "connected" : "disconnected"}`);
  console.log(`   LiveKit: ${health.livekit.url} — ${health.livekit.connected ? "connected" : "disconnected"}`);
  console.log("");

  // Step 2: List available voices
  console.log("2. Available voices:");
  const voices = await listVoices();
  for (const v of voices.slice(0, 8)) {
    console.log(`   - ${v.name} (${v.provider}, ${v.language}, ${v.gender})`);
  }
  console.log("");

  // Step 3: Create a voice session
  console.log(`3. Creating voice session with voice: ${VOICE_NAME}...`);
  const session = await createVoiceSession();
  console.log(`   Session ID: ${session.sessionId}`);
  console.log(`   Room: ${session.roomName}`);
  console.log(`   Participant: ${session.participantName}`);
  console.log("");

  // Step 4: Simulate voice interaction
  console.log("4. Simulated voice interaction (terminal mode):");
  console.log("   Type a message and TITAN will 'speak' the response.\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const input = await ask("You> ");
    if (!input.trim() || ["quit", "exit", "q"].includes(input.toLowerCase())) {
      console.log("Ending voice session...");
      rl.close();
      return;
    }

    // Send message and get response
    const msgRes = await fetch(`${TITAN_URL}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: input,
        sessionId: session.sessionId,
      }),
    });

    if (!msgRes.ok) {
      console.error(`Message failed: ${msgRes.status}`);
      continue;
    }

    const msgData = await msgRes.json();
    console.log(`TITAN> ${msgData.content}\n`);

    // In a real implementation, this would send the text to the
    // TTS engine and play the audio over WebRTC. In terminal mode,
    // we just print what would happen.
    if (health.tts.connected && !USE_BROWSER_TTS) {
      console.log(`   [TTS would synthesize: "${msgData.content.slice(0, 80)}..."]\n`);
    } else if (USE_BROWSER_TTS) {
      console.log("   [Browser TTS fallback active]\n");
    }
  }
}

// ============================================================
// WebRTC Connection (Real Voice Mode)
// ============================================================

async function realVoiceMode() {
  console.log("=== TITAN Real-Time Voice Mode ===\n");
  console.log("This mode requires the LiveKit WebRTC SDK.");
  console.log("For full WebRTC voice, run TITAN's gateway with voice enabled:\n");
  console.log("  docker-compose -f docker-compose.voice.yml up -d");
  console.log("  titan dev:gateway\n");
  console.log("Then open Mission Control at http://localhost:48420 and click the Voice button.\n");

  // Still demonstrate health check and session creation
  const health = await checkVoiceHealth();
  console.log(`Voice status: ${health.status}`);

  if (health.status === "unavailable") {
    console.log("\nVoice server is not running. Start it with:");
    console.log("  docker-compose -f docker-compose.voice.yml up -d");
    return;
  }

  const session = await createVoiceSession();
  console.log(`Voice session ready: ${session.roomName}`);
  console.log("\nOpen Mission Control (http://localhost:48420) to use voice chat.");
}

// ============================================================
// Entry Point
// ============================================================

// Detect if we're in a browser-like environment (for WebRTC)
const isBrowser = typeof window !== "undefined";

if (isBrowser || process.argv.includes("--webrtc")) {
  realVoiceMode().catch(console.error);
} else {
  terminalVoiceDemo().catch(console.error);
}
