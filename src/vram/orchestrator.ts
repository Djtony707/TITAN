/**
 * TITAN — VRAM Orchestrator (Singleton)
 * Central coordinator for GPU VRAM management:
 * - Acquire/release VRAM with automatic model swapping
 * - Async mutex to serialize concurrent VRAM operations
 * - Event bus for monitoring
 * - Periodic GPU polling
 */
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import { queryGpuState, queryOllamaModels, evictModel, preloadModel, getModelInfo } from './gpuProbe.js';
import { LeaseManager } from './leaseManager.js';
import type { GpuState, LoadedModel, VRAMLease, AcquireResult, VRAMSnapshot, VRAMEvent } from './types.js';

const COMPONENT = 'VRAMOrch';

/** Simple async mutex — serializes all VRAM operations */
class AsyncMutex {
    private locked = false;
    private queue: (() => void)[] = [];

    async acquire(): Promise<void> {
        if (!this.locked) {
            this.locked = true;
            return;
        }
        return new Promise<void>((resolve) => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
        } else {
            this.locked = false;
        }
    }
}

/** VRAM configuration from titan.json */
interface VRAMConfig {
    enabled: boolean;
    pollIntervalMs: number;
    reserveMB: number;
    autoSwapModel: boolean;
    fallbackModel: string;
    ollamaUrl: string;
    services: Record<string, {
        estimatedMB: number;
        priority: number;
        type: 'ollama' | 'docker' | 'process';
    }>;
}

function getVRAMConfig(): VRAMConfig {
    const config = loadConfig();
    const vram = (config as Record<string, unknown>).vram as Record<string, unknown> | undefined;
    return {
        enabled: (vram?.enabled as boolean) ?? true,
        pollIntervalMs: (vram?.pollIntervalMs as number) ?? 10000,
        reserveMB: (vram?.reserveMB as number) ?? 1024,
        autoSwapModel: (vram?.autoSwapModel as boolean) ?? true,
        fallbackModel: (vram?.fallbackModel as string) ?? 'qwen3:7b',
        ollamaUrl: (vram?.ollamaUrl as string) ?? 'http://localhost:11434',
        services: (vram?.services as VRAMConfig['services']) ?? {},
    };
}

class VRAMOrchestrator {
    private mutex = new AsyncMutex();
    private leaseManager: LeaseManager;
    private listeners: Array<(event: VRAMEvent) => void> = [];
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private lastGpuState: GpuState | null = null;
    private lastModels: LoadedModel[] = [];
    private initialized = false;

    constructor() {
        this.leaseManager = new LeaseManager((event) => this.emit(event));
    }

    /** Initialize the orchestrator — start polling */
    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;

        const config = getVRAMConfig();
        if (!config.enabled) {
            logger.info(COMPONENT, 'VRAM orchestrator disabled');
            return;
        }

        // Initial probe
        await this.refresh();

        // Start periodic polling
        if (config.pollIntervalMs > 0) {
            this.pollTimer = setInterval(() => {
                void this.refresh();
            }, config.pollIntervalMs);
            this.pollTimer.unref();
        }

        logger.info(COMPONENT, `VRAM orchestrator initialized (poll: ${config.pollIntervalMs}ms, reserve: ${config.reserveMB}MB)`);
    }

    /** Refresh GPU state and loaded models */
    async refresh(): Promise<void> {
        const config = getVRAMConfig();
        const [gpu, models] = await Promise.all([
            queryGpuState(),
            queryOllamaModels(config.ollamaUrl),
        ]);

        if (gpu) {
            this.lastGpuState = gpu;

            // Check for low VRAM warning
            const availableMB = gpu.freeMB - this.leaseManager.getTotalReservedMB() - config.reserveMB;
            if (availableMB < 500 && availableMB >= 0) {
                this.emit({ type: 'vram_low', freeMB: gpu.freeMB, thresholdMB: 500 });
            }
        }

        this.lastModels = models;
    }

    /** Get current VRAM snapshot */
    async getSnapshot(): Promise<VRAMSnapshot | null> {
        const config = getVRAMConfig();

        // Use cached state if recent, otherwise refresh
        if (!this.lastGpuState) {
            await this.refresh();
        }

        if (!this.lastGpuState) return null;

        const reservedMB = this.leaseManager.getTotalReservedMB();
        const availableMB = Math.max(0, this.lastGpuState.freeMB - reservedMB - config.reserveMB);

        return {
            gpu: this.lastGpuState,
            loadedModels: this.lastModels,
            activeLeases: this.leaseManager.getAll(),
            reservedMB,
            availableMB,
        };
    }

    /**
     * Acquire VRAM for a service.
     * If not enough free VRAM, attempts to swap the current LLM model to a smaller one.
     */
    async acquire(
        service: string,
        requiredMB: number,
        durationMs: number = 300_000, // 5 min default
    ): Promise<AcquireResult> {
        const config = getVRAMConfig();

        await this.mutex.acquire();
        try {
            // 1. Refresh GPU state
            await this.refresh();

            if (!this.lastGpuState) {
                return {
                    ok: false,
                    error: 'GPU state unavailable (no supported GPU detected — requires NVIDIA, AMD ROCm, or Apple Silicon)',
                    currentFreeMB: 0,
                };
            }

            const reservedByLeases = this.leaseManager.getTotalReservedMB();
            const effectiveFree = this.lastGpuState.freeMB - reservedByLeases - config.reserveMB;

            // 2. Check if we have enough free VRAM
            if (effectiveFree >= requiredMB) {
                const lease = this.leaseManager.create(service, requiredMB, durationMs);
                return {
                    ok: true,
                    leaseId: lease.id,
                    currentFreeMB: effectiveFree - requiredMB,
                };
            }

            // 3. Not enough free — try model swap if enabled
            if (!config.autoSwapModel) {
                return {
                    ok: false,
                    error: `Not enough VRAM: need ${requiredMB}MB, available ${effectiveFree}MB (auto-swap disabled)`,
                    currentFreeMB: effectiveFree,
                };
            }

            // 4. Find models to evict (sorted by VRAM usage, largest first)
            const evictable = this.lastModels
                .filter(m => m.sizeVramMB > 0)
                .sort((a, b) => b.sizeVramMB - a.sizeVramMB);

            if (evictable.length === 0) {
                return {
                    ok: false,
                    error: `Not enough VRAM: need ${requiredMB}MB, available ${effectiveFree}MB (no models to evict)`,
                    currentFreeMB: effectiveFree,
                };
            }

            // 5. Evict models until we have enough space
            let freedMB = 0;
            const evictedModels: string[] = [];

            for (const model of evictable) {
                if (effectiveFree + freedMB >= requiredMB) break;

                logger.info(COMPONENT, `Evicting ${model.name} (${model.sizeVramMB}MB) for ${service}`);
                const success = await evictModel(model.name, config.ollamaUrl);

                if (success) {
                    freedMB += model.sizeVramMB;
                    evictedModels.push(model.name);
                    this.emit({ type: 'model_evicted', model: model.name, freedMB: model.sizeVramMB });
                } else {
                    logger.warn(COMPONENT, `Failed to evict ${model.name}`);
                }
            }

            // 6. Preload fallback model if we evicted the primary
            let swappedTo: string | undefined;
            if (evictedModels.length > 0 && config.fallbackModel) {
                const fallbackInfo = await getModelInfo(config.fallbackModel, config.ollamaUrl);
                const fallbackSizeMB = fallbackInfo?.sizeMB || 4000; // estimate

                // Only preload fallback if it fits
                const newFree = effectiveFree + freedMB - requiredMB;
                if (newFree >= fallbackSizeMB) {
                    logger.info(COMPONENT, `Preloading fallback model: ${config.fallbackModel}`);
                    const preloaded = await preloadModel(config.fallbackModel, 5, config.ollamaUrl);
                    if (preloaded) {
                        swappedTo = config.fallbackModel;
                        this.emit({
                            type: 'model_swapped',
                            from: evictedModels[0],
                            to: config.fallbackModel,
                            freedMB,
                        });
                    }
                }
            }

            // 7. Verify we now have enough
            await this.refresh();
            const newEffectiveFree = (this.lastGpuState?.freeMB || 0) - this.leaseManager.getTotalReservedMB() - config.reserveMB;

            if (newEffectiveFree < requiredMB) {
                // Rollback: try to reload evicted models
                logger.warn(COMPONENT, `Still not enough VRAM after eviction. Need ${requiredMB}MB, have ${newEffectiveFree}MB`);

                if (swappedTo) {
                    await evictModel(swappedTo, config.ollamaUrl);
                }
                for (const modelName of evictedModels) {
                    await preloadModel(modelName, 5, config.ollamaUrl);
                }

                return {
                    ok: false,
                    error: `Evicted ${evictedModels.join(', ')} but still not enough VRAM: need ${requiredMB}MB, have ${newEffectiveFree}MB`,
                    freedMB,
                    currentFreeMB: newEffectiveFree,
                };
            }

            // 8. Create lease
            const lease = this.leaseManager.create(service, requiredMB, durationMs, {
                evictedModel: evictedModels[0],
                replacementModel: swappedTo,
            });

            return {
                ok: true,
                leaseId: lease.id,
                freedMB,
                swappedFrom: evictedModels[0],
                swappedTo,
                currentFreeMB: newEffectiveFree - requiredMB,
            };
        } finally {
            this.mutex.release();
        }
    }

    /**
     * Release a VRAM lease.
     * Optionally restores the original model that was evicted.
     */
    async release(leaseId: string, restoreModel: boolean = true): Promise<{
        ok: boolean;
        restoredModel?: string;
        error?: string;
    }> {
        await this.mutex.acquire();
        try {
            const lease = this.leaseManager.get(leaseId);
            if (!lease) {
                return { ok: false, error: `Lease ${leaseId} not found` };
            }

            const config = getVRAMConfig();
            const evictedModel = lease.evictedModel;
            const replacementModel = lease.replacementModel;

            // Release the lease
            this.leaseManager.release(leaseId);

            // Restore original model if requested and one was evicted
            let restoredModel: string | undefined;
            if (restoreModel && evictedModel) {
                // First evict the fallback model if one was loaded
                if (replacementModel) {
                    await evictModel(replacementModel, config.ollamaUrl);
                }

                // Preload the original model
                logger.info(COMPONENT, `Restoring model: ${evictedModel}`);
                const success = await preloadModel(evictedModel, 5, config.ollamaUrl);
                if (success) {
                    restoredModel = evictedModel;
                    this.emit({ type: 'model_loaded', model: evictedModel, sizeMB: 0 });
                } else {
                    logger.warn(COMPONENT, `Failed to restore ${evictedModel}, keeping fallback`);
                }
            }

            return { ok: true, restoredModel };
        } finally {
            this.mutex.release();
        }
    }

    /** Check if a given amount of VRAM can be acquired (dry run) */
    async canAcquire(requiredMB: number): Promise<{
        canFit: boolean;
        currentFreeMB: number;
        wouldNeedToEvict: boolean;
        evictCandidates: string[];
    }> {
        const config = getVRAMConfig();
        await this.refresh();

        if (!this.lastGpuState) {
            return { canFit: false, currentFreeMB: 0, wouldNeedToEvict: false, evictCandidates: [] };
        }

        const reservedByLeases = this.leaseManager.getTotalReservedMB();
        const effectiveFree = this.lastGpuState.freeMB - reservedByLeases - config.reserveMB;

        if (effectiveFree >= requiredMB) {
            return { canFit: true, currentFreeMB: effectiveFree, wouldNeedToEvict: false, evictCandidates: [] };
        }

        // Check if eviction could free enough
        const evictable = this.lastModels
            .filter(m => m.sizeVramMB > 0)
            .sort((a, b) => b.sizeVramMB - a.sizeVramMB);

        let potentialFree = effectiveFree;
        const candidates: string[] = [];
        for (const model of evictable) {
            if (potentialFree >= requiredMB) break;
            potentialFree += model.sizeVramMB;
            candidates.push(model.name);
        }

        return {
            canFit: potentialFree >= requiredMB,
            currentFreeMB: effectiveFree,
            wouldNeedToEvict: true,
            evictCandidates: candidates,
        };
    }

    /** Subscribe to VRAM events */
    on(listener: (event: VRAMEvent) => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    /** Emit an event to all listeners */
    private emit(event: VRAMEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                logger.warn(COMPONENT, `Event listener error: ${(err as Error).message}`);
            }
        }
    }

    /** Get active leases */
    getLeases(): VRAMLease[] {
        return this.leaseManager.getAll();
    }

    /** Shut down the orchestrator */
    destroy(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.leaseManager.destroy();
        this.listeners = [];
        this.initialized = false;
        logger.info(COMPONENT, 'VRAM orchestrator destroyed');
    }
}

// ── Singleton ──────────────────────────────────────────────────
let instance: VRAMOrchestrator | null = null;

export function getVRAMOrchestrator(): VRAMOrchestrator {
    if (!instance) {
        instance = new VRAMOrchestrator();
    }
    return instance;
}

/** Initialize and return the orchestrator singleton */
export async function initVRAMOrchestrator(): Promise<VRAMOrchestrator> {
    const orch = getVRAMOrchestrator();
    await orch.init();
    return orch;
}
