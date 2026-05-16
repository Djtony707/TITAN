/**
 * TITAN — Tool Contract (v6.1.0-beta.15, Phase D.3)
 *
 * Declarative input/output schemas + risk metadata for skills. Every
 * skill that opts in attaches a `ToolContract` to its `ToolHandler`;
 * the agent loop validates incoming tool calls against the contract
 * BEFORE the skill's execute() runs.
 *
 * WHY this module exists:
 *
 *   - The current ToolHandler.parameters is a raw JSON-schema blob
 *     and ToolHandler.execute accepts `Record<string, unknown>`. The
 *     LLM can pass anything; skills get to discover the bad shape at
 *     runtime, usually by crashing or returning a confusing string.
 *
 *   - The Picrew/awesome-agent-harness catalog identifies declarative
 *     tool contracts as a recurring pattern across reliable harnesses
 *     (PydanticAI, deepagents, Google ADK, NeMo Agent Toolkit). The
 *     shape is consistent: Zod or Pydantic schema in / Zod schema out
 *     / risk + side-effects metadata for governance.
 *
 *   - Contracts also feed the auto-mode classifier (Phase D.4):
 *     riskLevel === 'safe' tool calls can run without an approval
 *     prompt; 'high' calls require explicit user confirmation.
 *
 * DESIGN:
 *
 *   - Contracts are STRICTLY ADDITIVE. ToolHandler.contract is
 *     optional, so the 89 existing skill files don't break. The
 *     contract opt-in proceeds skill-by-skill.
 *
 *   - Input validation uses Zod. Skills declare a Zod schema; the
 *     tool runner calls schema.safeParse() at dispatch and rejects
 *     malformed args with a structured error message the LLM can
 *     fix on the next round.
 *
 *   - Output schemas are OPTIONAL. They power the auto-mode
 *     verifier (D.4) and let consumers type-narrow execute results.
 *     For skills whose output is a free-form string (most of ours),
 *     skip it.
 *
 *   - sideEffects + riskLevel are governance metadata. They never
 *     change behavior at this layer — D.4 wires them into approval
 *     gating, D.5 wires them into worktree isolation.
 *
 * TRADE-OFFS:
 *
 *   - Skills authored against the old parameters: JSON-schema shape
 *     can keep using it. Contracts are an opt-in upgrade. We don't
 *     force-migrate the long tail (89 skill files) — only the 5-10
 *     canonical skills get contracts in this beta.
 *
 *   - Zod adds ~30 KB to the runtime bundle (already a dep). No new
 *     dependencies introduced.
 *
 *   - Validation runs synchronously on dispatch. Schemas should stay
 *     simple — heavy refinements (network IO, fs reads) would slow
 *     every tool call.
 *
 * FOLLOW-UP:
 *
 *   - Phase D.4 reads `riskLevel` to decide whether to auto-approve
 *     or prompt the user.
 *   - Phase D.5 reads `sideEffects: 'destructive'` to decide which
 *     skills must run inside an isolated worktree.
 *   - A future `titan tools doctor` CLI command lints every
 *     registered tool: which have contracts, which are still on the
 *     raw JSON-schema shape, which are missing examples.
 */

import { z, type ZodTypeAny, type ZodError } from 'zod';

/* ───────────────────────────  Types  ─────────────────────────── */

/**
 * What the tool DOES to the world. The runtime uses this to decide
 * whether the call needs an approval gate, an isolated worktree,
 * or just runs free.
 *
 *   - read         — pure observation (read_file, list_dir, web_fetch).
 *   - write        — mutates state the user can recover from (write_file
 *                    to a non-system path, append_file, edit_file).
 *   - network      — outbound network call (web_search, download_image,
 *                    web_fetch). Often pairs with `read`.
 *   - destructive  — unrecoverable or sensitive: shell, delete_file,
 *                    git operations, anything touching ~/.ssh, /etc, etc.
 */
export type SideEffect = 'read' | 'write' | 'network' | 'destructive';

/**
 * Risk classification for the auto-mode classifier (Phase D.4).
 *
 *   - safe      — auto-run without prompting. Read-only tools + writes
 *                 inside the workspace.
 *   - moderate  — auto-run with a brief notification. Network calls,
 *                 writes outside the workspace.
 *   - high      — require explicit user approval every call. Shell,
 *                 destructive ops, anything touching credentials.
 */
export type RiskLevel = 'safe' | 'moderate' | 'high';

/**
 * The declarative contract a skill exports alongside its handler.
 * Both schemas are Zod — TITAN already uses Zod for config so this
 * adds no new dependency.
 */
export interface ToolContract<TInput = unknown, TOutput = unknown> {
    /** Tool name — must match the ToolHandler.name it's attached to. */
    name: string;
    /** One-sentence summary used by the auto-mode classifier + docs. */
    summary: string;
    /** Zod schema for the call arguments. Validated on dispatch. */
    input: z.ZodType<TInput>;
    /**
     * Optional Zod schema for the execute return value. When set, the
     * runtime can validate the skill kept its end of the bargain.
     * Skills returning free-form strings (most of ours) can omit this.
     */
    output?: z.ZodType<TOutput>;
    /** What the tool does to the world — drives governance gates. */
    sideEffects: SideEffect[];
    /** Risk level the auto-mode classifier reads (Phase D.4). */
    riskLevel: RiskLevel;
    /**
     * Concrete example calls. Used by:
     *   - Skill-author tests as fixture inputs
     *   - Auto-mode classifier as positive samples for "looks safe"
     *   - Docs / tool-author guide as ready-to-paste snippets
     *
     * Each example MUST validate against `input` — the test suite
     * for this module enforces that.
     */
    exampleCalls: Array<{
        description: string;
        args: TInput;
    }>;
}

/* ───────────────────────────  Validation  ─────────────────────────── */

/**
 * Structured validation error thrown by `validateToolCall` when the
 * incoming args don't match the contract's input schema. Distinct
 * class so the tool runner can catch it precisely + format a
 * helpful message for the LLM without confusing it with native
 * execute() errors.
 */
export class ToolValidationError extends Error {
    readonly toolName: string;
    readonly issues: ZodError['issues'];
    constructor(toolName: string, issues: ZodError['issues']) {
        const summary = issues
            .slice(0, 3)
            .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
        super(`Tool "${toolName}" rejected invalid arguments: ${summary}`);
        this.name = 'ToolValidationError';
        this.toolName = toolName;
        this.issues = issues;
    }
}

/**
 * Validate raw tool-call arguments against the contract. Returns the
 * parsed (and possibly coerced) args on success; throws
 * `ToolValidationError` on failure.
 *
 * Wrap in try/catch in the tool runner — DO NOT let validation
 * errors bubble all the way to the user. Instead, return a clear
 * "your args were wrong, here's why" string so the LLM corrects on
 * the next round.
 */
export function validateToolCall<TInput>(
    contract: ToolContract<TInput, unknown>,
    rawArgs: unknown,
): TInput {
    const result = contract.input.safeParse(rawArgs);
    if (!result.success) {
        throw new ToolValidationError(contract.name, result.error.issues);
    }
    return result.data;
}

/**
 * Format a validation error as a clear human-readable message the
 * tool runner can return to the LLM. The LLM reads this on the next
 * round and (usually) corrects its args.
 */
export function formatValidationError(err: ToolValidationError): string {
    const issues = err.issues
        .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
    return `Tool "${err.toolName}" rejected the call because the arguments don't match its schema:\n${issues}\n\nFix the arguments and try the call again.`;
}

/* ───────────────────────────  Registry  ─────────────────────────── */

/**
 * Optional global registry of contracts keyed by tool name. Skills
 * register their contract here at module-load time so other modules
 * (auto-mode classifier, docs generator, "titan tools doctor") can
 * iterate without depending on the full skill registry.
 *
 * Decoupled from `toolRegistry` in toolRunner.ts so a skill can opt
 * into a contract independently of how its handler is registered.
 */
const contractRegistry: Map<string, ToolContract> = new Map();

export function registerToolContract<T, U>(contract: ToolContract<T, U>): void {
    contractRegistry.set(contract.name, contract as unknown as ToolContract);
}

export function getToolContract(name: string): ToolContract | undefined {
    return contractRegistry.get(name);
}

export function listToolContracts(): ToolContract[] {
    return Array.from(contractRegistry.values());
}

/** For tests. */
export function clearToolContracts(): void {
    contractRegistry.clear();
}
