# TITAN Ultraplan: Pipeline Excellence
## Goal: Make TITAN's agent pipelines as good or better than OpenClaw, Hermes AI, and Claude Code

**Date**: April 7, 2026
**Status**: Active Development
**Owner**: Tony Elliott

---

## Competitive Analysis (Key Patterns)

### OpenClaw (346K stars)
- **Config-first** — SOUL.md/STYLE.md/SKILL.md reload on every wake (identity never drifts)
- **Flat sub-agents** — `sessions_spawn` creates isolated sessions, posts results back. No recursion, deliberate simplicity
- **MCP-native** — all tool interfaces standardized through MCP
- **Weakness**: Local model reliability is a known weak spot. No fallback or retry-with-simplification

### Hermes AI (Nous Research)
- **Core strength**: `execute_code` collapses multi-step tool pipelines into single inference calls
- **Trajectory compression** — past tool call/response pairs compressed into summaries, preserving context window
- **Tool call recovery** — when structured output fails, falls back to regex extraction from text
- **Multi-model orchestration** — different models for planning vs execution vs verification

### Claude Code
- **Agent tool** — spawns autonomous sub-agents with full context isolation (worktrees, separate sessions)
- **Plan mode** — explicit planning phase with user approval before execution
- **Tool result storage** — persists tool results to disk, clears from context window to save tokens
- **Smart context management** — automatic compression, head+tail truncation, summary injection

---

## Current TITAN Gaps (Ranked by Impact)

### P0 — Critical (Blocks basic agent tasks)

| # | Gap | Impact | Status |
|---|-----|--------|--------|
| 1 | **Large content tool calls fail** | Models can't wrap 12KB+ in JSON args | ✅ Fixed (ContentCapture) |
| 2 | **Fabrication goes uncaught** | Model says "I wrote it" without calling tools | ✅ Fixed (FabricationGuard) |
| 3 | **ToolRescue skips critical tools** | write_file/shell/read_file excluded for local models | ✅ Fixed |
| 4 | **HallucinationGuard cloud-only** | Local model fabrications pass through | ✅ Fixed |
| 5 | **Schemas too complex for local models** | Full Zod schemas confuse tool calling | ✅ Fixed (simplifySchema for all) |

### P1 — High (Limits complex task handling)

| # | Gap | Impact | Fix |
|---|-----|--------|-----|
| 6 | **No trajectory compression** | Context fills up with raw tool results, model loses focus | Implement Hermes-style result summarization |
| 7 | **No tool result persistence** | All results live in context window, eating tokens | Persist to disk, inject summaries like Claude Code |
| 8 | **Sub-agent depth limit too low** | Max depth 2 prevents multi-level decomposition | Raise to 3-4 with context isolation |
| 9 | **No model routing per phase** | Same model for planning + coding + verification | Use fast model for planning, capable model for coding |
| 10 | **Deliberation blocks on approval** | API callers wait for approval that never comes | ✅ Fixed (auto-execute for API) |

### P2 — Medium (Quality of life)

| # | Gap | Impact | Fix |
|---|-----|--------|-----|
| 11 | **No SOUL.md equivalent** | Agent identity defined in code, not user-configurable | Already have TITAN.md — enhance it |
| 12 | **Silence stalls kill long tasks** | 120s timeout kills gemma4 mid-generation | Dynamic timeout based on model speed |
| 13 | **No incremental write pattern** | Model must produce entire file in one shot | ✅ Fixed (append_file + chunked write hints) |
| 14 | **No tool result caching** | Same read_file called repeatedly wastes tokens | Cache recent read results |
| 15 | **No verification step** | Task "done" without checking output | Add auto-verify phase after writes |

---

## Implementation Phases

### Phase 1: Trajectory Compression (P1 #6, #7) — HIGH IMPACT
**Why**: This is how Hermes stays coherent over 20+ tool rounds. Without it, gemma4 loses context and fabricates.

**What to build**:
1. After each tool result, if result > 500 chars, compress it:
   - Keep first 200 chars (usually has the key answer)
   - Keep last 100 chars (status/summary)
   - Replace middle with `[... N chars truncated ...]`
2. After 5+ tool rounds, inject a running summary:
   - "Progress so far: (1) Read file X (500 lines), (2) Wrote section A, (3) Appended section B"
3. Persist full tool results to `~/.titan/tool-results/{sessionId}/` for debugging
4. Only keep compressed versions in the message context

**Files**: `src/agent/agentLoop.ts` (after ACT phase), new `src/agent/trajectoryCompressor.ts`

**Effort**: 2-3 hours
**Impact**: Huge — enables 20+ round tasks without context exhaustion

### Phase 2: Dynamic Model Routing (P1 #9) — HIGH IMPACT
**Why**: Planning doesn't need a 31B model. Fast 8B model plans in 3s, 31B model executes in 15s. Total: 18s vs 30s.

**What to build**:
1. In deliberation `analyze()`: use `modelAliases.fast` (e.g., gemma3:8b)
2. In deliberation `generatePlan()`: use `modelAliases.fast`
3. In `executePlan()` steps: use `modelAliases.smart` (gemma4:31b)
4. For verification steps: use `modelAliases.fast`

**Files**: `src/agent/deliberation.ts`, `src/agent/orchestrator.ts`

**Effort**: 1-2 hours
**Impact**: 2-3x faster complex tasks, saves VRAM time

### Phase 3: Dynamic Silence Timeout (P2 #12) — MEDIUM IMPACT
**Why**: gemma4:31b takes 60-120s for large outputs. The 120s silence timeout kills it mid-generation.

**What to build**:
1. Track average inference time per model: `modelTimings[model] = { avg, p95, count }`
2. Set silence timeout to `max(120s, modelTimings[model].p95 * 1.5)`
3. During streaming, reset timeout on every token (already works)
4. For non-streaming, use model-specific timeout

**Files**: `src/agent/stallDetector.ts`, `src/providers/ollama.ts`

**Effort**: 1 hour
**Impact**: Eliminates false silence stalls for slow models

### Phase 4: Auto-Verify Phase (P2 #15) — MEDIUM IMPACT
**Why**: TITAN writes a file and says "done" without checking it. Claude Code runs the build after every change.

**What to build**:
1. After write_file/append_file completes, auto-queue verification:
   - For HTML: `read_file` and check it's valid (has `</html>`)
   - For code: `shell("node -c file.js")` or `shell("python -c 'import ast; ast.parse(open(\"file.py\").read())')`
   - For any file: check file size is reasonable (not 0, not truncated)
2. If verification fails, inject a fix nudge and retry

**Files**: `src/agent/agentLoop.ts` (after tool execution), new `src/agent/autoVerify.ts`

**Effort**: 2 hours
**Impact**: Catches truncated/broken files before declaring success

### Phase 5: Improved Sub-Agent Architecture (P1 #8) — HIGH IMPACT
**Why**: OpenClaw's `sessions_spawn` and Claude Code's `Agent` tool both provide context isolation. TITAN's sub-agents share the parent context.

**What to build**:
1. Sub-agents get their own message history (already partially there)
2. Sub-agents can use `worktree` isolation for file operations
3. Results posted back to parent as compressed summaries
4. Increase max depth from 2 → 4
5. Each sub-agent gets only the tools relevant to its template

**Files**: `src/agent/subAgent.ts`, `src/agent/orchestrator.ts`

**Effort**: 3-4 hours
**Impact**: Enables true multi-agent workflows

### Phase 6: SOUL.md Identity System (P2 #11) — LOW IMPACT
**Why**: OpenClaw's biggest UX win — user drops a SOUL.md in the project and the agent adopts that personality/ruleset.

**What to build**:
- TITAN.md already exists and loads on startup
- Enhance: support `.titan/SOUL.md` for per-project identity
- Auto-reload on file change (watch mode)
- Support STYLE.md for output formatting rules

**Files**: `src/agent/agent.ts` (system prompt loading)

**Effort**: 1 hour
**Impact**: Nice UX, low engineering complexity

---

## Priority Order (What to Build Next)

1. **Trajectory Compression** — enables long multi-step tasks
2. **Dynamic Model Routing** — 2-3x speedup
3. **Dynamic Silence Timeout** — stop killing slow model inference
4. **Auto-Verify** — catch broken output
5. **Sub-Agent Architecture** — enable true multi-agent
6. **SOUL.md** — UX polish

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Simple write_file task | ✅ Works | ✅ Works |
| Medium HTML write (100 lines) | ✅ Works | ✅ Works |
| Large HTML write (250+ lines) | ⚠️ Partial (timeout) | ✅ Completes via chunked write |
| Multi-step task (read → plan → write → verify) | ⚠️ Deliberation triggers but slow | ✅ Completes in <3 min |
| 20+ tool round task | ❌ Context exhaustion | ✅ Trajectory compression keeps focus |
| Any model (8B, 31B, cloud) | ⚠️ 31B works, others untested | ✅ All work via model routing |

---

## What Makes This "Better Than"

- **vs OpenClaw**: TITAN has trajectory compression + ContentCapture + fabrication detection. OpenClaw has none of these — local model failures are a known gap.
- **vs Hermes**: TITAN adds multi-agent orchestration (Hermes is single-agent), deliberation planning, and MCP support.
- **vs Claude Code**: TITAN runs locally with ANY model. Claude Code requires Anthropic API. TITAN's ContentCapture lets local models produce large files naturally.

The unique TITAN advantage: **model-agnostic pipeline that works with any LLM** (local or cloud) through adaptive tool calling, content capture, and fabrication detection. No other framework has this.
