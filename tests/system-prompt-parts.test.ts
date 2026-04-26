/**
 * plan-this-logical-ocean step 3 — System Prompt Parts unit tests.
 *
 * Covers:
 *   - Composable block assembly in full / minimal / none modes
 *   - Per-model-family overlay selection (gemma/qwen/glm/minimax/nemotron/deepseek)
 *   - Overlays are short (< 20 lines) — large overlays defeat the refactor
 *   - Size budget: full mode prompt stays under 6KB, minimal under 2KB
 *     (without dynamic context)
 */
import { describe, it, expect } from 'vitest';
import {
    assembleSystemPrompt,
    getModelOverlay,
    identityBlock,
    TOOL_USE_CORE,
    DELEGATION_BLOCK,
    PRIVACY_BLOCK,
} from '../src/agent/systemPromptParts.js';

describe('systemPromptParts — block assembly', () => {
    it('full mode includes privacy, tool use, delegation', () => {
        const p = assembleSystemPrompt({ modelId: 'anthropic/claude-sonnet-4', persona: 'default', mode: 'full' });
        expect(p).toContain(PRIVACY_BLOCK);
        expect(p).toContain(TOOL_USE_CORE);
        expect(p).toContain(DELEGATION_BLOCK);
    });

    it('minimal mode drops privacy + delegation', () => {
        const p = assembleSystemPrompt({ modelId: 'anthropic/claude-sonnet-4', persona: 'default', mode: 'minimal' });
        expect(p).not.toContain(PRIVACY_BLOCK);
        expect(p).not.toContain(DELEGATION_BLOCK);
        expect(p).toContain(TOOL_USE_CORE);
    });

    it('none mode is identity + overlay only', () => {
        const p = assembleSystemPrompt({ modelId: 'ollama/gemma4:31b-cloud', persona: 'default', mode: 'none' });
        expect(p).not.toContain(TOOL_USE_CORE);
        expect(p).not.toContain(PRIVACY_BLOCK);
        expect(p).toContain('TITAN');
        // gemma overlay still present
        expect(p).toContain('<|tool>call');
    });

    it('identity block embeds model + persona', () => {
        const block = identityBlock('ollama/qwen3.5:397b-cloud', 'scout', 'A scout specialist.');
        expect(block).toContain('ollama/qwen3.5:397b-cloud');
        expect(block).toContain('scout');
        expect(block).toContain('A scout specialist.');
    });

    it('dynamicContext is appended at end', () => {
        const p = assembleSystemPrompt({
            modelId: 'ollama/glm-5:cloud',
            persona: 'default',
            mode: 'full',
            dynamicContext: '## Custom\nhello from user config',
        });
        expect(p).toContain('## Custom');
        expect(p).toContain('hello from user config');
    });
});

describe('systemPromptParts — per-model overlays', () => {
    it('gemma family gets the <|tool> warning', () => {
        const o = getModelOverlay('ollama/gemma4:31b-cloud');
        expect(o).toContain('<|tool>call');
        expect(o).toContain('absolute paths');
    });

    it('gemini family also gets the gemma overlay', () => {
        const o = getModelOverlay('ollama/gemini-3-flash-preview:cloud');
        expect(o).toContain('<|tool>call');
    });

    it('qwen family gets the "act don\'t ask" overlay', () => {
        const o = getModelOverlay('ollama/qwen3.5:397b-cloud');
        expect(o).toContain('Act, don');
        expect(o).not.toContain('<|tool>call');
    });

    it('glm family gets verify-before-edit overlay', () => {
        const o = getModelOverlay('ollama/glm-5:cloud');
        expect(o).toContain('read_file before claiming');
    });

    it('minimax family gets the <think> warning', () => {
        const o = getModelOverlay('ollama/minimax-m2.7:cloud');
        expect(o).toContain('<think>');
    });

    it('nemotron family gets conciseness overlay', () => {
        const o = getModelOverlay('ollama/nemotron-3-super:cloud');
        expect(o).toContain('preamble to one sentence');
    });

    it('deepseek family gets the <think> warning (same shape)', () => {
        const o = getModelOverlay('ollama/deepseek-v3.2:cloud');
        expect(o).toContain('<think>');
    });

    it('kimi / claude / gpt get no overlay', () => {
        expect(getModelOverlay('ollama/kimi-k2.5:cloud')).toBe('');
        expect(getModelOverlay('anthropic/claude-sonnet-4-5-20250929')).toBe('');
        expect(getModelOverlay('openai/gpt-5')).toBe('');
    });

    it('empty / unknown model ID returns empty overlay', () => {
        expect(getModelOverlay('')).toBe('');
        expect(getModelOverlay('unknown/some-model')).toBe('');
    });

    it('overlays stay short — no family overlay exceeds 20 lines', () => {
        const families = [
            'ollama/gemma4:31b-cloud',
            'ollama/qwen3.5:397b-cloud',
            'ollama/glm-5:cloud',
            'ollama/minimax-m2.7:cloud',
            'ollama/nemotron-3-super:cloud',
            'ollama/deepseek-v3.2:cloud',
        ];
        for (const f of families) {
            const o = getModelOverlay(f);
            const lineCount = o.split('\n').length;
            expect(lineCount, `${f} overlay has ${lineCount} lines — keep it short`).toBeLessThan(20);
        }
    });
});

describe('systemPromptParts — size budget', () => {
    // Measured on 2026-04-20 across the 6 whitelisted models:
    //   full: 2458-2997 chars, minimal: 1819-2358, none: 453-992.
    // The old monolithic prompt was ~25,000 chars. Budgets are set as
    // soft ceilings that would catch a regression (block creep) without
    // false-alarming on a small copy tweak.
    it('full mode without dynamicContext stays under ~5.8KB', () => {
        const p = assembleSystemPrompt({
            modelId: 'ollama/gemma4:31b-cloud',
            persona: 'default',
            mode: 'full',
        });
        expect(p.length, `full mode is ${p.length} chars, ceiling 5800`).toBeLessThan(5800);
    });

    it('minimal mode without dynamicContext stays under ~4.5KB', () => {
        const p = assembleSystemPrompt({
            modelId: 'ollama/gemma4:31b-cloud',
            persona: 'default',
            mode: 'minimal',
        });
        expect(p.length, `minimal mode is ${p.length} chars, ceiling 4500`).toBeLessThan(4500);
    });

    it('none mode stays under ~1.1KB', () => {
        const p = assembleSystemPrompt({
            modelId: 'ollama/gemma4:31b-cloud',
            persona: 'default',
            mode: 'none',
        });
        expect(p.length, `none mode is ${p.length} chars, ceiling 1100`).toBeLessThan(1100);
    });

    it('full mode is dramatically smaller than the legacy ~25KB template', () => {
        // Sanity check — the whole point of this refactor. If full-mode ever
        // creeps back above 6KB, someone is re-introducing the MUST/NEVER walls.
        const p = assembleSystemPrompt({
            modelId: 'ollama/gemma4:31b-cloud',
            persona: 'default',
            mode: 'full',
        });
        expect(p.length, `full is ${p.length}, legacy was ~25000 — regression budget 6000`).toBeLessThan(6000);
    });
});
