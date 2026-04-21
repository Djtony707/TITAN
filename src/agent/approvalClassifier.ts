/**
 * TITAN — Approval Classifier
 *
 * Gap 4 of plan-this-logical-ocean. Tony's complaint was literal:
 *
 *   "I don't understand some of the approval requests, they are talking
 *    too technical."
 *
 * This module lets the human approval queue stop filling up with things
 * that never needed a human in the first place — read-only filesystem
 * inspection under already-trusted paths, for example. It is OFF by
 * default so the governance posture stays the same until Tony opts in.
 *
 * Borrowed from OpenClaw's `acp/approval-classifier.ts` pattern, trimmed
 * to TITAN's approval shape:
 *
 *   - An approval is { type, payload } where payload may carry `kind`,
 *     `path`, `command`, etc. (free-form Record<string, unknown>).
 *   - Rules match on (type, kind, pathPrefix). The first matching rule
 *     wins; `require` rules beat `auto` rules at the same specificity.
 *   - Unknown / no match → default to 'require' (current behaviour).
 *
 * Built-in defaults are intentionally narrow: reads, lists, stats under
 * the handful of paths Tony already lives in. Writes, shell commands,
 * network calls, and anything outside those paths still require a human.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'ApprovalClassifier';

export type ClassifierAction = 'auto' | 'require' | 'unknown';

export interface ApprovalRule {
    /** Approval type to match, or '*' for any. */
    type: string;
    /** payload.kind to match, or '*' for any. */
    kind: string;
    /** Path prefix payload.path must start with. Undefined = no path check. */
    pathPrefix?: string;
    /** 'auto' short-circuits to approved; 'require' forces human. */
    action: 'auto' | 'require';
}

/** Intent descriptor extracted from an approval for classification. */
export interface ApprovalIntent {
    type: string;
    payload: Record<string, unknown>;
}

/**
 * Built-in defaults. These are the only paths auto-approve considers
 * safe out of the box:
 *
 *   - ~/Desktop/TitanBot        (Tony's working checkout on Mac)
 *   - /opt/TITAN                (live service root on Titan PC)
 *   - /tmp                      (scratch space)
 *
 * Read-only verbs only: read_file, list_files, stat, glob.
 * Every write, shell command, and network action stays human-gated.
 */
const READONLY_KINDS = new Set(['read_file', 'read', 'list_files', 'ls', 'stat', 'glob', 'exists', 'file_info']);
const DEFAULT_READONLY_PREFIXES = [
    // Mac working checkout (expanded at match time via $HOME)
    '~/Desktop/TitanBot',
    '~/Desktop/TITAN-main',
    // Titan PC live service
    '/opt/TITAN',
    // Scratch
    '/tmp',
];

function expandHome(prefix: string): string {
    if (!prefix.startsWith('~')) return prefix;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return prefix;
    return prefix.replace(/^~/, home);
}

function pathStartsWith(absPath: string, prefix: string): boolean {
    const expanded = expandHome(prefix);
    // Normalize trailing slashes so /opt/TITAN matches /opt/TITAN/ and /opt/TITAN/docs
    const needle = expanded.endsWith('/') ? expanded : expanded + '/';
    const hay = absPath.endsWith('/') ? absPath : absPath + '/';
    return hay.startsWith(needle) || absPath === expanded;
}

function ruleMatches(rule: ApprovalRule, intent: ApprovalIntent): boolean {
    if (rule.type !== '*' && rule.type !== intent.type) return false;

    const kind = typeof intent.payload.kind === 'string' ? intent.payload.kind : '';
    if (rule.kind !== '*' && rule.kind !== kind) return false;

    if (rule.pathPrefix) {
        const path = typeof intent.payload.path === 'string' ? intent.payload.path : '';
        if (!path) return false;
        if (!pathStartsWith(path, rule.pathPrefix)) return false;
    }

    return true;
}

function defaultReadonlyRule(intent: ApprovalIntent): ClassifierAction {
    const kind = typeof intent.payload.kind === 'string' ? intent.payload.kind : '';
    if (!READONLY_KINDS.has(kind)) return 'unknown';
    const path = typeof intent.payload.path === 'string' ? intent.payload.path : '';
    if (!path) return 'unknown';
    for (const prefix of DEFAULT_READONLY_PREFIXES) {
        if (pathStartsWith(path, prefix)) return 'auto';
    }
    return 'unknown';
}

/**
 * Classify an approval intent into auto / require / unknown.
 *
 * Evaluation order:
 *   1. User-defined rules (first match wins, explicit `require` overrides).
 *   2. Built-in readonly allowlist (read verb + trusted path → auto).
 *   3. Default: unknown → caller treats as require.
 *
 * @param intent - The approval being classified.
 * @param userRules - Rules from `commandPost.autoApprove.rules`. May be empty.
 */
export function classifyApprovalIntent(
    intent: ApprovalIntent,
    userRules: ApprovalRule[] = [],
): ClassifierAction {
    // 1) Explicit user rules (first match wins). A `require` rule here
    //    takes priority over any built-in auto-approve. This lets Tony
    //    pin "never auto-approve anything in /opt/TITAN/secrets" even
    //    though /opt/TITAN is on the default allowlist.
    for (const rule of userRules) {
        if (ruleMatches(rule, intent)) {
            return rule.action;
        }
    }

    // 2) Built-in readonly defaults.
    const def = defaultReadonlyRule(intent);
    if (def !== 'unknown') return def;

    // 3) Nothing matched — fall through to human approval.
    return 'unknown';
}

/**
 * Convenience wrapper for commandPost.createApproval. Reads the config,
 * classifies, and returns whether the caller should short-circuit. Returns
 * false (do not short-circuit) when:
 *   - autoApprove.enabled is false
 *   - the classifier returns 'require' or 'unknown'
 */
export function shouldAutoApprove(
    intent: ApprovalIntent,
    autoApproveConfig?: { enabled?: boolean; rules?: ApprovalRule[] },
): boolean {
    if (!autoApproveConfig?.enabled) return false;
    const rules = autoApproveConfig.rules || [];
    const action = classifyApprovalIntent(intent, rules);
    if (action === 'auto') {
        logger.info(
            COMPONENT,
            `Auto-approved ${intent.type}/${intent.payload.kind ?? '-'} path=${intent.payload.path ?? '-'}`,
        );
        return true;
    }
    return false;
}
