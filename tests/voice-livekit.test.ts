/**
 * TITAN — Voice Configuration Tests (LiveKit)
 * Tests for the LiveKit-based voice config schema and gateway endpoints.
 */
import { describe, it, expect } from 'vitest';

it('keeps local F5 configuration usable without enabling LiveKit credentials', async () => {
  const { VoiceConfigSchema } = await import('../src/config/schema.js');
  const voice = VoiceConfigSchema.parse({ ttsEngine: 'f5-tts', ttsUrl: 'http://localhost:5006' });
  expect(voice.ttsEngine).toBe('f5-tts');
  expect(voice.ttsUrl).toBe('http://localhost:5006');
  expect(voice.livekitApiSecret).toBe('');
});

// ─── VoiceConfigSchema ──────────────────────────────────────────
describe('VoiceConfigSchema', () => {
  it('should parse empty voice config with defaults', async () => {
    const { VoiceConfigSchema } = await import('../src/config/schema.js');
    const result = VoiceConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.livekitUrl).toBe('ws://localhost:7880');
    expect(result.livekitApiKey).toBe('');
    expect(result.livekitApiSecret).toBe('');
    expect(result.agentUrl).toBe('http://localhost:8081');
    expect(result.ttsVoice).toBe('andrew');
  });

  it('should accept valid voice config', async () => {
    const { VoiceConfigSchema } = await import('../src/config/schema.js');
    const result = VoiceConfigSchema.parse({
      enabled: true,
      livekitUrl: 'ws://<titan-host>:7880',
      livekitApiKey: 'mykey',
      livekitApiSecret: 'mysecret',
      agentUrl: 'http://localhost:8081',
      ttsVoice: 'af_bella',
    });
    expect(result.enabled).toBe(true);
    expect(result.livekitUrl).toBe('ws://<titan-host>:7880');
    expect(result.livekitApiKey).toBe('mykey');
    expect(result.ttsVoice).toBe('af_bella');
  });

  it('should use defaults for partial config', async () => {
    const { VoiceConfigSchema } = await import('../src/config/schema.js');
    const result = VoiceConfigSchema.parse({ enabled: true });
    expect(result.livekitUrl).toBe('ws://localhost:7880');
    expect(result.livekitApiKey).toBe('');
    expect(result.livekitApiSecret).toBe('');
    expect(result.ttsVoice).toBe('andrew');
  });

  it('should accept custom ttsVoice', async () => {
    const { VoiceConfigSchema } = await import('../src/config/schema.js');
    const result = VoiceConfigSchema.parse({
      enabled: true,
      ttsVoice: 'am_michael',
    });
    expect(result.ttsVoice).toBe('am_michael');
  });
});

// ─── TitanConfig voice integration ──────────────────────────────
describe('TitanConfig voice integration', () => {
  it('should include voice in full config', async () => {
    const { TitanConfigSchema } = await import('../src/config/schema.js');
    const result = TitanConfigSchema.parse({});
    expect(result.voice).toBeDefined();
    expect(result.voice.enabled).toBe(false);
    expect(result.voice.livekitUrl).toBe('ws://localhost:7880');
  });

  it('should merge voice overrides into full config', async () => {
    const { TitanConfigSchema } = await import('../src/config/schema.js');
    const result = TitanConfigSchema.parse({
      voice: {
        enabled: true,
        livekitUrl: 'ws://10.0.0.5:7880',
        ttsVoice: 'bf_emma',
      },
    });
    expect(result.voice.enabled).toBe(true);
    expect(result.voice.livekitUrl).toBe('ws://10.0.0.5:7880');
    expect(result.voice.ttsVoice).toBe('bf_emma');
    // Defaults still apply for unset fields
    expect(result.voice.livekitApiKey).toBe('');
    expect(result.voice.livekitApiSecret).toBe('');
    expect(result.voice.agentUrl).toBe('http://localhost:8081');
  });
});
