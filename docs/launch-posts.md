# TITAN Launch Posts — Ready to Copy-Paste

## 1. Show HN (Hacker News)

**Title:** Show HN: TITAN – Open-source AI agent framework with 149 tools, voice, mesh networking

**Text:**
Hey HN, I'm Tony. I built TITAN, an open-source AI agent framework in TypeScript.

What it does: TITAN is a self-hosted autonomous AI agent with 149 tools across 91 skills. It connects to 34 LLM providers (including local Ollama), has a React dashboard (Mission Control), WebRTC voice chat, P2P mesh networking between nodes, and runs on your own hardware.

Key features:
- 34 LLM providers with automatic failover chains
- 149 tools: shell, browser automation, GitHub, email, calendar, code execution (Docker sandbox), web search, and more
- Mission Control: React 19 dashboard with admin panels, chat UI, voice overlay
- Mesh networking: mDNS discovery, HMAC-authenticated WebSocket transport, peer approval
- LiveKit WebRTC voice integration
- MCP Server mode: expose your tools to other agents via JSON-RPC
- RAG with FTS5 + embeddings
- Autopilot mode with goal-based and checklist-based scheduling
- 3,879 tests, TypeScript strict mode, pure ESM

I run it on my homelab — a Titan PC with RTX 5090 running Ollama locally, with mesh peers across multiple machines. It's the AI assistant I wanted but couldn't find.

npm: `npm install titan-agent`
GitHub: https://github.com/Djtony707/TITAN
Dashboard demo: http://192.168.1.11:48420 (local only, but screenshots in README)

Built solo over 6 months. Happy to answer questions about the architecture, provider routing, mesh networking, or anything else.

---

## 2. Reddit — r/selfhosted

**Title:** I built an open-source AI agent that runs entirely on my homelab — 149 tools, mesh networking, voice chat, React dashboard

**Text:**
Hey r/selfhosted! I wanted to share TITAN, my self-hosted AI agent framework.

**The setup:** I run it natively on my Titan PC (RTX 5090, i9-14900KF, 64GB DDR5) with Ollama for local LLM inference. No cloud dependency required — it talks to local models, has its own React dashboard, and even supports P2P mesh networking between multiple nodes in your homelab.

**What makes it different from just running Ollama + Open WebUI:**
- 149 built-in tools (shell, file management, GitHub, browser automation, email, calendar, web search, code execution in Docker sandbox, etc.)
- Autonomous mode — give it a goal, it plans and executes multi-step tasks
- Mesh networking — your nodes discover each other via mDNS and share workloads
- WebRTC voice chat via LiveKit
- Mission Control dashboard (React 19) with 17 admin panels
- Autopilot mode for scheduled autonomous tasks
- MCP Server mode — expose tools to other agents

**Stack:** TypeScript, Node.js, Express, React 19, Vite, Tailwind CSS 4, LiveKit, Playwright

**Homelab fleet:**
- Titan PC: Primary GPU inference + TITAN gateway
- T610 Server: Always-on Docker backbone
- Raspberry Pi: Camera AI (Frigate + Hailo NPU)

GitHub: https://github.com/Djtony707/TITAN
npm: `npm install titan-agent`

3,879 tests passing. MIT licensed. Would love feedback from the community.

---

## 3. Reddit — r/LocalLLaMA

**Title:** Built an agent framework that connects to 34 LLM providers (including local Ollama) with automatic failover — TITAN

**Text:**
Hey r/LocalLLaMA! Sharing my open-source AI agent framework, TITAN.

I was frustrated that most agent frameworks are cloud-first and locked to one provider. TITAN supports 34 providers out of the box — 4 native (Anthropic, OpenAI, Google, Ollama) + 30 OpenAI-compatible (Groq, Mistral, DeepSeek, Together, xAI, etc.).

**The killer feature for local LLM users:** Automatic failover chains. If your local Ollama model is busy or OOM, TITAN falls back to your next preferred model — could be another local model, or a cloud provider as backup. You configure the priority chain once.

**Running on my setup:**
- RTX 5090 32GB VRAM running qwen3.5:35b and devstral-small via Ollama
- TITAN auto-discovers Ollama models and routes requests
- Mesh networking lets me distribute inference across my homelab nodes
- 149 tools for autonomous task execution (not just chat)

Other highlights:
- RAG with FTS5 + embeddings for document search
- Docker sandbox for safe code execution
- WebRTC voice chat
- React dashboard with 17 admin panels
- 3,879 tests, TypeScript, MIT license

GitHub: https://github.com/Djtony707/TITAN
npm: `npm install titan-agent`

Curious what models you'd run with it. Happy to answer architecture questions.

---

## 4. Reddit — r/homelab

**Title:** My AI homelab: distributed AI agent framework with mesh networking across 3 machines

**Text:**
Sharing my homelab AI setup with a custom agent framework I built called TITAN.

**The cluster:**
- **Titan PC** (primary): RTX 5090 32GB VRAM, i9-14900KF, 64GB DDR5 — runs Ollama + TITAN gateway
- **T610 Server** (backbone): Always-on Docker stack — Open WebUI, LiteLLM, Qdrant, n8n, Portainer
- **Raspberry Pi** (cameras): Frigate NVR + Hailo-8L AI Hat for object detection

**What TITAN does:**
It's an autonomous AI agent with 149 built-in tools. The cool part for homelab folks is the mesh networking — nodes discover each other via mDNS on your LAN, authenticate with HMAC, and can route tasks to whichever node has the right model/GPU available.

So if my Titan PC is running a heavy model and gets a new request, it can route to another node automatically. Peer approval system so you control which machines join the mesh.

Dashboard: React 19 SPA with system stats, chat UI, voice overlay, 17 admin panels.

Everything runs locally, no cloud dependency. MIT licensed, 3,879 tests.

GitHub: https://github.com/Djtony707/TITAN

---

## 5. Reddit — r/typescript

**Title:** Pure ESM TypeScript AI agent framework — 3,879 tests, Zod schemas, strict mode

**Text:**
If anyone's interested in a large-scale TypeScript project: TITAN is an AI agent framework I built. ~70K lines of TypeScript, pure ESM, strict mode, Zod-validated config schemas, 3,879 vitest tests across 124 files.

Some patterns that might be interesting:
- Universal provider router with alias resolution, fallback chains, and mesh routing
- Auth resolver with priority-based API key failover + cooldowns
- Dynamic skill/tool registry with Zod parameter schemas
- P2P mesh networking (mDNS discovery + HMAC-authenticated WebSocket)
- React 19 SPA with Vite + Tailwind CSS 4 + React Router v7

Stack: Node.js 20+, Express, React 19, Playwright, LiveKit, tsup for builds.

GitHub: https://github.com/Djtony707/TITAN
npm: `npm install titan-agent`

Happy to discuss architecture decisions. MIT licensed.

---

## 6. Dev.to / Hashnode Article

**Title:** How I Built an AI Agent Framework with 149 Tools That Runs on My Homelab

**Outline:**
1. Why I built it (couldn't find what I wanted)
2. Architecture overview (provider router, skill registry, mesh networking)
3. The homelab setup (RTX 5090, distributed inference)
4. Key technical decisions (pure ESM, Zod schemas, vitest)
5. What's next (growing the community, more providers, skill marketplace)
6. Try it: `npm install titan-agent`

---

## Posting Schedule

| Day | Platform | Post |
|-----|----------|------|
| Tuesday AM | Hacker News | Show HN |
| Tuesday PM | r/selfhosted | Homelab angle |
| Wednesday AM | r/LocalLLaMA | Local LLM angle |
| Wednesday PM | r/homelab | Distributed setup |
| Thursday | r/typescript | Technical angle |
| Friday | Dev.to | Long-form article |
| Following week | Product Hunt | Full launch |
