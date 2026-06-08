/**
 * TITAN — System-prompt section caps.
 *
 * The Persona injection cap (`src/personas/manager.ts`) already proves that
 * section-aware truncation works without breaking semantics — TITAN_PERSONA_CAP
 * has been live since v5.0. This module extends the same idea to every dynamic
 * section in `buildSystemPrompt`, so when memory/hindsight/wisdom/skill hints
 * bloat over time the prompt doesn't silently grow to 30 KB.
 *
 * Each cap is overridable via env (TITAN_CAP_<SECTION>) for power users; the
 * defaults are conservative and grounded in the audit in docs/HARNESS-PATTERNS.md.
 *
 * Reference:
 *   - Anthropic — "Effective context engineering for AI agents" (context-as-bottleneck)
 *   - 12 Factor Agents §3 "Own your context window"
 *   - awesome-agent-harness top-10 pattern #3 "Context Compaction & Working-State Management"
 *   - Hermes Agent's per-block size budget (procedural-memory layer)
 *
 * Caps are applied at *injection time* — the source data (memory store,
 * hindsight, wisdom) is never truncated. Only what reaches the LLM is bounded.
 */

/** Default cap (bytes) per section. 0 = no cap. */
export const SECTION_CAP_DEFAULTS: Readonly<Record<string, number>> = Object.freeze({
    // Identity-y things — should be small by construction; cap defensively.
    identityBlocks:    2048,
    dateTimeBlock:     512,

    // Continuous-learning hints — the historical 5-in-1 grab-bag that
    // tends to grow because each sub-hint accumulates over a session.
    learningBlock:     3072,

    // Frustration / teaching / custom — short by construction.
    frustrationBlock:  512,
    teachingBlock:     1024,
    customBlock:       4096,

    // Workspace context — combines TITAN.md / AGENTS.md / SOUL.md / persona /
    // TOOLS.md. Persona already has its own cap; this one bounds the union.
    // Big users put project rules here, so cap is generous.
    workspaceContext:  8192,

    // Memory-related — these grow as the user accumulates knowledge.
    memoryContext:     2048,
    personalContext:   1024,
    graphSection:      4096,
    memoryToolsBlock:  768,

    // Self-awareness + optimized-prompt blocks — should stay small.
    selfAwareness:     2048,
    optimizedBlock:    1024,

    // Prompt-includes — user-controlled; reasonable upper bound.
    systemIncludes:    4096,
    transientIncludes: 2048,

    // v6.0 step 5 — Active Space intent. Lands at the recency position
    // (U-shaped attention) so the model uses it. Generous cap so users
    // can write a few paragraphs of Space-specific instructions.
    activeSpace:       4096,

    // v6.0 step 14 — Per-user Soma profile (long-term baseline + recent
    // observations). Grows slowly over weeks of use. 4 KB lets the model
    // see ~50 short observations.
    somaProfile:       4096,

    // v6.0 "Living Canvas" voice — TITAN's character block. Lands FIRST in
    // the dynamic sections so the LLM primes on it. Generous cap so the
    // posture rules + drive-interpretation rules both fit.
    livingCanvasVoice: 4096,

    // v6.0 Command Post upgrade #1 — Per-agent lessons (Reflexion).
    // Top-N lessons the agent has learned. Cap at 3 KB — twelve concise
    // entries fit comfortably; older lessons roll off via the lessons.md
    // file-level cap (200) so this prompt section never exceeds the cap.
    agentLessons:    3072,

    // v6.0 Command Post upgrade #2 — Living goal plan (Manus recitation).
    // The current plan.md rendered for the goal this session is tied to.
    // 4 KB matches the renderer's PROMPT_RENDER_CAP — scratchpad gets
    // trimmed first if the steps list alone is big.
    goalPlan:        4096,

    // v7.0 — Living goal SPEC (spec-driven / context engineering). The
    // definition-of-done (problem + requirements + checkable acceptance
    // criteria) for the goal this session is tied to. Lands just before
    // goalPlan so the agent sees "are we done?" before "what's next?".
    // 4 KB matches the renderer's PROMPT_RENDER_CAP.
    goalSpec:        4096,

    // v6.0.5 — User-authored / agent-authored SKILL.md library. The
    // renderer caps itself at SKILL_PROMPT_CAP (6 KB) and skips body
    // injection past that, so this cap mostly matters as a defence-in-
    // depth fallback if the catalog of lazy skills grows huge.
    userSkills:      8192,
});

/** Resolve a section's cap from env override or default. Returns 0 if disabled. */
export function getSectionCap(name: string): number {
    const envKey = 'TITAN_CAP_' + name.toUpperCase();
    const raw = process.env[envKey];
    if (raw !== undefined) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    return SECTION_CAP_DEFAULTS[name] ?? 0;
}

/**
 * Truncate a section to the cap, preferring a markdown header in the final
 * quarter for a clean cut (same heuristic as persona truncation). Appends a
 * truncated-marker so the model can SEE that content was clipped — important
 * to prevent "I didn't see Y in your instructions" confusion.
 *
 * Returns the input unchanged when:
 *   - cap is 0 (disabled)
 *   - content is already within the cap
 *   - content is empty / whitespace
 */
export function capSection(name: string, content: string): string {
    if (!content || !content.trim()) return content;
    const cap = getSectionCap(name);
    if (cap === 0 || content.length <= cap) return content;

    const slice = content.slice(0, cap);
    const lookback = Math.floor(cap * 0.75);
    const tail = slice.slice(lookback);
    const headerMatch = tail.match(/\n(#{1,6} [^\n]+)\n[\s\S]*$/);
    let cut: string;
    if (headerMatch && headerMatch.index !== undefined) {
        cut = slice.slice(0, lookback + headerMatch.index);
    } else {
        const lastBreak = slice.lastIndexOf('\n\n');
        cut = lastBreak > cap * 0.5 ? slice.slice(0, lastBreak) : slice;
    }
    return cut.trimEnd() + `\n\n[${name} truncated at ${cap} bytes — full ${content.length} bytes still in source]`;
}

/**
 * Apply caps to a list of named sections. Returns the same shape, with each
 * over-budget section trimmed via {@link capSection}. Pure function — does
 * not log or mutate input.
 */
export function applyCaps<T extends { name: string; content: string }>(sections: T[]): T[] {
    return sections.map((s) => ({ ...s, content: capSection(s.name, s.content) }));
}

/**
 * Compute the total size of a section list. Useful for the prompt-size
 * regression test in `tests/unit/system-prompt-size.test.ts`.
 */
export function totalSize(sections: Array<{ content: string }>): number {
    return sections.reduce((n, s) => n + (s.content?.length || 0), 0);
}
