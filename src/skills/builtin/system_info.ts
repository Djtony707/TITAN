/**
 * TITAN — System Info Skill (Built-in)
 * Returns real hardware, software, and network information from the host system.
 * No API keys required — uses native OS commands.
 */
import { exec } from 'child_process';
import { platform, hostname, totalmem, freemem, cpus, uptime, release, arch, networkInterfaces } from 'os';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'SystemInfo';

/** Run a shell command and return stdout (empty string on error) */
function run(cmd: string, timeout = 5000): Promise<string> {
    return new Promise((resolve) => {
        exec(cmd, { timeout, shell: '/bin/bash' }, (err, stdout) => {
            resolve(err ? '' : stdout.trim());
        });
    });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
    return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

async function gatherSystemInfo(sections: string[]): Promise<string> {
    const wantAll = sections.length === 0 || sections.includes('all');
    const results: string[] = [];
    const os = platform();

    // ── CPU ──────────────────────────────────────────────────────
    if (wantAll || sections.includes('cpu')) {
        const cpuList = cpus();
        const model = cpuList[0]?.model || 'Unknown';
        const cores = cpuList.length;
        const speeds = cpuList.map(c => c.speed);
        const avgSpeed = (speeds.reduce((a, b) => a + b, 0) / speeds.length / 1000).toFixed(2);

        // CPU usage (1-second sample)
        let usageStr = '';
        if (os === 'linux') {
            const loadavg = await run('cat /proc/loadavg');
            if (loadavg) usageStr = `Load Average: ${loadavg.split(' ').slice(0, 3).join(', ')}`;
        } else if (os === 'darwin') {
            const loadavg = await run('sysctl -n vm.loadavg');
            if (loadavg) usageStr = `Load Average: ${loadavg.replace(/[{}]/g, '').trim()}`;
        }

        results.push([
            '## CPU',
            `Model: ${model}`,
            `Cores: ${cores}`,
            `Avg Clock: ${avgSpeed} GHz`,
            `Architecture: ${arch()}`,
            usageStr,
        ].filter(Boolean).join('\n'));
    }

    // ── Memory ──────────────────────────────────────────────────
    if (wantAll || sections.includes('memory')) {
        const total = totalmem();
        const free = freemem();
        const used = total - free;
        const pct = ((used / total) * 100).toFixed(1);

        results.push([
            '## Memory',
            `Total: ${formatBytes(total)}`,
            `Used: ${formatBytes(used)} (${pct}%)`,
            `Free: ${formatBytes(free)}`,
        ].join('\n'));
    }

    // ── GPU ─────────────────────────────────────────────────────
    if (wantAll || sections.includes('gpu')) {
        const nvsmi = await run('nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits 2>/dev/null');
        if (nvsmi) {
            const gpuLines = nvsmi.split('\n').map((line, i) => {
                const [name, memTotal, memUsed, memFree, temp, util] = line.split(', ').map(s => s.trim());
                return [
                    `GPU ${i}: ${name}`,
                    `  VRAM: ${memUsed} MB / ${memTotal} MB (${memFree} MB free)`,
                    `  Temperature: ${temp}°C`,
                    `  Utilization: ${util}%`,
                ].join('\n');
            });
            results.push(['## GPU (NVIDIA)', ...gpuLines].join('\n'));
        } else {
            // Try macOS GPU
            const macGpu = await run('system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset|VRAM|Metal" | head -5');
            if (macGpu) {
                results.push(['## GPU', macGpu].join('\n'));
            } else {
                results.push('## GPU\nNo dedicated GPU detected (or nvidia-smi not available)');
            }
        }
    }

    // ── Disk ────────────────────────────────────────────────────
    if (wantAll || sections.includes('disk')) {
        const dfCmd = os === 'darwin' ? 'df -h / | tail -1' : 'df -h / | tail -1';
        const df = await run(dfCmd);
        if (df) {
            const parts = df.split(/\s+/);
            results.push([
                '## Disk (Root)',
                `Size: ${parts[1]}`,
                `Used: ${parts[2]} (${parts[4]})`,
                `Available: ${parts[3]}`,
            ].join('\n'));
        }
    }

    // ── Network ─────────────────────────────────────────────────
    if (wantAll || sections.includes('network')) {
        const nets = networkInterfaces();
        const ifaceLines: string[] = [];
        for (const [name, addrs] of Object.entries(nets)) {
            if (!addrs) continue;
            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    ifaceLines.push(`${name}: ${addr.address} (${addr.mac})`);
                }
            }
        }

        // Public IP (quick)
        const publicIp = await run('curl -s --max-time 3 ifconfig.me 2>/dev/null');

        results.push([
            '## Network',
            ...ifaceLines,
            publicIp ? `Public IP: ${publicIp}` : null,
        ].filter(Boolean).join('\n'));
    }

    // ── OS / System ─────────────────────────────────────────────
    if (wantAll || sections.includes('os')) {
        let distro = '';
        if (os === 'linux') {
            distro = await run('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \'"\'');
        } else if (os === 'darwin') {
            distro = await run('sw_vers -productName 2>/dev/null') + ' ' + await run('sw_vers -productVersion 2>/dev/null');
        }

        const nodeVer = process.version;

        results.push([
            '## System',
            `Hostname: ${hostname()}`,
            `OS: ${distro || `${os} ${release()}`}`,
            `Kernel: ${release()}`,
            `Architecture: ${arch()}`,
            `Node.js: ${nodeVer}`,
            `Uptime: ${formatUptime(uptime())}`,
        ].join('\n'));
    }

    // ── Docker ──────────────────────────────────────────────────
    if (wantAll || sections.includes('docker')) {
        const dockerVer = await run('docker --version 2>/dev/null');
        if (dockerVer) {
            const containers = await run('docker ps --format "{{.Names}}: {{.Status}}" 2>/dev/null');
            results.push([
                '## Docker',
                dockerVer,
                containers ? `Running containers:\n${containers}` : 'No running containers',
            ].join('\n'));
        }
    }

    // ── Ollama ──────────────────────────────────────────────────
    if (wantAll || sections.includes('ollama')) {
        const ollamaList = await run('curl -s --max-time 3 http://localhost:11434/api/tags 2>/dev/null');
        if (ollamaList) {
            try {
                const parsed = JSON.parse(ollamaList);
                const models = (parsed.models || []).map((m: { name: string; size: number }) =>
                    `  ${m.name} (${formatBytes(m.size)})`
                );
                results.push([
                    '## Ollama Models',
                    models.length > 0 ? models.join('\n') : 'No models installed',
                ].join('\n'));
            } catch {
                // Parse error — skip
            }
        }
    }

    return results.join('\n\n');
}

export function registerSystemInfoSkill(): void {
    registerSkill(
        {
            name: 'system_info',
            description: 'Get real system hardware and software information',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'system_info',
            description: 'Get real hardware and software information about the system TITAN is running on.\n\nUSE THIS WHEN Tony says: "what are the system specs" / "how much RAM do I have" / "what GPU is this" / "show me CPU info" / "check disk space" / "what\'s my IP" / "what Docker containers are running" / "what Ollama models are installed" / "system stats" / "how much memory is free"\n\nSECTIONS: "cpu", "memory", "gpu", "disk", "network", "os", "docker", "ollama", or omit for all\nPass specific sections for faster results (e.g., sections:["memory","gpu"] to check VRAM).',
            parameters: {
                type: 'object',
                properties: {
                    sections: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Which sections to include: "cpu", "memory", "gpu", "disk", "network", "os", "docker", "ollama", or "all" (default). Pass specific sections for faster results.',
                    },
                },
            },
            execute: async (args) => {
                const sections = (args.sections as string[]) || [];
                logger.info(COMPONENT, `System info request: ${sections.length > 0 ? sections.join(', ') : 'all'}`);

                try {
                    const info = await gatherSystemInfo(sections);
                    return info || 'No system information available.';
                } catch (err) {
                    return `Error gathering system info: ${(err as Error).message}`;
                }
            },
        },
    );
}
