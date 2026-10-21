import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        const source = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const cli = basename(process.argv[1]);
const args = process.argv.slice(2);
let input = '';
if (cli === 'codex') for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.TITAN_CLI_FIXTURE_RECORD, JSON.stringify({ cli, args, input, apiUrl: process.env.TITAN_API_URL, runId: process.env.TITAN_RUN_ID, issueId: process.env.TITAN_ISSUE_ID }) + '\\n');
if (cli === 'claude' && args.length === 1 && args[0] === '--version') { console.log('1.0.0 (synthetic fixture)'); process.exit(0); }
if (process.env.TITAN_CLI_FIXTURE_MODE === 'timeout') { setInterval(() => {}, 1000); }
else if (process.env.TITAN_CLI_FIXTURE_MODE === 'error') { console.error('synthetic-cli-error'); process.exitCode = 7; }
else if (cli === 'codex') console.log(JSON.stringify({ result: 'synthetic-codex-result' }));
else console.log('synthetic-claude-result');
`;
        for (const cli of ['claude', 'codex']) writeFileSync(join(directory, cli), source, { mode: 0o755 });
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
        mode: (value: 'success' | 'error' | 'timeout') => vi.stubEnv('TITAN_CLI_FIXTURE_MODE', value),
        invocations: (): Invocation[] => readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    };
}
