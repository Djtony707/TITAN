# TITAN v8 Prototype — The Self-Compiling Agent

Demonstrates the core loop of the v8 architecture: a task is recorded as
a trace, compiled into a Tier-2 executable recipe, and replayed by the
router without invoking a frontier model. This fixture observes the
loop's mechanics — it does not measure a real baseline or prove savings.

## What's here

```
COMPARE/prototype/
├── README.md            ← this file
├── traceStore.ts        ← Stage 1 (RECORD): persist traces + join receipts
├── recipeCompiler.ts    ← Stage 3 (COMPILE): trace → Tier-2 recipe with typed slots
├── router.ts            ← Stage 5 (ROUTE): exact match → zero-frontier-call replay
├── mint.ts              ← v7's action_id minter (unchanged, re-exported)
├── demo.ts              ← TypeScript demo (the ideal runnable form)
├── demo.sh              ← Bash port — RUNS NOW, no node needed
├── demo.pl              ← Perl port (needs JSON::PP)
├── test-router.test.ts  ← canonical router safety test (imports route() from router.ts; needs tsx)
└── test-high-stakes.sh  ← runnable source-adapter: validates router.ts invariant (no TS runtime needed)
```

## How to run

```bash
bash demo.sh
```

The demo creates its own fixture file in a temporary directory — no
host-specific paths required. Output shows the full loop end-to-end:

1. A trace is persisted to a temp directory's `traces/traces.jsonl`
2. Trace compiled into a Tier-2 recipe (1 step, 1 slot: `path`)
3. Recipe passes shadow gate → promoted to `active`
4. 100th invocation: router hits exact match → replays `read_file` with zero frontier calls in this fixture
5. Compiler status: observed facts from this run (trace count, replay result, frontier-call count)

## Real v7 seams used (verified paths, not vibes)

| Prototype module | v7 source file | What it uses |
|---|---|---|
| `traceStore.ts` | `src/agent/tracer.ts` | Trace/TraceHandle types, startTrace pattern |
| `traceStore.ts` | `src/receipts/store.ts` | appendFileSync jsonl pattern, rotation, TITAN_HOME |
| `traceStore.ts` | `src/receipts/mint.ts` | mintActionId (unchanged, re-exported) |
| `recipeCompiler.ts` | `src/recipes/types.ts` | Recipe/RecipeStep shape (compileRecipe output) |
| `recipeCompiler.ts` | `src/agent/toolIntent.ts` | TOOL_KINDS: destructive/risky/sync classification |
| `router.ts` | `src/agent/agentLoop.ts:972` | responseCache check (precedent for zero-frontier-call short-circuit) |
| `router.ts` | `src/organism/shadow.ts` | ShadowVerdict pattern (candidate → shadow → active) |
| `demo.ts` | `src/skills/builtin/filesystem.ts` | read_file tool (execute path) |

## What this demonstrates

- The 5-stage loop (Record → Recognize → Compile → Gate → Route) is
  exercised on v7's existing seams in this fixture. No new infrastructure
  categories were required for the fixture; the full production integration
  would require wiring the existing observer patterns into the live
  agentLoop, which is beyond this prototype's scope.
- The router's zero-frontier-call replay path is observed in this fixture:
  exact signature match + slot resolution → tool execution with no LLM
  call. This demonstrates the replay mechanic on a single fixture, not a
  measured production baseline.
- Stakes-based routing floor is enforced inside route(): destructive
  tools (shell, exec) always return a confirm decision, never replay —
  even with perfect slot fill. Two tests cover this: `test-router.test.ts`
  is the canonical behavioral test that imports `route()` from `router.ts`
  and asserts `kind === 'confirm'` (run with `npx tsx test-router.test.ts`
  when a TS runtime is available); `test-high-stakes.sh` is a runnable
  source-adapter that validates the same invariant against the actual
  `router.ts` source text in environments without a TS runtime.
- The compile step produces a recipe from a single trace with a FIXED vs
  VARIABLE arg classification heuristic that runs in this fixture. The
  heuristic is conservative and unvalidated on a real trace library; the
  real Recognizer would learn classification from a cluster of traces.

## What's deliberately out of scope (v8.1)

- The Recognizer nightly job (clustering traces by signature) — needs a
  trace library to have signal.
- Tier-3 LoRA fine-tune — the train_prepare/start/deploy pipeline exists in
  v7 (`src/skills/builtin/model_trainer.ts`) but feeding it requires the
  trace library to mature first.
- The local slot-filling call — the prototype marks slots as
  `{{paramName}}` and the caller supplies values; the integration is
  one `chat()` call in the real build.
- Shadow mode N-run comparison — the prototype simulates promotion; the
  real gate uses `src/organism/shadow.ts` + `scripts/eval-gate.sh`.
