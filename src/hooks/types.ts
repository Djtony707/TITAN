/**
 * TITAN v5.0 — Hook Types
 */

export type ShellHookEvent =
    | 'pre_tool_call'
    | 'post_tool_call'
    | 'on_session_start'
    | 'on_session_end'
    | 'on_round_start'
    | 'on_round_end';

export interface ShellHookEnv {
    TITAN_SESSION_ID: string;
    TITAN_AGENT_ID: string;
    TITAN_TOOL_NAME?: string;
    TITAN_TOOL_ARGS?: string;
    TITAN_TOOL_RESULT?: string;
    TITAN_ROUND?: string;
}

export interface ShellHookResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    blocked?: boolean;
    blockReason?: string;
}
