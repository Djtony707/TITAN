/**
 * TITAN — VRAM Skill (Built-in)
 * Agent-facing tools for GPU VRAM management:
 * - vram_status: Show current GPU VRAM usage, loaded models, and active leases
 * - vram_acquire: Reserve VRAM for a GPU service, auto-downgrading the LLM if needed
 * - vram_release: Release a VRAM lease, optionally restoring the original model
 */
import { registerSkill } from '../registry.js';
import { getVRAMOrchestrator } from '../../vram/orchestrator.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'VRAMSkill';

export function registerVRAMSkills(): void {
    // ── vram_status ────────────────────────────────────────────
    registerSkill({
        name: 'vram_management',
        description: 'GPU VRAM management — status, acquire, release',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'vram_status',
        description: `Show current GPU VRAM usage, loaded models, and active leases.

Returns:
- GPU: total/used/free VRAM, temperature, utilization, GPU name
- Loaded models: name, VRAM usage, quantization, expiry
- Active leases: service, reserved MB, time remaining
- Available VRAM: free minus reserved minus safety buffer`,
        parameters: {
            type: 'object',
            properties: {},
        },
        execute: async () => {
            try {
                const orch = getVRAMOrchestrator();
                const snapshot = await orch.getSnapshot();

                if (!snapshot) {
                    return 'GPU state unavailable. No supported GPU detected (NVIDIA, AMD ROCm, or Apple Silicon required).';
                }

                const { gpu, loadedModels, activeLeases, reservedMB, availableMB } = snapshot;

                let report = `## GPU ${gpu.unifiedMemory ? 'Unified Memory' : 'VRAM'} Status\n\n`;
                report += `**${gpu.gpuName}** (${gpu.driverVersion})\n`;
                report += `- Vendor: ${gpu.vendor.toUpperCase()}${gpu.unifiedMemory ? ' (unified memory — shared with system RAM)' : ''}\n`;
                report += `- Total: ${gpu.totalMB}MB\n`;
                report += `- Used: ${gpu.usedMB}MB (${gpu.totalMB > 0 ? Math.round(gpu.usedMB / gpu.totalMB * 100) : 0}%)\n`;
                report += `- Free: ${gpu.freeMB}MB\n`;
                if (gpu.temperatureC > 0) report += `- Temperature: ${gpu.temperatureC}°C\n`;
                if (gpu.utilizationPct > 0) report += `- GPU Utilization: ${gpu.utilizationPct}%\n`;
                report += `- Available (after reserves): **${availableMB}MB**\n`;

                if (loadedModels.length > 0) {
                    report += `\n### Loaded Models (${loadedModels.length})\n`;
                    for (const m of loadedModels) {
                        report += `- **${m.name}**: ${m.sizeVramMB}MB VRAM`;
                        report += ` (${m.parameterSize}, ${m.quantization})`;
                        if (m.expiresAt !== 'unknown' && m.expiresAt !== 'never') {
                            const remaining = new Date(m.expiresAt).getTime() - Date.now();
                            if (remaining > 0) {
                                report += ` — expires in ${Math.round(remaining / 60000)}min`;
                            }
                        }
                        report += '\n';
                    }
                } else {
                    report += '\n### Loaded Models\nNone\n';
                }

                if (activeLeases.length > 0) {
                    report += `\n### Active Leases (${activeLeases.length}, ${reservedMB}MB reserved)\n`;
                    for (const l of activeLeases) {
                        const remaining = l.expiresAt - Date.now();
                        report += `- **${l.service}**: ${l.reservedMB}MB`;
                        if (remaining > 0) {
                            report += ` (${Math.round(remaining / 1000)}s remaining)`;
                        }
                        if (l.evictedModel) report += ` [evicted: ${l.evictedModel}]`;
                        report += '\n';
                    }
                }

                return report;
            } catch (err) {
                return `VRAM status error: ${(err as Error).message}`;
            }
        },
    });

    // ── vram_acquire ───────────────────────────────────────────
    registerSkill({
        name: 'vram_acquire',
        description: 'Reserve VRAM for a GPU service',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'vram_acquire',
        description: `Reserve VRAM for a GPU service. If not enough free VRAM, automatically swaps the current LLM model to a smaller fallback.

Use before starting GPU-intensive operations (cuOpt, ASR, TTS, etc.).
Returns a lease ID to release when done.

Example: Acquire 5000MB for cuOpt → auto-evicts 35B model, loads 7B fallback, creates lease.`,
        parameters: {
            type: 'object',
            properties: {
                service: {
                    type: 'string',
                    description: 'Service name requesting VRAM (e.g., "cuopt", "orpheus_tts", "nemotron_asr")',
                },
                requiredMB: {
                    type: 'number',
                    description: 'Amount of VRAM needed in megabytes',
                },
                durationSeconds: {
                    type: 'number',
                    description: 'How long to hold the reservation in seconds. Default: 300 (5 min).',
                    default: 300,
                },
            },
            required: ['service', 'requiredMB'],
        },
        execute: async (args: Record<string, unknown>) => {
            const service = args.service as string;
            const requiredMB = args.requiredMB as number;
            const durationSeconds = (args.durationSeconds as number) || 300;

            if (!service || !requiredMB) {
                return 'Error: service and requiredMB are required.';
            }

            if (requiredMB < 1 || requiredMB > 100000) {
                return 'Error: requiredMB must be between 1 and 100000.';
            }

            try {
                const orch = getVRAMOrchestrator();
                const result = await orch.acquire(service, requiredMB, durationSeconds * 1000);

                if (!result.ok) {
                    return `VRAM acquire failed: ${result.error}\nCurrent free: ${result.currentFreeMB}MB`;
                }

                let msg = `✅ VRAM acquired for ${service}\n`;
                msg += `- Lease ID: ${result.leaseId}\n`;
                msg += `- Reserved: ${requiredMB}MB\n`;
                msg += `- Duration: ${durationSeconds}s\n`;
                msg += `- Remaining free: ${result.currentFreeMB}MB\n`;

                if (result.swappedFrom) {
                    msg += `- Swapped: ${result.swappedFrom} → ${result.swappedTo || 'none'}\n`;
                    msg += `- Freed: ${result.freedMB}MB\n`;
                }

                return msg;
            } catch (err) {
                return `VRAM acquire error: ${(err as Error).message}`;
            }
        },
    });

    // ── vram_release ───────────────────────────────────────────
    registerSkill({
        name: 'vram_release',
        description: 'Release a VRAM lease',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'vram_release',
        description: `Release a VRAM lease, freeing the reserved memory. Optionally restores the original larger model that was evicted during acquire.

Use after GPU-intensive operations complete (cuOpt solve finished, ASR session ended, etc.).`,
        parameters: {
            type: 'object',
            properties: {
                leaseId: {
                    type: 'string',
                    description: 'The lease ID returned by vram_acquire',
                },
                restoreModel: {
                    type: 'boolean',
                    description: 'Whether to restore the original model that was swapped out. Default: true.',
                    default: true,
                },
            },
            required: ['leaseId'],
        },
        execute: async (args: Record<string, unknown>) => {
            const leaseId = args.leaseId as string;
            const restoreModel = (args.restoreModel as boolean) ?? true;

            if (!leaseId) {
                return 'Error: leaseId is required.';
            }

            try {
                const orch = getVRAMOrchestrator();
                const result = await orch.release(leaseId, restoreModel);

                if (!result.ok) {
                    return `VRAM release failed: ${result.error}`;
                }

                let msg = `✅ VRAM lease ${leaseId} released.\n`;
                if (result.restoredModel) {
                    msg += `- Restored model: ${result.restoredModel}\n`;
                }

                return msg;
            } catch (err) {
                return `VRAM release error: ${(err as Error).message}`;
            }
        },
    });

    logger.info(COMPONENT, 'VRAM management skills registered (vram_status, vram_acquire, vram_release)');
}
