/**
 * TITAN — Tool-result verifier.
 *
 * Why this exists
 * ---------------
 * Small-model agents systematically *claim* success when their tool call
 * actually failed. The harness research is unambiguous on this:
 *
 *   - The verifiers library (https://github.com/willccbb/verifiers) and
 *     SWE-agent's harness paper show that an output-checking pass after
 *     each risky tool call closes most of the "claimed success / actually
 *     failed" failure mode.
 *   - Anthropic — "Effective harnesses for long-running agents" frames
 *     verification as a harness concern, not a model one.
 *   - awesome-agent-harness top-10 pattern #5 ("Verification + evaluation
 *     as first-class").
 *
 * This module ships the FIRST SLICE: pure structural verifiers for a small
 * set of high-traffic tools. Each verifier is a synchronous, side-effect-
 * free function that inspects a tool's stringified or shaped result for
 * known failure signatures (non-zero exit, "Error:" prefixes, 4xx/5xx HTTP,
 * ENOENT, BLOCKED, TIMEOUT, …).
 *
 * The agent loop will call {@link verifyToolResult} after every tool call.
 * If it returns `{ ok: false }`, the loop injects a synthetic feedback
 * message into the conversation:
 *
 *   "Your last tool call appears to have failed: <reason>. The error
 *    must be acknowledged or retried before claiming success."
 *
 * That feedback gives the model one more round to fix the call or admit
 * the failure — closing the loop that small models leave open.
 *
 * Out of scope (deliberately, per the `incremental-implementation` skill):
 *   - LLM-as-judge verifiers (a v6.0 track item)
 *   - Multi-round retry loops with backoff
 *   - Cross-tool semantic verifiers (e.g. "you wrote the file but it has a
 *     syntax error per typecheck")
 *
 * The verifier ALWAYS prefers a false negative over a false positive.
 * If output is ambiguous, return ok=true. The verifier is a safety net,
 * not a critic. (`doubt-driven-development` skill — biased to disprove
 * claims of failure when there's no clear evidence.)
 */

/** Tools subject to verification. Read-only / informational tools are excluded. */
export const RISKY_TOOLS: ReadonlySet<string> = new Set([
    'shell',
    'write_file',
    'edit_file',
    'append_file',
    'read_file',
    'web_fetch',
    'browse_url',
    'execute_code',
    'apply_patch',
]);

export function isRiskyTool(toolName: string): boolean {
    return RISKY_TOOLS.has(toolName);
}

/** What a tool-runner hands to the verifier. */
export interface ToolResultEnvelope {
    toolName: string;
    args: Record<string, unknown>;
    /** Whatever the tool returned. Usually a string for shell/fs/read, an
     *  object for web_fetch and structured tools. */
    result: unknown;
}

/** What the verifier returns. */
export interface VerifierVerdict {
    ok: boolean;
    /** Present when ok=false; a one-line human-readable description of the
     *  evidence so the agent can act on it. */
    reason?: string;
    severity?: 'error' | 'warn';
}

const VERDICT_OK: VerifierVerdict = Object.freeze({ ok: true });

/** Coerce any tool result into a searchable string. Returns '' for null/undefined. */
function stringifyResult(result: unknown): string {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'number' || typeof result === 'boolean') return String(result);
    try {
        return JSON.stringify(result);
    } catch {
        return String(result);
    }
}

/** Helper: detect shell failure signatures. */
function verifyShellResult(env: ToolResultEnvelope): VerifierVerdict {
    const txt = stringifyResult(env.result);
    if (!txt) return VERDICT_OK;

    // Pre-execution scanner block — never a successful call.
    if (/\bBLOCKED:\s*(dangerous|sensitive)/i.test(txt)) {
        return { ok: false, severity: 'error', reason: `Shell call BLOCKED by pre-exec scanner: ${txt.slice(0, 200)}` };
    }
    // Timeout — the tool gave up before the command finished.
    if (/\bTIMEOUT\b/i.test(txt)) {
        return { ok: false, severity: 'error', reason: 'Shell call timeout — command exceeded its time budget' };
    }
    // ENOENT / command-not-found.
    if (/\bENOENT\b|command not found/i.test(txt)) {
        return { ok: false, severity: 'error', reason: 'Shell command not found (ENOENT)' };
    }
    // Explicit non-zero exit code surfaced in the result envelope.
    const exitMatch = txt.match(/"?exitCode"?\s*[:=]\s*(-?\d+)/);
    if (exitMatch) {
        const code = parseInt(exitMatch[1], 10);
        if (Number.isFinite(code) && code !== 0) {
            return { ok: false, severity: 'error', reason: `Shell exit code ${code}` };
        }
    }
    return VERDICT_OK;
}

/** Helper: detect filesystem-tool failures (write/edit/append/read). */
function verifyFsResult(env: ToolResultEnvelope): VerifierVerdict {
    const txt = stringifyResult(env.result);
    if (!txt) return VERDICT_OK;

    // The bundled filesystem skill returns "Error: ..." prose on failure.
    if (/^Error\b/i.test(txt) || /\bError\s+(writing|reading|editing|appending)/i.test(txt)) {
        const m = txt.match(/Error[^\n]+/i);
        return { ok: false, severity: 'error', reason: m ? m[0].slice(0, 200) : 'Filesystem call returned Error' };
    }
    // Path-guard blocks.
    if (/\bBLOCKED:\s*(sensitive|dangerous)/i.test(txt)) {
        return { ok: false, severity: 'error', reason: `Filesystem call BLOCKED: ${txt.slice(0, 200)}` };
    }
    // ENOENT / permission.
    if (/\bENOENT\b|no such file or directory/i.test(txt)) {
        return { ok: false, severity: 'error', reason: 'File not found (ENOENT)' };
    }
    if (/\bEACCES\b|permission denied/i.test(txt)) {
        return { ok: false, severity: 'error', reason: 'Permission denied (EACCES)' };
    }
    // edit_file — the bundled tool emits "Target string not found" when the
    // requested replacement target is absent.
    if (/Target string not found/i.test(txt)) {
        return { ok: false, severity: 'error', reason: 'edit_file: target string not found' };
    }
    return VERDICT_OK;
}

/** Helper: detect web_fetch / browse_url failures. */
function verifyWebFetchResult(env: ToolResultEnvelope): VerifierVerdict {
    // web_fetch returns either { status, content, ... } (success/structured)
    // or a plain string error like "fetch failed: ECONNREFUSED".
    if (env.result && typeof env.result === 'object' && !Array.isArray(env.result)) {
        const r = env.result as { status?: number };
        if (typeof r.status === 'number' && r.status >= 400) {
            return { ok: false, severity: 'error', reason: `web_fetch HTTP ${r.status}` };
        }
        return VERDICT_OK;
    }
    const txt = stringifyResult(env.result);
    if (!txt) return VERDICT_OK;
    if (/\bECONNREFUSED\b|\bENOTFOUND\b|fetch failed/i.test(txt)) {
        return { ok: false, severity: 'error', reason: `web_fetch network error: ${txt.slice(0, 200)}` };
    }
    return VERDICT_OK;
}

/**
 * Verify a tool result against known failure signatures. Returns a verdict
 * the agent loop can act on. Never throws.
 *
 * For tools NOT in {@link RISKY_TOOLS}, always returns ok=true (no opinion).
 */
export function verifyToolResult(env: ToolResultEnvelope): VerifierVerdict {
    try {
        const toolName = env?.toolName;
        if (!toolName || typeof toolName !== 'string' || !isRiskyTool(toolName)) {
            return VERDICT_OK;
        }
        switch (toolName) {
            case 'shell':
            case 'execute_code':
                return verifyShellResult(env);

            case 'read_file':
            case 'write_file':
            case 'edit_file':
            case 'append_file':
            case 'apply_patch':
                return verifyFsResult(env);

            case 'web_fetch':
            case 'browse_url':
                return verifyWebFetchResult(env);

            default:
                return VERDICT_OK;
        }
    } catch {
        // Verifier must never crash the agent loop. If our own code throws,
        // return ok=true (false-negative bias).
        return VERDICT_OK;
    }
}

/**
 * Build the synthetic feedback message the agent loop should inject when
 * the verifier flags a failure the model didn't acknowledge. Format kept
 * short and imperative so small models actually act on it.
 */
export function buildVerifierFeedback(toolName: string, verdict: VerifierVerdict): string {
    const reason = verdict.reason || 'unknown';
    return [
        `Your last tool call (${toolName}) appears to have failed:`,
        `  ${reason}`,
        ``,
        `Acknowledge the failure to the user and either retry with corrected arguments,`,
        `or explain why the task cannot be completed. Do NOT claim success.`,
    ].join('\n');
}
