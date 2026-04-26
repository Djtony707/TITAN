/**
 * TITAN — Config Schema Tests
 * Tests sub-schemas NOT covered by core.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    TitanConfigSchema,
    MeshConfigSchema,
    AgentConfigSchema,
    SecurityConfigSchema,
    ProviderConfigSchema,
    ChannelConfigSchema,
    GatewayConfigSchema,
} from '../src/config/schema.js';
import { getDefaultConfig, resetConfigCache } from '../src/config/config.js';
import { ALLOWED_TOOLS_DEFAULT } from '../src/utils/constants.js';

describe('MeshConfigSchema', () => {
    it('should have correct defaults', () => {
        const mesh = MeshConfigSchema.parse({});
        expect(mesh.enabled).toBe(false);
        expect(mesh.mdns).toBe(true);
        expect(mesh.tailscale).toBe(true);
        expect(mesh.staticPeers).toEqual([]);
        expect(mesh.allowRemoteModels).toBe(true);
        expect(mesh.maxRemoteTasks).toBe(3);
    });

    it('should accept custom values', () => {
        const mesh = MeshConfigSchema.parse({
            enabled: true, secret: 'mesh-secret-42', mdns: false,
            staticPeers: ['192.168.1.10:48420'], maxRemoteTasks: 10,
        });
        expect(mesh.enabled).toBe(true);
        expect(mesh.secret).toBe('mesh-secret-42');
        expect(mesh.mdns).toBe(false);
        expect(mesh.maxRemoteTasks).toBe(10);
    });
});

describe('AgentConfigSchema', () => {
    it('should have default model aliases including cloud tier', () => {
        const agent = AgentConfigSchema.parse({});
        expect(agent.modelAliases).toEqual({
            fast: 'ollama/qwen3.5:cloud',
            smart: 'ollama/glm-5:cloud',
            reasoning: 'ollama/kimi-k2.6:cloud',
            cheap: 'ollama/qwen3.5:cloud',
            local: 'ollama/qwen3.5:4b',
            cloud: 'ollama/kimi-k2.6:cloud',
        });
    });

    it('should default thinkingMode to medium', () => {
        expect(AgentConfigSchema.parse({}).thinkingMode).toBe('medium');
    });

    it('should reject invalid thinkingMode', () => {
        expect(() => AgentConfigSchema.parse({ thinkingMode: 'turbo' })).toThrow();
    });
});

describe('SecurityConfigSchema', () => {
    it('should default shield to strict', () => {
        const sec = SecurityConfigSchema.parse({});
        expect(sec.shield.enabled).toBe(true);
        expect(sec.shield.mode).toBe('strict');
    });

    it('should have expected allowedTools', () => {
        const sec = SecurityConfigSchema.parse({});
        expect(sec.allowedTools).toEqual(ALLOWED_TOOLS_DEFAULT);
    });

    it('should default deniedTools to empty', () => {
        expect(SecurityConfigSchema.parse({}).deniedTools).toEqual([]);
    });
});

describe('ProviderConfigSchema', () => {
    it('should accept all optional fields', () => {
        const p = ProviderConfigSchema.parse({ apiKey: 'sk-test', temperature: 1.5 });
        expect(p.apiKey).toBe('sk-test');
        expect(p.temperature).toBe(1.5);
    });

    it('should reject temperature outside 0-2', () => {
        expect(() => ProviderConfigSchema.parse({ temperature: 3 })).toThrow();
    });
});

describe('TitanConfigSchema providers', () => {
    it('should include all provider config slots', () => {
        const config = TitanConfigSchema.parse({});
        const keys = Object.keys(config.providers);
        const expected = ['anthropic', 'openai', 'google', 'ollama', 'groq', 'mistral',
            'openrouter', 'fireworks', 'xai', 'together', 'deepseek', 'cerebras', 'cohere', 'perplexity',
            'venice', 'bedrock', 'litellm', 'azure', 'deepinfra', 'sambanova', 'nvidia', 'minimax'];
        for (const name of expected) expect(keys).toContain(name);
        expect(keys).toHaveLength(36);
    });
});

describe('ChannelConfigSchema', () => {
    it('should default dmPolicy to pairing', () => {
        expect(ChannelConfigSchema.parse({}).dmPolicy).toBe('pairing');
    });
});

describe('GatewayConfigSchema', () => {
    it('should default port to 48420', () => {
        expect(GatewayConfigSchema.parse({}).port).toBe(48420);
    });

    it('should default auth mode to token', () => {
        expect(GatewayConfigSchema.parse({}).auth.mode).toBe('token');
    });
});

describe('AutonomySchema', () => {
    it('should default mode to supervised', () => {
        expect(TitanConfigSchema.parse({}).autonomy.mode).toBe('supervised');
    });

    it('should accept all valid modes', () => {
        for (const mode of ['autonomous', 'supervised', 'locked'] as const) {
            expect(TitanConfigSchema.parse({ autonomy: { mode } }).autonomy.mode).toBe(mode);
        }
    });
});

describe('Full config round-trip', () => {
    beforeEach(() => resetConfigCache());

    it('should merge overrides with defaults', () => {
        const config = TitanConfigSchema.parse({
            agent: { model: 'google/gemini-2.5-pro', thinkingMode: 'high' },
            mesh: { enabled: true, secret: 'key' },
            autonomy: { mode: 'autonomous' },
        });
        expect(config.agent.model).toBe('google/gemini-2.5-pro');
        expect(config.agent.temperature).toBe(0.7);
        expect(config.mesh.enabled).toBe(true);
        expect(config.mesh.mdns).toBe(true);
        expect(config.autonomy.mode).toBe('autonomous');
    });

    it('should match getDefaultConfig()', () => {
        expect(getDefaultConfig()).toEqual(TitanConfigSchema.parse({}));
    });
});
