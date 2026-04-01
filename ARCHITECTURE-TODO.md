# TITAN Architecture TODO — Multi-Agent & Cloud Model Fixes

**Date**: April 1, 2026 | **Version**: v2026.10.69
**Author**: Claude Code (Principal Engineer audit)

---

## Current State

TITAN is solid for single-tool tasks (2-5s), voice, dashboard, Command Post. But multi-round tool tasks, sub-agent delegation, and inter-agent communication have architectural limitations that quick fixes can't solve.

### What Works (Verified)
- Chat with tool calling: write_file, shell, memory, goal_create, web_search (2-5s each)
- Voice: F5-TTS cloning, LiveKit, streaming (3s)
- All 26 dashboard panels functional
- Command Post: issues, approvals, budgets, org chart, activity feed, console
- Agent spawn/stop/route to specific agents (5 max)
- 124/124 smoke tests, 4,430/4,430 vitest tests
- Graceful shutdown (3s timeout + closeAllConnections)
- Voice poison guard auto-resets stale sessions
- Cloud model benchmark: qwen3-coder-next:cloud is best (0.3s, perfect tool_choice)

### What Needs Architecture Work

---

## Problem 1: Cloud Model Tool Looping

**Symptom**: Cloud models (qwen3-coder-next, nemotron) call tools in endless loops instead of stopping and responding after getting results.

**Root Cause**: Cloud models don't respect `tool_choice: required` consistently. They also don't naturally "stop" after tool results — they keep calling more tools. TITAN's agent loop runs up to `maxToolRoundsHard` (10) rounds, and cloud models fill every round.

**Current Mitigations** (partial):
- Forced summarization at round 5 for cloud models
- CloudRetry nudge on round 0
- ToolRescue for text-based tool calls
- Stall detector with nudge messages
- Loop detector (ping-pong, repeated calls)

**Proper Fix — OpenClaw Pattern**: Separate "think" and "act" phases:

```
Phase 1 (THINK): LLM receives user message + tools list
  → LLM returns EITHER content OR tool_calls (never both in a loop)
  → If tool_calls: execute tools, add results to context
  → Go to Phase 2

Phase 2 (RESPOND): LLM receives tool results + explicit "now respond" instruction
  → Tools are REMOVED from the request (no tool definitions sent)
  → LLM can ONLY generate text content
  → This is the final response
```

This eliminates looping because the LLM physically can't call tools in Phase 2.

**Implementation**:
- In `agent.ts` `runAgentLoop`, after tool execution round, remove `tools` from the next LLM call
- Only re-add tools if the response indicates more work is needed (deliberation)
- This is a 20-line change in the agent loop

**Reference**: OpenClaw `src/agents/pi-embedded-subscribe.handlers.tools.ts` — tool execution is event-driven, not loop-driven.

---

## Problem 2: Synchronous Sub-Agent Execution

**Symptom**: `spawn_agent` blocks the parent agent for 30-60s while the sub-agent runs. Parent can't respond until sub-agent finishes.

**Root Cause**: `spawnSubAgent()` is `await`-ed synchronously. The sub-agent runs its own agent loop (3-5 rounds × 2-5s each = 15-30s), and the parent waits for the entire duration.

**Proper Fix — Paperclip Heartbeat Pattern**:

```
1. Parent calls spawn_agent → creates a TASK in Command Post (not an inline call)
2. Task gets assigned to a worker agent
3. Worker agent processes the task asynchronously (via heartbeat/wakeup)
4. Parent gets immediate response: "Task TIT-42 assigned to Research Worker"
5. Worker completes task, updates Command Post issue status
6. Parent is notified via SSE/webhook when task is done
7. User sees real-time progress in Command Post dashboard
```

**Implementation**:
- Modify `spawn_agent` tool to create a Command Post issue instead of running inline
- Add `agent_wakeup` mechanism: when an issue is assigned, wake the target agent
- Agent wakeup triggers `processMessage()` with the issue context
- Results written back to the issue as comments
- Parent gets the issue ID immediately, can poll or get SSE updates

**Reference**: Paperclip `agent_wakeup_requests` table + heartbeat scheduler

---

## Problem 3: Inter-Agent Communication

**Symptom**: CEO agent can't delegate tasks to worker agents. No agent-to-agent message routing.

**Root Cause**: TITAN agents are isolated — they share no message bus. The only way to route a message to a specific agent is via the HTTP API with `agentId` parameter, which is a user-facing API, not an inter-agent protocol.

**Proper Fix — Paperclip Task Assignment**:

```
CEO creates an issue:
  POST /api/command-post/issues
  { title: "Research competitors", assigneeAgentId: "worker-1" }

System wakes worker-1:
  → Checks inbox (GET /api/agents/me/inbox)
  → Sees assigned issue
  → Checks out issue (POST /api/command-post/issues/:id/checkout)
  → Works on it (calls tools)
  → Posts comment with results
  → Marks done (PATCH /api/command-post/issues/:id { status: "done" })

CEO checks results:
  → Reads issue comments
  → Synthesizes into final response
```

**Implementation**:
- Add `agent_inbox` concept: issues assigned to an agent
- Add `wakeup_agent(agentId, reason, context)` function
- Modify `processMessage()` to check inbox on entry
- Add `delegate_task` tool that creates issue + wakes target agent
- Wire into Command Post activity feed for real-time tracking

**Reference**: Paperclip `GET /api/agents/me/inbox-lite`, heartbeat trigger system

---

## Problem 4: Session Concurrency

**Symptom**: Ollama cloud API processes requests sequentially. When one request is running, others queue behind it.

**Root Cause**: Ollama's cloud model proxy is single-connection. TITAN sends requests to `localhost:11434` which proxies to the cloud — but only one at a time.

**Proper Fix**:
- For cloud models, bypass Ollama and call the cloud API directly
- Or use multiple Ollama instances (not practical)
- Or accept sequential processing and optimize round count (current approach)

**Pragmatic Approach**: Keep Ollama for local models, add direct cloud provider support for the top models (qwen3-coder-next already has an API at api.qwen.ai or via OpenRouter).

---

## Problem 5: Claude Code / Codex Integration (Paperclip-style)

**Goal**: Allow TITAN to orchestrate external agents like Claude Code, Codex, Cursor — just like Paperclip does.

**Paperclip Pattern**: Agents are external processes that receive "heartbeats" (environment variables) and call back to Paperclip's API:

```bash
# Paperclip injects these env vars when spawning an external agent:
PAPERCLIP_API_URL=http://localhost:3100
PAPERCLIP_API_KEY=jwt-token
PAPERCLIP_AGENT_ID=uuid
PAPERCLIP_TASK_ID=uuid
PAPERCLIP_RUN_ID=uuid
```

The external agent (Claude Code, Codex, etc.) reads these env vars, calls `GET /api/agents/me/inbox` to get tasks, works on them, and reports back via `PATCH /api/issues/:id`.

**Implementation for TITAN**:
- Add adapter system: `claude-code`, `codex`, `cursor`, `bash`, `http`
- Each adapter knows how to spawn the external process with TITAN env vars
- External process calls TITAN's Command Post API to get/update tasks
- TITAN monitors the process, collects output, tracks costs

**Reference**: Paperclip `packages/adapters/claude-local/`, `packages/adapters/codex-local/`

---

## Implementation Priority

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 1 | **Think/Act phase separation** (Problem 1) | Small (20 lines) | Eliminates cloud model looping |
| 2 | **Async sub-agent via Command Post** (Problem 2) | Medium (200 lines) | Sub-agents don't block parent |
| 3 | **Agent inbox + wakeup** (Problem 3) | Medium (150 lines) | CEO → Worker delegation |
| 4 | **External agent adapters** (Problem 5) | Large (500+ lines) | Claude Code/Codex integration |
| 5 | **Direct cloud API** (Problem 4) | Large (per provider) | Parallel cloud requests |

**Recommended order**: 1 → 2 → 3 → 4

Fix #1 (think/act) is the highest impact per line of code. It will make all cloud model interactions reliable — not just sub-agents but regular chat too. Everything else builds on top of reliable tool calling.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/agent/agent.ts` | Think/act phase separation in `runAgentLoop` |
| `src/agent/subAgent.ts` | Async execution via Command Post issues |
| `src/agent/commandPost.ts` | Agent inbox, wakeup mechanism |
| `src/gateway/server.ts` | Wakeup API endpoint, inbox endpoint |
| `ui/src/components/admin/CommandPostHub.tsx` | Show delegated tasks, wakeup status |

---

## Reference Repos

- **Paperclip**: `~/Desktop/paperclip-reference/` — agent orchestration, heartbeats, task checkout
- **OpenClaw**: `~/Desktop/openclaw-reference/` — tool calling, model fallback, session management
- **Claude Code**: `https://github.com/yasasbanukaofficial/claude-code` — Claude Code integration patterns

---

*This document should be read at the start of the next session to continue work.*
