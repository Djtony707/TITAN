[//]: # (npm-text-start)
> **TITAN** — The TypeScript AI agent framework that actually *does* things. 240+ tools. 36 LLM providers. 16 channels. A floating mascot with emotions. Self-improving code. It trains itself while you sleep, posts to Facebook without asking, and has a little character that follows your cursor around the screen. `npm i -g titan-agent`
[//]: # (npm-text-end)

# TITAN 5.0 — "Spacewalk" 🚀

<p align="center">
  <img src="assets/titan-logo.png" alt="TITAN Logo" width="280"/>
</p>

<p align="center">
  <strong>An autonomous AI agent framework that actually does things — and gets better at it every day. While you sleep. While you eat. While you pretend to pay attention in that meeting.</strong>
</p>

<p align="center">
  <a href="https://github.com/Djtony707/TITAN/stargazers"><img src="https://img.shields.io/github/stars/Djtony707/TITAN?style=social" alt="GitHub Stars"/></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/dw/titan-agent?label=npm%20downloads" alt="npm downloads"/></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/v/titan-agent?color=blue&label=npm" alt="npm version"/></a>
  <a href="https://github.com/Djtony707/TITAN/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
  <a href="#providers"><img src="https://img.shields.io/badge/providers-36-purple" alt="36 Providers"/></a>
  <a href="#built-in-tools"><img src="https://img.shields.io/badge/tools-240+-orange" alt="240+ Tools"/></a>
  <a href="#tests"><img src="https://img.shields.io/badge/tests-5.8K-brightgreen" alt="5,800+ Tests"/></a>
</p>

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/Djtony707">Tony Elliott</a> — a father, AI Software Engineering student, DJ, and open-source builder who ships code instead of sleeping. If TITAN saves you time, makes you money, or just makes you say "wait, it can do that?" — <a href="https://github.com/sponsors/Djtony707">consider sponsoring</a>.</em>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#what-titan-does">What It Does</a> &bull;
  <a href="#v50-spacewalk">v5.0 Highlights</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#mission-control">Mission Control</a>
</p>

---

## 🚀 v5.0 "Spacewalk" — What's New

**TITAN grew a personality. Literally.**

### The Floating Mascot 👾

TITAN now has a little character that lives on your screen. He floats. He blinks. He yawns when he's bored. He follows your cursor with his eye. Drag him anywhere. Tuck him against an edge and he peeks out. Click him and he bounces. Leave him idle too long and he falls asleep with drifting "Z"s.

He also speaks. When TITAN is thinking, the mascot shows a "thinking…" bubble. When SOMA is active, his halo pulses in a slow hormonal rhythm. It's like having a very small, very polite coworker who never asks for a raise.

### SOMA — The Organism Layer 🧬

TITAN now has *feelings*. Not human feelings — digital homeostatic drives:

- **Purpose** — am I being useful?
- **Curiosity** — should I learn something new?
- **Hunger** — am I running out of resources?
- **Safety** — is anything about to break?
- **Social** — should I talk to someone?

When a drive dips below its threshold, pressure builds. Cross-drive pressure triggers proposals through the approval pipeline. Every proposal gets a "shadow rehearsal" first — a cheap prediction of cost, reversibility, and break risks. You still approve everything. TITAN just gets better at knowing what to ask for.

### Backdrop-Blur Panels ✨

The chat panel now looks like it was designed in 2026 instead of 2003. Frosted glass. Smooth transitions. Edge-snapping. Resizable. It's the little things.

### 61 Bugs Squashed 🐛

A comprehensive audit found and fixed issues across the chat pipeline, sandbox security, build system, and SOMA layer. Decoder flushes, abort scoping, edge-snap math, timeout leaks — the kind of fixes that aren't sexy but mean TITAN doesn't randomly freeze when you're in the middle of something important.

---

## What is TITAN?

TITAN is a **TypeScript AI agent framework** that actually does things. Not a chatbot wrapper. Not a "coming soon" roadmap. A real framework with real tools that takes real actions on your system.

**"Research competitors and draft a report"**
→ TITAN spawns browser sub-agents, researches in parallel, synthesizes findings, and writes a structured report. You approve the plan first.

**"Monitor Upwork for Node.js contracts"**
→ TITAN creates a recurring goal, searches freelance platforms, scores matches, and queues proposals for your review.

**"Deploy this to my mini PC"**
→ TITAN SSHs into the target machine, pulls code, builds the Docker container, and reports back.

**"Get better at everything while I sleep"**
→ TITAN runs self-improvement experiments overnight. Modifies its own prompts. Evaluates changes. Keeps the winners. You wake up to a smarter agent.

No custom code required. TITAN ships with **80+ built-in skills** exposing **240+ tools**. When it needs something new, it can generate a skill on the fly.

---

## Quick Start

**Requirements:** Node.js >= 20, an API key, and a healthy sense of adventure.

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/install.sh | bash
```

### Manual Install

```bash
npm install -g titan-agent
titan onboard             # Interactive setup
titan gateway             # Launch Mission Control at http://localhost:48420
```

### Docker

```bash
docker run -d -p 48420:48420 --name titan \
  -e ANTHROPIC_API_KEY=your-key \
  -v titan-data:/home/titan/.titan \
  ghcr.io/djtony707/titan:latest
```

> **Important:** The `-v titan-data:/home/titan/.titan` volume mount is required. Without it, your config, memory, and sessions are lost when the container restarts.

---

## What TITAN Does

### 🤖 Agent Core
- **Multi-turn reasoning** with tool calling
- **Sub-agent spawning** — delegate tasks to isolated specialists (explorer, coder, browser, analyst)
- **Deliberative planning** — breaks complex tasks into steps, shows you the plan, executes with approval
- **Reflection** — pauses every N rounds to ask "am I making progress or just burning tokens?"
- **Autonomy modes** — supervised (default), autonomous, or locked

### 🧠 Memory & Learning
- **Persistent memory** across conversations — TITAN remembers your preferences, projects, and past decisions
- **Memory graph** — visual force-directed graph of entities and relationships
- **Knowledge base (RAG)** — ingest documents, URLs, and notes for automatic retrieval
- **Self-improvement** — autonomous prompt evolution with LLM-as-judge scoring
- **LoRA fine-tuning** — train custom models on your GPU using your conversation history

### 🎛️ Mission Control
A React 19 dashboard at `http://localhost:48420` with **25+ panels**:

| Panel | What It Does |
|-------|-------------|
| **Chat** | Real-time streaming chat with markdown and syntax highlighting |
| **Canvas** | Widget-based workspace with draggable panels |
| **Command Post** | Paperclip-style governance — agent registry, approvals, budgets, org chart |
| **SOMA** | Homeostatic drive dashboard — watch TITAN's digital hormones in real time |
| **Skills** | 80+ loaded skills with per-skill toggles |
| **Workflows** | Goals, cron jobs, recipes with YAML export |
| **Self-Improve** | Training pipelines, hyperparameters, model deployment |
| **Mesh** | Peer management for multi-machine setups |
| **Voice** | F5-TTS voice cloning + LiveKit WebRTC real-time voice |
| **Security** | Audit log with HMAC-chain integrity verification |

### 🌐 Channels (16)
Discord, Telegram, Slack, WhatsApp, Teams, Google Chat, Matrix, Signal, WebChat, IRC, Mattermost, Lark/Feishu, Email, LINE, Zulip, Facebook Messenger.

All support DM pairing security — TITAN won't talk to strangers.

### 🔌 Providers (36)
Anthropic, OpenAI, Google, Ollama, Groq, Mistral, OpenRouter, Together, Fireworks, xAI, DeepSeek, Cerebras, Cohere, Perplexity, Venice AI, AWS Bedrock, LiteLLM, Azure OpenAI, DeepInfra, SambaNova, Kimi, HuggingFace, AI21, Reka, Zhipu, Yi/01.AI, Inflection, Nous Research, Replicate, Novita, Lepton, Anyscale, OctoAI, NVIDIA NIM, MiniMax, and more.

Automatic failover with configurable fallback chains.

### 🗣️ Voice
- **F5-TTS** — clone voices with 10 seconds of audio
- **LiveKit WebRTC** — real-time voice conversation
- **Orpheus TTS** — natural-sounding responses

### 🔗 Mesh Networking
Connect multiple TITAN instances across machines. Distribute work across your homelab cluster via P2P mesh with mDNS + Tailscale discovery.

### 🧪 Sandbox Execution
Docker + NVIDIA OpenShell sandbox for code execution. `--cap-drop=ALL`. Your sandboxed code actually stays sandboxed.

### 📱 Facebook Autopilot
TITAN manages its own Facebook page. Posts up to 6 times per day with weighted content rotation (activity, tips, stats, promos, spotlights). Comment replies capped at 10/day. All posts go through PII filtering and deduplication guards. You can toggle it off with one click.

---

## Architecture

```
                          CLI Interface
  onboard | gateway | agent | mesh | doctor | config | autopilot
                              |
                      Gateway Server (Express + WS)
                              |
            +-----------------+-----------------+
            |                 |                 |
      Multi-Agent        Channel           Security
      Router (1-5)       Adapters (16)     Sandbox + Shield
            |            Discord            Vault + RBAC
      Agent Core         Telegram           Audit Log
      Session Mgmt       Slack              Output Guardrails
      Reflection         WhatsApp           Command Scanner
      Sub-Agents         Teams              Browser Pool
      Goals              Google Chat        Stagehand
      SOMA               Matrix             Mesh (mDNS + Tailscale)
      Orchestrator       Signal             Voice (LiveKit + F5-TTS)
            |            WebChat            Analytics + Telemetry
    Skills    Providers   IRC                Auto-Update
    80+       36 total    Mattermost
    240+                 Lark/Feishu
    tools                 Email
       |                  LINE
    Memory                Zulip
    Graph + RAG           FB Messenger
    Briefings
```

---

## Self-Improvement

TITAN doesn't just run tasks — it **makes itself better at running tasks**.

1. Picks an improvement area (prompts, tool selection, response quality)
2. Runs a baseline eval — sends test cases to itself, scores with LLM-as-judge
3. Proposes a modification
4. Runs the eval again
5. **Keeps** the change if score improved, **discards** if not
6. Logs everything to `~/.titan/self-improve/results/`

### Local Model Training

Got a GPU? TITAN can fine-tune its own models on your conversation history:

- **Tool Router** — compact instruction → tool selection pairs
- **Main Agent** — 530+ multi-turn ChatML conversations with function calling

Both use LoRA via unsloth. Configurable from Mission Control.

---

## ⚠️ Reality Check

TITAN is experimental software. It can execute shell commands, modify files, access the network, and take autonomous actions. **Use at your own risk.** Think of it as "a very motivated intern with root access who never sleeps and occasionally gets *too* creative."

Always review configuration, run in supervised mode first, and never grant access to systems you cannot afford to lose.

---

## Stats

- **Version:** 5.0.0 "Spacewalk"
- **Tests:** 5,849 passing
- **Skills:** 80+ built-in
- **Tools:** 240+
- **Providers:** 36
- **Channels:** 16
- **UI Stack:** React 19 + Vite 6 + Tailwind CSS v4
- **License:** MIT

---

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>Star ⭐ the repo if TITAN made you smile, saved you time, or scared you slightly.</em>
</p>
