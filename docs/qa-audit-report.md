# TITAN QA Audit Report

**Date**: 2026-03-16
**Auditor**: QA Architect (Claude Opus 4.6)
**Scope**: Agent Core, Provider Router, Gateway, Config, Skills Registry
**Test Status**: All 4,188 tests passing (133 files, 12.79s)

---

## Critical Issues

### 1. Daemon SSE Stream: `removeAllListeners` Nukes All Listeners

**File**: `src/gateway/server.ts`, line 1803
**Description**: When a single SSE client disconnects from `/api/daemon/stream`, the cleanup calls `titanEvents.removeAllListeners(evt)` for each event. This removes **all** listeners on those events -- including listeners registered by other connected SSE clients and internal system listeners. If two browser tabs are open, closing one kills the event feed for the other.
**Severity**: Critical
**Suggested fix**: Store the specific `onEvent` callback reference per-client and use `titanEvents.removeListener(evt, onEvent)` (or `titanEvents.off(evt, onEvent)`) instead of `removeAllListeners`.

### 2. YAML Skill Sandbox Allows `child_process` Import

**File**: `src/skills/registry.ts`, lines 524-527
**Description**: The YAML skill VM sandbox exposes a `safeRequire` function that allows importing `child_process`. A user-supplied YAML skill in `~/.titan/skills/` can execute arbitrary shell commands with no sandboxing. Combined with the `Buffer`, `setTimeout`, and `Promise` globals in the sandbox context (line 546), this creates a complete sandbox escape. The `vm.runInNewContext` with a 10-second timeout is the only constraint.
**Severity**: Critical
**Suggested fix**: Remove `child_process` from the allowed modules list. If shell execution is needed, YAML skills should use the `shell` tool (which goes through autonomy gates) instead of raw `child_process`.

---

## High Severity Issues

### 3. No JSON Body Size Limit on Express

**File**: `src/gateway/server.ts`, line 425
**Description**: `app.use(express.json())` is called without a `limit` option. Express defaults to 100KB, but an attacker can send large JSON payloads to endpoints like `/api/message` to consume memory. While Express has a default, it should be explicitly set for defense-in-depth, especially since `/api/message` content can legitimately be long.
**Severity**: High
**Suggested fix**: `app.use(express.json({ limit: '1mb' }))` -- explicit and reasonable for chat content.

### 4. Agent Loop Message Array Grows Unbounded Within a Request

**File**: `src/agent/agent.ts`, lines 651-1149
**Description**: The `messages` array inside `processMessage()` grows with every round: user injections (wrap-up prompts, nudges, pivot context, system messages), assistant responses, and tool results all push into it. With `maxToolRoundsHard` at 50 and autonomous mode allowing up to 75 rounds (`25 * 1.5`), this array can accumulate hundreds of messages. While `maybeCompressContext` exists (line 864), it only fires conditionally and the compression heuristic may not fire on every round. The context window estimation at line 874 (`maxTokens * 4`) is also very rough.
**Severity**: High
**Suggested fix**: Add a hard cap on `messages.length` (e.g., 200 entries) with aggressive pruning of oldest tool results. The context window estimate should use actual model context limits rather than `maxTokens * 4`.

### 5. `/api/chat/stream` Has No Client Disconnect Detection

**File**: `src/gateway/server.ts`, lines 1038-1063
**Description**: Unlike `/api/message` (which tracks `clientDisconnected` via `req.on('close')`), the `/api/chat/stream` endpoint has no disconnect detection. If a client disconnects mid-stream, the server continues writing to a dead socket until the generator completes. This wastes LLM tokens and keeps the connection open.
**Severity**: High
**Suggested fix**: Add `req.on('close', ...)` tracking and check `clientDisconnected` before each `res.write()`, matching the pattern already used in `/api/message`.

### 6. Config Hot Reload Partially Stale Due to Aggressive Caching

**File**: `src/config/config.ts`, lines 21-53; `src/agent/agent.ts`, lines 243-251
**Description**: `loadConfig()` caches the config in a module-level variable and only reloads on first call. `updateConfig()` correctly invalidates the cache by calling `saveConfig()` (which sets `cachedConfig`). However, prompt files are cached at module level in `cachedPromptFiles` (agent.ts line 243) with no invalidation mechanism. If `AGENTS.md`, `SOUL.md`, or `TOOLS.md` change while the process is running, the changes are never picked up. This is by design ("files are stable for the process lifetime") but surprising when combined with hot-reloading model/config.
**Severity**: High
**Suggested fix**: Either document this limitation clearly, or add a `resetPromptFileCache()` function callable from the config update path.

---

## Medium Severity Issues

### 7. Provider Failover Performs Health Checks Sequentially During Request

**File**: `src/providers/router.ts`, lines 337-361
**Description**: When the primary provider fails and the fallback chain is exhausted, the router iterates through `failoverOrder` calling `healthCheck()` and `listModels()` on each provider **sequentially**. Each health check is a network call (especially Ollama). In the worst case (all providers failing), this adds 4 sequential network timeouts to the user's request latency.
**Severity**: Medium
**Suggested fix**: Run health checks in parallel with `Promise.allSettled`, or maintain a cached health state that's refreshed periodically (the `healthCheckAll()` function already exists but isn't used here).

### 8. Tool Registry Allows Silent Overwrites

**File**: `src/agent/toolRunner.ts`, line 68-71
**Description**: `registerTool()` silently overwrites any existing tool with the same name. A test confirms this behavior ("registering same tool name overwrites previous"). While `loadAutoSkills()` in the skills registry checks for duplicates before calling `registerSkill`, the lower-level `registerTool()` does not. If a marketplace skill or personal skill registers a tool with the same name as a builtin (e.g., `shell`), it silently replaces the builtin with no warning.
**Severity**: Medium
**Suggested fix**: Log a warning when overwriting an existing tool, and consider rejecting overwrites from non-builtin sources unless explicitly opted in.

### 9. SubAgent `activeSubAgents` Counter Can Leak on Unhandled Rejection

**File**: `src/agent/subAgent.ts`, lines 358, 477-479
**Description**: The `activeSubAgents` counter is incremented at line 358 and decremented in the `finally` block at line 477. This is correct for errors within the try/catch. However, if `loadConfig()` (line 324) or `getToolDefinitions()` (line 382) throws before the try block, the counter is already incremented but the `finally` block never runs, leaving the counter permanently inflated. Eventually this would block all sub-agent spawning.
**Severity**: Medium
**Suggested fix**: Move the `activeSubAgents++` inside the try block, or restructure so the increment happens just before the loop.

### 10. Rate Limiter Uses `req.ip` Which May Be Spoofable

**File**: `src/gateway/server.ts`, lines 390-406
**Description**: The rate limiter keys on `req.ip || req.socket?.remoteAddress || 'unknown'`. Behind a reverse proxy (common in production), `req.ip` reflects the `X-Forwarded-For` header, which clients can spoof. Express does not trust proxies by default (`app.set('trust proxy', ...)` is not called), so `req.ip` falls back to `req.socket.remoteAddress`. However, if someone later adds `trust proxy`, the rate limiter becomes bypassable.
**Severity**: Medium
**Suggested fix**: Either explicitly set `app.set('trust proxy', false)` to document the intent, or use `req.socket.remoteAddress` directly for rate limiting.

### 11. Orchestrator Task Index Mismatch in Synthesis

**File**: `src/agent/orchestrator.ts`, lines 184-188
**Description**: The synthesis loop uses `results.map((r, i)` and accesses `plan.tasks[i]`. But `results` is populated by pushing independent results first, then dependent results. The index `i` in `results` does not correspond to index `i` in `plan.tasks` when there's a mix of independent and dependent tasks. For example, if tasks are [independent-0, dependent-1, independent-2], results will be [result-0, result-2, result-1] (independent first, then dependent), but the synthesis maps result[0] -> task[0], result[1] -> task[1], result[2] -> task[2], misattributing results.
**Severity**: Medium
**Suggested fix**: Use `taskResults` map (which correctly maps by original index) for synthesis instead of the `results` array.

### 12. `safeCompare` Leaks Length Information

**File**: `src/gateway/server.ts`, lines 143-146
**Description**: The `safeCompare` function returns `false` early when string lengths differ (line 144), before calling `timingSafeEqual`. This leaks the length of the secret token through timing, allowing an attacker to determine the token length. While `timingSafeEqual` requires equal-length buffers, the standard mitigation is to hash both inputs first (e.g., with HMAC-SHA256) before comparing.
**Severity**: Medium
**Suggested fix**: Hash both strings with `crypto.createHmac('sha256', 'constant-key').update(a).digest()` before comparing, eliminating the length check entirely.

---

## Low Severity Issues

### 13. Module-Level `setInterval` Runs Before `startGateway`

**File**: `src/gateway/server.ts`, lines 126-130
**Description**: The orphaned abort controller cleanup interval is created at module load time (line 126), before `startGateway()` is called. If the module is imported but the gateway is never started (e.g., in CLI mode or tests), this interval runs unnecessarily. It has `.unref()` so it won't prevent exit, but it's still executing cleanup logic against an empty `sessionAborts` map.
**Severity**: Low
**Suggested fix**: Move this interval inside `startGateway()` and register it for cleanup in `stopGateway()`.

### 14. Cost Optimizer Context Window Estimate Is Rough

**File**: `src/agent/agent.ts`, line 874
**Description**: `const tokenBudget = (config.agent.maxTokens || 4096) * 4` is used as a "rough context window estimate." `maxTokens` is the **output** token limit, not the context window. Multiplying by 4 is an arbitrary heuristic that doesn't correspond to any model's actual context window. For Claude 3.5 Sonnet (200K context), this would estimate 16K tokens. For GPT-4o-mini (128K context), same 16K. Both wildly underestimate.
**Severity**: Low
**Suggested fix**: Use a model-aware context window lookup table, or at minimum use a more generous estimate (e.g., 32K or 64K default).

### 15. Prompt File Cache Never Invalidated

**File**: `src/agent/agent.ts`, lines 243-251
**Description**: `cachedPromptFiles` is a `Map` that caches file reads forever. Comment says "files are stable for the process lifetime." In practice, if a user edits `AGENTS.md` while the gateway is running, they must restart the gateway to pick up changes. No warning is logged.
**Severity**: Low
**Suggested fix**: Add a TTL (e.g., 5 minutes) or a stat-based invalidation check.

### 16. Fallback Chain Skips Non-Retryable Errors

**File**: `src/providers/router.ts`, lines 311-318
**Description**: The fallback chain is only tried when `isRetryableError(error)` is true. If the primary provider returns a non-retryable error (e.g., `400 Bad Request` for an unsupported feature like tool calling on an old model), the fallback chain is skipped entirely, and the code falls through to the provider-level failover which picks a random model. This means the user's carefully configured fallback chain is bypassed for certain error classes.
**Severity**: Low
**Suggested fix**: Consider trying the fallback chain for all errors, not just retryable ones. The chain represents the user's explicit preference for which models to try.

### 17. Skills Registry `loadDisabledSkills()` Reads Disk on Every Call

**File**: `src/skills/registry.ts`, lines 120-129
**Description**: `loadDisabledSkills()` reads and parses `disabled-skills.json` from disk every time it's called. It's called from `getSkills()`, `isSkillEnabled()`, `isToolSkillEnabled()`, and `toggleSkill()`. `isToolSkillEnabled` is called during `getToolDefinitions()`, which runs on **every agent round**. With 50 rounds max and ~149 tools to filter, that's up to 7,450 file reads per request.
**Severity**: Low (file is small, OS caches it)
**Suggested fix**: Cache the disabled skills list in memory and invalidate on `saveDisabledSkills()`.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High | 4 |
| Medium | 6 |
| Low | 5 |
| **Total** | **17** |

### Top 3 Recommendations

1. **Fix the daemon SSE listener leak** (Issue #1) -- this is a live bug that causes event feed loss for concurrent dashboard users.
2. **Remove `child_process` from YAML skill sandbox** (Issue #2) -- this is a security hole that allows arbitrary code execution from user-supplied skills.
3. **Add client disconnect detection to `/api/chat/stream`** (Issue #5) -- this wastes LLM API credits when clients disconnect mid-stream.
