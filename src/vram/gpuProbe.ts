/**
 * TITAN — GPU Probe
 * Queries GPU state across NVIDIA (nvidia-smi), AMD (rocm-smi), and Apple Silicon (system_profiler).
 * Also queries Ollama API for loaded models and VRAM usage.
 */
import { execFile, execSync } from 'child_process';
import { existsSync } from 'fs';
import { platform, arch } from 'os';
import logger from '../utils/logger.js';
import type { GpuState, GpuVendor, LoadedModel } from './types.js';

const COMPONENT = 'VRAMProbe';

// ── Vendor Detection ───────────────────────────────────────────

let cachedVendor: GpuVendor | undefined;

/** Detect which GPU vendor is available on this system */
export function detectGpuVendor(): GpuVendor {
    if (cachedVendor !== undefined) return cachedVendor;

    // Apple Silicon — check first since macOS won't have /dev/nvidia0 or /dev/kfd
    if (platform() === 'darwin' && arch() === 'arm64') {
        cachedVendor = 'apple';
        return cachedVendor;
    }

    // NVIDIA — discrete GPU
    if (existsSync('/dev/nvidia0')) {
        cachedVendor = 'nvidia';
        return cachedVendor;
    }

    // AMD ROCm — discrete GPU (not just APU)
    if (existsSync('/dev/kfd')) {
        try {
            const out = execSync('rocm-smi --showmeminfo vram 2>/dev/null', { timeout: 3000 }).toString();
            if (/vram total/i.test(out)) {
                cachedVendor = 'amd';
                return cachedVendor;
            }
        } catch { /* no discrete AMD GPU */ }

        // Fallback: lspci check for discrete Radeon
        try {
            const out = execSync('lspci 2>/dev/null', { timeout: 3000 }).toString();
            if (/display.*amd.*navi/i.test(out) || /vga.*amd.*radeon\s+rx/i.test(out)) {
                cachedVendor = 'amd';
                return cachedVendor;
            }
        } catch { /* no lspci */ }
    }

    // macOS Intel with discrete GPU (check system_profiler)
    if (platform() === 'darwin') {
        try {
            const out = execSync('system_profiler SPDisplaysDataType 2>/dev/null', { timeout: 5000 }).toString();
            if (/metal/i.test(out)) {
                cachedVendor = 'apple';
                return cachedVendor;
            }
        } catch { /* no GPU info */ }
    }

    // Linux fallback: lspci for NVIDIA without /dev/nvidia0
    if (platform() === 'linux') {
        try {
            const out = execSync('lspci 2>/dev/null', { timeout: 3000 }).toString();
            if (/vga.*nvidia/i.test(out)) {
                cachedVendor = 'nvidia';
                return cachedVendor;
            }
        } catch { /* no lspci */ }
    }

    cachedVendor = 'none';
    return cachedVendor;
}

/** Reset cached vendor (for testing) */
export function resetVendorCache(): void {
    cachedVendor = undefined;
}

// ── NVIDIA Probe ───────────────────────────────────────────────

function queryNvidiaGpu(): Promise<GpuState | null> {
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
                vendor: 'nvidia',
                totalMB: parseInt(parts[0], 10) || 0,
                usedMB: parseInt(parts[1], 10) || 0,
                freeMB: parseInt(parts[2], 10) || 0,
                temperatureC: parseInt(parts[3], 10) || 0,
                utilizationPct: parseInt(parts[4], 10) || 0,
                driverVersion: parts[5],
                gpuName: parts[6],
                unifiedMemory: false,
            });
        });
    });
}

// ── AMD ROCm Probe ─────────────────────────────────────────────

async function queryAmdGpu(): Promise<GpuState | null> {
    try {
        // Get VRAM info
        const vramOut = execSync('rocm-smi --showmeminfo vram 2>/dev/null', { timeout: 5000 }).toString();
        const totalMatch = vramOut.match(/vram total[^:]*:\s*(\d+)/i);
        const usedMatch = vramOut.match(/vram used[^:]*:\s*(\d+)/i);

        // Values from rocm-smi are in bytes
        const totalBytes = parseInt(totalMatch?.[1] || '0', 10);
        const usedBytes = parseInt(usedMatch?.[1] || '0', 10);
        const totalMB = Math.round(totalBytes / 1024 / 1024);
        const usedMB = Math.round(usedBytes / 1024 / 1024);

        // Get temperature
        let temperatureC = 0;
        try {
            const tempOut = execSync('rocm-smi --showtemp 2>/dev/null', { timeout: 3000 }).toString();
            const tempMatch = tempOut.match(/(\d+)\.\d+\s*c/i) || tempOut.match(/Temperature[^:]*:\s*(\d+)/i);
            temperatureC = parseInt(tempMatch?.[1] || '0', 10);
        } catch { /* temp not available */ }

        // Get utilization
        let utilizationPct = 0;
        try {
            const useOut = execSync('rocm-smi --showuse 2>/dev/null', { timeout: 3000 }).toString();
            const useMatch = useOut.match(/(\d+)\s*%/) || useOut.match(/GPU use[^:]*:\s*(\d+)/i);
            utilizationPct = parseInt(useMatch?.[1] || '0', 10);
        } catch { /* util not available */ }

        // Get GPU name
        let gpuName = 'AMD GPU';
        let driverVersion = 'ROCm';
        try {
            const idOut = execSync('rocm-smi --showproductname 2>/dev/null', { timeout: 3000 }).toString();
            const nameMatch = idOut.match(/Card Series[^:]*:\s*(.+)/i) || idOut.match(/Card model[^:]*:\s*(.+)/i);
            if (nameMatch) gpuName = nameMatch[1].trim();
        } catch { /* name not available */ }
        try {
            const verOut = execSync('rocm-smi --showdriverversion 2>/dev/null', { timeout: 3000 }).toString();
            const verMatch = verOut.match(/Driver version[^:]*:\s*(.+)/i);
            if (verMatch) driverVersion = `ROCm ${verMatch[1].trim()}`;
        } catch { /* version not available */ }

        return {
            vendor: 'amd',
            totalMB,
            usedMB,
            freeMB: totalMB - usedMB,
            temperatureC,
            utilizationPct,
            driverVersion,
            gpuName,
            unifiedMemory: false,
        };
    } catch (err) {
        logger.debug(COMPONENT, `rocm-smi failed: ${(err as Error).message}`);
        return null;
    }
}

// ── Apple Silicon Probe ────────────────────────────────────────

async function queryAppleGpu(): Promise<GpuState | null> {
    try {
        // Get GPU name from system_profiler
        let gpuName = 'Apple Silicon GPU';
        try {
            const spOut = execSync('system_profiler SPDisplaysDataType 2>/dev/null', { timeout: 5000 }).toString();
            const chipMatch = spOut.match(/Chipset Model:\s*(.+)/i) || spOut.match(/Chip:\s*(.+)/i);
            if (chipMatch) gpuName = chipMatch[1].trim();
        } catch { /* fallback to generic name */ }

        // Apple Silicon uses unified memory — total system RAM is shared with GPU
        let totalMB = 0;
        try {
            const memOut = execSync('sysctl -n hw.memsize 2>/dev/null', { timeout: 3000 }).toString();
            totalMB = Math.round(parseInt(memOut.trim(), 10) / 1024 / 1024);
        } catch { /* fallback */ }

        // Get memory pressure / usage from vm_stat
        let usedMB = 0;
        try {
            const vmOut = execSync('vm_stat 2>/dev/null', { timeout: 3000 }).toString();
            const pageSize = 16384; // Apple Silicon uses 16KB pages
            const activeMatch = vmOut.match(/Pages active:\s+(\d+)/);
            const wiredMatch = vmOut.match(/Pages wired down:\s+(\d+)/);
            const compressedMatch = vmOut.match(/Pages occupied by compressor:\s+(\d+)/);

            const activePages = parseInt(activeMatch?.[1] || '0', 10);
            const wiredPages = parseInt(wiredMatch?.[1] || '0', 10);
            const compressedPages = parseInt(compressedMatch?.[1] || '0', 10);

            usedMB = Math.round((activePages + wiredPages + compressedPages) * pageSize / 1024 / 1024);
        } catch { /* fallback */ }

        // Get thermal state (macOS doesn't expose exact GPU temp easily)
        let temperatureC = 0;
        try {
            // Try powermetrics (requires sudo) or thermal monitor
            const thermalOut = execSync('pmset -g therm 2>/dev/null', { timeout: 3000 }).toString();
            if (/CPU_Scheduler_Limit\s*=\s*(\d+)/i.test(thermalOut)) {
                // If throttling is active, estimate high temp
                const limitMatch = thermalOut.match(/CPU_Scheduler_Limit\s*=\s*(\d+)/i);
                const limit = parseInt(limitMatch?.[1] || '100', 10);
                if (limit < 100) temperatureC = 90; // throttling → hot
            }
        } catch { /* temp not available without sudo */ }

        // GPU utilization — try to get from powermetrics or Activity Monitor
        let utilizationPct = 0;
        try {
            // ioreg can sometimes report GPU busy percentage
            const ioOut = execSync('ioreg -r -d 1 -c IOAccelerator 2>/dev/null | grep "PerformanceStatistics" -A 5', { timeout: 3000 }).toString();
            const busyMatch = ioOut.match(/"Device Utilization %"\s*=\s*(\d+)/i);
            if (busyMatch) utilizationPct = parseInt(busyMatch[1], 10);
        } catch { /* util not available */ }

        // macOS version as "driver version"
        let driverVersion = 'Metal';
        try {
            const osOut = execSync('sw_vers -productVersion 2>/dev/null', { timeout: 3000 }).toString().trim();
            driverVersion = `Metal (macOS ${osOut})`;
        } catch { /* fallback */ }

        return {
            vendor: 'apple',
            totalMB,
            usedMB,
            freeMB: totalMB - usedMB,
            temperatureC,
            utilizationPct,
            driverVersion,
            gpuName,
            unifiedMemory: true,
        };
    } catch (err) {
        logger.debug(COMPONENT, `Apple GPU probe failed: ${(err as Error).message}`);
        return null;
    }
}

// ── Main Query (dispatches to vendor) ──────────────────────────

/** Query GPU state — auto-detects vendor and dispatches to appropriate probe */
export async function queryGpuState(): Promise<GpuState | null> {
    const vendor = detectGpuVendor();

    switch (vendor) {
        case 'nvidia': return queryNvidiaGpu();
        case 'amd': return queryAmdGpu();
        case 'apple': return queryAppleGpu();
        case 'none': return null;
    }
}

// ── Ollama Queries (vendor-agnostic) ───────────────────────────

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
