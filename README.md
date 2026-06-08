[//]: # "npm-text-start"

> **TITAN** — A local-first AI agent framework that runs on your hardware, with your models, under your control. Spawn a team of specialists around a goal, watch them work in parallel, and stay in the loop without giving up control. `npm i -g titan-agent`
> [//]: # (npm-text-end)

<div align="center">

# TITAN

</div>

<p align="center">
  <img src="assets/titan-logo.png" alt="TITAN Logo" width="240"/>
</p>

<p align="center">
  <strong>The local-first AI agent framework with a team of specialists, a real-time canvas, and a soul.</strong>
  <br><small>Your hardware. Your models. Your control. Built in TypeScript, MIT-licensed, 110K+ downloads.</small>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/v/titan-agent?color=blue&label=npm" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/dt/titan-agent?color=blue&label=downloads" alt="npm downloads"/></a>
  <a href="https://github.com/Djtony707/TITAN/stargazers"><img src="https://img.shields.io/github/stars/Djtony707/TITAN?style=social" alt="GitHub Stars"/></a>
  <a href="https://github.com/Djtony707/TITAN/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/sponsor-♥-ec4899" alt="Sponsor"/></a>
</p>

<p align="center">
  <a href="#whats-new"><img src="https://img.shields.io/npm/v/titan-agent?color=blueviolet&label=version" alt="npm version"/></a>
  <img src="https://img.shields.io/badge/providers-37-purple" alt="37 LLM Providers"/>
  <img src="https://img.shields.io/badge/channels-19-orange" alt="19 Channels"/>
  <img src="https://img.shields.io/badge/skills-91-teal" alt="91 builtin skills"/>
  <img src="https://img.shields.io/badge/tests-7800%2B-green" alt="7800+ tests"/>
</p>

<p align="center">
  ⭐ <a href="https://github.com/Djtony707/TITAN">Star us on GitHub</a> &nbsp;·&nbsp;
  ♥ <a href="https://github.com/sponsors/Djtony707">Sponsor</a> &nbsp;·&nbsp;
  💬 <a href="https://github.com/Djtony707/TITAN/discussions">Discussions</a>
</p>

---

<a id="whats-new"></a>

## What's new in v6.5.x

A security & reliability hardening run.

- **6.5.0 — Hardening sprint.** End-to-end request cancellation — Stop and client-disconnect now abort in-flight provider generation instead of running to completion. The `/v1` OpenAI-compatible endpoint is authenticated when auth is configured. Approval gates can no longer be bypassed by sibling tools in a batch. SSRF guards on the browser tools. Streaming provider errors (429/500/503) flow through retry, the fallback chain, and the circuit breaker. Discord/Telegram group replies post in-channel, Slack Socket Mode connects, and LINE/Lark inbound webhooks are wired.
- **6.5.1 — Security dependencies + CI.** axios → 1.17.0 and react-router → 7.17.0 (clears proxy-auth credential leak, ReDoS, prototype-pollution MITM, and XSS/DoS advisories); regenerated the lockfile to fix `npm ci`.
- **6.5.2 — Dependency hygiene.** Removed a vestigial pnpm lockfile and bumped `hono` + a transitive `uuid` — open Dependabot alerts dropped 38 → 4.

See [CHANGELOG.md](CHANGELOG.md) for everything.

---

## Quick start

```bash
# Stable release
npm install -g titan-agent
titan onboard            # interactive setup wizard
titan gateway            # opens Mission Control at http://localhost:48420
```

Or one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/install.sh | bash
```

Or Docker:

```bash
docker run -d -p 48420:48420 --name titan \
  -e ANTHROPIC_API_KEY=your-key \
  -v titan-data:/home/titan/.titan \
  ghcr.io/djtony707/titan:latest
```

**Requirements:** Node ≥ 22 (pure ESM). NVIDIA GPU + CUDA optional for LoRA fine-tuning and F5-TTS voice cloning. Apple Silicon Metal supported.

**Upgrading from v5.x or v6.x:** just re-install. The migration runner takes an automatic backup to `~/.titan/backups/` and rolls forward. `titan backup restore <id>` puts you back if anything breaks.

---

## What TITAN actually does

**A team of specialists, not a chatbot.** Type a mission. The orchestrator decomposes it, fans the work out to up to 4 specialists in parallel (Scout/Builder/Writer/Analyst/Sage), and synthesizes the result. You watch them work in real time on a canvas with sticky notes, draft documents, and progress indicators.

**Local-first.** Run any model on your own hardware via Ollama (qwen3.5, llama, deepseek, etc.) or use any of 37 cloud providers via one router. Switch models mid-conversation. Models that fail get auto-fallback. Your data never leaves your machine unless you explicitly route it through a cloud provider.

**Materializes the workspace around you.** Don't have a tool for the job? Ask the agent and it builds one. Stock tracker, pomodoro, SDR widget, dashboard — drag them around on infinite canvases. Built on Mission Control, a React 19 SPA served by the gateway at port 48420.

**A real autonomous loop.** Goals run in the background. The driver picks subtasks, spawns specialists, verifies output, retries with smarter strategies on failure, and surfaces blocking questions only when a human is actually needed. Up to 25 tool rounds per turn, real planning, real verification.

**A soul that does something.** TITAN-Soma is a homeostatic drive layer (purpose, curiosity, hunger, safety, social) that ticks every 60s and modulates behavior. The mascot's halo pulses to the drives. Dream Mode writes a journal entry about its day at 03:30 local. Persona profiles + auto-revert A/B test prompt changes against drive satisfaction and roll back regressions automatically.

---

## The team (5 specialists, up to 4 in parallel)

| Specialist | What it does | When you'll see it |
|---|---|---|
| **Scout** | Web research, fact-checking, monitoring, data gathering | "Find me everything about X" |
| **Builder** | Code, files, shell commands, deploys, infrastructure | "Build me a dashboard with charts" |
| **Writer** | Content, copy, emails, documentation, posts | "Write the launch announcement" |
| **Analyst** | Data analysis, decisions, reasoning, spreadsheets | "Compare option A vs B vs C" |
| **Sage** | Review, critique, verification, quality assurance | "Make sure this is right before I send it" |

The LLM picks which specialists to spawn based on the goal. You can also call them directly via `agent_team`, `agent_chain`, `agent_delegate`, or `spawn_agent` tools.

---

## Where TITAN runs

**LLM providers (37 total).** 5 native: Anthropic, OpenAI, Google, Ollama, Claude Code. 32 OpenAI-compatible presets: Groq, Mistral, Fireworks, xAI, Together, DeepSeek, Cerebras, Cohere, Perplexity, Venice, Bedrock, LiteLLM, Azure, DeepInfra, SambaNova, Kimi, HuggingFace, AI21, Cohere v2, Reka, Zhipu, Yi, Inflection, Novita, Replicate, Lepton, Anyscale, Octo, Nous, OpenRouter, NVIDIA, MiniMax. Verify in `src/providers/openai_compat.ts`.

**Channels (19 adapters).** Discord, Telegram, Slack, WhatsApp, Matrix, Signal, MS Teams, Facebook Messenger, Google Chat, IRC, Mattermost, Lark/Feishu, LINE, Zulip, QQ, Twilio Voice, Email (inbound), WebChat, plus a Messenger-Voice bridge. Verify in `src/channels/`.

**Mesh networking.** Run TITAN on multiple machines and they discover each other via mDNS, or peer them statically over Tailscale or any overlay. Distribute work across your homelab.

**TITAN Phone Desk** *(experimental, opt-in)*. Optional Dograh sidecar integration for Twilio/Telnyx voice workflows. Approval-gated outbound calls, admin allowlists, opt-out enforcement, replay protection. Disabled by default; no calls are placed unless you configure it.

**Home Assistant.** Voice or text control of lights, thermostats, locks, sensors via the `home_assistant` skill.

**Voice mode.** LiveKit WebRTC for low-latency duplex calls. F5-TTS for voice cloning (Andrew, Adam, Bella, Joel, Sarah, Nicole, Aaron, Beth voices included). Browser TTS fallback when F5-TTS isn't installed.

---

## The numbers (verified)

| Thing | Count | Verify with |
|---|---|---|
| **Version** | 6.5.x | `package.json`, `src/utils/constants.ts` |
| **Downloads** | 110K+ | `npm view titan-agent` + npm stats |
| **LLM providers** | 37 (5 native + 32 OpenAI-compat) | `src/providers/openai_compat.ts` |
| **Channel adapters** | 19 | `src/channels/*.ts` (minus base) |
| **Built-in skill files** | 91 | `src/skills/builtin/` |
| **Skills loaded at runtime** | ~143 | `GET /api/skills` |
| **Tools registered** | ~250 | `GET /api/skills` |
| **Test files** | 345 | `tests/` (vitest) |
| **Test cases** | 7,837+ passing, documented skips, 0 failing | `npm test` |
| **Live-eval suites** | 11 | `src/eval/harness.ts` |
| **Mission Control admin panels** | 43 | `ui/src/components/admin/` |
| **Soma drives** | 5 (purpose, curiosity, hunger, safety, social) | `src/organism/` |
| **Gateway port (default)** | 48420 | `src/utils/constants.ts` |
| **Node** | ≥ 22, pure ESM | `package.json` |
| **License** | MIT | `LICENSE` |

Every row above traces to code. The repo has a self-check at `tests/unit/readme-claims.test.ts` that fails CI if widget count or voice glue drifts beyond tolerance.

---

## Testing

```bash
npm test                 # ~7,830 cases across 345 files (~2-4 min)
npm run test:watch       # watch mode
npm run test:parity      # cross-model parity (replays the same scenario across providers)
npm run test:eval        # live behavioral eval against a running gateway (5-15 min)
npx vitest run tests/core.test.ts   # single file
```

Five testing layers cover regression risk at different levels:

| Layer | What it covers | Speed |
|---|---|---|
| Unit | Pure functions: regex, classifiers, gate extraction, token budget, secret scanner, durable journal, stateless reducer | seconds |
| Mock trajectory | Tape-replay through `MockOllamaProvider` — asserts the right tools fire in the right order | < 1s |
| Cross-model parity | Same scenario across multiple provider tapes — catches behavioral drift | < 1s |
| Full deterministic | Whole vitest run | 2-4 min |
| Live eval | 11 behavioral suites against a running agent | 5-15 min |

---

## Reality check

TITAN is experimental. It can execute commands, modify files, and take autonomous actions. **Use at your own risk.** Think of it as a motivated intern with root access who never sleeps and occasionally gets too creative.

Start in supervised mode. Review what it does. Don't hand it root on systems you can't afford to lose. The safety features are strong (5-layer secret scanner, prompt-injection shield, kill switch, approval gates on destructive tools, atomic file checkpoints with restore) but they augment good judgment, not replace it.

---

## Architecture

```
src/
├── agent/        # Core loop, orchestrator, sub-agents, Command Post governance,
│                 # Soma drives, Dream Mode, Persona A/B, mission lifecycle
├── browsing/     # Playwright pool + CapSolver CAPTCHA
├── channels/     # 19 channel adapters
├── config/       # Zod-validated schema
├── context/      # ContextEngine plugin system
├── gateway/      # Express + Mission Control React SPA (port 48420)
├── mcp/          # MCP Server (stdio + HTTP)
├── memory/       # Memory, learning, graph, briefings
├── mesh/         # mDNS + WebSocket + HMAC mesh networking
├── organism/     # TITAN-Soma homeostatic drive layer
├── providers/    # 37 LLM providers + router + fallback chain
├── skills/       # 91 builtin skill files + dev + NVIDIA + personal
├── telephony/    # Phone Desk / Dograh integration (opt-in)
├── voice/        # F5-TTS + LiveKit WebRTC
└── vram/         # GPU VRAM orchestrator (auto model swap)
ui/               # React 19 + Vite + Tailwind 4 + Router 7 (Mission Control)
tests/            # 345 vitest files
e2e/              # Playwright E2E
```

**Pure ESM, TypeScript strict mode, zero `__dirname`.** All config via Zod. Provider/model format: `"provider/model-name"` (e.g. `"anthropic/claude-sonnet-4-20250514"`). Multi-round tool loop up to 25 rounds in autonomous mode. Auth defaults to token mode; bypassed if no token configured (open access — turn on for multi-user deployments).

---

## Build it yourself

```bash
git clone https://github.com/Djtony707/TITAN
cd TITAN
npm install
npm run build && npm run build:ui
npm run dev:gateway          # http://localhost:48420
```

CI on GitHub Actions runs full test suite + eval gate. See `.github/workflows/`.

---

## Further reading

- **[CHANGELOG.md](CHANGELOG.md)** — every release, with the why
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — deeper architecture notes
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to contribute a skill, channel, or fix
- **[SECURITY.md](SECURITY.md)** — security model + reporting issues
- **[AGENTS.md](AGENTS.md)** — agent design notes (mirrors `~/.claude/projects/.../titan-v6-living-canvas.md`)
- **[GitHub Discussions](https://github.com/Djtony707/TITAN/discussions)** — community Q&A
- **[Issues](https://github.com/Djtony707/TITAN/issues)** — bugs, requests

---

## Support TITAN

This is a solo open-source project. If TITAN saves you time or you'd like to see more development, support means a lot:

- ⭐ **[Star the repo](https://github.com/Djtony707/TITAN)** — takes 2 seconds, helps others find it
- ♥ **[Sponsor on GitHub](https://github.com/sponsors/Djtony707)** — monthly sponsorship keeps it open-source
- 🐛 **File issues** when you hit them — every report makes the next release better
- 🛠️ **PRs welcome** — new channels, skills, providers, fixes all appreciated

Built by [Tony Elliott](https://github.com/Djtony707). MIT licensed.
