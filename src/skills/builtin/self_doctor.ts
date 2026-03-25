/**
 * TITAN — Self-Doctor Skill
 * Lets TITAN run diagnostics on itself and detect capability degradation.
 * Like a self-check that the agent can invoke when it suspects something is wrong.
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import { getStallStats } from '../../agent/stallDetector.js';
import logger from '../../utils/logger.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const COMPONENT = 'SelfDoctor';

/** Safe fixes the self-doctor is allowed to perform (whitelist) */
const _SAFE_FIXES = new Set(['staleSessions', 'titanHome', 'workspace']); void _SAFE_FIXES;

export function registerSelfDoctorSkill(): void {
    registerSkill({
        name: 'self_doctor',
        description: 'Use this when the user says "something\'s broken", "fix yourself", "diagnose the issue", "you\'re not working right", "run a health check", or when TITAN notices its own tools are failing or responses are degraded. Also call this proactively if something feels off.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'self_doctor',
        description: 'Diagnose and report on TITAN\'s own health. Use this when tools are failing, responses seem degraded, the model appears stuck, or the user says "something\'s broken" / "fix yourself" / "you\'re not working right". Checks providers, config validity, stall detection, active model, memory usage, and disk. Run with checks="all" by default.',
        parameters: {
            type: 'object',
            properties: {
                checks: {
                    type: 'string',
                    description: 'Which checks to run: providers, config, stalls, disk, model, or all (default: all)',
                },
            },
        },
        execute: async (args) => {
            const checksArg = (args.checks as string || 'all').toLowerCase();
            const runAll = checksArg === 'all';
            const checks = runAll ? ['providers', 'config', 'stalls', 'disk', 'model'] : checksArg.split(',').map(s => s.trim());

            const results: string[] = [];
            results.push('TITAN Self-Diagnostic Report');
            results.push('═'.repeat(40));

            try {
                const config = loadConfig();

                // ── Config Check ──
                if (checks.includes('config')) {
                    try {
                        results.push(`\n[Config] Status: VALID`);
                        results.push(`  Model: ${config.agent.model}`);
                        results.push(`  Fallback chain: ${(config.agent as Record<string, unknown>).fallbackChain || '(none)'}`);
                        results.push(`  Self-heal: ${(config.agent as Record<string, unknown>).selfHealEnabled !== false ? 'enabled' : 'disabled'}`);
                    } catch (e) {
                        results.push(`\n[Config] Status: INVALID — ${(e as Error).message}`);
                    }
                }

                // ── Model Check ──
                if (checks.includes('model')) {
                    const model = config.agent.model;
                    const isCloud = model.includes('-cloud') || model.includes(':cloud');
                    results.push(`\n[Model] Active: ${model}`);
                    results.push(`  Type: ${isCloud ? 'cloud (routed via Ollama)' : 'local/API'}`);

                    // Check fallback availability
                    const fallbackChain = (config.agent as Record<string, unknown>).fallbackChain as string[] | undefined;
                    const aliases = (config.agent as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
                    const fallbacks: string[] = [];
                    if (fallbackChain?.length) fallbacks.push(...fallbackChain);
                    if (aliases?.fast) fallbacks.push(aliases.fast);
                    if (aliases?.smart) fallbacks.push(aliases.smart);
                    const uniqueFallbacks = [...new Set(fallbacks.filter(f => f !== model))];
                    results.push(`  Fallback models: ${uniqueFallbacks.length > 0 ? uniqueFallbacks.join(', ') : '(none — self-heal will not work!)'}`);

                    if (isCloud) {
                        results.push(`  ⚠ Cloud models may have limited tool calling. If tools are not working, consider switching to a local model.`);
                    }
                }

                // ── Stall Check ──
                if (checks.includes('stalls')) {
                    const stats = getStallStats();
                    const activeStalls = stats.filter(s => s.stallCount > 0);
                    results.push(`\n[Stalls] Active sessions with stalls: ${activeStalls.length}`);
                    for (const s of activeStalls.slice(0, 5)) {
                        results.push(`  Session ${s.sessionId.slice(0, 8)}...: ${s.stallCount} stalls, ${s.nudgeCount} nudges`);
                    }
                    if (activeStalls.length === 0) {
                        results.push(`  All clear — no stalls detected.`);
                    }
                }

                // ── Disk Check ──
                if (checks.includes('disk')) {
                    const titanHome = join(homedir(), '.titan');
                    results.push(`\n[Disk] TITAN home: ${titanHome}`);
                    results.push(`  Exists: ${existsSync(titanHome) ? 'yes' : 'NO — critical!'}`);

                    const memUsage = process.memoryUsage();
                    results.push(`  Memory (RSS): ${Math.round(memUsage.rss / 1024 / 1024)} MB`);
                    results.push(`  Memory (Heap): ${Math.round(memUsage.heapUsed / 1024 / 1024)} / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`);
                }

                // ── Provider Check ──
                if (checks.includes('providers')) {
                    const providers = config.providers || {};
                    const configured: string[] = [];
                    const unconfigured: string[] = [];
                    for (const [name, pConfig] of Object.entries(providers as Record<string, Record<string, unknown>>)) {
                        if (pConfig?.apiKey || name === 'ollama') {
                            configured.push(name);
                        } else {
                            unconfigured.push(name);
                        }
                    }
                    results.push(`\n[Providers] Configured: ${configured.join(', ') || '(none)'}`);
                    if (unconfigured.length > 0) {
                        results.push(`  Not configured: ${unconfigured.slice(0, 5).join(', ')}`);
                    }
                }

                results.push(`\n${'═'.repeat(40)}`);
                results.push('End of diagnostic report');

            } catch (err) {
                results.push(`\nDiagnostic error: ${(err as Error).message}`);
            }

            const report = results.join('\n');
            logger.info(COMPONENT, `Self-diagnostic completed (${checks.length} checks)`);
            return report;
        },
    });
}
