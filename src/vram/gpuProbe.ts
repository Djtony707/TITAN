/**
 * TITAN — GPU Probe
 * Queries nvidia-smi and Ollama API for GPU state, loaded models, and process VRAM usage.
 */
import { execFile } from 'child_process';
import logger from '../utils/logger.js';
import type { GpuState, LoadedModel } from './types.js';

const COMPONENT = 'VRAMProbe';

/** Query GPU state via nvidia-smi */
export async function queryGpuState(): Promise<GpuState | null> {
    return new Promise((resolve) => {
        execFile('nvidia-smi', [
            '--query-gpu=memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu,driver_version,name',
            '--format=csv,noheader,nounits',
        ], { timeout: 5000 }, (err, stdout) => {
            if (err) {
                logger.debug(COMPONENT, `nvidia-smi failed: ${err.message}`);
                resolve(null);
                return;
            }

            const parts = stdout.trim().split(',').map(s => s.trim());
            if (parts.length < 7) {
                logger.debug(COMPONENT, `nvidia-smi unexpected output: ${stdout}`);
                resolve(null);
                return;
            }

            resolve({
                totalMB: parseInt(parts[0], 10) || 0,
                usedMB: parseInt(parts[1], 10) || 0,
                freeMB: parseInt(parts[2], 10) || 0,
                temperatureC: parseInt(parts[3], 10) || 0,
                utilizationPct: parseInt(parts[4], 10) || 0,
                driverVersion: parts[5],
                gpuName: parts[6],
            });
        });
    });
}

/** Query loaded models from Ollama /api/ps */
export async function queryOllamaModels(ollamaUrl: string = 'http://localhost:11434'): Promise<LoadedModel[]> {
    try {
        const resp = await fetch(`${ollamaUrl}/api/ps`, {
            signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) return [];

        const data = await resp.json() as {
            models?: Array<{
                name: string;
                size: number;
                size_vram: number;
                details?: {
                    family?: string;
                    parameter_size?: string;
                    quantization_level?: string;
                };
                expires_at?: string;
            }>;
        };

        return (data.models || []).map(m => ({
            name: m.name,
            sizeMB: Math.round((m.size || 0) / 1024 / 1024),
            sizeVramMB: Math.round((m.size_vram || 0) / 1024 / 1024),
            family: m.details?.family || 'unknown',
            parameterSize: m.details?.parameter_size || 'unknown',
            quantization: m.details?.quantization_level || 'unknown',
            expiresAt: m.expires_at || 'unknown',
        }));
    } catch (err) {
        logger.debug(COMPONENT, `Ollama /api/ps failed: ${(err as Error).message}`);
        return [];
    }
}

/** Evict a model immediately via Ollama keep_alive: 0 */
export async function evictModel(modelName: string, ollamaUrl: string = 'http://localhost:11434'): Promise<boolean> {
    try {
        const resp = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                keep_alive: 0,
            }),
            signal: AbortSignal.timeout(15000),
        });

        if (!resp.ok) {
            logger.warn(COMPONENT, `Failed to evict ${modelName}: HTTP ${resp.status}`);
            return false;
        }

        // Consume the response body (may be streaming)
        await resp.text();
        logger.info(COMPONENT, `Evicted model: ${modelName}`);
        return true;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to evict ${modelName}: ${(err as Error).message}`);
        return false;
    }
}

/** Preload a model by sending empty prompt with keep_alive */
export async function preloadModel(
    modelName: string,
    keepAliveMinutes: number = 5,
    ollamaUrl: string = 'http://localhost:11434',
): Promise<boolean> {
    try {
        const resp = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                prompt: '',
                keep_alive: `${keepAliveMinutes}m`,
            }),
            signal: AbortSignal.timeout(120_000), // model load can take time
        });

        if (!resp.ok) {
            logger.warn(COMPONENT, `Failed to preload ${modelName}: HTTP ${resp.status}`);
            return false;
        }

        await resp.text();
        logger.info(COMPONENT, `Preloaded model: ${modelName}`);
        return true;
    } catch (err) {
        logger.warn(COMPONENT, `Failed to preload ${modelName}: ${(err as Error).message}`);
        return false;
    }
}

/** Get model info (size, quantization) without loading it */
export async function getModelInfo(
    modelName: string,
    ollamaUrl: string = 'http://localhost:11434',
): Promise<{ parameterSize: string; quantization: string; sizeMB: number } | null> {
    try {
        const resp = await fetch(`${ollamaUrl}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName }),
            signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) return null;

        const data = await resp.json() as {
            details?: {
                parameter_size?: string;
                quantization_level?: string;
            };
            size?: number;
        };

        return {
            parameterSize: data.details?.parameter_size || 'unknown',
            quantization: data.details?.quantization_level || 'unknown',
            sizeMB: Math.round((data.size || 0) / 1024 / 1024),
        };
    } catch {
        return null;
    }
}
