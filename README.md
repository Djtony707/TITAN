[//]: # (npm-text-start)
> **TITAN** — A TypeScript AI agent framework with autonomous self-improvement, LoRA fine-tuning, 220+ tools, 36 LLM providers, 15 channels, mesh networking, LiveKit voice with F5-TTS cloning, Paperclip-style Command Post governance, and a React dashboard with 30+ panels. It trains itself. `npm i -g titan-agent`
[//]: # (npm-text-end)

# TITAN — The Intelligent Task Automation Network

<p align="center">
  <img src="assets/titan-logo.png" alt="TITAN Logo" width="280"/>
</p>

<p align="center">
  <strong>An autonomous AI agent framework that actually does things — and gets better at it every day. Sub-agent orchestration, goal-driven autopilot, Paperclip-style Command Post governance with issues and approvals, deliberative reasoning, sandbox code execution, browser automation with CAPTCHA solving, F5-TTS voice cloning, autonomous self-improvement, local model fine-tuning, 15 channels, 36 providers, 220+ tools, 4,500+ tests. It trains itself. Pure TypeScript. No native compilation. No, seriously.</strong>
</p>

<p align="center">
  <a href="https://github.com/Djtony707/TITAN/stargazers"><img src="https://img.shields.io/github/stars/Djtony707/TITAN?style=social" alt="GitHub Stars"/></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/dw/titan-agent?label=npm%20downloads" alt="npm downloads"/></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/v/titan-agent?color=blue&label=npm" alt="npm version"/></a>
  <a href="https://github.com/Djtony707/TITAN/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Djtony707/TITAN/ci.yml?label=tests" alt="CI Status"/></a>
  <a href="https://github.com/Djtony707/TITAN/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
  <a href="#providers"><img src="https://img.shields.io/badge/providers-36-purple" alt="36 Providers"/></a>
  <a href="#built-in-tools"><img src="https://img.shields.io/badge/tools-209-orange" alt="209 Tools"/></a>
  <a href="#channels"><img src="https://img.shields.io/badge/channels-15-blue" alt="15 Channels"/></a>
  <a href="#tests"><img src="https://img.shields.io/badge/tests-4%2C655-brightgreen" alt="4,655 Tests"/></a>
  <a href="https://github.com/Djtony707/TITAN/graphs/contributors"><img src="https://img.shields.io/github/contributors/Djtony707/TITAN" alt="Contributors"/></a>
</p>

<p align="center">
  <a href="https://railway.app/template/titan-agent"><img src="https://railway.app/button.svg" alt="Deploy on Railway" height="32"/></a>
  &nbsp;
  <a href="https://render.com/deploy?repo=https://github.com/Djtony707/TITAN"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="32"/></a>
  &nbsp;
  <a href="https://replit.com/github/Djtony707/TITAN"><img src="https://replit.com/badge/github/Djtony707/TITAN" alt="Run on Replit" height="32"/></a>
</p>

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>TITAN is built by <a href="https://github.com/Djtony707">Tony Elliott</a> — a father, AI Software Engineering student, DJ, and open-source builder who'd rather ship features than sleep. If TITAN saves you time, makes you money, or just makes you say "wait, it can do that?" — <a href="https://github.com/sponsors/Djtony707">consider sponsoring</a>. It fuels the late-night coding sessions that keep this project alive.</em>
</p>

<p align="center">
  <a href="SUPPORTERS.md">View all supporters</a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#what-titan-does">What It Does</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#autonomy-system">Autonomy</a> &bull;
  <a href="#self-improvement">Self-Improvement</a> &bull;
  <a href="#mission-control">Mission Control</a> &bull;
  <a href="#channels">Channels</a> &bull;
  <a href="#providers">Providers</a> &bull;
  <a href="#voice-pipeline">Voice</a> &bull;
  <a href="#mesh-networking">Mesh</a> &bull;
  <a href="#sandbox-code-execution">Sandbox</a> &bull;
  <a href="#cli-reference">CLI</a>
</p>

---

## Why TITAN?

TITAN is the only open-source agent framework that **trains itself on your GPU**. While other frameworks focus on orchestration or chat, TITAN is a complete autonomous platform — self-improvement, voice, GUI, 15 channels, mesh networking, agent governance, and 36 providers in one package.

| Feature | TITAN | OpenClaw | CrewAI | LangGraph | AutoGen | Forge (MiniMax) |
|---------|:-----:|:--------:|:------:|:---------:|:-------:|:---------------:|
| **Language** | TypeScript | TypeScript | Python | Python | Python/.NET | Python |
| **GitHub Stars** | 8 | 316k | 48k | 28.4k | 56.7k | Emerging |
| **Self-improving** | LoRA + auto-eval | Foundry/Trace | — | — | Limited | RL training (CISPO) |
| **Local model fine-tuning** | LoRA on your GPU | — | — | — | — | Prefix tree merging (40× speedup) |
| **Built-in GUI** | React SPA, 30+ panels | Web + mobile | Partial | — | AutoGen Studio | — |
| **Agent governance** | Command Post (Paperclip) |
| **Engineering personas** | 40 (19 from agent-skills) | — | — | — | — | — |
| **Plan mode** | Claude Code-style approval | — | — | Human-in-the-loop | — | — |
| **Voice** | LiveKit WebRTC | ElevenLabs | — | — | — | — |
| **Channel adapters** | 15 | 24+ | 0 | 0 | 0 | — |
| **LLM providers** | 36 | Model-agnostic | ~10 | ~20 | ~15 | Universal agent support |
| **Mesh networking** | Multi-machine | — | — | — | — | — |
| **Sandbox execution** | Docker + NVIDIA OpenShell | — | — | — | — | — |
| **GPU VRAM management** | Auto-swap orchestrator | — | — | — | — | — |
| **MCP server mode** | Expose tools to other agents | Client only | Client | Client | Client | — |
| **Durable execution** | — | — | — | ✓ | — | Windowed FIFO scheduling |
| **Training throughput** | — | — | — | — | — | 100k+ agent scaffolds/day |

> **TITAN vs competitors**: While frameworks like CrewAI (48k⭐) and LangGraph (28.4k⭐) focus on orchestration, TITAN is a complete autonomous platform with self-improvement, voice, mesh networking, and GPU management built in. **OpenClaw** (316k⭐) is a personal assistant you configure. **TITAN** is a developer framework you build with — and it gets smarter on its own GPU.

> **New in Q2 2026**: **Forge by MiniMax** (Feb 2026) — internal RL framework with 40× training speedup via prefix tree merging and massive agent throughput (100k+ scaffolds/day). **LangGraph v1.1.6** (April 2026) adds durable execution and enterprise integrations.

---

> **WARNING — EXPERIMENTAL SOFTWARE**
> TITAN is experimental, actively developed software. It can execute shell commands, modify files, access the network, and take autonomous actions on your system. **Use at your own risk.** Think of it less as "software you install" and more as "a very motivated intern with root access." The author and contributors provide this software "as is" without warranty of any kind. By installing or running TITAN, you accept full responsibility for any consequences, including but not limited to data loss, system instability, unintended actions, API charges, or security issues. Always review TITAN's configuration, run it in supervised mode first, and never grant it access to systems or credentials you cannot afford to lose. See [LICENSE](LICENSE) for the full legal terms.

---

> **What's New in v1.2.1 — Agent Pipeline Overhaul + Claude Code Patterns**
>
> **Async sub-agent heartbeat** — agents can now poll their Command Post inbox every 3 rounds, claim pending wakeup requests, and spawn sub-agents automatically. New `claimWakeupRequest()` and `releaseWakeupRequest()` functions provide atomic claim/release semantics. `checkAndProcessInbox()` handles the full lifecycle: spawns sub-agent, updates issue status, posts results back as comments.
>
> **Agent Watcher mobile overlay** — responsive full-screen overlay for mobile devices. Agent Watcher panel is hidden on mobile by default; tapping the watch button opens a full-screen overlay with close button, matching the desktop 40% width layout. Desktop split-view improved with proper `overflow-hidden` handling and smooth width transitions.
>
> **Type safety hardening** — improved TypeScript strictness across gateway server (dynamic imports, nullable session fields, audit log queries), Command Post event handlers (spread args pattern), and config API exposure.
>
> **Bug fixes** — session timestamps use `createdAt` field, cloud mode redirects fixed, error handlers cleaned up, OpenRouter auth profiles added.
>
> Previous release: v2026.10.68 — Full Paperclip integration, 14 bugs fixed, Cloud model benchmark, F5-TTS voice cloning. 4,500+ tests across 154 files.
>
> **— Claude Code**

---

## Quick Start

**Requirements:** Node.js >= 20, an API key, and a healthy sense of adventure.

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/install.sh | bash
```

This detects your OS, installs Node.js if needed (via nvm), installs `titan-agent` globally, and launches the onboarding wizard.

### Manual Install

```bash
npm install -g titan-agent
titan onboard             # Interactive setup — pick a provider, paste your API key, give TITAN a soul
titan gateway             # Launch Mission Control at http://localhost:48420
```

### Docker

```bash
docker run -d -p 48420:48420 --name titan \
  -e ANTHROPIC_API_KEY=your-key \
  -v titan-data:/home/titan/.titan \
  ghcr.io/djtony707/titan:latest
```

Or with docker-compose:

```bash
git clone https://github.com/Djtony707/TITAN.git && cd TITAN
cp .env.example .env     # Edit with your API keys
docker compose up -d
```

That's it. From zero to a running autonomous agent with a dashboard.

### From Source

```bash
git clone https://github.com/Djtony707/TITAN.git && cd TITAN
npm install
npm run build:ui          # Build the React frontend
npm run dev:gateway       # Start in dev mode with Mission Control v2
```

### First Contact

```bash
titan agent -m "Hello"                  # Terminal chat
titan agent -m "What's on my calendar?" # Uses tools automatically
```

Or open `http://localhost:48420` and use the WebChat panel. Same agent, nicer UI.

---

## What TITAN Does

TITAN is not a chatbot wrapper. It's a framework for building AI agents that take real actions. Here's what that looks like in practice:

**"Research competitors and draft a report"**
TITAN enters deliberation mode. It decomposes the task into subtasks, spawns a browser sub-agent to research each competitor in parallel, synthesizes findings, writes a structured report, and saves it to disk. You approve the plan before execution starts.

**"Monitor Upwork for Node.js contracts and send me the best ones"**
TITAN creates a recurring goal. Every cycle, it searches freelance platforms, scores matches against your profile, drafts proposals, and queues them for your review. The autopilot handles scheduling.

**"Set up a content pipeline for my blog"**
TITAN researches SEO keywords, generates outlines, writes drafts, and schedules publishing. Each step uses specialized tools — `web_search` for research, `content_outline` for structure, `content_publish` for output.

**"What did I spend on APIs this month?"**
TITAN queries the income tracker, pulls cost data from provider logs, runs the numbers in a sandbox Python script, and returns a summary with a chart.

**"Deploy this to my mini PC"**
TITAN SSHs into the target machine via the mesh network, pulls the latest code, builds the Docker container, and reports back. All through the `shell` tool with mesh routing.

**"Get better at everything while I sleep"**
TITAN runs self-improvement experiments overnight. It modifies its own prompts, evaluates the changes against a benchmark suite using LLM-as-judge scoring, and keeps only the improvements. It can even fine-tune its own local model on your GPU. You wake up to a smarter agent.

No custom code required for any of the above. TITAN ships with 117 loaded skills exposing 220+ tools. When it needs a capability it doesn't have, it can generate a new skill on the fly.

---

## Architecture at a Glance

```
                          CLI Interface
  onboard | gateway | agent | mesh | doctor | config | autopilot
                              |
                      Gateway Server
            HTTP + WebSocket Control Plane
        Express REST API | Dashboard | WS Broadcast
                              |
            +-----------------+-----------------+
            |                 |                 |
      Multi-Agent        Channel           Security
      Router (1-5)       Adapters (15)     Sandbox + Pairing
            |            Discord            Shield + Vault
      Agent Core         Telegram           Audit Log
      Session Mgmt       Slack              Team RBAC
      Reflection         WhatsApp
      Sub-Agents         Teams              Browsing
      Orchestrator       Google Chat        Browser Pool
      Goals              Matrix             Stagehand
      Initiative         Signal
            |            WebChat             Mesh
       +----+----+       IRC                mDNS + Tailscale
       |         |       Mattermost         Peer Discovery
    Skills    Providers  Lark/Feishu        WS Transport
    117 loaded 36 total   Email (IMAP)
    220+ tools (4 native  LINE               Voice
       |       + 30       Zulip             LiveKit WebRTC
    Memory     compat)
    Graph + RAG
    Briefings
```

Full architecture details: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Autonomy System

TITAN's autonomy system is a complete self-directed execution framework. This isn't just tool calling — it's self-directed goal pursuit with reflection, delegation, and initiative.

### Reflection

Every N tool-call rounds, TITAN pauses and asks itself: "Am I making progress? Should I continue, change approach, or stop?" Uses the `fast` model alias for cheap, quick self-checks. Prevents runaway loops and wasted tokens.

### Sub-Agents

The `spawn_agent` tool delegates tasks to isolated sub-agents with constrained toolsets. Four templates:

| Template | Tools | Use Case |
|----------|-------|----------|
| `explorer` | Web search, fetch, browse | Research and information gathering |
| `coder` | Shell, filesystem, edit | Code generation and modification |
| `browser` | Browser pool, Stagehand | Interactive web automation |
| `analyst` | Memory, data analysis | Analysis and synthesis |

Max depth = 1 (no sub-sub-agents). Each sub-agent gets its own session and returns results to the parent.

### Orchestrator

When a task involves multiple independent subtasks, the orchestrator:

1. Analyzes the request for delegation potential
2. Breaks it into parallel and sequential assignments
3. Spawns sub-agents for each
4. Runs independent tasks in parallel, dependent tasks sequentially
5. Synthesizes all results into a unified response

### Goals

Persistent goals with subtasks, scheduling, budget tracking, and progress monitoring. Goals drive the autopilot system — each cycle picks the next actionable subtask.

```
You: "I want to grow my Twitter following to 10K"

TITAN creates a goal with subtasks:
  1. Analyze current posting patterns        [complete]
  2. Research trending topics in your niche   [complete]
  3. Draft 5 tweets for review               [in_progress]
  4. Schedule optimal posting times           [pending]
  5. Monitor engagement metrics weekly        [recurring]
```

Tools: `goal_create`, `goal_list`, `goal_update`, `goal_delete`

### Self-Initiative

After completing a goal subtask, TITAN checks for the next ready task. In autonomous mode, it starts working immediately. In supervised mode, it proposes the next action. Rate-limited to prevent runaway execution.

### Autonomy Modes

| Mode | Behavior |
|------|----------|
| `autonomous` | Full auto — executes all tools, auto-triggers deliberation, self-initiates goal subtasks |
| `supervised` | Asks before dangerous operations, proposes next steps (default) |
| `locked` | Asks permission for every tool call |

```bash
titan config set autonomy.mode supervised
```

### Deliberative Reasoning

When TITAN detects an ambitious request, it enters a multi-stage loop:

1. **Analyze** — Examines the request from multiple angles using high thinking
2. **Plan** — Generates a structured, dependency-aware execution plan
3. **Approve** — Presents the plan for your review
4. **Execute** — Runs each step, reporting progress via WebSocket
5. **Adapt** — Re-analyzes and adjusts if a step fails

```bash
/plan figure out how to monetize this homelab     # Force deliberation
/plan status                                        # Check progress
/plan cancel                                        # Abort
```

---

## Self-Improvement

This is the big one. TITAN doesn't just run tasks — it **makes itself better at running tasks**. Autonomously. While you sleep.

Inspired by [Karpathy's autoresearch pattern](https://github.com/karpathy/autoresearch), TITAN runs experiments on itself: propose a change, evaluate it, keep it if it's better, discard it if it's not. Rinse, repeat, forever.

### How It Works

1. TITAN picks an improvement area (prompts, tool selection, response quality, error recovery)
2. Runs a **baseline eval** — sends test cases to itself, scores responses with an LLM-as-judge
3. Proposes a modification to the target prompt/config (via LLM-guided search/replace)
4. Runs the eval again with the change applied
5. **Keeps** the change if the score improved, **discards** it if it didn't
6. Logs everything to `~/.titan/self-improve/results/`

### Improvement Areas

| Area | What Gets Optimized | Eval Metric |
|------|-------------------|-------------|
| **Prompts** | System prompt wording and structure | Response quality score (0-100) |
| **Tool Selection** | Tool descriptions and routing logic | Correct tool chosen (% accuracy) |
| **Response Quality** | Response style, conciseness, accuracy | User satisfaction proxy score |
| **Error Recovery** | Retry strategies, fallback behavior | Recovery success rate |

### Local Model Training

Got a GPU? TITAN can **fine-tune its own local models** using your conversation history. Two training pipelines are available:

| Pipeline | Model Name | Training Data | Purpose |
|----------|-----------|---------------|---------|
| **Tool Router** | `titan-qwen` | Single-turn instruction → tool selection pairs | Fast tool routing for TITAN's brain/router |
| **Main Agent** | `titan-agent` | Multi-turn ChatML conversations with OpenAI function calling | Full agent behavior — reasoning, tool use, error recovery |

**Tool Router** training uses compact instruction/output pairs to teach the model which tool to call. **Main Agent** training uses 530+ multi-turn conversation examples covering tool calling, direct answers, error recovery, multi-step chains, and identity — all in OpenAI function calling format.

Both pipelines are fully configurable from Mission Control's Self-Improve panel:
- **Base model** (e.g., `unsloth/Qwen2.5-32B-bnb-4bit`)
- **LoRA rank** (8–128)
- **Learning rate** (1e-5 – 1e-3)
- **Epochs** (1–10)
- **Time budget** (5–120 minutes)
- **Max sequence length** (512–8192)

Training tools:

1. `train_prepare` — Extracts high-quality training data from session history
2. `train_start` — Launches LoRA fine-tuning via unsloth on your GPU (background process, budget-limited)
3. `train_status` — Monitor training progress (loss, epoch, ETA)
4. `train_deploy` — Converts to GGUF, imports to Ollama, optionally switches TITAN's active model

Works with any GPU that can run unsloth. Tested with Qwen 3.5 35B.

### Schedule & Config

Everything is configurable from Mission Control's Self-Improvement panel or `titan.json`:

```json
{
  "selfImprove": {
    "enabled": true,
    "runsPerDay": 4,
    "schedule": ["0 2 * * *", "0 8 * * *", "0 14 * * *", "0 20 * * *"],
    "budgetMinutes": 30,
    "areas": ["prompts", "tool-selection", "response-quality", "error-recovery"],
    "autoApply": true,
    "maxDailyBudgetMinutes": 120,
    "pauseOnWeekends": false
  }
}
```

Or let autopilot handle it — set `autopilot.mode: "self-improve"` and TITAN runs experiments on the configured schedule automatically.

### Tools

| Tool | What It Does |
|------|-------------|
| `self_improve_start` | Launch an improvement session targeting a specific area |
| `self_improve_status` | Check current session progress |
| `self_improve_apply` | Apply successful experiment results to live config |
| `self_improve_history` | View history of all improvement sessions and outcomes |
| `train_prepare` | Curate training data from conversation history |
| `train_start` | Launch LoRA fine-tuning job on GPU |
| `train_status` | Monitor training progress |
| `train_deploy` | Convert model to GGUF and import to Ollama |

---

## Mission Control

**Mission Control v2** — a ChatGPT-style React 19 SPA at `http://localhost:48420`. Built with Vite, Tailwind CSS 4, and React Router v7.

| Panel | What It Does |
|-------|-------------|
| **Chat** | ChatGPT-style real-time chat with SSE token streaming, markdown rendering, syntax highlighting |
| **Overview** | System health, uptime, memory usage, model info, cost stats |
| **Agents** | Spawn, stop, and monitor up to 5 agent instances |
| **Settings** | 6-tab live config: AI, Providers, Channels, Security, Gateway, Profile |
| **Channels** | Connection status for all 15 channel adapters |
| **Skills** | 117 loaded skills with per-skill enable/disable toggles |
| **Sessions** | Active sessions with message counts and history |
| **Learning** | Tool success rates and knowledge base stats |
| **Autopilot** | Schedule, status, history, and run control |
| **Security** | Audit log viewer and DM pairing management |
| **Logs** | Color-coded real-time log viewer with filtering |
| **Mesh** | Peer management — approve, reject, revoke connections |
| **Memory Graph** | Visual force-directed graph of entities and relationships |
| **Integrations** | 12 provider API key management + Google OAuth connection manager |
| **Workflows** | Goals, Cron jobs, Recipes, and Autopilot — full workflow engine with YAML export/import |
| **Self-Improve** | Autonomous improvement sessions, dual training pipelines (Tool Router / Main Agent), customizable hyperparameters, training data generation, model deployment, schedule config |
| **Personas** | Create and switch between agent personality profiles |
| **Telemetry** | Prometheus metrics — request counts, latency, token usage |
| **Daemon** | Persistent agent awareness loop — health monitoring, event-driven subtask triggers |
| **Command Post** | Paperclip-style agent governance — 7 tabs: dashboard with pixel crew, org chart, issue/ticket board (TIT-1), agent registry with runs, approvals (hire/budget gates), budget meters, management console |
| **Audit** | Security audit log viewer with HMAC-chain integrity verification |
| **MCP** | MCP Server management — expose TITAN tools to other agents via JSON-RPC |
| **NVIDIA** | GPU skills — cuOpt, AI-Q, VRAM orchestrator, OpenShell sandbox |
| **Files** | Workspace file browser for `~/.titan/` directory |
| **Autoresearch** | Autonomous model fine-tuning research pipeline |

The legacy dashboard is still available at `/legacy`.

Settings includes a SOUL.md live editor (Profile tab) and Google OAuth connection manager (Providers tab). All changes take effect without restarting the gateway.

### Distributed Setup

TITAN supports split-machine deployments — run the gateway on a low-power node (e.g., Raspberry Pi 5) and route inference to a GPU machine (e.g., a desktop with an RTX GPU running Ollama). Configure via environment variables in `docker-compose.yml`:

```bash
# On your Pi 5 / Mini PC (gateway)
OLLAMA_BASE_URL=http://<gpu-machine-ip>:11434  # Points to GPU machine

# On your GPU PC
ollama serve  # Exposes models on the LAN
```

---

## Channels

TITAN connects to 15 messaging platforms. All support the DM pairing security system.

| Channel | Library | Notes |
|---------|---------|-------|
| **Discord** | discord.js | Full bot integration |
| **Telegram** | grammY | Bot API with webhook support |
| **Slack** | @slack/bolt | Workspace app integration |
| **WhatsApp** | Baileys | No official API needed |
| **Microsoft Teams** | botbuilder | Enterprise integration |
| **Google Chat** | Webhooks | Real webhook-based adapter |
| **Matrix** | matrix-js-sdk | Decentralized chat support |
| **Signal** | signal-cli REST | Privacy-focused messaging |
| **WebChat** | Built-in WebSocket | Included in Mission Control |
| **IRC** | irc-framework | Any IRC network |
| **Mattermost** | API client | Self-hosted team chat |
| **Lark/Feishu** | API client | Enterprise messaging (ByteDance) |
| **Email (IMAP)** | IMAP/SMTP | Inbound email monitoring |
| **LINE** | LINE Messaging API | Popular in Asia-Pacific |
| **Zulip** | API client | Open-source team chat |

Configure via `~/.titan/titan.json` or the Mission Control Settings panel.

---

## Providers

36 AI providers. Add your API key and go. TITAN routes, fails over, and load-balances automatically with configurable fallback chains.

| Provider | Type | Notable Models |
|----------|------|----------------|
| **Anthropic** | Native | Claude Opus 4, Sonnet 4, Haiku 4 |
| **OpenAI** | Native | GPT-4o, GPT-4o-mini, o1, o3-mini |
| **Google** | Native | Gemini 2.5 Pro/Flash, 2.0 Flash |
| **Ollama** | Native | Any locally installed model |
| **Groq** | OpenAI-compat | LLaMA 3.3 70B, Mixtral, DeepSeek-R1 Distill |
| **Mistral** | OpenAI-compat | Mistral Large, Codestral, Nemo |
| **OpenRouter** | OpenAI-compat | 290+ models from all providers |
| **Together** | OpenAI-compat | LLaMA 3.3, DeepSeek-R1, Qwen 2.5 |
| **Fireworks** | OpenAI-compat | LLaMA 3.3, Mixtral, Qwen 3 |
| **xAI** | OpenAI-compat | Grok-3, Grok-3-fast, Grok-3-mini |
| **DeepSeek** | OpenAI-compat | DeepSeek Chat, DeepSeek Reasoner |
| **Cerebras** | OpenAI-compat | LLaMA 3.3, Qwen 3 |
| **Cohere** | OpenAI-compat | Command-R+, Command-R |
| **Cohere v2** | OpenAI-compat | Command-R+ v2 with tool use |
| **Perplexity** | OpenAI-compat | Sonar, Sonar Pro, Sonar Reasoning |
| **Venice AI** | OpenAI-compat | LLaMA 3.3 70B, DeepSeek-R1 671B |
| **AWS Bedrock** | OpenAI-compat | Claude, Titan Text, LLaMA 3 (via proxy) |
| **LiteLLM** | OpenAI-compat | Any model via universal proxy |
| **Azure OpenAI** | OpenAI-compat | GPT-4o, GPT-4o-mini, o1 |
| **DeepInfra** | OpenAI-compat | LLaMA 3.3, Mixtral 8x22B, Qwen 2.5 |
| **SambaNova** | OpenAI-compat | LLaMA 3.3, DeepSeek-R1 Distill |
| **Kimi** | OpenAI-compat | Kimi K2.5 |
| **HuggingFace** | OpenAI-compat | Inference API models |
| **AI21** | OpenAI-compat | Jamba 1.5 |
| **Reka** | OpenAI-compat | Reka Core, Flash |
| **Zhipu** | OpenAI-compat | GLM-4 |
| **Yi/01.AI** | OpenAI-compat | Yi-34B, Yi-Lightning |
| **Inflection** | OpenAI-compat | Pi |
| **Nous Research** | OpenAI-compat | Hermes |
| **Replicate** | OpenAI-compat | Run any model via API |
| **Novita** | OpenAI-compat | LLaMA, Mistral variants |
| **Lepton** | OpenAI-compat | LLaMA 3.3, Mixtral |
| **Anyscale** | OpenAI-compat | LLaMA, Mistral variants |
| **OctoAI** | OpenAI-compat | LLaMA, Mixtral variants |
| **NVIDIA NIM** | OpenAI-compat | Nemotron Super 49B, Ultra 253B, Nano 30B |
| **MiniMax** | OpenAI-compat | M2.7 (2.3T MoE, 200K ctx), M2.5, M1 |

**4 native providers** with full API integration. **32 OpenAI-compatible providers** through a unified adapter. All 36 support automatic failover with configurable fallback chains — if your primary model goes down, TITAN cascades to the next one automatically.

```bash
titan model --discover                              # Live-detect all available models
titan model --set anthropic/claude-sonnet-4-20250514
titan model --alias fast=openai/gpt-4o-mini         # Create shortcuts
```

Built-in aliases: `fast`, `smart`, `cheap`, `reasoning`, `local` — fully configurable.

> Running locally? See [docs/MODELS.md](docs/MODELS.md) for GPU-tiered Ollama model recommendations.

---

## Model Benchmark

We benchmark every Ollama cloud and local model through TITAN's gateway across 7 categories: reasoning, code, math, tool use, instruction following, creative writing, and summarization. **March 2026 results:**

| # | Model | Score | Grade | Latency | Type | Best For |
|---|-------|-------|-------|---------|------|----------|
| 1 | **GLM-5** | 8.5/10 | A- | 12.3s | ☁️ cloud | Code generation, summarization |
| 2 | **Devstral Small 2** | 8.5/10 | A- | 5.3s | 💻 local (15GB) | Code generation, reasoning |
| 3 | **Qwen3 Coder Next** | 8.4/10 | B+ | 3.5s | ☁️ cloud | Tool use (perfect 10), fastest cloud |
| 4 | **GLM-4.7** | 8.4/10 | B+ | 16.1s | ☁️ cloud | Code generation, creative writing |
| 5 | **Qwen 3.5 35B** | 8.3/10 | B+ | 11.7s | 💻 local (23GB) | Tool use, code generation |
| 6 | **Nemotron 3 Nano 24B** | 8.3/10 | B+ | 7.0s | 💻 local (24GB) | Tool use, creative writing |
| 7 | **Nemotron 3 Nano 4B** | 8.3/10 | B+ | 2.3s | 💻 local (2.8GB) | 🏆 Best value — full B+ at 2.8GB |
| 8 | **MiniMax M2** | 8.3/10 | B+ | 10.2s | ☁️ cloud | Tool use (perfect 10) |
| 9 | **Nemotron 3 Super** | 8.2/10 | B+ | 13.0s | ☁️ cloud | Math, tool use |
| 10 | **Kimi K2.5** | 8.2/10 | B+ | 12.4s | ☁️ cloud | Tool use (perfect 10) |
| 11 | **Qwen 3.5 397B** | 8.0/10 | B+ | 9.4s | ☁️ cloud | Code generation, creative writing |
| 12 | **MiniMax M2.7** | 7.9/10 | B | 24.8s | ☁️ cloud | Code generation, creative writing |
| 13 | **DeepSeek V3.1 671B** | 7.7/10 | B | 8.9s | ☁️ cloud | Code generation, creative writing |
| 14 | **DeepSeek V3.2** | 7.6/10 | B | 22.8s | ☁️ cloud | Code, creative — weak tool use |
| 15 | **Gemini 3 Flash Preview** | 7.6/10 | B | 4.9s | ☁️ cloud | Code, fast — tool use errors |

**Key takeaways:**
- 🥇 **GLM-5** is the top overall model — strong across every category
- 🏆 **Nemotron 3 Nano 4B** is the best value play — B+ grade at only 2.8GB VRAM and 2.3s latency
- ⚡ **Qwen3 Coder Next** is the fastest cloud model with perfect tool use
- 💻 All 4 local models scored B+ — you don't need cloud APIs for great results

> 📊 Full per-category breakdown: [benchmarks/MODEL_COMPARISON.md](benchmarks/MODEL_COMPARISON.md)

---

## Voice (LiveKit WebRTC)

TITAN's real-time voice uses [LiveKit](https://livekit.io/) — a production-grade WebRTC platform that handles echo cancellation, NAT traversal, codec negotiation, and jitter buffering. No custom audio pipelines, no PCM-over-WebSocket hacks.

**How it works:**
1. Click "Start Voice" in Mission Control
2. TITAN fetches a scoped JWT token (`POST /api/livekit/token`)
3. Browser connects to a LiveKit room via WebRTC
4. LiveKit's agent worker bridges STT → TITAN's agent brain → TTS
5. You talk, TITAN responds — sub-second latency, full duplex

**Deployment options:**
- **LiveKit Cloud** — zero infrastructure, set `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
- **Self-hosted** — run `livekit-server` on your own hardware

**Voice Cloning (F5-TTS):** Upload a 3-5 second audio sample and TITAN clones the voice for TTS. Uses F5-TTS on GPU with zero-shot cloning — no training needed. Manage voices from Mission Control Settings panel. Auto-preprocessing normalizes audio to -23 LUFS.

The file-based voice tools (`generate_speech`, `transcribe_audio`) still work independently via the OpenAI API for offline use cases.

---

## Mesh Networking

Connect up to 5 machines so they share AI models and API keys. One machine has a GPU? The others can use its local models. One machine has an OpenAI key? Everyone benefits.

TITAN finds your other machines automatically via mDNS on your local network, or via Tailscale if they're remote.

### Quick Setup

**Machine 1** (your GPU desktop):
```bash
titan mesh --init         # Generates a secret: TITAN-a1b2-c3d4-e5f6
titan gateway
```

**Machine 2** (your laptop):
```bash
titan mesh --join "TITAN-a1b2-c3d4-e5f6"
titan gateway
```

Machine 2 discovers Machine 1 automatically. You approve the connection (or enable `--auto-approve`), and both machines now share all available models.

### How Routing Works

1. **Local first** — If your machine has the model, it runs locally
2. **Mesh fallback** — If not, TITAN checks connected peers
3. **Provider failover** — Last resort, tries other local providers

### Approval System

New peers are quarantined until approved. Manage from CLI or the Mesh dashboard panel:

```bash
titan mesh --pending                    # See who's waiting
titan mesh --approve <nodeId>           # Allow connection
titan mesh --reject <nodeId>            # Deny connection
titan mesh --revoke <nodeId>            # Disconnect an approved peer
titan mesh --auto-approve               # Trust all peers with your secret
```

Approved peers persist to `~/.titan/approved-peers.json` and reconnect automatically on restart.

### Remote Machines (Tailscale)

```json
{
  "mesh": {
    "enabled": true,
    "tailscale": true
  }
}
```

Or add static peers manually: `titan mesh --add "<peer-ip>:48420"`

---

## MCP Server Mode

TITAN can act as an **MCP server**, exposing all 220+ tools to other AI agents via the [Model Context Protocol](https://modelcontextprotocol.io/). Claude Code, Cursor, Windsurf, or any MCP client can connect and use TITAN's tools.

**HTTP transport** (runs on the gateway port):
```json
// titan.json
{ "mcp": { "server": { "enabled": true } } }
```
Then any MCP client can connect to `http://localhost:48420/mcp`.

**Stdio transport** (launch TITAN as a subprocess):
```json
// claude_desktop_config.json or .cursor/mcp.json
{
  "mcpServers": {
    "titan": {
      "command": "npx",
      "args": ["titan-agent", "mcp-server"]
    }
  }
}
```

Security: MCP server respects the same `security.deniedTools` and `security.allowedTools` config as the gateway.

---

## Sandbox Code Execution

When the LLM needs to run complex logic — loops, data processing, batch operations — it writes Python and executes it in an isolated Docker container. Tool calls from inside the sandbox route through a secure HTTP bridge back to TITAN.

```
Traditional approach: 50 individual tool calls x LLM round-trips = bloated context + slow
Sandbox approach:     1 Python script with a for-loop = fast, accurate, minimal tokens
```

The LLM writes code like this:
```python
from tools import web_search, read_file

results = []
for topic in ["AI agents", "LLM tools", "code sandbox"]:
    data = web_search(query=topic)
    results.append(data)

print(f"Found {len(results)} results")
```

**Security:** Containers run with `--cap-drop=ALL`, `--read-only`, `--security-opt=no-new-privileges`, memory/CPU limits, and session-token authenticated bridge. Dangerous tools (`shell`, `exec`, `process`) are blocked inside the sandbox.

```json
{
  "sandbox": {
    "engine": "docker",
    "enabled": true,
    "timeoutMs": 60000,
    "memoryMB": 512,
    "deniedTools": ["shell", "exec", "code_exec", "process", "apply_patch"]
  }
}
```

**Alternative: NVIDIA OpenShell** — For NVIDIA GPU machines, set `"engine": "openshell"` to use K3s-based sandboxes with declarative YAML security policies. Requires `TITAN_NVIDIA=1`.

---

## Built-in Tools

117 loaded skills exposing 220+ tools. All individually toggleable from Mission Control.

| Category | Tools |
|----------|-------|
| **Shell & Process** | `shell`, `exec`, `process` (list, kill, spawn, poll, log) |
| **Filesystem** | `read_file`, `write_file`, `edit_file`, `list_dir`, `apply_patch` |
| **Web** | `web_search`, `web_fetch`, `web_read`, `web_act`, `smart_form_fill`, `browser` (CDP), `browse_url`, `browser_search`, `browser_auto_nav` |
| **Intelligence** | `auto_generate_skill`, `analyze_image`, `transcribe_audio`, `generate_speech` |
| **GitHub** | `github_repos`, `github_issues`, `github_prs`, `github_commits`, `github_files` |
| **Email** | `email_send`, `email_search`, `email_read`, `email_list` (Gmail OAuth + SMTP) |
| **Computer Use** | `screenshot`, `mouse_click`, `mouse_move`, `keyboard_type`, `keyboard_press`, `screen_read` |
| **Data & Documents** | `data_analysis`, `csv_parse`, `csv_stats`, `pdf_read`, `pdf_info` |
| **Smart Home** | `ha_devices`, `ha_control`, `ha_status` |
| **Image Generation** | `generate_image`, `edit_image` |
| **Weather** | `weather` (real-time via wttr.in, no API key) |
| **Automation** | `cron`, `webhook` |
| **Memory** | `memory`, `switch_model`, `graph_remember`, `graph_search`, `graph_entities`, `graph_recall` |
| **Sandbox** | `code_exec` (Python/JS in isolated Docker with tool bridge) |
| **Meta** | `tool_search` (discover tools on demand), `plan_task` (deliberative planning) |
| **Sessions** | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_close` |
| **Income Tracking** | `income_log`, `income_summary`, `income_list`, `income_goal` |
| **Freelance** | `freelance_search`, `freelance_match`, `freelance_draft`, `freelance_track` |
| **Content** | `content_research`, `content_outline`, `content_publish`, `content_schedule` |
| **Lead Gen** | `lead_scan`, `lead_score`, `lead_queue`, `lead_report` |
| **Goals** | `goal_create`, `goal_list`, `goal_update`, `goal_delete` |
| **X/Twitter** | `x_post`, `x_reply`, `x_search`, `x_review` |
| **Self-Improvement** | `self_improve_start`, `self_improve_status`, `self_improve_apply`, `self_improve_history` |
| **Model Training** | `train_prepare`, `train_start`, `train_status`, `train_deploy` (LoRA fine-tuning → GGUF → Ollama) |
| **Sub-Agents** | `spawn_agent` (delegate to isolated sub-agents) |
| **NVIDIA GPU** | `nvidia_cuopt_solve`, `nvidia_cuopt_health`, `nvidia_aiq_research` (requires `TITAN_NVIDIA=1`) |
| **VRAM Management** | `vram_status`, `vram_acquire`, `vram_release` (auto-swap models for GPU services) |

### Tool Search — Compact Mode

TITAN doesn't dump all 209 tool schemas into every LLM call. It sends only 9 core tools plus `tool_search`. When the LLM needs a capability, it calls `tool_search("email")` and gets the relevant tools added dynamically.

```
Before: 220+ tools x ~50 tokens each = ~10,450 input tokens
After:  10 core tools + tool_search  = ~700 input tokens (93% reduction)
```

Works with all 36 providers. Especially beneficial for cloud models and smaller local models where context window is precious.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `titan onboard` | Interactive setup wizard (profile, soul, provider, autonomy) |
| `titan gateway` | Start Mission Control + API server |
| `titan agent -m "..."` | Send a message from the terminal |
| `titan send --to ch:id -m "..."` | Message a specific channel |
| `titan model --list` | Show all configured models |
| `titan model --discover` | Live-detect available models |
| `titan model --set <model>` | Switch the active model |
| `titan model --alias <name>=<model>` | Create a model alias |
| `titan agents` | Multi-agent management (spawn, stop, list) |
| `titan mesh --init` | Initialize mesh networking |
| `titan mesh --status` | View peers, pending, and shared models |
| `titan mesh --pending` | Show peers waiting for approval |
| `titan mesh --approve <id>` | Approve a discovered peer |
| `titan mesh --reject <id>` | Reject a pending peer |
| `titan mesh --revoke <id>` | Disconnect an approved peer |
| `titan mesh --auto-approve` | Toggle auto-approve mode |
| `titan skills` | List installed skills |
| `titan skills --create "..."` | Generate a skill with AI |
| `titan skills --scaffold --name <n> --format js\|ts\|yaml` | Scaffold a skill project from template |
| `titan create-skill <name>` | Alias for skill scaffolding |
| `titan skills --test <name>` | Test a skill with sample arguments |
| `titan mcp-server` | Launch as stdio MCP server for external clients |
| `titan teams` | List teams |
| `titan teams --create <name>` | Create a new team |
| `titan teams --info <teamId>` | Show team details and members |
| `titan teams --add-member <teamId> --user <id> --role <role>` | Add a team member |
| `titan teams --invite <teamId>` | Generate invite code |
| `titan teams --join <code>` | Join a team via invite |
| `titan teams --set-role <teamId> --user <id> --role <role>` | Change member role |
| `titan pairing` | Manage DM access control |
| `titan doctor` | System diagnostics |
| `titan doctor --fix` | Auto-fix detected issues |
| `titan vault` | Manage encrypted secrets vault |
| `titan config [key]` | View/edit configuration |
| `titan graphiti --init` | Initialize knowledge graph |
| `titan graphiti --stats` | Graph statistics |
| `titan mcp` | Manage MCP servers (client + server mode) |
| `titan recipe --list` | List and run saved recipes |
| `titan monitor` | Manage proactive monitors |
| `titan autopilot --init` | Create AUTOPILOT.md checklist |
| `titan autopilot --run` | Trigger immediate autopilot run |
| `titan autopilot --enable` | Toggle autopilot scheduling |
| `titan autopilot --status` | View schedule and last run info |
| `titan update` | Update to latest version |

---

## Custom Skills

Create new tools in seconds. Use the scaffolding CLI or drop files into `~/.titan/skills/`:

### Scaffold a Skill (Recommended)

```bash
# Generate a full skill project with template, metadata, and tests
titan create-skill my_tool --format ts

# Or use the long form
titan skills --scaffold --name my_tool --format js --description "Fetches data" --author "Your Name"

# Test your skill
titan skills --test my_tool
```

This creates `~/.titan/skills/my_tool/` with the skill source, `SKILL.md` metadata, and a test file.

### YAML (Easiest)

```yaml
# ~/.titan/skills/word_count.yaml
name: word_count
description: Count words, lines, and characters in a file
parameters:
  filePath:
    type: string
    description: Path to the file
    required: true
script: |
  const fs = require('fs');
  const content = fs.readFileSync(args.filePath, 'utf-8');
  const lines = content.split('\n').length;
  const words = content.split(/\s+/).filter(Boolean).length;
  return 'Lines: ' + lines + ', Words: ' + words + ', Characters: ' + content.length;
```

### JavaScript

```javascript
// ~/.titan/skills/hello.js
export default {
  name: 'hello',
  description: 'Greet someone by name',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet' }
    },
    required: ['name']
  },
  execute: async (args) => `Hello, ${args.name}!`
};
```

### AI-Generated

```bash
titan skills --create "a tool that converts CSV files to JSON"
```

TITAN writes, compiles, and hot-loads the skill instantly.

---

## Security

Defense-in-depth, not "we'll add auth later."

| Layer | What It Does |
|-------|-------------|
| **Prompt Injection Shield** | Two-layer detection — heuristic engine + keyword density analysis |
| **DM Pairing** | New senders quarantined until approved |
| **Sandbox** | Docker isolation with `--cap-drop=ALL`, read-only filesystem, memory limits |
| **Secrets Vault** | AES-256-GCM encrypted credential store with PBKDF2 key derivation |
| **Audit Log** | HMAC-SHA256 chained tamper-evident JSONL trail |
| **E2E Encryption** | AES-256-GCM per-session encryption, keys held in memory only |
| **Tool Allowlists** | Configurable per-agent tool permissions |
| **Network Allowlists** | Configurable outbound connection boundaries |
| **Autonomy Gates** | Risk classification with human-in-the-loop approval |

---

## Memory Systems

| System | Storage | Purpose |
|--------|---------|---------|
| **Episodic** | `~/.titan/titan-data.json` | Conversation history per session |
| **Learning** | `~/.titan/knowledge.json` | Tool success/failure rates, error patterns, resolutions |
| **Relationship** | `~/.titan/profile.json` | User preferences, work context, personal continuity |
| **Temporal Graph** | `~/.titan/graph.json` | Entities, episodes, relationships — searchable across time |

The temporal graph is pure TypeScript — no Neo4j, no Docker, no external services. Entities are extracted from conversations automatically, linked with timestamps, and injected into every system prompt.

---

## Development

```bash
npm run build          # tsup ESM production build
npm run test           # vitest (4,500+ tests across 154 files)
npm run test:coverage  # ~82% line coverage
npm run ci             # typecheck + full test suite
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run dev:gateway    # Dev mode with tsx hot-reload
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide and [ARCHITECTURE.md](ARCHITECTURE.md) for the codebase layout.

---

## Roadmap

### Current (v1.2.x)

- **v1.2.1** (April 7, 2026): **Agent Pipeline Overhaul** — 15-layer tool calling defense, Plan Mode, 10 new skills, 40 engineering personas, OpenClaw-style sidebar, multi-agent PixelOffice, Agent Eval Framework. 45 commits.
- **v1.2.0** (April 6, 2026): **Gemma 4 Support** — Google-spec sampling, coding enforcement, write_file guards, LLM session titles.
- **v1.1.0** (April 4, 2026): **Command Post Governance** — Budget enforcement, E2E tests, type safety.
- **v1.0.0** (April 1, 2026): **Semver Migration** — Multi-agent architecture rewrite.

### Previous (v2026.10.x)

- **v2026.10.45**: **MiniMax M2.7 + Autopilot Dry-Run** — New MiniMax provider (M2.7, 2.3T MoE, 200K context, provider #32). Community PR: autopilot dry-run mode by @sastarogers. 36 providers, 4,329 tests.
- **v2026.10.43**: **VRAM Orchestrator** — Automatic GPU VRAM management for RTX 5090. Monitors GPU via nvidia-smi, tracks Ollama model loads, auto-swaps to smaller models when GPU services need memory. Time-bounded leases with auto-expiry, async mutex for serialization, emergency OOM unload. 3 agent tools, 4 API endpoints, config schema.
- **v2026.10.42**: **NVIDIA GPU Skills** — cuOpt v26.02 async VRP optimization (tested live, 74ms solve), AI-Q deep research via Nemotron Super NIM API, OpenShell K3s sandbox engine. NVIDIA skill loader gated behind `TITAN_NVIDIA=1`. Voice mic leak fix. 6 TypeScript fixes.
- **v2026.10.41**: **Hotfix** — Tool visibility fix (security.allowedTools default), OpenAI-compat keepModelPrefix bug, voice system prompt rewrite, voice core tools, voice model override, HA debug logging.
- **v2026.10.40**: **9 New Skills** — Structured output, workflow engine, social scheduler, agent handoff, event triggers, knowledge base, eval framework, approval gates, A2A protocol. 2 critical security fixes. 4,500+ tests across 154 files.
- **v2026.10.39**: **Security Release** — Resolved all 23 Dependabot alerts, 0 vulnerabilities.
- **v2026.10.28**: **Bug Fixes** — Vector search circular dependency fixed (`initVectors` now calls Ollama `/api/embed` directly instead of `embed()` which was gated on `available=false` during init, causing RAG to never initialize). ActiveLearning no-op fixed (no longer records "use X instead of X" when same tool succeeds on retry). ESLint prefer-const fix.
- **v2026.10.27**: **System Prompt Architecture Overhaul** — Complete redesign of how TITAN instructs AI models to use tools reliably. Tool Execution rules now appear first in the system prompt (before identity/capabilities). ReAct loop (Reason→Act→Observe) taught to every model. MUST/NEVER directives and negative examples (wrong vs. right behavior) burn in correct tool-call patterns. Task-aware dynamic injection appends `[TASK ENFORCEMENT]` blocks for file-write, research, and shell tasks detected in the message. API-level `tool_choice: "required"` added for OpenAI/Ollama and `tool_choice: {type: "any"}` for Anthropic on enforced first rounds. Ollama cloud prompt compression fixed — tool enforcement rules now survive compression (limit raised 2000→3500 chars). All 11 sub-agent templates (Explorer, Coder, Browser, Analyst, Researcher, Reporter, Fact Checker, Dev Debugger, Dev Tester, Dev Reviewer, Dev Architect) rewritten with tool-specific guidance, MUST rules, and output format requirements. New `agent.forceToolUse` config flag.
- **v2026.10.26**: **Live Training Feed** — Real-time SSE streaming of training progress in Self-Improvement panel, incremental training data writes (data survives tool timeouts), cloud-assisted training pipeline
- **v2026.10.22**: **Voice System Hardening** — 24 bug fixes across voice, gateway, and agent core. VoiceOverlay rewrite (stale closure fixes, AbortController cleanup, session continuity, emotion tag stripping). FluidOrb canvas rewrite (single animation loop, no 60fps teardown). Gateway SSE leak fix, TTS health probe fix, Ollama context 8K→16K, internal health monitor (Ollama/TTS/memory watchdog), fetchWithRetry timeout, systemd service unit, log rotation. 91 loaded skills, 220+ tools, 3,839 tests across 123 files.
- **v2026.10.21**: **Dual Training Pipelines** — Tool Router (single-turn tool selection) and Main Agent (multi-turn ChatML with OpenAI function calling) training modes. Self-Improve panel training type selector with fully customizable hyperparameters (base model, LoRA rank, learning rate, epochs, time budget, max sequence length). Training data generation, model deployment, and benchmarking from the UI. Ollama provider context management fix (prevents context over-allocation). New API endpoints: generate-data, deploy, type-filtered results.
- **v2026.10.20**: **Autonomous Self-Improvement** — TITAN experiments on its own prompts, tool selection, response quality, and error recovery using LLM-as-judge evaluation. LoRA fine-tuning pipeline (unsloth → GGUF → Ollama) for local model training on GPU. Configurable schedule (1–12 runs/day), budget caps, auto-apply, weekend pause. Mission Control Self-Improvement panel. Autopilot `self-improve` mode. 8 new tools, 149 total tools, 91 skills, 3,839 tests across 123 files.
- **v2026.10.17**: CapSolver CAPTCHA solving, direct form-fill API, deferred button clicks, React-compatible form automation
- **v2026.10.10**: Integrations panel (12 provider API keys + Google OAuth), Workflows panel (Goals, Cron, Recipes, Autopilot), autonomous persona, research pipeline with autoresearch, TopFacts context plugin, checkpoint/resume, 17 admin panels, 117 tools, 82 skills, 3,691 tests across 114 files
- **v2026.10.4**: Onboarding wizard, system_info tool, tool discovery fix, polished Mission Control
- **v2026.10.0**: Mission Control v2 — React 19 SPA with ChatGPT-style chat, distributed setup support, voice health endpoint, THIRD_PARTY_NOTICES.md
- **v2026.9.6**: Version sync fix, mini PC deployment update
- **v2026.9.5**: Visual Workflow Builder — drag-and-drop recipe editor, YAML export/import, node-graph canvas, 7 API endpoints
- **v2026.9.4**: One-Line Install, Cloud Deploy (Railway/Render/Replit), optimized Dockerfile
- **v2026.9.2**: Team Mode with RBAC — 4 roles, invite system, per-role tool permissions, 14 API endpoints
- **v2026.9.1**: Plugin SDK + Skill Scaffolding — CLI templates for JS/TS/YAML skill development
- **v2026.9.0**: MCP Server Mode — expose all tools via Model Context Protocol, LiveKit Voice Integration

### Previous (v2026.7.x–8.x)

- **v2026.8.0**: ContextEngine plugins, Prometheus metrics, 30 OpenAI-compat provider presets, 6 new channels (15 total), fallback model chains, deep research agent
- **v2026.7.0**: RAG/Vector Search (FTS5 + embeddings), token streaming (SSE + WebSocket), adaptive teaching system, memory importance scoring

### Previous (v2026.5.x–6.x)

- **v2026.6.7**: Autonomy Overhaul — reflection, sub-agents, orchestrator, goals, initiative, shared browser pool, Stagehand, X/Twitter
- **v2026.6.0**: Tool Search, Sandbox Code Execution, Deliberative Reasoning
- **v2026.5.17**: Skills Marketplace, dynamic model dropdown
- **v2026.5.4–5.16**: Secrets vault, audit log, autopilot, mesh networking, income skills

### What's Next

**Q2 2026 Priorities:**
- Plugin marketplace for third-party skills
- Cloud sandbox VMs with full Computer Use
- Fast codebase indexing (15K files in <8s)
- Cost-optimized model routing
- Harbor/SWE-bench benchmark submissions
- Zapier/Make.com integration

Sponsors vote on the roadmap. See [TITAN Insiders](https://github.com/TITANframework/TITAN-insiders) for early access and feature voting.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

```bash
git clone https://github.com/Djtony707/TITAN.git && cd TITAN
npm install
npm run dev:gateway
```

We don't bite. Unless you submit a PR that adds `is-even` as a dependency.

### Contributors

Thanks to everyone who has contributed to TITAN:

| Contributor | Contribution |
|-------------|-------------|
| [Tony Elliott](https://github.com/Djtony707) | Creator & maintainer |
| [sastarogers](https://github.com/sastarogers) | Autopilot dry-run mode ([#7](https://github.com/Djtony707/TITAN/pull/7)) |

---

## Acknowledgments

### Architectural Inspiration

- **[OpenClaw](https://github.com/openclaw/openclaw)** by [Peter Steinberger](https://github.com/steipete) — TITAN's architecture, CLI surface, tool signatures, workspace layout (AGENTS.md, SOUL.md, TOOLS.md), and DM pairing system are inspired by OpenClaw. Licensed under MIT.

### Agent Governance

- **[Paperclip](https://github.com/paperclipai/paperclip)** by [Paperclip AI](https://github.com/paperclipai) — Command Post's atomic task checkout, budget enforcement, goal ancestry chains, agent registry, and activity feed patterns are inspired by Paperclip's control plane architecture. Licensed under MIT.

### Temporal Knowledge Graph

- **[Graphiti](https://github.com/getzep/graphiti)** by [Zep AI](https://www.getzep.com/) — Inspired the episodic memory and temporal graph approach. Licensed under Apache 2.0. Research paper: [arXiv:2501.13956](https://arxiv.org/abs/2501.13956).

### Voice Pipeline

- **[LiveKit](https://livekit.io/)** by [LiveKit, Inc.](https://github.com/livekit) — Production-grade WebRTC platform for real-time voice. Voice UI adapted from [agent-starter-react](https://github.com/livekit-examples/agent-starter-react). Licensed under MIT.

### Browser Automation

- **[Skyvern](https://github.com/Skyvern-AI/skyvern)** by [Skyvern AI](https://skyvern.com/) — AI browser automation via vision + LLMs. Licensed under AGPL-3.0 (separate service).
- **[CapSolver](https://www.capsolver.com/)** — REST API for solving reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile. Optional integration — configure via `capsolver` config section.

### Frontend (Mission Control v2)

- **[React 19](https://react.dev/)** — UI framework (MIT)
- **[Vite](https://vite.dev/)** — Build tool (MIT)
- **[Tailwind CSS 4](https://tailwindcss.com/)** — CSS framework (MIT)
- **[React Router v7](https://reactrouter.com/)** — Client-side routing (MIT)
- **[Lucide React](https://lucide.dev/)** — Icon library (ISC)
- **[Motion](https://motion.dev/)** — Animations (MIT)

### Open-Source Libraries

Express, Zod, Commander.js, ws, Chalk, Ora, Boxen, Inquirer, dotenv, node-cron, uuid, Playwright, jsdom, turndown, @mozilla/readability, bonjour-service, tsup, Vitest, TypeScript.

For the complete list, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## Support

If TITAN saves you time, consider sponsoring its development:

[![Sponsor on GitHub](https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github)](https://github.com/sponsors/Djtony707)

---

## Like TITAN?

If TITAN saved you time, taught you something, or just made you say *"wait, it can do that?"* — give it a star. It helps other developers find this project.

<p align="center">
  <a href="https://github.com/Djtony707/TITAN/stargazers"><img src="https://img.shields.io/github/stars/Djtony707/TITAN?style=for-the-badge&logo=github&label=Star%20on%20GitHub" alt="Star on GitHub"/></a>
</p>

---

## Disclaimer

TITAN IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS, COPYRIGHT HOLDERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

TITAN is an autonomous agent that can execute arbitrary commands, modify your filesystem, make network requests, and incur API costs. The author accepts no responsibility or liability for any actions taken by the software. You are solely responsible for reviewing and approving all actions taken by TITAN on your systems.

---

## License

MIT License — Copyright (c) 2026 Tony Elliott

Created by [Tony Elliott (Djtony707)](https://github.com/Djtony707)
