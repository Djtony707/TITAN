/**
 * Gap 1 (plan-this-logical-ocean) — Error Taxonomy shouldCompress coverage.
 *
 * These tests don't exercise the router retry loop (that needs a full
 * provider mock + fake fetch); they pin down the taxonomy's classification
 * for the specific error shapes that must set `shouldCompress: true`, which
 * is what the router now reads. If these regress, the router wiring is
 * effectively dead code again.
 */
import { describe, it, expect } from 'vitest';
import { classifyProviderError, FailoverReason } from '../src/providers/errorTaxonomy.js';

describe('errorTaxonomy — shouldCompress wiring (Gap 1)', () => {
    it('sets shouldCompress=true for "maximum context length exceeded" 400s', () => {
        const err = Object.assign(new Error('400 Bad Request — maximum context length is 32000 tokens'), {
            status: 400,
        });
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
        expect(classified.shouldCompress).toBe(true);
        expect(classified.retryable).toBe(true);
    });

    it('sets shouldCompress=true for "token limit" 400s', () => {
        const err = Object.assign(new Error('Request exceeds the token limit for this model.'), {
            status: 400,
        });
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
        expect(classified.shouldCompress).toBe(true);
    });

    it('sets shouldCompress=true for "context window" in error message', () => {
        const err = Object.assign(new Error('Input exceeds the context window'), {
            status: 400,
        });
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
        expect(classified.shouldCompress).toBe(true);
    });

    it('sets shouldCompress=true for context-length patterns without status code', () => {
        const err = new Error('token limit exceeded for this request');
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
        expect(classified.shouldCompress).toBe(true);
    });

    it('does NOT set shouldCompress for rate limits', () => {
        const err = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.RATE_LIMIT);
        expect(classified.shouldCompress).toBe(false);
    });

    it('does NOT set shouldCompress for content filter 400s', () => {
        const err = Object.assign(new Error('Content was flagged by safety filter'), { status: 400 });
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.CONTENT_FILTERED);
        expect(classified.shouldCompress).toBe(false);
    });

    it('does NOT set shouldCompress for format errors', () => {
        const err = Object.assign(new Error('400 Bad Request: invalid JSON in tool arguments'), {
            status: 400,
        });
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.FORMAT_ERROR);
        expect(classified.shouldCompress).toBe(false);
    });

    it('does NOT set shouldCompress for server errors', () => {
        const err = Object.assign(new Error('500 Internal Server Error'), { status: 500 });
        const classified = classifyProviderError(err);
        expect(classified.reason).toBe(FailoverReason.SERVER_ERROR);
        expect(classified.shouldCompress).toBe(false);
    });
});
