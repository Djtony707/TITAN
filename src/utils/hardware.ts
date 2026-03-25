/**
 * TITAN — Hardware Detection Utilities
 * Detects GPU availability to auto-tune performance settings.
 * Supports NVIDIA (CUDA), AMD (ROCm), and Apple Silicon (Metal/MPS).
 */
import { detectGpuVendor } from '../vram/gpuProbe.js';
import type { GpuVendor } from '../vram/types.js';

/**
 * Detect whether a GPU usable for LLM inference is available.
 * Returns true for NVIDIA discrete, AMD discrete (ROCm), and Apple Silicon (Metal).
 * Integrated GPUs (AMD APUs with /dev/kfd) are excluded since Ollama
 * uses CPU-only on those — validated on Ryzen 7 5825U (Barcelo).
 */
export function detectGpu(): boolean {
    return detectGpuVendor() !== 'none';
}

/** Returns the detected GPU vendor for more granular checks */
export function getGpuVendor(): GpuVendor {
    return detectGpuVendor();
}
