/**
 * TITAN — Centralized Error Taxonomy
 *
 * Replaces scattered error handling across router.ts, toolRunner.ts, and server.ts
 * with a single 7-step classification pipeline. Inspired by Hermes error_classifier.py.
 *
 * Each provider error is classified into a FailoverReason with structured recovery hints
 * (retryable, shouldCompress, shouldRotateCredential, shouldFallback, cooldownMs).
 */
import logger from '../utils/logger.js';

const COMPONENT = 'ErrorTaxonomy';

// ── Error Categories ──────────────────────────────────────────────
export enum FailoverReason {
    RATE_LIMIT = 'rate_limit',
    QUOTA_EXCEEDED = 'quota_exceeded',
    CONTEXT_OVERFLOW = 'context_overflow',
    AUTH_INVALID = 'auth_invalid',
    AUTH_EXPIRED = 'auth_expired',
    MODEL_NOT_FOUND = 'model_not_found',
    CONTENT_FILTERED = 'content_filtered',
    SERVER_ERROR = 'server_error',
    TIMEOUT = 'timeout',
    NETWORK_ERROR = 'network_error',
    OVERLOADED = 'overloaded',
    EMPTY_RESPONSE = 'empty_response',
    FORMAT_ERROR = 'format_error',
    UNKNOWN = 'unknown',
}

// ── Classification Result ─────────────────────────────────────────
export interface ClassifiedError {
    /** The category of failure */
    reason: FailoverReason;
    /** HTTP status code if available */
    httpStatus?: number;
    /** Whether this error can be retried with the same provider/key */
    retryable: boolean;
    /** Whether context compression might resolve the issue */
    shouldCompress: boolean;
    /** Whether the API key should be rotated (for credential pools) */
    shouldRotateCredential: boolean;
    /** Whether to try a different provider entirely */
    shouldFallback: boolean;
    /** Suggested delay before retry in ms (0 = no delay) */
    cooldownMs: number;
    /** Human-readable error message */
    message: string;
}

// ── Default recovery profiles ─────────────────────────────────────
const RECOVERY_PROFILES: Record<FailoverReason, Omit<ClassifiedError, 'reason' | 'httpStatus' | 'message'>> = {
    [FailoverReason.RATE_LIMIT]: {
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: false,
        cooldownMs: 5000,
    },
    [FailoverReason.QUOTA_EXCEEDED]: {
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: true,
        cooldownMs: 3600000, // 1 hour
    },
    [FailoverReason.CONTEXT_OVERFLOW]: {
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: false,
        cooldownMs: 0,
    },
    [FailoverReason.AUTH_INVALID]: {
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: true,
        cooldownMs: 0,
    },
    [FailoverReason.AUTH_EXPIRED]: {
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: false,
        cooldownMs: 0,
    },
    [FailoverReason.MODEL_NOT_FOUND]: {
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
        cooldownMs: 0,
    },
    [FailoverReason.CONTENT_FILTERED]: {
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        cooldownMs: 0,
    },
    [FailoverReason.SERVER_ERROR]: {
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        cooldownMs: 2000,
    },
    [FailoverReason.TIMEOUT]: {
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        cooldownMs: 1000,
    },
    [FailoverReason.NETWORK_ERROR]: {
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
        cooldownMs: 2000,
    },
    [FailoverReason.OVERLOADED]: {
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
        cooldownMs: 10000,
    },
    [FailoverReason.EMPTY_RESPONSE]: {
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        cooldownMs: 1000,
    },
    [FailoverReason.FORMAT_ERROR]: {
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        cooldownMs: 0,
    },
    [FailoverReason.UNKNOWN]: {
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        cooldownMs: 0,
    },
};

// ── Status code extraction ────────────────────────────────────────
function extractStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const e = error as Record<string, unknown>;
    // Direct status property
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    // Nested in response
    if (e.response && typeof e.response === 'object') {
        const resp = e.response as Record<string, unknown>;
        if (typeof resp.status === 'number') return resp.status;
        if (typeof resp.statusCode === 'number') return resp.statusCode;
    }
    // Check error property (Anthropic SDK)
    if (e.error && typeof e.error === 'object') {
        const nested = e.error as Record<string, unknown>;
        if (typeof nested.status === 'number') return nested.status;
    }
    return undefined;
}

// ── Error body extraction ─────────────────────────────────────────
function extractBody(error: unknown): string {
    if (!error || typeof error !== 'object') return '';
    const e = error as Record<string, unknown>;
    const parts: string[] = [];

    if (typeof e.message === 'string') parts.push(e.message);
    if (e.response && typeof e.response === 'object') {
        const resp = e.response as Record<string, unknown>;
        if (typeof resp.data === 'string') parts.push(resp.data);
        if (resp.data && typeof resp.data === 'object') {
            try { parts.push(JSON.stringify(resp.data)); } catch { /* skip */ }
        }
    }
    if (e.body && typeof e.body === 'string') parts.push(e.body);
    if (e.error && typeof e.error === 'object') {
        try { parts.push(JSON.stringify(e.error)); } catch { /* skip */ }
    }
    return parts.join(' ').toLowerCase();
}

// ── Build result helper ───────────────────────────────────────────
function buildResult(reason: FailoverReason, status: number | undefined, message: string): ClassifiedError {
    return {
        reason,
        httpStatus: status,
        message,
        ...RECOVERY_PROFILES[reason],
    };
}

// ── 7-Step Classification Pipeline ────────────────────────────────
/**
 * Classify a provider error into a structured recovery recommendation.
 *
 * Pipeline steps:
 * 1. Extract HTTP status code
 * 2. Extract error body text
 * 3. Match exact status codes (429, 401, 402, 404, 503, 529)
 * 4. Disambiguate 400 (context overflow vs content filter vs format error)
 * 5. Disambiguate 402 (billing vs quota)
 * 6. Match network/timeout patterns from error message
 * 7. Default to UNKNOWN
 */
export function classifyProviderError(error: unknown): ClassifiedError {
    // Step 1: Extract HTTP status
    const status = extractStatus(error);
    const msg = (error as Error)?.message || String(error);

    // Step 2: Extract body text for pattern matching
    const body = extractBody(error);

    // Step 3: Match exact status codes
    if (status === 429) {
        return buildResult(FailoverReason.RATE_LIMIT, status, msg);
    }

    if (status === 401) {
        // Step 3a: Disambiguate expired vs invalid auth
        if (body.includes('expired') || body.includes('token expired') || body.includes('refresh')) {
            return buildResult(FailoverReason.AUTH_EXPIRED, status, msg);
        }
        return buildResult(FailoverReason.AUTH_INVALID, status, msg);
    }

    if (status === 403) {
        return buildResult(FailoverReason.AUTH_INVALID, status, msg);
    }

    if (status === 404) {
        if (body.includes('model') || body.includes('not found') || body.includes('does not exist')) {
            return buildResult(FailoverReason.MODEL_NOT_FOUND, status, msg);
        }
        return buildResult(FailoverReason.UNKNOWN, status, msg);
    }

    // Step 4: Disambiguate 400 errors
    if (status === 400) {
        if (body.includes('context length') || body.includes('maximum context') ||
            body.includes('max tokens') || body.includes('token limit') ||
            body.includes('too long') || body.includes('too many tokens') ||
            body.includes('context window') || body.includes('input too large')) {
            return buildResult(FailoverReason.CONTEXT_OVERFLOW, status, msg);
        }
        if (body.includes('content_filter') || body.includes('content filter') ||
            body.includes('safety') || body.includes('harmful') ||
            body.includes('flagged') || body.includes('blocked')) {
            return buildResult(FailoverReason.CONTENT_FILTERED, status, msg);
        }
        if (body.includes('invalid') || body.includes('malformed') ||
            body.includes('parse') || body.includes('json')) {
            return buildResult(FailoverReason.FORMAT_ERROR, status, msg);
        }
        return buildResult(FailoverReason.FORMAT_ERROR, status, msg);
    }

    // Step 5: Disambiguate 402 (billing vs transient quota)
    if (status === 402) {
        if (body.includes('billing') || body.includes('payment') ||
            body.includes('subscription') || body.includes('plan')) {
            return buildResult(FailoverReason.QUOTA_EXCEEDED, status, msg);
        }
        // Default 402 to quota exceeded (usually means out of credits)
        return buildResult(FailoverReason.QUOTA_EXCEEDED, status, msg);
    }

    // Anthropic overloaded (529)
    if (status === 529) {
        return buildResult(FailoverReason.OVERLOADED, status, msg);
    }

    // 5xx server errors
    if (status && status >= 500 && status < 600) {
        if (body.includes('overloaded') || body.includes('capacity')) {
            return buildResult(FailoverReason.OVERLOADED, status, msg);
        }
        return buildResult(FailoverReason.SERVER_ERROR, status, msg);
    }

    // Step 6: Match patterns from error message (no status code available)
    const lowerMsg = msg.toLowerCase();

    // Timeout patterns
    if (lowerMsg.includes('timed out') || lowerMsg.includes('timeout') ||
        lowerMsg.includes('etimedout') || lowerMsg.includes('aborted')) {
        // v4.10.0-local (cost cap): claude-code timeouts are NOT retryable.
        // Each retry burns another ~2 min of MAX plan quota on what is
        // probably a stuck tool loop; better to fail fast and let the
        // fallback-ladder try a cheaper model.
        if (lowerMsg.includes('claude cli') || lowerMsg.includes('claude-code')) {
            return {
                ...buildResult(FailoverReason.TIMEOUT, status, msg),
                retryable: false,
                shouldFallback: true,
                cooldownMs: 0,
            };
        }
        return buildResult(FailoverReason.TIMEOUT, status, msg);
    }

    // Rate limit patterns (from message without status code)
    if (lowerMsg.includes('rate limit') || lowerMsg.includes('rate_limit') ||
        lowerMsg.includes('too many requests') || lowerMsg.includes('quota exceeded') ||
        lowerMsg.includes('429')) {
        return buildResult(FailoverReason.RATE_LIMIT, status, msg);
    }

    // Network/connection patterns
    if (lowerMsg.includes('econnrefused') || lowerMsg.includes('econnreset') ||
        lowerMsg.includes('econnaborted') || lowerMsg.includes('epipe') ||
        lowerMsg.includes('enotfound') || lowerMsg.includes('fetch failed') ||
        lowerMsg.includes('network error') || lowerMsg.includes('socket hang up') ||
        lowerMsg.includes('connection closed') || lowerMsg.includes('connection refused') ||
        lowerMsg.includes('dns')) {
        return buildResult(FailoverReason.NETWORK_ERROR, status, msg);
    }

    // Overloaded patterns
    if (lowerMsg.includes('overloaded') || lowerMsg.includes('service unavailable') ||
        lowerMsg.includes('capacity') || lowerMsg.includes('503') || lowerMsg.includes('502')) {
        return buildResult(FailoverReason.OVERLOADED, status, msg);
    }

    // Server error patterns
    if (lowerMsg.includes('500') || lowerMsg.includes('internal server error') ||
        lowerMsg.includes('server error')) {
        return buildResult(FailoverReason.SERVER_ERROR, status, msg);
    }

    // Auth patterns from message
    if (lowerMsg.includes('unauthorized') || lowerMsg.includes('invalid api key') ||
        lowerMsg.includes('invalid_api_key') || lowerMsg.includes('authentication')) {
        return buildResult(FailoverReason.AUTH_INVALID, status, msg);
    }

    // Context overflow patterns from message
    if (lowerMsg.includes('context length') || lowerMsg.includes('token limit') ||
        lowerMsg.includes('too long') || lowerMsg.includes('context window')) {
        return buildResult(FailoverReason.CONTEXT_OVERFLOW, status, msg);
    }

    // Empty response
    if (lowerMsg.includes('empty response') || lowerMsg.includes('no content') ||
        lowerMsg.includes('null response')) {
        return buildResult(FailoverReason.EMPTY_RESPONSE, status, msg);
    }

    // Step 7: Default
    logger.debug(COMPONENT, `Unclassified error (status=${status}): ${msg.slice(0, 200)}`);
    return buildResult(FailoverReason.UNKNOWN, status, msg);
}

/**
 * Check if a classified error should prevent the circuit breaker from opening.
 * Auth errors and model-not-found are config problems, not provider instability.
 */
export function shouldAffectCircuitBreaker(classified: ClassifiedError): boolean {
    return classified.reason !== FailoverReason.AUTH_INVALID
        && classified.reason !== FailoverReason.AUTH_EXPIRED
        && classified.reason !== FailoverReason.MODEL_NOT_FOUND
        && classified.reason !== FailoverReason.CONTENT_FILTERED
        && classified.reason !== FailoverReason.FORMAT_ERROR;
}

/**
 * Hunt Finding #37 (2026-04-14): a shared helper for building errors from
 * a failed fetch Response. Previous code pattern was:
 *
 *     throw new Error(`Provider error (${response.status}): ${errorText}`);
 *
 * This dropped the `Retry-After` header on the floor. Downstream code in
 * router.ts tried `(error as Response)?.headers?.get?.('Retry-After')`
 * which always returned undefined at runtime because the error is an
 * Error object, not a Response. Result: Retry-After headers were NEVER
 * respected, even though the code pretended to.
 *
 * New pattern: use this helper to attach status + parsed Retry-After
 * (in ms) + the original body snippet to the error, so router.ts can
 * read them back via typed properties.
 */
export interface ProviderHttpError extends Error {
    status?: number;
    retryAfterMs?: number | null;
    provider?: string;
    model?: string;
}

export function createProviderError(
    providerDisplayName: string,
    response: { status: number; headers?: { get(name: string): string | null } },
    errorText: string,
    opts?: { provider?: string; model?: string },
): ProviderHttpError {
    const err: ProviderHttpError = new Error(
        `${providerDisplayName} error (${response.status}): ${errorText}`,
    );
    err.status = response.status;
    err.provider = opts?.provider;
    err.model = opts?.model;

    // Parse Retry-After at throw time — router.ts reads err.retryAfterMs later
    try {
        const raw = response.headers?.get('Retry-After');
        if (raw) {
            const sec = parseInt(raw, 10);
            if (Number.isFinite(sec)) {
                err.retryAfterMs = Math.max(0, Math.min(sec * 1000, 300_000));
            } else {
                const date = new Date(raw);
                if (!isNaN(date.getTime())) {
                    err.retryAfterMs = Math.max(0, Math.min(date.getTime() - Date.now(), 300_000));
                }
            }
        }
    } catch {
        // Header parsing failures are non-fatal — just fall back to calculated backoff.
    }

    return err;
}
