# Changelog

All notable changes to TITAN are documented in this file.

---

## [2026.10.45] — 2026-03-19

### Added
- **MiniMax M2.7 provider** — OpenAI-compatible preset for MiniMax's self-evolving agentic model (2.3T params, 100B active MoE, 200K context). Provider #32. Access via `minimax/minimax-m2.7` or Ollama cloud `ollama/minimax-m2.7:cloud`.
  - Known models: `minimax-m2.7`, `minimax-m2.7-highspeed`, `minimax-m2.5`, `minimax-01`, `minimax-text-01`
  - API: `https://api.minimax.chat/v1`, env: `MINIMAX_API_KEY`
  - Ollama cloud context: 204,800 tokens
- **Autopilot dry-run mode** — Community contribution by [@sastarogers](https://github.com/sastarogers) ([#7](https://github.com/Djtony707/TITAN/pull/7)). 3-tier precedence: config, runtime, per-call. Skips tool execution in all 4 autopilot modes.

## [2026.10.44] — 2026-03-16

### Changed
- **README** — Updated "What's New" banner (VRAM orchestrator + NVIDIA GPU skills), tool count ~155, test count 4,321, added NVIDIA/VRAM to comparison table, tools table, sandbox section, and roadmap
- **CLAUDE.md** — Updated version, stats, project structure (added `vram/` dir), API endpoints (VRAM), key files, recent history
- **GitHub** — New release v2026.10.43, updated repo description + topics (gpu, vram, nvidia)

## [2026.10.43] — 2026-03-16

### Added
- **VRAM Orchestrator** — Automatic GPU VRAM management for RTX 5090 multi-service workloads. Auto-swaps LLM models to smaller fallbacks when GPU services need VRAM.
  - `src/vram/types.ts` — Interfaces: GpuState, LoadedModel, VRAMLease, AcquireResult, VRAMSnapshot, VRAMEvent
  - `src/vram/gpuProbe.ts` — nvidia-smi queries, Ollama /api/ps model listing, model eviction (keep_alive:0), preload, getModelInfo
  - `src/vram/leaseManager.ts` — Time-bounded VRAM reservations with auto-expiry timers
  - `src/vram/orchestrator.ts` — Core singleton: async mutex, acquire/release with auto-swap and rollback, periodic GPU polling, event bus
  - `src/skills/builtin/vram.ts` — Agent-facing tools: `vram_status`, `vram_acquire`, `vram_release`
- **VRAM API endpoints** — `GET /api/vram` (snapshot), `POST /api/vram/acquire`, `POST /api/vram/release`, `GET /api/vram/check?mb=N` (dry run)
- **VRAM config schema** — `vram.*` config section with `reserveMB`, `autoSwapModel`, `fallbackModel`, `ollamaUrl`, `services` budget map, `pollIntervalMs`
- **Ollama VRAM env vars** — Applied `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_GPU_MEMORY_FRACTION=0.75`, `OLLAMA_KEEP_ALIVE=5m` on Titan PC

## [2026.10.42] — 2026-03-16

### Added
- **NVIDIA NIM provider** — OpenAI-compatible provider preset for NVIDIA NIM API (`nvidia/` prefix). Supports Nemotron 3 Nano, Super, and Llama-Nemotron models. Aliases: `nim`, `nvidia-nim`.
- **NVIDIA skills system** — env-gated (`TITAN_NVIDIA=1` or `nvidia.enabled`) skill loader for optional GPU-accelerated features.
- **cuOpt GPU optimization skill** — `nvidia_cuopt_solve` + `nvidia_cuopt_health` tools for GPU-accelerated vehicle routing (VRP), MILP, LP via NVIDIA cuOpt v26.02 async API. Tested live.
- **AI-Q research skill** — `nvidia_aiq_research` tool using Nemotron Super via NIM API for deep multi-source research with citations. Falls back to local AI-Q Docker deployment.
- **OpenShell sandbox engine** — `sandbox-openshell.ts` wraps NVIDIA OpenShell CLI (v0.0.6) for secure K3s-based code execution with declarative YAML policies. Config: `sandbox.engine: 'openshell'`.
- **NVIDIA config schema** — `nvidia.*` config section (enabled, apiKey, cuopt, asr, openshell subsections). All disabled by default.
- **NVIDIA Docker Compose** — `docker-compose.nvidia.yml` with cuOpt, Nemotron-ASR, and Riva bridge services (separate from main compose).
- **NVIDIA admin panel** — Mission Control UI panel for managing NVIDIA integration settings.
- **THIRD_PARTY_NOTICES** — NVIDIA attribution for Nemotron, cuOpt, OpenShell, Riva.

### Fixed
- **Voice mic leak** — VoiceOverlay now sets `phaseRef` before stopping recognition to prevent `onend` auto-restart. Added unmount cleanup `useEffect` for mic stream, AudioContext, and timers.
- **6 TypeScript errors** — sandbox-openshell `killed` type, server ttsEngine/sttEngine union casts, a2a_protocol `auth` → `oauth`, cuOpt fetchWithRetry timeout param, workflows prefer-const.
- **cuOpt image tag** — corrected from `py3.14` (doesn't exist) to `py3.13`.

## [2026.10.41] — 2026-03-16

### Fixed
- **Critical: Tool visibility** — `security.allowedTools` default changed from restrictive whitelist to empty (allow all). New tools added to skills were silently blocked.
- **Critical: toolSearch.coreTools override** — config-level `coreTools` list overrode `DEFAULT_CORE_TOOLS` entirely. Schema default now empty (falls back to code defaults).
- **Home Assistant tools invisible** — `ha_control`, `ha_devices`, `ha_status` added to `DEFAULT_CORE_TOOLS` so HA tools are always available without needing tool_search discovery.
- **OpenAI-compat keepModelPrefix bug** — providers using `keepModelPrefix` (e.g., NIM API) had model prefix stripped when already present, breaking API calls. Fixed in both `chat()` and `chatStream()`.
- **Voice system prompt** — new `buildVoiceSystemPrompt()` (~500 tokens vs ~3000+) with explicit tool-use rules, HA integration, and TTS emotion tags. Prevents hallucinated tool completion and off-topic responses.
- **Voice core tools** — dedicated `VOICE_CORE_TOOLS` set (9 tools including HA) for faster voice response with fewer prompt tokens.
- **Voice model override** — `voice.model` config allows separate model for voice (e.g., fast local model) vs text chat (e.g., cloud model).
- **ha_control debug logging** — tool now logs raw args, resolved args, HA API call details, and success/failure for easier debugging.

## [2026.10.40] — 2026-03-16

### Added
- **Structured Output skill** — `json_extract`, `json_transform`, `validate_json` tools with JSON Schema validation
- **Workflow Engine skill** — DAG-based declarative workflows with parallel execution, conditional steps, template substitution
- **Social Media Scheduler** — Multi-platform post scheduling (X, LinkedIn, Bluesky, Mastodon, Threads) with character limits and AI drafts
- **Agent Handoff skill** — `agent_delegate`, `agent_team`, `agent_chain`, `agent_critique` for multi-agent patterns
- **Event Triggers skill** — Reactive "when X → do Y" automation (file_change, webhook, schedule, system, email, custom)
- **Knowledge Base skill** — `kb_ingest`, `kb_search`, `kb_ingest_url`, `kb_ingest_file`, `kb_list`, `kb_delete` with TF-IDF search
- **Eval Framework skill** — Dataset management, 5 scorers (exact_match, contains, llm_judge, length, json_valid), model comparison
- **Approval Gates skill** — Human-in-the-loop tool-level approve/deny with timeout auto-actions and audit history
- **A2A Protocol skill** — Agent-to-Agent interoperability following Google/Linux Foundation standard
- **Integration tests** — 1,522-line cross-skill interaction test suite
- **Security tests** — 391-line injection, traversal, and DoS vector test suite

### Fixed
- **Critical**: SSE daemon `removeAllListeners` bug — multi-client disconnect no longer nukes other clients' listeners
- **Critical**: YAML skill sandbox — removed `child_process`, `http`, `https` from allowed modules (arbitrary code execution vector)
- Knowledge base path validation now includes `os.tmpdir()` (macOS compatibility)
- Event triggers file watcher cleanup and input validation hardened
- A2A protocol stricter task state transitions
- Structured output JSON schema edge cases
- Workflow template substitution safety improvements

### Stats
- 9 new skills, 40 new tools (~189 total)
- 4,321 tests across 135 files (all passing)

---

## [2026.10.39] — 2026-03-16

### Fixed
- **Security**: Resolved all 23 Dependabot vulnerability alerts (0 remaining)
- Upgraded matrix-js-sdk v34 → v41
- Added npm overrides for transitive deps: esbuild ^0.25.0, yauzl ^3.2.1, langsmith ^0.5.0

---

## [2026.10.38] — 2026-03-16

### Added
- **`titan doctor --json`** — Machine-readable JSON output with full DoctorReport (Issue #2)
- **npm download stats** — `titan doctor` now shows weekly npm download count from registry (Issue #4)
- **Weather skill tests** — 27 unit tests covering registration, execution, forecasts, errors (Issue #6)

### Improved
- **Provider error messages** — Actionable hints for missing API keys: env var names, config paths, Ollama-specific messages, key validity vs missing (Issue #3)

---

## [2026.10.37] — 2026-03-15

### Added
- **Streaming voice endpoint** (`POST /api/voice/stream`) — LLM tokens streamed via SSE, chunked at sentence boundaries, TTS fired per-sentence
- **Sentence-chunked TTS** — First audio arrives while LLM is still generating; ~1-2s faster time-to-first-audio
- **Server-side voice text processing** — stripMarkdown, stripEmotionTags, stripToolNarration in streaming endpoint
- **Audio playback queue** — VoiceOverlay plays sentence chunks sequentially as they stream in

### Changed
- VoiceOverlay uses `/api/voice/stream` by default with fallback to sequential `/api/message` + `/api/voice/preview`

---

## [2026.10.36] — 2026-03-15

### Added
- **Voice fast-path** — Voice channel skips deliberation, Brain tool filtering, reflection, orchestration, and context compression for ~200-500ms savings per request
- **Adaptive silence timer** — STT silence detection adapts to utterance length: 400ms for short commands, 700ms for longer questions (was fixed 1200ms)
- **Ollama keep_alive** — Models stay loaded in VRAM for 30 minutes between requests, eliminating 2-5s cold-start penalty
- **Voice performance config** — New `voice.maxToolRounds` (default 3) and `voice.fastPath` (default true) settings

### Changed
- Echo grace period reduced from 1500ms to 500ms (browser echoCancellation + mic energy interrupt handle echo)
- Voice tool rounds capped at 3 (configurable) for faster responses

---

## [2026.10.35] — 2026-03-15

### Fixed
- **Voice echo prevention** — `processingRef` guard prevents duplicate API calls; 1500ms grace period after TTS playback; transcript buffer cleared between exchanges
- **TTS/display mismatch** — TTS now uses same `displayText` as chat display (was using pre-stripped `cleanText`)
- **Tool narration in voice mode** — Client-side `stripToolNarration()` removes LLM tool-mention leaks ("I'll use the ha_setup tool...") from voice responses
- **STT restart after first exchange** — `processingRef` removed from `onresult`/`onend` callbacks (only guards `handleUserMessage`)

### Changed
- Voice mode system prompt strengthened with explicit "NEVER mention tool names" directive
- Voice text pipeline: `rawText → stripMarkdown → stripEmotionTags → stripToolNarration → displayText`

---

## [2026.10.34] — 2026-03-15

### Changed
- **Fish Speech removed** — All Fish Speech code, UI, and Gradio integration stripped; TTS is Orpheus-only with browser fallback
- **TTS engine schema validated** — `z.enum(['orpheus', 'browser'])` replaces unvalidated string
- **Dead code removed** — VoiceSettingsPanel.tsx (11KB, never imported)
- **Agent error logging** — 5 silent catch blocks now log warnings/debug messages
- **Double compression fix** — Skip `buildSmartContext` when `maybeCompressContext` already compressed
- **Session cleanup hardening** — Periodic sweep of orphaned AbortControllers
- **Titan PC cleanup** — Removed unhealthy llama-cpp-server container (3.8GB VRAM), Fish Speech files (11GB+ disk)

---

## [2026.10.33] — 2026-03-15

### Changed
- **Home Assistant auto-save** — Gateway auto-detects HA URL + JWT token in user messages and saves to config before LLM processes (prevents model hallucination/tool-skip)
- **ha_setup tool hardened** — Stronger description, rawInput param for free-form text parsing, atomic config saves, logging
- **ha_setup in coreTools** — Always visible to LLM, no tool_search needed
- **Voice test fix** — ttsVoice default assertion updated from 'default' to 'tara'

---

## [2026.10.32] — 2026-03-15

### Changed
- **Orpheus TTS restored** — Reverted from TADA (too slow on CPU) back to Orpheus TTS with GPU acceleration and emotional speech. Default voice `tara`, 8 voices: tara, leah, jess, mia, zoe, leo, dan, zac. Port 5005.
- **Voice selector in VoiceOverlay** — Dropdown during active voice chat to switch between all 8 Orpheus voices mid-conversation. Color-coded dots, saves to localStorage and server config.
- **VoicePicker overhaul** — Proper Orpheus voice presets with unique gradients, descriptions, and gender hints. Exported `getVoiceInfo()` utility.
- **Separate TTS AbortController** — TTS fetch no longer shares AbortController with main request, preventing cascade aborts.
- **Browser TTS fallback** — If Orpheus server is unreachable (15s timeout), falls back to browser Speech Synthesis API instantly.

### Fixed
- **Speech recognition error handling** — Descriptive error messages for mic denied, network errors, audio capture failures.
- **Gateway TTS health check** — Tries `/health` first, falls back to `/v1/audio/speech` probe for Orpheus compatibility.
- **All TADA references removed** — Settings panel, voice settings panel, config schema, gateway, types, and VoiceOverlay updated to Orpheus.

---

## [2026.10.31] — 2026-03-15

### Fixed
- **Config migration for ttsEngine** — Old configs with `ttsEngine: 'orpheus'` or `'kokoro'` no longer crash Zod parse; gracefully coerced. Prevents `onboarded` reset on upgrade.

---

## [2026.10.30] — 2026-03-15

### Added
- **Home Assistant skill (11 tools)** — Full smart home control: `ha_setup`, `ha_devices`, `ha_control`, `ha_status`, `ha_automations`, `ha_scenes`, `ha_history`, `ha_areas`, `ha_call_service`, `ha_dashboard`, `ha_notify`. Config persistence via chat. `src/skills/builtin/smart_home.ts`
- **Voice server REST API** — OpenAI-compatible `/v1/audio/speech` + `/v1/audio/voices` + `/health` endpoints. `titan-voice-server/server.py`
- **Home Assistant config in schema** — `homeAssistant.url` and `homeAssistant.token` fields in Zod config. `src/config/schema.ts`

### Fixed
- **Voice echo cancellation** — Browser AEC/noise suppression constraints, STT paused during TTS playback, 500ms grace period, confidence filtering (< 0.5 = echo). `ui/src/components/voice/VoiceOverlay.tsx`
- **Ollama provider** — Improved error handling and response parsing. `src/providers/ollama.ts`

---

## [2026.10.29] — 2026-03-14

### Added
- **Personal skills global bridge** — `globalThis.__titanRegisterSkill` pattern ensures personal skills (esbuild bundles) register tools into the main app's registry instead of an isolated ghost Map. `src/skills/registry.ts`
- **Personal skills build script** — `scripts/build-personal.cjs` compiles `src/skills/personal/` → `dist/skills/personal/loader.js` via esbuild
- **Stop button (end-to-end)** — Chat stop button now actually works: `POST /api/sessions/:id/abort` + `AbortController` in agent loop + SSE cancellation wired through UI. `src/gateway/server.ts`, `src/agent/agent.ts`, `ui/src/components/chat/ChatInput.tsx`, `ui/src/components/chat/ChatView.tsx`
- **Session abort API** — `POST /api/sessions/:id/abort` endpoint with session-level `AbortController` map. `src/gateway/server.ts`
- **Task continuation injection** — Short confirmation messages (CONFIRM, yes, ok, etc.) now re-inject last 2 assistant messages as `[TASK CONTINUATION]` context so the model doesn't lose its place after system prompt compression. `src/agent/agent.ts`
- **Gmail `delete_label` action** — Delete a single label by ID or name, two CONFIRMs required. `src/skills/personal/google_workspace.ts`
- **Gmail `bulk_delete_labels` action** — Delete multiple labels by name array in one operation, two CONFIRMs required. `src/skills/personal/google_workspace.ts`
- **Google OAuth integration panel** — IntegrationsPanel now has full Google OAuth flow with connection status display. `ui/src/components/admin/IntegrationsPanel.tsx`
- **`abortSession()` API client** — Frontend API function for session abort. `ui/src/api/client.ts`

### Fixed
- **System prompt compression stripping tool instructions** — `compressSystemPrompt()` raised from 3500 → 8000 chars and made tool-aware: active tools with descriptions >200 chars get their full description preserved in a dedicated section. `src/providers/ollama.ts`
- **Confirmation gate `"true"` vs `true` bug** — `requireConfirmation()` checked `confirmed === true` (boolean) but the schema type was `string`, so LLMs sent `"true"` which never passed. Added `|| confirmed === 'true'`. `src/skills/personal/google_workspace.ts`
- **Personal skills registering into ghost registry** — esbuild `--bundle` created a self-contained bundle with its own `toolRegistry` Map instance, separate from the main TITAN app. Tools registered but were invisible. Fixed with global bridge pattern.
- **ToolSearch compact mode hiding personal tools** — Gmail and other personal workspace tools weren't in `coreTools`, so they disappeared after short messages. Added 8 personal tools to `toolSearch.coreTools` config.
- **Skill description consistency** — Standardized description field types across all 50+ builtin skills (string literals, no runtime expressions)

### Changed
- **systemd service** — Added `TITAN_PERSONAL_DIR` env var pointing to `dist/skills/personal/` so the bridge-aware bundle is used. `scripts/titan-gateway.service`

---

## [2026.10.28] — 2026-03-14

### Fixed

- **Vector search circular dependency** — `initVectors()` was calling `embed('test')` to verify the embedding model was available, but `embed()` starts with `if (!available) return null` — and `available` is `false` during init. This meant the test always failed, the init always bailed, and RAG/vector search never initialized. Fixed by replacing the test call with a direct `fetch()` to Ollama's `/api/embed` endpoint (bypassing the availability guard) and using the response to confirm dimensions before setting `available = true`. `src/memory/vectors.ts`
- **ActiveLearning recording no-op resolutions** — When a tool call failed and then succeeded on retry with the *same* tool, `recordErrorResolution()` stored entries like "Resolved by using shell instead of shell." Added a guard: `if (result.name !== lastFailedTool.name)` before recording. `lastFailedTool` is now always cleared on success regardless. `src/agent/agent.ts`
- **ESLint prefer-const** — `let failedApproaches` in `agent.ts` was never reassigned (only `.push()` used), changed to `const`. `src/agent/agent.ts`

---

## [2026.10.27] — 2026-03-14

### Changed — System Prompt Architecture Overhaul
- **Tool Execution section moved to top of system prompt** — Critical tool-use rules now appear before identity/capabilities, ensuring models process enforcement instructions first (LLMs prioritize early context)
- **ReAct loop pattern added** — All models now receive explicit Reason→Act→Observe loop instructions, dramatically increasing tool-call reliability vs. inline text responses
- **MUST/NEVER directives** — Replaced scattered behavior bullets with clear non-negotiable rules: MUST call write_file for files, MUST call web_search for research, MUST call shell for commands, NEVER output file content as text
- **Negative examples injected** — Side-by-side ❌/✓ examples show models exactly what wrong vs. correct behavior looks like for common tasks (write file, research, run command)
- **Task-aware dynamic injection** — System prompt now auto-appends `[TASK ENFORCEMENT]` sections based on message intent detection (file write / research / shell patterns), adding targeted enforcement for each task type
- **API-level `tool_choice` forcing** — When task enforcement is active, round 0 now passes `tool_choice: "required"` (OpenAI/Ollama) or `tool_choice: {type: "any"}` (Anthropic) via API, adding a hard guarantee on top of prompt instructions
- **Cloud model compressed prompt fixed** — `compressSystemPrompt()` in Ollama provider now preserves the full Tool Execution rules section (previously it was stripped, leaving only a vague "use tools" line). Limit raised from 2000 → 3500 chars
- **All 11 sub-agent prompts rewritten** — Explorer, Coder, Browser, Analyst, Researcher, Reporter, Fact Checker, Dev Debugger, Dev Tester, Dev Reviewer, Dev Architect now each have detailed prompts with tool-specific guidance, MUST rules, and output format requirements (was: one-liner descriptions with no enforcement)
- **`forceToolUse` config flag** — New `agent.forceToolUse: boolean` (default: true) controls API-level tool forcing

### Added
- `forceToolUse?: boolean` field in `ChatOptions` interface (base.ts)
- `forceToolUse` config option in `AgentConfigSchema` (schema.ts)

---

## [2026.10.26] — 2026-03-14

### Added
- **Live Training Feed** — Real-time SSE streaming of training progress in Mission Control's Self-Improvement panel
- **Training SSE endpoint** — `GET /api/training/stream` for live progress events, with poll fallback at `GET /api/training/progress`
- **EventEmitter progress system** — `trainingEvents` emitter in model_trainer.ts broadcasts progress to SSE subscribers
- **Terminal-style training log** — Color-coded event display with progress bar, success/error counts, and auto-scroll

### Fixed
- **Critical: Incremental training data writes** — `trainGenerateCloud` now writes each example to disk immediately via `appendFileSync` instead of batching in memory. Previously, all data was lost when TITAN's tool execution timeout killed the long-running generation before it could write the accumulated batch.

---

## [2026.10.25] — 2026-03-14

### Fixed
- **Zero TypeScript errors** — Fixed 15 type errors across agent.ts, server.ts, web_browse_llm.ts, stagehand.ts, autopilot.ts
- **Zero ESLint errors** — Converted `require()` to ESM `await import()`, fixed `prefer-const` violations
- **SSE write safety** — `res.write()` calls wrapped in try/catch to prevent crashes when clients disconnect mid-stream
- **Rate limit store cap** — Rate limit map now capped at 10,000 entries with LRU eviction to prevent unbounded memory growth
- **Interval cleanup** — `rateLimitCleanupInterval` and `healthMonitorInterval` use `.unref()` so they don't block graceful shutdown
- **Unhandled rejection handler** — Added `process.on('unhandledRejection')` to log and prevent silent crashes
- **Hardcoded IPs removed** — Training endpoint SSH commands now use `TITAN_TRAIN_HOST` and `TITAN_TRAIN_USER` env vars instead of hardcoded `192.168.1.11`

---

## [2026.10.24] — 2026-03-14

### Added
- **GitHub Actions CI** — `.github/workflows/ci.yml` runs tests on Node 20/22 for every push and PR
- **"Why TITAN?" comparison table** — Honest feature comparison vs OpenClaw, NemoClaw, Auto-GPT, CrewAI, LangGraph in README
- **README growth assets** — GitHub stars badge, npm downloads badge, CI status badge, contributors badge, star CTA section
- **npm SEO** — Added homepage, bugs fields, expanded keywords from 15 to 25
- **CODE_OF_CONDUCT.md** — Community standards for contributors
- **Examples directory** — 5 runnable demo scripts (quick-start, discord-bot, research-agent, self-improve, mcp-server)
- **Migration guide** — `docs/MIGRATION.md` for developers coming from OpenClaw, CrewAI, LangChain, Auto-GPT
- **Benchmarks doc** — `docs/BENCHMARKS.md` with system requirements, performance characteristics, codebase stats

---

## [2026.10.23] — 2026-03-14

### Changed
- **README bio** — Updated personal bio to accurately reflect family situation
- **TASKS.md** — Marked all completed production autonomy items as done (systemd, health monitor, log rotation, fetchWithRetry timeout, autopilot, fallback chain, goals, AUTOPILOT.md)

---

## [2026.10.22] — 2026-03-14

### Added
- **Internal health monitor** — 60-second interval checks Ollama, TTS, memory usage, and stuck LLM requests; exposes status via `/api/stats` `health` field
- **fetchWithRetry timeout** — Default 2-minute timeout via `AbortSignal.timeout()` prevents gateway freeze from hung providers
- **systemd service unit** — `scripts/titan-gateway.service` for crash recovery with `Restart=on-failure`, `WatchdogSec=120`
- **Log rotation config** — `scripts/titan-logrotate.conf` for daily rotation with 7-day retention
- **Deploy script systemd support** — `scripts/deploy.sh` detects and uses systemd service when available

### Fixed
- **Voice session continuity** — Voice conversations now track `sessionId` across utterances for multi-turn memory
- **Voice recognition stale closure** — `recognition.onend` now uses refs instead of stale state closures, fixing recognition silently stopping after first TTS response
- **Audio memory leaks** — All `Audio` elements properly cleaned up (`src = ''`, object URLs revoked, refs nullified)
- **Voice error feedback** — Visible red error indicators for "Connection error", "TTS unavailable", "Request timed out"
- **Voice timeouts** — 45s timeout on TITAN API, 30s on TTS calls via `AbortController`
- **Voice interruption** — Speaking while TITAN talks now interrupts audio and processes new input
- **Emotion tags in transcript** — Orpheus tags (`<laugh>`, `<sigh>`, etc.) stripped from display, kept for TTS
- **Markdown in voice responses** — Code blocks, bold, italic, headings, bullets stripped client-side before TTS
- **FluidOrb animation loop** — Draw callback no longer recreates 60x/sec; uses refs for props, single `useEffect`
- **Canvas resize thrashing** — Canvas dimensions only set when they actually change
- **TranscriptView keys** — Stable unique IDs instead of array index
- **SSE client-disconnect leak** — `activeLlmRequests` counter no longer leaks when browser drops SSE connection
- **Duplicate graph episodes** — Removed duplicate `addEpisode` call that wrote every user message to the knowledge graph twice
- **Provider field in `/api/config`** — Now correctly derived from model string instead of hardcoded `'openai'`
- **SettingsPanel VoiceHealth type** — Updated from stale `whisper`/`kokoro` field names to `stt`/`tts`
- **TTS health probe** — Voice health endpoint now probes actual TTS endpoint (`/v1/audio/speech`) instead of root URL
- **Voice health check delay** — No longer fires on every page load when voice is disabled (was adding 3s timeout)
- **Ollama context window** — `num_ctx` increased from 8192 to 16384 for local models (better for devstral on RTX 5090)
- **TTS text truncation** — Client caps at 300 chars, server at 500 chars to prevent long TTS hangs
- **Voice mode prompt** — Strengthened to 50 word max, explicit "ABSOLUTELY NO" formatting rules
- **In-flight fetch abort** — Closing voice overlay now aborts pending API/TTS requests
- **Mute stops mic stream** — Browser microphone indicator now correctly turns off when muted
- **Voice config tests** — Updated expected default from `af_heart` to `tara`

---

## [2026.10.21] — 2026-03-13

### Added
- **Dual Training Pipelines** — Two model training modes selectable from Mission Control's Self-Improve panel:
  - **Tool Router** (`titan-qwen`) — Single-turn instruction/output pairs for fast tool selection
  - **Main Agent** (`titan-agent`) — Multi-turn ChatML conversations with OpenAI function calling format (530+ examples covering tool calls, direct answers, error recovery, multi-step chains, identity, code generation, refusal/boundaries)
- **Training Type Selector UI** — Side-by-side cards in Self-Improve panel with model name, score, example count, and role description
- **Customizable Training Hyperparameters** — Collapsible config panel with sliders for base model, LoRA rank (8–128), learning rate (1e-5–1e-3), epochs (1–10), time budget (5–120 min), max sequence length (512–8192)
- **Training Data Generator** — `generate_agent_data.py` creates 530+ multi-turn training examples using 17 real TITAN tool schemas in OpenAI function calling format
- **Agent Training Pipeline** — `train_agent.py` with higher LoRA rank (32), lower learning rate (1e-4), 2048 max seq length, and 9 agent-specific eval cases
- **Self-Improve Action Buttons** — Generate Training Data, Start Training, Deploy Best Model, Run Benchmark — all callable from the UI per training type
- **Separate Experiment History** — Tool Router and Main Agent results displayed in independent tables with distinct color coding
- **API Endpoints** — `POST /api/autoresearch/generate-data`, `POST /api/autoresearch/deploy`, type-filtered `GET /api/autoresearch/results?type=agent|tool_router`

### Fixed
- **Ollama context over-allocation** — Provider was requesting `num_ctx: 65536` for all local models, causing memory spill to CPU and 4-minute response times. Now defaults to `num_ctx: 8192`
- **Deploy script context size** — `deploy.py` Modelfile now uses `num_ctx 8192` instead of `num_ctx 65536`

### Changed
- `deploy.py` supports `--type agent|router` flag for deploying either training pipeline's output
- `TrainingType` and `TrainingConfig` types added to `ui/src/api/types.ts`

---

## [2026.10.20] — 2026-03-13

### Added
- **Autonomous Self-Improvement System** — TITAN now experiments on its own prompts, tool selection, response quality, and error recovery. Uses LLM-as-judge evaluation against benchmark test suites. Proposes changes, evaluates, keeps improvements, discards regressions. Inspired by Karpathy's autoresearch pattern.
  - `self_improve_start` — Launch an improvement session targeting a specific area
  - `self_improve_status` — Check current session progress
  - `self_improve_apply` — Apply successful experiment results to live config
  - `self_improve_history` — View history of all improvement sessions and outcomes
- **Local Model Training Pipeline** — LoRA fine-tuning on local GPU via unsloth, with GGUF conversion and Ollama deployment
  - `train_prepare` — Extract high-quality instruction/response pairs from session history, scored by tool success rates
  - `train_start` — Launch LoRA fine-tuning as background process (budget-limited)
  - `train_status` — Monitor training progress (loss, epoch, ETA)
  - `train_deploy` — Convert to GGUF, import to Ollama as `titan-custom`, optionally switch active model
- **Self-Improvement Config** — `selfImprove` section: `runsPerDay` (1-12), `schedule` (cron array), `budgetMinutes` (5-120), `maxDailyBudgetMinutes` safety cap, `areas` toggle, `autoApply`, `pauseOnWeekends`, `notifyOnSuccess`
- **Training Config** — `training` section: `enabled`, `dataDir`, `budgetMinutes`, `method` (lora/qlora/full), `baseModel`, `autoDeploy`
- **Autopilot Self-Improve Mode** — `autopilot.mode: "self-improve"` iterates configured areas with budget enforcement
- **Mission Control Self-Improvement Panel** — Stats cards, session history, training runs, schedule settings (runs/day slider, cron presets, budget sliders, area toggles), manual trigger buttons
- **Self-Improve API Endpoints** — `GET /api/self-improve/history`, `GET /api/self-improve/config`, `GET /api/training/runs`

---

## [2026.10.19] — 2026-03-13

### Added
- **Slack Skill** — 7 new tools (`slack_post`, `slack_read`, `slack_search`, `slack_react`, `slack_thread_reply`, `slack_channels`, `slack_review`) for proactive Slack engagement with human review queue. Separate from channel adapter — uses `@slack/web-api` for bot-initiated messaging
- **Interaction Tracker** — 3 tools (`interaction_log`, `interaction_stats`, `interaction_search`) for tracking community interactions across platforms (X, GitHub, Discord, Slack, forums). JSONL append-only storage, 50/week compliance warnings, daily trend charts
- **Feedback Tracker** — 3 tools (`feedback_submit`, `feedback_list`, `feedback_update`) for structured product feedback with severity/category classification and keyword-based duplicate detection (>50% word overlap)
- **Growth Experiments** — 3 tools (`experiment_create`, `experiment_update`, `experiment_list`) for hypothesis-driven growth experiments with result/outcome/learnings tracking
- **Content Calendar** — 3 tools (`calendar_add`, `calendar_view`, `calendar_update`) for content publishing pipeline with week-grouped views and 2/week compliance indicators
- **Weekly Report Generator** — 3 tools (`report_generate`, `report_deliver`, `report_history`) aggregating metrics from all trackers into structured async check-in reports with Slack delivery
- **RevenueCat Knowledge Base** — 2 tools (`rc_ingest`, `rc_search`) for RAG-style ingestion and keyword-scored retrieval of RevenueCat documentation
- **Slack Config Schema** — New `slack` section in config: `enabled`, `botToken`, `defaultChannel`, `reviewRequired`
- 130 new tests across 7 test files (total: 3,839 tests, 123 files)

---

## [2026.10.18] — 2026-03-13

### Added
- **Tool Retry with Error Classification** — Automatic retry for transient, timeout, and rate-limit errors with exponential backoff (1s/2s/4s). Permanent errors fail immediately. Per-tool timeout overrides (browser ops 60s, code exec 120s, web search 45s)
- **Dynamic Execution Budget** — Round limits scale with task complexity: simple (10), medium (15), complex (25). Autonomous mode gets 1.5x multiplier. Graceful degradation injects wrap-up prompt 2 rounds before limit
- **Auto-Deliberation** — In autonomous mode, complex task detection auto-enables deliberative reasoning without requiring `/plan` prefix
- **Learning-Driven Tool Selection** — Tools with <30% success rate (10+ uses) tagged `[LOW RELIABILITY]`, >90% tagged `[HIGHLY RELIABLE]` in LLM-visible descriptions. Error resolution patterns recorded when alternative tools succeed
- **Sub-Agent Depth 2** — Configurable nesting depth (default 2) replaces hard block. Max rounds reduced 30% per depth level. Output validation checks for empty/too-short/error responses
- **Goal Dependency Graph** — `dependsOn` field on subtasks with DFS cycle detection. `getReadyTasks()` respects dependency ordering
- **Smarter Context Summarization** — Older tool results (>500 chars) compressed to 150-char summaries. Last 5 tool results kept at full fidelity
- **Checkpoint/Resume** — Agent state serialized when round budget exhausted. `exhaustedBudget` flag and `checkpoint` field in AgentResponse
- **Configurable Initiative Rate Limits** — `autonomy.initiativeIntervalMs` replaces hardcoded 60s interval
- **React-Compatible Form Filling** — `pressSequentially()` replaces `page.fill()` for React SPA compatibility in `fillFormSmart()`

---

## [2026.10.17] — 2026-03-13

### Added
- **CapSolver Integration** — Automatic CAPTCHA solving via CapSolver REST API. Supports reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile. New `captchaSolver.ts` module with detect, solve, and inject pipeline
- **Direct Form Fill Endpoint** — `POST /api/browser/form-fill` bypasses LLM orchestration for reliable form automation. Supports `postClicks` for button/radio interactions after text fill
- **CAPTCHA Solve Endpoint** — `POST /api/browser/solve-captcha` for standalone CAPTCHA solving on any page
- **CapSolver Config** — New `capsolver` section in Zod config schema (`enabled`, `apiKey`, `timeoutMs`, `minScore`)
- **reCAPTCHA Script Render Detection** — Detects sitekeys from `recaptcha/api.js?render=` script tags (invisible reCAPTCHA v3)

### Fixed
- **Form fill button ordering** — Button/radio clicks now deferred to second pass after all text fields are filled, preventing page state corruption
- **React controlled component compatibility** — Form fills now work with React apps that use synthetic events (e.g., AshbyHQ)
- **CAPTCHA detection before submit** — CapSolver integration in `fillFormSmart` attempts auto-solve before falling back to manual

---

## [2026.10.11] — 2026-03-12

### Added
- **Activity Panel** — Live real-time feed showing TITAN's actions (tool calls, agent activity, system events, errors) with auto-refresh, filter buttons, pause/resume, status pills (Idle/Processing/Autopilot), and system summary side panel
- **Activity API** — `GET /api/activity/recent` (parsed gateway log events with filter/limit) and `GET /api/activity/summary` (live system state aggregation)

---

## [2026.10.10] — 2026-03-12

### Added
- **Integrations Panel** — New admin panel for managing LLM provider API keys (12 providers: Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, Fireworks, xAI, Together, DeepSeek, Perplexity, Ollama) and Google OAuth credentials, with configured/not-configured status badges
- **Workflows Panel** — Fully functional command center with Active Goals (create/track/complete), Scheduled Tasks (cron CRUD), Recipes (browse/run), and Autopilot status with run history
- **Goals API** — REST endpoints for goal/subtask CRUD (`/api/goals`)
- **Cron API** — REST endpoints for cron job management (`/api/cron`)
- **Autopilot toggle API** — Enable/disable autopilot via `/api/autopilot/toggle`
- **Recipe run API** — Execute recipes via `/api/recipes/:id/run`
- **Autonomous persona** — New `autonomous` persona with prime directives, tool mastery guide, and self-reflection protocol
- **Provider config support** — Backend handles API keys for 8 additional providers (Groq, Mistral, OpenRouter, Fireworks, xAI, Together, DeepSeek, Perplexity)

---

## [2026.10.9] — 2026-03-12

### Fixed
- **LearningPanel rewrite** — Panel now fetches from correct API endpoints (`/api/learning`, `/api/stats`, `/api/graphiti`), shows knowledge entries, tool tracking, error patterns, corrections, graph stats, and system metrics. Replaced broken CSS variables with hardcoded hex colors.

### Added
- **Autonomous operation** — AUTOPILOT.md checklist and SOUL.md persona for fully autonomous agent behavior with 30-minute autopilot cycles

---

## [2026.10.8] — 2026-03-12

### Fixed
- **HelpPanel transparency** — Panel used undefined CSS variables making it see-through; replaced with hardcoded hex colors matching dark theme design system

---

## [2026.10.7] — 2026-03-12

### Added
- **Research Pipeline** — DeerFlow-inspired multi-agent parallel research with plan decomposition, parallel sub-agent fan-out, synthesis with confidence scoring, and structured reports (`deep_research_pipeline` tool)
- **Autonomous Experimentation** — Karpathy's autoresearch pattern: bounded iterative experimentation with git-as-memory, keep/discard/crash tracking, results.tsv audit trail (`experiment_loop` tool)
- **TopFacts Memory Plugin** — DeerFlow-inspired persistent "What I Know About You" facts injected into system prompt via ContextEngine plugin (auto-extracts preferences, corrections, expertise from conversations)
- **Checkpoint/Resume** — Plans checkpoint after each completed task for crash recovery (`checkpointPlan`, `loadCheckpoint`, `resumePlan`)
- **Sub-agent templates** — `reporter` and `fact_checker` templates added to SUB_AGENT_TEMPLATES
- **7 new recipes** — `/research`, `/market-analysis`, `/competitor-intel`, `/tech-report`, `/experiment`, `/optimize`, `/ab-test`
- **Help Panel** — Context-sensitive "?" help panel with FAQ, glossary, and search in Mission Control
- **Quick Actions** — Guided workflow prompt cards in empty chat state (Research, Experiment, Brainstorm, Debug, Explain, Market Analysis)
- **100 new tests** — research-pipeline (15), autoresearch (16), top-facts (20), checkpoint (15), recipes-extended (22), deliberation checkpoint integration

### Fixed
- **agent.test.ts** — Added missing `learnFact` mock export, fixed `addEpisode` call count assertion
- **autoresearch** — Fixed `||` to `??` for `timeBudgetMinutes`/`maxExperiments` so `0` values are respected
- **tool-search.test.ts** — Updated `DEFAULT_CORE_TOOLS` bound for new tools

---

## [2026.10.6] — 2026-03-10

### Added
- **Human-like voice** — Conversational system prompt, thinking preambles, time-aware greetings, tech acronym expansion
- **Dynamic FluidOrb** — Real LiveKit agent state (listening/thinking/speaking) drives orb color and animation
- **Thinking state** — Amber/gold orb pulse while TITAN processes a response
- **6 new voice personas** — Sarah, Liam, Lily, George, Jessica, Eric for small business and new users (16 total)
- **MiniFluidBubble** — Animated canvas-based fluid orb replaces mic icon in chat input
- **Agent selector** — ChatView agent pill bar for routing messages to specific spawned agents
- **Agent routing** — `agentId` parameter through gateway → multiAgent router
- **TrackVolumeMonitor** — Isolated component for LiveKit useTrackVolume hook

### Fixed
- **Voice overlay crash** — Conditional `useTrackVolume` hook call violated React rules of hooks, causing blank screen after 1 second
- **Self-healing LiveKit URL** — WebSocket URL dynamically rewrites based on request hostname (Tailscale/LAN/local)
- **Voice health pre-check** — Checks `/api/voice/health` before LiveKit connection with auto-retry (3 attempts)
- **AgentsPanel type** — Fixed `getAgents()` return type unwrapping

---

## [2026.10.5] — 2026-03-10

### Added
- **Personas system** — 21 curated agent personas (default + 20 from agency-agents) with division-based organization (engineering, testing, product, project-mgmt, design, specialized)
- **Persona Manager skill** — `list_personas`, `switch_persona`, `get_persona` tools for runtime persona switching
- **Personas admin panel** — Mission Control panel with division-filtered grid, active persona indicator, click-to-switch
- **API endpoints** — `GET /api/personas` and `POST /api/persona/switch` for persona management
- **Onboarding FluidOrb hero** — Welcome step now features the animated FluidOrb instead of static logo
- **Onboarding persona selection** — Profile step replaced with dynamic persona picker from API
- **Onboarding cinematic launch** — Launch step with shimmer text "MISSION CONTROL READY" and animated stat counters
- **Persona tests** — `tests/personas.test.ts` covering load, get, list, content, and cache invalidation

### Improved
- **System prompt** — Active persona content injected after SOUL.md in agent context
- **Config schema** — Added `agent.persona` field (default: 'default')
- **Third-party attribution** — Added agency-agents (MIT, AgentLand Contributors) to THIRD_PARTY_NOTICES.md

---

## [2026.10.4] — 2026-03-10

### Added
- **Onboarding Wizard** — beautiful 5-step web-based setup wizard for first-time users (provider selection, model picking, personality customization) — no terminal required
- **`system_info` tool** — real hardware detection (CPU, RAM, GPU via nvidia-smi, disk, network, OS, Docker containers, Ollama models) replaces generic placeholder responses
- **New admin panels** — Learning, Autopilot, Security, Workflows, Memory Graph panels in Mission Control
- **Suggestion pills** — chat empty state now shows quick-start prompts for new users

### Fixed
- **Tool discovery** — added `system_info`, `goal_list`, `spawn_agent` to core tools so the model always has access without needing `tool_search`
- **Chat 400 errors** — fixed message field name (`message` → `content`) in chat API client
- **SSE parser** — fixed streaming response parsing for real-time chat output
- **Version display** — sidebar now shows current version with npm update check

### Improved
- **109 tools** — up from 108 with the new `system_info` skill
- **Onboarding API** — `GET /api/onboarding/status` and `POST /api/onboarding/complete` endpoints
- **Health endpoint** — now includes `onboarded` status flag

---

## [2026.10.3] — 2026-03-09

### Fixed
- **Settings panel crash** — `getModels()` API returns `{provider: [models]}` object but Settings panel expected an array; now flattens to `ModelInfo[]` in the API client
- **Settings panel wrong config keys** — panel read `config.model` / `config.provider` but API returns nested `config.agent.model`; fixed to read from correct paths

---

## [2026.10.2] — 2026-03-09

### Fixed
- **Auth lockout on fresh installs** — default `auth.mode='token'` with no token configured permanently locked out all API requests (401); now treats unconfigured token auth as no-auth so Mission Control works out of the box

---

## [2026.10.1] — 2026-03-09

### Fixed
- **Settings panel blank screen** — admin panels now have proper padding wrapper
- **Settings error handling** — shows error message with retry button instead of blank screen on API failure
- **Voice button always visible** — mic button renders in chat input (disabled when voice not configured)
- **Voice overlay modal** — clicking voice button now opens VoiceOverlay instead of hash navigation
- **Docker build** — include `tsconfig.json` and `ui/dist` in Docker image
- **ESM `__dirname`** — fixed `ReferenceError` in gateway server when serving React SPA

### Added
- **Mission Control v2 tests** — 35 comprehensive tests covering all admin panels, auth, SSE, SPA serving

---

## [2026.10.0] — 2026-03-09

### Added
- **Mission Control v2** — complete React 19 SPA replacing the monolithic HTML dashboard
  - ChatGPT-style chat interface with SSE token streaming
  - 10 admin panels: Overview, Agents, Settings, Channels, Skills, Sessions, Learning, Autopilot, Security, Logs
  - Built with Vite, Tailwind CSS 4, React Router v7, Lucide React, Motion
  - Markdown rendering with syntax highlighting (react-markdown + rehype-highlight)
- **Voice health endpoint** — `GET /api/voice/health` reports LiveKit, STT, and TTS status
- **LiveKit token endpoint on gateway** — `POST /api/livekit/token` for voice session tokens
- **Distributed setup support** — env-var based docker-compose for split-machine deployments (Pi 5 + GPU PC)
- **THIRD_PARTY_NOTICES.md** — comprehensive OSS attribution for all ~50 dependencies

### Changed
- Legacy dashboard moved to `/legacy` route
- Removed titan-voice-ui container (voice UI consolidated into Mission Control v2)
- Docker-compose restructured for multi-machine deployments

---

## [2026.9.6] — 2026-03-09

### Fixed
- **Version constant** — `TITAN_VERSION` in constants.ts was stuck at 2026.9.1 while package.json was at 2026.9.5, causing `/api/health` to report wrong version
- **Version test** — updated core.test.ts to match current version
- **README audit** — corrected all stats: 108 tools (was 112), 34 providers (was 21), 15 channels (was 9), 3,561 tests, updated roadmap, added all missing providers/channels to tables
- **ARCHITECTURE.md** — updated diagram counts, added MCP/metrics/RBAC/voice to overview

---

## [2026.9.5] — 2026-03-09

### Added
- **Visual Workflow Builder** — drag-and-drop recipe/pipeline editor in dashboard
  - Node-graph canvas visualization of workflow steps (HTML5 Canvas)
  - Step builder with prompt, tool, and awaitConfirm fields
  - Add/remove steps with live canvas update
  - YAML export/import for workflow sharing
  - 7 REST API endpoints: `GET/POST/PUT/DELETE /api/recipes`, `/api/recipes/builtin/templates`, `/api/recipes/import`
  - Workflow execution from dashboard (sends steps to agent chat)
  - 6 builtin recipe templates (code-review, standup, explain, brainstorm, debug, briefing)
  - 12 workflow tests (YAML roundtrip, store integration, parameter handling)

### Changed
- Recipe store now exports `importRecipeYaml` and `exportRecipeYaml` for YAML serialization
- Dashboard nav updated with Workflows panel

---

## [2026.9.4] — 2026-03-09

### Added
- **One-Line Install** — `curl -fsSL .../install.sh | bash` with OS detection, Node.js auto-install via nvm
- **Cloud Deploy Configs** — Railway, Render, Replit one-click deployment with healthchecks and persistent storage
- **Deploy Buttons** — Railway/Render/Replit buttons in README header

### Changed
- **Dockerfile** — switched to Alpine runtime (smaller image), added 0.0.0.0 binding, .dockerignore
- **README badges** — updated to current stats (34 providers, 112 tools, 15 channels, 3,549 tests)
- Reorganized Quick Start with install script, Docker, and manual install sections

---

## [2026.9.2] — 2026-03-09

### Added
- **Team Mode with RBAC** — multi-user support with role-based access control
  - 4 hierarchical roles: owner > admin > operator > viewer
  - Team CRUD, member management, invite codes with expiry
  - Per-role tool permissions with wildcard pattern matching (deny overrides allow)
  - 14 API endpoints: `/api/teams/*` for full team lifecycle
  - CLI: `titan teams --create|--delete|--info|--add-member|--invite|--join|--set-role`
  - Session `teamId` field for RBAC-scoped sessions
  - JSON persistence at `~/.titan/teams.json`
  - 32 tests

---

## [2026.9.1] — 2026-03-09

### Added
- **Plugin SDK + Skill Scaffolding** — CLI templates for rapid third-party skill development
  - `titan skills --scaffold --name <name> --format js|ts|yaml` generates full project structure
  - `titan create-skill <name>` alias command for quick scaffolding
  - SKILL.md frontmatter metadata per skill (name, version, author, category)
  - `titan skills --test <name>` to load and execute skills with sample arguments
  - `titan mcp-server` to launch stdio MCP transport for external clients
  - JS/TS/YAML templates with parameter schemas, exports, and auto-generated test files

### Fixed
- Fixed briefing test mock hoisting issue (vi.hoisted for shared fs mock references)
- Fixed scaffold test mock hoisting issue (vi.hoisted for testHome variable)

---

## [2026.9.0] — 2026-03-09

### Added
- **MCP Server Mode** — expose TITAN's ~112 tools via Model Context Protocol (JSON-RPC 2.0)
  - HTTP transport: `POST /mcp` endpoint on gateway port
  - Stdio transport: launch TITAN as subprocess for MCP clients (Claude Code, Cursor, etc.)
  - `GET /api/mcp/server` status endpoint
  - Respects security policy (denied/allowed tools, skill enable state)
  - 15 tests
- **LiveKit Voice Integration** — replaced custom PCM-over-WebSocket voice pipeline with LiveKit WebRTC
  - `POST /api/livekit/token` for secure room access (JWT, 15-min TTL)
  - Dashboard voice panel with connect/mute/disconnect, bar visualizer, agent state
  - Agent bridge (`src/voice/livekitAgent.ts`) routes STT → TITAN brain → TTS
  - LiveKit, Inc. MIT attribution in LICENSE and package.json

### Removed
- Old voice pipeline: 10 source files (pipeline.ts, audioUtils.ts, 4 STT/4 TTS providers)
- 4 voice test files (replaced with voice-livekit.test.ts)

### Changed
- `VoiceConfigSchema` now uses LiveKit provider config (url, apiKey, apiSecret, agentName)
- Updated README, ARCHITECTURE, TASKS docs for LiveKit voice and MCP server

---

## [2026.8.0] — 2026-03-09

### Added
- **ContextEngine Plugin System** — lifecycle hooks (bootstrap/ingest/assemble/compact/afterTurn), config-driven registry
- **Prometheus Metrics** — Counter/Histogram/Gauge, `GET /metrics` endpoint, Telemetry dashboard panel
- **30 OpenAI-compatible Provider Presets** — HuggingFace, AI21, Cohere v2, Reka, Zhipu, 01.AI, and more (34 total)
- **6 New Channels** — IRC, Mattermost, Lark/Feishu, Email (IMAP), LINE, Zulip (15 total)
- **Fallback Model Chains** — auto-cascade on failure with configurable chain
- **Deep Research Agent** — researcher sub-agent template with iterative search-read-synthesize and citation tracking

---

## [2026.7.0] — 2026-03-09

### Added
- **RAG/Vector Search** — SQLite FTS5 + Ollama/OpenAI embeddings, 4 tools (rag_ingest/search/list/delete)
- **Token Streaming** — SSE (`Accept: text/event-stream`) + WebSocket live token streaming to dashboard
- **Adaptive Teaching** — first-run wizard, progressive skill reveal, teach mode, user skill profiles
- **Memory Importance Scoring** — LLM-rated importance (1-10), smart context eviction

---

## [2026.6.7] — 2026-03-08

### Added
- **Agent Reflection** — self-assessment every N rounds during tool loops (confidence, completeness, next steps)
- **Sub-Agent Spawning** — isolated agents with constrained toolsets (explorer, coder, browser, analyst templates)
- **Orchestrator** — parallel/sequential multi-step task delegation with dependency-aware execution
- **Goal Management** — persistent goals with subtasks, budget tracking, auto-completion (4 tools)
- **Self-Initiative** — auto-chains goal subtasks after completion via autopilot loop
- **Shared Browser Pool** — single Chromium instance, max 5 pages, 30-min TTL, cookie persistence, anti-detection
- **Stagehand Integration** — natural language browser automation with Playwright fallback (act/extract/observe)
- **X/Twitter Posting** — OAuth 1.0a signature, review queue, draft/approve/post/list (4 tools)
- 98 new tests across 9 test files (reflection, subAgent, orchestrator, goals, initiative, goals-skill, x-poster, browser-pool, stagehand)

### Changed
- Browser skills (`web_browser.ts`, `web_browse_llm.ts`) now use shared browser pool instead of spawning individual Chromium processes
- Deliberation uses configured model (or fast alias) instead of hardcoded `o3-mini` fallback
- Deliberation thinking parameter is now conditional on model support (only enabled for o-series and Claude models)
- Initiative wired into autopilot — `checkInitiative()` called after successful goal subtask completion

### Fixed
- Deliberation fallback chain: no longer fails silently when o3-mini unavailable and fallback model doesn't support thinking
- Browser memory leak: shared pool replaces duplicate Chromium processes

### Stats
- **95 tools** (was 86)
- **33 skill files** (was 31)
- **3,323 tests** across 94 files (was 3,225 across 85 files)
- **21 providers**, **9 channels**

---

## [2026.6.0–6.6] — 2026-03-07

### Added
- **Tool Search** — compact tool mode for efficient tool discovery
- **Sandbox Code Execution** — Docker-based code execution with HTTP tool bridge
- **Deliberative Reasoning** — multi-stage reasoning (analyze, plan, approve, execute)

---

## [2026.5.18] — 2026-03-07

### Added
- Mesh networking fully operational — router integration, peer approval system, up to 5 peers
- Dashboard Mesh tab for peer management (approve/reject/revoke)
- Mesh API endpoints, CLI commands, persisted approved-peers.json

---

## [2026.5.17] — 2026-03-06

### Added
- GitHub-hosted Skills Marketplace (12 curated skills)
- Dynamic model dropdown (all 21 providers)
- Marketplace API endpoints

---

## [2026.5.14–5.16] — 2026-03-05

### Added
- 4 income automation skills (16 tools): income_tracker, freelance_monitor, content_publisher, lead_scorer
- Skill enable/disable toggle (dashboard + API)
- Onboarding UX improvements

---

## [2026.5.9–5.10] — 2026-03-04

### Added
- Port pre-check, small model tool reduction, GPU auto-detection
- Config validation, slash commands via API, concurrent LLM limit
- Tool fallback (provider failover hardening)

---

## [2026.5.4–5.8] — 2026-03-03

### Added
- Encrypted secrets vault, tamper-evident audit log, self-healing doctor
- Autopilot Mode — hands-free scheduled agent runs
- 6 new providers (Venice AI, AWS Bedrock, LiteLLM, Azure OpenAI, DeepInfra, SambaNova)
- Google Chat channel, Cloudflare Tunnel support
- Skyvern MCP browser automation
