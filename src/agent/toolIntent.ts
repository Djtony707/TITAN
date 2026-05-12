/**
 * TITAN — Tool intent classification.
 *
 * Why this exists
 * ---------------
 * 12 Factor §8 ("Own your control flow") frames the harness's job as: take
 * the LLM's proposed next step, classify it (sync vs async vs destructive),
 * and route accordingly — continue the loop for sync, break and confirm for
 * destructive, break and persist for long-running async.
 *
 * Today TITAN's agent loop fires every tool call the moment the LLM emits
 * it. That's fine for `read_file` and `web_search`, but it means a
 * destructive `shell` call (e.g. `rm -rf /tmp/cache`) executes without any
 * harness-level checkpoint. The pre-execution scanner is the safety net,
 * but that's a deny-list — it catches well-known bad patterns, not
 * "this command is destructive in this user's context."
 *
 * v5.8.0 ships the CLASSIFICATION layer. The actual selection-vs-invocation
 * GATE (where approval prompts plug in) is a v6.0 item. Once the kinds are
 * data, the gate is just an `if (isDestructive(toolName) && needsApproval)
 * { await getUserConfirm() }` away.
 *
 * Reference:
 *   - https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md
 *   - awesome-agent-harness top-10 pattern #9 "Approval delegation + HITL"
 *   - Claude Code "auto mode" — classifier-backed approval delegation
 *
 * Classification scheme:
 *   sync           — read-only or trivially reversible; fire-and-continue
 *   risky          — state-mutating but rollback-able via shadow-git / config
 *   destructive    — can mutate the OS, the network, or external services
 *                    in non-reversible ways
 *   long-running   — network or browser-bound; the result takes seconds
 *                    and may want async confirmation later
 *
 * Default for unknown tools is `sync` (false-negative bias — don't gate
 * what we don't understand).
 */

export type ToolKind = 'sync' | 'risky' | 'destructive' | 'long-running';

/**
 * Explicit classifications for known tools. Anything not in this map
 * defaults to `sync` via {@link getToolKind}.
 *
 * Editing rules:
 *   - Adding a NEW tool: default to `sync` unless you can name a way it
 *     can damage state. Then upgrade to risky / destructive.
 *   - Promoting a tool TO destructive: must be reviewed by code-review-and-quality.
 *     Once a tool is destructive, future approval-gate work will surface
 *     a confirm prompt for it.
 */
export const TOOL_KINDS: Readonly<Record<string, ToolKind>> = Object.freeze({
    // ── sync: read-only or trivially reversible ──
    read_file:          'sync',
    list_dir:           'sync',
    web_search:         'sync',
    current_model:      'sync',
    list_personas:      'sync',
    get_persona:        'sync',
    gallery_search:     'sync',
    gallery_get:        'sync',
    gallery_list:       'sync',
    memory:             'sync',
    graph_search:       'sync',
    graph_recall:       'sync',
    graph_entities:     'sync',
    tool_search:        'sync',
    list_uploads:       'sync',
    read_upload:        'sync',
    sessions_list:      'sync',
    sessions_history:   'sync',
    system_info:        'sync',
    weather:            'sync',
    audit_log:          'sync',

    // ── risky: state-mutating, rollback-able via shadow-git or config ──
    write_file:         'risky',
    edit_file:          'risky',
    append_file:        'risky',
    apply_patch:        'risky',
    graph_remember:     'risky',
    switch_persona:     'risky',
    switch_model:       'risky',
    save_skill:         'risky',
    sessions_close:     'risky',

    // ── destructive: can mutate OS / network / external services irreversibly ──
    shell:              'destructive',
    execute_code:       'destructive',
    exec:               'destructive',
    process:            'destructive',

    // ── long-running: network or browser-bound, async by nature ──
    web_fetch:          'long-running',
    browse_url:         'long-running',
    browser_screenshot: 'long-running',
    browser_search:     'long-running',
    web_browse_llm:     'long-running',
    web_act:            'long-running',
    web_read:           'long-running',
    cron:               'long-running',
    webhook:            'long-running',
    fb_post:            'long-running',
    fb_reply:           'long-running',
    x_post:             'long-running',
    x_reply:            'long-running',
    email_send:         'long-running',
    slack_post:         'long-running',
    deep_research:      'long-running',
    research:           'long-running',
});

/** Return the kind for a tool. Unknown tools default to `sync`. */
export function getToolKind(toolName: string): ToolKind {
    if (!toolName || typeof toolName !== 'string') return 'sync';
    return TOOL_KINDS[toolName] ?? 'sync';
}

/** A tool is "risky" if it's either risky or destructive (destructive is a strict superset). */
export function isRisky(toolName: string): boolean {
    const k = getToolKind(toolName);
    return k === 'risky' || k === 'destructive';
}

/** A tool is "destructive" only when it's classified that way. */
export function isDestructive(toolName: string): boolean {
    return getToolKind(toolName) === 'destructive';
}

/** A tool is "long-running" when it does network / browser / external I/O. */
export function isLongRunning(toolName: string): boolean {
    return getToolKind(toolName) === 'long-running';
}
