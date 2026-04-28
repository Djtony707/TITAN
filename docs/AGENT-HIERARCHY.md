# TITAN Agent Orchestration Hierarchy

> **Audience:** anyone touching `src/agent/`. If you're about to add a new
> file or another way to spawn a sub-agent, read this first. Most of the
> time the answer is "use the existing path."

TITAN's agent layer has three distinct concerns. Keeping them separate
prevents the "I'll just add another orchestrator" cycle that produced
the v5.4.x cleanup pass.

---

## The three layers

```
┌─────────────────────────────────────────────────────────────┐
│ LAYER 1 — Conversation loop (one user, one turn)            │
│                                                             │
│   /api/message  →  multiAgent.routeMessage                  │
│                 →  agent.processMessage                     │
│                 →  agentLoop  (THINK → ACT → RESPOND)       │
│                                                             │
│   Files: agent/loop/{agent,agentLoop,agentEvents,           │
│          contextManager,contextCompressor,promptBudget}.ts  │
└─────────────────────────────────────────────────────────────┘
                             │
                             │  needs parallel / specialized work?
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ LAYER 2 — Delegation (this turn spawns sub-agents)          │
│                                                             │
│   orchestrator.analyzeForDelegation                         │
│        → spawnSubAgent(template, task, ctx)  ← CANONICAL    │
│   hierarchicalPlanner.decomposeHierarchically               │
│        → spawnSubAgent for each leaf                        │
│                                                             │
│   Specialists: explorer, coder, browser, analyst, …         │
│                                                             │
│   Files: agent/delegation/{subAgent,orchestrator,           │
│          specialists,specialistRouter,                      │
│          hierarchicalPlanner,structuredSpawn,swarm}.ts      │
└─────────────────────────────────────────────────────────────┘
                             │
                             │  no user prompt at all? scheduled / autonomous?
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ LAYER 3 — Autonomy (no-user-prompt background work)         │
│                                                             │
│   driverScheduler  (10s tick, concurrency cap = 5)          │
│    │                                                        │
│    ├─ goalDriver       (per-goal state machine)             │
│    ├─ missionDriver    (multi-goal coordination)            │
│    ├─ autopilot        (fallback chain orchestration)       │
│    └─ initiative       (build-loop initiative engine)       │
│                                                             │
│   Soma drives → goalProposer → driverScheduler picks up     │
│                                                             │
│   Files: agent/autonomy/{driverScheduler,goalDriver,        │
│          missionDriver,autopilot,initiative,                │
│          driverAwareChat,heartbeatScheduler}.ts             │
└─────────────────────────────────────────────────────────────┘
                             │
                             │  spans every layer
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ GOVERNANCE OVERLAY (runs alongside, not below)              │
│                                                             │
│   commandPost    — atomic checkout, registry, ancestry      │
│   budgetEnforcer — token + dollar caps per goal             │
│   guardrails     — input/tool/output content filters        │
│   approvalClassifier — auto-approve vs ask-user             │
│                                                             │
│   Files: agent/governance/{commandPost,budgetEnforcer,      │
│          guardrails,approvalClassifier,auditLog,            │
│          auditStore,outputGuardrails}.ts                    │
└─────────────────────────────────────────────────────────────┘
```

---

## When do I use which?

| You want to… | Layer | Use |
|---|---|---|
| Process a message from the user / a channel / voice | 1 | `agent.processMessage(msg, channel, userId)` |
| Spawn a fresh sub-agent for a parallel sub-task in the current turn | 2 | `subAgent.spawnSubAgent(template, task, ctx)` ← **always this** |
| Decompose a multi-step request into a planned tree | 2 | `hierarchicalPlanner.decomposeHierarchically(...)` then iterate `spawnSubAgent` per leaf |
| Decide *whether* to delegate at all | 2 | `orchestrator.analyzeForDelegation(message)` |
| Run a goal in the background until it completes | 3 | Create the goal via Command Post → `driverScheduler` picks it up automatically |
| Coordinate multiple goals into one outcome | 3 | `missionDriver.createMission({...})` |
| Add a budget / approval / audit gate | overlay | Hook into `commandPost`, `budgetEnforcer`, or `guardrails` — **don't add a new gate file**, extend an existing one |

---

## Anti-patterns (these are **deprecated** as of v5.4.x cleanup)

- ❌ `swarm.runSubAgent` — was a parallel implementation of `spawnSubAgent`. Re-exports through the canonical path; new call sites should use `spawnSubAgent` directly.
- ❌ `structuredSpawn.spawn` — was a third copy. Same re-export shim.
- ❌ Inline `chat({ systemPrompt: 'You are an explorer...', ... })` calls — bypasses the specialist registry, the governance overlay, and the trace bus. **Always go through `spawnSubAgent`.**
- ❌ A new file in `src/agent/` to "do something kind of like sub-agents but different" — talk to the architecture before adding. 99% of the time, an existing primitive covers it.

---

## Soma feedback loop

The autonomous layer has one input the others lack: **homeostatic drives**.

```
   driveTickWatcher (every N seconds)
        │
        ▼
   organism/pressure.ts  computes pressure per drive
        │
        ▼  if pressure > threshold
   goalProposer  emits a draft goal
        │
        ▼
   commandPost.createIssue (governance entry point)
        │
        ▼
   driverScheduler picks up the new goal next tick
```

This is the part that's actually hard to copy. LangGraph / CrewAI / Mastra have nothing equivalent. If you're touching this loop, read `docs/ADR-001-soma.md` first.

---

## File-organization contract

Every file in `src/agent/` lives in one of six subdirectories:

| Directory | What goes here |
|---|---|
| `agent/loop/` | Per-turn conversation processing |
| `agent/delegation/` | Sub-agent spawn + specialist registry + hierarchical planning |
| `agent/autonomy/` | Background drivers, schedulers, mission/goal state machines |
| `agent/governance/` | Cross-cutting policy: budgets, approvals, audit, guardrails |
| `agent/self-mod/` | Self-improvement: GEPA, proposals, staging, shadow git |
| `agent/tooling/` | Tool execution: runner, search, sandbox, parallel exec |

When in doubt, check which **layer** above your concern belongs to and the
subdirectory follows.

---

## Testing the contract

`tests/architecture-contract.test.ts` (TODO: write) should grep `src/agent/` for:

- Any file outside the six subdirectories → fail
- Any inline `chat({ systemPrompt: 'You are a ...' })` outside `delegation/specialists.ts` → fail
- Any `runSubAgent` / `structuredSpawn` import that isn't the deprecated re-export shim → fail

That's how this contract stays a contract instead of a doc nobody reads.
