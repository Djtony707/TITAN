/**
 * Dev Skill: Performance Profiler
 * Profiles TITAN operations and identifies bottlenecks.
 */
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { execSync } from 'child_process';

export function register(): void {
    registerSkill({
        name: 'dev_perf',
        description: 'Performance profiler — identifies bottlenecks in TITAN operations',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'perf_profile',
        description: 'Profile a TITAN operation or analyze performance characteristics of a file/module.',
        parameters: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'File path or module name to profile' },
                command: { type: 'string', description: 'Shell command to profile (runs with --prof flag)' },
                duration: { type: 'number', description: 'Profile duration in seconds', default: 10 },
            },
        },
        execute: async (args: Record<string, unknown>) => {
            const target = args.target as string | undefined;
            const command = args.command as string | undefined;

            let profileData = '';

            if (command) {
                try {
                    profileData = execSync(`${command} 2>&1`, {
                        encoding: 'utf-8',
                        timeout: ((args.duration as number) || 10) * 1000 + 5000,
                    });
                } catch (err: unknown) {
                    profileData = `Command output:\n${(err as { stdout?: string }).stdout || (err as Error).message}`;
                }
            }

            // Collect basic Node.js metrics
            const metrics = {
                heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
                external: Math.round(process.memoryUsage().external / 1024 / 1024),
                uptime: Math.round(process.uptime()),
                cpuUser: process.cpuUsage().user,
                cpuSystem: process.cpuUsage().system,
            };

            const config = loadConfig();
            const model = config.agent.modelAliases?.fast || 'ollama/qwen3.5:cloud';

            const response = await chat({
                model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a performance engineer analyzing a Node.js/TypeScript AI agent framework. Identify bottlenecks, memory issues, and optimization opportunities. Be specific and actionable.',
                    },
                    {
                        role: 'user',
                        content: `Performance analysis${target ? ` for ${target}` : ''}:\n\nProcess metrics: ${JSON.stringify(metrics, null, 2)}\n\n${profileData ? `Profile output:\n${profileData.slice(0, 8000)}` : 'No profile data — analyze based on metrics and known patterns.'}`,
                    },
                ],
                maxTokens: 4096,
                temperature: 0.2,
            });

            return `## Performance Profile${target ? `: ${target}` : ''}\n\n**Memory:** ${metrics.heapUsed}MB used / ${metrics.heapTotal}MB total (RSS: ${metrics.rss}MB)\n**Uptime:** ${metrics.uptime}s\n\n${response.content}`;
        },
    });
}
