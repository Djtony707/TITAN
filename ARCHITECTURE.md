# TITAN Architecture

> **TITAN -- The Intelligent Task Automation Network**
> v5.0.0 "Spacewalk"

## System Overview

TITAN is a TypeScript-based autonomous AI agent framework with a modular architecture designed for extensibility, security, and multi-agent operation. Pure ESM, zero native compilation, runs on Node.js >= 22.

## Core Components

```
                          CLI Interface
  onboard | gateway | agent | mesh | doctor | config | autopilot | teams
                              |
                      Gateway Server
            HTTP + WebSocket Control Plane
        Express REST API | Dashboard (14 panels) | WS Broadcast
        MCP Server (JSON-RPC 2.0) | Prometheus /metrics
                              |
            +-----------------+-----------------+
            |                 |                 |
      Multi-Agent        Channel           Security
      Router (1-5)       Adapters (15)     Sandbox + Pairing
            |                                Shield + Vault
      Agent Core                             Audit Log
      Session Mgmt | Reflection              Team RBAC
      Tool Runner  | Sub-Agents
      Orchestrator | Goals
            |
       +----+----+--------+
       |         |         |
    Skills    LLM Providers  Browsing
    38 files  34 providers   Browser Pool
    ~108 tools (4 native +   Stagehand
       |       30 compat)
    Memory + Learning        Voice
    Graph + RAG              LiveKit WebRTC
    Relationship
    Briefings
```

## Data Flow

1. **Inbound** -- Messages arrive from channels (Discord, Telegram, WebChat, etc.)
2. **Routing** -- Multi-agent router resolves which agent handles the message
3. **Context** -- Agent builds system prompt with workspace files, learning context, memories
4. **Deliberation** -- Complex requests trigger multi-stage reasoning (analyze, plan, approve, execute)
5. **Orchestration** -- Multi-step tasks analyzed and delegated to sub-agents (parallel or sequential)
6. **LLM** -- Provider router sends to best available LLM (with failover + retry)
7. **Tools** -- Multi-round tool execution loop (up to 10 rounds)
8. **Reflection** -- Agent self-assesses quality every N rounds (confidence, completeness, next steps)
9. **Learning** -- Tool results tracked, knowledge base updated
10. **Goals** -- Persistent goal tracking drives autopilot subtask execution + initiative chaining
11. **Response** -- Final response routed back to originating channel

## Autonomy Flow

The v2026.6.7 autonomy system introduces a layered execution model:

```
  Inbound Message
        |
  Complexity Classification
  (simple / moderate / complex / ambitious)
        |
  +-----+-----+
  |           |
  Simple    Complex/Ambitious
  |           |
  Direct    Deliberation Loop
  LLM Call    |
  |         Analyze -> Plan -> Approve -> Execute -> Adapt
  |           |
  |         Orchestrator
  |           |
  |         +---+---+---+
  |         |   |   |   |
  |        Sub-Agents (parallel or sequential)
  |         explorer / coder / browser / analyst
  |           |
  +-----+-----+
        |
  Tool Execution Loop (up to 10 rounds)
        |
  Reflection Check (every N rounds)
  "Am I making progress?"
        |
  +-----+-----+
  |           |
  Continue   Adjust/Stop
  |           |
  +-----+-----+
        |
  Goal Check (initiative)
  "Is there a next subtask?"
        |
  +-----+-----+
  |           |
  Auto-start  Propose
  (autonomous) (supervised)
        |
  Response
```

### Reflection Details

- Runs every N tool-call rounds (configurable)
- Uses the `fast` model alias for cheap, quick self-assessment
- Evaluates: confidence level, progress toward goal, whether to continue or pivot
- Prevents runaway tool loops and wasted token spend
- Works alongside the existing loop detection and circuit breaker systems

### Sub-Agent Architecture

- `spawn_agent` tool creates isolated agent instances
- Each sub-agent has its own session, constrained toolset, and context
- Four templates: `explorer` (web), `coder` (files), `browser` (interactive web), `analyst` (analysis)
- Max depth = 1 (sub-agents cannot spawn sub-agents)
- Results returned to parent agent for synthesis

### Orchestrator Flow

- Analyzes incoming task for delegation potential
- Identifies independent subtasks (can run in parallel) vs. dependent subtasks (must run sequentially)
- Spawns sub-agents with appropriate templates
- Parallel tasks execute concurrently; sequential tasks receive context from predecessors
- Synthesizes all sub-agent results into a unified response

## Security Model

- **Main session**: Full host access (single-user mode)
- **Non-main sessions**: Docker sandbox per session
- **DM pairing**: New senders quarantined until approved
- **Tool allowlists**: Configurable per-agent tool permissions
- **Network/filesystem allowlists**: Configurable access boundaries
- **Prompt injection shield**: Multi-layer detection (heuristic + LLM)
- **Secrets vault**: AES-256-GCM encrypted credential store
- **Audit log**: HMAC-SHA256 chained tamper-evident event trail

## Voice Architecture (LiveKit WebRTC)

Real-time voice uses [LiveKit](https://livekit.io/) for production-grade WebRTC:

```
  Browser (Mission Control)
        |
  WebRTC (audio tracks)
        |
  LiveKit Server (cloud or self-hosted)
        |
  LiveKit Agent Worker (src/voice/livekitAgent.ts)
        |
  +-----+-----+
  |           |
  STT         TTS
  (Deepgram/  (Cartesia/
   Whisper)    OpenAI)
        |
  TITAN processMessage()
  (agent brain)
```

- **Token endpoint**: `POST /api/livekit/token` — issues scoped JWT (15-min TTL) secured by gateway auth
- **Agent bridge**: LiveKit dispatches a worker when a user joins a room; the worker routes transcribed speech through `processMessage()` and speaks the response via TTS
- **File-based tools**: `generate_speech` and `transcribe_audio` still available via OpenAI API for offline/file-based use cases (independent of WebRTC pipeline)
- LiveKit is an optional dependency — TITAN runs fine without voice enabled

## MCP Server Architecture

TITAN serves its tools via the Model Context Protocol (JSON-RPC 2.0, spec 2025-03-26):

```
  External MCP Client (Claude Code, Cursor, etc.)
        |
  POST /mcp (HTTP transport)  or  stdin/stdout (stdio transport)
        |
  JSON-RPC Dispatcher (src/mcp/server.ts)
        |
  +-----+-----+-----+
  |           |       |
  initialize  tools/  tools/
              list    call
                |       |
           getRegistered  executeTool()
           Tools()        (with timeout,
           (filtered by   security check)
            security)
```

- **HTTP transport**: `POST /mcp` on gateway port, enabled via `mcp.server.enabled: true`
- **Stdio transport**: `startStdioServer()` — newline-delimited JSON-RPC on stdin/stdout
- **Security**: Filters tools by `security.deniedTools`, `allowedTools`, and skill enable state
- **Status**: `GET /api/mcp/server` returns enabled/initialized/toolCount

## File Layout

```
src/
+-- agent/
|   +-- agent.ts            # Core agent loop with learning integration
|   +-- autonomy.ts         # Risk classification + HITL approval gates
|   +-- autopilot.ts        # Hands-free scheduled agent runs
|   +-- contextManager.ts   # Context window management + compaction
|   +-- costOptimizer.ts    # Token cost tracking + optimization
|   +-- deliberation.ts     # Multi-stage reasoning for complex requests
|   +-- goals.ts            # Persistent goal & subtask tracking
|   +-- generator.ts        # Auto-generate skills from natural language
|   +-- initiative.ts       # Self-initiative: auto-chain next subtasks
|   +-- loopDetection.ts    # Detect infinite tool-call loops
|   +-- monitor.ts          # File/process monitoring
|   +-- multiAgent.ts       # Multi-agent router (max 5 agents)
|   +-- orchestrator.ts     # Multi-step task delegation to sub-agents
|   +-- parallelTools.ts    # Parallel tool execution
|   +-- planner.ts          # Task planning + execution
|   +-- reflection.ts       # Self-assessment during tool loops
|   +-- responseCache.ts    # LRU response cache
|   +-- session.ts          # Per-user/per-channel session management
|   +-- stallDetector.ts    # Detect stalled LLM inference
|   +-- subAgent.ts         # Isolated sub-agent spawning (explorer/coder/browser/analyst)
|   +-- swarm.ts            # Agent swarm coordination
|   +-- toolRunner.ts       # Tool execution engine with sandboxing
+-- browsing/
|   +-- browserPool.ts      # Shared Chromium pool (max 5 pages, 30-min TTL)
|   +-- stagehand.ts        # Natural language browser automation (Playwright fallback)
+-- auth/
|   +-- google.ts           # Google OAuth
+-- channels/
|   +-- base.ts             # Abstract channel adapter
|   +-- discord.ts          # Discord
|   +-- telegram.ts         # Telegram
|   +-- slack.ts            # Slack
|   +-- googlechat.ts       # Google Chat
|   +-- webchat.ts          # Built-in WebSocket chat
|   +-- whatsapp.ts         # WhatsApp (Baileys)
|   +-- matrix.ts           # Matrix
|   +-- signal.ts           # Signal
|   +-- msteams.ts          # Microsoft Teams
+-- cli/
|   +-- index.ts            # CLI entrypoint (10+ commands)
|   +-- onboard.ts          # Setup wizard
|   +-- doctor.ts           # Diagnostics + self-healing
+-- config/
|   +-- schema.ts           # Zod-based configuration schema
|   +-- config.ts           # Config manager
+-- gateway/
|   +-- server.ts           # HTTP+WS server, REST APIs
|   +-- dashboard.ts        # Mission Control inline HTML/JS
|   +-- slashCommands.ts    # Slash command registry
+-- mcp/
|   +-- client.ts           # MCP client (connect to external MCP servers)
|   +-- registry.ts         # MCP server configuration persistence
|   +-- server.ts           # MCP server (expose TITAN tools via MCP)
+-- memory/
|   +-- memory.ts           # JSON file-based persistent memory
|   +-- graph.ts            # Temporal graph memory (entities + episodes)
|   +-- learning.ts         # Continuous learning engine
|   +-- relationship.ts     # User relationship tracking
|   +-- briefing.ts         # Morning briefing generation
+-- mesh/
|   +-- ...                 # Mesh networking (mDNS + Tailscale)
+-- providers/
|   +-- base.ts             # Abstract LLM provider
|   +-- anthropic.ts        # Claude (native Messages API)
|   +-- openai.ts           # GPT (native)
|   +-- google.ts           # Gemini (native)
|   +-- ollama.ts           # Local models (native)
|   +-- openai_compat.ts    # 17 OpenAI-compatible providers
|   +-- router.ts           # Provider router + failover
|   +-- authResolver.ts     # Auth profile rotation
+-- recipes/
|   +-- store.ts            # Recipe CRUD, YAML export/import
|   +-- types.ts            # Recipe & RecipeStep interfaces
+-- security/
|   +-- sandbox.ts          # Session security contexts
|   +-- teams.ts            # Team Mode RBAC (roles, members, invites, permissions)
|   +-- pairing.ts          # DM pairing manager
|   +-- shield.ts           # Prompt injection detection
|   +-- secrets.ts          # Encrypted secrets vault
|   +-- encryption.ts       # AES-256-GCM encryption
|   +-- auditLog.ts         # Tamper-evident audit trail
+-- skills/
|   +-- registry.ts         # Skill discovery, loading, toggle
|   +-- marketplace.ts      # GitHub-hosted skills marketplace
|   +-- scaffold.ts         # Plugin SDK: skill template generation (JS/TS/YAML)
|   +-- builtin/            # 36 built-in skill files (95 tools)
|       +-- shell.ts        # Shell execution
|       +-- filesystem.ts   # File operations
|       +-- browser.ts      # CDP browser control
|       +-- web_search.ts   # DuckDuckGo search
|       +-- web_fetch.ts    # URL content extraction
|       +-- web_browse_llm.ts # web_read + web_act (LLM-powered browsing)
|       +-- github.ts       # GitHub API (5 tools)
|       +-- email.ts        # Email (4 tools)
|       +-- computer_use.ts # Computer use (6 tools)
|       +-- vision.ts       # Image analysis
|       +-- voice.ts        # Text-to-speech / speech-to-text
|       +-- image_gen.ts    # Image generation
|       +-- pdf.ts          # PDF parsing
|       +-- calendar.ts     # Calendar management
|       +-- data_analysis.ts# Data analysis + charting
|       +-- smart_home.ts   # Smart home control
|       +-- skyvern.ts      # Skyvern MCP browser automation
|       +-- income_tracker.ts    # Financial ledger (4 tools)
|       +-- freelance_monitor.ts # Job search + matching (4 tools)
|       +-- content_publisher.ts # SEO content pipeline (4 tools)
|       +-- goals.ts        # Goal management (4 tools)
|       +-- lead_scorer.ts      # Lead gen + scoring (4 tools)
|       +-- x_poster.ts     # X/Twitter posting + review queue (4 tools)
|       +-- cron.ts         # Scheduled tasks
|       +-- webhook.ts      # HTTP webhooks
|       +-- memory_skill.ts # Persistent memory ops
|       +-- memory_graph.ts # Graph memory ops
|       +-- sessions.ts     # Inter-agent sessions
|       +-- process.ts      # Background processes
|       +-- apply_patch.ts  # Unified diff patching
|       +-- auto_generate.ts# Skill generation from NL
|       +-- model_switch.ts # Runtime model switching
|       +-- web_browser.ts  # Additional browser tools
|       +-- code_exec.ts    # Sandbox code execution
|       +-- weather.ts      # Weather forecasts
+-- utils/
    +-- constants.ts        # Paths, defaults, version
    +-- logger.ts           # Structured logging
    +-- helpers.ts          # File I/O utilities
```

## Test Coverage

- **5,840+ tests** across **211 files** (Vitest)
- **~85% line coverage**
- All core systems have dedicated test suites
- Run with `npm run test` or `npm run test:coverage`
