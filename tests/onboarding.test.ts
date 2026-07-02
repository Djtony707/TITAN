import { describe, it, expect } from 'vitest';
import { buildProviderConfigPatch } from '../src/gateway/onboarding.js';

describe('welcome-mode config patches', () => {
    it('ollama: prefixes the model and strips a duplicate prefix', () => {
        const p = buildProviderConfigPatch({ kind: 'ollama', model: 'ollama/qwen3.5' }) as Record<string, { model?: string }>;
        expect(p.agent.model).toBe('ollama/qwen3.5');
    });

    it('ollama: custom base URL lands under providers', () => {
        const p = buildProviderConfigPatch({ kind: 'ollama', model: 'qwen3.5', baseUrl: 'http://gx10:11434/' }) as Record<string, Record<string, { baseUrl?: string }>>;
        expect(p.providers.ollama.baseUrl).toBe('http://gx10:11434');
    });

    it('cloud: key required, default model filled', () => {
        expect(buildProviderConfigPatch({ kind: 'anthropic' })).toBeNull();
        const p = buildProviderConfigPatch({ kind: 'anthropic', apiKey: 'sk-ant-x' }) as Record<string, { model?: string }>;
        expect(p.agent.model).toMatch(/^anthropic\//);
    });

    it('openai_compat: needs base URL and model; blank key becomes placeholder', () => {
        expect(buildProviderConfigPatch({ kind: 'openai_compat', baseUrl: 'http://x:4000/v1' })).toBeNull();
        const p = buildProviderConfigPatch({ kind: 'openai_compat', baseUrl: 'http://x:4000/v1/', model: 'qwen3-30b' }) as Record<string, Record<string, { apiKey?: string; baseUrl?: string }>> & { agent: { model: string } };
        expect(p.providers.litellm.baseUrl).toBe('http://x:4000/v1');
        expect(p.providers.litellm.apiKey).toBe('not-needed');
        expect(p.agent.model).toBe('litellm/qwen3-30b');
    });

    it('rejects unknown kinds', () => {
        expect(buildProviderConfigPatch({ kind: 'nope' as never })).toBeNull();
    });
});
