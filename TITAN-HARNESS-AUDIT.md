# TITAN Agent Harness Audit — 2026 Best Practices

**Date**: 2026-04-28  
**Auditor**: AI Code Assistant (Claude Sonnet 4.6)  
**Scope**: `src/agent/*`, `src/eval/*`, `src/safety/*`, `src/skills/*`  
**Standard**: 2026 Production Agent Harness Best Practices (Anthropic, OpenAI, LangChain, Furmanets, Crosley, arXiv 2603.29231)

---

## Executive Summary

TITAN has one of the most **feature-rich** agent harnesses in open source. It is also one of the most **complex**. The framework implements nearly every advanced concept from the 2026 agent literature — but several critical design decisions violate the consensus best practices that separate demo-grade agents from production-grade systems.

**Verdict**: TITAN is a **B+ harness with A+ ambition**. With targeted refactoring, it can become a reference implementation for the industry.

| Category | Grade | Note |
|---|---|---|
| Guardrails & Safety | A | Three-layer runtime guardrails, secret scanning, PII redaction, sandboxing |
| Observability | B+ | Good trajectory logging, missing distributed trace IDs and span latency |
| Context Management | B+ | Smart compaction, but tool catalog is too large for cache stability |
| Tool Design | D | 253 tools violates the "small stable action space" consensus |
| Loop Architecture | C+ | 2,463-line monolith; needs middleware decomposition |
| Evaluation | B | Behavioral evals exist, missing harness-level tests (resumption, compaction, delegation recovery) |
| Multi-Agent | B- | Architecture is correct, but heartbeat inbox is **stubbed and disabled** |
| Code Execution | A | Docker sandbox with HTTP bridge and denied-tool lists |
| Self-Improvement | C+ | Auto-skill generation works, but dynamic skill injection breaks cache |

---

## The 2026 Consensus: What a Proper Harness Looks Like

Based on current industry literature, a production agent harness in 2026 MUST have these properties:

### 1. The Harness Matters More Than the Loop
> "The model-tool loop is now commodity. Differentiation comes from context engineering, durable state, policy enforcement, externalized memory, and protocol design." — Modern Agent Harness Blueprint 2026

**What this means**: The LLM call itself is the easy part. The hard parts are:
- Retrieving the right context
- Enforcing policies deterministically
- Managing state across crashes/restarts
- Logging everything for debugging

### 2. Cache Stability First
> "Design around cache stability first. Stable prompt prefix, append-only history, fixed tool catalog per session." — Modern Agent Harness Blueprint 2026

**What this means**: 
- The system prompt should be as stable as possible across turns
- History should be append-only (never rewrite mid-session)
- Tool definitions should not change during a session
- This maximizes prompt cache hits and reduces cost/latency

### 3. Small, Stable Action Space
> "Keep the built-in action space small and stable. Start with a compact set of high-leverage primitives: file ops, search/read, code execution or shell, planning/tasks, subagent delegation." — Modern Agent Harness Blueprint 2026

**What this means**:
- 3–5 core tools, not 253
- Each tool is a primitive, not a feature
- New capabilities are added via subagents or skills, not new tools
- The model always sees the same tool catalog

### 4. Filesystem / Artifact Store as Working Memory
> "Treat the filesystem and artifact store as working memory. Large tool outputs, notes, plans, recovered state, and handoffs should live outside the model context and be referenced by handles." — Modern Agent Harness Blueprint 2026

**What this means**:
- Don't return 5,000 lines of JSON to the model
- Write large outputs to files, return `artifact://path` handles
- The model reads handles when it needs detail

### 5. Guardrails in the Runtime, Not the Prompt
> "Put guardrails in the runtime, not the prompt. The model should never be the only enforcement layer." — Modern Agent Harness Blueprint 2026

**What this means**:
- Policy checks happen in code, not in system prompt instructions
- Destructive tools require deterministic approval gates
- Sandboxing is mandatory for shell/code execution
- Every action is logged to an audit trail

### 6. Evaluate the Harness, Not Just the Model
> "Skipping evaluation of the harness itself. Tool tests are not enough; evaluate resumption, compaction, approvals, and delegation." — Modern Agent Harness Blueprint 2026

**What this means**:
- Test what happens when the agent crashes and restarts
- Test context compaction doesn't lose critical state
- Test approval gates block dangerous actions 100% of the time
- Test subagent delegation and result draining

### 7. Quality Loop
> "Implement → Review → Evaluate → Refine → Zoom Out → Repeat → Report" — Blake Crosley, Agent Architecture 2026

**What this means**:
- Every non-trivial change goes through a structured review cycle
- The harness enforces this, not the human

---

## TITAN Deep Dive

### ✅ What's Done Well

#### 1. Runtime Guardrails (`src/agent/guardrails.ts` — 256 lines)
TITAN implements a **three-layer guardrail system** exactly as recommended:
- **Input Guard**: Validates user messages before processing
- **Tool Guard**: Validates tool calls before execution
- **Output Guard**: Validates responses before delivery

Violations are logged with timestamps, severity, and content snippets. Critical violations trigger alerts. This is **better than most production systems**.

#### 2. Docker Sandbox (`src/agent/sandbox.ts` — 417 lines)
Code execution runs in isolated Docker containers with:
- HTTP bridge for tool calls back to TITAN
- Session token validation
- Denied-tool lists (`shell`, `exec`, `code_exec` blocked by default)
- Automatic container cleanup

This matches the Anthropic recommendation for "self-managed sandboxed execution."

#### 3. Trajectory Logging (`src/agent/trajectoryLogger.ts` — 128 lines)
Every task is logged to `~/.titan/trajectories/task-trajectories.jsonl` with:
- Tool sequence (ordered)
- Tool arguments and results
- Success/failure status
- Duration and round count
- Session ID for correlation

This enables **offline evaluation** and **auto-skill generation**.

#### 4. System Prompt Composability (`src/agent/systemPromptParts.ts` — 376 lines)
TITAN learned from Hermes/Paperclip/OpenClaw:
- Prompt modes: `full`, `minimal`, `none`
- Base Law placed at BOTH top and bottom (primacy + recency)
- Per-model-family overlays instead of one mega-prompt
- Condensed privacy guard (8 paragraphs → 1 sentence)

This is **advanced prompt engineering**.

#### 5. Loop Detection (`src/agent/loopDetection.ts` — 240 lines)
Three detectors:
- `genericRepeat` — same tool + same params repeatedly
- `knownPollNoProgress` — repeating polls with identical outputs
- `pingPong` — alternating A/B patterns with no progress

Circuit breaker at 20 repetitions. This prevents the "meltdown" behavior documented in arXiv 2603.29231.

#### 6. Context Budgeting (`src/agent/contextManager.ts` — 307 lines)
Token budget calculation accounts for:
- System prompt tokens
- Tool definition tokens (~120 per tool)
- Response reserve (2,000 tokens)
- Remaining budget for history

Smart truncation preserves tool call context. This is better than Auto-GPT's naive truncation.

---

### ❌ Critical Gaps

#### GAP 1: 253 Tools Violates "Small Stable Action Space"
**Severity**: CRITICAL  
**File**: `src/skills/*`, `tests/unit/readme-claims.test.ts`

TITAN registers **253 tools** across 143 skills. This is the **opposite** of the 2026 consensus.

**Why this is bad**:
1. **Cache instability**: Every tool definition changes the prompt prefix. Adding/removing skills mid-session breaks prompt cache.
2. **Model confusion**: Studies show tool choice accuracy degrades past ~10 tools. At 253, the model randomly selects tools.
3. **Evaluation intractability**: You cannot write deterministic tests for 253 tools.
4. **Token bloat**: 253 × 120 tokens = 30,360 tokens just for tool definitions. That's 30% of a 100K context window before any conversation.

**What the best practices say**:
> "Start with a compact set of high-leverage primitives: file ops, search/read, code execution or shell, planning/tasks, subagent delegation." — Modern Agent Harness Blueprint 2026

**Recommended Fix**:
1. Define **5 core primitive tools** that never change:
   - `read` (file, URL, or artifact handle)
   - `write` (file or artifact)
   - `edit` (search + replace)
   - `bash` (shell command with sandbox)
   - `delegate` (spawn subagent or external adapter)
2. Convert all 248 other "tools" into **skills** that are implemented as subagents or prompt templates
3. Add a `search_skills` tool that lets the agent find the right skill for a task
4. Keep the skill registry static per session (no dynamic injection)

**Effort**: 2–3 days of refactoring + test updates

---

#### GAP 2: Agent Loop is a 2,463-Line Monolith
**Severity**: HIGH  
**File**: `src/agent/agentLoop.ts`

TITAN's agent loop is **2,463 lines** in a single file. This violates the principle of "keep the loop simple, put complexity in middleware."

**Why this is bad**:
1. **Unmaintainable**: No human can hold 2,463 lines of state machine logic in working memory
2. **Untestable**: You can't unit test a 2,463-line file effectively
3. **No middleware composability**: Can't add/remove layers without touching the monolith
4. **Cache-unfriendly**: Dynamic context injection scattered throughout

**What the best practices say**:
> "The harness matters more than the loop." — Modern Agent Harness Blueprint 2026
> "LangChain structures their harness as composable middleware layers." — nxcode.io

**Recommended Fix**:
Decompose `agentLoop.ts` into middleware layers:

```
Agent Request
  → PreProcessMiddleware (input classification, guardrails)
  → ContextAssemblyMiddleware (memory, skills, workspace files)
  → CacheStabilityMiddleware (stable prefix, append-only history)
  → ModelCallMiddleware (provider routing, retry, failover)
  → ToolExecutionMiddleware (sandbox, parallel, checkpoint)
  → ReflectionMiddleware (self-assess, loop detection)
  → PostProcessMiddleware (output guardrails, response formatting)
  → Agent Response
```

Each middleware is 100–200 lines, independently testable.

**Effort**: 3–4 days of refactoring

---

#### GAP 3: Dynamic Skill Injection Breaks Cache
**Severity**: HIGH  
**File**: `src/agent/autoSkillGen.ts`

TITAN auto-generates skills from successful trajectories and injects them into the system prompt. This is **dynamic toolset rewriting mid-session** — an explicit anti-pattern.

**Why this is bad**:
> "Dynamically rewriting the toolset mid-session breaks cache locality and confuses state." — Modern Agent Harness Blueprint 2026

**Recommended Fix**:
1. Auto-generated skills should be **written to disk** as SKILL.md files (TITAN already does this)
2. They should be **loaded at session start** into a static skill catalog
3. The agent should use `search_skills` to find relevant skills, not have them all injected into the prompt
4. Never change the tool catalog after the first turn

**Effort**: 1 day

---

#### GAP 4: Missing Harness-Level Evaluations
**Severity**: MEDIUM-HIGH  
**File**: `src/eval/harness.ts`, `tests/*`

TITAN's eval harness tests:
- Expected tools used
- Expected gates emitted
- Expected content in response
- Forbidden tools not used

This is **model-level evaluation**. It's missing **harness-level evaluation**:

**Missing tests**:
1. **Resumption**: Crash the agent mid-task, restart it, verify it recovers state and continues
2. **Compaction**: Fill context to 95%, trigger compaction, verify critical state is preserved
3. **Approval gates**: Send a destructive command, verify the gate blocks it 100/100 times
4. **Delegation recovery**: Spawn a subagent, kill the subagent process, verify parent handles failure gracefully
5. **Cache stability**: Run 10 turns, verify the system prompt hash never changes
6. **Tool mock determinism**: Replay a tape 100 times, verify identical tool sequences every time

**Recommended Fix**:
Add a `tests/harness/` directory with:
- `resumption.test.ts`
- `compaction.test.ts`
- `approval-gate-reliability.test.ts`
- `delegation-failure.test.ts`
- `cache-stability.test.ts`

**Effort**: 2–3 days

---

#### GAP 5: Heartbeat Inbox is Stubbed
**Severity**: CRITICAL (for multi-agent use case)  
**File**: `src/agent/agentLoop.ts` (lines ~178–194)

`checkAndProcessInbox()` is implemented but **commented out**. The multi-agent heartbeat system — the core feature that lets TITAN run 24/7 with worker agents — is **disabled**.

**Recommended Fix**:
1. Uncomment the inbox polling logic
2. Add a feature flag `TITAN_HEARTBEAT_INBOX=true`
3. Write a dedicated test: `tests/harness/heartbeat-inbox.test.ts`
4. Document the multi-agent startup sequence in AGENTS.md

**Effort**: 4–6 hours

---

#### GAP 6: No Artifact Store Pattern
**Severity**: MEDIUM  
**File**: `src/agent/toolRunner.ts`

TITAN sanitizes base64 images (`[image: 45.2KB omitted]`) but does not have a general **artifact store** for large tool outputs.

**What this means**:
- A `web_search` that returns 50 results still sends all 50 summaries to the model
- A `data_analysis` tool that produces a 5,000-row table sends the full table to the model
- This causes context overflow and "meltdown"

**Recommended Fix**:
1. Add an `artifacts/` directory (in-memory or filesystem)
2. Any tool output > 1,000 tokens gets written to an artifact file
3. The tool returns `artifact://search-results-abc123` instead of raw content
4. The model uses `read_artifact` when it needs detail
5. This is exactly what Anthropic's programmatic tool calling recommends

**Effort**: 1–2 days

---

#### GAP 7: Missing Structured Quality Loop
**Severity**: MEDIUM  
**File**: `src/agent/reflection.ts`, `src/agent/verifier.ts`

TITAN has reflection and verification, but not a **structured quality loop** that enforces:
1. Implement
2. Review
3. Evaluate
4. Refine
5. Zoom Out (check integration points)
6. Repeat
7. Report

**Recommended Fix**:
Add a `qualityLoop` middleware that runs after tool execution:
- On write/edit: trigger review of changed lines
- On test failure: trigger evaluate → refine cycle
- On completion: trigger zoom-out check for adjacent regressions
- Every result includes a structured report: what changed, how verified, evidence cites

**Effort**: 2–3 days

---

## Remediation Priority

| Priority | Gap | Effort | Impact |
|---|---|---|---|
| P0 | Enable heartbeat inbox (GAP 5) | 4–6 hours | Unblocks 24/7 multi-agent |
| P0 | Reduce tool count to 5 primitives (GAP 1) | 2–3 days | Fixes cache, cost, accuracy |
| P1 | Decompose agent loop into middleware (GAP 2) | 3–4 days | Maintainability, testability |
| P1 | Add harness-level evals (GAP 4) | 2–3 days | Production confidence |
| P1 | Implement artifact store (GAP 6) | 1–2 days | Prevents meltdown |
| P2 | Fix dynamic skill injection (GAP 3) | 1 day | Cache stability |
| P2 | Add quality loop middleware (GAP 7) | 2–3 days | Code quality |

**Total estimated effort**: 12–17 days of focused work

---

## What TITAN Should Look Like After Fixes

```
┌─────────────────────────────────────────────────────────────┐
│                    TITAN Agent Harness v6.0                 │
├─────────────────────────────────────────────────────────────┤
│  Middleware Stack (composable, testable, 100–200 lines each) │
│  ├── PreProcessMiddleware    (input classification)         │
│  ├── GuardrailMiddleware     (runtime policy enforcement)   │
│  ├── ContextAssemblyMiddleware (memory + skills + files)    │
│  ├── CacheStabilityMiddleware (stable prefix, static tools) │
│  ├── ModelCallMiddleware     (provider routing, retry)      │
│  ├── ToolExecutionMiddleware (sandbox, artifact store)      │
│  ├── QualityLoopMiddleware   (review → evaluate → refine)   │
│  ├── ReflectionMiddleware    (self-assess, loop detect)     │
│  └── PostProcessMiddleware   (output guardrails, format)    │
├─────────────────────────────────────────────────────────────┤
│  Core Primitives (5 tools, never change mid-session)        │
│  ├── read  → file, URL, artifact handle                     │
│  ├── write → file or artifact                               │
│  ├── edit  → search + replace                               │
│  ├── bash  → sandboxed shell                                │
│  └── delegate → subagent or external adapter                │
├─────────────────────────────────────────────────────────────┤
│  Skill Registry (static per session, loaded at start)       │
│  ├── search_skills(query) → returns relevant skill handles  │
│  ├── Skills are prompt templates + subagent configs         │
│  └── Auto-generated skills written to disk, loaded next run │
├─────────────────────────────────────────────────────────────┤
│  Artifact Store (working memory outside model context)      │
│  ├── Large outputs → artifact://handle                      │
│  ├── Model reads handles on demand                          │
│  └── Prevents token flooding and meltdown                   │
├─────────────────────────────────────────────────────────────┤
│  Multi-Agent (heartbeat-driven, 24/7 capable)               │
│  ├── Command Post work queue                                │
│  ├── Inbox polling every 3 rounds                           │
│  ├── Atomic claim/release (CAS)                             │
│  └── External adapters: Claude Code, Codex, Bash            │
├─────────────────────────────────────────────────────────────┤
│  Evaluation (5 layers)                                      │
│  ├── Unit tests (pure functions)                            │
│  ├── Mock trajectory tests (deterministic replays)          │
│  ├── Cross-model parity tests                               │
│  ├── Live eval suites (80% gate)                            │
│  └── Harness tests (resumption, compaction, delegation)     │
└─────────────────────────────────────────────────────────────┘
```

---

## Immediate Actions

1. **Enable heartbeat inbox** — uncomment `checkAndProcessInbox()` in `agentLoop.ts`
2. **Count actual runtime tools** — run `npm test -- tests/unit/readme-claims.test.ts`
3. **Design the 5-primitive toolset** — document which 248 tools become skills
4. **Write one harness test** — `tests/harness/resumption.test.ts`
5. **Add artifact store prototype** — `src/agent/artifactStore.ts` (200 lines)

---

*Audit complete. See `TITAN-100-PLAN.md` for the full operational plan.*
