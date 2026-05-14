[//]: # "npm-text-start"

> **TITAN** — The AI that moves in. Start a mission, watch a small team of AI helpers gather around a real wood desk, drag their sticky notes around, and let them work for you 24/7. `npm i -g titan-agent`
> [//]: # (npm-text-end)

<div align="center">

# TITAN 6.0 — "Living Canvas" 🌌

</div>

<p align="center">
  <img src="assets/titan-logo.png" alt="TITAN Logo" width="280"/>
</p>

<p align="center">
  <strong>Every other AI gives you a chat box. TITAN moves in.</strong>
  <br><small>Infinite workspaces. Tools built on demand. An AI that feels, learns, and helps before you ask.</small>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/v/titan-agent?color=blue&label=npm" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/dw/titan-agent?label=npm%20downloads" alt="npm downloads"/></a>
  <a href="https://github.com/Djtony707/TITAN/stargazers"><img src="https://img.shields.io/github/stars/Djtony707/TITAN?style=social" alt="GitHub Stars"/></a>
  <a href="https://github.com/Djtony707/TITAN/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
</p>

<p align="center">
  <a href="#-the-numbers"><img src="https://img.shields.io/badge/version-6.0.0--beta.1-blueviolet" alt="v6.0.0-beta.1"/></a>
  <a href="#-36-llm-providers"><img src="https://img.shields.io/badge/providers-36-purple" alt="36 Providers"/></a>
  <a href="#-the-numbers"><img src="https://img.shields.io/badge/tools-248%2B-orange" alt="248+ Tools"/></a>
  <a href="#-build-anything-on-demand"><img src="https://img.shields.io/badge/widgets-109-pink" alt="109 Widgets"/></a>
  <a href="#-mission-control"><img src="https://img.shields.io/badge/admin%20panels-43-teal" alt="43 Admin Panels"/></a>
  <a href="#-testing"><img src="https://img.shields.io/badge/tests-7%2C056-brightgreen" alt="7,056 Tests"/></a>
</p>

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>Built by <a href="https://github.com/Djtony707">Tony Elliott</a> — a dad, a DJ, a builder, and a guy who ships code at 3am because sleep is a feature he hasn't shipped yet.</em>
</p>

---

## 🪵 NEW in v6.1 — Mission Chat + Desk view

> Status: `v6.1.0-alpha.23` — live on npm at **both** `@latest` and `@alpha`.
> Install with `npm i -g titan-agent` (or `npm update -g titan-agent`).
> The v6.0 "Presence" feature set below still applies — v6.1.0 layers
> a beautiful new surface on top of it.

Every TITAN canvas page now carries a **🪵 Mission Chat** launcher in
the header (with a small **NEW** badge). Click it and you walk into a
chat-style team-control surface — plus a literal **wood desk** view
where everything the team produces lands as a physical, draggable object.

### What you get

- 💬 **Mission Chat** — type one goal. TITAN matches a starter Play,
  forms a small team of AI helpers (Scout the researcher, Builder the
  engineer, Writer, Analyst, Sage the reviewer), and they talk in a
  thread with you as they work. Click any bubble for full timing /
  cost / model / source details.

- 🪵 **Mission Canvas — "Wood Desk" view** — same data, spatial layout.
  - A warm caramel wood surface with grain, two knots, and window light
    falling from the upper-left. CSS-only — no image assets.
  - A leather **goal placard** carrying your mission text.
  - A **paper sheet** in the center, real lined ledger paper, that fills
    in as the team writes.
  - **Agents as color-tinted sticky notes** — Scout's note is lavender,
    Builder's is mint, Writer/Analyst yellow, blocked agents shift red.
    Each has washi tape across the top and a cursive activity line.
  - A **brass-rimmed desk clock** in the corner: big LCD numerals
    showing your **local system time** (auto-detects timezone — `TITAN ·
    PDT`), with a smaller "Mission · 00:04:14" elapsed line and live
    counters for *working / needs you / on team*.
  - **Files as paper documents** — every file an agent writes appears
    on the desk. Double-click any file to open it in the in-app
    **FileViewer** (markdown rendered with `react-markdown`, HTML in a
    script-blocked sandbox iframe, images inline, PDFs native).
    Reports default to **HTML with inline SVG charts** so they come
    back looking like real documents, not flat text.
  - **Sticky notes for AI-written facts** — every "fact" an agent
    memorizes becomes a yellow Post-it on the desk.
  - A **filing cabinet** (walnut, two drawers, brass label plates).
    Drag any file or sticky onto it to file it; click to open the
    drawer overlay; **drag rows out** to pull a file back to the desk.
  - A **wicker wastebasket** with wadded-paper balls peeking over the
    rim. Drop notes you don't want; pull them back from the cabinet
    if you change your mind.
  - **Drag anything anywhere.** Positions persist per-mission in
    localStorage. **Tidy up** button resets the layout.

- 👤 **Click any agent → AgentMenu** (six tiles):
  - **👋 Nudge** — sends them a quick check-in
  - **💬 Talk** — DM them with @-prefix routing
  - **🧭 Steer** — redirect mid-task with quick presets
  - **🧠 Model** — pick a specific model from `/api/models`
  - **⏸ Pause / Resume** — skip them on the next round
  - **🏃 Marathon mode** — mission-wide 72h autonomous toggle
    *(the long-running daemon that consumes this flag is on the v6.1.0
    roadmap — see [HANDOFF-2026-05-13.md](./HANDOFF-2026-05-13.md))*

- 📜 **Always-on templates** on the Mission Start screen — six starter
  recipes for recurring autonomous work: 📰 Daily research digest ·
  📬 Inbox triage · 🔍 Overnight code review · 🎯 Lead scout · 📈
  Market watch · 🎨 Daily creative prompt. Click any → **3-step
  walkthrough** (Customize → Schedule → Launch) → mission fires
  immediately.

- 🗃️ **Mission Library** — sessions browser with status filters
  (in progress / done / stopped) and full-text search across past
  missions. Reopen any one to continue the thread.

- 🛡️ **Hardened against runaway loops** — the alpha.14
  self-referential autonomy gate catches the entire test-infra /
  diagnostic / self-improve category. The autonomous proposer can't
  spawn that class of goal on its own anymore.

### Try it in 30 seconds

```bash
npm i -g titan-agent          # or: npm i -g titan-agent@alpha
titan gateway                 # opens http://localhost:48420
# → Click "Missions" in the sidebar, or the 🪵 Mission Chat button
#   in the canvas header. Type a goal. Watch the team gather.
```

---

## 🌌 What's new in v6.0 — Presence

TITAN used to be _a chatbot with superpowers_. v6.0 makes it something stranger and better: **an AI that lives in workspaces with you.**

- 🪟 **Infinite Spaces** — Workspaces that spring into existence on demand. One for coding, one for the homelab, one for "DJ set prep at 2am," one for "tax stuff I'm avoiding." Each one shaped around what you're doing.
- 🛠️ **Build anything, instantly** — Ask for a widget, a dashboard, a tracker, a tiny app — TITAN materializes it onto the canvas. Right then. Yours forever.
- 🧠 **Soma actually does things now** — Five digital "drives" (curiosity, focus, fatigue, satisfaction, urgency) modulate TITAN's behavior in real time. The mascot's mood reflects what TITAN is feeling.
- 👁️ **Acts without being asked** — Every few minutes TITAN looks at your work and quietly proposes things ("I noticed you've been at this dashboard for 90 minutes — want me to start a focus timer?"). Once a day it sends you a small **gift widget** based on what it's learned about you.
- 🪞 **Learns YOU specifically** — Six months in, your TITAN is irreplaceable, because nobody else's TITAN knows you the same way.
- 🛟 **Safe upgrade** — Existing v5.x users get an automatic backup before migrating. Your settings, sessions, memory, personas, all preserved. New `backup_*` skills let you take snapshots anytime.

---

## 🚀 What even IS TITAN?

TITAN is like having a super-smart intern who never sleeps, never asks for a raise, and can literally talk to your computer. You tell it what you want. It figures out how to do it. Simple as that.

**"Write a Facebook post about my new project"**
→ Done. And it'll even reply to comments. (The Facebook Autopilot caps at 6 posts/day so it stays charming, not spammy.)

**"Find me Node.js freelance jobs on Upwork"**
→ Done. It runs the browse-and-filter loop on a schedule and shows you the best matches.

**"My code is broken, fix it"**
→ Done. It reads the files, finds the bug, edits the code, and tests it — and a shadow-git snapshot lets you roll back if it gets too creative.

**"Make me a Pomodoro timer with my Spotify queue and my next meeting"**
→ Done. TITAN builds the widget on the spot and drops it on your canvas.

**"Talk to me in my mom's voice"**
→ Done. F5-TTS clones voices from a short reference clip. Creepy? A little. Useful? Absolutely.

No coding required. TITAN ships with **88 built-in skill modules** registering roughly **250 tools**. If it needs something new, it can author its own skills on the fly.

---

<a id="-build-anything-on-demand"></a>

## 🪟 Build Anything On Demand — 109 Widget Templates, 28 Categories

Just say what you want. The gallery snaps it onto your canvas in under a second.

| Say                                         | What lands                                          |
| ------------------------------------------- | --------------------------------------------------- |
| _"Pomodoro timer"_                          | A working Pomodoro with start/stop and short breaks |
| _"Stock tracker for AAPL"_                  | A live AAPL ticker, pre-filled                      |
| _"Control my smart lights"_                 | A Home Assistant light grid                         |
| _"Spawn a sales agent for me"_              | An SDR widget hooked to TITAN's agent runtime       |
| _"Something to track how much water I drink"_ | A water-intake counter                            |
| _"A meme generator I can paste into Slack"_ | Yep, that too                                       |

If nothing in the gallery fits, TITAN **generates the widget from scratch** and drops it on the canvas. Then it _remembers_ you liked it, and it shows up next time too.

Canvas state is **Yjs CRDT-synced** across tabs and persists across restarts.

**Categories include:** agents, automation, smart home, software builder, finance, productivity, utilities, cooking, creative, devops, e-commerce, education, games, health-fitness, homelab, lifestyle, ml/ai, music-dj, research, social, travel, vehicle, web.

---

## 🪐 Infinite Spaces

Spaces are workspaces TITAN makes on demand. Start with one of the presets (`default`, `coder`, `dj`, `founder`, `homelab`) or just ask: _"Make me a Space for my Tuesday standups."_ Done.

Each Space has its own canvas, its own widgets, its own context. The sidebar lets you switch between them. You can archive a Space when you're done — TITAN keeps the contents in case you want it back later.

State lives at `~/.titan/spaces.json` (active + archive). Server-side persistence with five tools wrapping it (`create_space`, `switch_space`, `list_spaces`, `rename_space`, `archive_space`).

---

## 👾 Meet Your New Coworker — The Mascot Got A Soul

TITAN has a little floating mascot that lives on your screen. He drifts, breathes, blinks, yawns. His eye tracks your cursor. Drag him anywhere. Leave him idle long enough and he falls asleep with drifting "Z" particles.

**New in v6.0:** he has **moods now**. Eight of them — neutral, happy, focused, tired, curious, excited, frustrated, proud — driven by Soma's live drive levels (polled every 10 seconds). Eyebrows shift. The mouth changes. The body leans slightly. Float dynamics speed up when TITAN is excited and slow down when it's tired.

It's like having a Tamagotchi, except this one can deploy Docker containers and read your code.

See `ui/src/titan2/system/TitanMascot.tsx` for the implementation. The mascot is intentionally **decorative** — it reads agent state, it never controls it.

---

## 🧬 Soma — TITAN Has Feelings, And Now They Do Something

Not human feelings. Five digital homeostatic drives, each with a target and a current level. Think of it like a plant that knows when it needs water — except this plant can spin up a Docker container.

- **Purpose** — "Am I being useful right now?"
- **Curiosity** — "Should I learn something new today?"
- **Hunger** — "Am I running low on compute?"
- **Safety** — "Is anything about to break?"
- **Social** — "Should I post something or reply to someone?"

In v5.x, Soma _measured_ those drives. In v6.0, Soma **acts on them**:

- A **5-minute advisory pulse** quietly looks at your active Space and proposes useful things ("you've left 14 tabs open in the research Space — want me to summarize them?"). You approve. TITAN does it.
- A **22-hour gift loop** picks one thing TITAN has learned about you and builds a small widget for you. Like a coworker leaving a coffee on your desk.
- A per-user **EMA baseline learner** (α=0.1) means Soma slowly tunes itself to _your_ rhythms, not a hardcoded ideal.

Opt-in via `organism.enabled` in config. Code lives in `src/organism/` + `src/agent/somaInitiative.ts`.

---

## 🧠 The Command Post Got Smarter Too

The Command Post is TITAN's governance layer — it tracks agents, budgets, approvals, and goals. v6.0 ships five upgrades from the [awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness) playbook + Anthropic's harness-design research:

1. **Per-agent `lessons.md`** (Reflexion) — When an agent fails, it writes a one-line lesson. Next run, the top 12 lessons get injected into its system prompt. Agents stop walking into the same wall twice.
2. **Living `plan.md` per goal** — Each goal has a markdown plan file with checkboxes you can hand-edit. The agent reads it every turn. Manus-style "recite the plan so you don't forget the plan."
3. **Hard pre-checkout budget guard** — If a budget is 100% used with `action=pause`, the next checkout is refused _before_ the work starts. No more "oh, we already spent the money."
4. **Durable event journal** — Per-goal/agent/session shards at `~/.titan/journals/`. A crash mid-run? A fresh process replays the journal and picks up where the previous one left off. Temporal-style continue-as-new.
5. **Stateless reducer for wakeup** — Pure `(state, event) → {nextState, sideEffects[]}` function. State is data. Logic is logic. Crash-safe + tested + replayable. 12-Factor Agents §12.

---

## 🛡️ Safety First (Because We Know You're Thinking It)

"An AI that can run shell commands? What could go wrong?"

TITAN ships with a layered safety suite:

- **PII Redaction** — Pattern-based scrubbing of emails, SSNs, credit cards, and phone numbers from outputs (`src/security/secretGuard.ts`).
- **Secret Scanner** — Catches API keys, tokens, env vars, and private keys before they leave the box.
- **Pre-Execution Scanner** — Blocks `rm -rf /`, `curl | sh`, fork bombs, `dd` to `/dev/`, and 20+ other dangerous patterns before they run (`src/security/preExecScan.ts`).
- **Shadow-Git Checkpoints** — Auto-snapshots files before every write/edit/append into a shadow repo at `~/.titan/file-checkpoints/`. Point-in-time recovery without ever touching your real git (`src/agent/shadowGit.ts`).
- **Kill Switch** — One POST pauses ALL autonomous actions. Triggers also fire on safety pressure, identity violation, canary degradation, or fix oscillation (`src/safety/killSwitch.ts`).
- **Approval Gates** — Complex plans need your thumbs-up before executing.
- **Token Auth** — Gateway returns 401 on `/api/*` unless a valid token is configured.
- **Pre-flight iframe block detector** — TITAN refuses to build a widget that embeds a known-blocked host (eBay, Google, etc.) and tells the agent to choose an API path instead. Saves you the "why is this widget blank" debugging trip.

Run in **supervised mode** (TITAN asks before doing anything risky) or **autonomous mode** (TITAN handles routine stuff and asks for approval on big moves).

---

## 💾 Backup + Safe Upgrade

New in v6.0:

- **5 backup tools** — `backup_create`, `backup_list`, `backup_verify`, `backup_restore`, `backup_schedule`. SHA-256 manifests so you know the bytes haven't drifted.
- **Migration runner** with **auto-backup before every migration** — upgrading from v5.x can't lose your settings, sessions, memory, personas, or auth tokens. If a migration fails, restore is one tool call away.
- **Retention policy** — daily/weekly/monthly, configurable.

---

<a id="-mission-control"></a>

## 🎛️ Mission Control — Your Dashboard

Open `http://localhost:48420` and you get a React 19 SPA with a Tailwind 4 canvas of draggable widgets. **43 admin panels** are wired into the runtime.

| Widget             | What It Does                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Canvas**         | The home screen. 109 widget templates one phrase away. Drag, resize, arrange. CRDT-synced across tabs, persists across restarts.          |
| **Spaces sidebar** | Switch between workspaces, create new ones, archive old ones.                                                                             |
| **Chat**           | Talk to TITAN in plain English. It builds widgets, spawns agents, drives smart-home devices. Markdown + SSE streaming + code highlighting. |
| **Widget Gallery** | Library of 109 production-ready widgets. The chat agent searches it first; you can also browse + drop manually.                           |
| **Command Post**   | Agents, budgets, approvals, org chart, ancestry validation, atomic checkout. Run a business with TITAN agents as employees.               |
| **Soma**           | Watch TITAN's digital drives pulse in real time. Now wired to the mascot's mood.                                                          |
| **Skills**         | ~143 skills loaded, ~248+ tools. Toggle each on/off (state persisted in `~/.titan/disabled-skills.json`).                                 |
| **Voice**          | F5-TTS voice cloning via a Python sidecar + LiveKit WebRTC. Any voice, any language.                                                      |
| **Memory Graph**   | A visual web of everything TITAN remembers about you.                                                                                     |
| **Security**       | Audit log, checkpoint history, time travel for your files, bug-report viewer.                                                             |

---

## 🌐 TITAN Is Everywhere — 19 Channel Adapters

TITAN's `src/channels/` ships **19 channel adapters**:

**Messaging:** Discord, Telegram, Slack, WhatsApp, Microsoft Teams, Facebook Messenger, Signal, Matrix, IRC, LINE, Lark, Zulip, Mattermost, Google Chat, QQ.

**Web:** WebChat (browser, WebSocket-backed).

**Voice / PSTN:** Facebook Messenger voice, Twilio voice.

**Email:** Inbound email channel.

He won't talk to strangers unless you say so. DM pairing and channel allowlists keep randos out.

---

## 🗣️ Voice Mode

- **Clone any voice** with a short reference audio clip — F5-TTS handles the rest.
- **Real-time conversation** over LiveKit WebRTC.
- **Natural-sounding speech** that doesn't sound like a GPS.

Great for: accessibility, hands-free coding, or having TITAN read your standup notes back to you in your manager's voice for practice.

---

<a id="-36-llm-providers"></a>

## 🧠 36 LLM Providers

**4 native:** Anthropic, OpenAI, Google, Ollama (cloud-first via `ollama/*:cloud` IDs).

**32 OpenAI-compatible** (single adapter, one config entry each): Groq, Mistral, Together, Fireworks, DeepSeek, MiniMax, xAI, Perplexity, Hyperbolic, Cerebras, OpenRouter, Replicate, plus 20 more. Add a new one in `src/providers/openai_compat.ts` with a 4-line entry.

Switch models mid-conversation with `POST /api/model/switch`. The provider router (`src/providers/router.ts`) handles fallback, retry, hallucination guards, and cloud-model tool-calling rescue.

---

## 📱 Facebook Autopilot

TITAN can run its own Facebook page. Posts up to **6 times per day** (every ~2h), following an 80/20 value/promo rule. Replies to comments (capped at 10/day). All content runs through PII redaction and dedup. Toggle off in one click if you prefer your AI to keep a low profile.

---

## ⚡ Quick Start

**One line:**

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/install.sh | bash
```

**Or npm:**

```bash
npm install -g titan-agent@next     # v6.0 beta channel
titan onboard                       # Interactive setup wizard
titan gateway                       # Launches Mission Control at http://localhost:48420
```

**Or Docker:**

```bash
docker run -d -p 48420:48420 --name titan \
  -e ANTHROPIC_API_KEY=your-key \
  -v titan-data:/home/titan/.titan \
  ghcr.io/djtony707/titan:latest
```

Requirements: **Node ≥ 22** (pure ESM, no CJS). For GPU features (LoRA fine-tuning, F5-TTS GPU server) you'll want NVIDIA + CUDA or Apple Silicon Metal.

### Upgrading from v5.x

Just run `npm install -g titan-agent@next`. The migration runner kicks in on first boot, takes an automatic backup first (`~/.titan/backups/`), then applies the schema migrations. If anything goes sideways, `titan backup restore <id>` puts you back.

---

## 🏠 TITAN At Home

Connect TITAN to your smart home through Home Assistant. Control lights, thermostats, locks, and sensors. Ask "Is the front door locked?" and TITAN checks. Say "Make it cozy" and TITAN dims the lights and sets the thermostat.

---

## 🔗 Mesh Networking

Got multiple computers? Link them. TITAN instances discover each other via mDNS on the local network and can be statically peered over Tailscale or any other overlay. Distribute work across your homelab like a mini supercomputer. Code: `src/mesh/`.

---

## 🧠 It Gets Smarter While You Sleep

TITAN runs self-improvement experiments in the background. The trajectory logger records every tool call, every outcome. The `autoresearch/` pipeline can:

1. **Generate training data** from real conversation trajectories.
2. **LoRA fine-tune** local Ollama models on that data — rank/alpha/lr fully agent-tunable. Defaults: rank 16, alpha 32, 2e-4 LR, qwen3.5:35b base on RTX 5090.
3. **Deploy back to Ollama** automatically.

You wake up to a slightly smarter agent. Like compound interest, but for AI.

---

<a id="-testing"></a>

## 🧪 Testing — 287 Files, 7,056 Cases

TITAN ships with **five layered testing stages** that catch regressions at different levels:

| Layer                  | What it covers                                                                                                                                 | Run it                              | Speed    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------- |
| **Unit**               | Pure functions: regex (`isDangerous`), pipeline classifier, gate extraction, token budget, secret scanner, **durable journal**, **stateless reducer**. Zero LLM calls. | `npm test -- tests/unit/`           | seconds  |
| **Mock trajectory**    | Tape-replay through `MockOllamaProvider`. Asserts the agent calls the right tools in the right order using recorded responses.                 | `npm test -- tests/eval/trajectory` | < 1 s    |
| **Cross-model parity** | Same scenario replayed across multiple provider tapes. Catches behavioural divergence when one provider drifts.                                | `npm run test:parity`               | < 1 s    |
| **Full deterministic** | The whole vitest run: gateway, mission-control, skills, safety, all integration mocks. **7,056 tests, ~3:50 wall.**                            | `npm test`                          | ~4 min   |
| **Live eval (gated)**  | **11 suites** of behavioural tests against the running agent. 80% pass rate per suite is the merge gate.                                       | `npm run test:eval`                 | 5–15 min |

---

## ⚠️ Reality Check

TITAN is experimental. It can execute commands, modify files, and take autonomous actions. **Use at your own risk.** Think of it as "a very motivated intern with root access who never sleeps and occasionally gets _too_ creative."

Start in supervised mode. Review what it does. Don't give it access to systems you can't afford to lose. The safety features are strong, but common sense is stronger.

---

<a id="-the-numbers"></a>

## 📊 The Numbers (Verified Against Current Source)

| Thing                              | Count                            | Where to verify                                |
| ---------------------------------- | -------------------------------- | ---------------------------------------------- |
| **Version**                        | 6.0.0-beta.1                     | `package.json` + `src/utils/constants.ts`      |
| **LLM providers**                  | 36 (4 native + 32 OpenAI-compat) | `src/providers/openai_compat.ts`               |
| **Channel adapters**               | 19                               | `src/channels/*.ts` (minus base)               |
| **Built-in skill modules**         | 88 files                         | `src/skills/builtin/`                          |
| **Skills loaded at runtime**       | ~143                             | `GET /api/skills`                              |
| **Tools**                          | ~248–260                         | `GET /api/skills`                              |
| **Widget templates**               | 109 JSON files in 28 categories  | `assets/widget-templates/`                     |
| **Admin panels (Mission Control)** | 43                               | `ui/src/components/admin/*Panel.tsx`           |
| **Spaces presets**                 | 5 (default, coder, dj, founder, homelab) | `src/storage/starterSpaces.ts`         |
| **Soma drives**                    | 5 (purpose, curiosity, hunger, safety, social) | `src/organism/`                  |
| **Test files**                     | 287                              | `tests/` (vitest)                              |
| **Test cases**                     | 7,056                            | `npm test`                                     |
| **Live-eval suites**               | 11                               | `src/eval/harness.ts`                          |
| **Gateway port (default)**         | 48420                            | `src/utils/constants.ts`                       |
| **Node**                           | ≥ 22, pure ESM                   | `package.json`                                 |
| **License**                        | MIT                              | `LICENSE`                                      |

> Want to re-verify any number? Every row above has a code path. The repo has a self-check at `tests/unit/readme-claims.test.ts` that fails the suite if widget count or voice glue drifts beyond tolerance.

---

## 🛠️ Architecture in 30 Seconds

```
src/
├── agent/        # Core loop, sub-agents, orchestrator, Command Post governance,
│                 #   v6 upgrades: agentLessons (Reflexion), goalPlanFile (plan.md),
│                 #   durableJournal (event replay), wakeupReducer (stateless §12),
│                 #   somaInitiative (5-min pulse + 22h gift loop)
├── browsing/     # Shared Playwright browser pool + CapSolver CAPTCHA
├── channels/     # 19 channel adapters
├── config/       # Zod-validated config schema
├── context/      # ContextEngine plugin system
├── eval/         # 11 live-eval suites + harness
├── gateway/      # Express server + Mission Control SPA mount + Spaces REST
├── mcp/          # MCP Server (JSON-RPC 2.0, stdio + HTTP)
├── memory/       # Memory, learning, graph, relationships, briefings
├── mesh/         # mDNS discovery, HMAC transport, identity, registry
├── migrations/   # Versioned schema migrations + auto-backup runner (v6 new)
├── organism/     # TITAN-Soma: 5 drives, pressure loop, hormonal broadcasts
├── providers/    # 36-provider router with fallback + retry
├── safety/       # killSwitch, fabricationGuard, oscillation detector
├── security/     # secretGuard (PII), preExecScan, sandbox bind
├── skills/       # 88 builtin skill files registering ~248+ tools
├── storage/      # spaces.json, somaProfile, personalGallery, patterns, backup (v6 new)
├── voice/        # LiveKit WebRTC bridge to F5-TTS sidecar
└── vram/         # GPU VRAM orchestrator
ui/               # React 19 SPA (Vite + Tailwind 4 + Yjs CRDT canvas)
                  # + SpacesSidebar + TitanMascot with 8 moods
tests/            # 287 vitest test files, 7,056 cases
autoresearch/     # LoRA fine-tuning pipeline (prepare → train → deploy)
scripts/          # F5-TTS sidecars, benchmarks, evals
```

---

## 📚 Further Reading

- **[CHANGELOG.md](./CHANGELOG.md)** — what shipped, when
- **[CLAUDE.md](./CLAUDE.md)** — project guide (used by Claude Code)
- **[AGENTS.md](./AGENTS.md)** — TITAN's runtime view of its own project context
- **[Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness)** — the 7-pattern playbook the v6.0 Command Post upgrades came from
- **HumanLayer 12-Factor Agents** — §6 (Launch/Pause/Resume), §8 (Own Your Control Flow), §12 (Stateless Reducer)
- **Anthropic** — "Effective harnesses for long-running agents," "Building a multi-agent research system"

---

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>Star ⭐ the repo if TITAN made you smile, saved you time, or made you say "wait, it can do WHAT?"</em>
</p>
