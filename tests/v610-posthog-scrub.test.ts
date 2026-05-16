/**
 * TITAN — v6.1.0 Phase A · Gap 3
 *
 * Secret scrubber must cover every outbound string in the bug-report
 * payload sent to PostHog. The local `~/.titan/bug-reports.jsonl` file
 * remains un-scrubbed (operator source of truth), but anything that
 * crosses the wire to PostHog must be redacted.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../src/security/secretGuard.js';

describe('v6.1.0 Phase A — Gap 3 — outbound secret scrubber', () => {
    it('redacts an OpenAI-style key embedded in a stack trace', () => {
        const stack = [
            'Error: bad call',
            '    at apiCall (foo.js:1:1)',
            '    using sk-abc123DEF456ghi789JKL0',
        ].join('\n');
        const out = redactSecrets(stack);
        expect(out).not.toContain('sk-abc123DEF456ghi789JKL0');
        expect(out).toContain('[REDACTED:openai_api_key]');
    });

    it('redacts a Bearer token in an error message', () => {
        const msg = 'Request failed with Bearer xyz12345abcdef67890ABCDEF';
        const out = redactSecrets(msg);
        expect(out).not.toContain('xyz12345abcdef67890ABCDEF');
        expect(out).toContain('[REDACTED:bearer_token]');
    });

    it('rewrites the operator home dir to ~ in stack paths', () => {
        const home = process.env.HOME || '';
        // Should always be set under test, but guard anyway.
        if (!home || home === '/') return;
        const stack = [
            'Error: file not found',
            `    at readFileSync (${home}/Desktop/TitanBot/TITAN-main/src/foo.ts:42:10)`,
        ].join('\n');
        const out = redactSecrets(stack);
        expect(out).not.toContain(home);
        expect(out).toContain('~/Desktop/TitanBot/TITAN-main/src/foo.ts');
    });

    it('leaves a plain stack with no secrets unchanged', () => {
        const stack = [
            'TypeError: undefined is not a function',
            '    at /opt/TITAN/dist/something.js:10:20',
            '    at Object.<anonymous> (/opt/TITAN/dist/main.js:1:1)',
        ].join('\n');
        const out = redactSecrets(stack);
        expect(out).toBe(stack);
    });

    it('redacts a PostHog phc_ key if it ever ends up in a stack', () => {
        const stack = 'config dump: phc_kVw5xLJx5SVXex9RSTCFwP8cJSNEXTYZ7oJwqoDdMPJX';
        const out = redactSecrets(stack);
        expect(out).not.toContain('phc_kVw5xLJx5SVXex9RSTCFwP8cJSNEXTYZ7oJwqoDdMPJX');
        expect(out).toContain('[REDACTED:posthog_key]');
    });

    it('redacts an AWS access key id', () => {
        const msg = 'aws creds: AKIAIOSFODNN7EXAMPLE failed auth';
        const out = redactSecrets(msg);
        expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(out).toContain('[REDACTED:aws_access_key]');
    });
});
