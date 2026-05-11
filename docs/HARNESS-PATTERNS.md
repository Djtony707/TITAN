# TITAN — Harness Patterns

A self-audit of where TITAN stands against the agent-harness ecosystem catalogued in [`Picrew/awesome-agent-harness`](https://github.com/Picrew/awesome-agent-harness) and the principles in [12 Factor Agents](https://github.com/humanlayer/12-factor-agents).

The point of this doc is not marketing. It's a true table: what we have, what we partially have, what we explicitly don't have and why. It's updated each release.

> **Why this doc exists.** The recurring user pain in TITAN (token-budget hard-stops, identity hallucination, sycophancy, sparse model lists) all traced to harness-engineering gaps, not LLM problems. The article "[Skill Issue: Harness Engineering for Coding Agents](https://blog.langchain.com/skill-issue-harness-engineering-for-coding-agents/)" frames this directly: **harness quality drives agent quality**.

## Top-10 patterns (from the agent-harness research)

| # | Pattern | TITAN status | Where |
|---|---------|--------------|-------|
| 1 | **Explicit control loops + checkpointing** | ✅ Have | Shadow-git checkpoints (`src/agent/shadowGit.ts`), Command Post checkout/budgets/ancestry (`src/agent/commandPost.ts`), durable session persistence (`src/agent/session.ts`). |
| 2 | **Sandbox abstraction + isolation strategy** | ⚠️ Partial | Iframe sandbox for widgets (`ui/src/titan2/sandbox/SandboxRuntime.ts`), shell pre-exec scanner (`src/security/preExecScan.ts`), kill-switch (`src/safety/killSwitch.ts`). Missing: WASM/MicroVM-grade isolation. |
| 3 | **Context compaction + working-state management** | ✅ Have (fixed v5.7.0) | `buildSmartContext` + `compressContext` (`src/agent/contextManager.ts`, `src/agent/contextCompressor.ts`). v5.7.0 wired these into the budget-exceed path so `action: 'compress'` actually compresses instead of hard-stopping with "Session paused". |
| 4 | **Tool protocol standardisation via MCP** | ✅ Have | MCP Server (JSON-RPC 2.0, stdio + HTTP) in `src/mcp/`. Hindsight MCP bridge for cross-session episodic memory. |
| 5 | **Verification + evaluation as first-class** | ✅ Have | 11 live-eval suites in `src/eval/harness.ts`, 80 %-per-suite CI gate in `.github/workflows/eval-gate.yml`, `tests/unit/readme-claims.test.ts` for documentation truth. |
| 6 | **Multi-agent orchestration via explicit role boundaries** | ✅ Have | 43 personas in `assets/personas/`, Command Post governance, sub-agent registry. Tracks 7 + 9 of `docs/ROADMAP.md` strengthen this further. |
| 7 | **Gateway-level policy enforcement** | ✅ Have | Provider router with fail-fast (`isConfigured()`), circuit breakers, rate limiting, PII redaction, secret guard, pre-exec scanner. |
| 8 | **Deterministic workflow control (DAG / spec)** | ❌ Missing | TITAN runs autonomous loops. Spec-driven phases (Archon / GitHub Spec Kit style) are an open v6.x item. |
| 9 | **Approval delegation + human-in-the-loop** | ✅ Have | `src/skills/builtin/approval_gates.ts`, Command Post atomic checkout, classifier-backed safety pressure (Soma). |
| 10 | **Observability-native architecture** | ⚠️ Partial | PostHog telemetry, `~/.titan/bug-reports.jsonl`, audit log, internal `tracer.ts` + `diagnostics/otel.ts`. Missing: OpenInference / OpenTelemetry export so Langfuse / Phoenix / Helicone can consume traces directly. |

## 12 Factor Agents — TITAN compliance

Tracking [12 Factor Agents](https://github.com/humanlayer/12-factor-agents) by Dex Horthy / HumanLayer. Each factor + TITAN's stance:

| # | Factor | TITAN |
|---|--------|-------|
| 1 | Natural-language → structured tool calls | ✅ Tool router with provider-agnostic schema enforcement (`src/agent/toolRunner.ts`) |
| 2 | Own your prompts | ✅ `src/agent/systemPromptParts.ts` — composable blocks, per-mode assembly, per-model overlays |
| 3 | Own your context window | ✅ v5.7.0 — explicit `BudgetCheckResult` shape with compress/downgrade/stop actions, `buildSmartContext` machinery |
| 4 | Tools are just structured outputs | ✅ Zod schemas on every skill (`src/skills/registry.ts`) |
| 5 | Unify execution state + business state | ⚠️ Partial — sessions + agent state are unified; goals + cron live in adjacent stores |
| 6 | Launch / pause / resume with simple APIs | ✅ Session save/resume, checkpoint resume, kill-switch + restart |
| 7 | Contact humans with tool calls | ✅ Approval gates, command-post review queue, push notifications |
| 8 | Own your control flow | ✅ Explicit ReAct loop in `src/agent/agentLoop.ts`, not hidden inside a framework |
| 9 | Compact errors into context window | ✅ Error taxonomy in `src/providers/errorTaxonomy.ts`, structured error injection |
| 10 | Small, focused agents | ✅ Per-persona scope; v6.0 track #6 (agent-authored live widgets) strengthens further |
| 11 | Trigger from anywhere, meet users where they are | ✅ 19 channel adapters in `src/channels/` |
| 12 | Make your agent a stateless reducer | ⚠️ Partial — sessions are stateful; the per-turn function is pure modulo memory injection |

## Patterns we explicitly DON'T have (and why)

- **Deterministic DAG workflow builder** (LangGraph-style). The roadmap explicitly rejects this — drawn flows lose against agentic flows. We bet on the LLM as the planner, not the human-as-planner-of-flows.
- **WASM / MicroVM-grade execution sandbox**. Operational overhead vs the population we serve (single-user homelab + small-team SaaS) doesn't justify it yet.
- **A locked-in cloud control plane**. Cloud features are opt-in. TITAN must work fully offline against local Ollama — that's a hard line.

## What v5.7.0 specifically fixes from the harness research

Real user incident, 2026-05-10:
> 5-turn conversation → "Token budget exceeded (216,713/200,000). Session paused to control costs."

Root cause traced via the research: TITAN had `action: 'compress'` as the default budget action, BUT `promptBudget.checkBudget()` returned a single string regardless of action, and `agentLoop.ts` treated any non-null result as a hard stop. The compression machinery existed (`buildSmartContext`); nothing called it on budget exceed.

v5.7.0 fix:
1. **`promptBudget.checkBudget()` returns a structured `BudgetCheckResult`** with `action: 'compress' | 'downgrade' | 'stop'`. Compresses by default.
2. **`agentLoop.ts` honors `action: 'compress'`** — invokes `buildSmartContext`, swaps the message history, resets the budget counter, continues the loop.
3. **The user-facing message** for the compress path no longer says "Session paused" — it says the context was trimmed and the session is continuing.
4. **New unit tests** in `tests/unit/promptBudget-compress.test.ts` pin the structured return shape and the message wording, so the regression cannot silently recur.

References used:
- Anthropic — "Effective context engineering for AI agents" — context-as-bottleneck
- 12 Factor Agents — §3 ("Own your context window") + §10 ("Small, focused agents")
- awesome-agent-harness top-10 pattern #3

## How to verify

```bash
# Unit tests
npx vitest run tests/unit/promptBudget-compress.test.ts

# Live in a session — set a low maxTokens to force the compress branch
TITAN_MAX_TOKENS=2000 npm run dev:gateway
# Then chat normally; after a few turns the log will say:
#   [Budget] Compressed context: 12 → 4 messages, budget reset
# instead of "Session paused to control costs."
```

## Reading list (from the research)

- [12 Factor Agents](https://github.com/humanlayer/12-factor-agents) — Dex Horthy / HumanLayer
- [Anatomy of an Agent Harness](https://www.harnessengineering.com/anatomy-of-a-harness/) — Martin Fowler series
- [Skill Issue: Harness Engineering for Coding Agents](https://blog.langchain.com/skill-issue-harness-engineering-for-coding-agents/)
- [Effective context engineering for AI agents](https://www.anthropic.com/news/context-engineering) — Anthropic
- [Building Effective AI Agents](https://www.anthropic.com/research/building-effective-agents) — Anthropic
- [Your Agent Needs a Harness, Not a Framework](https://blog.langchain.com/your-agent-needs-a-harness-not-a-framework/)
- [Writing effective tools for AI agents](https://www.anthropic.com/news/writing-effective-tools-for-ai-agents-using-ai-agents) — Anthropic
- [Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness) — the full catalogue
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) — TITAN ships these in `assets/agent-skills/`

If you see a pattern in the awesome-agent-harness catalogue that TITAN should adopt, open an issue on the [TITAN repo](https://github.com/Djtony707/TITAN/issues) with the pattern name + a one-line argument for fit.
