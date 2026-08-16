/**
 * TITAN v8 Slice 4 — Task Signature Abstraction
 *
 * Extracts the intent + typed entity placeholders from task trajectories.
 * A task signature captures WHAT was asked (intent + variable parts),
 * distinct from the tool-sequence signature (HOW it was solved) that
 * muscleMemory already mines.
 *
 * Example:
 *   "Deploy auth to staging" → intent: "deploy", entities: {target: "auth", env: "staging"}
 *   "Check why payments returns 500" → intent: "diagnose", entities: {component: "payments", error: "500"}
 *
 * The signature string is: intent::entity_type_1::entity_type_2::...
 * This is the clustering key for the nightly RECOGNIZE pass.
 *
 * Flag-off invariant: when v8 is disabled, no signature extraction runs.
 * The module exports are pure functions — no side effects on import.
 */
import { createHash } from 'crypto';

// ── Types ───────────────────────────────────────────────────────────

/** A typed entity placeholder extracted from a task description. */
export interface TaskEntity {
    /** The entity type (e.g., "service", "environment", "error_code"). */
    type: string;
    /** The concrete value in this instance (e.g., "auth", "staging", "500"). */
    value: string;
    /** Position in the original task string (for traceability). */
    position: number;
}

/** A resolved task signature: intent + typed entities. */
export interface TaskSignature {
    /** The extracted intent verb (e.g., "deploy", "diagnose", "configure"). */
    intent: string;
    /** Typed entity placeholders — the variable parts. */
    entities: TaskEntity[];
    /** The canonical signature string: intent::type1::type2::... */
    signature: string;
    /** SHA-256 of the signature for compact comparison. */
    hash: string;
}

/** A task trajectory annotated with its signature. */
export interface SignedTrajectory {
    /** The original trajectory ID. */
    trajectoryId: string;
    /** The raw task text (first 500 chars). */
    task: string;
    /** The extracted signature. */
    signature: TaskSignature;
    /** Whether the trajectory succeeded. */
    success: boolean;
    /** Duration in ms. */
    durationMs: number;
    /** Number of tool-calling rounds. */
    rounds: number;
    /** The tool sequence used. */
    toolSequence: string[];
}

// ── Intent extraction ──────────────────────────────────────────────

/**
 * Known intent verbs. Extraction is pattern-based (no LLM call) so it
 * runs cheaply on every trajectory. The verb is the first matching
 * keyword in the task text.
 */
const INTENT_PATTERNS: Array<{ regex: RegExp; intent: string }> = [
    { regex: /\b(deploy|release|ship|push)\b/i, intent: 'deploy' },
    { regex: /\b(diagnose|debug|troubleshoot|investigate|why|what'?s wrong)\b/i, intent: 'diagnose' },
    { regex: /\b(fix|repair|resolve|patch|correct)\b/i, intent: 'fix' },
    { regex: /\b(configure|setup|set up|install|initialize)\b/i, intent: 'configure' },
    { regex: /\b(monitor|watch|track|observe)\b/i, intent: 'monitor' },
    { regex: /\b(analyze|review|audit|inspect|examine)\b/i, intent: 'analyze' },
    { regex: /\b(build|compile|assemble)\b/i, intent: 'build' },
    { regex: /\b(test|verify|validate|check)\b/i, intent: 'test' },
    { regex: /\b(create|generate|write|produce|scaffold)\b/i, intent: 'create' },
    { regex: /\b(update|modify|change|edit|refactor)\b/i, intent: 'update' },
    { regex: /\b(search|find|locate|look up|query)\b/i, intent: 'search' },
    { regex: /\b(summarize|explain|describe|document)\b/i, intent: 'summarize' },
    { regex: /\b(optimize|improve|enhance|speed up)\b/i, intent: 'optimize' },
    { regex: /\b(migrate|move|transfer|copy)\b/i, intent: 'migrate' },
    { regex: /\b(rollback|revert|undo|restore)\b/i, intent: 'rollback' },
];

/**
 * Entity type patterns. Each extracts a typed placeholder from the task
 * text. The type is the category; the value is the concrete instance.
 */
const ENTITY_PATTERNS: Array<{ regex: RegExp; type: string; extractGroup: number }> = [
    // Service/component names: "auth service", "payment API", "the database"
    { regex: /\b(\w+(?:\s+\w+)?)\s+(?:service|api|endpoint|module|component|microservice)\b/i, type: 'service', extractGroup: 1 },
    // Environment: "staging", "production", "dev", "prod"
    { regex: /\b(to|in|on)\s+(staging|production|prod|dev|development|test|qa|canary)\b/i, type: 'environment', extractGroup: 2 },
    // Error codes: "500", "404", "ECONNREFUSED", "timeout"
    { regex: /\b(5\d\d|4\d\d|3\d\d)\b/, type: 'error_code', extractGroup: 1 },
    { regex: /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EACCES|EPERM)\b/i, type: 'error_code', extractGroup: 1 },
    { regex: /\b(timeout|crash|OOM|out of memory|segfault|null pointer|race condition|deadlock)\b/i, type: 'error_type', extractGroup: 1 },
    // File/path references: "config.yaml", "src/main.ts", "/etc/nginx"
    { regex: /\b([\w./-]+\.(?:yaml|yml|json|ts|js|py|rs|go|toml|conf|cfg|env))\b/i, type: 'file', extractGroup: 1 },
    // Version references: "v2.1.0", "1.0.0-beta"
    { regex: /\b(v?\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)\b/i, type: 'version', extractGroup: 1 },
    // Branch references: "main", "feature/xyz"
    { regex: /\b(branch|PR|pull request)\s+(\S+)\b/i, type: 'branch', extractGroup: 2 },
    // Database/table references
    { regex: /\b(table|collection|index)\s+(\w+)\b/i, type: 'db_object', extractGroup: 2 },
];

// ── Extraction ──────────────────────────────────────────────────────

/**
 * Extract a task signature from a raw task string.
 * Pure function — no side effects, no I/O.
 */
export function extractTaskSignature(task: string): TaskSignature {
    const lower = task.toLowerCase();
    
    // Find the intent whose keyword match starts earliest in the task text
    // (per the documented contract above: "the verb is the first matching
    // keyword in the task text"). This is NOT the first pattern in
    // INTENT_PATTERNS that matches anywhere — a pattern earlier in the
    // array can match later in the text than a pattern further down the
    // array. Ties (identical match position) keep INTENT_PATTERNS order,
    // since we only replace the best match on a STRICTLY earlier position.
    let intent = 'unknown';
    let bestPosition = Infinity;
    for (const pattern of INTENT_PATTERNS) {
        const match = pattern.regex.exec(lower);
        if (match && match.index < bestPosition) {
            bestPosition = match.index;
            intent = pattern.intent;
        }
    }
    
    // Extract typed entities
    const entities: TaskEntity[] = [];
    const seenPositions = new Set<number>();
    
    for (const pattern of ENTITY_PATTERNS) {
        // Ensure the regex has the global flag so exec() advances
        const flags = pattern.regex.flags.includes("g") ? pattern.regex.flags : pattern.regex.flags + "g";
        const re = new RegExp(pattern.regex.source, flags);
        let match: RegExpExecArray | null;
        while ((match = re.exec(task)) !== null) {
            const pos = match.index;
            if (seenPositions.has(pos)) continue; // don't double-count
            seenPositions.add(pos);
            entities.push({
                type: pattern.type,
                value: match[pattern.extractGroup] || match[0],
                position: pos,
            });
        }
    }
    
    // Sort entities by position for deterministic ordering
    entities.sort((a, b) => a.position - b.position);
    
    // Build the canonical signature string
    const entityTypes = entities.map(e => e.type);
    const signature = `${intent}::${entityTypes.join('::')}`;
    const hash = createHash('sha256').update(signature).digest('hex').slice(0, 16);
    
    return { intent, entities, signature, hash };
}

/**
 * Annotate a batch of trajectories with their task signatures.
 * All trajectories (success and failure) are annotated so that
 * scoreCluster can compute success rate over the full population.
 */
export function signTrajectories(
    trajectories: Array<{
        id: string;
        task: string;
        success: boolean;
        durationMs: number;
        rounds: number;
        toolSequence: string[];
    }>,
): SignedTrajectory[] {
    return trajectories
        .map(t => ({
            trajectoryId: t.id,
            task: t.task,
            signature: extractTaskSignature(t.task),
            success: t.success,
            durationMs: t.durationMs,
            rounds: t.rounds,
            toolSequence: t.toolSequence,
        }));
}

/**
 * Compute the stability of a set of trajectories: the fraction that
 * share the same tool sequence. High stability = the same workflow
 * reliably solves this task pattern.
 */
export function computeStability(signed: SignedTrajectory[]): number {
    if (signed.length <= 1) return 1.0;
    const seqCounts = new Map<string, number>();
    for (const t of signed) {
        const seq = t.toolSequence.join(' → ');
        seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1);
    }
    const maxCount = Math.max(...seqCounts.values());
    return maxCount / signed.length;
}
