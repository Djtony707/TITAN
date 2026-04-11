/**
 * TITAN — Error Taxonomy Tests
 * Tests the centralized error classification pipeline (P3 from Hermes integration).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { classifyProviderError, shouldAffectCircuitBreaker, FailoverReason, type ClassifiedError } from '../src/providers/errorTaxonomy.js';

describe('Error Taxonomy', () => {
    describe('classifyProviderError', () => {
        // ── Rate Limit (429) ──────────────────────────────────
        it('classifies HTTP 429 as RATE_LIMIT', () => {
            const error = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.RATE_LIMIT);
            expect(result.retryable).toBe(true);
            expect(result.shouldRotateCredential).toBe(true);
            expect(result.httpStatus).toBe(429);
        });

        it('classifies "rate limit" in message without status as RATE_LIMIT', () => {
            const error = new Error('rate limit exceeded for this key');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.RATE_LIMIT);
            expect(result.retryable).toBe(true);
        });

        it('classifies "too many requests" as RATE_LIMIT', () => {
            const error = new Error('Too many requests');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.RATE_LIMIT);
        });

        // ── Auth Errors (401, 403) ────────────────────────────
        it('classifies HTTP 401 as AUTH_INVALID', () => {
            const error = Object.assign(new Error('Unauthorized'), { status: 401 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.AUTH_INVALID);
            expect(result.retryable).toBe(false);
            expect(result.shouldRotateCredential).toBe(true);
            expect(result.shouldFallback).toBe(true);
        });

        it('classifies HTTP 401 with "expired" as AUTH_EXPIRED', () => {
            const error = Object.assign(new Error('Token expired'), { status: 401 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.AUTH_EXPIRED);
            expect(result.retryable).toBe(false);
            expect(result.shouldRotateCredential).toBe(true);
        });

        it('classifies HTTP 403 as AUTH_INVALID', () => {
            const error = Object.assign(new Error('Forbidden'), { status: 403 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.AUTH_INVALID);
        });

        // ── Billing (402) ─────────────────────────────────────
        it('classifies HTTP 402 with billing body as QUOTA_EXCEEDED', () => {
            const error = Object.assign(new Error('Payment required - billing issue'), { status: 402 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.QUOTA_EXCEEDED);
            expect(result.retryable).toBe(false);
            expect(result.shouldRotateCredential).toBe(true);
            expect(result.shouldFallback).toBe(true);
            expect(result.cooldownMs).toBe(3600000);
        });

        it('classifies HTTP 402 without specific body as QUOTA_EXCEEDED', () => {
            const error = Object.assign(new Error('Payment required'), { status: 402 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.QUOTA_EXCEEDED);
        });

        // ── Context Overflow (400) ────────────────────────────
        it('classifies 400 with "context length" as CONTEXT_OVERFLOW', () => {
            const error = Object.assign(new Error('context length exceeded'), { status: 400 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
            expect(result.retryable).toBe(true);
            expect(result.shouldCompress).toBe(true);
        });

        it('classifies 400 with "max tokens" as CONTEXT_OVERFLOW', () => {
            const error = Object.assign(new Error('max tokens exceeded for this model'), { status: 400 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
        });

        it('classifies 400 with "token limit" as CONTEXT_OVERFLOW', () => {
            const error = Object.assign(new Error('Request exceeds the token limit'), { status: 400 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
        });

        it('classifies "context length" in message without status as CONTEXT_OVERFLOW', () => {
            const error = new Error('context length exceeded');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.CONTEXT_OVERFLOW);
        });

        // ── Content Filter (400) ──────────────────────────────
        it('classifies 400 with "content_filter" as CONTENT_FILTERED', () => {
            const error = Object.assign(new Error('content_filter triggered'), { status: 400 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.CONTENT_FILTERED);
            expect(result.retryable).toBe(false);
        });

        it('classifies 400 with "safety" as CONTENT_FILTERED', () => {
            const error = Object.assign(new Error('safety system blocked this request'), { status: 400 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.CONTENT_FILTERED);
        });

        // ── Model Not Found (404) ─────────────────────────────
        it('classifies 404 with model mention as MODEL_NOT_FOUND', () => {
            const error = Object.assign(new Error('Model gpt-5 not found'), { status: 404 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.MODEL_NOT_FOUND);
            expect(result.retryable).toBe(false);
            expect(result.shouldFallback).toBe(true);
        });

        // ── Server Errors (5xx) ───────────────────────────────
        it('classifies 500 as SERVER_ERROR', () => {
            const error = Object.assign(new Error('Internal server error'), { status: 500 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.SERVER_ERROR);
            expect(result.retryable).toBe(true);
        });

        it('classifies 502 as SERVER_ERROR', () => {
            const error = Object.assign(new Error('Bad gateway'), { status: 502 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.SERVER_ERROR);
        });

        it('classifies 503 with overloaded body as OVERLOADED', () => {
            const error = Object.assign(new Error('Service overloaded'), { status: 503 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.OVERLOADED);
            expect(result.retryable).toBe(true);
            expect(result.shouldFallback).toBe(true);
        });

        it('classifies 503 as SERVER_ERROR', () => {
            const error = Object.assign(new Error('Service unavailable'), { status: 503 });
            const result = classifyProviderError(error);
            // "service unavailable" doesn't contain "overloaded" or "capacity"
            // but the 5xx handler defaults to SERVER_ERROR
            expect(result.reason).toBe(FailoverReason.SERVER_ERROR);
        });

        // ── Anthropic Overloaded (529) ────────────────────────
        it('classifies Anthropic 529 as OVERLOADED', () => {
            const error = Object.assign(new Error('Anthropic API overloaded'), { status: 529 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.OVERLOADED);
            expect(result.retryable).toBe(true);
            expect(result.cooldownMs).toBe(10000);
        });

        // ── Timeout ───────────────────────────────────────────
        it('classifies timeout errors', () => {
            const error = new Error('Request timed out');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.TIMEOUT);
            expect(result.retryable).toBe(true);
        });

        it('classifies ETIMEDOUT', () => {
            const error = new Error('connect ETIMEDOUT 1.2.3.4:443');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.TIMEOUT);
        });

        // ── Network Errors ────────────────────────────────────
        it('classifies ECONNREFUSED as NETWORK_ERROR', () => {
            const error = new Error('connect ECONNREFUSED 127.0.0.1:11434');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.NETWORK_ERROR);
            expect(result.retryable).toBe(true);
            expect(result.shouldFallback).toBe(true);
        });

        it('classifies ECONNRESET as NETWORK_ERROR', () => {
            const error = new Error('read ECONNRESET');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.NETWORK_ERROR);
        });

        it('classifies "fetch failed" as NETWORK_ERROR', () => {
            const error = new Error('fetch failed');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.NETWORK_ERROR);
        });

        it('classifies "socket hang up" as NETWORK_ERROR', () => {
            const error = new Error('socket hang up');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.NETWORK_ERROR);
        });

        // ── Format Errors ─────────────────────────────────────
        it('classifies 400 with "invalid" as FORMAT_ERROR', () => {
            const error = Object.assign(new Error('invalid JSON in request body'), { status: 400 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.FORMAT_ERROR);
        });

        // ── Empty Response ────────────────────────────────────
        it('classifies empty response', () => {
            const error = new Error('Empty response from model');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.EMPTY_RESPONSE);
            expect(result.retryable).toBe(true);
        });

        // ── Unknown ───────────────────────────────────────────
        it('classifies unknown errors as UNKNOWN', () => {
            const error = new Error('something completely unexpected');
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.UNKNOWN);
            expect(result.retryable).toBe(false);
        });

        // ── Status extraction from nested objects ─────────────
        it('extracts status from response.status', () => {
            const error = Object.assign(new Error('fail'), { response: { status: 429 } });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.RATE_LIMIT);
            expect(result.httpStatus).toBe(429);
        });

        it('extracts status from statusCode', () => {
            const error = Object.assign(new Error('fail'), { statusCode: 503 });
            const result = classifyProviderError(error);
            expect(result.reason).toBe(FailoverReason.SERVER_ERROR);
            expect(result.httpStatus).toBe(503);
        });

        // ── Non-error inputs ──────────────────────────────────
        it('handles null/undefined gracefully', () => {
            const result = classifyProviderError(null);
            expect(result.reason).toBe(FailoverReason.UNKNOWN);
        });

        it('handles string errors', () => {
            const result = classifyProviderError('timeout error');
            expect(result.reason).toBe(FailoverReason.TIMEOUT);
        });
    });

    describe('shouldAffectCircuitBreaker', () => {
        it('returns true for transient errors', () => {
            const error = Object.assign(new Error('fail'), { status: 500 });
            const classified = classifyProviderError(error);
            expect(shouldAffectCircuitBreaker(classified)).toBe(true);
        });

        it('returns false for AUTH_INVALID', () => {
            const error = Object.assign(new Error('Unauthorized'), { status: 401 });
            const classified = classifyProviderError(error);
            expect(shouldAffectCircuitBreaker(classified)).toBe(false);
        });

        it('returns false for MODEL_NOT_FOUND', () => {
            const error = Object.assign(new Error('Model not found'), { status: 404 });
            const classified = classifyProviderError(error);
            expect(shouldAffectCircuitBreaker(classified)).toBe(false);
        });

        it('returns false for CONTENT_FILTERED', () => {
            const error = Object.assign(new Error('content_filter'), { status: 400 });
            const classified = classifyProviderError(error);
            expect(shouldAffectCircuitBreaker(classified)).toBe(false);
        });

        it('returns true for RATE_LIMIT', () => {
            const error = Object.assign(new Error('Rate limited'), { status: 429 });
            const classified = classifyProviderError(error);
            expect(shouldAffectCircuitBreaker(classified)).toBe(true);
        });

        it('returns true for OVERLOADED', () => {
            const error = Object.assign(new Error('Overloaded'), { status: 529 });
            const classified = classifyProviderError(error);
            expect(shouldAffectCircuitBreaker(classified)).toBe(true);
        });
    });

    describe('recovery profiles', () => {
        it('CONTEXT_OVERFLOW recommends compression', () => {
            const error = Object.assign(new Error('context length exceeded'), { status: 400 });
            const result = classifyProviderError(error);
            expect(result.shouldCompress).toBe(true);
            expect(result.cooldownMs).toBe(0);
        });

        it('QUOTA_EXCEEDED has 1-hour cooldown', () => {
            const error = Object.assign(new Error('billing issue'), { status: 402 });
            const result = classifyProviderError(error);
            expect(result.cooldownMs).toBe(3600000);
        });

        it('OVERLOADED recommends fallback', () => {
            const error = Object.assign(new Error('overloaded'), { status: 529 });
            const result = classifyProviderError(error);
            expect(result.shouldFallback).toBe(true);
        });
    });
});
