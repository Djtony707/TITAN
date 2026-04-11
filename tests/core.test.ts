/**
 * TITAN — Unit Tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TitanConfigSchema } from '../src/config/schema.js';
import { getDefaultConfig, resetConfigCache } from '../src/config/config.js';
import { truncate, formatBytes, formatDuration, deepMerge, shortId } from '../src/utils/helpers.js';
import {
    TITAN_VERSION, TITAN_NAME, TITAN_FULL_NAME,
    DEFAULT_GATEWAY_PORT, DEFAULT_MODEL,
} from '../src/utils/constants.js';
import { LLMProvider } from '../src/providers/base.js';

// ─── Constants ──────────────────────────────────────────────────
describe('Constants', () => {
    it('should have correct version', () => {
        expect(TITAN_VERSION).toBe('2.8.6');
    });

    it('should have correct name', () => {
        expect(TITAN_NAME).toBe('TITAN');
        expect(TITAN_FULL_NAME).toBe('The Intelligent Task Automation Network');
    });

    it('should have valid default port', () => {
        expect(DEFAULT_GATEWAY_PORT).toBe(48420);
    });

    it('should have valid default model', () => {
        expect(DEFAULT_MODEL).toContain('anthropic/');
    });
});

// ─── Helpers ────────────────────────────────────────────────────
describe('Helpers', () => {
    describe('truncate', () => {
        it('should not truncate short strings', () => {
            expect(truncate('hello', 10)).toBe('hello');
        });

        it('should truncate long strings', () => {
            expect(truncate('hello world', 8)).toBe('hello...');
        });
    });

    describe('formatBytes', () => {
        it('should format zero bytes', () => {
            expect(formatBytes(0)).toBe('0 B');
        });

        it('should format kilobytes', () => {
            expect(formatBytes(1024)).toBe('1 KB');
        });

        it('should format megabytes', () => {
            expect(formatBytes(1048576)).toBe('1 MB');
        });
    });

    describe('formatDuration', () => {
        it('should format milliseconds', () => {
            expect(formatDuration(500)).toBe('500ms');
        });

        it('should format seconds', () => {
            expect(formatDuration(5000)).toBe('5.0s');
        });

        it('should format minutes', () => {
            expect(formatDuration(120000)).toBe('2m 0s');
        });
    });

    describe('deepMerge', () => {
        it('should merge flat objects', () => {
            const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
            expect(result).toEqual({ a: 1, b: 3, c: 4 });
        });

        it('should merge nested objects', () => {
            const result = deepMerge(
                { a: { x: 1, y: 2 }, b: 3 },
                { a: { y: 5, z: 6 } },
            );
            expect(result).toEqual({ a: { x: 1, y: 5, z: 6 }, b: 3 });
        });
    });

    describe('shortId', () => {
        it('should generate a string', () => {
            const id = shortId();
            expect(typeof id).toBe('string');
            expect(id.length).toBeGreaterThan(0);
        });

        it('should generate unique ids', () => {
            const ids = new Set(Array.from({ length: 100 }, () => shortId()));
            expect(ids.size).toBe(100);
        });
    });
});

// ─── Config Schema ──────────────────────────────────────────────
describe('Config Schema', () => {
    it('should parse empty config with defaults', () => {
        const result = TitanConfigSchema.parse({});
        expect(result.agent.model).toContain('anthropic/');
        expect(result.agent.maxTokens).toBe(8192);
        expect(result.agent.temperature).toBe(0.7);
        expect(result.gateway.port).toBe(48420);
        expect(result.security.sandboxMode).toBe('host');
    });

    it('should validate model override', () => {
        const result = TitanConfigSchema.parse({
            agent: { model: 'openai/gpt-4o' },
        });
        expect(result.agent.model).toBe('openai/gpt-4o');
    });

    it('should validate channel config', () => {
        const result = TitanConfigSchema.parse({
            channels: {
                discord: { enabled: true, token: 'test-token' },
            },
        });
        expect(result.channels.discord.enabled).toBe(true);
        expect(result.channels.discord.token).toBe('test-token');
        expect(result.channels.discord.dmPolicy).toBe('pairing');
    });

    it('should validate security config', () => {
        const result = TitanConfigSchema.parse({
            security: {
                sandboxMode: 'docker',
                deniedTools: ['shell'],
            },
        });
        expect(result.security.sandboxMode).toBe('docker');
        expect(result.security.deniedTools).toContain('shell');
    });

    it('should reject invalid temperature', () => {
        expect(() => TitanConfigSchema.parse({
            agent: { temperature: 5 },
        })).toThrow();
    });
});

// ─── Default Config ─────────────────────────────────────────────
describe('Config Manager', () => {
    beforeEach(() => {
        resetConfigCache();
    });

    it('should return a valid default config', () => {
        const config = getDefaultConfig();
        expect(config.agent.model).toBeDefined();
        expect(config.gateway.port).toBe(48420);
        expect(config.security.allowedTools).toBeInstanceOf(Array);
    });
});

// ─── Provider Base ──────────────────────────────────────────────
describe('LLM Provider', () => {
    describe('parseModelId', () => {
        it('should parse provider/model format', () => {
            const result = LLMProvider.parseModelId('anthropic/claude-3-opus');
            expect(result.provider).toBe('anthropic');
            expect(result.model).toBe('claude-3-opus');
        });

        it('should default to anthropic for plain model names', () => {
            const result = LLMProvider.parseModelId('claude-3-opus');
            expect(result.provider).toBe('anthropic');
            expect(result.model).toBe('claude-3-opus');
        });

        it('should handle nested model paths', () => {
            const result = LLMProvider.parseModelId('openai/gpt-4/turbo');
            expect(result.provider).toBe('openai');
            expect(result.model).toBe('gpt-4/turbo');
        });
    });
});
