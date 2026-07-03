[//]: # "npm-text-start"

> **TITAN** — A local-first AI agent framework that runs on your hardware, with your models, under your control. Spawn a team of specialists around a goal, watch them work live — step-by-step, with real file diffs — and stay in the loop without giving up control. `npm i -g titan-agent`
> [//]: # (npm-text-end)

<div align="center">

# TITAN

</div>

<p align="center">
  <img src="assets/titan-logo.png" alt="TITAN Logo" width="240"/>
</p>

<p align="center">
  <strong>The local-first AI agent framework that is model-agnostic, accessible by design, and lets you watch it work.</strong>
  <br><small>Your hardware. Your models. Your control. Built in TypeScript, MIT-licensed, 40K+ lifetime installs.</small>
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
  <img src="https://img.shields.io/badge/providers-36-purple" alt="36 LLM Providers"/>
  <img src="https://img.shields.io/badge/channels-19-orange" alt="19 Channels"/>
  <img src="https://img.shields.io/badge/skills-~143%20loaded-teal" alt="~143 skills loaded"/>
  <img src="https://img.shields.io/badge/WCAG-2.1%20AA-blueviolet" alt="WCAG 2.1 AA"/>
  <img src="https://img.shields.io/badge/tests-8000%2B-green" alt="8000+ tests"/>
</p>

<p align="center">
  ⭐ <a href="https://github.com/Djtony707/TITAN">Star us on GitHub</a> &nbsp;·&nbsp;
  ♥ <a href="https://github.com/sponsors/Djtony707">Sponsor</a> &nbsp;·&nbsp;
  💬 <a href="https://github.com/Djtony707/TITAN/discussions">Discussions</a>
</p>

---

<a id="whats-new"></a>

## What's new in v7.0.0 — "Alive, Welcoming, Model-Agnostic"

Four themes define this release: **TITAN provably teaches itself from your usage, first run takes one minute, it lives on your machine between conversations, and it runs well on any capable model.**

### 💪 Muscle Memory — self-improvement you can actually trust

The #1 wish across agent-framework reviews: agents that turn repeated workflows into skills *by themselves* — without the untrustworthy self-grading that plagues every attempt at it. TITAN ships it, with proof:

- **It notices.** Repeat a workflow ~3 times and TITAN mines the pattern from its own task trajectories and drafts a reusable, parameterized skill with its own slash command.
- **The replay exam.** Before you ever see a learned skill, it must **reproduce the original workflow's exact tool path against your real historical request**, verified by the deterministic eval harness. No self-praise — grounded proof. Failed drafts stay hidden.
- **Structurally safe.** Exams replay inside a tool allowlist sandbox; workflows containing side-effectful tools (send / post / delete / deploy / …) are never mined at all; nothing ever auto-adopts.
- **One click to adopt** → instant `/slash-command` in every channel, a savings ledger per run, and a mascot that announces what it learned. "Not for me" is remembered forever.

### 👋 Welcome Mode — first run in about a minute

- **The gateway always boots.** No Ollama, no API keys? v7.0 starts anyway and greets you — no more terminal refusal before you've ever seen the desk.
- **The dashboard walks you in:** one-click connect when Ollama is detected (models auto-listed), or paste an Anthropic/OpenAI key, or point at any OpenAI-compatible endpoint (LiteLLM, vLLM, LM Studio, llama.cpp).
- **No restart** — connect a model and the desk unlocks live. Chat answers with friendly setup guidance until then.

### 🧠 Model-agnostic harness

TITAN no longer assumes one vendor's quirks. The generic `openai_compat` provider (DeepSeek / Qwen / GLM / Kimi / MiniMax / xAI / Groq / …) now honors per-model tool-calling instead of a blind passthrough:

- **Native tool-calls per vendor** via a shared **per-model capability registry** (qwen3.6, deepseek-v4, glm-5.1, kimi-k2.6, minimax, nemotron-3) used by *both* the Ollama and openai-compat paths.
- **`forceToolUse` → `tool_choice`** per-model, plus JSON `format` (`response_format` + a 2 KB anti-truncation floor), with a guard for the DeepSeek-reasoner HTTP-400 case.
- **Adaptive `max_tokens`** — parse a deployment's real ceiling out of a 400 and retry, so a static `maxOutput` never hard-fails a model on a constrained deployment.
- **Deterministic system-widget gates** — "show backup" reliably renders the widget no matter which model is driving, instead of depending on per-model formatting adherence.

> TITAN is deliberately **not** tuned to one LLM. Model-fit and harness bugs are kept separate so the framework stays model-agnostic.

### ♿ Accessible by design (WCAG 2.1 AA)

- a11y primitives across the UI: Input / Modal / Toast / Button focus + ARIA, a skip-link and `<main>` landmark, and a global focus-visible baseline.
- A new **"Studio" theme** (clean neutral graphite) plus a **WCAG contrast-audit harness** that programmatically proves every theme meets AA.

### 👀 Living-agents foundation — *watch it work*

A session-scoped **event spine** now emits `tool:call` / `tool:result` events (with a diff for file changes) as the agent runs. On top of it:

- **Live Studio** — a "watch it work" split-pane that shows a **step timeline**, **live file diffs**, and a **changed-files rail** as the agent operates.
- Sessions are **URL-addressable and replayable** — share a link, scrub the timeline.

*(The Live Studio ships with the timeline + diff stream + changed-files list. A live preview server, a one-click-revert button, and the round/token spine tail are on the [roadmap](#roadmap) — not in v7.0.)*

### 🫀 Alive by default — the life loop

TITAN doesn't just respond — it lives on your machine:

- **The Heartbeat.** Every ~30 minutes TITAN checks its world and decides if ONE thing is worth telling you, unprompted — the mascot says it. Default is silence; quiet hours respected.
- **Proactive memory.** It quietly notices durable things about you from real conversations (strict rules, never sensitive categories) — what it learns shapes every future reply and fills the plain-language **"What I know about you"** page.
- **It proposes work.** When a drive is genuinely neglected, Soma files a suggestion into your approvals — shadow-rehearsed first, never auto-run. (v7.0 fixes the threshold that had made this mathematically impossible.)
- **Real reminders, honestly kept.** "Remind me Friday at 5pm" actually fires — the mascot announces it at the right time. And a built-in anti-fabrication guard means TITAN can never claim it scheduled something it didn't.

### 🪵 The Living Desk — home is a canvas, the mascot is a creature

- **Home IS your canvas.** The "Ask TITAN" input is itself a widget — move it, resize it, build your desk around it. Five desk themes (incl. the new **Night Desk** dark walnut), zoomable 40–200%.
- **The mascot wanders the desk**, goes wherever you place it, narrates work in plain English, celebrates finishes, carries your day-streak flame, and greets you with what it finished while you were away.
- **Edit widgets by talking** — the editor's "Ask AI" bar rewrites a widget from a plain-English request; History undoes.
- **Five doors, not 48** — Home · Desk · Studio · Memory · Workshop. All the power is still there, behind the Workshop door.

### 🔭 Observability & tracing

- Per-run **spans** (latency, tokens, cost, tools) with a live summary and **OTel export**.
- File-backed per-run trace store at `$TITAN_HOME/traces`, served via `/api/traces`, `/api/traces/summary`, and OTel `/api/traces/export`.

### 🧩 Mission Control — 4 new panels

**Memory Taxonomy** (9 memory types + the drive-backed *emotional* differentiator) · **Security self-audit** (severity-grouped config findings) · **Evals dashboard** · **Observability / tracing**.

### Also in v7.0

- **Workflow Builder** — a dependency-free SVG **goal/subtask DAG** of any mission: nodes coloured by status, edges from `dependsOn`, layered by longest-dependency-depth, the live current subtask highlighted. Click a node for detail, or author a new workflow from a plain-English prompt. Mission decomposition now threads real dependency edges (backward-only, always-acyclic), so the DAG reflects true ordering.
- **2 new agent skills:** `codebase_explore` (walks a repo into a structured map — entrypoints, key files, language mix, top dirs) and `delegate_agent` (orchestrates external coding agents — codex / aider / goose / gemini / opencode; **never** the `claude` CLI).
- **8 ECC software-craft skills** (MIT, attributed), `config_audit` (config security self-audit), a spec-driven workflow (acceptance criteria recited every turn), and a named memory taxonomy (`memory_map`).
- **SECURITY:** the Facebook Messenger webhook verifies the `X-Hub-Signature-256` HMAC (constant-time) when `FB_APP_SECRET` is set — forged POSTs are then rejected with 403. (Set the secret to enable enforcement; without it, verification is skipped.)
- **FIX:** the agent loop-breaker could itself infinite-loop (the round counter froze) — now terminal and bounded.

See **[CHANGELOG.md](CHANGELOG.md)** for the full v7.0.0 entry and everything before it.

---

## Why TITAN

- **It teaches itself — provably.** Muscle Memory turns your repeated workflows into replay-verified skills. Every learned skill passes a deterministic exam against your real usage before you see it; nothing auto-adopts. No other framework ships trustworthy self-improvement on by default.
- **One-minute first run.** `npm install -g titan-agent && titan gateway` — the dashboard greets you and connects a model in about a minute. No Docker, no YAML, no config-file editing.
- **Model-agnostic, for real.** One harness, native tool-calls per vendor, a per-model capability registry, adaptive token ceilings. Bring DeepSeek, Qwen, GLM, Kimi, MiniMax, Anthropic, OpenAI, Gemini, or anything OpenAI-compatible — the framework adapts instead of being tuned to one LLM.
- **Local-first.** Run any model on your own hardware via Ollama, or route to any of 36 providers through one router. Switch models mid-conversation. Failed models auto-fallback. Your data never leaves your machine unless you explicitly send it to a cloud provider.
- **Watch it work.** The Live Studio shows the agent's step timeline, real file diffs, and changed files as it runs. Sessions are URL-addressable and replayable.
- **A team of specialists, not a chatbot.** The orchestrator decomposes a mission, fans the work out to up to 4 specialists in parallel, verifies output, and synthesizes the result.
- **Accessible by design.** WCAG 2.1 AA primitives, a contrast-audit harness that proves every theme meets AA, full keyboard focus, ARIA, and a skip-link landmark.
- **Observable.** Per-run spans (latency, tokens, cost, tools) with OTel export.

---

## Quick start

```bash
# Stable release
npm install -g titan-agent
titan gateway            # opens Mission Control at http://localhost:48420
```

That's it — no setup required first. The dashboard greets you and connects a model in about a minute (one click if Ollama is running; or paste any API key / OpenAI-compatible endpoint). Prefer the terminal? `titan onboard` runs the full interactive wizard.

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

**A team of specialists, not a chatbot.** Type a mission. The orchestrator decomposes it, fans the work out to up to 4 specialists in parallel (Scout / Builder / Writer / Analyst / Sage), and synthesizes the result. You watch them work in real time on Mission Control.

**Watch it work, live.** The Live Studio is a split-pane "watch it work" view: a **step timeline** on one side, **live file diffs** and a **changed-files rail** on the other, driven by a session-scoped event spine that emits `tool:call` / `tool:result` as the agent runs. Sessions are URL-addressable and replayable, so you can share a link or scrub back through what happened.

**Model-agnostic by design.** TITAN binds native tool-calls per vendor through a shared capability registry, maps `forceToolUse` to each model's `tool_choice`, enforces JSON mode with an anti-truncation floor, and adapts `max_tokens` to a deployment's real ceiling. Run any capable model — the harness fits the model, not the other way around.

**A real autonomous loop.** Goals run in the background. The driver picks subtasks, spawns specialists, verifies output, retries with smarter strategies on failure, and surfaces blocking questions only when a human is actually needed. Up to 25 tool rounds per turn, real planning, real verification, with a bounded loop-breaker that can't itself spin.

**Materializes the workspace around you.** Don't have a tool for the job? Ask the agent and it builds one. Stock tracker, pomodoro, SDR widget, dashboard — drag them around on infinite canvases. Built on Mission Control, a React 19 SPA served by the gateway at port 48420.

**A soul that does something.** TITAN-Soma is a homeostatic drive layer (purpose, curiosity, hunger, safety, social) that ticks every 60s and modulates behavior. Dream Mode writes a journal entry about its day at 03:30 local. Persona profiles + auto-revert A/B test prompt changes against drive satisfaction and roll back regressions automatically.

---

## The team (5 specialists, up to 4 in parallel)

| Specialist | What it does | When you'll see it |
|---|---|---|
| **Scout** | Web research, fact-checking, monitoring, data gathering | "Find me everything about X" |
| **Builder** | Code, files, shell commands, deploys, infrastructure | "Build me a dashboard with charts" |
| **Writer** | Content, copy, emails, documentation, posts | "Write the launch announcement" |
| **Analyst** | Data analysis, decisions, reasoning, spreadsheets | "Compare option A vs B vs C" |
| **Sage** | Review, critique, verification, quality assurance | "Make sure this is right before I send it" |

The LLM picks which specialists to spawn based on the goal. You can also call them directly via `agent_team`, `agent_chain`, `agent_delegate`, or `spawn_agent`. For *external* coding agents (codex / aider / goose / gemini / opencode), use the new `delegate_agent` skill — it never shells out to the `claude` CLI.

---

## Where TITAN runs

**LLM providers (36 total).** 4 native: Anthropic, OpenAI, Google, Ollama. 32 OpenAI-compatible presets: Groq, Mistral, Fireworks, xAI, Together, DeepSeek, Cerebras, Cohere, Perplexity, Venice, Bedrock, LiteLLM, Azure, DeepInfra, SambaNova, Kimi, HuggingFace, AI21, Cohere v2, Reka, Zhipu, Yi, Inflection, Novita, Replicate, Lepton, Anyscale, Octo, Nous, OpenRouter, NVIDIA, MiniMax. The generic `openai_compat` path binds native tool-calls per model via the shared capability registry. Verify in `src/providers/openai_compat.ts`.

**Channels (19 adapters).** Discord, Telegram, Slack, WhatsApp, Matrix, Signal, MS Teams, Facebook Messenger (HMAC-verified webhook), Google Chat, IRC, Mattermost, Lark/Feishu, LINE, Zulip, Email (inbound), WebChat. Verify in `src/channels/`.

**Mesh networking.** Run TITAN on multiple machines and they discover each other via mDNS, or peer them statically over Tailscale or any overlay. Distribute work across your homelab.

**TITAN Phone Desk** *(experimental, opt-in)*. Optional Dograh sidecar integration for Twilio/Telnyx voice workflows. Approval-gated outbound calls, admin allowlists, opt-out enforcement, replay protection. Disabled by default; no calls are placed unless you configure it.

**Home Assistant.** Voice or text control of lights, thermostats, locks, sensors via the `home_assistant` skill.

**Voice mode.** LiveKit WebRTC for low-latency duplex calls. F5-TTS for voice cloning (Andrew, Adam, Bella, Joel, Sarah, Nicole, Aaron, Beth voices included). Browser TTS fallback when F5-TTS isn't installed.

---

## The numbers (verified)

| Thing | Count | Verify with |
|---|---|---|
| **Version** | 7.0.0 | `package.json`, `src/utils/constants.ts` |
| **Downloads** | 40K+ lifetime | `npm view titan-agent` + npm stats |
| **LLM providers** | 36 (4 native + 32 OpenAI-compat) | `src/providers/openai_compat.ts` |
| **Channel adapters** | 19 | `src/channels/*.ts` |
| **Skills loaded at runtime** | ~143 | `GET /api/skills` |
| **Tools registered** | ~248 | `GET /api/skills` |
| **Test cases** | 8,122 passing / 9 skipped / 0 failing | `npm test` |
| **Mission Control admin panels** | 51 | `ui/src/components/admin/` |
| **Soma drives** | 5 (purpose, curiosity, hunger, safety, social) | `src/organism/` |
| **Gateway port (default)** | 48420 | `src/utils/constants.ts` |
| **Node** | ≥ 22, pure ESM | `package.json` |
| **License** | MIT | `LICENSE` |

Every row above traces to code. The repo has a self-check at `tests/unit/readme-claims.test.ts` that fails CI if the verified counts drift beyond tolerance.

### v7.0 verification

The v7.0.0 release was verified end-to-end before publish:

- **Full test suite:** 8,122 pass / 9 skip / **0 fail**.
- **Muscle Memory adversarial review:** 26-agent review fleet, 21 confirmed findings — all fixed before ship; the learned-skill pipeline was proven live (mined a real repeated workflow, drafted `add-widget`, passed its replay exam unprompted on first boot).
- **Welcome Mode first-run:** verified on a virgin machine end-to-end — boot with zero config → guided connect → first real reply, no restart.
- **Live UI route sweep:** 40 / 40 routes render clean (zero console errors).
- **v7-smoke e2e:** 12 / 12.
- **API sweep:** 18 / 19 (the one non-200 is a 503 by design).
- **Chat:** works end-to-end.
- **Behavioral eval-gate:** 93% (GO).

---

## Testing

```bash
npm test                 # full suite (8,000+ cases)
npm run test:watch       # watch mode
npm run test:parity      # cross-model parity (replays the same scenario across providers)
npm run test:eval        # live behavioral eval against a running gateway (5-15 min)
npx vitest run tests/core.test.ts   # single file
```

Five testing layers cover regression risk at different levels:

| Layer | What it covers | Speed |
|---|---|---|
| Unit | Pure functions: regex, classifiers, gate extraction, token budget, secret scanner, capability registry, contrast harness | seconds |
| Mock trajectory | Tape-replay through `MockOllamaProvider` — asserts the right tools fire in the right order | < 1s |
| Cross-model parity | Same scenario across multiple provider tapes — catches behavioral drift | < 1s |
| Full deterministic | Whole vitest run | 2-4 min |
| Live eval | Behavioral suites against a running agent | 5-15 min |

---

<a id="roadmap"></a>

## Roadmap (not in v7.0)

These are **planned**, not shipped. v7.0 lays the foundation for them but does not include them:

- **Roster Forge — dynamic agent spawning.** Define and spin up new specialist roles at runtime, beyond the fixed five.
- **Verdict-grounded self-evolution loop.** Close the loop so the agent's own eval verdicts drive prompt/behavior evolution automatically. (v7.0's Muscle Memory covers *workflow-level* self-learning with replay exams; this item extends grounded verdicts to prompt/behavior evolution, e.g. GEPA fitness.)
- **Live Studio live preview pane.** A running preview server in the Studio right-pane (today: timeline + file-diff stream + changed-files list only — **no preview pane**).
- **One-click revert + the round/token spine tail.** A revert button on the change rail and round/token accounting on the event spine (today: **no revert button**, diffs are read-only).

If you want one of these sooner, [open a discussion](https://github.com/Djtony707/TITAN/discussions) or a PR.

---

## Reality check

TITAN is experimental. It can execute commands, modify files, and take autonomous actions. **Use at your own risk.** Think of it as a motivated intern with root access who never sleeps and occasionally gets too creative.

Start in supervised mode. Review what it does — the Live Studio makes that easier than ever. Don't hand it root on systems you can't afford to lose. The safety features are strong (5-layer secret scanner, prompt-injection shield, kill switch, approval gates on destructive tools that can't be bypassed by sibling tools in a batch, atomic file checkpoints with restore, HMAC-verified inbound webhooks) but they augment good judgment, not replace it.

---

## Architecture

```
src/
├── agent/        # Core loop, orchestrator, sub-agents, Command Post governance,
│                 # Soma drives, Dream Mode, Persona A/B, mission lifecycle, event spine
├── browsing/     # Playwright pool + CapSolver CAPTCHA
├── channels/     # Channel adapters (16)
├── config/       # Zod-validated schema
├── context/      # ContextEngine plugin system
├── gateway/      # Express + Mission Control React SPA (port 48420), traces API
├── mcp/          # MCP Server (stdio + HTTP)
├── memory/       # Memory, learning, graph, briefings, memory taxonomy
├── mesh/         # mDNS + WebSocket + HMAC mesh networking
├── organism/     # TITAN-Soma homeostatic drive layer
├── providers/    # 36 LLM providers + router + fallback chain + capability registry
├── skills/       # Builtin skills + dev + NVIDIA + ECC software-craft + personal
├── telephony/    # Phone Desk / Dograh integration (opt-in)
├── voice/        # F5-TTS + LiveKit WebRTC
└── vram/         # GPU VRAM orchestrator (auto model swap)
ui/               # React 19 + Vite + Tailwind 4 + React Router 7 (Mission Control + Live Studio)
tests/            # vitest suite (8,000+ cases)
e2e/              # Playwright E2E
```

**Pure ESM, TypeScript strict mode, zero `__dirname`.** All config via Zod. Provider/model format: `"provider/model-name"` (e.g. `"anthropic/claude-sonnet-4-20250514"`). Multi-round tool loop up to 25 rounds in autonomous mode. Auth defaults to token mode; bypassed if no token configured (open access — turn it on for multi-user deployments). The `/v1` OpenAI-compatible endpoint is authenticated when auth is configured.

---

## Build it yourself

```bash
git clone https://github.com/Djtony707/TITAN
cd TITAN
npm install
npm run build && npm run build:ui
npm run dev:gateway          # http://localhost:48420
```

CI on GitHub Actions runs the full test suite + eval gate. See `.github/workflows/`.

---

## Further reading

- **[CHANGELOG.md](CHANGELOG.md)** — every release, with the why
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — deeper architecture notes
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to contribute a skill, channel, or fix
- **[SECURITY.md](SECURITY.md)** — security model + reporting issues
- **[AGENTS.md](AGENTS.md)** — agent design notes
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
