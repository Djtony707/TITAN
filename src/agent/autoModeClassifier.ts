/**
 * TITAN — Auto-Mode Classifier (v6.1.0-beta.16, Phase D.4)
 *
 * Reads the tool contract registry to decide whether an incoming
 * tool call can run autonomously, deserves a passive notification,
 * or requires explicit human approval. Pattern from Anthropic's
 * "Claude Code auto-mode" blog (in the Picrew/awesome-agent-harness
 * featured-reading list): classifier-backed approval delegation
 * gives the agent autonomy on safe paths while keeping a kill
 * switch on the risky ones.
 *
 * THREE DECISIONS:
 *
 *   - 'auto'    — run without prompting. Read-only ops + workspace
 *                 writes. Most missions run mostly 'auto' calls.
 *   - 'notify'  — run, but record a passive notification so a
 *                 watcher (Mission Canvas, log tail) can see it
 *                 happened. Default for network calls.
 *   - 'gate'    — require explicit human approval before running.
 *                 Default for destructive ops (shell, delete, etc.)
 *                 AND for any tool without a registered contract
 *                 (unknown → conservative).
 *
 * POLICY OVERRIDES (config.security.autoMode.policy):
 *
 *   - 'standard'  (default) — riskLevel drives the decision per
 *                             the table above.
 *   - 'paranoid'             — every tool call is 'gate'. For
 *                             demos, regulated environments, or
 *                             when Tony is debugging a misbehaving
 *                             agent.
 *   - 'permissive'           — riskLevel 'moderate' is auto-run
 *                             (still 'gate' on 'high'). For
 *                             trusted hot loops where ping-the-user
 *                             on every web_search is annoying.
 *   - 'yolo'                 — everything auto, including 'high'.
 *                             ONLY for sandboxed eval runs. Logs
 *                             a loud warning on init.
 *
 * WHY this module exists:
 *
 *   - Phase D.3 added riskLevel + sideEffects metadata to the 9
 *     canonical contracts. D.4 makes the metadata actually do
 *     something — gating decisions, not just labels.
 *
 *   - The existing approval-gate path in toolRunner uses a hardcoded
 *     "is this tool name dangerous?" list. That's a string-match
 *     allowlist that doesn't scale and doesn't account for HOW the
 *     tool is being used. The classifier is the structural answer:
 *     contracts declare risk; the classifier reads contracts.
 *
 *   - Decoupling the policy from the runner means changing the
 *     gating semantics (e.g. add a new 'risky-during-business-hours'
 *     decision) is a one-file change — never a wholesale runner
 *     refactor.
 *
 * TRADE-OFFS:
 *
 *   - First cut keys decisions on contract.riskLevel alone. A
 *     follow-up could consider call ARGS (e.g. shell with
 *     `command: 'ls'` could be 'auto' while shell with
 *     `command: 'rm -rf'` is still 'gate'). Skipped for now to
 *     keep the surface small + predictable.
 *
 *   - Tools without a registered contract default to 'gate'. This
 *     is conservative but means the long-tail 239 skills will hit
 *     the approval gate on every call until their contracts ship.
 *     If that becomes painful, lift the default to 'notify' via
 *     the `unknownToolDefault` config field.
 *
 * FOLLOW-UP:
 *
 *   - Phase D.5 reads sideEffects==='destructive' to route the
 *     call into a worktree-isolated executor.
 *   - Args-aware classification (shell `rm -rf` vs shell `ls`).
 *   - Per-session policy override so a "draft a quick email"
 *     mission can opt into 'permissive' while a "review and merge
 *     this PR" mission stays on 'paranoid'.
 */

import { getToolContract, type RiskLevel } from './toolContract.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'autoMode';

/* ──────────────────────────  Types  ────────────────────────── */

export type AutoModeDecision = 'auto' | 'notify' | 'gate';
export type AutoModePolicy = 'standard' | 'paranoid' | 'permissive' | 'yolo';

export interface ClassificationResult {
    /** What the runner should do with the call. */
    decision: AutoModeDecision;
    /** Plain-english reason — logged and surfaced in the trajectory. */
    reason: string;
    /** Policy that produced this decision (drives observability). */
    policy: AutoModePolicy;
    /** Risk level from the contract, if any. Undefined for unknown tools. */
    riskLevel?: RiskLevel;
}

/* ──────────────────────────  Policy loader  ────────────────────────── */

/**
 * Resolve the current auto-mode policy. Reads
 * `config.security.autoMode.policy` if present; defaults to 'standard'.
 * Pure synchronous lookup — no IO, safe to call per-tool-call.
 */
export function getAutoModePolicy(): AutoModePolicy {
    // beta.21 — env override. Lets the test suite (and any embedder
    // that wants a process-wide policy without touching config files)
    // short-circuit the classifier without mutating loaded config.
    // Production callers should configure via `config.security.autoMode.policy`
    // — this env hook is opt-in and silent when unset.
    const envPolicy = process.env.TITAN_AUTOMODE_POLICY;
    if (envPolicy === 'paranoid' || envPolicy === 'permissive' || envPolicy === 'yolo' || envPolicy === 'standard') {
        return envPolicy;
    }
    try {
        const cfg = loadConfig();
        const sec = (cfg as Record<string, unknown>).security as Record<string, unknown> | undefined;
        const am = sec?.autoMode as Record<string, unknown> | undefined;
        const policy = am?.policy as string | undefined;
        if (policy === 'paranoid' || policy === 'permissive' || policy === 'yolo' || policy === 'standard') {
            return policy;
        }
    } catch { /* config unavailable — fall through */ }
    return 'standard';
}

/**
 * Inherently high-impact operations that stay gated even without a declared
 * contract — arbitrary command execution, destructive deletes, deploys, and
 * irreversible external sends/payments. Everything else uncontracted runs with
 * a notify (see classifyToolCall). Curated conservatively; a tool that should
 * gate but is missing here can still be added to the user approval list.
 */
const NAME_GATED_EXACT = new Set<string>([
    'shell', 'run_shell', 'bash', 'run_command', 'execute_command', 'exec',
    'delete_file', 'bulk_delete_labels', 'phone_call', 'make_call',
]);
const NAME_GATED_PATTERN = /(^|_)(delete|destroy|wipe|purge|deploy|publish|transfer|payment|purchase|wire|send_email|email_send)(_|$)/i;

export function nameLooksHighImpact(toolName: string): boolean {
    return NAME_GATED_EXACT.has(toolName) || NAME_GATED_PATTERN.test(toolName);
}

/* ──────────────────────────  Classifier  ────────────────────────── */

/**
 * Decide whether a tool call should run automatically, with a
 * notification, or with explicit approval. The runner uses this to
 * decide whether to short-circuit the existing approval-gate path.
 *
 * Pure: no IO beyond reading the config + contract registry. Cheap
 * enough to call on every tool call without measuring.
 */
export function classifyToolCall(toolName: string): ClassificationResult {
    const policy = getAutoModePolicy();
    const contract = getToolContract(toolName);
    const riskLevel = contract?.riskLevel;

    // yolo short-circuit: regardless of risk, run. ONLY for sandboxed
    // eval runs — logs a loud warning the first time per process.
    if (policy === 'yolo') {
        warnYoloOnce();
        return {
            decision: 'auto',
            reason: 'yolo policy — gating disabled',
            policy,
            riskLevel,
        };
    }

    // paranoid short-circuit: every call gated.
    if (policy === 'paranoid') {
        return {
            decision: 'gate',
            reason: 'paranoid policy — every tool call requires approval',
            policy,
            riskLevel,
        };
    }

    // Unknown tool (no registered contract). The long-tail of ~239 skills has
    // no contract, so gating ALL of them walled benign actions (search, read,
    // widget-building, …) behind approval on every call — which broke the
    // "ask TITAN to build a weather widget" flow and made the agent feel broken.
    //
    // v7.0 fix: uncontracted tools run with a 'notify' (visible, logged) by
    // default, EXCEPT a curated set of inherently high-impact operations that
    // stay gated by name. Dangerous shell commands + URLs are independently
    // caught by preExecScan (toolRunner), and external-send tools (email/slack/
    // x/publisher) self-gate via the approval_gates skill — so 'notify' here is
    // safe for the benign majority. Strict users can still set policy='paranoid'.
    if (!contract) {
        if (nameLooksHighImpact(toolName)) {
            return {
                decision: 'gate',
                reason: `no contract + high-impact name "${toolName}" — gating`,
                policy,
            };
        }
        return {
            decision: 'notify',
            reason: `no contract for "${toolName}" — notify (benign long-tail)`,
            policy,
        };
    }

    // Standard + permissive paths read riskLevel.
    if (riskLevel === 'safe') {
        return { decision: 'auto', reason: 'contract riskLevel=safe', policy, riskLevel };
    }
    if (riskLevel === 'moderate') {
        if (policy === 'permissive') {
            return { decision: 'auto', reason: 'permissive policy — moderate risk auto-runs', policy, riskLevel };
        }
        return { decision: 'notify', reason: 'contract riskLevel=moderate', policy, riskLevel };
    }
    if (riskLevel === 'high') {
        return { decision: 'gate', reason: 'contract riskLevel=high', policy, riskLevel };
    }

    // Defensive fallback for an unknown future riskLevel value.
    return {
        decision: 'gate',
        reason: `unrecognised riskLevel "${riskLevel}" — gating defensively`,
        policy,
        riskLevel,
    };
}

/* ──────────────────────────  Helpers  ────────────────────────── */

let _yoloWarned = false;
function warnYoloOnce(): void {
    if (_yoloWarned) return;
    _yoloWarned = true;
    logger.warn(
        COMPONENT,
        'AUTO_MODE=yolo — every tool call will run without approval. This mode is ONLY intended for sandboxed eval runs. If you see this in production logs, something is misconfigured.',
    );
}

/** For tests. */
export function _resetYoloWarning(): void {
    _yoloWarned = false;
}

/**
 * Convenience: returns true iff the decision means the call should
 * NOT proceed without explicit human approval. Used by the runner
 * to short-circuit the existing approval-gate path on 'auto' /
 * 'notify' decisions.
 */
export function shouldGate(result: ClassificationResult): boolean {
    return result.decision === 'gate';
}

/**
 * Format the classification as a one-line breadcrumb suitable for
 * the trajectory `note` event. Used by the runner on 'notify'
 * decisions so the trajectory captures what the agent did
 * autonomously vs what required a human prompt.
 */
export function formatBreadcrumb(toolName: string, result: ClassificationResult): string {
    return `automode:${result.decision} tool=${toolName} risk=${result.riskLevel ?? 'unknown'} policy=${result.policy} (${result.reason})`;
}
