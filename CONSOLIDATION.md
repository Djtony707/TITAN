# TITAN v8 — Slice 5 Consolidation Plan

**Author:** Vera (architect) · 2026-08-09
**Status:** active — Forge to implement

## Ground Truth (MEASURED)

| Branch | HEAD | Commits beyond merge-base `d627ef5b` | Unique to branch |
|--------|------|--------------------------------------|------------------|
| `v8-slice5-compile-forge` | `d627ef5b` | 0 | **Nothing** — this IS the merge base |
| `v8-slice5-contract-ivy` | `5f15bbda` | 10 (8 on v8-dev, 2 unique) | Honey blockers 2+3 |
| `v8-slice5-pair-ivy` | `ed10058b` | 1 | Testable gates + real-module tests |
| `scout/v8-slice5-gate-tests` | `f09a6b77` | 2 | Gate test suite (604 lines) |

**v8-dev HEAD:** `06952c14` — already contains the slice 5 skeleton + slice 6 ROUTE (the first 8 contract-ivy commits).

## What Each Branch Contributes

### v8-slice5-compile-forge → NOTHING to merge
This branch IS the merge base (`d627ef5b`). It contributed the skeleton that's already on v8-dev. Zero unique commits.

### v8-slice5-contract-ivy → 2 unique commits to cherry-pick
1. `f6f788ca` — **Honey blockers 2+3:** shadowEpoch (reset on re-entry), structured ShadowComparisonRecord with comparator identity metadata, shouldCompile/shouldPromote gates in v8Gates.ts, atomic write-through persistence (tmp+rename)
2. `5f15bbda` — **Honey blocker 3 final form:** closed comparator registry (COMPARATOR_REGISTRY), no public comparator parameter, evidence hashes, duplicate comparisonId rejection, stale epoch rejection

**Verdict: KEEP both.** These are Honey-reviewed fixes. The closed comparator registry is the correct architecture — callers cannot inject `() => true`.

### v8-slice5-pair-ivy → 1 unique commit to cherry-pick
`ed10058b` — **Testable gates + real-module gate tests:**
- Config override parameters on every gate function (`configOverride?: TitanConfig`)
- Lazy `registryPath()` for test isolation (re-reads `TITAN_HOME` from env)
- Two test files: `v8-slice5-import-contract.test.ts` (flag-off import contract) and `v8-slice5-promotion-gate.test.ts` (promotion state machine with real module imports)

**Verdict: KEEP the testability pattern, but it must be applied ON TOP of contract-ivy's rewrite.** The pair-ivy diff is against the old skeleton (`d627ef5b`), not the contract-ivy rewrite. The config override pattern must be manually ported to the contract-ivy version of recipeRegistry.ts.

### scout/v8-slice5-gate-tests → gate test suite
`5fc62d87` + `f09a6b77` — Comprehensive gate test file (`tests/v8-slice5-gate.test.ts`, 604 lines) covering:
- Flag-off invariant (v7 modules don't import promotion)
- Promotion state machine (all transitions)
- Gate enforcement (flags off → throws)
- Auto-demote on equivalence failure
- Measured-only rule

**Verdict: KEEP the test file, adapt to the consolidated API.** Scout's tests are based on the old skeleton API. They need updating to match the contract-ivy API (structured ShadowComparisonRecord, config override pattern, etc.).

## Consolidation Strategy

### Step 1: Cherry-pick contract-ivy's 2 unique commits
```
git cherry-pick f6f788ca 5f15bbda
```
These apply cleanly — v8-dev has the same parent commits.

### Step 2: Port pair-ivy's testability pattern
Manually add `configOverride?: TitanConfig` parameters to the contract-ivy version of:
- `registerRecipe()`
- `promoteToShadow()`
- `recordShadowComparison()`
- `activate()`
- `recordInvocation()`

And add lazy `registryPath()` for test isolation.

### Step 3: Add test files
- `tests/v8-slice5-import-contract.test.ts` — from pair-ivy (flag-off import contract)
- `tests/v8-slice5-promotion-gate.test.ts` — from pair-ivy (promotion state machine)
- `tests/v8-slice5-gate.test.ts` — from scout, adapted to consolidated API

### Step 4: Verify
- Run the full test suite
- Confirm scout's gate tests pass against the consolidated code
- Confirm flag-off invariant holds

## What Survives From Each Branch

| Component | Source | Why |
|-----------|--------|-----|
| Promotion state machine core | contract-ivy | Already on v8-dev; Honey-reviewed |
| Closed comparator registry | contract-ivy | Honey blocker 3 — correct architecture |
| shadowEpoch + reset on re-entry | contract-ivy | Honey blocker 2 — prevents stale counter reactivation |
| Structured ShadowComparisonRecord | contract-ivy | Evidence trail with comparator identity |
| Atomic write-through (tmp+rename) | contract-ivy | Production-grade persistence |
| shouldCompile/shouldPromote gates | contract-ivy | Extracted gate functions, testable in isolation |
| Config override pattern | pair-ivy | Enables real-module tests without config files |
| Lazy registryPath() | pair-ivy | Enables per-test TITAN_HOME isolation |
| Import-contract test | pair-ivy | Proves flag-off = v7 byte-identical |
| Promotion gate tests | pair-ivy | Real module imports, no mocks |
| Scout gate test suite | scout | Comprehensive coverage, adapted to new API |

## What Does NOT Survive

| Component | Source | Why |
|-----------|--------|-----|
| Old skeleton recipeRegistry.ts | compile-forge | Superseded by contract-ivy rewrite |
| Old skeleton recipeCompiler.ts | compile-forge | Superseded by contract-ivy rewrite |
| Bare-boolean `recordShadowComparison(id, bool)` | pair-ivy (old API) | Superseded by structured evidence API |
| `transitions[]` array | compile-forge skeleton | Superseded by `lastTransition` only |
| `getSelfCompilingConfig()` from loadConfig | compile-forge skeleton | Superseded by v8Gates.ts + TitanConfig |
| `gateOn()` / `selfCompilingFlag()` without config param | compile-forge skeleton | Superseded by shouldCompile/shouldPromote |
