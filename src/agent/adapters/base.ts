/**
 * TITAN — External Agent Adapter Base Interface
 *
 * Adapters spawn external CLI agents (Claude Code, Codex, etc.) as child
 * processes and capture their output. TITAN injects env vars so the external
 * agent can call back to TITAN's Command Post API if needed.
 */

/** Context passed to every adapter execution */
export interface AdapterContext {
    /** The task/prompt to send to the external agent */
    task: string;
    /** Working directory for the spawned process */
    cwd?: string;
    /** Additional env vars to inject (merged with TITAN vars) */
    env?: Record<string, string>;
    /** Max execution time in ms (default: 300_000 = 5 min) */
    timeoutMs?: number;
    /** Max tool turns for agents that support it */
    maxTurns?: number;
    // ── TITAN env vars injected into all adapters ──
    /** TITAN gateway URL, e.g. "http://localhost:48420" */
    titanApiUrl: string;
    /** Current run ID for cost/tracking attribution */
    titanRunId: string;
    /** Command Post issue ID this execution is for */
    titanIssueId: string;
}

/** Result from an adapter execution */
export interface AdapterResult {
    /** The output content from the external agent */
    content: string;
    /** Process exit code (null if killed by signal) */
    exitCode: number | null;
    /** Whether the execution was successful */
    success: boolean;
    /** Wall-clock execution time in ms */
    durationMs: number;
    /** Tools/commands the external agent used (best-effort parsing) */
    toolsUsed: string[];
}

/** Interface all external adapters must implement */
export interface ExternalAdapter {
    /** Unique adapter type identifier, e.g. "claude-code", "codex", "bash" */
    readonly type: string;
    /** Human-readable display name */
    readonly displayName: string;
    /** Execute the adapter — spawn process, capture output, return result */
    execute(ctx: AdapterContext): Promise<AdapterResult>;
}
