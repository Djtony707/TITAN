/**
 * TITAN Voice Agent Example — voice capabilities with LiveKit WebRTC + TTS.
 *
 * This demonstrates how to:
 * 1. Check voice system health
 * 2. Test TTS (text-to-speech) with Orpheus
 * 3. List available voice models
 * 4. Trigger voice-based tasks
 *
 * Prerequisites:
 *   - Running TITAN gateway (`titan gateway`)
 *   - Orpheus TTS installed (optional, falls back to browser TTS)
 *
 * Run: npx tsx examples/voice-agent.ts
 */

const TITAN_URL = process.env.TITAN_URL || "http://localhost:48420";

async function checkVoiceHealth() {
  console.log("\nVoice System Status:");
  const res = await fetch(`${TITAN_URL}/api/voice/health`);
  if (!res.ok) {
    console.log(`  Failed to check voice health: ${res.status}`);
    return null;
  }
  const data = await res.json();
  console.log(`  Status: ${data.status || "unknown"}`);
  console.log(`  TTS Available: ${data.tts?.available || "no"}`);
  console.log(`  Current TTS: ${data.tts?.currentEngine || "none"}`);
  if (data.tts?.engineStatus) {
    Object.entries(data.tts.engineStatus).forEach(([engine, status]: [string, any]) => {
      console.log(`    ${engine}: ${status.available ? "available" : "unavailable"}`);
    });
  }
  return data;
}

async function listVoices() {
  console.log("\nAvailable Voices:");
  const res = await fetch(`${TITAN_URL}/api/voice/voices`);
  if (!res.ok) {
    console.log(`  Failed to list voices: ${res.status}`);
    return;
  }
  const data = await res.json();
  if (data.voices && data.voices.length > 0) {
    data.voices.forEach((voice: any) => {
      console.log(`  - ${voice.name} (${voice.provider})`);
      if (voice.description) {
        console.log(`    ${voice.description}`);
      }
    });
  } else {
    console.log("  No voices available");
  }
}

async function testTTS(text = "Hello! I am TITAN, your autonomous AI agent.") {
  console.log(`\nTesting TTS: "${text}"`);

  // TTS is served via WebSocket in the React UI
  // This example shows how to trigger voice-related API calls
  const res = await fetch(`${TITAN_URL}/api/voice/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice: "orca",
      output_path: "/tmp/titan-tts-test.wav",
    }),
  });

  if (!res.ok) {
    console.log(`  TTS synthesis failed: ${res.status}`);
    return;
  }

  const data = await res.json();
  if (data.success) {
    console.log(`  Saved to: ${data.outputPath}`);
  } else {
    console.log(`  Failed: ${data.error}`);
  }
}

async function enableVoiceMode() {
  console.log("\nEnabling voice mode...");

  // Voice mode is enabled via config
  const configRes = await fetch(`${TITAN_URL}/api/config`);
  if (!configRes.ok) {
    console.log(`  Failed to fetch config: ${configRes.status}`);
    return;
  }

  const config = await configRes.json();
  const voiceEnabled = config.voice?.enabled;
  console.log(`  Current voice status: ${voiceEnabled ? "enabled" : "disabled"}`);

  if (!voiceEnabled) {
    console.log("  Enabling voice...");
    const updateRes = await fetch(`${TITAN_URL}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...config,
        voice: { ...config.voice, enabled: true },
      }),
    });

    if (updateRes.ok) {
      console.log("  Voice enabled successfully!");
    } else {
      console.log("  Failed to enable voice");
    }
  }
}

async function main() {
  console.log("TITAN Voice Agent Demo\n");
  console.log("=".repeat(50));

  // Step 1: Check voice health
  await checkVoiceHealth();

  // Step 2: List available voices
  await listVoices();

  // Step 3: Test TTS
  await testTTS();

  // Optional: Enable voice mode
  // await enableVoiceMode();

  console.log("\nVoice capabilities integrated! React UI includes VoiceOverlay for live voice chat.");
  console.log("Voice docs: https://github.com/Djtony707/TITAN/blob/main/docs/VOICE.md");
}

main().catch(console.error);
