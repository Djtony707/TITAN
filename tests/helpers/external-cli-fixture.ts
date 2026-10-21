import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, vi } from 'vitest';

interface Invocation { cli: string; args: string[]; input?: string; apiUrl?: string; runId?: string; issueId?: string }

/** Exercise real child-process plumbing without discovering authenticated user CLIs. */
export function useExternalCliFixture() {
    let directory: string;
    let record: string;
    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'titan-cli-fixture-'));
        record = join(directory, 'invocations.jsonl');
        const source = `import { appendFileSync } from 'node:fs';
const cli = process.argv[2];
const args = process.argv.slice(3);
let input = '';
if (cli === 'codex') for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.TITAN_CLI_FIXTURE_RECORD, JSON.stringify({ cli, args, input, apiUrl: process.env.TITAN_API_URL, runId: process.env.TITAN_RUN_ID, issueId: process.env.TITAN_ISSUE_ID }) + '\\n');
if (process.env.TITAN_CLI_FIXTURE_MODE === 'timeout') { setInterval(() => {}, 1000); }
else if (process.env.TITAN_CLI_FIXTURE_MODE === 'error') { console.error('synthetic-cli-error'); process.exitCode = 7; }
else if (cli === 'codex') console.log(JSON.stringify({ result: 'synthetic-codex-result' }));
else console.log('synthetic-claude-result');
`;
        const payload = join(directory, 'cli-fixture.mjs');
        writeFileSync(payload, source);
        const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        for (const cli of ['claude', 'codex']) {
            // A shebang cannot quote a Node executable path containing spaces.
            const launcher = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(payload)} ${shellQuote(cli)} "$@"\n`;
            writeFileSync(join(directory, cli), launcher, { mode: 0o755 });
        }
        // PATH retains system utilities needed by bash tests; both agent names resolve to fixtures first.
        vi.stubEnv('PATH', `${directory}${delimiter}${process.env.PATH ?? ''}`);
        vi.stubEnv('TITAN_CLI_FIXTURE_RECORD', record);
        vi.stubEnv('TITAN_CLI_FIXTURE_MODE', 'success');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
    });
    return {
        directory: () => directory,
        mode: (value: 'success' | 'error' | 'timeout') => vi.stubEnv('TITAN_CLI_FIXTURE_MODE', value),
        invocations: (): Invocation[] => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    };
}
