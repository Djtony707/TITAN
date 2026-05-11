# TITAN Roadmap

> A live document. Last updated 2026-05-10.

This is what's next. We aim to ship v6.0 this month.

## Where TITAN sits today (v5.5.x)

TITAN is the synthesis of three lineages: **OpenClaw** (personal AI assistant on every channel), **Hermes Agent** (self-improving multi-agent harness, by Nous Research), and **Space Agent** (browser-runtime-embedded agent with great design). Plus moats none of the ancestors have:

| TITAN-only today | Where it lives |
| ---------------- | -------------- |
| **36 LLM providers** with a single router + fallback chain | `src/providers/router.ts` |
| **LoRA fine-tuning on conversation history** (qwen3.5:35b on RTX 5090) | `src/skills/builtin/model_trainer.ts` + `autoresearch/train.py` |
| **F5-TTS voice cloning** from a short reference clip | `scripts/f5-tts-server.py` |
| **LiveKit WebRTC voice** real-time conversation | `src/voice/` + `src/channels/messenger-voice.ts` |
| **Mesh networking** via mDNS + Tailscale | `src/mesh/` |
| **TITAN-SOMA** homeostatic drives (Purpose, Curiosity, Hunger, Safety, Social) | `src/organism/drives.ts` |
| **Yjs CRDT canvas** sync across browser tabs | `ui/src/titan2/crdt/CrdtEngine.ts` |
| **109 widget templates** in 28 categories | `assets/widget-templates/` |
| **Shadow-git checkpoints** for every file write | `src/agent/shadowGit.ts` |
| **Command Post governance** (atomic checkout, budgets, ancestry) | `src/agent/commandPost.ts` |
| **Pre-execution scanner** + PII redaction + secret guard + kill switch | `src/safety/` + `src/security/` |
| **6,600+ tests** + 11 live-eval suites + 80 % per-suite CI gate | `tests/` + `.github/workflows/eval-gate.yml` |

## v6.0 — Ship in May 2026

v6.0 closes the gaps the ancestors have outpaced TITAN on, while doubling down on the moats above. Eight tracks, roughly in priority order:

### 1. TitanHub — public skill registry (≈2 weeks)
A community surface for skills, inspired by OpenClaw's ClawHub.

- Plain `SKILL.md` format (Space-Agent-compatible) — agent-readable + human-readable
- Vector search over skill descriptions
- `titan skill publish` and `titan skill install <name>` CLI verbs
- Moderation hook (license check + secret-scan)
- Hosted alongside the npm registry

### 2. `titan onboard` wizard polish (≈3–5 days)
Lower the activation cliff for new users.

- Pick providers, paste keys, pick channels, pick voice profile, pick mascot — interactive prompts
- Validates each key on entry
- One-line transcript at the end so you know what got written to `~/.titan/config.toml`

### 3. TITAN-as-ACP-COO (≈2 weeks)
Make TITAN itself an [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) server AND client.

- **Server side:** TITAN exposes ACP so editors (Zed, VS Code via plugin, Vim) can drive it
- **Client side:** TITAN orchestrates Claude Code, Codex, OpenCode, Cursor via ACP — the COO role
- Bridges TITAN with the rest of the coding-agent ecosystem

### 4. Skill-level learning loop (≈3 weeks)
Inspired by Hermes' procedural-memory layer. Sits on top of the existing LoRA pipeline.

- After complex sessions, distill a `SKILL.md` from the trajectory
- Auto-promote high-use distilled skills into the LoRA fine-tune queue
- User can edit/approve the distilled skill before it goes into the active set

### 5. `titan import <openclaw|hermes>` migration (≈1 week)
Capture both upstream populations.

- Batch-import settings, skills, memories, API keys
- Dry-run mode shows what would change
- Source-format detection: `~/.openclaw/`, `~/.hermes/`, etc.

### 6. Agent-authored live widgets (≈3 weeks)
Inspired by Space Agent's frontend-embedded model.

- Agent emits a React component (already supported via `_____react` blocks)
- Component hot-reloads into the dashboard (Yjs canvas already syncs)
- Shadow-git checkpoint on every emit so we can roll back

The plumbing is mostly already there — the work is the publish-to-canvas handshake and the diff/preview UI.

### 7. Hierarchical AGENTS.md governance (≈1 week)
Inspired by Space Agent's L0/L1/L2 instruction layering.

- Project root `AGENTS.md` (L0) — owner/architecture
- Subdirectory `AGENTS.md` (L1) — domain-specific rules
- File-level frontmatter (L2) — local overrides
- Auto-loaded by Command Post with provenance

### 8. Serverless hibernate / VPS deploy presets (≈1 week)
Inspired by Hermes' "$5 VPS / hibernate when idle" deployment matrix.

- `titan deploy modal|vercel|fly|render` presets
- Auto-hibernate when idle (configurable threshold)
- Render + Railway configs already exist in the repo — finish them

### 9. Proactive co-worker mode (≈3-4 weeks) ⭐ Tony's flagship ask
The single thing that separates TITAN from every other agent framework: it should be a **24/7 co-worker / COO that talks first**, not a chatbot that waits to be poked. Hermes-as-COO is the closest reference, but Hermes still breaks too often. TITAN should be:

1. **Talks first** — boots into a daily briefing ("Here's what changed overnight, here's the 3 things you said you wanted me to do, here's a flag I noticed and want to ask about"). Doesn't wait for a `>` prompt.
2. **Anticipatory** — watches the user's signal stream (calendar, email, recent files, channel activity) and surfaces "you have a meeting in 20 min, here's the prep doc," "PR #42 just hit a CI failure, want me to triage?," "you said you'd ship the v6 plan today, here's the draft."
3. **Self-healing without supervision** — when something breaks (provider down, model unavailable, context overflow, circuit tripped, sandbox crash), TITAN routes around it AND tells the user exactly what happened, AND learns from it (procedural-memory entry).
4. **Honest about its own state** — never claims to be a model it isn't (the `current_model` skill exists for exactly this — see v5.6.5 fix). Anti-sycophancy: doesn't capitulate to user assertions without verification.
5. **Backbone** — pushes back when the user is wrong about TITAN's state. "Actually, I just checked — `current_model` says X, not Y." Truth first, manners second.

Concrete deliverables for the v6.0 cut:
- **Daemon-init briefing skill** — runs at boot + once per morning. Pulls last-N-hours of agent activity, calendar, inbox, recent file edits, and emits a structured briefing widget on the canvas + (opt-in) a chat message.
- **Anticipation engine** — a small daemon-watcher loop that examines the user's signal stream every N minutes and emits proposals via the existing Soma pressure → proposal pipeline.
- **Self-healing playbook** — codified recovery recipes for the top 10 failure modes (no key configured, circuit open, context overflow, sandbox dead, browser pool exhausted, model unavailable, etc.). Each recipe is a tool sequence that can run autonomously, with a final "I noticed X and did Y, here's the result" surface to the user.
- **Identity discipline** — already shipped in v5.6.5 as the `current_model` skill + system-prompt rules. Document the pattern as an example for future "agent must verify, not guess" tools.

### 10. Token-budget defense (≈1 week)
Tony's 5-turn chat hit the 200k-token cap. Root cause: ~50k tokens of tool schemas + ~10 prompt-section blocks (TITAN.md, AGENTS.md, SOUL.md, persona, TOOLS.md, hormones, learning, hindsight, wisdom, skill guidance) sent every turn. Fixes:

- **Dynamic tool gating** — only send tool schemas relevant to the current turn (we already have `classifyTaskType`; wire it into the request builder so a chat about lunch doesn't ship the 254-tool kitchen sink).
- **Static-vs-dynamic prompt split** — Paperclip-style separation so the cache-friendly bootstrap context isn't re-sent every turn.
- **Per-section size budget** — cap each `## ` block (TITAN.md max 2k tok, hindsight max 1k, etc.) with section-aware truncation we already use for personas. Drift detection in CI.
- **Better budget UX** — instead of "Session paused to control costs", auto-compress + tell the user "I trimmed older context to fit, full transcript saved at `~/.titan/sessions/<id>.jsonl`."

## v6.x cycle (June onward)

- **TITAN Companion** — iOS/Android pair-mode node, like OpenClaw's mobile companions
- **Wake-word voice** on macOS (Apple Speech) and Linux (whisper-cpp)
- **TitanHub web UI** — search, browse, install in the browser
- **GEPA v2** — evolutionary prompt optimization with multi-agent fitness (the v2026.10.50 pilot showed it works; v2 should ship as an opt-in default for agent-router prompts)
- **Hindsight v2** — write-back retention (we ingest hints but don't yet contribute back)

## Not on the roadmap

Things that other agent frameworks chase but we've decided are not the right investment for TITAN:

- **Visual drag-and-drop workflow builder.** Drawn flows lose against agentic flows. We're betting on the LLM as the planner, not the human as the planner-of-flows.
- **Time-travel debugging UI** in the style of LangSmith. Shadow-git checkpoints already give ~80 % of this. Building a custom replay UI would be a months-long investment for a marginal gain.
- **A locked-in cloud control plane.** Cloud features (PostHog telemetry, optional NVIDIA NIM endpoints, optional Hindsight memory) are opt-in, not load-bearing. TITAN must work fully offline against local Ollama. That's a hard line.

## How to influence this roadmap

Open an issue or a discussion thread:

- [GitHub Issues](https://github.com/Djtony707/TITAN/issues)
- [GitHub Discussions](https://github.com/Djtony707/TITAN/discussions)

Particularly useful contributions: skills you'd want in TitanHub, channel adapters we're missing, anything broken with `titan onboard` that should be smoother.
