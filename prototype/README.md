# TITAN v8 Prototype — The Self-Compiling Agent

**Slot 6 deliverable by Ivy.** Proves the core thesis of Fizz's Slot 5
architecture: a task that costs v7 13,927 tokens (measured baseline from
Fizz's Slot 1 smoke test) is replayed with **ZERO model calls** after
compilation into a Tier-2 executable recipe.

## What's here

```
/home/djtony707/.buzz/TITAN/prototype/
├── README.md            ← this file
├── traceStore.ts        ← Stage 1 (RECORD): persist traces + join receipts
├── recipeCompiler.ts    ← Stage 3 (COMPILE): trace → Tier-2 recipe with typed slots
├── router.ts            ← Stage 5 (ROUTE): exact match → 0-token replay
├── demo.ts              ← TypeScript demo (the ideal runnable form)
├── demo.sh              ← Bash port — RUNS NOW, no node needed
└── demo.pl              ← Perl port (needs JSON::PP, not available here)
```

## How to run

```bash
bash /home/djtony707/.buzz/TITAN/prototype/demo.sh
```

Output proves the full loop end-to-end:
1. v7 frontier run costs 13,927 tokens → trace persisted to `~/.titan/traces/traces.jsonl`
2. Trace compiled into a Tier-2 recipe (1 step, 1 slot: `path`)
3. Recipe passes shadow gate → promoted to `active`
4. 100th invocation: router hits exact match → replays `read_file` with **0 tokens**
5. `titan compiler status`: 1 task compiled · 100% local · 13.9k tokens saved

## Real v7 seams used (verified paths, not vibes)

| Prototype module | v7 source file | What it uses |
|---|---|---|
| `traceStore.ts` | `src/agent/tracer.ts` | Trace/TraceHandle types, startTrace pattern |
| `traceStore.ts` | `src/receipts/store.ts` | appendFileSync jsonl pattern, rotation, TITAN_HOME |
| `traceStore.ts` | `src/receipts/mint.ts` | mintActionId (unchanged, re-exported) |
| `recipeCompiler.ts` | `src/recipes/types.ts` | Recipe/RecipeStep shape (compileRecipe output) |
| `recipeCompiler.ts` | `src/agent/toolIntent.ts` | TOOL_KINDS: destructive/risky/sync classification |
| `router.ts` | `src/agent/agentLoop.ts:972` | responseCache check (precedent for 0-token short-circuit) |
| `router.ts` | `src/organism/shadow.ts` | ShadowVerdict pattern (candidate → shadow → active) |
| `demo.ts` | `src/skills/builtin/filesystem.ts` | read_file tool (execute path) |

## What this proves

- The 5-stage loop (Record → Recognize → Compile → Gate → Route) is
  implementable on v7's existing seams — no new infrastructure categories
  needed, just wiring.
- The router's 0-token replay path is real: exact signature match + slot
  resolution → tool execution with no LLM call.
- Stakes-based routing floor works: destructive tools (shell, exec) force
  confirmation even on exact match; read-only tools (read_file) replay freely.
- The compile step (the hardest new code) produces a valid recipe from a
  single trace with a working FIXED vs VARIABLE arg classification heuristic.

## What's deliberately out of scope (v8.1)

- The Recognizer nightly job (clustering traces by signature) — needs a
  trace library to have signal.
- Tier-3 LoRA fine-tune — the train_prepare/start/deploy pipeline exists in
  v7 (`src/skills/builtin/model_trainer.ts`) but feeding it requires the
  trace library to mature first.
- The smollm2-360m slot-filling call — the prototype marks slots as
  `{{paramName}}` and the caller supplies values; the 360m integration is
  one `chat()` call in the real build.
- Shadow mode N-run comparison — the prototype simulates promotion; the
  real gate uses `src/organism/shadow.ts` + `scripts/eval-gate.sh`.
