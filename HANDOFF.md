# TITAN Project Handoff Document
## Complete State as of March 30, 2026

---

## 1. What is TITAN

TITAN (The Intelligent Task Automation Network) is a Node.js/TypeScript AI agent framework created by Tony Elliott. It's a full-stack AI assistant with:

- **211 tools** across 122 skills
- **36 LLM providers** (4 native + 32 OpenAI-compatible)
- **15 communication channels** (Discord, Slack, Telegram, etc.)
- **React 19 dashboard** (Mission Control) at `http://192.168.1.11:48420`
- **Voice cloning** via F5-TTS on Apple Silicon
- **Memory system** with knowledge graph, learning engine, and episodic recall
- **Mesh networking** for multi-instance coordination
- **npm package**: `titan-agent` (v2026.10.63, 12K+ downloads)
- **GitHub**: `Djtony707/TITAN`
- **License**: MIT
- **SaaS (LIVE)**: `https://titan-api.djtony707.workers.dev`

## 2. Repository & Source Locations

- **Source**: `~/Desktop/TitanBot/TITAN-main/`
- **Deployed instance**: Titan PC at `/opt/TITAN/` (192.168.1.11)
- **Dashboard**: `http://192.168.1.11:48420`
- **Config**: `~/.titan/titan.json`
- **Graph DB**: `~/.titan/graph.json`
- **Voice references**: `~/.titan/voices/andrew.wav` + `andrew.txt`
- **TTS venv**: `~/.titan/qwen3tts-venv/`

## 3. Hardware

### Development Machine (MacBook Pro)
- M1 Max, 32GB RAM
- macOS Darwin 25.3.0
- Node.js v25.8.0
- Used for development, building, and running F5-TTS voice cloning

### Titan PC (Production)
- Intel i9-14900KF, 64GB DDR5-6000
- NVIDIA RTX 5090 32GB VRAM
- Runs Ollama at `http://192.168.1.11:11434`
- Models: qwen3.5:35b, qwen3:30b, devstral-small-2
- TITAN deployed at `/opt/TITAN/`, runs via `node dist/cli/index.js gateway`
- Logs: `/tmp/titan-gateway.log`
- Config: `~/.titan/titan.json` — model `ollama/nemotron-3-super:cloud`, auth mode `password`, port 48420

## 4. Architecture Overview

```
MacBook (dev)                    Titan PC (prod)
├── Source code                  ├── /opt/TITAN/ (deployed build)
├── F5-TTS server (:5006)       ├── Ollama (:11434)
├── npm build + publish          ├── TITAN Gateway (:48420)
└── Voice ref files              └── Dashboard (React SPA)
```

### Key API Endpoints
- `POST /api/message` — send message (NOT /api/chat), returns `{content, sessionId, toolsUsed, durationMs, model}`
- `POST /api/login` — password auth, returns `{token}`
- `GET /api/voice/voices` — list available TTS voices
- `GET /api/voice/health` — TTS/STT/LiveKit health status
- `POST /api/voice/stream` — voice chat SSE endpoint
- `GET /api/sessions/:id/messages` — get session history
- `DELETE /api/sessions/:id` — delete session
- `GET /api/config` — returns top-level `model`, `provider`, `voice`
- `POST /api/config` — update config (Zod-validated)
- `GET /api/usage` — usage tracking per model/provider
- `GET /api/docs` — auto-generated API documentation
- `POST /api/sessions/:id/abort` — stop button (AbortController)

### Auth
- Mode: `password` (password: `titan2026`)
- Login: `POST /api/login` → returns JWT token
- All API calls need `Authorization: Bearer <token>` header
- UI uses `apiFetch()` wrapper in `ui/src/api/client.ts`

## 5. Voice Cloning System

### Current State: F5-TTS (working)
- Engine: F5-TTS via `f5-tts-mlx` (MLX native for Apple Silicon)
- Server script: `scripts/qwen3-tts-server.py`
- Port: 5006
- OpenAI-compatible API: `POST /v1/audio/speech`
- Parameters: speed=0.87, steps=6, cfg_strength=1.5, seed=42
- Reference audio: `~/.titan/voices/andrew.wav` (Robin Williams as Andrew Martin, Bicentennial Man)
- Reference transcript: `~/.titan/voices/andrew.txt`

### Voice Pipeline Flow
1. User speaks → browser captures audio
2. Gateway receives text (via STT or typed)
3. Gateway sends full LLM response to agent
4. Agent returns text → gateway sends to TTS server as one batch
5. TTS server generates WAV via F5-TTS with andrew reference
6. WAV returned to gateway → streamed to browser as audio

### Critical Voice Fixes Applied
- Reference audio normalized to -23 LUFS (was -17, caused "yelling")
- De-essed at 4.5kHz (-4dB) for male voice
- Trimmed to match transcript (mismatch caused first-word skipping)
- Fixed seed (42) for consistent pitch across generations
- cfg_strength lowered to 1.5 (default 2.0 was too aggressive)
- Gateway sends full response as one TTS call (not sentence-by-sentence)
- Internal engine ID is `qwen3-tts` for backward compatibility, actual engine is F5-TTS

### Previous Engines (removed/replaced)
- Qwen3-TTS: Poor voice cloning quality, replaced by Chatterbox, then F5-TTS
- Chatterbox TTS: Better than Qwen3, but inconsistent across sentences. Replaced by F5-TTS
- Orpheus TTS: Original TTS, no voice cloning capability

### Starting TTS Server
```bash
pkill -f "qwen3-tts-server" 2>/dev/null
~/.titan/qwen3tts-venv/bin/python3 scripts/qwen3-tts-server.py --port 5006 &
```

### TTS Server Dependencies (in qwen3tts-venv)
- f5-tts-mlx
- mlx-audio (may have version conflicts with csm-mlx if installed)
- soundfile, numpy

## 6. Andrew Martin Persona

TITAN speaks in the style of Andrew Martin from Bicentennial Man (1999). This is configured in the voice system prompt in `src/agent/agent.ts` (lines ~470-530).

### Key Persona Rules
- Communication STYLE modeled after Andrew Martin (not "you ARE Andrew" — nemotron refuses identity roleplay)
- Formal but warm speech, calls user "Sir"
- No contractions in formal mode
- Short sentences (max 15 words) for TTS cadence
- Periods and commas only (no dashes, semicolons, parentheses)
- 4-8 sentences for thoughtful questions, shorter for simple ones
- No lists, bullet points, or essay format — flowing speech like a person talking
- References to Bicentennial Man themes: service, purpose, dignity, curiosity

### Persona Detection
- `isAndrew` flag in agent.ts checks if voice reference contains "andrew"
- Falls back to generic conversational style if not Andrew

### Model Limitation (nemotron-3-super)
- Nemotron's safety training refuses to "be" a fictional character or claim to have feelings
- Workaround: frame as "communication style" not "identity"
- The model read the full Bicentennial Man script during a session, which helped it adopt the style
- Consider having each new session re-read key Andrew quotes via the memory system

## 7. Memory System

### Components
1. **Knowledge Graph** (`~/.titan/graph.json`) — entities, facts, episodes from all conversations
2. **Learning Engine** — learned facts from interactions
3. **Teaching System** — adaptive teaching context
4. **Personal Skills** — Google Workspace integration

### Graph Structure
- **Episodes**: Raw conversation messages (user + TITAN responses)
- **Entities**: Named things extracted from episodes (people, tools, concepts)
- **Facts**: Assertions about entities
- **episodeIds**: Links entities to episodes (currently ALL EMPTY — entities exist but have no episode links)

### Memory Injection in Voice Mode
- Memory is injected at the TOP of the system prompt (before persona rules)
- Section header: `## IMPORTANT — Your Memories`
- Includes graph context, learning context, personal context
- Model is instructed: "Do NOT say 'I do not recall' if the answer is in your memories below"

### Critical Fixes Applied
1. **Poison episode filtering**: TITAN's own "I don't know" responses were being stored as episodes, then returned as the most relevant matches for future queries. Fixed by:
   - Filtering out episodes containing "I do not recall", "I am not able to find", etc. from graph search results
   - Purged 11 existing poisoned episodes from graph.json
   - Added guard in `addEpisode()` to prevent future poison storage

2. **Stop word filtering**: Search queries like "do you remember a joke" matched 60+ entities on common words ("do", "you", "a"). Fixed by filtering stop words before entity/episode search.

3. **TITAN response exclusion**: Graph search now filters out `[TITAN →` prefixed episodes, prioritizing user messages and actual content.

### Known Issue
- `episodeIds` field is empty on ALL 70 entities — the entity-to-episode bridge doesn't populate this. Entity facts contain the right info but there's no link back to the source episode. This hasn't been fixed yet.

## 8. Security Hardening (Applied)

### Fixes in v2026.10.60-62
1. **WebSocket session isolation** — broadcast() now routes by sessionId, not to all clients
2. **Filesystem path allowlist** — blocks access to /etc, /root, .ssh, .env, .git, etc.
3. **Shell command validation** — blocks dangerous patterns (rm -rf /, curl to external, etc.)
4. **Health monitor async safety** — wrapped setInterval async callback in try/catch
5. **WebSocket message size limit** — rejects messages > 5MB
6. **Body size limit** — express.json({ limit: '2mb' }) prevents huge payload crashes
7. **File upload endpoint** — fixed raw body parsing middleware conflict

### Known Security Gaps (Not Yet Fixed)
- **Auth bypass**: If no password/token is configured, all requests are allowed (mode: 'none')
- **Session ownership**: Any authenticated user can access any sessionId
- **No HTTPS**: Required for production SaaS
- **No per-user rate limiting**: Only IP-based
- **Config file stores API keys in plaintext**
- **CORS allows broad LAN ranges** — fine for homelab, not for SaaS
- **CSP allows unsafe-inline and unsafe-eval**

## 9. Stress Test Results

Script: `scripts/stress-test.ts`
Run: `npx tsx scripts/stress-test.ts --password=titan2026`

**Latest results: 111/111 passed (100%)**

Three test suites:
1. **Stress Testing** (85 prompts) — knowledge, code, short, math, memory, concurrency
2. **Adversarial Testing** — empty content, huge payload, SQL injection, XSS, prompt injection, unicode bomb, rate limit flood
3. **User Simulation** — full journey: health → models → message → follow-up → sessions → search → export → upload → usage → config → skills → tools

## 10. Build & Deploy

### Build Commands
```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run build        # TypeScript → dist/
npm run build:ui     # React SPA → ui/dist/
```

### Version Bumping
Update version in THREE places:
1. `package.json` → `"version": "2026.10.XX"`
2. `src/utils/constants.ts` → `TITAN_VERSION`
3. Tests: `tests/core.test.ts`, `tests/mission-control.test.ts`

### Publishing
```bash
npm version patch --no-git-tag-version  # or manually edit
npm run build && npm run build:ui
git add -A && git commit -m "v2026.10.XX: description"
git push origin main
npm publish
```

### Deploy to Titan PC
```bash
ssh titan-pc  # or ssh 192.168.1.11
cd /opt/TITAN
git pull
npm run build
# Restart: kill old gateway, start new one
```

### IMPORTANT: Never use preview_start for TITAN
Tony's explicit instruction: build on Mac, deploy to Titan PC via SSH. No local preview server.

## 11. SaaS Cloud Platform (LIVE)

Tony built the full SaaS while this Claude Code instance worked on voice cloning. It's production-ready and live.

### Live URL
`https://titan-api.djtony707.workers.dev`

### Architecture
```
User → Cloudflare Worker (3,243 lines) → Supabase (DB) + Fly.io (compute) + OpenRouter (LLM)
```

### Stack
- **Cloudflare Worker** — gateway, auth (PBKDF2+JWT), billing proxy, dashboard reverse proxy, landing page
- **Supabase** — PostgreSQL: profiles, api_keys, usage_logs tables
- **Fly.io** — per-user TITAN instances, auto-stop on idle ($0.17/mo per user)
- **OpenRouter** — LLM inference (free models available: Nemotron, GLM)
- **Stripe** — billing: $20 Starter / $50 Pro / $100 Enterprise
- **Edge TTS** — free Microsoft neural TTS for cloud (replaces F5-TTS in Docker/Alpine)
- **GHCR** — `ghcr.io/djtony707/titan:cloud`, automated via GitHub Actions
- **Docker image** — multi-stage Node 22 Alpine + Python3 + ffmpeg + sox

### Pricing Tiers
| Tier | Monthly | Included Credits | Free Models | Paid Models |
|------|---------|-----------------|-------------|-------------|
| Free | $0 | $1.00 (signup) | Yes | No |
| Starter | $20 | $25.00 | Yes | Yes |
| Pro | $50 | $65.00 | Yes | Yes |
| Enterprise | $100 | $150.00 | Yes | Yes |

### Key Files (NOT in TITAN repo — separate Worker deployment)
- Worker source: `/sessions/laughing-fervent-rubin/worker-final.js`
- Deploy script: `/sessions/laughing-fervent-rubin/deploy-worker.sh`
- Admin panel: `/sessions/laughing-fervent-rubin/admin-panel.js`
- Fly token: `/sessions/laughing-fervent-rubin/.fly_token`

### Credentials
- Cloudflare Worker: `titan-api` on account `5fd6dba21338dc26569642db3f7eb5d9`
- Supabase project: `byordgvieyuocjdjelul`
- Fly.io app: `titan-instances`, region: `iad`
- Tony's user ID: `d1966396-4089-4ee9-a332-2c5e3501cffe`
- Current Fly machine: `d892275f425918`

### Full SaaS Documentation
See: `~/Desktop/TITAN-SaaS-Complete-Project-Documentation.md` (806 lines, covers everything)

## 12. TITAN Synapse (Custom AI Model)

Tony also built a custom neural network architecture and trained a 1B model from scratch.

### What It Is
- Novel architecture: Mamba SSM + xLSTM + Sparse MoE + Thalamus Router + Fast-Weight Memory (all O(n), no attention)
- Rust inference engine (candle) + Python training pipeline (PyTorch)
- Intended to eventually replace Ollama models as TITAN's own brain

### Current State
- **Source**: `~/Desktop/titan-synapse/` (Mac) / `~/titan-synapse/` (Titan PC)
- **GitHub**: `Djtony707/titan-synapse`
- **npm**: `titan-synapse` v0.2.0
- **HuggingFace**: `djtony707/synapse-3b` (TIES-merged Qwen3-3B, 62.6% MMLU)
- **1B model trained** from scratch: 100K steps, 51M tokens, loss 11.9→8.02
- **SFT trained**: 2,000 steps on 235K samples
- **Status**: Generates gibberish — needs 1000x more pre-training data
- **Critical bug**: Rust xLSTM uses exp() instead of sigmoid() for forget gate — must fix before Rust inference

### Full Synapse Documentation
See: `~/Desktop/TITAN_SYNAPSE_COMPLETE_HANDOFF.md` (542 lines, covers everything)

## 13. Research Completed (for SaaS)

### GPU Hosting
- RunPod: RTX 4090 $0.34/hr ($248/mo always-on), best value
- Hetzner: GEX44 $212/mo dedicated (cheapest always-on)
- CoreWeave: Enterprise, 60% discount on commits
- Modal: Serverless GPU for bursty inference (F5-TTS sidecar)

### Legal
- MIT license is SaaS-safe, no restrictions on commercial use
- Need LLC/C-Corp before taking money (personal liability protection)
- Need Terms of Service + Privacy Policy (legally required)
- Anthropic API terms: TITAN as value-add agent = fine, raw API resale = needs partnership agreement
- Consider BSL 1.1 later if a funded competitor forks TITAN

### Billing Architecture
- Stripe subscriptions + metered billing for overage
- 5-layer cost protection in Cloudflare Worker (already built)
- OpenRouter aggregates 100+ models, per-token billing with 75% markup

## 14. Config Schema

Zod schema in `src/config/schema.ts`. Key fields:

- `ttsEngine`: enum `['orpheus', 'qwen3-tts', 'fish-speech', 'edge', 'browser']` — 'qwen3-tts' = F5-TTS locally, 'edge' = Edge TTS in cloud
- `ttsVoice`: string (e.g., 'andrew')
- `agent.model`: string (e.g., 'ollama/nemotron-3-super:cloud')
- `gateway.auth.mode`: enum `['none', 'token', 'password']`
- `gateway.auth.password`: string
- `security.fileSystemAllowlist`: string array
- `security.sandboxMode`: enum `['none', 'docker']`

## 15. Key Files Reference

| File | Purpose |
|------|---------|
| `src/gateway/server.ts` | Main Express gateway (~4500 lines). All API routes. |
| `src/agent/agent.ts` | Agent loop, system prompt building, voice persona |
| `src/memory/graph.ts` | Knowledge graph — entities, episodes, search |
| `src/config/schema.ts` | Zod config validation schema |
| `src/config/config.ts` | Config loading/saving |
| `scripts/qwen3-tts-server.py` | F5-TTS voice cloning HTTP server |
| `scripts/stress-test.ts` | Stress/adversarial/simulation test harness |
| `ui/src/components/voice/VoiceOverlay.tsx` | Voice chat UI |
| `ui/src/components/voice/VoicePicker.tsx` | Voice selection carousel |
| `ui/src/components/admin/SettingsPanel.tsx` | Settings admin panel |
| `ui/src/api/client.ts` | API client with auth wrapper |
| `~/.titan/titan.json` | Runtime config |
| `~/.titan/graph.json` | Knowledge graph data |
| `~/.titan/voices/andrew.wav` | Voice clone reference audio |
| `~/.titan/voices/andrew.txt` | Voice clone reference transcript |

## 16. Open TODOs

### Bugs to Fix
- [ ] `episodeIds` never populated on entities in graph.ts
- [ ] Nemotron occasionally breaks Andrew persona on first message of new session
- [ ] F5-TTS quality degrades on passages longer than ~8 sentences
- [ ] TTS server dies when gateway is killed via `pkill -f "node.*gateway"` (also kills Python)

### SaaS Done (by Tony)
- [x] Stripe billing integration (Cloudflare Worker)
- [x] User account system (signup/login, PBKDF2+JWT)
- [x] Multi-tenant isolation (per-user Fly.io machines)
- [x] HTTPS (Cloudflare Worker = automatic HTTPS)
- [x] Docker production image (GHCR, GitHub Actions CI/CD)
- [x] Terms of Service + Privacy Policy (built into landing page)
- [x] Edge TTS for cloud voice (free, no GPU needed)
- [x] 5-layer cost protection (prevents balance overspend)
- [x] Admin panel for user management

### Next Up
- [ ] Get F5-TTS voice cloning running on Titan PC (RTX 5090) — faster than Mac M1 Max
- [ ] LiveKit + STT for full voice chat in cloud (not just TTS preview)
- [ ] Edge TTS voice selection UI in dashboard
- [ ] Multi-region Fly.io support (eu, apac)
- [ ] Plugin marketplace UI
- [ ] SSO/SAML beyond Google OAuth
- [ ] White-label branding for SaaS customers

## 17. Working Preferences (Tony)

- Direct, practical, action-oriented responses
- Short and concise — no fluff unless deep detail is requested
- Never skimp on quality — always use the best approach
- Always publish to npm after pushing to git
- Never use preview_start for TITAN — build on Mac, deploy to Titan PC via SSH
- Learns by building, not by studying theory
- Builder mindset — blends tech, music, entrepreneurship

## 18. Commands Cheatsheet

```bash
# Build
cd ~/Desktop/TitanBot/TITAN-main
npm run build && npm run build:ui

# Start TTS server (on Mac)
~/.titan/qwen3tts-venv/bin/python3 scripts/qwen3-tts-server.py --port 5006 &

# Start gateway (on Mac for testing)
node dist/cli/index.js gateway &

# Run stress tests
npx tsx scripts/stress-test.ts --password=titan2026

# Run unit tests
npx vitest run

# Publish
npm version patch --no-git-tag-version
npm publish
git add -A && git commit -m "v2026.10.XX: description"
git push origin main

# Check npm downloads
curl -s "https://api.npmjs.org/downloads/point/last-month/titan-agent"

# Kill everything
pkill -f "qwen3-tts-server"
pkill -f "node.*gateway"
```

---

## 19. Related Documentation

| Document | Location | Contents |
|----------|----------|----------|
| TITAN Handoff (this file) | `HANDOFF.md` in repo root | Framework + voice + memory + security |
| SaaS Cloud Platform | `~/Desktop/TITAN-SaaS-Complete-Project-Documentation.md` | Full SaaS stack: Worker, Supabase, Fly.io, Stripe, Edge TTS |
| TITAN Synapse | `~/Desktop/TITAN_SYNAPSE_COMPLETE_HANDOFF.md` | Custom 1B model: architecture, training, benchmarks |
| CLAUDE.md | `CLAUDE.md` in repo root | Build/test/deploy quick reference |
| Changelog | `CHANGELOG.md` in repo root | Full version history |

---

*Last updated: March 30, 2026 by Claude Code*
*Current version: v2026.10.63*
*npm: titan-agent@2026.10.63*
*SaaS: https://titan-api.djtony707.workers.dev*
