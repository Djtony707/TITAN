# CLAUDE.md — TITAN Project Guide

> This file is read automatically by Claude Code. It contains everything needed to understand, build, test, and contribute to TITAN.

## Current Live Status — 2026-04-25 — v5.0.0 "Spacewalk" STAGED FOR RELEASE

- **Local HEAD:** `bf57cf7c v5.0.0 — Spacewalk: full release` (Mac authoring checkout)
- **Local tag:** `v5.0.0`
- **Stats:** 450 files changed, +69,846 / −18,147 lines
- **`origin/main` is at:** `1c04ca71 v4.13.0` — 11 commits behind local
- **Release commit not yet pushed.** Tony pushes from Titan PC, not this Mac.

Full release report: `docs/HANDOFF-2026-04-25.md`. Release-day breakdown: `AGENTS.md`.

### Standing rules (Tony, do not violate)

- **TITAN runtime must never call Claude Code or shell to the `claude` CLI.** Local Claude Code notes/docs in `~/.claude/` are fine; runtime adapters / providers / fallbacks are not.
- **Push to GitHub and npm from Titan PC, not from this Mac.** The Mac is the authoring host; Titan PC has the npm + GitHub credentials and is the publishing host.
- **`/opt/TITAN` on Titan PC is the running service**, not the publish source. For npm releases, fresh-clone into `~/titan-publish` on Titan PC and publish from there. `/opt/TITAN` carries Soma self-mod drift that must not ship.
- **Mini PC (Node 18) cannot build Tailwind 4.** Always build `ui/dist/` on Mac or Titan PC.
- **Always explain WHY** when announcing fixes to Kimi (WHAT / WHY this approach / TRADE-OFF / FOLLOW-UP).
- **Always have Kimi double-check** Claude's work before deploy. Vice versa when Kimi authors.

### Release commands (Titan PC)

```bash
ssh titan
cd ~/titan-publish || git clone https://github.com/Djtony707/TITAN ~/titan-publish
cd ~/titan-publish
git fetch --tags && git checkout v5.0.0
npm install && npm run build && npm run build:ui
git push origin main
git push origin v5.0.0
npm publish --tag next   # @next first per CHANGELOG; promote to @latest after ~1 week
```

If the v5.0 commit isn't on Titan PC yet, rsync from Mac first (exclude `node_modules`, `dist`, `ui/dist`, `server/`, `space-app/`, `space-pages/`, `packages/`).

### What's in v5.0

1. **Widget gallery** — 110 production templates + gallery-first chat agent (`gallery_search` always called first; `gallery_get` fills `REPLACE_WITH_X` / `{{X}}` placeholders with backslash + single-quote + backtick escaping).
2. **Self-awareness layer** — companyPortability, conflictResolver, peerAdvise, runContinuations, subdirHints, trajectory; identity / self-model / experiments / workingMemory / provenance fully wired.
3. **Multi-agent prompt threading** — `systemPromptAppendix` carries live canvas context every turn.
4. **Observability** — PostHog telemetry with bucketed system fingerprint, `/api/bug-reports` endpoints, `~/.titan/bug-reports.jsonl` capture (5 MB rotation, 250 ms burst guard).
5. **F5-TTS voice** replaces Orpheus.
6. **Agent-bus IPC** at `~/.local/bin/agent-bus` for Claude ↔ Kimi co-working.
7. **Hardening** — PII redaction, 5-layer secret scanner, pre-execution scanner, shell lifecycle hooks.

### Excluded from the v5.0 commit (intentional)

`server/`, `space-app/`, `space-pages/`, `packages/`, `pnpm-workspace.yaml`, root scratch (`babel.standalone.min.js`, `debug_template.cjs`, `find_escapes.cjs`).

### Open items (post-v5.0)

- `titan.api.call` proxy bug in canvas widgets (Stock Analyzer "Analyze" returns "No response."; backend works via curl).
- Pomodoro UI generation 90s+ hang while direct curl produces in 33s — SSE timing suspected.
- Vitest worker OOM flake on full suite; tests pass individually.

### Cleared from prior audit

- ✅ `package.json` synced to 5.0.0.
- ✅ `agentScope.ts` wired into runtime (was dead code).
- ✅ Persona token bloat capped at 4 KB with section-aware truncation; override via `TITAN_PERSONA_CAP` env. Full content via `get_persona` tool.
- ✅ Stale top-level files (`src/server.ts`, `src/schema.ts`, etc.) cleaned.
- ✅ Self-awareness modules restored.
- ✅ PostHog telemetry implemented.

## What is TITAN?

**TITAN (The Intelligent Task Automation Network)** is a premium, autonomous AI agent framework built in TypeScript. It's published as `titan-agent` on npm with 25,000+ installs. Created by Tony Elliott.

- **Current version**: v5.0.0 "Spacewalk" (semantic versioning — NOT 2026.10.XX). Note: `package.json` still reads `4.12.0` — needs sync.
- **License**: MIT
- **Repo**: https://github.com/Djtony707/TITAN
- **Runtime**: Node.js >= 22, pure ESM

## Quick Reference

| Stat | Value |
|------|-------|
| Providers | 36 (4 native + 32 OpenAI-compatible) |
| Skills | 143 loaded |
| Tools | 248 across 143 loaded skills |
| Channels | 16 (Discord, Telegram, Slack, WhatsApp, Matrix, IRC, Line, Zulip, etc.) |
| Soma | Homeostatic drive layer (v4.0+, opt-in via `organism.enabled`) |
| Tests | 5,840+ across 211 files (vitest) |
| Default model | `ollama/qwen3.5:cloud` (Ollama cloud-first) |
| Gateway port | 48420 |

## Project Structure

```
src/
├── agent/        # Agent core, reflection, sub-agents, orchestrator, goals, initiative, Command Post
├── browsing/     # Shared browser pool (Playwright), CAPTCHA solver (CapSolver)
├── channels/     # 16 channel adapters
├── config/       # Zod-validated config schema
├── context/      # ContextEngine plugin system
├── gateway/      # Express HTTP/WS server + Mission Control v2 (React SPA)
├── mcp/          # MCP Server (JSON-RPC 2.0, stdio + HTTP)
├── memory/       # Memory, learning, graph, relationship, briefings
├── mesh/         # P2P mesh networking (mDNS, WebSocket, HMAC)
├── organism/     # TITAN-Soma: homeostatic drives, pressure loop, hormonal broadcasts, shadow rehearsal (v4.0+)
├── providers/    # LLM provider router + 36 providers
├── skills/       # Builtin skills (143 loaded, 248 tools) + dev + NVIDIA skills
├── utils/        # Constants, helpers, hardware detection
├── voice/        # LiveKit WebRTC voice integration
└── vram/         # VRAM orchestrator (GPU memory management, model swap, leases)
ui/               # React 19 SPA (Vite + Tailwind CSS 4 + React Router v7)
tests/            # 154 vitest test files
e2e/              # Playwright E2E tests (135+ tests, 7 spec files)
```

## Build & Run

```bash
# Install
npm install

# Development (runs from source via tsx)
npm run dev              # CLI
npm run dev:gateway      # Gateway + Mission Control UI

# Build
npm run build            # TypeScript → dist/ (tsup)
npm run build:ui         # React SPA → ui/dist/ (Vite)

# Production
npm start                # Runs from dist/

# Lint & Typecheck
npm run lint
npm run typecheck
```

## Testing

```bash
npm test                 # Run all 4,655 tests
npm run test:watch       # Watch mode
npx vitest run tests/core.test.ts  # Run specific file
```

- Framework: **vitest**
- Tests use heavy `vi.mock()` patterns — see `tests/gateway-extended.test.ts` for the full mock setup
- Mission Control tests: `tests/mission-control.test.ts` (35 tests)

## Version Bumping

When bumping the version, update ALL of these files:
1. `package.json` → `"version"`
2. `src/utils/constants.ts` → `TITAN_VERSION`
3. `tests/core.test.ts` → version assertion
4. `tests/mission-control.test.ts` → version references (4 occurrences)
5. `CHANGELOG.md` → new entry

## Key Architecture Decisions

- **Pure ESM** — No CommonJS. Use `import.meta.url` not `__dirname`.
- **Zod schemas** for all config validation (`src/config/schema.ts`)
- **Provider/model format**: `"provider/model-name"` (e.g., `"anthropic/claude-sonnet-4-20250514"`)
- **Tool execution**: Multi-round loop (up to 25 rounds in autonomous mode)
- **Auth**: Default `auth.mode='token'`. When no `auth.token` is configured, auth is bypassed (open access).
- **Gateway API**: All endpoints under `/api/*`. Auth middleware skips when no token configured.
- **React SPA**: Served from `ui/dist/` at `/`. Legacy dashboard at `/legacy`.

## API Endpoints

Main chat endpoint:
```
POST /api/message
Body: { content, sessionId?, model? }
Returns: { content, sessionId, toolsUsed, durationMs, model }
SSE streaming: Add header `Accept: text/event-stream`
```

Key endpoints:
- `GET /api/health` — Health check
- `GET /api/config` — Full config (nested: `agent.model`, `gateway.auth`, etc.)
- `GET /api/models` — Returns `{ provider: ["provider/model", ...] }` (object, NOT array)
- `POST /api/config` — Update config
- `POST /api/model/switch` — Switch active model
- `GET /api/stats` — System stats
- `GET /api/voice/health` — Voice subsystem status
- `GET /api/goals` — List all goals
- `GET /api/cron` — List cron jobs
- `POST /api/autopilot/toggle` — Enable/disable autopilot
- `POST /api/recipes/:id/run` — Execute a saved recipe
- `POST /api/browser/form-fill` — Direct form fill (bypasses LLM, supports `postClicks`)
- `POST /api/browser/solve-captcha` — Solve CAPTCHA on a given URL via CapSolver
- `GET /api/vram` — GPU VRAM snapshot (state, models, leases)
- `POST /api/vram/acquire` — Request VRAM (auto-swaps models)
- `POST /api/vram/release` — Release a VRAM lease
- `GET /api/vram/check?mb=N` — Dry-run VRAM availability check

### Agent Wakeup API
Wakeup endpoints live under `/api/command-post/*` (moved during the Command Post
refactor — Hunt Finding #25 cleaned up stale references):
- `POST /api/command-post/wakeup` — Create wakeup request (body: `{agentId, task, model}`)
- `GET /api/command-post/wakeup/:requestId` — Get wakeup request status
- `DELETE /api/command-post/wakeup/:requestId` — Cancel wakeup request
- `GET /api/command-post/agents/:agentId/inbox` — Get agent's assigned issues + drain pending results

### Command Post API
- `GET /api/command-post/dashboard` — Full dashboard state (agents, issues, budgets)
- `GET /api/command-post/agents` — List registered agents
- `GET /api/command-post/agents/stale` — Detect stale agents (no heartbeat in 1+ hour)
- `GET /api/command-post/issues` — List issues
- `PATCH /api/command-post/issues/:id` — Update issue
- `GET /api/command-post/activity` — Activity feed
- `GET /api/command-post/goals/tree` — Goal hierarchy tree
- `GET /api/command-post/goals/:id/validate-ancestry` — Validate goal ancestry (depth + cycle check)
- `GET /api/command-post/org` — Organization chart
- `GET /api/command-post/budgets` — Budget policies
- `POST /api/command-post/budgets/:agentId/enforce` — Enforce budget for agent (auto-pause/stop)
- `POST /api/command-post/checkouts/sweep` — Clean up expired checkouts

## Mission Control v2 (React SPA)

Located in `ui/` — React 19 + Vite + Tailwind CSS 4 + React Router v7.

Key files:
- `ui/src/App.tsx` — Routes and layout
- `ui/src/api/client.ts` — API client (transforms server responses)
- `ui/src/api/types.ts` — TypeScript interfaces
- `ui/src/components/admin/` — 25 admin panels
- `ui/src/components/chat/` — ChatGPT-style chat interface
- `ui/src/hooks/useConfig.tsx` — Config + voice health hook

Important: The API returns nested config (`config.agent.model`) but some UI types expect flat shapes. The `client.ts` transforms responses where needed (e.g., `getModels()` flattens `{provider: [ids]}` into `ModelInfo[]`).

## Deployment

### Local Development
```bash
npm run dev:gateway      # http://localhost:48420
```

### Remote Machines — Homelab Fleet

| Machine | LAN IP | Tailscale IP | SSH User | Role |
|---------|--------|-------------|----------|------|
| **Titan PC** | 192.168.1.11 | 100.100.168.26 | `dj` | Primary GPU (RTX 5090), Ollama inference |
| **Mini PC #2** | 192.168.1.95 | 100.108.231.109 | `djtony707` | Previous TITAN Docker host |
| **T610 Server** | 192.168.1.67 | 100.100.25.57 | `t610` | Always-on backbone (Docker stack) |

SSH aliases configured in `~/.ssh/config`: `titan`, `minipc`, `t610` (LAN) and `ts-titan`, `ts-minipc`, `ts-t610` (Tailscale).

**TITAN deployment target**: Titan PC at `/opt/TITAN/`
- Ollama runs locally on Titan PC at `localhost:11434`
- Gateway port: 48420
- Docker env: `OLLAMA_HOST=http://localhost:11434`, `TITAN_GATEWAY_HOST=0.0.0.0`
- For Docker with GPU: add `--gpus all`
- Mini PC runs Node 18 — it **cannot build Tailwind CSS 4**. Always build `ui/dist/` elsewhere.
- Dashboard URL: `http://192.168.1.11:48420`

**Service ports on T610** (Docker stack at `/opt/ai-stack/`):
Open WebUI :3000 | Portainer :9443 | LiteLLM :4000 | Ollama :11434 | n8n :5678 | Qdrant :6333

Additional memory files with detailed homelab context are in `~/.claude/projects/` memory files.

## Publishing

After all changes are committed and pushed:
```bash
npm run build && npm run build:ui
npm publish
```

Always publish to npm after pushing to git.

## Key Files

| File | Purpose |
|------|---------|
| `src/utils/constants.ts` | Version, paths, defaults |
| `src/config/schema.ts` | Zod config schema with all defaults |
| `src/gateway/server.ts` | Express server, auth middleware, API routes, SPA serving |
| `src/agent/agent.ts` | Core agent loop |
| `src/providers/base.ts` | LLM provider base class, `parseModelId()` |
| `src/skills/registry.ts` | Skill/tool registration |
| `ui/src/api/client.ts` | React SPA API client |
| `src/vram/orchestrator.ts` | VRAM orchestrator singleton (GPU memory management) |
| `src/agent/commandPost.ts` | Command Post governance (checkout, budgets, ancestry, registry, feed) |
| `src/skills/nvidia/` | NVIDIA GPU skills (cuOpt, AI-Q, gated by TITAN_NVIDIA=1) |
| `package.json` | Dependencies, scripts, tsup config |

## Recent History

See `CHANGELOG.md` for full history. Key milestones:
- **v1.1.0**: Command Post governance (budget enforcement, ancestry validation, stale agent detection), 135+ Playwright E2E tests, type safety fixes, 4,655 tests across 154 files
- **v1.0.0**: First semver release. Paperclip integration, provider error recovery, multi-agent architecture rewrite. All prior 2026.10.XX versions deprecated.
- **v2026.10.68**: Full-stack audit & hardening — 14 bugs fixed (concurrency guard, model validation, config exposure, mesh TLS, Prometheus /metrics, 6 UI fixes), AUDIT-REPORT.md
- **v2026.10.67**: Command Post — Paperclip-inspired agent governance (atomic task checkout, budget enforcement, goal ancestry, agent registry, activity feed), 25 admin panels, 4,430 tests across 140 files
- **v2026.10.66**: Agent Watcher, rich SSE events, iOS voice fixes, auto-HTTPS, bounded memory, injection protection
- **v2026.10.55**: Orpheus TTS auto-installer — one-click setup (mlx-audio on Mac, orpheus-speech on Linux), management endpoints, settings UI with progress streaming, logout button
- **v2026.10.53**: Login page + voice Orpheus auto-fallback — React SPA auth gate with password login, voice stream TTS probe, browser TTS fallback with status indicator
- **v2026.10.52**: Security & stability hardening — 25+ bug fixes across 12 files (config mutation crash, GEPA race condition, auth error data leak, graph edge cap, sandbox bind, graceful shutdown, VRAM validation, stack trace leaks, session hijack prevention, ESLint 53→14 warnings)
- **v2026.10.51**: Cloud model tool calling fix — ToolRescue + CloudRetry + HallucinationGuard (3-layer defense for cloud-routed Ollama models)
- **v2026.10.50**: GEPA — Genetic Evolution of Prompts & Agents (population-based evolutionary optimization, tournament selection, crossover, mutation, elitism, 3 tools)
- **v2026.10.49**: Hindsight MCP Bridge — cross-session episodic memory (retain strategies + recall hints via Vectorize.io Hindsight)
- **v2026.10.48**: Smart auto-learning — SmartCompress plugin (task-type-aware compression), continuous learning feedback loop, ordered tool sequence capture, ContextEngine compact hook wired
- **v2026.10.47**: Multi-chip GPU support (NVIDIA + AMD ROCm + Apple Silicon Metal), Hindsight MCP memory preset, tool sequence learning
- **v2026.10.46**: Model Benchmark — 15 Ollama models tested through TITAN (7 categories, README + benchmarks/MODEL_COMPARISON.md)
- **v2026.10.45**: MiniMax M2.7 provider (#32), autopilot dry-run mode (community PR #7)
- **v2026.10.43**: VRAM Orchestrator — auto GPU VRAM management (nvidia-smi polling, model swap, leases, 3 tools, 4 API endpoints)
- **v2026.10.42**: NVIDIA GPU skills — cuOpt VRP optimization, AI-Q Nemotron research, OpenShell sandbox, voice mic fix
- **v2026.10.41**: Hotfix — tool visibility, voice prompt, keepModelPrefix
- **v2026.10.40**: 9 new skills (40 tools) — structured output, workflows, social scheduler, agent handoff, event triggers, knowledge base, evals, approval gates, A2A protocol. 2 critical security fixes (SSE listener leak, YAML sandbox). 4,321 tests across 135 files.
- **v2026.10.39**: Security release — resolved all 23 Dependabot alerts (0 vulnerabilities), matrix-js-sdk v41, npm overrides for transitive deps
- **v2026.10.38**: `titan doctor --json` (Issue #2), better provider error messages (Issue #3), npm download stats (Issue #4), 27 weather skill tests (Issue #6), 5 dependency patches
- **v2026.10.33**: HA auto-save (gateway intercepts tokens), ha_setup in coreTools, voice test fix
- **v2026.10.32**: Orpheus TTS restored (reverted TADA), voice selector dropdown in VoiceOverlay, VoicePicker with 8 named Orpheus voices, separate TTS AbortController, browser TTS fallback, all TADA references removed
- **v2026.10.30**: Home Assistant skill (11 tools), voice server REST API, voice echo cancellation
- **v2026.10.29**: Personal skills bridge (ghost registry fix), stop button (end-to-end abort), task continuation injection, tool-aware system prompt compression, Gmail delete_label/bulk_delete_labels, confirmation gate string vs boolean fix, Google OAuth panel
- **v2026.10.28**: Critical bug fixes — vector search circular dependency fixed (initVectors now does direct API call instead of calling embed() while available=false), ActiveLearning no-op loop fixed (no longer records "use shell instead of shell"), ESLint prefer-const fix
- **v2026.10.27**: System prompt architecture overhaul — Tool Execution rules moved to top, ReAct loop pattern, MUST/NEVER directives, negative examples, task-aware dynamic injection, API-level `tool_choice` forcing, cloud prompt compression fixed, all 11 sub-agent prompts rewritten with proper tool enforcement
- **v2026.10.26**: Live training feed (SSE streaming + terminal UI), incremental training data writes (critical fix — data survives tool timeouts), cloud-assisted training pipeline
- **v2026.10.25**: Production hardening — 0 TypeScript errors, 0 ESLint errors, SSE write safety, rate limit cap, `.unref()` intervals, unhandled rejection handler, hardcoded IPs removed
- **v2026.10.24**: GitHub Actions CI, "Why TITAN?" comparison table, README badges, npm SEO keywords, CODE_OF_CONDUCT, examples/, migration guide, benchmarks doc
- **v2026.10.23**: Production autonomy — systemd service unit, health monitor, log rotation, fetchWithRetry timeout, autopilot, fallback chain, goals
- **v2026.10.22**: Voice system hardening (24 fixes), VoiceOverlay rewrite, FluidOrb canvas rewrite, Gateway SSE leak fix, TTS health probe fix, Ollama context 8K→16K, internal health monitor
- **v2026.10.21**: Dual training pipelines (Tool Router + Main Agent), training type selector UI with customizable hyperparameters, agent training data generator (530+ examples), Ollama context management fix, new API endpoints (generate-data, deploy, type-filtered results)
- **v2026.10.20**: Autonomous self-improvement system (LLM-as-judge eval, autoresearch experiments), local model LoRA fine-tuning pipeline (unsloth → GGUF → Ollama), Self-Improvement Mission Control panel, autopilot self-improve mode, 8 new tools
- **v2026.10.17**: CapSolver CAPTCHA integration, direct form-fill endpoint, deferred button clicks, React-compatible form automation
- **v2026.10.11**: Integrations panel (12 provider API keys + Google OAuth), Workflows panel (Goals, Cron, Recipes, Autopilot), autonomous persona, research pipeline, autoresearch, TopFacts plugin, checkpoint/resume, 25 admin panels, 117 tools, 82 skills
- **v2026.10.4**: Onboarding wizard, system_info tool, tool discovery fix, new admin panels
- **v2026.10.3**: Settings panel data binding (models API shape, nested config keys)
- **v2026.10.2**: Auth lockout fix (unconfigured token auth no longer blocks API)
- **v2026.10.1**: Settings panel padding, voice button, Docker/ESM fixes
- **v2026.10.0**: Mission Control v2 (React 19 SPA replacing monolithic HTML dashboard)
- **v2026.9.0**: LiveKit WebRTC voice, MCP Server mode
- **v2026.8.0**: ContextEngine plugins, Prometheus metrics, 30 providers, 15 channels

## Style & Conventions

- TypeScript strict mode
- ESM only (`"type": "module"` in package.json)
- Tests colocated in `tests/` directory (not alongside source)
- Skill files export tool definitions with Zod parameter schemas
- Config defaults defined in Zod schema (`src/config/schema.ts`)
- No `__dirname` — use `fileURLToPath(import.meta.url)` + `dirname()`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **TITAN** (29559 symbols, 50352 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/TITAN/context` | Codebase overview, check index freshness |
| `gitnexus://repo/TITAN/clusters` | All functional areas |
| `gitnexus://repo/TITAN/processes` | All execution flows |
| `gitnexus://repo/TITAN/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
