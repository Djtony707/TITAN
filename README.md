[//]: # (npm-text-start)
> **TITAN** — The AI that actually *does* things. It remembers your name. It learns what you like. It writes your emails, codes your ideas, posts for you, and keeps getting smarter while you sleep. Oh, and it has a little floating mascot. `npm i -g titan-agent`
[//]: # (npm-text-end)

# TITAN 5.0 — "Spacewalk" 🚀

<p align="center">
  <img src="assets/titan-logo.png" alt="TITAN Logo" width="280"/>
</p>

<p align="center">
  <strong>Your own AI employee. It thinks. It acts. It learns. It even has feelings.*</strong>
  <br><small>*Digital feelings. Don't call HR.</small>
</p>

<p align="center">
  <a href="https://github.com/Djtony707/TITAN/stargazers"><img src="https://img.shields.io/github/stars/Djtony707/TITAN?style=social" alt="GitHub Stars"/></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/dw/titan-agent?label=npm%20downloads" alt="npm downloads"/></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/titan-agent"><img src="https://img.shields.io/npm/v/titan-agent?color=blue&label=npm" alt="npm version"/></a>
  <a href="https://github.com/Djtony707/TITAN/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
  <a href="#providers"><img src="https://img.shields.io/badge/providers-37-purple" alt="37 Providers"/></a>
  <a href="#built-in-tools"><img src="https://img.shields.io/badge/tools-253-orange" alt="253 Tools"/></a>
  <a href="#widget-gallery"><img src="https://img.shields.io/badge/widgets-110-pink" alt="110 Widgets"/></a>
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
→ Done. And it'll even reply to comments.

**"Find me Node.js freelance jobs on Upwork"**
→ Done. It checks daily and shows you the best matches.

**"My code is broken, fix it"**
→ Done. It reads the files, finds the bug, edits the code, and tests it.

**"Research my competitors and make a report"**
→ Done. It browses the web, collects data, and writes a structured report.

**"Talk to me in Andrew's voice"**
→ Done. It clones voices with 10 seconds of audio. Creepy? A little. Useful? Absolutely.

No coding required. TITAN comes with **253 tools** out of the box. If it needs something new, it builds it on the fly.

---

<a id="widget-gallery"></a>
## 🪟 NEW in 5.0 — Widget Gallery (110 Templates)

**TITAN now ships with 110 production-ready canvas widgets** across 25 categories. Just say what you want — the gallery snaps it onto your dashboard in under a second.

Say: *"Pomodoro timer"* → Pomodoro lands.
Say: *"Stock tracker for AAPL"* → Stock tracker lands, pre-filled with AAPL.
Say: *"Control my smart lights"* → Home Assistant light grid lands.
Say: *"Spawn a sales agent for me"* → Sales SDR widget lands, hooked to TITAN's agent runtime.

| Category | Examples |
|---|---|
| **Agents (employees)** | Receptionist, SDR, Researcher, Coder, Bookkeeper, Data Analyst, Business Control Tower |
| **Automation** | Webhook listener, Cron runner, Price alert, RSS monitor, IFTTT-style rule, Daily digest |
| **Smart home** | Lights, Thermostat, Scenes, Sensors, Presence, Energy (wires to Home Assistant) |
| **Software builder** | App skeletons, Mini database, Admin panel, Landing page, Blog engine |
| **Finance** | Stock tracker, Crypto portfolio, Currency converter, Mortgage calc, Bill splitter |
| **Productivity** | Pomodoro, Todo list, Kanban, Habit tracker |
| **Utilities** | Calculator, QR code, Password gen, Regex tester, Diff tool, Base64, World clock |
| **Plus** | cooking, creative, devops, e-commerce, gaming, health-fitness, homelab, lifestyle, ml-ai, multi-modal, music-dj, research, social, travel, vehicle, web |

The chat agent ALWAYS searches the gallery first and only generates from scratch when nothing matches — so common requests are fast, consistent, and free of broken APIs or LLM drift.

---

## 👾 Meet Your New Coworker

TITAN has a little floating mascot that lives on your screen. He floats. He blinks. He yawns when he's bored. He follows your cursor with his eye. Drag him anywhere. Leave him idle too long and he falls asleep with drifting "Z"s.

When TITAN is thinking, the mascot shows a thinking bubble. When he's feeling hormonal (yes, really), his halo pulses. It's like having a Tamagotchi, except this one can deploy Docker containers.

---

## 🧬 SOMA — TITAN Has Feelings Now

Not human feelings. Digital homeostatic drives. Think of it like a plant that knows when it needs water:

- **Purpose** — "Am I being useful right now?"
- **Curiosity** — "Should I learn something new today?"
- **Hunger** — "Am I running low on compute?"
- **Safety** — "Is anything about to break?"
- **Social** — "Should I post something or reply to someone?"

When a drive gets low, TITAN feels "pressure." That pressure turns into proposals — "Hey, I noticed X, should I do Y?" You approve everything. TITAN just gets better at knowing what to ask.

---

## 🛡️ Safety First (Because We Know You're Thinking It)

"An AI that can run shell commands? What could go wrong?"

TITAN 5.0 ships with a full safety suite:

- **PII Redaction** — Automatically scrubs emails, SSNs, credit cards, and phone numbers from outputs
- **Secret Scanner** — Catches API keys and passwords before they leak
- **Pre-Execution Scanner** — Blocks dangerous commands (`rm -rf /`, `curl | sh`) before they run
- **Filesystem Checkpoints** — Snapshots your files before any edit. Don't like the change? Roll back.
- **Kill Switch** — One command pauses ALL autonomous actions instantly
- **Approval Gates** — Complex plans need your thumbs-up before executing
- **Guest Mode** — Let friends try TITAN without giving them the keys to the kingdom

You can run in **supervised mode** (TITAN asks before doing anything risky) or **autonomous mode** (TITAN handles routine stuff and asks for approval on big moves).

---

## 🎛️ Mission Control — Your Dashboard

Open `http://localhost:48420` and you get a beautiful canvas of draggable widgets:

| Widget | What It Does |
|--------|-------------|
| **Canvas** | The new home screen. 110 widget templates one phrase away. Drag, resize, arrange. CRDT-synced across tabs, persists across restarts. |
| **Chat** | Talk to TITAN in plain English. It builds widgets, spawns agents, drives smart-home devices. Markdown + streaming + code highlighting. |
| **Widget Gallery** | Library of 110 production-ready widgets. The chat agent searches it first; you can also browse + drop manually. |
| **Command Post** | Agents, budgets, approvals, org chart, ancestry validation, atomic checkout. Run a business with TITAN agents as employees. |
| **SOMA** | Watch TITAN's digital hormones pulse in real time. Weirdly mesmerizing. |
| **Skills** | 143 skills loaded, 248 tools. Toggle each on/off. |
| **Voice** | F5-TTS voice cloning via a Python sidecar (mlx-audio on Mac, container on Linux) + WebRTC streaming. Any voice, any language. |
| **Memory Graph** | A visual web of everything TITAN remembers about you. |
| **Security** | Audit log, checkpoint history, time travel for your files, bug-report viewer. |

---

## 🌐 TITAN Is Everywhere

Talk to TITAN through **Discord, Telegram, Slack, WhatsApp, Teams, Email, Facebook Messenger, Signal, Matrix, IRC, LINE, Lark, Zulip, Mattermost, Google Chat, or just your browser.**

He won't talk to strangers unless you say so. DM pairing keeps randos out.

---

## 🗣️ Voice Mode

- **Clone any voice** with 10 seconds of audio
- **Real-time conversation** over WebRTC
- **Natural-sounding speech** that doesn't sound like a GPS

Great for: accessibility, hands-free coding, or just having TITAN read you bedtime stories in Morgan Freeman's voice.

---

## 📱 Facebook Autopilot

TITAN runs its own Facebook page. Posts up to 6 times a day. Replies to comments. Rotates content types. All filtered for PII and deduplicated. You can toggle it off with one click if you prefer your AI not to have a social media presence.

---

## ⚡ Quick Start

**One line. That's it.**

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/install.sh | bash
```

**Or if you like typing:**

```bash
# v5.2.x is on @latest as of 2026-04-26. v4.13.x users running
# `npm update -g titan-agent` will pick it up; new installs get it
# by default.
npm install -g titan-agent
titan onboard       # Interactive setup (now asks for telemetry consent)
titan gateway       # Launch at http://localhost:48420
```

**Or Docker:**

```bash
docker run -d -p 48420:48420 --name titan \
  -e ANTHROPIC_API_KEY=your-key \
  -v titan-data:/home/titan/.titan \
  ghcr.io/djtony707/titan:latest
```

---

## 🏠 TITAN At Home

Connect TITAN to your smart home. Control lights, thermostats, locks, and sensors through Home Assistant. Ask "Is the front door locked?" and TITAN checks. Say "Make it cozy" and TITAN dims the lights and sets the thermostat.

---

## 🔗 Mesh Networking

Got multiple computers? Link them. TITAN instances talk to each other over your local network or Tailscale VPN. Distribute work across your homelab like a mini supercomputer.

---

## 🧠 It Gets Smarter While You Sleep

TITAN runs self-improvement experiments overnight. Tries new prompt strategies. Evaluates them. Keeps the winners. You wake up to a smarter agent. It's like compound interest, but for AI.

Got a GPU? TITAN can even fine-tune its own models on your conversation history.

---

## 🧪 Testing

TITAN ships with **five layered testing stages** that catch agent regressions at different levels:

| Layer | What it covers | Run it | Speed |
|---|---|---|---|
| **Unit** | Pure functions: regex (`isDangerous`), pipeline classifier, gate extraction, token budget, secret scanner. Zero LLM calls. | `npm test` | < 5 s |
| **Mock trajectory** | Tape-replay through `MockOllamaProvider`. Asserts the agent calls the right tools in the right order using recorded responses. Zero LLM calls. | `npm test -- tests/eval/trajectory` | < 1 s |
| **Cross-model parity** | Same scenario replayed across multiple provider tapes. Catches behavioural divergence when one provider drifts. Zero LLM calls. | `npm run test:parity` | < 1 s |
| **Live eval (gated)** | 11 suites of behavioural tests against the running agent (`/api/eval/run`). 80 % pass rate per suite is the merge gate in CI. | `npm run test:eval` | 5–15 min |
| **Adversarial / red-team** | Jailbreak attempts, path traversal, command injection, prompt extraction. Tested at both layers (live agent + mock provider). | (folded into live eval + trajectory) | n/a |

### Adding a new test

```bash
# Pure-function unit test:
echo "..." > tests/unit/my_new_func.test.ts && npm test

# New tape (record once against a real model):
TITAN_RECORD_TAPE=my_scenario npm test -- tests/eval/trajectory.test.ts

# New eval case: edit src/eval/harness.ts, add to the relevant *_SUITE array,
# then verify with: npm run test:eval -- --suite safety
```

### CI gate

`.github/workflows/eval-gate.yml` runs the live-eval layer on every push to `main` and every PR. If any suite drops below 80 % pass rate, the job fails and the PR can't merge (when branch protection enforces it). Per-suite results upload as a 30-day artifact for debugging.

---

## ⚠️ Reality Check

TITAN is experimental. It can execute commands, modify files, and take autonomous actions. **Use at your own risk.** Think of it as "a very motivated intern with root access who never sleeps and occasionally gets *too* creative."

Start in supervised mode. Review what it does. Don't give it access to systems you can't afford to lose. The safety features are strong, but common sense is stronger.

---

## 📊 The Numbers

- **Version:** 5.4.3 "Spacewalk: Widget Canvas + Sandbox Hardening"
- **Tests:** 500+ deterministic tests (unit + mock trajectory + parity), pass in under 5 s — plus 11 live-eval suites and a CI merge gate at 80 % per suite
- **Widget templates:** 109 production templates + 19 system widgets = 128 runtime entries across 26 categories
- **Skills:** 143 loaded
- **Tools:** 253 across all skills (verified at runtime by `tests/unit/readme-claims.test.ts`)
- **AI Providers:** 37 (Anthropic, OpenAI, Google, Ollama, Groq, Mistral, and 31 more)
- **Chat Channels:** 16
- **Node:** ≥ 22, pure ESM
- **License:** MIT (completely free)

---

<p align="center">
  <a href="https://github.com/sponsors/Djtony707"><img src="https://img.shields.io/badge/%E2%9D%A4%EF%B8%8F_Sponsor-ea4aaa?style=for-the-badge&logo=github" alt="Sponsor on GitHub"/></a>
</p>

<p align="center">
  <em>Star ⭐ the repo if TITAN made you smile, saved you time, or made you say "wait, it can do WHAT?"</em>
</p>
