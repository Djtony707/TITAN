# TITAN — Visionary Features V2 — 2026-05-07

> Pivot brief: V1 leaned on Tony's biography and produced demo-shaped features for viral clips. V2 targets the install→advocate flywheel: features that make a senior engineer at a YC AI-infra startup install TITAN, realize they can't go back, and tell three coworkers. Engineer-credible. Numbers, not vibes. Tied to TITAN's structural assets — multi-machine mesh, Soma drive history, persona-profile resolver, VRAM orchestrator, F5-TTS — not Tony's identity. The hook is the *shape of the abstraction*, not the artifact.

---

### 1. Drive-Aware Model Router

**The pitch:** "Your agent's reliability suddenly stopped degrading at 4pm? It's because TITAN noticed Safety drive crossed setpoint and re-routed your tool calls to a colder model."

**The engineer-credible problem:** Every agent framework's "model router" is a static decision tree (cost tier, function-call support, latency budget). None of them can answer the operator's real question: *why did my agent's pass-rate drop at 4pm yesterday?* Mastra/Vercel SDK route a request based on the request, not on the **operating state of the agent itself**. That's the gap: routing decisions don't see telemetry, so when a model degrades under load or budget pressure, the router keeps shoving requests at it.

**Why TITAN can ship this and they can't:** Soma drives already compute Safety from budget runway + recent error rate, every 60s. The 24h drive ring buffer + trajectoryLogger + provider router are all already wired. No competitor has a **homeostatic substrate underneath the router** — they'd have to build the drive layer first. TITAN inverts the pattern: the router consults `getDriveState().safety.satisfaction` *as a routing input*.

**The numbers:**
- Test-pass-rate improvement under degraded conditions: **+12-18% projected** (rerouting cloud→local Kimi when Anthropic 401-storms, vs. fallbackChain's reactive-only behavior — fallbackChain fires *after* the failure, this fires before).
- Mean-time-to-recovery from a provider incident: **~4min → <60s** (Safety drive picks up error-rate spike in one tick).
- Cost reduction during low-Purpose periods: **~30%** (when no priority-1 goals are active, drop to qwen-fast for tool-use; reuse existing model registry).

**MVP scope:**
- New `src/agent/driveAwareRouter.ts` — middleware between `agent.ts` and `providers/router.ts`. Reads `getCurrentDriveState()` + telemetryErrorRate.
- Three policies, declared in config: `safety_floor` (route to fallbackModel when Safety < 0.4), `cost_lid` (downgrade tier when Purpose < 0.3 for >10min), `curiosity_boost` (route to a stronger model when Curiosity is spiking and the user message is a hard question).
- New endpoint `GET /api/router/decisions?last=50` — returns the last N routing decisions with the drive snapshot that caused each one. **This is the killer artifact.** Engineers paste it in incident reviews.
- Reuse: `organism/drives.ts`, `providers/router.ts`, `agent/fallbackChain.ts`, `vram/orchestrator.ts` (downgrades that need a model swap go through the existing leaseManager).
- Mission Control panel: timeline of routing decisions overlaid on drive heatmap.

**The flywheel claim:** *"We're the only agent framework where the router has a feedback loop. Anthropic SDK picks a model. TITAN picks a model based on how the agent is feeling — and we have receipts."*

---

### 2. Trajectory Replay Test Harness

**The pitch:** "TITAN ships a `titan replay` command that reconstructs any production trajectory as a deterministic test fixture, including the drive state and the persona that was active. CI catches regressions in agent *behavior*, not just code."

**The engineer-credible problem:** Eval frameworks (Braintrust, Langsmith, Mastra eval) test agents against curated datasets. Nobody tests against **the trajectories your agent actually ran in production yesterday**. When a senior engineer ships a prompt change and silently breaks the live retry behavior on flaky tools, the eval suite misses it because the eval suite isn't real traffic. There's no `pytest tests/regression/` for agents.

**Why TITAN can ship this and they can't:** trajectoryLogger + persona-profile resolver + drive ring buffer + tool execution log are all already on disk. The full causal context of any production turn is reconstructable from `~/.titan/`. Mastra/Vercel persist nothing — there's no past trajectory to replay. This is purely *exposure of latent state*.

**The numbers:**
- Behavior-regression catch rate: prompt edits that break tool sequence get flagged in CI in **<2min** instead of "next time we run that workflow in prod."
- False-positive eval rate: deterministic replay (mocked tools, frozen drive snapshot) brings flakes to **near-zero** vs. live-eval flakes ~15-20%.
- Time to write a regression test: from "draft an eval scenario" (~30min per case) to **`titan replay --pin trajectory_id` (~5s)**.

**MVP scope:**
- New CLI `titan replay <trajectoryId>` — reads `getRecentTrajectories()`, hydrates drive snapshot from ring buffer at the timestamp, sets persona via `forceId`, replays the user message through the agent loop with tool calls **mocked from the trajectory's recorded responses**. Asserts the output matches.
- Snapshot format: extends existing trajectory schema with `driveSnapshot`, `personaId`, `modelTier`, recorded `toolCalls[].response`. Versioned.
- New gateway endpoint `POST /api/trajectories/:id/pin` — copies a trajectory + drive snapshot into `tests/regression/pinned/<slug>.json` and writes a vitest stub. One click in Mission Control = one new regression test.
- Reuse: `agent/trajectory.ts`, `organism/drives.ts` (snapshot reconstruction), `personaProfiles.ts`, existing vitest infra.
- v1 gates: only mockable trajectories pin (no live-network tools); a "pin this" button in trajectory log UI.

**The flywheel claim:** *"Production behavior is a regression test now. Click any turn in your trajectory log → it's a vitest case. Try doing that in Mastra."*

---

### 3. Persona A/B + Auto-Revert

**The pitch:** "Roll a new system prompt to 10% of customer traffic. If pass-rate drops or Safety drive crosses threshold for 30 min, TITAN reverts itself and posts the diff. Argo Rollouts for prompts."

**The engineer-credible problem:** Every agent shop has the same broken loop: edit prompt → deploy → hope someone notices if it gets worse → roll back manually three days later when a customer complains. There's no canary mechanism for prompts. Mastra/Vercel SDK don't ship one because they have no notion of *agent health* — they only know request status. **Datadog-shaped problem, not Twitter-shaped.**

**Why TITAN can ship this and they can't:** persona-profile resolver (just shipped v5.5.24) already keys behavior off channel/time/forceId — extend the resolver to key off a **deterministic hash of caller identity → cohort** and you have free per-tenant A/B. Soma drive metrics are the auto-revert signal. Nobody else has both.

**The numbers:**
- Bad-prompt blast radius: **10% × 30min** instead of "100% × N days until a human notices."
- Mean-time-to-revert: **<30 min, automatic** vs. typical 2-5 days manual.
- Revenue protection per bad ship: a single 24h customer-facing prompt regression on an enterprise tier (~$5K/day MRR per customer) → **multiply by N customers**. Replit's argument for $100K/yr writes itself.

**MVP scope:**
- Extend `personaProfiles.ts` with `cohort: { hashKey: 'tenantId'|'sessionId', percent: number, baseline: personaId, candidate: personaId }`.
- New `src/agent/personaRollout.ts` — computes pass-rate (existing eval harness) + Safety-drive trend per cohort over rolling 30min window. If candidate cohort < baseline by configurable margin OR Safety drops >0.2, auto-revert: flip `cohort.percent` to 0, log to audit trail.
- New endpoint `POST /api/personas/:id/canary` and `GET /api/personas/cohorts/health` returning per-cohort pass-rate, p50/p95 latency, drive deltas.
- Reuse: persona resolver, drives, evals (already on Phase E roadmap — *this is what makes evals visionary instead of table-stakes*), auditStore.
- Mission Control panel: side-by-side cohort cards with sparklines + a big red revert button (and an automated revert event log).

**The flywheel claim:** *"Promptops is shipping. We canary persona changes against Soma drives — bad prompts auto-revert in 30 min. Show me one other agent framework that does this."*

---

### 4. Mesh-Aware VRAM Lease Market

**The pitch:** "Your laptop needs 24GB to run Llama-70B for 90 seconds. Your other rig has it free. TITAN auto-leases the model on the remote box, streams tokens back over the mesh, and releases. Ray for hobbyists."

**The engineer-credible problem:** Heterogeneous-hardware orchestration is an enterprise-only category right now (Ray, Modal, RunPod). Senior engineers at AI-infra startups personally own multiple GPUs and use ~one of them at a time because nothing makes the mesh frictionless. Mastra/Vercel SDK are explicitly **single-machine**. Anthropic SDK doesn't even know GPUs exist. The gap is enormous, and nobody's filled it for the prosumer/homelab tier because nobody has both the **mesh transport** and the **VRAM orchestrator** in one runtime.

**Why TITAN can ship this and they can't:** mesh discovery (mDNS), HMAC-auth peer registry, per-peer model registry, and the VRAM orchestrator with leaseManager + autoSwap all already exist. The only missing piece is "cross-peer lease acquisition" — a 2-week build *because the substrate is done*.

**The numbers:**
- Cost to run a 70B model in your dev loop: **$0/hr** (your idle 5090 instead of $2-4/hr Together/RunPod).
- Cold-start latency for a model not loaded locally: **~6-15s** (mesh peer + warm Ollama) vs. **~30-90s** (cold cloud provider) vs. **fail** (single-machine framework).
- Effective VRAM available to a single agent: **sum of mesh peers** instead of `min(local)`. For Tony's setup, ~32GB → ~56GB.

**MVP scope:**
- New `src/vram/meshLease.ts` — `acquireMeshLease(modelId, estimatedMB, ttlMs)`. Polls mesh peers (existing `getPeers()`), filters by `peer.models.includes(modelId)` and free VRAM via a new `/api/vram/check` proxy. Lease record persisted at `~/.titan/leases.jsonl` (recoverable across restarts via `restartTracker.ts` pattern).
- New `src/providers/meshProxy.ts` — OpenAI-shaped provider that streams generation from a mesh peer's `/api/generate` endpoint over the existing HMAC-auth WebSocket transport.
- Lease scheduler: pick peer by `(free_vram >= needed) AND (load < 0.8) AND (rtt < 50ms)`, weighted lowest-load-first.
- Auto-release on idle (>60s no tokens) or explicit release. Heartbeat: lease holder pings peer every 10s; on miss, peer auto-releases.
- Mission Control: "Mesh VRAM" panel shows lease graph (which agent on which peer using which model), free VRAM per peer.
- Reuse: full `src/mesh/*`, `src/vram/orchestrator.ts`, `src/vram/leaseManager.ts`.

**The flywheel claim:** *"My laptop just borrowed 24GB of VRAM from my desktop and ran a 70B model for the duration of one tool call. Then it gave it back. Ray for the rest of us. 19 lines of yaml."*

---

### 5. Drive-Indexed Failure Forensics

**The pitch:** "Click any failed run. TITAN shows you what the agent's drives looked like in the 60 minutes before failure, what other agents were running, and which 3 historical failures had the most-similar drive trajectory. Datadog APM, but for agent state."

**The engineer-credible problem:** When an autonomous agent fails at 4pm on a Tuesday, you currently have a stack trace and maybe a tool log. You don't know: *was the system under budget pressure? Was there a tool-flake spike 20 min before? Did this same shape of failure happen last week?* This is the **operations problem** for autonomous agents that nobody's solving — Mastra/Anthropic SDK ship traces, not health histories. OTel + Langfuse give you spans; they don't give you **the agent's emotional state at the moment of failure**, which turns out to be the most predictive signal we have.

**Why TITAN can ship this and they can't:** Drive ring buffer (1440 ticks/24h) + trajectoryLogger + commandPost run history are all on disk. *Embedding the drive-state-at-failure as a vector* and doing nearest-neighbor lookup against historical failures is **5 days of work**. No competitor has the substrate.

**The numbers:**
- Mean-time-to-diagnose a flaky autonomous failure: from **20-60 min "look at logs"** to **<2 min** (similar-failure cluster surfaces the answer).
- Repeat-incident rate: **−40% projected** (operators see "this is the 4th time Safety crossed 0.3 right before a run failure" and fix the upstream cause).
- Onboarding time for new ops engineer: drive-shape clusters become **runbook anchors** ("Cluster #7 = Anthropic-rate-limit pattern; runbook: switch to Kimi").

**MVP scope:**
- New `src/organism/forensics.ts` — `embedDriveWindow(timestamp, windowMins=60)` returns a fixed-length vector (drives × time bins, normalized). Cheap, deterministic, no LLM.
- On every failed CPRun (existing event), persist `{runId, embedding, traceId, errorClass}` to `~/.titan/failure-embeddings.jsonl`.
- New endpoint `GET /api/forensics/:runId` — returns the 60-min drive snapshot + top-5 nearest historical failures (cosine sim on the embedding) + their resolutions if logged.
- Mission Control "Forensics" panel: 5-track drive heatmap centered on failure timestamp, similar-failure list with one-click jump.
- Reuse: drives, trajectoryLogger, commandPost, auditStore. **No new vector DB needed** — 1000 failures × 600-dim is 4MB on disk; brute-force cosine in Node is sub-ms.

**The flywheel claim:** *"Autonomous agents need APM. We shipped it. Every failure is grouped with its three closest historical siblings, indexed by drive shape. Try diagnosing 4am incidents without it once you've had it."*

---

### 6. Federated Failure Patterns (opt-in)

**The pitch:** "TITAN nodes opt-in to ship anonymized failure embeddings to a federated index. When your agent fails at 3am, you see 'this same drive-shape failure occurred on 14 other TITAN installs in the last 48h, here's the consensus root cause.' Network effects for agent reliability."

**The engineer-credible problem:** Right now every agent install is an island. Customer A's agent breaks Tuesday, customer B's breaks Wednesday with identical root cause, neither knows the other exists. The Anthropic SDK can't fix this — they'd need a multi-tenant telemetry plane and they don't have one. Mastra is single-machine. Sentry-style aggregate error telemetry is the obvious play and nobody has it for **agent runtime state** specifically because nobody else has *agent runtime state worth aggregating*.

**Why TITAN can ship this and they can't:** Failure embeddings (#5) are **already anonymized vectors** — no PII, no prompts, just drive shapes + error classes. PostHog telemetry pipe + bucketed system fingerprint are already shipping (v5.0). The federated index is `embedding + count + top-N error_class + top-N resolution_text` — no LLM, no data lake. **A Postgres + 200 lines of route code.**

**The numbers:**
- Time-to-known-issue lookup: **seconds** (vector NN) vs. **hours/days** (search GitHub issues, Discord, hope someone hit it).
- Adoption flywheel: every install that opts in makes the index more valuable, which makes opt-in more valuable. Classic network effect — and it's specific to TITAN's substrate, so no competitor can replicate without rebuilding the drive layer first.
- Concrete example: Kimi 401-storm pattern (already in Tony's CHANGELOG) hits 50 installs Tuesday → by Wednesday morning installs 51-N see "47 sibling installs hit this 36h ago, fix: swap model preset URL" the moment it triggers.

**MVP scope:**
- Opt-in `telemetry.federatedFailures: true` in config. **Off by default.** Document exactly what's transmitted: 600-dim vector, errorClass enum, TITAN version, anonymized fingerprint.
- New gateway-side service (small Cloudflare Worker + D1 vectors, or Supabase pgvector — 1 day) — receives embeddings, stores, serves NN queries.
- Client-side: on failure, if opted-in, query the index, surface results in Mission Control "Forensics" panel under a "Sibling failures" section.
- Resolution-text contribution: when an operator logs a fix in Mission Control, an opt-in toggle attaches the (sanitized) one-line fix to that embedding cluster.
- Hard privacy gate: never transmit prompts, tool call content, secrets, hostnames. Embeddings are mathematically just shape — they cannot reconstruct text.
- Reuse: PostHog plumbing, telemetry plumbing, forensics module from #5.

**The flywheel claim:** *"Sentry was a 9-figure outcome because dev errors get more valuable when they're aggregated. We're doing it for agent drive-state failures. Day 1 it's interesting. Day 90 it's the only reason you can sleep."*

---

### 7. Stateful Fork & 3-Way Merge for Agents

**The pitch:** "git for agents. Snapshot your agent's full state — drives, goals, knowledge, persona, recent context — fork it to a new port, run an experiment for 6 hours, then 3-way merge what it learned back into main. The framework where agents have branches."

**The engineer-credible problem:** Right now if you want to test "what would my agent do differently if I gave it a new tool / different persona / different model" you destructively edit your single agent and live with it. There's no `git checkout -b experiment`. Mastra/Vercel SDK have no persistent agent state to fork *from*. This is the abstraction every framework will eventually need and nobody has.

**Why TITAN can ship this and they can't:** Drive state, goals.json, knowledge.json, trajectoryLogger, persona profiles, command-post run history — **all on disk, all in `~/.titan/`**. `conflictResolver.ts` already exists and does 3-way merge for goals/knowledge. Spawning a second gateway on a different port is an existing test pattern. The full machinery is there; it just needs an exposed API.

**The numbers:**
- Time to test "what if agent had access to tool X": **5 min** (`titan fork --add-tool X`) instead of "edit config, restart, lose context, hope the experiment is interpretable."
- Failed-experiment rollback cost: **0** (fork lives in its own `TITAN_HOME`, just delete the directory).
- Ability to run two agents in parallel for paired-experiment evals (same starting context, different prompt): **first-class** vs. impossible-without-this-feature.

**MVP scope:**
- New `src/agent/timeMachine.ts` — `createSnapshot()` zips drive-state, goals, knowledge, persona config, last-N trajectories, command-post DB to `~/.titan/snapshots/<id>.tgz`.
- `forkFrom(snapshotId, port, overrides)` — spawns a child gateway process with `TITAN_HOME=~/.titan/forks/<id>`, applies overrides (e.g., add a persona, swap model), runs independently.
- `mergeFork(forkId, strategy='goals'|'knowledge'|'both')` — runs existing `conflictResolver.ts` 3-way merge against current main state.
- Fork TTL: 24h auto-cleanup unless promoted; capped at 5 concurrent forks (prevent fork bombs).
- Reuse: conflictResolver, restartTracker pattern, existing CLI infra.
- Endpoint: `POST /api/forks` / `GET /api/forks` / `POST /api/forks/:id/merge`.

**The flywheel claim:** *"My agent has branches. I forked it Monday with a new tool, ran it on real traffic for 24h, and just merged its learned knowledge back. git but for agent state. The first framework where this is a one-liner."*

---

## Top 2 picks (V2)

**#3 Persona A/B + Auto-Revert** is the strongest answer to the lock criterion. *Would Replit pay $100K/yr for this?* Yes — bad-prompt regressions on enterprise customer traffic cost real revenue, and the auto-revert + audit trail solves a problem their on-call team currently manages with Slack threads and dread. It also leverages persona-profiles (just shipped, so the foundation is real) and turns the eval framework on Phase E roadmap from table-stakes into a genuine moat. Senior engineers will retweet it; CTOs will line-item it.

**#4 Mesh-Aware VRAM Lease Market** is the strongest *shape-of-the-abstraction* claim — "I borrowed 24GB from my other machine for the duration of one tool call" is a sentence that doesn't exist in any other framework's vocabulary. Ship it and TITAN occupies a unique position: the only agent framework whose **structural advantage is that you can run more than one machine**. It also has the lowest-vapor MVP because every substrate piece (mesh transport, VRAM orchestrator, lease manager, model registry) is already shipping. 1-2 weeks; everyone with a homelab installs it day-1.

Honorable mention: **#5 Drive-Indexed Failure Forensics** is the lowest-cost ship and the hook with the longest tail — once an operator has used "show me sibling failures" they can't operate without it. Pair it with #6 (federated index) once the local version is mature and you have a Sentry-shaped business.
