# TITAN Architecture

## System Overview

- Main loop summary: Discord gateway events are received by `titan-cli`, converted to `CoreEvent`, passed to `titan-gateway::process_event`, planned deterministically in `titan-core`, executed through `titan-tools` with policy gating, then persisted and surfaced in Web UI.
- Crates and responsibilities: each crate has a strict role (CLI control plane, gateway orchestration, deterministic planning, tools/policy, memory/persistence, Discord transport, web/API, shared config/path safety, comm adapters, skill runtime).
- Where traces/memory live: run data is persisted in SQLite via `titan-memory` (`goals`, `run_plans`, `run_steps`, `trace_events`, `approval_requests`, `episodic_memories`, plus semantic/procedural tables).
- How approvals work: in `Collaborative` mode, non-READ steps are blocked before execution, a pending approval row is created, and execution continues only after `/titan approve <id>` (or web approve) resolves it.

## Workspace Crates

### `titan-cli`
- User/operator entrypoint (`onboard`, `doctor`, `run`, goal/tool/approval/memory/model/skill/web commands).
- Runs the Discord gateway event handler (Serenity).
- Starts Web runtime and delegates event execution to `titan-gateway`.

### `titan-gateway`
- Runtime orchestration boundary.
- Accepts inbound events and calls deterministic planning/execution pipeline.
- Persists each run atomically through `titan-memory::persist_run_bundle`.
- Resolves approvals and resumes blocked actions.

### `titan-core`
- Deterministic planning and execution model for v1.
- Defines `CoreEvent`, `GoalIntent`, `PlanCandidate`, `TaskPlan`, `Step`, `StepPermission`, `StepResult`, and `TraceEvent`.
- Generates 2-5 plan candidates, scores by risk/cost/confidence, selects one deterministically.

### `titan-tools`
- Tool registry and execution broker.
- Capability classes: `Read`, `Write`, `Exec`, `Net`.
- Enforces workspace boundaries and command/network restrictions.
- Uses shared `path_guard` for safe filesystem access.

### `titan-memory`
- SQLite persistence layer.
- Stores run lifecycle records (goal, plan, step, trace, approval, episodic memory).
- Provides approval queue APIs and replay protection for approved tool runs.

### `titan-web`
- Local dashboard + API over SQLite-backed state.
- Shows runtime status, pending approvals, goals, recent traces, and episodic memory.
- Approval actions execute through the same tool/policy constraints.

### `titan-discord`
- Discord HTTP client utilities for health/status and messaging operations.
- Complements CLI’s event-driven gateway runtime.

### `titan-comms`
- Normalized communication adapter surface for channel status/send operations.
- Supports native and bridge-style channel adapters.

### `titan-skills`
- Skill package loading/validation/runtime for extensibility.
- Preserves workspace safety constraints.

### `titan-common`
- Shared config, logging, and path guard utilities.
- Defines autonomy modes and common runtime helpers.

## Runtime Data Flow

1. Incoming Discord message reaches the CLI event handler.
2. Handler constructs `InboundEvent` and calls `titan-gateway::process_event`.
3. Gateway builds a `CoreEvent`, invokes deterministic planner, then executes steps through tool broker.
4. Policy checks gate risky permissions based on autonomy mode.
5. Gateway writes run state transactionally to SQLite.
6. Web UI reads SQLite and renders current truth.

## Persistence Model (SQLite)

- Goal lifecycle: `goals`
- Selected plan metadata: `run_plans`
- Step-level execution status/output: `run_steps`
- Timeline/audit events: `trace_events`
- Human-in-the-loop gating: `approval_requests`
- Reflection memory: `episodic_memories`
- Long-horizon memory: `semantic_facts`, `procedural_strategies`

## Safety Model

### Policy gating
- `Supervised`: all capabilities require approval.
- `Collaborative`: `Read` auto-executes; `Write`/`Exec`/`Net` require approval.
- `Autonomous`: no approval gate.

### Workspace boundary
- File operations are constrained by canonicalized workspace checks in `path_guard`.
- Escapes outside workspace are rejected.

### Execution constraints
- Tool execution has command allowlist, timeout bounds, output caps, and network restrictions.

### Auditability
- Every run persists traces and step outcomes.
- Approval decisions and post-approval executions are persisted.
- Web/API views are driven from SQLite, not ephemeral memory.
