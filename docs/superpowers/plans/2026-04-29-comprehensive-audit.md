# TITAN v5.4.5 — Comprehensive Codebase Audit Report

> Generated from GitNexus knowledge graph analysis
> Date: 2026-04-29
> Commit: `7f5a6b7` (v5.4.5)

---

## Executive Summary

| Metric | Value | Risk |
|---|---|---|
| Total symbols | 29,559 | — |
| Gateway inline routes | **406** (was ~500+ before v5.4.5) | **HIGH** |
| Duplicate function names | 24× `ensureDir`, 23× `main` | **MEDIUM** |
| init/start/stop functions | 94 lifecycle functions across 37 files | **HIGH** |
| Widget compiler CDN dep | Loads Babel from unpkg.com | **CRITICAL** |
| Test-to-source ratio | 64% (248 tests / 383 source) | **MEDIUM** |
| UI/Server shared files | 10 files crossing boundary | **MEDIUM** |

---

## CRITICAL Issues

### C1: Widget Compiler Loads Remote Babel CDN

**File:** `ui/src/space-agent/widgetCompiler.ts:12`
**Code:**
```typescript
script.src = 'https://unpkg.com/@babel/standalone@7.26.0/babel.min.js';
```

**Problem:** The `SandboxRuntime.ts` (lines 26-28) already loads React, ReactDOM, and Babel from **local paths** (`/react.development.js`, `/react-dom.development.js`, `/babel.min.js`). But the separate `widgetCompiler.ts` for the space-agent canvas loads Babel from a **third-party CDN**.

**Impact:**
- Offline/air-gapped deployments break completely
- Supply chain attack vector (unpkg.com compromise)
- Version drift (unpkg may serve a different patch than the self-hosted file)
- DNS/routing failure in restricted networks

**Fix:** Change to `script.src = '/babel.min.js';` to match the sandbox.

---

### C2: Gateway Still Monolithic (406 Inline Routes)

After extracting 4 sub-routers in v5.4.5, `src/gateway/server.ts` still contains **406 inline route handlers**. The largest remaining blocks:

| Route Prefix | Count | Status |
|---|---|---|
| `/api/command-post/*` | 64 | **NOT EXTRACTED** |
| `/api/voice/*` | 17 | NOT EXTRACTED |
| `/api/sessions/*` | 16 | NOT EXTRACTED |
| `/api/teams/*` | 14 | NOT EXTRACTED |
| `/api/files/*` | 12 | NOT EXTRACTED |
| `/api/goals/*` | 10 | NOT EXTRACTED |
| `/api/organism/*` | 9 | NOT EXTRACTED |
| `/api/mesh/*` | 9 | NOT EXTRACTED |
| `/api/drivers/*` | 9 | NOT EXTRACTED |
| `/api/tests/*` | 8 | NOT EXTRACTED |
| `/api/recipes/*` | 8 | NOT EXTRACTED |
| ... | ... | ... |

**Problem:** `startGateway()` is a 9,623-line function. It handles HTTP routes, WebSocket upgrades, auth, rate limiting, proxying, static serving, health checks, LLM request throttling, and shutdown — all in one file. This is the single biggest architectural risk in TITAN.

**Impact:**
- Any bug in one route can crash the entire gateway
- Impossible to unit test individual route groups
- No route-level middleware isolation
- Code review is impractical (10,000+ lines)

**Fix Priority:** 
1. Extract `/api/command-post/*` (64 routes) — highest impact
2. Extract `/api/voice/*` and `/api/sessions/*`
3. Extract static/admin routes

---

### C3: No Unified Lifecycle Manager (94 Lifecycle Functions)

45 `init*` functions across 37 files:
```
initPool, initWakeupSystem, initAlerts, initAuditStore, initChecklist,
initAutopilot, initCommandPost, initDaemon, initHeartbeatScheduler,
initMonitors, initAgents, initBudget, initShadowRepo, initSoulState,
initOtel, initSlashCommands, initMcpServers, initGraph, initIdentity,
initLearning, initMemory, initVectors, initPlugins, initProviders,
initVault, initCronScheduler, initFileWatchers, initPopulation,
initModelSwitchTool, initPromptFiles, initBenchmarks, initProviders,
initWebBrowserTool, initPersistentWebhooks, initDevSkills, initNvidiaSkills,
initBuiltinSkills, initFileLogger, initVRAMOrchestrator, initWebGL,
initBuffers, initShaders, init, initSession
```

49 start/stop function pairs but no central registry:
```
startGateway ↔ stopGateway
startPaperclip ↔ stopPaperclip
startAutopilot ↔ stopAutopilot
startDaemon ↔ stopDaemon
startBridge ↔ stopBridge
startF5TTSHandler ↔ stopF5TTSHandler
startMonitor ↔ stopMonitor
startTunnel ↔ stopTunnel
startHeartbeat ↔ stopHeartbeat
startDiscovery ↔ stopDiscovery
...
```

**Problem:** `gracefulShutdown()` in `server.ts` closes the HTTP server and cleans intervals, but it does NOT:
- Stop the F5-TTS Python server (leaked process)
- Stop Paperclip sidecar (leaked child process)
- Stop mesh transport heartbeats (hanging WebSockets)
- Flush pending analytics events to PostHog
- Unload GPU VRAM leases
- Terminate the `TitanAgentBridge` Python process (new in v5.4.5)

**Impact:** Restarting TITAN on Titan PC with `pkill -f 'node dist/cli/index.js gateway'` leaves 3-5 zombie Python processes per restart. Over days this exhausts RAM.

**Fix:** Create a `LifecycleManager` that registers all startables and shuts them down in reverse dependency order.

---

## HIGH Issues

### H1: Duplicate Function Names Break Traces

| Function | Count | Files |
|---|---|---|
| `ensureDir` | 24 | utils, memory, testing, safety, skills |
| `main` | 23 | scripts, tests, examples, server |
| `timeSince` | 20 | utils, ui, gateway |
| `load` | 16 | storage, config, memory, examples |
| `handler` | 14 | channels, gateway, mcp |
| `timeAgo` | 11 | ui, gateway |
| `register` | 10 | skills, channels, agent |
| `handleDelete` | 9 | ui, gateway |
| `makeConfig` | 8 | config, testing |
| `__init__` | 8 | python voice files |

**Problem:** GitNexus Process traces use function names as step labels. When 24 functions are all named `ensureDir`, the trace is `init → ensureDir → ensureDir → ensureDir` — useless for debugging. Impact analysis also fails because it can't determine WHICH `ensureDir` is being called.

**Fix:** 
- Rename utility `ensureDir` to `mkdirIfNotExists`
- Rename script `main` to descriptive names (`runStressTest`, `startF5TTSServer`)
- Add `--name` uniqueness check to GitNexus analyzer

---

### H2: UI/Server Boundary Violations

Files imported by both frontend UI and backend server:

| File | Imported By Server? | Imported By UI? | Risk |
|---|---|---|---|
| `ui/src/space-agent/widgetCompiler.ts` | **YES** (types path) | YES | `document` API in node build |
| `ui/src/space-agent/useCanvasSSE.ts` | **YES** (types path) | YES | Hooks in server bundle |
| `ui/src/titan2/types.ts` | **YES** (gateway server) | YES | UI types leaked to server |

**Problem:** `server.ts` imports `../agent/company.js` but the graph shows it also pulls in UI-side modules through shared type paths. This bloats the server bundle and can cause runtime crashes when UI-only APIs (like `document`) are called server-side.

**Fix:** Create a `shared/types.ts` file for server-safe types only. Move UI-only types back to `ui/src/`.

---

### H3: Test Suite Unreliable at Scale

| Metric | Value |
|---|---|
| Test files | 248 |
| Total test lines | 88,289 |
| Source files | 383 |
| Test-to-source ratio | 64% |
| Tests excluded in CI | 1 (agent.test.ts — OOMs at >7GB) |
| Vitest heap (local) | 12 GB |
| Vitest heap (CI) | 4 GB |

**Problem:** The full suite times out or OOMs on CI. The workaround is to exclude heavy tests, which means CI doesn't actually test the full module graph. This creates a blind spot where refactoring `src/agent/agent.js` or `src/agent/agentLoop.ts` can break production without CI catching it.

**Fix:** 
- Split `agent.test.ts` into unit tests (no module graph reload) and integration tests (mock providers)
- Add shard count detection: if CI runner has <8GB RAM, skip heavy tests automatically
- Run heavy tests nightly instead of per-PR

---

## MEDIUM Issues

### M1: Gateway Route Count Still Growing

Before v5.4.5: ~500 inline routes
After v5.4.5: **406 inline routes** (only 94 extracted)

At the current pace (~4 routes extracted per release), it'll take 100+ releases to fully decompose the gateway. The `command-post` block (64 routes) alone should be a priority — it's larger than the entire extracted paperclip router.

### M2: Voice Bridge Process Leak Risk

The new `TitanAgentBridge` in v5.4.5 spawns a Python child process but:
- No process timeout (30s only for audio processing)
- No automatic cleanup on parent crash
- No PID tracking file
- Python process is not in `gracefulShutdown()`

If the Node gateway crashes, the Python voice agent becomes an orphan. Over time, these accumulate and cause the "Vitest OOM" symptom in production (not just tests).

### M3: Gateway Has 9,623 Lines in Single Function

`startGateway()` is the longest function in the graph:
```
Function: startGateway | src/gateway/server.ts | LOC: 9623
```

This is 15× longer than the second-longest function (`getMissionControlHTML` at 3,286 lines). No single function should exceed 500 lines — the cognitive load for maintainers is too high.

### M4: Caddyfile Has Hardcoded Configs

`Caddyfile` in repo root uses hardcoded port `:48420` and auth tokens. If TITAN needs to run on a different port or domain, this file must be manually edited and isn't templated.

---

## Recommended Fix Order

Based on blast radius, user impact, and GitNexus traceability:

| Priority | Issue | Effort | Impact |
|---|---|---|---|
| P0 | C1: Fix widgetCompiler.ts CDN → `/babel.min.js` | 1 line | **CRITICAL** — offline deployments break |
| P0 | C3: Add LifecycleManager for shutdown | 1 file | **CRITICAL** — zombie processes on Titan PC |
| P1 | C2: Extract `/api/command-post/*` (64 routes) | 200 lines | **HIGH** — largest route block |
| P1 | H1: Rename duplicate `ensureDir`/`main` | 50 files | **HIGH** — fixes GitNexus traces |
| P2 | H2: Separate UI/server types | 5 files | **MEDIUM** — prevents node/browser API leaks |
| P2 | M2: Add Python child process cleanup | 20 lines | **MEDIUM** — prevents memory leaks |
| P3 | H3: Split agent.test.ts into unit + integration | 1 file | **MEDIUM** — enables CI coverage |
| P3 | C2: Extract voice/sessions/teams routers | 3 files | **LOW** — already have pattern from paperclip |

---

## Appendix: Useful GitNexus Queries for Ongoing Monitoring

```bash
# Monitor gateway route count (should decrease over releases)
npm run gitnexus:cypher "MATCH (r:Route) RETURN COUNT(r)"

# Monitor function growth (should stay flat or decrease)
npm run gitnexus:cypher "MATCH (f:Function) RETURN COUNT(f)"

# Find new lifecycle functions added without cleanup
npm run gitnexus:cypher "MATCH (f:Function) WHERE f.name STARTS WITH 'start' AND NOT EXISTS { (f2:Function {name: REPLACE(f.name,'start','stop')}) } RETURN f.name, f.filePath"

# Find files crossing UI/server boundary
npm run gitnexus:cypher "MATCH (f:File) WHERE f.filePath CONTAINS 'ui/src/' AND EXISTS { (f2:File)-[:{type:'IMPORTS'}]->(f) WHERE f2.filePath CONTAINS 'src/' AND NOT f2.filePath CONTAINS 'ui/' } RETURN f.name, f.filePath"
```

---

*Report generated by OpenCode using GitNexus knowledge graph (29,559 symbols, 50,352 edges, v5.4.5)*
