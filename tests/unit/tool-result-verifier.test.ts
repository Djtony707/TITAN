/**
 * Tool-result verifier — unit tests.
 *
 * Why this exists
 * ---------------
 * Small-model agents systematically claim success when their tool call
 * actually failed. The verifiers library (https://github.com/willccbb/verifiers)
 * and SWE-agent's harness paper both establish that an output-checking pass
 * after each risky tool call closes most of the "claimed-success-actually-
 * failed" failure mode. SWE-agent gets ~50% on SWE-bench with this pattern;
 * base models without one hit ~5%.
 *
 * This file pins the FIRST SLICE: pure structural checks (exit codes, error
 * strings, HTTP status) for five high-traffic tools. LLM-as-judge verifiers
 * are out of scope here — they land in a later phase. Per
 * `incremental-implementation` and `doubt-driven-development`:
 * we ship one thin layer that we can audit cheaply, not a grand framework.
 *
 * Reference:
 *   - https://github.com/willccbb/verifiers
 *   - Anthropic — "Effective harnesses for long-running agents"
 *   - Picrew/awesome-agent-harness top-10 pattern #5
 *     (Verification + evaluation as first-class)
 */
import { describe, it, expect } from 'vitest';
import {
    verifyToolResult,
    isRiskyTool,
    RISKY_TOOLS,
    type ToolResultEnvelope,
} from '../../src/agent/toolResultVerifier.js';

describe('isRiskyTool — gate', () => {
    it('includes the high-traffic tools we intend to verify', () => {
        for (const t of ['shell', 'write_file', 'edit_file', 'web_fetch', 'read_file']) {
            expect(isRiskyTool(t), `${t} should be classified as risky`).toBe(true);
        }
    });

    it('excludes low-risk read-only / informational tools', () => {
        for (const t of ['list_dir', 'web_search', 'current_model', 'list_personas']) {
            expect(isRiskyTool(t), `${t} should NOT be classified as risky`).toBe(false);
        }
    });

    it('RISKY_TOOLS is non-empty and is a subset of what isRiskyTool accepts', () => {
        expect(RISKY_TOOLS.size).toBeGreaterThan(0);
        for (const t of RISKY_TOOLS) expect(isRiskyTool(t)).toBe(true);
    });
});

describe('verifyToolResult — shell', () => {
    it('passes a successful shell call', () => {
        const env: ToolResultEnvelope = {
            toolName: 'shell',
            args: { command: 'echo hi' },
            result: 'hi',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(true);
    });

    it('flags a non-zero exit code surfaced in the stringified result', () => {
        const env: ToolResultEnvelope = {
            toolName: 'shell',
            args: { command: 'false' },
            result: 'exitCode: 1\nstderr: ...',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.severity).toBe('error');
        expect(v.reason).toMatch(/exit/i);
    });

    it('flags BLOCKED pre-exec scanner output', () => {
        const env: ToolResultEnvelope = {
            toolName: 'shell',
            args: { command: 'rm -rf /' },
            result: 'BLOCKED: dangerous pattern matched',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/BLOCKED/);
    });

    it('flags TIMEOUT', () => {
        const env: ToolResultEnvelope = {
            toolName: 'shell',
            args: { command: 'sleep 999' },
            result: 'TIMEOUT after 60000ms',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/timeout/i);
    });

    it('flags ENOENT (command not found)', () => {
        const env: ToolResultEnvelope = {
            toolName: 'shell',
            args: { command: 'nonsuch' },
            result: 'ENOENT: command not found: nonsuch',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/ENOENT|not found/i);
    });
});

describe('verifyToolResult — write_file / edit_file', () => {
    it('passes a successful write', () => {
        const env: ToolResultEnvelope = {
            toolName: 'write_file',
            args: { path: '/tmp/x.txt', content: 'hi' },
            result: 'Successfully wrote 2 bytes to /tmp/x.txt',
        };
        expect(verifyToolResult(env).ok).toBe(true);
    });

    it('flags write_file "Error" prefix returned in result text', () => {
        const env: ToolResultEnvelope = {
            toolName: 'write_file',
            args: { path: '/etc/passwd', content: 'pwned' },
            result: 'Error writing file: EACCES: permission denied',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/permission/i);
    });

    it('flags edit_file when target not found', () => {
        const env: ToolResultEnvelope = {
            toolName: 'edit_file',
            args: { path: '/tmp/x.txt', target: 'foo', replacement: 'bar' },
            result: 'Error: Target string not found',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/target.*not found/i);
    });

    it('flags edit_file destructive-rewrite block message', () => {
        const env: ToolResultEnvelope = {
            toolName: 'write_file',
            args: { path: '/x.ts', content: 'a' },
            result: 'Error: write_file would replace 200 lines with only 5 lines',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/replace/i);
    });
});

describe('verifyToolResult — web_fetch', () => {
    it('passes a 2xx response', () => {
        const env: ToolResultEnvelope = {
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
            result: { status: 200, url: 'https://example.com', content: '<html>...</html>' },
        };
        expect(verifyToolResult(env).ok).toBe(true);
    });

    it('flags 4xx response', () => {
        const env: ToolResultEnvelope = {
            toolName: 'web_fetch',
            args: { url: 'https://example.com/missing' },
            result: { status: 404, url: 'https://example.com/missing', content: 'Not Found' },
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.severity).toBe('error');
        expect(v.reason).toMatch(/404/);
    });

    it('flags 5xx response', () => {
        const env: ToolResultEnvelope = {
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
            result: { status: 503, url: 'https://example.com', content: '' },
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/503/);
    });

    it('flags ECONNREFUSED string result', () => {
        const env: ToolResultEnvelope = {
            toolName: 'web_fetch',
            args: { url: 'http://does-not-exist.local' },
            result: 'fetch failed: ECONNREFUSED',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/ECONNREFUSED|fetch failed/);
    });
});

describe('verifyToolResult — read_file', () => {
    it('passes a normal read', () => {
        const env: ToolResultEnvelope = {
            toolName: 'read_file',
            args: { path: '/tmp/x.txt' },
            result: '   1\thello\n   2\tworld',
        };
        expect(verifyToolResult(env).ok).toBe(true);
    });

    it('flags ENOENT', () => {
        const env: ToolResultEnvelope = {
            toolName: 'read_file',
            args: { path: '/tmp/missing' },
            result: 'Error: ENOENT: no such file or directory',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/ENOENT|not found/i);
    });

    it('flags BLOCKED sensitive path', () => {
        const env: ToolResultEnvelope = {
            toolName: 'read_file',
            args: { path: '~/.ssh/id_rsa' },
            result: 'BLOCKED: sensitive path',
        };
        const v = verifyToolResult(env);
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/BLOCKED/);
    });
});

describe('verifyToolResult — unknown / non-risky tools', () => {
    it('returns ok=true (no opinion) for tools not in the risky set', () => {
        const env: ToolResultEnvelope = {
            toolName: 'some_random_tool',
            args: {},
            result: 'whatever',
        };
        expect(verifyToolResult(env).ok).toBe(true);
    });

    it('is robust to undefined or object results', () => {
        expect(verifyToolResult({
            toolName: 'shell',
            args: {},
            result: undefined,
        }).ok).toBe(true);

        expect(verifyToolResult({
            toolName: 'shell',
            args: {},
            result: { totally: 'unexpected', shape: true },
        }).ok).toBe(true);
    });
});

describe('verifier — silent on success (HumanLayer "Skill Issue" principle)', () => {
    // HumanLayer's "Skill Issue" post documents that successful verifier
    // runs should produce NO observable output — no log line, no synthetic
    // user message, no reason field. Anything else trains the model to
    // expect verifier chatter on success, which then dilutes the signal
    // when something actually goes wrong. The agent loop's injection gate
    // is `!verdict.ok && verdict.reason`, so both halves must be clean.
    //
    // Reference: https://humanlayer.dev/blog/skill-issue
    it('successful shell call returns a clean ok verdict (no reason, no severity)', () => {
        const v = verifyToolResult({
            toolName: 'shell',
            args: { command: 'echo hi' },
            result: 'hi',
        });
        expect(v.ok).toBe(true);
        expect(v.reason).toBeUndefined();
        expect(v.severity).toBeUndefined();
    });

    it('successful write_file returns a clean ok verdict', () => {
        const v = verifyToolResult({
            toolName: 'write_file',
            args: { path: '/tmp/x.txt', content: 'ok' },
            result: 'Wrote 2 bytes to /tmp/x.txt',
        });
        expect(v.ok).toBe(true);
        expect(v.reason).toBeUndefined();
    });

    it('successful web_fetch (HTTP 200) returns a clean ok verdict', () => {
        const v = verifyToolResult({
            toolName: 'web_fetch',
            args: { url: 'https://example.com' },
            result: { status: 200, content: '<!doctype html>...' },
        });
        expect(v.ok).toBe(true);
        expect(v.reason).toBeUndefined();
    });

    it('non-risky tool always returns a clean ok verdict — no opinion offered', () => {
        const v = verifyToolResult({
            toolName: 'current_model',
            args: {},
            result: { provider: 'ollama', model: 'qwen3.5:cloud' },
        });
        expect(v.ok).toBe(true);
        expect(v.reason).toBeUndefined();
        expect(v.severity).toBeUndefined();
    });
});

describe('verifier resilience', () => {
    it('never throws on malformed input', () => {
        // Pass garbage and verify we get a structured response, not a crash.
        const cases: Array<Partial<ToolResultEnvelope>> = [
            {},
            { toolName: 'shell' },
            { toolName: 'shell', result: null as unknown as string },
            { toolName: 'shell', result: 12345 as unknown as string },
        ];
        for (const c of cases) {
            expect(() => verifyToolResult(c as ToolResultEnvelope)).not.toThrow();
        }
    });

    it('false negatives are preferred over false positives (per skill: doubt-driven)', () => {
        // When the result is ambiguous, return ok=true — don't second-guess
        // successful calls. The verifier is a safety net, not a critic.
        const env: ToolResultEnvelope = {
            toolName: 'shell',
            args: { command: 'grep error logfile' },
            result: 'error: deprecated flag (this is grep output, not a tool failure)',
        };
        // We don't have signal that this is a TOOL failure (just user-content
        // that mentions "error"). The verifier should NOT flag this.
        const v = verifyToolResult(env);
        // We expect ok=true because the result isn't structurally a shell error.
        expect(v.ok).toBe(true);
    });
});
