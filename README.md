[//]: # "npm-text-start"

> **TITAN** — The AI that actually _does_ things. It remembers your name. It learns what you like. It writes your emails, codes your ideas, posts for you, and keeps getting smarter while you sleep. Oh, and it has a little floating mascot. `npm i -g titan-agent`
> [//]: # (npm-text-end)

# TITAN 5.5 — "Spacewalk" 🚀

<p align="center">
  <img src="assets/titan-logo.png" alt="TITAN Logo" width="280"/>
</p>

<p align="center">
  <strong>Your own AI employee. It thinks. It acts. It learns. It even has feelings.*</strong>
  <br><small>*Digital homeostatic drives. Don't call HR.</small>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/v/titan-agent?color=blue&label=npm" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/dw/titan-agent?label=npm%20downloads" alt="npm downloads"/></a>
  <a href="https://github.com/Djtony707/TITAN/stargazers"><img src="https://img.shields.io/github/stars/Djtony707/TITAN?style=social" alt="GitHub Stars"/></a>
  <a href="https://github.com/Djtony707/TITAN/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
</p>

<p align="center">
  <a href="#-providers"><img src="https://img.shields.io/badge/providers-36-purple" alt="36 Providers"/></a>
  <a href="#-the-numbers"><img src="https://img.shields.io/badge/tools-248%2B-orange" alt="248+ Tools"/></a>
  <a href="#-widget-gallery"><img src="https://img.shields.io/badge/widgets-109-pink" alt="109 Widgets"/></a>
  <a href="#-mission-control"><img src="https://img.shields.io/badge/admin%20panels-45-teal" alt="45 Admin Panels"/></a>
  <a href="#-testing"><img src="https://img.shields.io/badge/tests-6%2C600%2B-brightgreen" alt="6,600+ Tests"/></a>
</p>

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/Djtony707">Tony Elliott</a> — a dad, student, DJ, and guy who ships code at 3am because sleep is for people without deadlines.</em>
</p>

---

## 🚀 What Even IS TITAN?

TITAN is like having a super-smart intern who never sleeps, never asks for a raise, and can literally talk to your computer. You tell it what you want. It figures out how to do it. Simple as that.

**"Write a Facebook post about my new project"**
→ Done. And it'll even reply to comments. (The Facebook Autopilot caps at 6 posts/day so it stays charming, not spammy.)

**"Find me Node.js freelance jobs on Upwork"**
→ Done. It runs the browse-and-filter loop on a schedule and shows you the best matches.

**"My code is broken, fix it"**
→ Done. It reads the files, finds the bug, edits the code, and tests it — and a shadow-git snapshot lets you roll back if it gets too creative.

**"Research my competitors and make a report"**
→ Done. It browses the web, collects data, and writes a structured report.

**"Talk to me in my mom's voice"**
→ Done. F5-TTS clones voices from a short reference clip. Creepy? A little. Useful? Absolutely.

No coding required. TITAN ships with 80+ built-in skill modules registering roughly **250 tools**. If it needs something new, it can author its own skills on the fly.

---

<a id="-widget-gallery"></a>

## 🪟 Widget Gallery — 109 Templates, 28 Categories

**TITAN ships with 109 production-ready canvas widgets** across 28 categories. Plus a handful of always-on system widgets (chat, watch, voice overlay) for a few dozen more entries in the live runtime catalogue. Just say what you want — the gallery snaps it onto your dashboard in under a second.

Say: _"Pomodoro timer"_ → Pomodoro lands.
Say: _"Stock tracker for AAPL"_ → Stock tracker lands, pre-filled with AAPL.
Say: _"Control my smart lights"_ → Home Assistant light grid lands.
Say: _"Spawn a sales agent for me"_ → SDR widget lands, hooked to TITAN's agent runtime.

| Category               | Examples                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents (employees)** | Receptionist, SDR, Researcher, Coder, Bookkeeper, Data Analyst, Business Control Tower                                                                  |
| **Automation**         | Webhook listener, Cron runner, Price alert, RSS monitor, IFTTT-style rule, Daily digest                                                                 |
| **Smart home**         | Lights, Thermostat, Scenes, Sensors, Presence, Energy (wires to Home Assistant)                                                                         |
| **Software builder**   | App skeletons, Mini database, Admin panel, Landing page, Blog engine                                                                                    |
| **Finance**            | Stock tracker, Crypto portfolio, Currency converter, Mortgage calc, Bill splitter                                                                       |
| **Productivity**       | Pomodoro, Todo list, Kanban, Habit tracker                                                                                                              |
| **Utilities**          | Calculator, QR code, Password gen, Regex tester, Diff tool, Base64, World clock                                                                         |
| **Plus**               | cooking, creative, devops, e-commerce, education, games, gaming, health-fitness, homelab, lifestyle, ml/ai, multi-modal, music-dj, research, social, travel, vehicle, web |

The chat agent ALWAYS searches the gallery first (`gallery_search`) and only generates from scratch when nothing matches — so common requests are fast, consistent, and free of LLM drift. Canvas state is **Yjs CRDT-synced** across browser tabs and persists across restarts.

---

## 👾 Meet Your New Coworker

TITAN has a little floating mascot that lives on your screen. He drifts on a multi-axis idle float (translate + rotate, four keyframes — the trick we stole from Space Agent). He breathes. He blinks. He yawns. His eye actually tracks your cursor. Drag him anywhere. Leave him idle long enough and he falls asleep with drifting "Z" particles.

When TITAN is thinking, the mascot enters `thinking` state. When SOMA is running, his halo breathes in a slower, warmer rhythm — that's the **hormonal pulse**. It's like having a Tamagotchi, except this one can deploy Docker containers.

See `ui/src/titan2/system/TitanMascot.tsx` for the implementation. State enum: `idle | thinking | executing | listening | error`. Mood overlay: `neutral | happy | focused | tired`. The mascot is intentionally **decorative** — it reads agent state, it never controls it.

---

## 🧬 SOMA — TITAN Has Feelings Now

Not human feelings. Five digital homeostatic drives, each with a target setpoint and a current level. Think of it like a plant that knows when it needs water:

- **Purpose** — "Am I being useful right now?"
- **Curiosity** — "Should I learn something new today?"
- **Hunger** — "Am I running low on compute?"
- **Safety** — "Is anything about to break?"
- **Social** — "Should I post something or reply to someone?"

When a drive drifts below its setpoint, TITAN feels "pressure." Pressure turns into **proposals** — "Hey, I noticed X, should I do Y?" You approve everything; TITAN just gets better at knowing what to ask. Opt-in via `organism.enabled` in config.

Code lives in `src/organism/` (drives, pressure loop, hormonal broadcasts, shadow rehearsal). The Mission Control SOMA panel renders the live pulse — weirdly mesmerizing.

---

## 🛡️ Safety First (Because We Know You're Thinking It)

"An AI that can run shell commands? What could go wrong?"

TITAN ships with a layered safety suite:

- **PII Redaction** — Pattern-based scrubbing of emails, SSNs, credit cards, and phone numbers from outputs (`src/security/secretGuard.ts`).
- **Secret Scanner** — Catches API keys, tokens, env vars, and private keys before they leave the box.
- **Pre-Execution Scanner** — Blocks `rm -rf /`, `curl | sh`, fork bombs, `dd` to `/dev/`, and 20+ other dangerous patterns before they run (`src/security/preExecScan.ts`).
- **Shadow-Git Checkpoints** — Auto-snapshots files before every write/edit/append into a shadow repo at `~/.titan/file-checkpoints/`. Point-in-time recovery without ever touching your real git (`src/agent/shadowGit.ts`).
- **Kill Switch** — One POST pauses ALL autonomous actions. Triggers also fire on safety pressure, identity violation, canary degradation, or fix oscillation (`src/safety/killSwitch.ts`).
- **Approval Gates** — Complex plans need your thumbs-up before executing (`src/skills/builtin/approval_gates.ts`).
- **Token Auth** — Gateway returns 401 on `/api/*` unless a valid token is configured. Static asset serving stays open so the SPA loads.

Run in **supervised mode** (TITAN asks before doing anything risky) or **autonomous mode** (TITAN handles routine stuff and asks for approval on big moves).

---

<a id="-mission-control"></a>

## 🎛️ Mission Control — Your Dashboard

Open `http://localhost:48420` and you get a React 19 SPA with a Tailwind 4 canvas of draggable widgets. **45 admin panels** are wired into the runtime (verified in `ui/src/components/admin/`).

| Widget             | What It Does                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Canvas**         | The new home screen. 109 widget templates one phrase away. Drag, resize, arrange. Yjs CRDT-synced across tabs, persists across restarts. |
| **Chat**           | Talk to TITAN in plain English. It builds widgets, spawns agents, drives smart-home devices. Markdown + SSE streaming + code highlighting. |
| **Widget Gallery** | Library of 109 production-ready widgets. The chat agent searches it first; you can also browse + drop manually.                        |
| **Command Post**   | Agents, budgets, approvals, org chart, ancestry validation, atomic checkout. Run a business with TITAN agents as employees.            |
| **SOMA**           | Watch TITAN's digital hormones pulse in real time.                                                                                     |
| **Skills**         | ~143 skills loaded, ~248+ tools. Toggle each on/off (state persisted in `~/.titan/disabled-skills.json`). |
| **Voice**          | F5-TTS voice cloning via a Python sidecar (mlx-audio on Mac, GPU container on Linux) + LiveKit WebRTC. Any voice, any language.       |
| **Memory Graph**   | A visual web of everything TITAN remembers about you.                                                                                  |
| **Security**       | Audit log, checkpoint history, time travel for your files, bug-report viewer.                                                          |

---

## 🌐 TITAN Is Everywhere — 19 Channel Adapters

TITAN's `src/channels/` ships 19 channel adapters:

**Messaging:** Discord, Telegram, Slack, WhatsApp, Microsoft Teams, Facebook Messenger, Signal, Matrix, IRC, LINE, Lark, Zulip, Mattermost, Google Chat, QQ.

**Web:** WebChat (browser, WebSocket-backed).

**Voice / PSTN:** Facebook Messenger voice, Twilio voice.

**Email:** Inbound email channel.

He won't talk to strangers unless you say so. DM pairing and channel allowlists keep randos out.

---

## 🗣️ Voice Mode

- **Clone any voice** with a short reference audio clip — F5-TTS handles the rest (`scripts/f5-tts-server.py`, `scripts/f5-tts-gpu-server.py`).
- **Real-time conversation** over LiveKit WebRTC (`src/voice/`, `src/channels/messenger-voice.ts`, `src/channels/twilio-voice.ts`).
- **Natural-sounding speech** that doesn't sound like a GPS.

Great for: accessibility, hands-free coding, or just having TITAN read your standup notes back to you in your manager's voice for practice.

---

<a id="-providers"></a>

## 🧠 36 LLM Providers

**4 native:** Anthropic, OpenAI, Google, Ollama (cloud-first via `ollama/*:cloud` IDs).

**32 OpenAI-compatible** (single adapter, one config entry each): Groq, Mistral, Together, Fireworks, DeepSeek, MiniMax, xAI, Perplexity, Hyperbolic, Cerebras, OpenRouter, Replicate, plus 20 more. Add a new one in `src/providers/openai_compat.ts` with a 4-line entry.

Switch models mid-conversation with `POST /api/model/switch`. The provider router (`src/providers/router.ts`) handles fallback, retry, hallucination guards, and cloud-model tool-calling rescue.

---

## 📱 Facebook Autopilot

TITAN can run its own Facebook page. Posts up to **6 times per day** (every ~2h), following an 80/20 value/promo rule. Replies to comments (capped at 10/day). All content runs through PII redaction and dedup. Toggle off in one click if you prefer your AI to keep a low profile. Implementation: `src/skills/builtin/fb_autopilot.ts`.

---

## ⚡ Quick Start

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/install.sh | bash
```

**Or npm:**

```bash
npm install -g titan-agent
titan onboard       # Interactive setup wizard (asks for telemetry consent)
titan gateway       # Launches Mission Control at http://localhost:48420
```

**Or Docker:**

```bash
docker run -d -p 48420:48420 --name titan \
  -e ANTHROPIC_API_KEY=your-key \
  -v titan-data:/home/titan/.titan \
  ghcr.io/djtony707/titan:latest
```

Requirements: **Node ≥ 22** (pure ESM, no CJS). For GPU features (LoRA fine-tuning, F5-TTS GPU server) you'll want NVIDIA + CUDA or Apple Silicon Metal.

---

## 🏠 TITAN At Home

Connect TITAN to your smart home through Home Assistant (`src/skills/builtin/smart_home.ts`). Control lights, thermostats, locks, and sensors. Ask "Is the front door locked?" and TITAN checks. Say "Make it cozy" and TITAN dims the lights and sets the thermostat.

---

## 🔗 Mesh Networking

Got multiple computers? Link them. TITAN instances discover each other via mDNS on the local network and can be statically peered over Tailscale or any other overlay. Distribute work across your homelab like a mini supercomputer. Code: `src/mesh/` (discovery, identity, registry, HMAC-authenticated transport).

---

## 🧠 It Gets Smarter While You Sleep

TITAN runs self-improvement experiments in the background. The trajectory logger records every tool call, every outcome. The `autoresearch/` pipeline can:

1. **Generate training data** from real conversation trajectories (`autoresearch/generate_data.py`, `autoresearch/generate_agent_data.py`).
2. **LoRA fine-tune** local Ollama models on that data — rank/alpha/lr fully agent-tunable (`autoresearch/train.py`, `src/skills/builtin/model_trainer.ts`). Defaults: rank 16, alpha 32, 2e-4 LR, qwen3.5:35b base on RTX 5090.
3. **Deploy back to Ollama** automatically (`autoresearch/deploy.py`).

You wake up to a slightly smarter agent. Like compound interest, but for AI.

---

## 🧪 Testing — 258 Files, 6,100+ Cases

TITAN ships with **five layered testing stages** that catch regressions at different levels:

| Layer                      | What it covers                                                                                                                                 | Run it                               | Speed    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| **Unit**                   | Pure functions: regex (`isDangerous`), pipeline classifier, gate extraction, token budget, secret scanner. Zero LLM calls.                     | `npm test -- tests/unit/`           | seconds  |
| **Mock trajectory**        | Tape-replay through `MockOllamaProvider`. Asserts the agent calls the right tools in the right order using recorded responses. Zero LLM calls. | `npm test -- tests/eval/trajectory`  | < 1 s    |
| **Cross-model parity**     | Same scenario replayed across multiple provider tapes. Catches behavioural divergence when one provider drifts. Zero LLM calls.                | `npm run test:parity`                | < 1 s    |
| **Full deterministic**     | The whole vitest run: gateway tests, mission-control tests, skill tests, safety tests, all integration mocks. **6,100+ tests, ~3:25 wall.**    | `npm test`                          | ~3 min   |
| **Live eval (gated)**      | **11 suites** of behavioural tests against the running agent (`/api/eval/run`): WIDGET_CREATION, SAFETY, TOOL_ROUTING (v1+v2), GATE_FORMAT (v1+v2), PIPELINE, ADVERSARIAL, SESSION, CONTENT, WIDGET_V2. 80 % pass rate per suite is the merge gate. | `npm run test:eval`                 | 5–15 min |

The 11 live-eval suites are defined in `src/eval/harness.ts`. The merge gate is `.github/workflows/eval-gate.yml`. If any suite drops below 80 % pass rate, the job fails and (with branch protection) the PR can't merge.

### Adding a new test

```bash
# Pure-function unit test:
echo "..." > tests/unit/my_new_func.test.ts && npm test

# New tape (record once against a real model):
TITAN_RECORD_TAPE=my_scenario npm test -- tests/eval/trajectory.test.ts

# New eval case: edit src/eval/harness.ts, add to the relevant *_SUITE array,
# then verify with: npm run test:eval -- --suite safety
```

---

## ⚠️ Reality Check

TITAN is experimental. It can execute commands, modify files, and take autonomous actions. **Use at your own risk.** Think of it as "a very motivated intern with root access who never sleeps and occasionally gets _too_ creative."

Start in supervised mode. Review what it does. Don't give it access to systems you can't afford to lose. The safety features are strong, but common sense is stronger.

---

## 📊 The Numbers (Verified Against Current Source)

| Thing                | Count | Where to verify |
| -------------------- | ----- | --------------- |
| **Version**          | see `package.json` (currently 5.5.x line) | `package.json` `version` field |
| **LLM providers**    | 36 (4 native + 32 OpenAI-compat) | `src/providers/openai_compat.ts` + native files |
| **Channel adapters** | 19 | `src/channels/*.ts` (minus base) |
| **Built-in skill modules** | 83 files | `src/skills/builtin/` |
| **Skills loaded at runtime** | ~143 | `GET /api/skills` |
| **Tools** | ~248–260 | `GET /api/skills` (each skill registers 1+ tools) |
| **Widget templates** | 109 JSON files in 28 categories | `assets/widget-templates/` |
| **Admin panels (Mission Control)** | 45 | `ui/src/components/admin/*Panel.tsx` |
| **Test files**       | 258 | `tests/` (vitest) |
| **Test cases**       | 6,100+ | `grep -rE "^\s*(it\|test)\(" tests/` |
| **Live-eval suites** | 11 | `src/eval/harness.ts` exported `*_SUITE` consts |
| **Gateway port (default)** | 48420 | `src/utils/constants.ts` `DEFAULT_GATEWAY_PORT` |
| **Node**             | ≥ 22, pure ESM | `package.json` engines + `"type": "module"` |
| **License**          | MIT | `LICENSE` |

> Want to re-verify any number? Every row above has a code path. The repo has a self-check at `tests/unit/readme-claims.test.ts` that fails the suite if widget count or voice glue drifts beyond tolerance.

---

## 🛠️ Architecture in 30 Seconds

```
src/
├── agent/        # Core loop, sub-agents, orchestrator, Command Post governance, shadow-git checkpoints
├── browsing/     # Shared Playwright browser pool + CapSolver CAPTCHA
├── channels/     # 19 channel adapters
├── config/       # Zod-validated config schema (the single source of truth)
├── context/      # ContextEngine plugin system (compression, smart compress, hindsight)
├── eval/         # 11 live-eval suites + harness
├── gateway/      # Express server + Mission Control v2 SPA mount
├── mcp/          # MCP Server (JSON-RPC 2.0, stdio + HTTP)
├── memory/       # Memory, learning, graph, relationships, briefings, experiments
├── mesh/         # mDNS discovery, HMAC transport, identity, registry
├── organism/     # TITAN-SOMA: 5 drives, pressure loop, hormonal broadcasts
├── providers/    # 36-provider router with fallback + retry
├── safety/       # killSwitch, fabricationGuard, oscillation detector
├── security/     # secretGuard (PII), preExecScan, sandbox bind
├── skills/       # 83 builtin skill files registering ~248+ tools
├── voice/        # LiveKit WebRTC bridge to F5-TTS sidecar
└── vram/         # GPU VRAM orchestrator (nvidia-smi polling, model swap leases)
ui/               # React 19 SPA (Vite + Tailwind CSS 4 + Yjs CRDT canvas)
tests/            # 258 vitest test files
autoresearch/     # LoRA fine-tuning pipeline (prepare → train → deploy)
scripts/          # F5-TTS sidecars (Mac + Linux GPU), benchmarks, evals
```

---

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>Star ⭐ the repo if TITAN made you smile, saved you time, or made you say "wait, it can do WHAT?"</em>
</p>
