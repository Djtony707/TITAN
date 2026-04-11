/**
 * TITAN — Universal Model Router
 * Routes model requests to the correct provider with failover, alias resolution,
 * and live model discovery across all configured providers (including local Ollama).
 *
 * Error Recovery Features:
 * - Exponential backoff retry for transient failures (429, 503, timeouts)
 * - Circuit breaker pattern to avoid hammering failing providers
 * - Automatic fallback to next provider in chain on persistent errors
 * - Detailed error messages including provider name and model
 */
import { LLMProvider, type ChatOptions, type ChatResponse, type ChatStreamChunk } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatProvider, PROVIDER_PRESETS } from './openai_compat.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { findModelOnMesh } from '../mesh/registry.js';
import type { MeshPeer } from '../mesh/discovery.js';
import { routeTaskToNode } from '../mesh/transport.js';
import { randomBytes } from 'crypto';
import { sleep } from '../utils/helpers.js';
import { classifyProviderError, shouldAffectCircuitBreaker, FailoverReason } from './errorTaxonomy.js';
import { getExistingPool } from './credentialPool.js';

const COMPONENT = 'Router';

// ── Provider name normalization ─────────────────────────────────
const PROVIDER_ALIASES: Record<string, string> = {
    'z.ai': 'xai',
    'zai': 'xai',
    'grok': 'xai',
    'local': 'ollama',
    'vertex': 'google',
    'vertex-ai': 'google',
    'azure-openai': 'azure',
    'aws': 'bedrock',
    'amazon': 'bedrock',
    'litellm-proxy': 'litellm',
    'hf': 'huggingface',
    'hugging-face': 'huggingface',
    '01ai': 'yi',
    '01.ai': 'yi',
    'glm': 'zhipu',
    'bigmodel': 'zhipu',
    'pi': 'inflection',
    'octoai': 'octo',
    'nim': 'nvidia',
    'nvidia-nim': 'nvidia',
};

/** Normalize provider names for consistency (e.g. "grok" → "xai", "local" → "ollama") */
export function normalizeProvider(name: string): string {
    const lower = name.toLowerCase();
    return PROVIDER_ALIASES[lower] || lower;
}

/** Provider registry */
const providers: Map<string, LLMProvider> = new Map();
let initialized = false;

function initProviders(): void {
    if (initialized) return;
    // Core providers (custom implementations)
    providers.set('anthropic', new AnthropicProvider());
    providers.set('openai', new OpenAIProvider());
    providers.set('google', new GoogleProvider());
    providers.set('ollama', new OllamaProvider());
    // OpenAI-compatible providers (Groq, Mistral, OpenRouter, xAI, etc.)
    for (const preset of PROVIDER_PRESETS) {
        providers.set(preset.name, new OpenAICompatProvider(preset));
    }
    initialized = true;
}

/** Get a provider by name */
export function getProvider(name: string): LLMProvider | undefined {
    initProviders();
    return providers.get(name);
}

/** Get all registered providers */
export function getAllProviders(): Map<string, LLMProvider> {
    initProviders();
    return providers;
}

/** Resolve a model alias (e.g. "fast" → "openai/gpt-4o-mini") */
function resolveAlias(modelId: string): string {
    const config = loadConfig();
    const aliases = config.agent.modelAliases;
    if (aliases && aliases[modelId]) {
        const resolved = aliases[modelId];
        logger.debug(COMPONENT, `Alias "${modelId}" → "${resolved}"`);
        return resolved;
    }
    return modelId;
}

// ── Cloud model → OpenRouter bypass ──────────────────────────────────
// Ollama's cloud proxy is single-connection (sequential). When multiple agents
// send requests simultaneously, they queue. Bypass by routing :cloud models
// directly to OpenRouter for parallel processing.
const CLOUD_TO_OPENROUTER: Record<string, string> = {
    'qwen3-coder-next:cloud': 'qwen/qwen3-coder',
    'qwen3.5:397b-cloud': 'qwen/qwen-3.5-397b',
    'nemotron-3-super:cloud': 'nvidia/nemotron-3-super',
    'deepseek-v3.1:671b-cloud': 'deepseek/deepseek-chat-v3-0324',
    'deepseek-v3.2:671b-cloud': 'deepseek/deepseek-chat-v3-0324',
    'devstral-2:cloud': 'mistralai/devstral-2',
    'glm-5:cloud': 'thudm/glm-4-32b',
    'kimi-k2.5:cloud': 'moonshotai/kimi-k2',
    'gpt-oss:120b-cloud': 'openai/gpt-4.1',
    'minimax-m2.7:cloud': 'minimax/minimax-m1-80k',
};

/** Resolve the provider and model from a model ID like "anthropic/claude-3" or alias like "fast" */
export function resolveModel(modelId: string): { provider: LLMProvider; model: string } {
    initProviders();
    // First resolve aliases
    const resolved = resolveAlias(modelId);
    const { provider: rawProviderName, model } = LLMProvider.parseModelId(resolved);

    // ── Cloud bypass: route :cloud models to OpenRouter for parallel processing ──
    if ((model.includes(':cloud') || model.includes('-cloud')) && rawProviderName === 'ollama') {
        const orProvider = providers.get('openrouter');
        const orModel = CLOUD_TO_OPENROUTER[model];
        if (orProvider && orModel) {
            logger.info(COMPONENT, `[CloudBypass] ${model} → openrouter/${orModel} (parallel-capable)`);
            return { provider: orProvider, model: orModel };
        }
        // Fallback: unknown cloud model, keep on Ollama
        logger.debug(COMPONENT, `[CloudBypass] No OpenRouter mapping for ${model}, keeping on Ollama`);
    }

    // Normalize provider name (e.g. "grok" → "xai", "local" → "ollama")
    const providerName = normalizeProvider(rawProviderName);
    const provider = providers.get(providerName);
    if (!provider) {
        throw new Error(`Unknown provider: ${providerName}. Available: ${Array.from(providers.keys()).join(', ')}`);
    }
    return { provider, model };
}

/** Check if a model is allowed by the allowlist. Empty list = all allowed. */
export function isModelAllowed(modelId: string): boolean {
    const config = loadConfig();
    const allowedModels = config.agent.allowedModels;
    if (!allowedModels || allowedModels.length === 0) return true;

    // Resolve alias first
    const resolved = resolveAlias(modelId);

    for (const pattern of allowedModels) {
        if (pattern === resolved) return true;
        // Wildcard support: "openai/*" matches "openai/gpt-4o"
        if (pattern.endsWith('/*')) {
            const prefix = pattern.slice(0, -1); // "openai/"
            if (resolved.startsWith(prefix)) return true;
        }
    }
    return false;
}

/** Discovered model info */
export interface DiscoveredModel {
    id: string;          // Full ID e.g. "ollama/llama3.1"
    provider: string;    // Provider name e.g. "ollama"
    model: string;       // Model name e.g. "llama3.1"
    displayName: string; // Provider display name e.g. "Ollama (Local)"
    source: 'static' | 'live'; // Whether discovered via live API or hardcoded list
}

/** Cache for discovered models (refreshed on demand, 60s TTL) */
let modelCache: { models: DiscoveredModel[]; timestamp: number } | null = null;
const MODEL_CACHE_TTL = 60_000; // 60 seconds

/**
 * Discover all available models across all providers.
 * Queries each provider's listModels() — for Ollama this hits the local API
 * to find actually-installed models. Results are cached for 60s.
 */
export async function discoverAllModels(forceRefresh = false): Promise<DiscoveredModel[]> {
    initProviders();

    if (!forceRefresh && modelCache && (Date.now() - modelCache.timestamp) < MODEL_CACHE_TTL) {
        return modelCache.models;
    }

    const discovered: DiscoveredModel[] = [];
    const health = await healthCheckAll();

    const tasks = Array.from(providers.entries()).map(async ([name, provider]) => {
        try {
            const models = await provider.listModels();
            const isLive = health[name] === true;
            for (const model of models) {
                discovered.push({
                    id: `${name}/${model}`,
                    provider: name,
                    model,
                    displayName: provider.displayName,
                    source: (name === 'ollama' && isLive) ? 'live' : 'static',
                });
            }
        } catch (err) {
            logger.debug(COMPONENT, `Failed to list models for ${name}: ${(err as Error).message}`);
        }
    });

    await Promise.all(tasks);

    modelCache = { models: discovered, timestamp: Date.now() };
    logger.info(COMPONENT, `Discovered ${discovered.length} models across ${providers.size} providers`);
    return discovered;
}

/** Get current model aliases from config */
export function getModelAliases(): Record<string, string> {
    const config = loadConfig();
    return config.agent.modelAliases || {};
}

// ── Circuit Breaker ─────────────────────────────────────────────
/** Circuit breaker states for each provider */
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerState {
    state: CircuitState;
    failureCount: number;
    lastFailureTime: number | null;
    lastSuccessTime: number | null;
    openSince: number | null;
}

/** Circuit breaker configuration */
const CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 5,        // Number of failures before opening circuit
    resetTimeout: 30000,        // 30s before trying again (half-open)
    monitoringWindow: 60000,    // 60s window for counting failures
    successThreshold: 3,        // Successes needed in half-open to close circuit
};

/** Track circuit breaker state per provider */
const circuitBreakers = new Map<string, CircuitBreakerState>();

/**
 * Get or create circuit breaker state for a provider.
 */
function getCircuitBreaker(providerName: string): CircuitBreakerState {
    if (!circuitBreakers.has(providerName)) {
        circuitBreakers.set(providerName, {
            state: 'closed',
            failureCount: 0,
            lastFailureTime: null,
            lastSuccessTime: null,
            openSince: null,
        });
    }
    return circuitBreakers.get(providerName)!;
}

/**
 * Record a successful request for a provider.
 * Resets failure count and updates state appropriately.
 */
function recordSuccess(providerName: string): void {
    const cb = getCircuitBreaker(providerName);
    cb.lastSuccessTime = Date.now();

    if (cb.state === 'half-open') {
        // In half-open state, success reduces the counter
        cb.failureCount = Math.max(0, cb.failureCount - 1);
        // If we've had enough successes, close the circuit
        if (cb.failureCount <= 0) {
            cb.state = 'closed';
            cb.openSince = null;
            cb.failureCount = 0;
            logger.info(COMPONENT, `[CircuitBreaker] ${providerName} circuit CLOSED after successful recovery`);
        }
    } else if (cb.state === 'closed') {
        // In closed state, reset the failure count on success
        cb.failureCount = 0;
    }
}

/**
 * Record a failed request for a provider.
 * Opens circuit if failure threshold is exceeded.
 */
function recordFailure(providerName: string): void {
    const cb = getCircuitBreaker(providerName);
    const now = Date.now();
    cb.lastFailureTime = now;

    // Only count failures within the monitoring window
    const windowStart = now - CIRCUIT_BREAKER_CONFIG.monitoringWindow;
    if (cb.lastFailureTime && cb.lastFailureTime < windowStart) {
        // Reset if outside monitoring window
        cb.failureCount = 1;
    } else {
        cb.failureCount++;
    }

    // Check if we should open the circuit
    if (cb.failureCount >= CIRCUIT_BREAKER_CONFIG.failureThreshold && cb.state === 'closed') {
        cb.state = 'open';
        cb.openSince = now;
        logger.warn(COMPONENT, `[CircuitBreaker] ${providerName} circuit OPENED after ${cb.failureCount} failures`);
    }
}

/**
 * Check if a provider's circuit breaker allows requests.
 * Returns true if closed or if half-open (time to test).
 * Returns false if open and still in timeout period.
 */
function canRequest(providerName: string): boolean {
    const cb = getCircuitBreaker(providerName);

    if (cb.state === 'closed') {
        return true;
    }

    if (cb.state === 'open') {
        const now = Date.now();
        if (cb.openSince && (now - cb.openSince) >= CIRCUIT_BREAKER_CONFIG.resetTimeout) {
            // Timeout expired, transition to half-open
            cb.state = 'half-open';
            cb.failureCount = CIRCUIT_BREAKER_CONFIG.successThreshold; // Need this many successes to close
            logger.info(COMPONENT, `[CircuitBreaker] ${providerName} circuit transitioned to HALF-OPEN (testing)`);
            return true;
        }
        return false; // Still open, don't try
    }

    // half-open: allow testing
    return true;
}

/**
 * Get circuit breaker status for all providers (for health dashboards).
 */
export function getCircuitBreakerStatus(): Record<string, { state: CircuitState; failureCount: number; openSince?: number }> {
    const status: Record<string, { state: CircuitState; failureCount: number; openSince?: number }> = {};
    for (const [providerName, cb] of circuitBreakers) {
        status[providerName] = {
            state: cb.state,
            failureCount: cb.failureCount,
            ...(cb.openSince !== null ? { openSince: cb.openSince } : {}),
        };
    }
    return status;
}

/**
 * Reset all circuit breaker state (for testing).
 * NOT exported to production API - test use only.
 */
export function __resetCircuitBreakers__(): void {
    circuitBreakers.clear();
    lastFallbackEvent = null;
}

// ── Fallback chain state ─────────────────────────────────────────
/** Tracks the most recent fallback event for dashboard display */
let lastFallbackEvent: { primary: string; active: string; reason: string; timestamp: number } | null = null;

/** Get the current fallback state (for dashboard display) */
export function getFallbackState(): { primary: string; active: string; reason: string; timestamp: number } | null {
    // Expire after 5 minutes
    if (lastFallbackEvent && (Date.now() - lastFallbackEvent.timestamp) > 300_000) {
        lastFallbackEvent = null;
    }
    return lastFallbackEvent;
}

/** Retry configuration with exponential backoff */
const RETRY_CONFIG = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,  // 30 second cap
    backoffMultiplier: 2,
    jitter: true,
};

/**
 * Calculate delay with exponential backoff and optional jitter.
 * delay = min(initialDelay * multiplier^attempt, maxDelay)
 */
function calculateBackoffDelay(attempt: number): number {
    const exponentialDelay = RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
    const cappedDelay = Math.min(exponentialDelay, RETRY_CONFIG.maxDelayMs);

    if (RETRY_CONFIG.jitter) {
        // Add random jitter (±20%) to prevent thundering herd
        const jitterRange = cappedDelay * 0.4;
        const jitter = jitterRange * (Math.random() - 0.5);
        return Math.max(100, cappedDelay + jitter);
    }

    return cappedDelay;
}

/** Parse retry-after header value (seconds or HTTP date) */
function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;

    // Try parsing as seconds
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds)) {
        return Math.min(seconds * 1000, RETRY_CONFIG.maxDelayMs); // Cap at max delay
    }

    // Try parsing as HTTP date
    const date = new Date(header);
    if (!isNaN(date.getTime())) {
        const delay = date.getTime() - Date.now();
        return Math.max(1000, Math.min(delay, RETRY_CONFIG.maxDelayMs)); // Min 1s, max configured cap
    }

    return null;
}

/**
 * Check if an error is retryable using the centralized error taxonomy.
 */
function isRetryableError(error: unknown): boolean {
    return classifyProviderError(error).retryable;
}

/**
 * Extract HTTP status code from an error object if present.
 */
function getErrorStatus(error: unknown): number | undefined {
    return classifyProviderError(error).httpStatus;
}

/** Try the fallback chain for a chat request. Returns null if chain is empty or exhausted. */
async function tryFallbackChain(
    options: ChatOptions,
    primaryModelId: string,
    originalError: Error,
): Promise<ChatResponse | null> {
    const config = loadConfig();
    const chain = config.agent.fallbackChain;
    if (!chain || chain.length === 0) return null;

    const maxRetries = config.agent.fallbackMaxRetries ?? 3;
    let attempts = 0;

    for (const fallbackModelId of chain) {
        if (attempts >= maxRetries) break;
        if (fallbackModelId === primaryModelId) continue;

        attempts++;
        try {
            const { provider: fbProvider, model: fbModel } = resolveModel(fallbackModelId);
            const fbProviderName = fbProvider.name;

            // Check circuit breaker for fallback provider
            if (!canRequest(fbProviderName)) {
                const cb = getCircuitBreaker(fbProviderName);
                logger.warn(COMPONENT, `Skipping fallback ${fallbackModelId} — circuit breaker OPEN (${cb.failureCount} failures)`);
                continue;
            }

            logger.warn(COMPONENT, `Model ${primaryModelId} failed (${originalError.message}), falling back to ${fallbackModelId}`);
            const result = await fbProvider.chat({ ...options, model: fbModel });

            // Record success for circuit breaker
            recordSuccess(fbProviderName);

            lastFallbackEvent = {
                primary: primaryModelId,
                active: fallbackModelId,
                reason: originalError.message,
                timestamp: Date.now(),
            };
            return result;
        } catch (chainErr) {
            // Record failure for circuit breaker
            try {
                const { provider: fbProvider } = resolveModel(fallbackModelId);
                recordFailure(fbProvider.name);
            } catch {
                // Ignore if we can't resolve the provider for recording
            }
            logger.warn(COMPONENT, `Fallback model ${fallbackModelId} also failed: ${(chainErr as Error).message}`);
            continue;
        }
    }
    return null;
}

/** Try the fallback chain for a streaming request. Returns an async generator or null if exhausted. */
async function tryFallbackChainStream(
    options: ChatOptions,
    primaryModelId: string,
    originalError: Error,
): Promise<AsyncGenerator<ChatStreamChunk> | null> {
    const config = loadConfig();
    const chain = config.agent.fallbackChain;
    if (!chain || chain.length === 0) return null;

    const maxRetries = config.agent.fallbackMaxRetries ?? 3;
    let attempts = 0;

    for (const fallbackModelId of chain) {
        if (attempts >= maxRetries) break;
        if (fallbackModelId === primaryModelId) continue;

        attempts++;
        try {
            const { provider: fbProvider, model: fbModel } = resolveModel(fallbackModelId);
            const fbProviderName = fbProvider.name;

            // Check circuit breaker for fallback provider
            if (!canRequest(fbProviderName)) {
                const cb = getCircuitBreaker(fbProviderName);
                logger.warn(COMPONENT, `Skipping stream fallback ${fallbackModelId} — circuit breaker OPEN (${cb.failureCount} failures)`);
                continue;
            }

            logger.warn(COMPONENT, `Stream model ${primaryModelId} failed (${originalError.message}), falling back to ${fallbackModelId}`);
            // Verify the provider responds by getting the generator (will throw on immediate errors)
            const gen = fbProvider.chatStream({ ...options, model: fbModel });

            // Record success for circuit breaker (optimistically, actual success tracked in chatStream)
            recordSuccess(fbProviderName);

            lastFallbackEvent = {
                primary: primaryModelId,
                active: fallbackModelId,
                reason: originalError.message,
                timestamp: Date.now(),
            };
            return gen;
        } catch (chainErr) {
            // Record failure for circuit breaker
            try {
                const { provider: fbProvider } = resolveModel(fallbackModelId);
                recordFailure(fbProvider.name);
            } catch {
                // Ignore if we can't resolve the provider for recording
            }
            logger.warn(COMPONENT, `Fallback stream model ${fallbackModelId} also failed: ${(chainErr as Error).message}`);
            continue;
        }
    }
    return null;
}

/** Route a chat request to a mesh peer */
async function meshChat(peer: MeshPeer, modelId: string, message: string): Promise<ChatResponse> {
    const requestId = randomBytes(8).toString('hex');
    const config = loadConfig();
    const timeoutMs = config.mesh?.taskTimeoutMs || 120_000;
    logger.info(COMPONENT, `Routing "${modelId}" to mesh peer ${peer.hostname} (${peer.nodeId.slice(0, 8)}...)`);
    const result = await routeTaskToNode(peer.nodeId, requestId, message, modelId, timeoutMs) as Record<string, unknown>;
    if (result.error) {
        throw new Error(`Mesh peer error: ${result.error}`);
    }
    return result as unknown as ChatResponse;
}

/**
 * Enhanced error message with provider and model context.
 */
function createEnhancedErrorMessage(error: Error, providerName: string, model: string, attempt: number): string {
    const status = getErrorStatus(error);
    const statusInfo = status ? `[HTTP ${status}] ` : '';

    return [
        `Provider ${providerName}/${model} failed`,
        statusInfo + error.message,
        attempt > 0 ? `(attempt ${attempt + 1})` : null,
    ].filter(Boolean).join(': ');
}

/**
 * Send a chat request with exponential backoff retry and circuit breaker protection.
 * Automatically routes to the correct provider with error recovery and fallback chain.
 */
export async function chat(options: ChatOptions): Promise<ChatResponse> {
    const modelId = options.model || 'anthropic/claude-sonnet-4-20250514';
    const { provider, model } = resolveModel(modelId);
    const providerName = provider.name;

    logger.info(COMPONENT, `Routing to ${provider.displayName} (model: ${model})`);

    // Check circuit breaker before attempting request
    if (!canRequest(providerName)) {
        const cb = getCircuitBreaker(providerName);
        const errorMsg = `Circuit breaker OPEN for ${providerName}/${model} (${cb.failureCount} failures, reset in ${
            cb.openSince ? Math.round((CIRCUIT_BREAKER_CONFIG.resetTimeout - (Date.now() - cb.openSince)) / 1000) : 'unknown'
        }s)`;
        logger.warn(COMPONENT, errorMsg);
        const enhancedError = new Error(errorMsg);
        Object.assign(enhancedError, { status: 503, provider: providerName, model });
        throw enhancedError;
    }

    let lastError: Error | null = null;
    const maxRetries = RETRY_CONFIG.maxRetries;

    // Attempt request with retry logic
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await provider.chat({ ...options, model });

            // Record success for circuit breaker
            recordSuccess(providerName);
            lastFallbackEvent = null; // Clear fallback state on primary success

            // Log if this was a retry that succeeded
            if (attempt > 0) {
                logger.info(COMPONENT, `${provider.displayName}/${model} recovered after ${attempt} retry attempt(s)`);
            }

            return result;
        } catch (error) {
            lastError = error as Error;

            // Classify error using centralized taxonomy
            const classified = classifyProviderError(error);

            // Only affect circuit breaker for genuine provider instability
            if (shouldAffectCircuitBreaker(classified)) {
                recordFailure(providerName);
            }

            // Exhaust credential in pool if rotation is recommended
            if (classified.shouldRotateCredential) {
                const pool = getExistingPool(providerName);
                if (pool) {
                    // Find which credential was used and exhaust it
                    const status = pool.status();
                    const lastUsed = status.find(s => s.available);
                    if (lastUsed) {
                        pool.exhaust(lastUsed.name, classified.cooldownMs || 60000);
                    }
                }
            }

            const errorMsg = createEnhancedErrorMessage(error as Error, providerName, model, attempt);

            // Check if we should retry
            if (classified.retryable && attempt < maxRetries) {
                // Use taxonomy cooldown or calculate backoff, whichever is larger
                let retryDelayMs = Math.max(classified.cooldownMs, calculateBackoffDelay(attempt));

                // Respect Retry-After header for rate limits
                const retryAfter = (error as Response)?.headers?.get?.('Retry-After');
                if (retryAfter) {
                    const parsed = parseRetryAfter(retryAfter);
                    if (parsed !== null) {
                        retryDelayMs = parsed;
                        logger.info(COMPONENT, `[RateLimit] Respecting Retry-After: ${Math.round(retryDelayMs / 1000)}s`);
                    }
                }

                logger.warn(COMPONENT, `${errorMsg} [${classified.reason}] — retrying in ${Math.round(retryDelayMs)}ms`);
                await sleep(retryDelayMs);
                continue;
            }

            // Not retryable or max retries exceeded
            if (!classified.retryable) {
                logger.error(COMPONENT, `${errorMsg} — not retryable [${classified.reason}] (${classified.httpStatus ? `HTTP ${classified.httpStatus}` : 'unknown error'})`);
            } else {
                logger.error(COMPONENT, `${errorMsg} — max retries (${maxRetries}) exceeded [${classified.reason}]`);
            }

            // Try configured fallback chain first (model-level fallback)
            if (classified.retryable || classified.shouldFallback) {
                const chainResult = await tryFallbackChain(options, modelId, error as Error);
                if (chainResult) {
                    logger.info(COMPONENT, `Fallback chain recovered from ${providerName}/${model} failure [${classified.reason}]`);
                    return chainResult;
                }
            }

            // Try mesh peers before local failover
            const config = loadConfig();
            if (config.mesh?.enabled) {
                const peer = findModelOnMesh(modelId);
                if (peer) {
                    try {
                        const message = Array.isArray(options.messages)
                            ? options.messages.map(m => m.content).join('\n')
                            : (options as unknown as Record<string, unknown>).message as string || '';
                        return await meshChat(peer, modelId, message);
                    } catch (meshErr) {
                        logger.warn(COMPONENT, `Mesh routing failed: ${(meshErr as Error).message}`);
                    }
                }
            }

            // Attempt failover to other providers (only on first failure, not after retries)
            if (attempt === 0) {
                const failoverOrder = ['anthropic', 'openai', 'google', 'ollama'];
                for (const fallbackName of failoverOrder) {
                    if (fallbackName === providerName) continue;

                    // Check circuit breaker for fallback provider
                    if (!canRequest(fallbackName)) {
                        logger.debug(COMPONENT, `Skipping fallback ${fallbackName} — circuit breaker OPEN`);
                        continue;
                    }

                    const fallback = providers.get(fallbackName);
                    if (!fallback) continue;

                    try {
                        const healthy = await fallback.healthCheck();
                        if (!healthy) continue;

                        const models = await fallback.listModels();
                        if (models.length === 0) continue;

                        // Prefer a model with a similar name prefix (e.g. claude-* → claude-*)
                        const originalPrefix = model.split('-')[0];
                        const preferred = models.find(m => m.startsWith(originalPrefix)) || models[0];

                        logger.warn(COMPONENT, `Failing over from ${providerName}/${model} → ${fallbackName}/${preferred}`);
                        const result = await fallback.chat({ ...options, model: preferred });
                        recordSuccess(fallbackName); // Record success for the fallback provider
                        return result;
                    } catch (fallbackErr) {
                        recordFailure(fallbackName); // Record failure for the fallback provider too
                        logger.warn(COMPONENT, `Fallback ${fallbackName} also failed: ${(fallbackErr as Error).message}`);
                        continue;
                    }
                }
            }

            // All recovery options exhausted, throw enhanced error
            const finalError = new Error(`All providers failed: ${errorMsg}`);
            Object.assign(finalError, {
                status: classified.httpStatus,
                provider: providerName,
                model,
                cause: error,
                failoverReason: classified.reason,
            });
            throw finalError;
        }
    }

    // Should never reach here, but TypeScript requires it
    throw lastError || new Error(`Provider ${providerName}/${model} failed after all retries`);
}

/**
 * Send a streaming chat request with exponential backoff retry and circuit breaker protection.
 */
export async function* chatStream(options: ChatOptions): AsyncGenerator<ChatStreamChunk> {
    const modelId = options.model || 'anthropic/claude-sonnet-4-20250514';
    const { provider, model } = resolveModel(modelId);
    const providerName = provider.name;

    logger.info(COMPONENT, `Streaming via ${provider.displayName} (model: ${model})`);

    // Check circuit breaker before attempting request
    if (!canRequest(providerName)) {
        const cb = getCircuitBreaker(providerName);
        yield {
            type: 'error',
            error: `[CircuitBreaker] Circuit OPEN: ${providerName}/${model} (${cb.failureCount} failures, testing in ${
                Math.round((CIRCUIT_BREAKER_CONFIG.resetTimeout - (Date.now() - cb.openSince!)) / 1000)
            }s)`,
        };
        return;
    }

    let lastError: Error | null = null;
    const maxRetries = RETRY_CONFIG.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Stream from provider
            for await (const chunk of provider.chatStream({ ...options, model })) {
                // Record success on first successful chunk
                if (attempt === 0 && chunk.type !== 'error') {
                    recordSuccess(providerName);
                }
                lastFallbackEvent = null;
                yield chunk;
            }

            // Log if this was a retry that succeeded
            if (attempt > 0) {
                logger.info(COMPONENT, `${provider.displayName}/${model} stream recovered after ${attempt} retry attempt(s)`);
            }
            return;
        } catch (error) {
            lastError = error as Error;

            // Classify error using centralized taxonomy
            const classified = classifyProviderError(error);
            if (shouldAffectCircuitBreaker(classified)) {
                recordFailure(providerName);
            }

            const errorMsg = createEnhancedErrorMessage(error as Error, providerName, model, attempt);

            // Check if we should retry
            if (classified.retryable && attempt < maxRetries) {
                const retryDelayMs = Math.max(classified.cooldownMs, calculateBackoffDelay(attempt));
                logger.warn(COMPONENT, `${errorMsg} [${classified.reason}] — streaming retry in ${Math.round(retryDelayMs)}ms`);

                // Notify consumer about the retry
                yield {
                    type: 'text',
                    content: `\n[Retrying request (${attempt + 1}/${maxRetries}) due to ${classified.reason}...]\n\n`,
                };

                await sleep(retryDelayMs);
                continue;
            }

            // Not retryable or max retries exceeded
            if (!classified.retryable) {
                logger.error(COMPONENT, `${errorMsg} — streaming not retryable [${classified.reason}]`);
            } else {
                logger.error(COMPONENT, `${errorMsg} — streaming max retries exceeded [${classified.reason}]`);
            }

            // Try configured fallback chain first
            if (classified.retryable || classified.shouldFallback) {
                const chainStream = await tryFallbackChainStream(options, modelId, error as Error);
                if (chainStream) {
                    yield {
                        type: 'failover' as const,
                        originalProvider: providerName,
                        originalModel: model,
                        error: (error as Error).message,
                    };
                    yield* chainStream;
                    return;
                }
            }

            // Try mesh peers (non-streaming fallback for now)
            const config = loadConfig();
            if (config.mesh?.enabled) {
                const peer = findModelOnMesh(modelId);
                if (peer) {
                    try {
                        const message = Array.isArray(options.messages)
                            ? options.messages.map(m => m.content).join('\n')
                            : (options as unknown as Record<string, unknown>).message as string || '';
                        const result = await meshChat(peer, modelId, message);
                        yield { type: 'text' as const, content: result.content };
                        yield { type: 'done' as const };
                        return;
                    } catch (meshErr) {
                        logger.warn(COMPONENT, `Mesh stream routing failed: ${(meshErr as Error).message}`);
                    }
                }
            }

            // Attempt provider failover (only on first attempt)
            if (attempt === 0) {
                const failoverOrder = ['anthropic', 'openai', 'google', 'ollama'];
                let failedOver = false;

                for (const fallbackName of failoverOrder) {
                    if (fallbackName === providerName) continue;

                    if (!canRequest(fallbackName)) {
                        logger.debug(COMPONENT, `Skipping stream fallback ${fallbackName} — circuit breaker OPEN`);
                        continue;
                    }

                    const fallback = providers.get(fallbackName);
                    if (!fallback) continue;

                    try {
                        const healthy = await fallback.healthCheck();
                        if (!healthy) continue;

                        const models = await fallback.listModels();
                        if (models.length === 0) continue;

                        const originalPrefix = model.split('-')[0];
                        const preferred = models.find(m => m.startsWith(originalPrefix)) || models[0];

                        logger.warn(COMPONENT, `Stream failing over from ${providerName}/${model} → ${fallbackName}/${preferred}`);

                        // Notify consumer about failover
                        yield {
                            type: 'failover' as const,
                            originalProvider: providerName,
                            originalModel: model,
                            error: errorMsg,
                        };

                        yield* fallback.chatStream({ ...options, model: preferred });
                        recordSuccess(fallbackName);
                        failedOver = true;
                        break;
                    } catch (fallbackErr) {
                        recordFailure(fallbackName);
                        logger.warn(COMPONENT, `Stream fallback ${fallbackName} also failed: ${(fallbackErr as Error).message}`);
                        continue;
                    }
                }

                if (failedOver) return;
            }

            // All recovery options exhausted
            yield { type: 'error', error: `All streaming providers failed: ${errorMsg}` };
            return;
        }
    }

    // Should never reach here
    yield { type: 'error', error: lastError?.message || 'Streaming failed after all retries' };
}

/** Health check all providers */
export async function healthCheckAll(): Promise<Record<string, boolean>> {
    initProviders();
    const entries = Array.from(providers.entries());
    const settled = await Promise.allSettled(
        entries.map(([, provider]) => provider.healthCheck())
    );
    const results: Record<string, boolean> = {};
    for (let i = 0; i < entries.length; i++) {
        const [name] = entries[i];
        const outcome = settled[i];
        results[name] = outcome.status === 'fulfilled' ? outcome.value : false;
    }
    return results;
}
