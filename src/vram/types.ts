/**
 * TITAN — VRAM Orchestrator Types
 * Interfaces for GPU memory management, model swapping, and lease tracking.
 */

/** Current GPU state from nvidia-smi */
export interface GpuState {
    totalMB: number;
    usedMB: number;
    freeMB: number;
    temperatureC: number;
    utilizationPct: number;
    driverVersion: string;
    gpuName: string;
}

/** A model currently loaded in Ollama */
export interface LoadedModel {
    name: string;
    sizeMB: number;
    sizeVramMB: number;
    family: string;
    parameterSize: string;
    quantization: string;
    expiresAt: string; // ISO timestamp or 'never'
}

/** A GPU service that may need VRAM */
export interface GpuService {
    name: string;
    estimatedMB: number;
    priority: number; // 1 = highest
    type: 'ollama' | 'docker' | 'process';
    containerId?: string;
}

/** A time-bounded VRAM reservation */
export interface VRAMLease {
    id: string;
    service: string;
    reservedMB: number;
    createdAt: number; // Date.now()
    expiresAt: number; // Date.now() + durationMs
    evictedModel?: string; // model that was swapped out
    replacementModel?: string; // model that was loaded instead
}

/** Budget entry from config */
export interface VRAMBudgetEntry {
    estimatedMB: number;
    priority: number;
    type: 'ollama' | 'docker' | 'process';
}

/** Result of an acquire operation */
export interface AcquireResult {
    ok: boolean;
    leaseId?: string;
    freedMB?: number;
    swappedFrom?: string;
    swappedTo?: string;
    error?: string;
    currentFreeMB: number;
}

/** Full VRAM snapshot for API */
export interface VRAMSnapshot {
    gpu: GpuState;
    loadedModels: LoadedModel[];
    activeLeases: VRAMLease[];
    reservedMB: number;
    availableMB: number; // free - reserved by leases - config reserve
}

/** Events emitted by the orchestrator */
export type VRAMEvent =
    | { type: 'model_evicted'; model: string; freedMB: number }
    | { type: 'model_loaded'; model: string; sizeMB: number }
    | { type: 'model_swapped'; from: string; to: string; freedMB: number }
    | { type: 'lease_created'; lease: VRAMLease }
    | { type: 'lease_released'; leaseId: string; service: string }
    | { type: 'lease_expired'; leaseId: string; service: string }
    | { type: 'vram_low'; freeMB: number; thresholdMB: number }
    | { type: 'oom_warning'; freeMB: number; requestedMB: number }
    | { type: 'probe_error'; error: string };
