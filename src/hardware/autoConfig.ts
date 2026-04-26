/**
 * TITAN — Hardware Auto-Configuration
 * Detects host capabilities and suggests config tunings.
 */
import { cpus, totalmem, freemem, platform } from 'os';
import { execSync } from 'child_process';
import { queryGpuState, detectGpuVendor } from '../vram/gpuProbe.js';
import { updateConfig } from '../config/config.js';
import type { TitanConfig } from '../config/schema.js';
import logger from '../utils/logger.js';

const COMPONENT = 'AutoConfig';

export interface HardwareProfile {
    cpuCores: number;
    cpuModel: string;
    ramTotalMB: number;
    ramFreeMB: number;
    gpuVendor: 'nvidia' | 'amd' | 'apple' | 'none';
    gpuName: string;
    gpuVramMB: number;
    gpuFreeMB: number;
    diskTotalGB: number;
    diskFreeGB: number;
    os: string;
}

function execQuiet(cmd: string): string {
    try {
        return execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
    } catch {
        return '';
    }
}

/** Detect CPU, RAM, GPU, and disk space */
export async function detectHardware(): Promise<HardwareProfile> {
    const cpuList = cpus();
    const cpuCores = cpuList.length || 1;
    const cpuModel = cpuList[0]?.model || 'Unknown';

    const ramTotalMB = Math.round(totalmem() / 1024 / 1024);
    const ramFreeMB = Math.round(freemem() / 1024 / 1024);

    const gpuState = await queryGpuState();
    const gpuVendor = detectGpuVendor();
    const gpuName = gpuState?.gpuName || 'None';
    const gpuVramMB = gpuState?.totalMB || 0;
    const gpuFreeMB = gpuState?.freeMB || 0;

    let diskTotalGB = 0;
    let diskFreeGB = 0;
    const df = execQuiet(platform() === 'darwin' ? 'df -g / | tail -1' : 'df -BG / | tail -1');
    if (df) {
        const parts = df.split(/\s+/);
        const sizeRaw = parts[1] || '0';
        const freeRaw = parts[3] || '0';
        diskTotalGB = parseInt(sizeRaw.replace(/[^0-9]/g, ''), 10) || 0;
        diskFreeGB = parseInt(freeRaw.replace(/[^0-9]/g, ''), 10) || 0;
    }

    return {
        cpuCores,
        cpuModel,
        ramTotalMB,
        ramFreeMB,
        gpuVendor,
        gpuName,
        gpuVramMB,
        gpuFreeMB,
        diskTotalGB,
        diskFreeGB,
        os: platform(),
    };
}

/** Generate human-readable + structured recommendations */
export function generateRecommendations(profile: HardwareProfile): string[] {
    const recs: string[] = [];
    const { cpuCores, ramTotalMB, gpuVramMB, diskFreeGB } = profile;

    const maxConcurrent = Math.min(Math.max(cpuCores, 2), 32);
    recs.push(`security.maxConcurrentTasks: ${maxConcurrent}`);

    const gatewayConcurrency = Math.min(Math.max(Math.floor(cpuCores / 2), 3), 20);
    recs.push(`gateway.maxConcurrentMessages: ${gatewayConcurrency}`);

    const maxMemMB = Math.min(Math.max(Math.floor(ramTotalMB * 0.6), 512), 32768);
    recs.push(`security.maxMemoryMB: ${maxMemMB}`);

    const sandboxMemMB = Math.min(Math.max(Math.floor(ramTotalMB * 0.15), 256), 8192);
    recs.push(`sandbox.memoryMB: ${sandboxMemMB}`);

    if (profile.gpuVendor !== 'none') {
        const reserveMB = Math.min(Math.max(Math.floor(gpuVramMB * 0.1), 512), 4096);
        recs.push(`vram.reserveMB: ${reserveMB}`);
        recs.push(`vram.enabled: true`);
        if (profile.gpuVendor === 'nvidia') {
            recs.push(`nvidia.enabled: true`);
        }
    } else {
        recs.push(`vram.enabled: false`);
    }

    const subAgents = Math.min(Math.max(Math.floor(cpuCores / 4), 1), 8);
    recs.push(`subAgents.maxConcurrent: ${subAgents}`);

    if (diskFreeGB < 50) {
        recs.push(`WARNING: Only ${diskFreeGB} GB disk free`);
    }

    return recs;
}

function recsToConfig(recs: string[], profile: HardwareProfile): Partial<TitanConfig> {
    const partial: Record<string, unknown> = {};

    for (const rec of recs) {
        const m = rec.match(/^([\w.]+):\s*(.+)$/);
        if (!m) continue;
        const key = m[1];
        const valStr = m[2].split(' ')[0];

        if (key === 'security.maxConcurrentTasks') {
            partial.security = { ...(partial.security as object || {}), maxConcurrentTasks: parseInt(valStr, 10) };
        }
        if (key === 'gateway.maxConcurrentMessages') {
            partial.gateway = { ...(partial.gateway as object || {}), maxConcurrentMessages: parseInt(valStr, 10) };
        }
        if (key === 'security.maxMemoryMB') {
            partial.security = { ...(partial.security as object || {}), maxMemoryMB: parseInt(valStr, 10) };
        }
        if (key === 'sandbox.memoryMB') {
            partial.sandbox = { ...(partial.sandbox as object || {}), memoryMB: parseInt(valStr, 10) };
        }
        if (key === 'vram.reserveMB') {
            partial.vram = { ...(partial.vram as object || {}), reserveMB: parseInt(valStr, 10) };
        }
        if (key === 'vram.enabled') {
            partial.vram = { ...(partial.vram as object || {}), enabled: valStr === 'true' };
        }
        if (key === 'nvidia.enabled') {
            partial.nvidia = { ...(partial.nvidia as object || {}), enabled: valStr === 'true' };
        }
        if (key === 'subAgents.maxConcurrent') {
            partial.subAgents = { ...(partial.subAgents as object || {}), maxConcurrent: parseInt(valStr, 10) };
        }
    }

    if (profile.gpuVendor === 'none') {
        partial.agent = { ...(partial.agent as object || {}), modelAliases: { local: 'ollama/qwen3.5:4b' } };
    }

    return partial as Partial<TitanConfig>;
}

/** Apply recommendations to titan.json */
export async function applyAutoConfiguration(dryRun: boolean): Promise<{
    profile: HardwareProfile;
    recommendations: string[];
    applied: boolean;
    changes?: Record<string, unknown>;
}> {
    const profile = await detectHardware();
    const recommendations = generateRecommendations(profile);

    if (dryRun) {
        return { profile, recommendations, applied: false, changes: recsToConfig(recommendations, profile) };
    }

    try {
        const changes = recsToConfig(recommendations, profile);
        updateConfig(changes);
        logger.info(COMPONENT, `Applied ${recommendations.length} hardware auto-config settings`);
        return { profile, recommendations, applied: true, changes };
    } catch (err) {
        logger.error(COMPONENT, `Failed to apply auto-config: ${(err as Error).message}`);
        throw err;
    }
}
