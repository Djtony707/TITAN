/**
 * TITAN Configuration Manager
 * Loads, validates, and persists configuration from ~/.titan/titan.json
 */
import { existsSync } from 'fs';
import { TITAN_CONFIG_PATH, TITAN_HOME } from '../utils/constants.js';
import { readJsonFile, writeJsonFile, ensureDir, deepMerge } from '../utils/helpers.js';
import { TitanConfigSchema, type TitanConfig } from './schema.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Config';

let cachedConfig: TitanConfig | null = null;

/** Get the default configuration */
export function getDefaultConfig(): TitanConfig {
    return TitanConfigSchema.parse({});
}

/** Load configuration from disk, merging with defaults */
export function loadConfig(): TitanConfig {
    if (cachedConfig) return cachedConfig;

    ensureDir(TITAN_HOME);

    let rawConfig: Record<string, unknown> = {};

    if (existsSync(TITAN_CONFIG_PATH)) {
        const loaded = readJsonFile<Record<string, unknown>>(TITAN_CONFIG_PATH);
        if (loaded) {
            rawConfig = loaded;
            logger.debug(COMPONENT, `Loaded config from ${TITAN_CONFIG_PATH}`);
        } else {
            logger.warn(COMPONENT, `Failed to parse config at ${TITAN_CONFIG_PATH}, using defaults`);
        }
    } else {
        logger.info(COMPONENT, 'No config file found, using defaults');
    }

    // Apply environment variables
    applyEnvOverrides(rawConfig);

    // v4.8.4: migrate a top-level `auth` block to `gateway.auth`. The
    // documented path has always been `gateway.auth`, but users (and
    // Claude) naturally try `auth` at the root. Rather than strip it
    // silently and warn, move it to the canonical location and continue.
    if (rawConfig && typeof rawConfig === 'object' && 'auth' in rawConfig) {
        const raw = rawConfig as Record<string, unknown>;
        const topAuth = raw.auth as Record<string, unknown> | undefined;
        if (topAuth && typeof topAuth === 'object') {
            const gateway = (raw.gateway as Record<string, unknown> | undefined) ?? {};
            const gatewayAuth = (gateway.auth as Record<string, unknown> | undefined) ?? {};
            // gateway.auth wins if both are set — explicit nested wins
            // over migrated top-level.
            raw.gateway = { ...gateway, auth: { ...topAuth, ...gatewayAuth } };
            delete raw.auth;
            logger.info(COMPONENT, 'Migrated top-level `auth` → `gateway.auth`. Update titan.json to nest it under `gateway` to silence this notice.');
        }
    }

    // Detect unknown top-level keys BEFORE Zod strips them.
    // Hunt Finding #1 (2026-04-14): `facebook: {...}` was silently stripped because
    // the key wasn't in TitanConfigSchema. Users editing their config saw no effect.
    // Now we warn loudly when a key is about to be dropped, so bugs of this class
    // are caught immediately instead of being debugged days later.
    try {
        const schemaShape = (TitanConfigSchema as unknown as { _def: { shape: () => Record<string, unknown> } })._def.shape();
        const knownKeys = new Set(Object.keys(schemaShape));
        const unknownKeys = Object.keys(rawConfig).filter(k => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
            logger.warn(
                COMPONENT,
                `Config contains unknown top-level keys that will be stripped: ${unknownKeys.join(', ')}. ` +
                `If these are intentional, add them to TitanConfigSchema in src/config/schema.ts.`,
            );
        }
    } catch {
        // If the schema shape introspection fails, skip the warning (shouldn't block load).
    }

    // Validate and merge with defaults via Zod.
    // CRITICAL: On validation failure, deep-merge raw config over defaults
    // so that valid user settings (daemon.enabled, autonomy.mode, etc.) survive.
    // Previously this fell back to pure defaults, wiping ALL user config on any error.
    const result = TitanConfigSchema.safeParse(rawConfig);
    if (result.success) {
        cachedConfig = result.data;
    } else {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
        logger.warn(COMPONENT, `Config validation issues (${issues}) — merging valid fields over defaults`);
        // Deep-merge raw config over defaults so valid sections survive
        const defaults = getDefaultConfig();
        const merged = deepMerge(defaults as Record<string, unknown>, rawConfig) as TitanConfig;
        // Try parsing the merged result — if it still fails, use defaults but log loudly
        const reparse = TitanConfigSchema.safeParse(merged);
        if (reparse.success) {
            cachedConfig = reparse.data;
        } else {
            logger.error(COMPONENT, `Config still invalid after merge — falling back to defaults. Fix your titan.json.`);
            cachedConfig = defaults;
        }
    }

    return cachedConfig;
}

/** Save current configuration to disk */
export function saveConfig(config: TitanConfig): void {
    ensureDir(TITAN_HOME);
    writeJsonFile(TITAN_CONFIG_PATH, config);
    cachedConfig = config;
    logger.info(COMPONENT, `Config saved to ${TITAN_CONFIG_PATH}`);
}

/** Update specific fields in the config */
export function updateConfig(partial: Partial<TitanConfig>): TitanConfig {
    const current = loadConfig();
    const updated = deepMerge(current as Record<string, unknown>, partial as Record<string, unknown>) as TitanConfig;
    const validated = TitanConfigSchema.parse(updated);
    saveConfig(validated);
    return validated;
}

/** Reset config cache (useful for testing) */
export function resetConfigCache(): void {
    cachedConfig = null;
}

/** Check if the configuration file exists */
export function configExists(): boolean {
    return existsSync(TITAN_CONFIG_PATH);
}

/**
 * Check if at least one usable AI provider is configured.
 *
 * "Usable" means one of:
 *   - Any cloud provider has a non-empty `apiKey` set in config
 *   - Any *_API_KEY env var is set (Anthropic, OpenAI, Google, Groq, etc.)
 *   - Ollama is reachable at the configured baseUrl (returns at least one model)
 *
 * Used by the gateway boot guard and CLI to refuse to start with empty config
 * instead of letting the user hit "Internal Server Error" later.
 *
 * Note: Ollama check is async and is the slowest part of this function (~3s timeout).
 * Callers should `await` and only call once at boot.
 */
export async function hasUsableProvider(): Promise<{ ok: boolean; details: string }> {
    const config = loadConfig();

    // 1. Check config-file API keys (cloud providers)
    const providers = (config.providers as Record<string, unknown> | undefined) || {};
    const cloudProviderNames = [
        'anthropic', 'openai', 'google', 'groq', 'mistral', 'openrouter',
        'fireworks', 'xai', 'together', 'deepseek', 'cerebras', 'cohere',
        'perplexity', 'venice', 'bedrock', 'litellm', 'azure', 'deepinfra',
        'sambanova', 'kimi', 'huggingface', 'ai21', 'cohere-v2', 'reka',
        'zhipu', 'yi', 'inflection', 'novita', 'replicate', 'lepton',
        'anyscale', 'octo', 'nous', 'minimax', 'nvidia',
    ];
    for (const name of cloudProviderNames) {
        const p = providers[name] as { apiKey?: string } | undefined;
        if (p?.apiKey && p.apiKey.trim().length > 0) {
            return { ok: true, details: `${name} has an API key configured` };
        }
    }

    // 2. Check env-var API keys (in case config wasn't reloaded after env var change)
    const envKeys = [
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY',
        'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'FIREWORKS_API_KEY', 'XAI_API_KEY',
        'TOGETHER_API_KEY', 'DEEPSEEK_API_KEY', 'CEREBRAS_API_KEY', 'COHERE_API_KEY',
        'PERPLEXITY_API_KEY', 'AZURE_OPENAI_API_KEY',
    ];
    for (const key of envKeys) {
        if (process.env[key] && process.env[key]!.trim().length > 0) {
            return { ok: true, details: `${key} is set in environment` };
        }
    }

    // 3. Check Ollama reachability (last resort — slow)
    const ollamaUrl = (providers.ollama as { baseUrl?: string } | undefined)?.baseUrl
        || process.env.OLLAMA_BASE_URL
        || 'http://localhost:11434';
    try {
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const json = await res.json() as { models?: { name: string }[] };
            const count = (json.models || []).length;
            if (count > 0) {
                return { ok: true, details: `Ollama at ${ollamaUrl} is reachable (${count} models)` };
            }
            return { ok: false, details: `Ollama at ${ollamaUrl} is reachable but has 0 models — run "ollama pull qwen3.5:4b"` };
        }
    } catch {
        // Ollama unreachable, fall through to "no providers"
    }

    return { ok: false, details: 'No API keys configured and Ollama is not running' };
}

/** Apply environment variable overrides to raw config */
function applyEnvOverrides(config: Record<string, unknown>): void {
    const envMap: Record<string, (val: string) => void> = {
        TITAN_MODEL: (val) => setNested(config, 'agent.model', val),
        TITAN_GATEWAY_PORT: (val) => setNested(config, 'gateway.port', parseInt(val, 10)),
        TITAN_GATEWAY_HOST: (val) => setNested(config, 'gateway.host', val),
        TITAN_LOG_LEVEL: (val) => setNested(config, 'logging.level', val),
        ANTHROPIC_API_KEY: (val) => setNested(config, 'providers.anthropic.apiKey', val),
        OPENAI_API_KEY: (val) => setNested(config, 'providers.openai.apiKey', val),
        GOOGLE_API_KEY: (val) => setNested(config, 'providers.google.apiKey', val),
        OLLAMA_BASE_URL: (val) => setNested(config, 'providers.ollama.baseUrl', val),
        DISCORD_TOKEN: (val) => setNested(config, 'channels.discord.token', val),
        TELEGRAM_TOKEN: (val) => setNested(config, 'channels.telegram.token', val),
        SLACK_TOKEN: (val) => setNested(config, 'channels.slack.token', val),
        GOOGLE_OAUTH_CLIENT_ID: (val) => setNested(config, 'oauth.google.clientId', val),
        GOOGLE_OAUTH_CLIENT_SECRET: (val) => setNested(config, 'oauth.google.clientSecret', val),
        OPENROUTER_API_KEY: (val) => setNested(config, 'providers.openrouter.apiKey', val),
    };

    // Cloud mode: auto-configure OpenRouter to point at SaaS gateway
    if (process.env.TITAN_CLOUD_MODE === 'true' && process.env.TITAN_CLOUD_API) {
        const cloudApi = process.env.TITAN_CLOUD_API;
        setNested(config, 'providers.openrouter.baseUrl', cloudApi + '/api/v1');
        logger.debug(COMPONENT, `Cloud mode: OpenRouter base URL set to ${cloudApi}/api/v1`);
    }

    for (const [envKey, setter] of Object.entries(envMap)) {
        const val = process.env[envKey];
        if (val) {
            setter(val);
            logger.debug(COMPONENT, `Applied env override: ${envKey}`);
        }
    }
}

/** Set a nested property by dot-notation path */
function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
}
