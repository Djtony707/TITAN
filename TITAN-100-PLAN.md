# TITAN 100% Operational Plan

**Project**: TITAN Agent v5.4.1  
**Goal**: Get every claimed feature built, tested, and running — then deploy a 24/7 multi-agent worker swarm to finish the framework itself.  
**Status**: Fresh clone from `Djtony707/TITAN`. No build artifacts. Architecture solved on paper, some critical paths still stubbed.

---

## Phase 0 — Audit Results (What We Found)

| Claim (README) | Reality | Status |
|---|---|---|
| 37 AI Providers | 15 provider files in `src/providers/` | **GAP** — need to map the other 22 |
| 253 Tools | `tests/unit/readme-claims.test.ts` verifies at runtime | **VERIFY** — run the test |
| 110 Widgets | `assets/widget-templates/` exists (JSON templates) | **VERIFY** — count the JSON files |
| 16 Chat Channels | 20 channel files in `src/channels/` | **OK** — actually exceeds claim |
| SOMA / Digital Feelings | `src/organism/` (5 files) | **OK** — implemented |
| Mesh Networking | `src/mesh/` (5 files) | **OK** — implemented |
| Voice (F5-TTS, LiveKit) | `titan-voice-*` packages at root (3 separate projects) | **PARTIAL** — not wired into main gateway |
| Multi-Agent (heartbeat inbox) | `checkAndProcessInbox()` stubbed with TODOs in `agentLoop.ts` | **CRITICAL GAP** — must enable |
| Self-Improvement / Fine-tune | Referenced in README, `src/eval/` exists | **VERIFY** — check if end-to-end works |
| Facebook Autopilot | `src/skills/builtin/content_publisher.ts` likely handles this | **VERIFY** — test the flow |
| 500+ Tests, <5s | 247 test files, no `node_modules` yet | **VERIFY** — install and run |
| Build / Dist | No `dist/`, no `node_modules/` | **BLOCKED** — must install first |

### Critical TODOs in Source
1. `src/agent/agentLoop.ts:1762` — "Re-enable when models handle injected context better" (reflection context injection)
2. `src/agent/agentLoop.ts:1873` — "pipe runId through LoopContext"
3. `src/agent/autopilot.ts:84` — "Check workspace for any TODO items that need attention"
4. `ARCHITECTURE-TODO.md` explicitly states `checkAndProcessInbox()` is **stubbed** and needs uncommenting:
   - Line 178-187: `if (ctx.agentId && round > 0 && round % 3 === 0)` check
   - Line 191-194: `if (cpEnabled && ctx.agentId && round === 0)` check

---

## Phase 1 — Foundation (Day 1)

**Goal**: The codebase compiles, installs, and passes its own test baseline.

1. **Install Dependencies**
   ```bash
   cd ~/Desktop/TitanBot/TITAN-main
   npm install
   ```
   - Node 24 is installed ✅
   - May need to handle native deps or platform-specific packages

2. **Type Check**
   ```bash
   npm run typecheck
   ```
   - Fix any TypeScript errors before building
   - Document each fix in commit messages

3. **Build**
   ```bash
   npm run build
   ```
   - Produces `dist/` via tsup
   - If UI build fails separately, fix `npm run build:ui`

4. **Run Unit + Mock Tests**
   ```bash
   npm test
   npm run test:parity
   ```
   - Target: all unit and trajectory tests pass in <5s (README claim)
   - Capture the actual pass/fail count
   - Fix any broken tests before moving on

5. **Run README Claim Verification**
   ```bash
   npm test -- tests/unit/readme-claims.test.ts
   ```
   - This test catches drift between README marketing and runtime reality
   - If it fails, we know exactly which claim is a lie and fix it

**Deliverable**: `npm test` exits 0. We know the honest baseline.

---

## Phase 2 — Critical Path Fixes (Day 2)

**Goal**: Enable the multi-agent heartbeat system and close the highest-impact TODOs.

1. **Enable `checkAndProcessInbox()` in `agentLoop.ts`**
   - Uncomment the round-based polling logic (lines ~178-194)
   - Verify `claimWakeupRequest()` CAS logic works under concurrent access
   - Add a feature flag (e.g., `TITAN_HEARTBEAT_INBOX=true`) so it can be toggled safely
   - Test: spawn a sub-agent, verify the parent continues immediately and results drain on the next inbox poll

2. **Pipe `runId` through `LoopContext`**
   - `agentLoop.ts:1873` has `runId: undefined`
   - Trace where `runId` originates (likely Command Post `startRun()`) and thread it through the loop context
   - This connects telemetry/logging from the agent loop back to the Command Post run record

3. **Re-enable Reflection Context Injection**
   - `agentLoop.ts:1762` — reflection reasoning is currently disabled
   - Evaluate if current models (Claude Sonnet 4, GPT-4o, etc.) handle injected context well enough now
   - If yes, remove the comment block; if no, document why and set a model-version gate

4. **Autopilot Workspace TODO Scanner**
   - `autopilot.ts:84` references scanning workspace for TODOs
   - Implement or wire this up so autopilot can proactively surface stale TODOs as goals

**Deliverable**: Multi-agent delegation works end-to-end. Agent A can spawn Agent B asynchronously and receive results without blocking.

---

## Phase 3 — Feature Verification & Gap Closure (Days 3-4)

**Goal**: Every README feature has a working path. No phantom features.

### 3a — Provider Count (37 claimed)
- Audit `src/providers/`: count unique provider implementations
- The `auxiliary.ts` and `video/` may hide additional providers
- Document the actual count. If <37, create a tracker issue for each missing provider
- Priority order: Groq, Cerebras, DeepSeek, Mistral, Together, Fireworks, Azure, Bedrock, xAI, Gemini

### 3b — Widget Gallery (110 claimed)
- Verify `assets/widget-templates/` exists and count JSON templates
- If count is low, determine if widgets are generated dynamically from skills or hard-coded
- The README says "110 production-ready canvas widgets across 25 categories"
- Check `src/gateway/dashboard.ts` and UI code for widget rendering logic
- Ensure the gallery search/load path works from the chat agent

### 3c — Voice Integration
- `titan-voice-server/` — Python FastAPI server with TTS/STT/VAD
- `titan-voice-agent/` — Python agent wrapper (Kokoro TTS)
- `titan-voice-ui/` — Next.js UI for voice
- **Gap**: These are separate packages, not wired into the main Node gateway
- Plan:
  1. Build Docker images for voice-server and voice-agent
  2. Add `docker-compose.voice.yml` to the main project
  3. Wire the gateway's voice endpoints (`/api/voice/*`) to proxy to the Python sidecar
  4. Verify WebRTC streaming path from UI → gateway → voice-server → LiveKit

### 3d — Facebook Autopilot
- `src/skills/builtin/content_publisher.ts` likely handles posting
- Verify it can:
  1. Authenticate with Facebook Graph API
  2. Schedule posts (up to 6/day)
  3. Reply to comments via webhook
  4. PII-filter content before posting
- Check `src/channels/messenger.ts` for DM pairing logic
- If incomplete, scope the remaining work

### 3e — Self-Improvement / Overnight Learning
- `src/eval/` has harness and benchmark scripts
- `scripts/agent-eval-v2.ts` runs evaluation suites
- Check if there's an actual automated pipeline that:
  1. Records conversation outcomes as DPO preference pairs
  2. Runs fine-tuning or prompt optimization overnight
  3. Evaluates new strategies against old ones
  4. Swaps in winners automatically
- If this is aspirational (not implemented), document it as a v6 roadmap item

### 3f — Safety Suite Verification
- PII Redaction: test with fake SSNs, emails, credit cards
- Secret Scanner: verify API keys are caught before logging
- Pre-Execution Scanner: confirm `rm -rf /`, `curl | sh` are blocked
- Filesystem Checkpoints: verify rollback works after a bad edit
- Kill Switch: test `titan pause` or equivalent stops all autonomous actions
- Guest Mode: verify restricted permissions for secondary users

**Deliverable**: A feature matrix (Google Sheets or markdown table) showing every README claim with ✅/❌/🚧 status and a one-line note.

---

## Phase 4 — Testing & CI Hardening (Day 5)

**Goal**: The test suite is trustworthy and CI blocks broken code.

1. **Live Eval Gate**
   ```bash
   npm run test:eval
   ```
   - 11 suites, 80% pass rate per suite is the merge gate
   - Run this locally first to establish the baseline
   - If any suite is below 80%, fix or adjust the threshold with justification

2. **E2E Tests**
   ```bash
   npm run test:e2e
   ```
   - Playwright tests against the running gateway
   - Verify dashboard loads, chat works, widgets spawn

3. **Benchmarks**
   ```bash
   npm run benchmark:dry
   ```
   - Ensure benchmarks run without crashing
   - Capture baseline numbers for token/s and latency

4. **Docker Build**
   ```bash
   docker build -t titan:test .
   ```
   - Multi-stage Dockerfile must produce a working image
   - Test the Docker run command from README

5. **CI Verification**
   - Check `.github/workflows/eval-gate.yml`
   - Verify sharding, heap limits, and artifact uploads are configured correctly
   - If CI has been failing (commit messages suggest OOM issues), confirm the fixes in `vitest.config.ts` actually work

**Deliverable**: All test commands exit 0. CI is green on `main`.

---

## Phase 5 — Multi-Agent Worker Swarm (Days 6-7)

**Goal**: You are no longer a one-person team. TITAN agents work on TITAN itself, 24/7.

### 5a — Agent Specialization Map
Define 5 specialist agents (matching the README's router limit) each with a focused domain:

| Agent | Role | Tools | Workspace |
|---|---|---|---|
| **Builder** | Writes code, fixes bugs, adds features | `write_file`, `edit_file`, `shell`, `git` | `~/Desktop/TitanBot/TITAN-main/src/` |
| **Tester** | Runs tests, diagnoses failures, adds coverage | `npm test`, `vitest`, `playwright` | `~/Desktop/TitanBot/TITAN-main/tests/` |
| **Docs** | Updates README, ARCHITECTURE, comments | `write_file`, `web_search` | `~/Desktop/TitanBot/TITAN-main/*.md` |
| **Reviewer** | Code review, architecture audit, security scan | `read`, `grep`, `git diff` | `~/Desktop/TitanBot/TITAN-main/` |
| **DevOps** | Docker, CI, deploy scripts, infrastructure | `docker`, `docker-compose`, `shell` | `~/Desktop/TitanBot/TITAN-main/` |

### 5b — External Adapter Setup
TITAN already has adapters for Claude Code, Codex, and bash (`src/agent/adapters/`). Use these to spawn real coding agents:

1. **Claude Code Adapter**
   - Configure `claude-code` binary path
   - Set `cwd` to the TITAN repo
   - The adapter spawns Claude Code with a task, captures stdout, and returns results

2. **Codex Adapter**
   - Configure `codex` CLI path
   - Use for quick file edits and test generation

3. **Bash Adapter**
   - For automated scripts: `npm test`, `npm run build`, `git commit`

### 5c — Command Post Work Queue
Use TITAN's own Command Post as the task board:

1. Create issues for each Phase 1-4 task
2. Assign issues to specialist agents
3. Enable heartbeat inbox polling so agents pick up work automatically
4. Set up a cron/loop that creates new issues when old ones close

### 5d — 24/7 Daemon Mode
```bash
# Run TITAN gateway as a background service
titan gateway --daemon

# Or use tmux/screen for persistent sessions
tmux new -d -s titan-builder 'cd ~/Desktop/TitanBot/TITAN-main && titan agent --name builder --specialist coder'
tmux new -d -s titan-tester 'cd ~/Desktop/TitanBot/TITAN-main && titan agent --name tester --specialist qa'
tmux new -d -s titan-docs   'cd ~/Desktop/TitanBot/TITAN-main && titan agent --name docs --specialist writer'
```

### 5e — Integration with Kimi / Claude Desktop
Since you're already using Kimi Code CLI (as evidenced by `~/.kimi_openclaw` and the `claude` binary), wire TITAN's `delegate_task` tool to spawn Kimi/Claude sessions:

```typescript
// In TITAN config or skills
delegate_task({
  task: "Implement the missing provider for Groq",
  adapter: "claude-code",
  cwd: "/Users/michaelelliott/Desktop/TitanBot/TITAN-main",
  priority: "high"
})
```

**Deliverable**: A running configuration where TITAN agents autonomously pick up tasks from the Command Post, execute them via external adapters, and post results back.

---

## Phase 6 — Documentation & Polish (Day 8)

1. **Update ARCHITECTURE-TODO.md**
   - Remove "ALL PROBLEMS SOLVED" banner if any items from this plan remain
   - Add a "Verified" section with dates and commit hashes

2. **Align README with Reality**
   - Update provider count, tool count, widget count to match runtime verification
   - Remove or flag aspirational features (e.g., "fine-tunes its own models overnight") if not yet implemented
   - Add a "Current Status" badge that links to CI

3. **CONTRIBUTING.md**
   - Add the multi-agent workflow so other contributors know how to use the agent swarm
   - Document how to run a single specialist agent for focused work

4. **AGENTS.md / CLAUDE.md**
   - Update with the latest architecture decisions from Phase 2-3
   - Ensure context files load correctly (`/settings` or `.pi/settings.json`)

**Deliverable**: README is honest. Docs match code. New contributors can onboard in 5 minutes.

---

## Immediate Next Steps (What To Do Right Now)

1. `cd ~/Desktop/TitanBot/TITAN-main && npm install`
2. `npm run typecheck` → fix errors
3. `npm run build` → verify dist/ is created
4. `npm test` → capture the real pass/fail baseline
5. Open `src/agent/agentLoop.ts` and find the commented-out `checkAndProcessInbox` calls

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| npm install fails on native deps | Medium | Blocks everything | Use `--legacy-peer-deps` or Docker |
| Tests fail due to missing env vars | High | False negatives | Create `.env.local` from `.env.example` |
| Voice packages are completely separate | Medium | Integration complexity | Treat as microservices, compose them |
| Widget templates are missing/empty | Medium | README claim broken | Generate minimal templates or adjust claim |
| Agent loop stubs cause instability | Medium | Multi-agent crashes | Enable behind feature flag, test heavily |
| One person can't review all agent output | High | Bad code gets committed | Require human approval gate for `git push` |

---

## Success Criteria

TITAN is "100%" when:
- [ ] `npm test` passes (all 5 layers)
- [ ] `npm run build` produces a working `dist/`
- [ ] Docker image builds and runs
- [ ] Multi-agent heartbeat inbox is enabled and tested
- [ ] Every README claim is either ✅ working or 🚧 documented with a ticket
- [ ] At least 3 specialist agents run autonomously for 24 hours without crashing
- [ ] You can delegate a coding task to TITAN and it returns a working PR/patch

---

*Plan written: 2026-04-28*  
*Next review: After Phase 1 completion*
