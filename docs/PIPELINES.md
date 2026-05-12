# TITAN Pipelines

> **What this is.** The contract for how a request flows through TITAN
> end-to-end. Each pipeline lists the modules it touches, the order they
> fire in, what log lines you should expect, and how to verify it's
> actually wired correctly.
>
> **Why this exists.** v5.8.0 (the "harness pack") added 7 new modules
> that are easy to break with a refactor because the wiring is implicit.
> This doc + `tests/integration/pipeline-v580.test.ts` together pin the
> wiring so it can't silently regress.
>
> If you're touching `agent/agent.ts`, `agent/agentLoop.ts`,
> `agent/toolRunner.ts`, or `gateway/server.ts` — read the relevant
> pipeline below first and make sure your change preserves the
> observable contract.

---

## Pipeline 1 — Chat message: `POST /api/message` → response

The main user-facing request path. Every test in `tests/integration/pipeline-v580.test.ts` exercises some slice of this.

### Sequence

```
1. POST /api/message arrives at src/gateway/server.ts
2. Auth check (gateway/server.ts isValidToken)
3. SSE writer setup (if Accept: text/event-stream)
4. widgetEmitter.subscribe() opens per-session widget side-channel
5. routeMessage(content, channel, userId, opts) → src/agent/multiAgent.ts
6. processMessage() → src/agent/agent.ts
7. assembleSystemPrompt() builds dynamic sections, then:
   → applyCaps(sections)              src/agent/promptSectionCaps.ts
   → loadAgentsHierarchy()            src/agent/agentsMdLoader.ts
8. agentLoop() begins multi-round tool-use loop  src/agent/agentLoop.ts
9. For each round:
   a. Chat call → providers/router.ts → provider implementation
   b. If tool_calls present:
      → executeTools(toolCalls)       src/agent/toolRunner.ts
        - [ToolIntent] log emitted per tool (sync/risky/destructive/long-running)
        - executeTool() runs handler.execute(args)
        - capToolOutput() clips output, appends tool-aware hint   src/agent/toolOutputCap.ts
      → verifyToolResult() per result  src/agent/toolResultVerifier.ts
        - On failure, consolidated synthetic feedback injected next turn
   c. Loop until model returns final answer or maxRounds hit
10. SSE event: done with content, sessionId, durationMs, toolsUsed
11. widgetEmitter unsubscribed in finally{}
```

### Observable log markers

| Module | Log line you should see | Component |
|---|---|---|
| Tool intent | `[ToolIntent] <toolName> = <kind>` | `agentLoop.ts:executeTools` |
| Tool output cap | (silent on small) / `[ToolOutputCap] truncated <N>→<M> chars (<tool>)` | `toolRunner.ts` |
| Verifier (silent on success) | `[Verifier] Injected feedback for N failed tool call(s)` | `agentLoop.ts` |
| AGENTS.md loader | `[AgentsMdLoader] Loaded <N> file(s), <K> chars` | `agentsMdLoader.ts` |
| Prompt caps | `[PromptCaps] section "<name>" trimmed N→M` (debug only with `TITAN_PROMPT_DEBUG=1`) | `promptSectionCaps.ts` |
| widget side-channel | `event: widget` on the SSE stream | `gateway/server.ts:1860` |

### Integration test coverage

- **H2.1** — canvas_widgets skill registers 3 lifecycle tools
- **H2.2** — `applyCaps` trims oversized sections to per-section ceilings
- **H2.3** — verifier flags realistic failure shapes with actionable reasons
- **H2.4** — `getToolKind` classifies shell/write_file/read_file correctly
- **H2.5** — output cap clips with tool-aware steering hints
- **H2.6** — widget side-channel is session-scoped, `create_widget` fires event
- **H2.7** — `agent_delegate` 4-field contract composes structured task
- **H2.8** — `executeTool` round-trips real registered handler

### How to verify in production

After deploy + restart:

```bash
# 1. Confirm the gateway boots clean
ssh titan 'sudo systemctl status titan'

# 2. Tail the log + send a probe that exercises a few pipeline pieces
ssh titan 'tail -F ~/titan.log' &
# Then from any chat client: "make me a clock widget"
# Expected log markers:
#   [ToolIntent] gallery_search = sync
#   [ToolIntent] create_widget = sync
#   [Verifier] (silent — gallery_search + create_widget succeed)
#   [CanvasWidgets] create_widget "Clock" (react, 4x4) — delivered=true
```

---

## Pipeline 2 — Tool execution: `executeTool(toolCall)`

The path each individual tool call takes. Called from the agent loop's
multi-tool-call dispatch (`executeTools`).

### Sequence

```
1. executeTool(toolCall, channel?) → src/agent/toolRunner.ts
2. Lookup handler in toolRegistry (Map<name, ToolHandler>)
3. Pre-tool hooks (shell only)        src/agent/guardrails.ts
4. Approval gate (if tool is in approval_gates list)
5. Checkpoint creation (file-mutating tools)  src/agent/fileCheckpoints.ts
6. handler.execute(args) — the tool's own implementation
7. Tool intent logged                  src/agent/toolIntent.ts
8. capToolOutput()                     src/agent/toolOutputCap.ts
9. Post-tool hooks (shell post)
10. Trajectory + structured result recorded
11. Return ToolResult { content, name, success, toolCallId, ... }
```

### Observable log markers

| Step | Log line | Component |
|---|---|---|
| Dispatch | `[ToolRunner] Executing tool: <name>` | `toolRunner.ts` |
| Intent | `[ToolIntent] <name> = <kind>` | `toolIntent.ts` |
| Approval (if gated) | `[ApprovalGate] Pending approval for <name>` | `guardrails.ts` |
| Checkpoint | `[FileCheckpoints] <name> snapshot N bytes` | `fileCheckpoints.ts` |
| Completion | `[ToolRunner] Tool <name> completed in Nms` | `toolRunner.ts` |
| Output cap (when truncated) | `truncated at <N> chars` in the result string itself | `toolOutputCap.ts` |

### Integration test coverage

- **H2.8** in `pipeline-v580.test.ts` — `executeTool` round-trips a real
  tool through the full path including registry lookup + intent log +
  cap + handler invocation.

---

## Pipeline 3 — Sub-agent delegation: `agent_delegate` tool

The 4-field contract path that lets the main agent hand off focused
sub-tasks to specialist agents.

### Sequence

```
1. agent_delegate({role, objective?, task?, output_format?, tool_guidance?,
                   boundaries?, context?, maxRounds?})
   → src/skills/builtin/agent_handoff.ts
2. resolveRole(role) — looks up SUB_AGENT_TEMPLATES[role]
3. If any 4-field contract field present:
   → composeDelegationTask({objective, outputFormat, toolGuidance,
                            boundaries, context})
   - Renders structured prompt with `## Objective`, `## Output Format`,
     `## Tool Guidance`, `## Boundaries (do NOT)`, `## Context` headers
4. spawnSubAgent({name, task, tools, systemPrompt, tier, maxRounds})
   → src/agent/subAgent.ts
5. Sub-agent runs an independent agent loop with its own tool budget
6. Result returned as: "[SUCCESS|FAILED] Agent: <name> | Rounds: N |
   Duration: Nms\nTools used: ...\n\n<content>"
```

### The 4-field contract

When the model supplies any of these optional fields, the task is composed
into a structured prompt the sub-agent reads:

```
## Objective
<what success looks like in one sentence>

## Output Format
<exact response shape>

## Tool Guidance
<recommended tool order / sources>

## Boundaries (do NOT)
<explicit "do not" lines>

## Context
<extra prose context>
```

Legacy callers using only `task` + `context` keep working unchanged.

### Integration test coverage

- **H2.7** in `pipeline-v580.test.ts` — section order pinned, parameter
  schema includes all 4 new fields additively, `agent_delegate` description
  carries the effort-scaling ladder.

---

## Pipeline 4 — Canvas widget side-channel: `create_widget` tool → SSE

The path that lets the agent create widgets without emitting a `_____react`
fence in its assistant text.

### Sequence

```
1. create_widget({name, template?, source?, format?, w?, h?, ...})
   → src/skills/builtin/canvas_widgets.ts
2. resolveEnvelope(args)
   - If template, getTemplate(id, fill) from widget_gallery
   - Else use raw source + auto-derive name
   - Apply default size, clamp w/h to [1, 12]
3. getCurrentSessionId() → src/agent/agent.ts
   - If no active session, tool returns "prepared" status (no delivery)
4. emitWidget(sessionId, envelope, 'create')
   → src/agent/widgetEmitter.ts
   - Pushes WidgetEvent onto the in-process EventEmitter
5. gateway/server.ts subscription (set up at start of stream) fires:
   safeWrite(`event: widget\ndata: ${JSON.stringify(evt)}\n\n`)
6. ChatWidget.tsx in the React SPA receives the SSE event:
   - Routes mode='create' → SpaceEngine.addWidget(spaceId, def)
   - Routes mode='update' → SpaceEngine.updateWidget(spaceId, id, patch)
   - Routes mode='remove' → SpaceEngine.removeWidget(spaceId, id)
7. window.dispatchEvent(CustomEvent('titan:space:refresh', {detail: {spaceId}}))
8. Canvas re-renders with the new widget in place
```

### Observable log markers

| Step | Log line | Component |
|---|---|---|
| Tool call | `[CanvasWidgets] create_widget "<name>" (<format>, WxH) — delivered=true` | `canvas_widgets.ts` |
| Side-channel | (no log — events are short-lived) | `widgetEmitter.ts` |
| Gateway forward | (browser dev-tools network tab shows `event: widget` frames) | `gateway/server.ts` |
| Frontend mount | console.log on error only — `[ChatWidget] widget side-channel handler failed` | `ChatWidget.tsx` |

### Integration test coverage

- **H2.6** in `pipeline-v580.test.ts` — emitter delivers to subscribers
  scoped by sessionId, emitter does NOT cross sessions, `create_widget`
  tool fires real event end-to-end through registered handler.

### Failure modes

- **No session ID set:** Tool returns a "prepared, no listener" message
  instead of throwing. Used as the signal that the user disconnected.
- **Source is empty:** Tool refuses with `Error: either "template" or
  "source" is required.`
- **Template id unknown:** Tool refuses with `Error: template "X" not
  found in the gallery.`

---

## Pipeline 5 — AGENTS.md hierarchical loader

Reads project-level instruction files and injects them into the agent's
system prompt every turn.

### Sequence

```
1. assembleSystemPrompt() in src/agent/agent.ts calls
   loadAgentsHierarchy() at the appropriate section.
2. loadAgentsHierarchy() → src/agent/agentsMdLoader.ts
   - L0: Looks for AGENTS.md in workspaceRoot
   - L1: Looks for AGENTS.md in each registered project subdir
   - Each file capped at 60 lines / 100 KB (HumanLayer guidance)
   - Aggregate capped at 32 KB
   - Returns AgentsHierarchyResult { files, aggregateBytes }
3. formatAgentsHierarchyForPrompt(result) renders a single prompt block:
   ## AGENTS.md hierarchy (L0 → L1)

   <markers>
   <file 1 content>
   </markers>

   <markers>
   <file 2 content>
   </markers>
4. The rendered block is added to the dynamicSections array.
5. applyCaps() may further trim if the aggregate exceeds budget.
```

### Observable log markers

| Step | Log line | Component |
|---|---|---|
| Files loaded | `[AgentsMdLoader] Loaded N file(s), K chars` (when any) | `agentsMdLoader.ts` |
| File truncated | `[AgentsMdLoader] Trimmed <path>: <X>→<60> lines` | `agentsMdLoader.ts` |

### Integration test coverage

- Unit tests: `tests/unit/agents-md-loader.test.ts` — 12 tests pinning
  the 60-line cap, aggregate cap, path-traversal guard, marker rendering.
- Integration: implicit via `tests/integration/pipeline-v580.test.ts`
  H2.2 (caps include `agentsMd` section).

### Failure modes

- No AGENTS.md anywhere — loader returns empty, no block in prompt.
- File too large — silently trimmed at 60 lines with a `[trimmed]` marker.
- Path traversal attempt — rejected by `safeWithinRoot()`.

---

## Pipeline 6 — Migration runner (boot-time + CLI)

Runs on every gateway boot AND when the user invokes `titan migrate`.

### Sequence

```
1. Entry: safeRunMigrations(ALL_MIGRATIONS, opts)
   → src/migrations/safeRun.ts
2. planMigrations() → which migrations are pending vs applied
3. If pending is empty: exit success, no backup needed
4. Else: createBackup() with label "pre-migration"
   - If backup fails, abort the entire run
5. runMigrations() → src/migrations/runner.ts
   - For each pending migration in id-ascending order:
     - Make MigrationContext (titanHome, helpers)
     - Run up()
     - On success: append to MIGRATION_STATE.json, persist immediately
     - On failure: return early with structured error
6. Run smoke checks (default + user-provided)
7. If any failure (migration or smoke):
   - Call each ran migration's rollback() in REVERSE order
   - Restore from pre-flight backup
8. Return SafeRunResult { success, ran, skipped, smokeChecks,
   preflightBackupPath, rolledBack, summary }
```

### Observable log markers

| Step | Log line | Component |
|---|---|---|
| Plan | `[SafeMigrationRunner] N pending migration(s): <ids>` | `safeRun.ts` |
| Backup | `[SafeMigrationRunner] Pre-flight backup: <path>` | `safeRun.ts` |
| Per-migration start | `[MigrationRunner] → <id> (<version>) <description>` | `runner.ts` |
| Per-migration done | `[MigrationRunner] ✓ <id> applied in Nms` | `runner.ts` |
| Per-migration fail | `[MigrationRunner] ✗ <id> FAILED after Nms: <error>` | `runner.ts` |
| Smoke fail | `[SafeMigrationRunner] Smoke check "<name>" FAILED: <error>` | `safeRun.ts` |
| Rollback | `[MigrationRunner] ↩ <id> rolled back` | `runner.ts` |
| Restore | `[SafeMigrationRunner] Restored from pre-flight backup: <path>` | `safeRun.ts` |

### Integration test coverage

- `tests/unit/migration-runner.test.ts` — 11 tests pinning idempotency,
  ordering, crash safety, state file structure
- `tests/unit/migration-saferun.test.ts` — 7 tests pinning the full
  safety perimeter (backup + smoke + rollback)
- `tests/unit/migration-001-005.test.ts` — 13 tests pinning each of the
  5 initial migrations + their end-to-end run

### Failure modes

- Pre-flight backup fails → migrations don't run, state unchanged
- A migration's up() throws → runner stops, rolls back applied ones,
  restores from backup
- A smoke check throws → same auto-rollback path
- The auto-rollback itself fails → manual recovery path documented in
  `docs/UPGRADING.md`

---

## Verifying a pipeline end-to-end in production

After any v5.8.x or v6.x deploy to `/opt/TITAN`:

```bash
# 1. Service is alive
ssh titan 'sudo systemctl is-active titan'

# 2. Auth works (the v5.7.2 H1 fix)
TOKEN=$(ssh titan 'cat ~/.titan/auth-tokens.json' | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['token'])")
ssh titan "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost:48420/api/health"

# 3. Migration state is fresh
ssh titan 'cat ~/.titan/MIGRATION_STATE.json | python3 -m json.tool | head -10'

# 4. Tail logs while issuing a probe that exercises pipeline 1 + 2 + 4
ssh titan 'tail -F ~/titan.log' &
ssh titan "curl -s -X POST -H 'Authorization: Bearer $TOKEN' \
    -H 'Content-Type: application/json' \
    -d '{\"content\":\"make me a clock widget\",\"sessionId\":\"smoke-$(date +%s)\"}' \
    http://localhost:48420/api/message"

# Expected log markers in order:
#   [ToolRunner] Executing tool: gallery_search
#   [ToolIntent] gallery_search = sync
#   [ToolRunner] Tool gallery_search completed in Nms
#   [ToolRunner] Executing tool: create_widget
#   [ToolIntent] create_widget = sync
#   [CanvasWidgets] create_widget "Clock" (react, ?x?) — delivered=true
#   [ToolRunner] Tool create_widget completed in Nms

# 5. Confirm the widget event landed on the SSE stream
# (open browser dev-tools → Network → click chat request → look for
# `event: widget` frames)
```

If any of those markers are missing for an operation that should produce
them, the pipeline is broken at the missing point. Refer back to this doc
to identify which module's wiring needs investigation.
