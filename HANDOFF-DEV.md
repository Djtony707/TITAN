# TITAN Development Handoff — Programming Only
## April 1, 2026 | v2026.10.69

This handoff is for coding/development work on TITAN only. For voice cloning, ad recording, or SaaS deployment, see HANDOFF.md.

---

## Quick Start

```bash
cd ~/Desktop/TitanBot/TITAN-main
npm run build        # TypeScript → dist/
npm run build:ui     # React SPA → ui/dist/
npx vitest run       # 4,430 tests across 140 files
```

Deploy to Titan PC:
```bash
ssh titan "cd /opt/TITAN && git pull && npm run build && npm run build:ui"
sudo systemctl restart titan-gateway
sudo systemctl restart titan-tts
```

Publish: `npm version patch --no-git-tag-version && npm publish && git push`

---

## Codebase Structure

```
src/
├── agent/agent.ts        # Core agent loop, system prompts, voice persona
├── agent/commandPost.ts  # Command Post governance (checkout, budgets, ancestry, registry, feed)
├── agent/session.ts      # Session management, auto-titling
├── agent/sandbox.ts      # Docker sandbox for code execution
├── agent/toolRunner.ts   # Tool execution, parallel support
├── config/schema.ts      # Zod config validation
├── config/config.ts      # Config load/save
├── gateway/server.ts     # Express gateway (~4800 lines), ALL API routes
├── memory/graph.ts       # Knowledge graph — entities, episodes, search
├── memory/vectors.ts     # Vector search (embeddings)
├── providers/ollama.ts   # Ollama provider (streaming, thinking-field fix)
├── providers/router.ts   # Multi-provider routing, fallback chains
├── skills/registry.ts    # Skill/tool registration
├── skills/builtin/       # 61 builtin skills
├── mcp/                  # MCP Server mode
├── mesh/                 # P2P mesh networking
├── voice/                # LiveKit WebRTC (empty — voice logic in agent.ts + server.ts)
└── vram/                 # GPU VRAM orchestrator

ui/
├── src/api/client.ts     # API client with auth wrapper
├── src/api/types.ts      # TypeScript types (AgentEvent, StreamEvent, etc.)
├── src/hooks/useSSE.ts   # SSE streaming hook with RAF-buffered agentEvents
├── src/hooks/useConfig.tsx # Config + voice health hook
├── src/components/
│   ├── chat/ChatView.tsx       # Main chat with split-view Agent Watcher
│   ├── chat/StreamingMessage.tsx
│   ├── chat/ToolCallIndicator.tsx
│   ├── admin/CommandPostPanel.tsx  # Agent governance dashboard
│   ├── agent-watcher/AgentWatcher.tsx   # Container with Cards/Pixel toggle
│   ├── agent-watcher/ActivityCards.tsx  # Tool execution cards
│   ├── agent-watcher/PixelOffice.tsx    # Canvas 2D pixel art agent
│   ├── voice/VoiceOverlay.tsx   # Voice chat (iOS audio fixes applied)
│   ├── voice/VoicePicker.tsx    # Voice selection
│   └── admin/                   # 24 admin panels
```

---

## Current Version: v2026.10.69

### What Was Just Shipped
- **Full Paperclip integration** — Command Post v2 with 7 tabs: Dashboard (metrics + pixel crew), Org Chart (hierarchical agent tree), Issues (TIT-1 ticket board), Agents (registry + run history), Approvals (hire/budget gates), Costs (budget meters), Console (NL management). 12 new API endpoints, issues/approvals/runs persist to disk.
- **Cloud model optimization** — Benchmarked all 7 Ollama cloud models. Switched default to `qwen3-coder-next:cloud` (0.3s chat, perfect tool_choice). DeepSeek XML tool call parser. CloudRetry expanded. Voice uses `qwen3.5:397b-cloud`.
- **14 bugs fixed** — concurrency guard, model switch validation, Prometheus `/metrics`, mesh TLS, gateway shutdown fix, voice poison guard, 6 UI fixes, Overview stats.
- **124-test smoke suite** — `scripts/smoke-test.ts` covers all 12 subsystems.
- **README fully updated** — 209 tools, 36 providers, 117 skills, 26 panels, Paperclip Command Post, F5-TTS voice cloning.

### Critical Next Steps (ARCHITECTURE-TODO.md)
1. **Think/Act phase separation** — Remove tools from LLM after tool execution round. 20-line fix, eliminates cloud model looping.
2. **Async sub-agents via Command Post** — spawn_agent creates issue instead of blocking inline. Paperclip heartbeat pattern.
3. **Agent inbox + wakeup** — CEO → Worker delegation via task assignment.
4. **External agent adapters** — Claude Code, Codex, Cursor integration (Paperclip adapter pattern).

### Reference Repos on Disk
- `~/Desktop/paperclip-reference/` — Paperclip source (agent orchestration, heartbeats, task checkout)
- `~/Desktop/openclaw-reference/` — OpenClaw source (tool calling, model fallback, sessions)
- **Agent Watcher** — split-view real-time tool execution visualizer (ActivityCards + PixelOffice)
- **Rich SSE events** — tool_start (with args), tool_end (with result/duration), thinking, round
- **iOS Safari voice** — DOM `<audio autoPlay playsInline>` + Web Audio API AudioContext unlock
- **Auto-HTTPS** — mkcert cert detection at `~/.titan/certs/`
- **Bounded memory** — max 500 entities, 5000 episodes, auto-prune
- **Injection protection** — 9 regex patterns block prompt injection in memory
- **Memory nudges** — every 20 messages, remind agent to save important details
- **Thinking-field fix** — handles models that ignore think=false (qwen3.5, nemotron-super)
- **Session title cleanup** — strips voice/api prefixes, capitalizes
- **Form accessibility** — 34 input fields got id/name attributes across 6 panels
- **CSP fix** — removed unsafe-eval
- **CI green** — 4,430 tests passing across 140 files

---

## Key Architecture Patterns

### SSE Streaming (text chat)
```
POST /api/message (Accept: text/event-stream)
→ Events: token, tool_call, tool_end, thinking, round, done, error
→ Parsed by ui/src/api/client.ts → useSSE hook → ChatView
```

### Voice Stream
```
POST /api/voice/stream
→ Events: tts_mode, sentence, audio (base64 WAV), done
→ Parsed by VoiceOverlay.tsx → createAudioPlayer → playAudioData
→ iOS: Web Audio API (AudioContext.decodeAudioData)
→ Desktop: HTMLAudioElement
```

### Tool Execution Flow
```
agent.ts runAgentLoop → chatStream (provider) → onToken callback
  → tool_calls detected → executeTools (toolRunner.ts)
  → onToolResult callback → SSE tool_end event
  → repeat up to maxRounds
```

### Config Flow
```
~/.titan/titan.json → loadConfig() → Zod validation (schema.ts)
POST /api/config → validatePartial → merge → saveConfig
Voice reads: cfg.voice.ttsEngine, cfg.voice.ttsVoice, cfg.voice.model
```

---

## Critical Code Locations

### Voice System
- **Voice persona** (Andrew Martin): `src/agent/agent.ts:470-530` — `buildVoiceSystemPrompt()`
- **Voice stream endpoint**: `src/gateway/server.ts:2911` — `/api/voice/stream`
- **TTS probe**: `server.ts:2950-2973` — auto-detects TTS availability
- **F5-TTS batch**: `server.ts:3176-3209` — collects sentences, sends as chunks
- **iOS audio**: `ui/src/components/voice/VoiceOverlay.tsx:110-140` — `playAudioData()` with Web Audio fallback
- **Audio unlock**: `VoiceOverlay.tsx:753-770` — creates AudioContext during user gesture

### Agent Watcher
- **SSE enrichment**: `server.ts:1263-1280` — tool_call, tool_end, thinking, round events
- **Agent callbacks**: `agent.ts:542-548` — StreamCallbacks interface (onToolResult, onThinking, onRound)
- **RAF buffering**: `hooks/useSSE.ts:40-55` — requestAnimationFrame event flush
- **Split view**: `chat/ChatView.tsx:302-320` — Eye toggle, 60/40 layout

### Memory
- **Graph search**: `memory/graph.ts:561` — `getGraphContext(query)`
- **Poison filtering**: `graph.ts:338-342` — blocks "I don't know" responses
- **Stop word filtering**: `graph.ts` — filters common words from search
- **Injection protection**: `graph.ts:25-35` — INJECTION_PATTERNS array
- **Bounds enforcement**: `graph.ts` — `enforceMemoryBounds()` after each episode

### Command Post
- **Core module**: `src/agent/commandPost.ts` — all 5 subsystems (checkout, budgets, ancestry, registry, feed)
- **Config**: `src/config/schema.ts` — `commandPost` Zod section (enabled, heartbeat, checkouts, budgets)
- **API routes**: `src/gateway/server.ts` — 13 endpoints under `/api/command-post/`
- **Dashboard**: `ui/src/components/admin/CommandPostPanel.tsx` — admin panel #25
- **Autopilot integration**: `src/agent/autopilot.ts` — checkout/checkin wrapping in goal mode
- **Tests**: `tests/command-post.test.ts` — 24 tests

### Ollama Provider
- **Streaming**: `providers/ollama.ts:381-547` — `chatStream()` generator
- **Thinking-field fix**: `ollama.ts:509-514` — treats thinking as content when think=false
- **Cloud model detection**: `ollama.ts:385` — `:cloud` suffix detection
- **System prompt compression**: `ollama.ts:440-455` — for cloud models with tools

---

## Known Bugs / Tech Debt

### Must Fix
- [ ] **Voice model override** — `voice.model` in config overrides to qwen3.5:35b which uses thinking. Currently removed from Titan PC config, but code still supports it. Should validate voice model doesn't use thinking.
- [ ] **episodeIds never populated** — entities in graph.ts have empty episodeIds arrays. Entity facts are correct but no link back to source episodes.
- [ ] **TTS server dies with gateway** — `pkill -f "node.*gateway"` also kills Python TTS. Use systemd services instead.

### Should Fix
- [ ] **AutopilotPanel read-only** — no save/update functionality, says "Configure via titan.json"
- [ ] **Parallel tool execution** — tools run sequentially. Hermes runs 8 in parallel for read-only tools.
- [ ] **Autonomous skill creation** — Hermes auto-creates SKILL.md after complex tasks. TITAN doesn't.
- [ ] **Session title LLM generation** — currently uses raw first message. Should generate a 5-word title via LLM.

### Won't Fix (Working as Designed)
- CSP `unsafe-inline` still needed for Vite — only `unsafe-eval` was removed
- Voice internal engine ID `qwen3-tts` — kept for backward compatibility, actual engine is F5-TTS

---

## Testing

```bash
npx vitest run                              # All 4,430 tests
npx vitest run tests/core.test.ts           # Core constants
npx vitest run tests/providers-extended.test.ts  # Ollama streaming
npx vitest run tests/mission-control.test.ts     # API endpoints
npx vitest run tests/command-post.test.ts        # Command Post governance
npx tsx scripts/stress-test.ts --password=titan2026  # Live stress test (111 tests)
```

### Version Bumping (update ALL of these)
1. `package.json` → `"version"`
2. `src/utils/constants.ts` → `TITAN_VERSION`
3. `tests/core.test.ts` → version assertion
4. `tests/mission-control.test.ts` → version references (4 occurrences)

---

## Deployment

### Titan PC (Production)
- IP: 192.168.1.11, SSH: `ssh titan`
- TITAN: `/opt/TITAN/`, systemd: `titan-gateway`
- TTS: F5-TTS on RTX 5090, systemd: `titan-tts`, port 5006
- Ollama: port 11434, models: qwen3.5:35b, nemotron-3-super:cloud
- Dashboard: `https://192.168.1.11:48420` (HTTPS via mkcert)
- Config: `~/.titan/titan.json` — model `ollama/qwen3.5:35b`, voice engine `qwen3-tts`, voice `andrew`
- HTTPS certs: `~/.titan/certs/titan.pem` + `titan-key.pem`

### SaaS (Live)
- URL: `https://titan-api.djtony707.workers.dev`
- Stack: Cloudflare Worker + Supabase + Fly.io + OpenRouter + Stripe
- Full docs: `~/Desktop/TITAN-SaaS-Complete-Project-Documentation.md`

---

## Working Rules

- **Never use preview_start** — build on Mac, deploy to Titan PC via SSH
- **Always publish to npm** after pushing to git
- **Always bump version** in all 4 files before publishing
- **Don't break 14K users** — backward compatibility required
- **Andrew voice is private** — not in public releases
- **Run tests before pushing** — CI must stay green
