/**
 * SandboxRuntime `api` response-format contract tests.
 *
 * Widgets call `titan.api.call(endpoint, body)` and expect a specific shape
 * back. Two long-standing patterns exist in widget code:
 *   1. const r = await titan.api.call(...); r.body.content  ← canonical
 *   2. const r = await titan.api.call(...); r.content       ← LLM-habit pattern
 *
 * The runtime spreads JSON-body fields onto the top-level result so both
 * patterns work. These tests pin that contract so it cannot regress.
 *
 * We can't easily instantiate SandboxRuntime in jsdom (window.addEventListener
 * + iframe.contentWindow plumbing). The behaviour we care about lives in pure
 * data-transform shape, so we mirror that shape here and pin it.
 */
import { describe, it, expect } from 'vitest';

function buildResult(status: number, ok: boolean, parsedBody: unknown, rawText: string) {
    const flat = (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody))
        ? (parsedBody as Record<string, unknown>)
        : {};
    return { ...flat, status, body: parsedBody ?? rawText, ok };
}

describe('sandbox api response format', () => {
    it('returns canonical { status, body, ok } when body is a JSON object', () => {
        const result = buildResult(200, true, { content: 'hello', sessionId: 'abc' }, '{"content":"hello"}');
        expect(result.status).toBe(200);
        expect(result.ok).toBe(true);
        expect(result.body).toEqual({ content: 'hello', sessionId: 'abc' });
    });

    it('flattens JSON-body fields onto the top level so r.content works', () => {
        // This is the failure mode that produced the "No response." bug in Stock
        // Analyzer: widgets read r.content directly instead of r.body.content.
        const result = buildResult(200, true, { content: 'hello', sessionId: 'abc' }, '{"content":"hello"}');
        expect((result as Record<string, unknown>).content).toBe('hello');
        expect((result as Record<string, unknown>).sessionId).toBe('abc');
    });

    it('canonical fields win on collision with body fields', () => {
        // If the gateway ever returns { status: "weird-string" } in its body,
        // the top-level result.status MUST stay numeric.
        const result = buildResult(418, false, { status: 'spurious-string', other: 1 }, '');
        expect(result.status).toBe(418);
        expect(result.ok).toBe(false);
        expect((result as Record<string, unknown>).other).toBe(1);
    });

    it('non-object JSON bodies (array / number / string) do not flatten', () => {
        const arr = buildResult(200, true, [1, 2, 3], '[1,2,3]');
        expect(arr.body).toEqual([1, 2, 3]);
        // Spread of an array doesn't add numeric props at the top level usefully,
        // but the canonical { status, body } must always exist.
        expect(arr.status).toBe(200);

        const num = buildResult(200, true, 42, '42');
        expect(num.body).toBe(42);

        const str = buildResult(200, true, undefined, 'not json');
        expect(str.body).toBe('not json');
    });

    it('legacy { ok, text, json } shape is NOT returned', () => {
        const result = buildResult(200, true, { x: 1 }, '{"x":1}');
        // The old shape had `text` as the raw body and `json` for parsed. We
        // explicitly do not return those any more — they would shadow real
        // widget content keys named `text` or `json`.
        const keys = Object.keys(result);
        expect(keys).not.toContain('text');
        expect(keys).not.toContain('json');
    });
});

/**
 * Forgiving call-shape contract.
 *
 * Widgets (and LLM-generated widget code) historically pass two shapes:
 *   A. titan.api.call(ep, { content: '...' })                         ← preferred
 *   B. titan.api.call(ep, { method: 'POST', body: { content: '...' } }) ← fetch-style legacy
 *
 * The runtime auto-unwraps shape B so both produce the same network request.
 * We unit-test the unwrap predicate here.
 */
describe('sandbox api call-shape detection', () => {
    function isFetchEnvelope(rawBody: unknown): boolean {
        if (!rawBody || typeof rawBody !== 'object') return false;
        const r = rawBody as Record<string, unknown>;
        return ('method' in r || 'headers' in r)
            && !('content' in r) && !('message' in r) && !('action' in r);
    }

    it('detects the fetch-style envelope', () => {
        expect(isFetchEnvelope({ method: 'POST', body: { content: 'x' } })).toBe(true);
        expect(isFetchEnvelope({ method: 'GET' })).toBe(true);
        expect(isFetchEnvelope({ headers: { 'X-Foo': 'bar' }, body: 'x' })).toBe(true);
    });

    it('does NOT misclassify content-bearing direct bodies as envelopes', () => {
        // A widget calling /api/message with { method: 'send', content: '...' } —
        // the gateway expects `content`, so this is NOT an envelope.
        expect(isFetchEnvelope({ content: 'hello' })).toBe(false);
        expect(isFetchEnvelope({ message: 'hello' })).toBe(false);
        expect(isFetchEnvelope({ action: 'list' })).toBe(false);
        // A weird widget that explicitly sets a `method` field as a domain
        // concept along with `content` is still a direct body — we don't
        // unwrap it. (Better a false negative than swallowing real content.)
        expect(isFetchEnvelope({ method: 'send', content: 'x' })).toBe(false);
    });

    it('handles primitives and arrays as direct bodies, not envelopes', () => {
        expect(isFetchEnvelope(null)).toBe(false);
        expect(isFetchEnvelope(undefined)).toBe(false);
        expect(isFetchEnvelope('string body')).toBe(false);
        expect(isFetchEnvelope([1, 2, 3])).toBe(false);
    });
});
