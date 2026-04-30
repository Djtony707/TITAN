# TITAN Comprehensive Test & Audit Plan

**Goal:** Exhaustively test every TITAN subsystem to surface latent bugs, performance issues, configuration gaps, and user-facing regressions.

**Approach:** Horizontal sweep across all layers (unit → integration → e2e → production). Each test bucket is independent and can run in parallel.

---

## Bucket 1: Core Agent Loop

### 1.1 Think/Respond Cycle Invariants
- [ ] Non-autonomous mode completes multi-step tasks (write → read → edit chain)
- [ ] Autonomous mode respects maxRounds / maxToolRoundsHard limits
- [ ] Voice fastPath caps tokens at 2000 and returns within 5s
- [ ] Empty responses trigger ToolRescue (extractToolCallFromContent)
- [ ] `no_tool_cap` stall detection fires after 2 nudges
- [ ] `silence` stall detection fires after 120s inactivity
- [ ] Budget warnings injected once per loop (not spam)

### 1.2 Session Lifecycle
- [ ] Session compaction triggers after maxSessionRuns / maxSessionAgeHours
- [ ] Session timeout kills process after 30 minutes idle
- [ ] Absolute timeout kills process after 10 minutes total
- [ ] CleanupBudget removes spend tracking on session end
- [ ] Steer queue cleared on session end

### 1.3 Context Budgeting
- [ ] `maxTokens=200000` never triggers false "budget exceeded" for short tasks
- [ ] `maxTokens=4000` aggressively compresses to fit
- [ ] `compress` action truncates oldest history first
- [ ] `downgrade` action switches to cheap model at 80% spend
- [ ] `stop` action hard-halts at 100% spend

---

## Bucket 2: Provider Layer

### 2.1 Model Routing
- [ ] `kimi-k2.6:cloud` routes to Ollama on Titan PC
- [ ] `fast` alias resolves to `qwen3.5:cloud`
- [ ] `smart` alias resolves to `glm-5:cloud`
- [ ] Fallback chain activates on 503/504/timeout
- [ ] `toolCapableModels` list gates tool injection
- [ ] Auxiliary model (`minimax-m2.7:cloud`) used for goal proposing

### 2.2 Provider Health
- [ ] Ollama health check via `/api/tags` (not just TCP)
- [ ] OpenRouter credit check before routing
- [ ] Claude Code adapter handles `think` blocks correctly
- [ ] Google Gemini handles `maxOutputTokens` vs `max_tokens` schema
- [ ] `clampMaxTokens()` per model prevents 400 errors

### 2.3 Rate Limiting
- [ ] 429 from Ollama triggers 1s/2s/4s retry backoff
- [ ] Credential rotation after cooldown period
- [ ] Cost estimator warns before expensive call

---

## Bucket 3: Tool Execution

### 3.1 Shell Tool
- [ ] Blocked commands (rm -rf /, chmod 777 /etc, etc.) rejected
- [ ] Command scanner scores commands 0-100 and blocks > threshold
- [ ] Timeout default is 60000ms (not 30000ms)
- [ ] Background mode (`background: true`) spawns without waiting
- [ ] `verify_port` waits up to 20s for port to open
- [ ] 10MB output buffer, truncates to 25KB head + 25KB tail

### 3.2 File Tools
- [ ] `write_file` creates directories recursively
- [ ] `edit_file` produces unified diff in response
- [ ] `apply_patch` handles fuzzy matching
- [ ] Pre-execution snapshot captured for diff generation
- [ ] File system allowlist blocks `.ssh`, `.env`, `.git/objects`

### 3.3 Browser Automation
- [ ] `browser_navigate` loads page with 60s timeout
- [ ] `browser_screenshot` captures full page
- [ ] `browser_auto_nav` handles CAPTCHA via capsolver
- [ ] `web_act` executes click/type actions
- [ ] Browser pool reuses sessions across calls

### 3.4 Web Tools
- [ ] `web_fetch` returns text content (not raw HTML)
- [ ] `web_search` queries multiple engines and dedupes
- [ ] `smart_form_fill` extracts form schema and fills fields
- [ ] AbortSignal.timeout(45000) on all web calls

### 3.5 Approval Gates
- [ ] `requiresApproval()` checks per-tool preferences
- [ ] `approvalPending` returned when unconfigured
- [ ] Auto-approve for `safe` tools (read_file, list_dir)
- [ ] Auto-deny for `dangerous` tools (shell, exec, code_exec)
- [ ] Command-post approval requests show diff/context

---

## Bucket 4: Memory & Graph

### 4.1 Episodic Memory
- [ ] `graph_remember` stores episode with embedding
- [ ] `graph_search` returns relevant episodes by vector similarity
- [ ] `graph_entities` extracts people, places, concepts
- [ ] `graph_recall` reconstructs timeline
- [ ] Auto-compact when > maxHistoryMessages (50)

### 4.2 Vector Search
- [ ] `nomic-embed-text` model loaded for embeddings
- [ ] 4290 vectors indexed at startup (Titan PC)
- [ ] Query embedding matches within 512 tokens
- [ ] Dimension check: 768d vectors

### 4.3 Working Memory
- [ ] Tracks session state (activeTools, summary, goals)
- [ ] Retires old entries after pressure threshold
- [ ] Persists to `~/.titan/working-memory.jsonl`

---

## Bucket 5: Self-Awareness & Autonomy

### 5.1 Drive System
- [ ] `curiosity`, `competence`, `connection`, `pressure` drives fire
- [ ] Drive satisfaction score updates per tick
- [ ] Goal proposals filed when drive satisfaction < threshold
- [ ] `peerAdvise` gets verdict from sage sub-agent

### 5.2 Self-Healing
- [ ] `self_doctor` detects anomalies in logs
- [ ] `self_repair` generates fix proposals
- [ ] Proposals go to command post for approval
- [ ] Circuit breaker trips after 50 rounds

### 5.3 Organism
- [ ] Hormones injected into system prompt
- [ ] Pressure threshold (1.2) triggers organism response
- [ ] Shadow mode runs background analysis
- [ ] Tick interval 60s, not blocking main loop

---

## Bucket 6: Gateway & Server

### 6.1 HTTP Endpoints
- [ ] GET `/api/health` returns `{status: "ok", version, uptime}`
- [ ] GET `/api/config` returns safe config (passwords masked)
- [ ] GET `/api/stats` returns token usage, memory, provider health
- [ ] POST `/api/message` accepts message + systemPromptAppendix
- [ ] POST `/api/eval/run` runs eval suites

### 6.2 Authentication
- [ ] Password mode (`titan2026`) issues Bearer token
- [ ] Token mode validates `Authorization: Bearer <token>`
- [ ] `mode: "none"` bypasses auth entirely
- [ ] Mesh auth validates secret + nodeId

### 6.3 HTTPS
- [ ] Auto-detects `~/.titan/certs/titan.pem` + `titan-key.pem`
- [ ] Falls back to HTTP if certs missing
- [ ] Health check responds to HTTPS (kimi-k2.6:cloud verified)

### 6.4 WebSocket
- [ ] `/ws` accepts agent bus connections
- [ ] Mesh peers authenticate via URL params
- [ ] Heartbeat every 60s

### 6.5 SSE
- [ ] `/api/stream` streams tool results in real-time
- [ ] Reconnection handled on client disconnect

---

## Bucket 7: Channels

### 7.1 WebChat
- [ ] Enabled by default, runs on port 48421
- [ ] Receives messages via POST `/api/webchat/message`
- [ ] Returns widget HTML or text

### 7.2 Messenger
- [ ] Webhook at `/api/messenger/webhook`
- [ ] Voice replies via F5-TTS (voice=andrew)
- [ ] Page ID configured

### 7.3 Twilio
- [ ] Inbound calls trigger voice agent
- [ ] TTS engine: f5-tts
- [ ] Allowed callers list enforced

### 7.4 Disabled Channels
- [ ] Discord, Telegram, Slack, WhatsApp all `enabled: false`
- [ ] No startup errors when disabled

---

## Bucket 8: Skills Registry

### 8.1 Discovery
- [ ] 248 tools loaded at startup (Titan PC log verified)
- [ ] Auto-discovery scans `src/skills/builtin/` and `~/.titan/skills/`
- [ ] Marketplace disabled (`marketplace: false`)

### 8.2 Registration
- [ ] Each skill has `name`, `description`, `parameters`, `execute`
- [ ] Schema validation via Zod
- [ ] Duplicate names rejected

### 8.3 Procedural Memory
- [ ] `save_skill` stores custom skills
- [ ] `recall_skill` retrieves by fuzzy name match
- [ ] `auto_generate_skill` creates from natural language

---

## Bucket 9: Sub-agents & Delegation

### 9.1 Spawn
- [ ] `spawn_agent` creates new process with isolated context
- [ ] Max depth = 2 (grandchildren allowed, great-grandchildren blocked)
- [ ] Worktree support for parallel edits

### 9.2 Concurrency
- [ ] `maxConcurrent: 8` sub-agents
- [ ] `maxRoundsPerAgent: 10` per delegate
- [ ] Pool queue when limit exceeded

### 9.3 Results
- [ ] Sub-agent results bubble back to parent
- [ ] ` StructuredSpawn` formats output for parent consumption
- [ ] Failed sub-agent returns error + partial output

---

## Bucket 10: Mesh / Networking

### 10.1 Discovery
- [ ] mDNS broadcasts on local network (`mdns: true`)
- [ ] Tailscale VPN peers auto-discovered (`tailscale: true`)
- [ ] Static peers from config (`staticPeers: []`)

### 10.2 Communication
- [ ] `allowRemoteModels: true` — peers can use our models
- [ ] `maxRemoteTasks: 3` — queue limit
- [ ] `heartbeatIntervalMs: 60000`
- [ ] `peerStaleTimeoutMs: 300000` (5 min)

### 10.3 Auth
- [ ] `mesh.secret` required for peer connections
- [ ] `autoApprove: false` — manual approval for mesh tasks

---

## Bucket 11: Voice

### 11.1 TTS
- [ ] F5-TTS server running on port 5006
- [ ] GPU acceleration active
- [ ] Voice `andrew` available
- [ ] Max chars: 1000 per synthesis

### 11.2 STT
- [ ] faster-whisper endpoint: `http://localhost:48421`
- [ ] LiveKit WebSocket: `ws://localhost:7880`

---

## Bucket 12: Safety & Security

### 12.1 Kill Switch
- [ ] `killSwitch.ts` monitors for dangerous patterns
- [ ] Immediate halt on command injection detection
- [ ] Alert sent to command post

### 12.2 Secret Scanning
- [ ] `secretGuard.ts` checks for API keys in output
- [ ] Redacts passwords, tokens, private keys
- [ ] Configurable deny list

### 12.3 Command Scanner
- [ ] Risk score 0-100 per command
- [ ] Block level: commands rejected
- [ ] Warn level: logged but allowed

### 12.4 Sandbox
- [ ] Docker sandbox: `image: titan-sandbox`
- [ ] Openshell sandbox: NVIDIA GPU passthrough
- [ ] Memory limit: 8192 MB, CPU: 1

---

## Bucket 13: VRAM & Performance

### 13.1 GPU Monitoring
- [ ] Ollama VRAM usage tracked every 10s
- [ ] `autoSwapModel: true` when VRAM < reserveMB (3260)
- [ ] Fallback to `qwen3:7b` on OOM

### 13.2 Memory Usage
- [ ] Gateway RSS: ~217 MB (Titan PC verified)
- [ ] Heap used: ~81 MB
- [ ] No memory leaks over 7-day uptime

### 13.3 Response Times
- [ ] Fast model (qwen3.5): < 5s
- [ ] Smart model (glm-5): < 15s
- [ ] Reasoning model (kimi-k2.6): < 60s for complex tasks
- [ ] Ollama 503 retries: max 3 attempts with backoff

---

## Bucket 14: Configuration

### 14.1 Schema Validation
- [ ] `zod` schema catches invalid config on load
- [ ] Defaults applied for missing fields
- [ ] Type coercion for numeric strings

### 14.2 Hot Reload
- [ ] Config changes trigger component restart
- [ ] `RESTART_REQUIRED_PATTERNS` list accurate
- [ ] Graceful shutdown: finish in-flight requests

### 14.3 Environment Variables
- [ ] `TITAN_HOME` overrides default `~/.titan`
- [ ] `TITAN_TELEMETRY_ENABLED=false` disables PostHog
- [ ] `NODE_OPTIONS=--max-old-space-size=6144` for CI

---

## Bucket 15: CI/CD

### 15.1 GitHub Actions
- [ ] `ci.yml`: build + test on Node 22
- [ ] `eval-gate.yml`: boot gateway + run eval suites
- [ ] Gateway boot timeout: 180s (was 60s)
- [ ] Artifact upload: eval results + gateway log retained 30 days

### 15.2 Test Suites
- [ ] Unit tests: `npm test -- --run`
- [ ] Eval suites: 11 behavioral test suites
- [ ] Threshold: 80% pass rate per suite
- [ ] Sharding: 4 shards for memory headroom

### 15.3npm Publish
- [ ] Version bump: `package.json` + `constants.ts` + `README.md`
- [ ] `npm publish --tag latest`
- [ ] `npm dist-tag ls titan-agent` shows `latest: 5.4.2`

---

## Bucket 16: Updater

### 16.1 Development Mode
- [ ] `.git` detected → `git pull && npm run build`
- [ ] Restart script spawns detached process

### 16.2 Production Mode (systemd)
- [ ] `/run/systemd/system` detected → use systemctl
- [ ] `git pull && npm run build`
- [ ] `sudo systemctl restart titan-gateway`

### 16.3 Global npm Mode
- [ ] `npm update -g titan-agent`
- [ ] Requires write access to npm prefix

---

## Bucket 17: Telemetry & Analytics

### 17.1 PostHog
- [ ] API key: `phc_kVw5xLJx5SVXex9RSTCFwP8cJSNEXTYZ7oJwqoDdMPJX`
- [ ] Host: `https://us.i.posthog.com`
- [ ] Consent version: `5.0.1`

### 17.2 Local Logging
- [ ] `~/.titan/telemetry-events.jsonl`
- [ ] `~/.titan/bug-reports.jsonl`
- [ ] `~/.titan/activity-log.jsonl`

---

## Execution Plan

Run all tests in parallel where possible:

```bash
# Run locally (Titan PC)
ssh titan "cd /opt/TITAN && npm test -- --run 2>&1 | tail -20"

# Run eval suites
ssh titan "cd /opt/TITAN && node -e \"require('./dist/eval/harness.js').runAllSuites().then(console.log)\""

# Gateway health soak test
watch -n 5 'curl -k -s -H "Authorization: Bearer $(curl -k -s -X POST https://127.0.0.1:48420/api/login -H "Content-Type: application/json" -d "{\"password\":\"titan2026\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)[\"token\"])")" https://127.0.0.1:48420/api/health'
```
