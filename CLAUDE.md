# CLAUDE.md — TITAN Project Guide

> This file is read automatically by Claude Code. It contains everything needed to understand, build, test, and contribute to TITAN.

## What is TITAN?

**TITAN (The Intelligent Task Automation Network)** is a premium, autonomous AI agent framework built in TypeScript. It's published as `titan-agent` on npm with 5,500+ installs. Created by Tony Elliott.

- **Current version**: v2026.10.52
- **License**: MIT
- **Repo**: https://github.com/Djtony707/TITAN
- **Runtime**: Node.js >= 20, pure ESM

## Quick Reference

| Stat | Value |
|------|-------|
| Providers | 36 (4 native + 32 OpenAI-compatible) |
| Skills | 100+ loaded |
| Tools | ~195 across 100+ loaded skills |
| Channels | 15 (Discord, Telegram, Slack, WhatsApp, Matrix, IRC, etc.) |
| Tests | 4,329+ across 135 files (vitest) |
| Default model | `anthropic/claude-sonnet-4-20250514` |
| Gateway port | 48420 |

## Project Structure

```
src/
├── agent/        # Agent core, reflection, sub-agents, orchestrator, goals, initiative
├── browsing/     # Shared browser pool (Playwright), CAPTCHA solver (CapSolver)
├── channels/     # 15 channel adapters
├── config/       # Zod-validated config schema
├── context/      # ContextEngine plugin system
├── gateway/      # Express HTTP/WS server + Mission Control v2 (React SPA)
├── mcp/          # MCP Server (JSON-RPC 2.0, stdio + HTTP)
├── memory/       # Memory, learning, graph, relationship, briefings
├── mesh/         # P2P mesh networking (mDNS, WebSocket, HMAC)
├── providers/    # LLM provider router + 34 providers
├── skills/       # Builtin skills (100+ loaded, ~195 tools) + dev + NVIDIA skills
├── utils/        # Constants, helpers, hardware detection
├── voice/        # LiveKit WebRTC voice integration
└── vram/         # VRAM orchestrator (GPU memory management, model swap, leases)
ui/               # React 19 SPA (Vite + Tailwind CSS 4 + React Router v7)
tests/            # 123 vitest test files
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
npm test                 # Run all 3,839 tests
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

## Mission Control v2 (React SPA)

Located in `ui/` — React 19 + Vite + Tailwind CSS 4 + React Router v7.

Key files:
- `ui/src/App.tsx` — Routes and layout
- `ui/src/api/client.ts` — API client (transforms server responses)
- `ui/src/api/types.ts` — TypeScript interfaces
- `ui/src/components/admin/` — 17 admin panels
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
| `src/skills/nvidia/` | NVIDIA GPU skills (cuOpt, AI-Q, gated by TITAN_NVIDIA=1) |
| `package.json` | Dependencies, scripts, tsup config |

## Recent History

See `CHANGELOG.md` for full history. Key milestones:
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
- **v2026.10.11**: Integrations panel (12 provider API keys + Google OAuth), Workflows panel (Goals, Cron, Recipes, Autopilot), autonomous persona, research pipeline, autoresearch, TopFacts plugin, checkpoint/resume, 17 admin panels, 117 tools, 82 skills
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
