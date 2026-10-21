import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useExternalCliFixture } from './helpers/external-cli-fixture.js';

vi.mock('../src/config/config.js', () => ({ loadConfig: () => ({
    agent: { model: 'anthropic/fixture', modelAliases: { legacy_cli: 'claude-code/default' }, fallbackChain: ['anthropic/fixture'] },
    providers: {},
}) }));
vi.mock('../src/utils/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { chat, chatStream, getProvider, resolveModel } from '../src/providers/router.js';
const fixture = useExternalCliFixture();
beforeEach(() => vi.clearAllMocks());

describe('Claude CLI router policy', () => {
    it.each(['claude-code/default', 'claude_code/default', 'Claude Code/default', 'legacy_cli'])('rejects model %s before provider dispatch or fallback', async (model) => {
        const cliChat = vi.spyOn(getProvider('claude-code')!, 'chat').mockResolvedValue({
            id: 'fixture', content: 'should not be returned', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: 'stop', model,
        });
        const apiChat = vi.spyOn(getProvider('anthropic')!, 'chat').mockRejectedValue(new Error('Unexpected API fallback'));
        expect(() => resolveModel(model)).toThrow(/disabled by TITAN standing policy/);
        await expect(chat({ model, messages: [], providerOptions: { allowClaudeCode: true } })).rejects.toThrow(/disabled by TITAN standing policy/);
        await expect(async () => { for await (const _chunk of chatStream({ model, messages: [] })) { /* drain */ } }).rejects.toThrow(/disabled by TITAN standing policy/);
        expect(cliChat).not.toHaveBeenCalled();
        expect(apiChat).not.toHaveBeenCalled();
        expect(fixture.invocations()).toEqual([]);
        vi.restoreAllMocks();
    });

    it('retains ordinary Anthropic API and local-model resolution', () => {
        expect(resolveModel('anthropic/claude-sonnet-4-20250514').provider.name).toBe('anthropic');
        expect(resolveModel('ollama/local-fixture').provider.name).toBe('ollama');
    });
});
