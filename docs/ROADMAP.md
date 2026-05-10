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
