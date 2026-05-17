/**
 * Regression coverage for Mac-local provider deny switches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
    mockConfig: {
        providers: {
            anthropic: {
                enabled: true,
                apiKey: '',
                authProfiles: [],
                rotationStrategy: 'priority',
                credentialCooldownMs: 60_000,
            },
        },
    },
}));

vi.mock('../src/config/config.js', () => ({
    loadConfig: () => mockConfig,
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AnthropicProvider } from '../src/providers/anthropic.js';

describe('AnthropicProvider provider disable switch', () => {
    afterEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
        mockConfig.providers.anthropic.enabled = true;
        mockConfig.providers.anthropic.apiKey = '';
    });

    it('is not configured when disabled even if config and env keys exist', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
        mockConfig.providers.anthropic.enabled = false;
        mockConfig.providers.anthropic.apiKey = 'sk-ant-config';

        const provider = new AnthropicProvider();

        expect(provider.isConfigured()).toBe(false);
    });
});
