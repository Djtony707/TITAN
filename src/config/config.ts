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

    // Validate and merge with defaults via Zod
    const result = TitanConfigSchema.safeParse(rawConfig);
    if (!result.success) {
        logger.warn(COMPONENT, 'Config validation issues, using defaults for invalid fields');
        logger.debug(COMPONENT, result.error.message);
        cachedConfig = getDefaultConfig();
    } else {
        cachedConfig = result.data;
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

    // Validate and merge with defaults via Zod
    const result = TitanConfigSchema.safeParse(rawConfig);
    if (!result.success) {
        logger.warn(COMPONENT, 'Config validation issues, using defaults for invalid fields');
        logger.debug(COMPONENT, result.error.message);
        cachedConfig = getDefaultConfig();
    } else {
        cachedConfig = result.data;
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
    };

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
