/**
 * TITAN — Test Runner
 * Spawns vitest with supplied options and streams back pass/fail counts.
 */
import { spawn } from 'child_process';

export async function runTests(
    opts?: { pattern?: string; watch?: boolean; coverage?: boolean; timeout?: number },
): Promise<Record<string, unknown>> {
    const args = ['vitest', opts?.watch ? '' : 'run'];
    if (opts?.pattern) args.push(opts.pattern);
    if (opts?.coverage) args.push('--coverage');
    if (opts?.timeout) args.push('--testTimeout', String(opts.timeout));

    const filtered = args.filter(Boolean) as string[];

    return new Promise((resolve) => {
        const child = spawn('npx', filtered, { cwd: process.cwd(), shell: true });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });

        child.on('close', (code) => {
            const passMatch = stdout.match(/(\d+)\s+passed/);
            const failMatch = stdout.match(/(\d+)\s+failed/);
            resolve({
                status: code === 0 ? 'passed' : 'failed',
                passed: passMatch ? parseInt(passMatch[1], 10) : 0,
                failed: failMatch ? parseInt(failMatch[1], 10) : 0,
                exitCode: code,
            });
        });
    });
}
