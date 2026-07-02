/**
 * Welcome Mode — first-run onboarding over the web UI (v7.0).
 *
 * Before v7.0 an unconfigured `titan gateway` refused to boot with a terminal
 * error, so a first-time user never saw the dashboard at all. Now the gateway
 * ALWAYS starts: when no provider is usable it enters welcome mode, the SPA
 * shows a setup screen, and these helpers detect Ollama / apply the chosen
 * provider config / flip providerReady once a model actually works.
 */
import { loadConfig, updateConfig, hasUsableProvider } from '../config/config.js';
import type { TitanConfig } from '../config/schema.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Onboarding';

let providerReady = true;

export function getProviderReady(): boolean {
    return providerReady;
}

export function setProviderReady(ready: boolean): void {
    providerReady = ready;
}

/** Re-check provider usability (e.g. after config save) and update state. */
export async function refreshProviderReady(): Promise<{ ok: boolean; details: string }> {
    const usable = await hasUsableProvider();
    providerReady = usable.ok;
    return usable;
}

export interface OllamaDetection {
    detected: boolean;
    baseUrl: string;
    models: string[];
}

/** Probe a local Ollama for availability + installed models (fast timeout). */
export async function detectOllama(baseUrl?: string): Promise<OllamaDetection> {
    const base = (baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
    try {
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return { detected: false, baseUrl: base, models: [] };
        const data = await res.json() as { models?: Array<{ name: string }> };
        return { detected: true, baseUrl: base, models: (data.models || []).map(m => m.name).slice(0, 10) };
    } catch {
        return { detected: false, baseUrl: base, models: [] };
    }
}

export interface OnboardingConfigureInput {
    kind: 'ollama' | 'openai_compat' | 'anthropic' | 'openai';
    /** ollama / openai_compat */
    baseUrl?: string;
    /** cloud + openai_compat */
    apiKey?: string;
    /** model id; for ollama can be bare tag, else provider-prefixed automatically */
    model?: string;
}

/**
 * Map a welcome-screen choice to a config patch. Pure — unit-testable.
 * Returns null when required fields are missing.
 */
export function buildProviderConfigPatch(input: OnboardingConfigureInput): Partial<TitanConfig> | null {
    const kind = input.kind;
    if (kind === 'ollama') {
        const model = (input.model || '').trim();
        if (!model) return null;
        const patch: Record<string, unknown> = { agent: { model: `ollama/${model.replace(/^ollama\//, '')}` } };
        if (input.baseUrl && input.baseUrl.trim()) {
            patch.providers = { ollama: { baseUrl: input.baseUrl.trim().replace(/\/$/, '') } };
        }
        return patch as Partial<TitanConfig>;
    }
    if (kind === 'anthropic' || kind === 'openai') {
        const apiKey = (input.apiKey || '').trim();
        if (!apiKey) return null;
        const model = (input.model || '').trim()
            || (kind === 'anthropic' ? 'claude-sonnet-5' : 'gpt-5.2');
        return {
            providers: { [kind]: { apiKey, enabled: true } },
            agent: { model: `${kind}/${model.replace(new RegExp(`^${kind}/`), '')}` },
        } as unknown as Partial<TitanConfig>;
    }
    if (kind === 'openai_compat') {
        // Any OpenAI-compatible endpoint (LiteLLM, vLLM, LM Studio, llama.cpp…)
        // rides TITAN's litellm universal-proxy provider slot.
        const baseUrl = (input.baseUrl || '').trim().replace(/\/$/, '');
        const model = (input.model || '').trim();
        if (!baseUrl || !model) return null;
        return {
            providers: {
                litellm: {
                    baseUrl,
                    apiKey: (input.apiKey || '').trim() || 'not-needed',
                    enabled: true,
                },
            },
            agent: { model: `litellm/${model.replace(/^litellm\//, '')}` },
        } as unknown as Partial<TitanConfig>;
    }
    return null;
}

export interface OnboardingState {
    providerReady: boolean;
    configuredModel: string;
    ollama: OllamaDetection;
}

export async function getOnboardingState(): Promise<OnboardingState> {
    const cfg = loadConfig();
    return {
        providerReady,
        configuredModel: cfg.agent?.model || '',
        ollama: await detectOllama((cfg.providers as Record<string, { baseUrl?: string }> | undefined)?.ollama?.baseUrl),
    };
}

/** Apply a welcome-screen configuration, re-check usability, report back. */
export async function applyOnboardingConfig(input: OnboardingConfigureInput): Promise<{ ok: boolean; details: string }> {
    const patch = buildProviderConfigPatch(input);
    if (!patch) return { ok: false, details: 'Missing required fields for the chosen provider.' };
    updateConfig(patch);
    const usable = await refreshProviderReady();
    logger.info(COMPONENT, `Welcome-mode configure (${input.kind}) → ${usable.ok ? 'READY' : `not ready: ${usable.details}`}`);
    return usable;
}
