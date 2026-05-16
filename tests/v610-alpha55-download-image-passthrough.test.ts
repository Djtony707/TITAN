/**
 * TITAN — v6.1.0-alpha.55 download_image output-pipeline regression
 *
 * Tony asked me to check the logs after the alpha.54 MLK essay
 * run. The Writer called `download_image` 8 times — the tool
 * worked. But the final HTML still had an external `<img
 * src="https://upload.wikimedia.org/…">` URL instead of an
 * inlined `data:image/jpeg;base64,…`. Log line:
 *
 *   Tool download_image output truncated: 779570 → 25034 chars
 *
 * Two layers of context-protection in ToolRunner were each
 * killing the feature on its way back to the LLM:
 *
 *   1. `sanitizeBase64()` (toolRunner.ts:76) — strips ALL
 *      `data:image/...;base64,…` URIs from EVERY tool result
 *      and replaces them with `[image: NNN KB omitted]` to
 *      prevent token explosion from vision / screenshot tools.
 *      Necessary for those — but it was also stripping
 *      `download_image`'s output, whose entire purpose is to
 *      return a data URL.
 *
 *   2. The 30KB head-tail smart-truncation block right after
 *      (toolRunner.ts:681) — even if sanitization had been
 *      skipped, a 779KB data URL would be cut to a 25KB
 *      head+tail concatenation, which is also unusable.
 *
 *   3. `capToolOutput()` in toolOutputCap.ts — applies the
 *      100KB hard cap from Anthropic's effective-tools guidance
 *      after the agent loop completes. Same issue: chopping
 *      mid-base64 yields garbage.
 *
 * alpha.55 adds a shared `DATA_URL_PRODUCING_TOOLS` set
 * (currently just `download_image`) and exempts those tools
 * from all three trimming passes. These tests pin every
 * exemption so a future refactor can't silently strip the URL
 * again.
 */
import { describe, it, expect } from 'vitest';
import { capToolOutput, DEFAULT_OUTPUT_CAP } from '../src/agent/toolOutputCap.js';
import { isDataUrlProducingTool } from '../src/agent/toolRunner.js';

const SAMPLE_DATA_URL = 'data:image/jpeg;base64,' + 'A'.repeat(800_000); // ~800KB, well over both caps

describe('v6.1.0-alpha.55 — capToolOutput exempts data-URL tools', () => {
    it('does NOT truncate download_image output even when very large', () => {
        const payload = JSON.stringify({ ok: true, dataUrl: SAMPLE_DATA_URL, mimeType: 'image/jpeg', sizeBytes: 600000 });
        expect(payload.length).toBeGreaterThan(DEFAULT_OUTPUT_CAP);
        const result = capToolOutput('download_image', payload);
        expect(result.truncated).toBe(false);
        expect(result.content).toBe(payload);
        expect(result.content).toContain('A'.repeat(800));
    });

    it('still truncates an unrelated large tool output (sanity check)', () => {
        const bigBlob = 'X'.repeat(DEFAULT_OUTPUT_CAP + 50_000);
        const result = capToolOutput('shell', bigBlob);
        expect(result.truncated).toBe(true);
        expect(result.content.length).toBeLessThan(bigBlob.length);
        expect(result.hint).toBeTruthy();
    });

    it('still truncates web_fetch (a common offender)', () => {
        const bigPage = 'P'.repeat(DEFAULT_OUTPUT_CAP + 1);
        const result = capToolOutput('web_fetch', bigPage);
        expect(result.truncated).toBe(true);
    });

    it('passes through small download_image outputs unmodified', () => {
        const small = JSON.stringify({ ok: true, dataUrl: 'data:image/png;base64,iVBOR' });
        const result = capToolOutput('download_image', small);
        expect(result.truncated).toBe(false);
        expect(result.content).toBe(small);
    });
});

describe('v6.1.0-alpha.55 — isDataUrlProducingTool registry', () => {
    it('lists download_image', () => {
        expect(isDataUrlProducingTool('download_image')).toBe(true);
    });

    it('does NOT list general-purpose tools', () => {
        expect(isDataUrlProducingTool('shell')).toBe(false);
        expect(isDataUrlProducingTool('web_fetch')).toBe(false);
        expect(isDataUrlProducingTool('screenshot')).toBe(false);
        expect(isDataUrlProducingTool('generate_image')).toBe(false);
        expect(isDataUrlProducingTool('analyze_image')).toBe(false);
        // Empty / nonsense
        expect(isDataUrlProducingTool('')).toBe(false);
        expect(isDataUrlProducingTool('not_a_real_tool')).toBe(false);
    });
});

describe('v6.1.0-alpha.55 — semantic guard: alpha.53 + alpha.55 together', () => {
    it('a realistic download_image payload survives end-to-end size policy', () => {
        // Simulate a moderate-size MLK portrait — ~270KB base64 ≈ 200KB raw
        const realistic = JSON.stringify({
            ok: true,
            dataUrl: 'data:image/jpeg;base64,' + 'B'.repeat(270_000),
            mimeType: 'image/jpeg',
            sizeBytes: 200_000,
        });
        const result = capToolOutput('download_image', realistic);
        expect(result.truncated).toBe(false);
        expect(result.content).toContain('data:image/jpeg;base64,');
        // The base64 body must remain intact — chopping it yields garbage.
        expect(result.content.length).toBe(realistic.length);
    });
});
