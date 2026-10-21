/** Manual, separately authorized integration check; never included in npm test. */
const provider = process.argv.find(argument => argument.startsWith('--provider='))?.split('=')[1];
if (process.env.TITAN_ALLOW_REAL_CLI_TESTS !== '1' ||
    !process.argv.includes('--allow-real-provider-calls') ||
    provider !== 'codex') {
    console.error('Refusing real CLI calls. After explicit authorization, set TITAN_ALLOW_REAL_CLI_TESTS=1 and pass --allow-real-provider-calls --provider=codex. Only Codex is supported. This can use credentials, MCP tools and paid inference.');
    process.exitCode = 1;
} else {
    const { getAdapter } = await import('../src/agent/adapters/index.js');
    const result = await getAdapter('codex')!.execute({
        task: 'Reply with only: TITAN manual CLI check',
        titanApiUrl: 'http://127.0.0.1:48420',
        titanRunId: `manual-cli-${Date.now()}`,
        titanIssueId: 'manual-cli-integration',
        timeoutMs: 10000,
    });
    // Report status only; model output may contain local context.
    console.log(JSON.stringify({ provider, success: result.success, exitCode: result.exitCode, durationMs: result.durationMs }));
    if (!result.success) process.exitCode = 1;
}
