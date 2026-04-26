# TITAN PC Audit — 2026-04-20

> **⚠️ SUPERCEDED — See `AI_AGENT_SYNC.md` for current state.** This audit captured the TITAN PC as of April 20, 2026. Many blockers listed here (missing memory modules, approval-gated restart, version drift, specialist schema stripping, typecheck failures) have since been resolved. The live TITAN PC now runs v5.0.0 "Spacewalk" with HTTPS on port 48420.

This note captures the live TITAN PC state so Claude Code and future agents can continue from the same facts.

## Ground Rules

- TITAN is an autonomous framework. It should be truthful about what it is doing, self-aware where possible, self-healing where safe, and restart-safe.
- Claude Code may be used by Tony as a development assistant.
- TITAN itself must not use Claude Code at runtime.
- Do not re-add `claude-code` as a provider, adapter, specialist route, model fallback, or shell command.
- Do not push to GitHub or publish to npm until TITAN is functioning correctly and the release gates are clean.
- The live operational source of truth is `titan:/opt/TITAN`. Make runtime/code changes there first because TITAN is actively running from that checkout.

## Live Runtime

- Machine: `titan`
- Live repo: `/opt/TITAN`
- Service: `/etc/systemd/system/titan.service`
- Runtime command: `/usr/bin/node dist/cli/index.js gateway`
- Gateway: `https://127.0.0.1:48420`
- Service status observed: active/running
- Main process observed: `node dist/cli/index.js gateway`

Systemd service shape:

```ini
[Service]
User=dj
WorkingDirectory=/opt/TITAN
ExecStart=/usr/bin/node dist/cli/index.js gateway
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=TITAN_HOME=/home/dj/.titan
StandardOutput=append:/home/dj/titan.log
StandardError=append:/home/dj/titan.log
```

## What Works

- `npm run build` succeeds on the TITAN PC.
- Gateway starts and listens on port `48420`.
- API routes respond after login/auth.
- `Ollama` is reachable.
- `OpenRouter` is reachable.
- Messenger is active in the systemd environment because `FB_PAGE_ACCESS_TOKEN` and `FB_PAGE_ID` are injected there.
- Claude CLI runtime hooks were removed from executable paths.

API proof after login:

```text
/api/health status=200
/api/stats status=200
/api/skills status=200
/api/models status=200
```

Claude CLI runtime scan:

```text
Searched executable source/dist patterns:
- from .*/claudeCode
- claude-code/
- claude --
- ClaudeCodeProvider
- claudeCodeBudget
- providers.set('claude-code')

Result: no executable runtime matches after removal.
```

The only expected remaining code match is a test asserting the adapter is absent:

```text
tests/adapters.test.ts: expect(getAdapter('claude-code')).toBeNull()
```

## Current Build And Test State

Production build:

```text
npm run build
ESM Build success
```

Typecheck:

```text
npm run typecheck
Result: failing
```

Main typecheck failure categories:

- Missing memory modules.
- `driverAwareChat.ts` missing an `escalated` phase label.
- Twilio voice expected exports are missing.
- Top-level duplicate/stale files have invalid relative imports.
- Test-health and dependency-scan typing issues.

Full tests:

```text
npm run test -- --reporter=basic
Result: not clean
```

Observed failing areas:

- `tests/streaming.test.ts`
- `tests/gateway.test.ts`
- `tests/critical-bugfixes.test.ts`
- `tests/computer-use.test.ts`

Observed failure patterns:

```text
fetch failed
expected browser action success text to contain Error
Test timed out in 30000ms
Node heap pressure / out-of-memory during full suite
```

Targeted adapter tests:

```text
tests/adapters.test.ts: passed
tests/adapters-integration.test.ts: passed
27/27 adapter tests passed
```

## P0 Blockers

### Missing Self-Awareness Modules

The gateway references these modules:

```text
src/memory/identity.ts
src/memory/meta.ts
src/memory/workingMemory.ts
src/memory/experiments.ts
src/memory/provenance.ts
```

They do not exist in `/opt/TITAN/src/memory`.

Runtime logs confirm the gateway skips important self-awareness bootstraps:

```text
Identity bootstrap skipped: Cannot find module '/opt/TITAN/dist/memory/identity.js'
Self-model bootstrap skipped: Cannot find module '/opt/TITAN/dist/memory/meta.js'
Working-memory retire watcher skipped: Cannot find module '/opt/TITAN/dist/memory/workingMemory.js'
```

Impact:

- TITAN cannot reliably know its persistent identity.
- Agents do not get the intended self-model block.
- Working-memory retirement/self-repair hooks are missing.
- Goal proposal context that expects identity/experiments is incomplete.

### Twilio Voice Is Half-Wired

`src/gateway/server.ts` imports many Twilio voice helpers:

```text
twimlPlayAndGather
twimlPauseAndRedirect
twimlPlayAndHangup
twimlReject
twimlSayAndHangup
validateTwilioSignature
isAllowedCaller
synthesizeAndCache
readCachedAudio
getCallSession
setCallSession
endCall
createVoiceJob
getVoiceJob
completeVoiceJob
failVoiceJob
```

But `src/channels/twilio-voice.ts` is only a stub:

```ts
/** Stub: Twilio Voice Channel */
export class TwilioVoiceChannel implements Partial<ChannelAdapter> {
  name = 'twilio-voice';
  async start() { console.log('Twilio Voice not implemented'); }
  async stop() {}
  async send() {}
}
```

Impact:

- Gateway logs say Twilio endpoints are registered.
- Typecheck says the required exports are missing.
- This is a truthfulness gap: TITAN advertises a feature that is not fully implemented.

### No Approval-Gated Self-Restart

TITAN has Command Post approvals for:

- goal proposals
- Soma proposals
- self-repair
- self-mod PRs
- budget override
- hire agent

But no confirmed flow exists for:

```text
request_restart
→ create approval
→ approve
→ systemctl restart titan.service
→ audit/log trace
→ post-restart health check
```

This should be added because Tony explicitly wants TITAN to restart itself only when allowed or approved.

## P1 Blockers

### Version Drift

`package.json` reports:

```json
"version": "4.12.0"
```

`src/utils/constants.ts` reports:

```ts
export const TITAN_VERSION = '4.10.0';
```

Live API reports:

```text
/api/health -> "version":"4.10.0"
```

Doctor reports:

```text
Update available! 4.10.0 → 4.12.0
```

Impact:

- Diagnostics are misleading.
- Release state is unclear.
- Agents may reason from stale version facts.

### Config Schema Strips Specialist Overrides

Doctor warned:

```text
Config contains unknown top-level keys that will be stripped: specialists.
```

But `/home/dj/.titan/titan.json` contains specialist model overrides:

```json
"specialists": {
  "sage": {
    "model": "ollama/glm-5:cloud"
  }
}
```

Impact:

- Specialist identity/model config may be ignored or lost during config saves.
- This affects the self-aware specialist pool.

### Canary Regression

Recent log:

```text
Canary regressions detected: math_simple 99%→50%, code_snippet 99%→67%, persona_stable 98%→67%
```

Impact:

- TITAN's own quality monitor says behavior regressed.
- This should create a visible repair path or pending approval.

### Action Verification Is Catching Path Mistakes

Recent logs:

```text
AutoVerify write_file: File ~/titan-saas/lib/policies/curiosity-fallback.ts does not exist after write
AutoVerify write_file: File /opt/TITAN/titan-saas/lib/policies/curiosity-fallback.ts does not exist after write
```

Impact:

- The verification layer is useful.
- The agent still makes workspace/path mistakes and retries.
- Self-healing should learn from this instead of repeating it.

## P2 Cleanup

Likely stale duplicate files:

```text
src/server.ts
src/schema.ts
src/learning.ts
src/opusReview.ts
```

Backup files:

```text
src/gateway/server.ts.bak
src/safety/selfRepair.ts.bak
```

Large/fragile file:

```text
src/gateway/server.ts
```

It owns too many concerns and is a long-term refactor target.

## Desired End State

TITAN should be able to truthfully answer:

- who it is
- what version it is
- what models it is using
- which agents are active
- what goals/runs are in progress
- what failed recently
- what it is trying to repair
- whether it is allowed to restart
- what approval is needed before risky actions

TITAN should be able to self-heal safely:

- detect broken imports and missing modules
- create repair proposals
- stage changes
- request approval
- apply only after approval
- verify build/typecheck/tests where appropriate
- restart only through an approved flow
- log/audit every step

## Recommended Fix Order

1. Implement/restore missing self-awareness modules:
   - `src/memory/identity.ts`
   - `src/memory/meta.ts`
   - `src/memory/workingMemory.ts`
   - `src/memory/experiments.ts`
   - `src/memory/provenance.ts`

2. Add approval-gated restart:
   - Command Post approval type: `restart_titan`
   - CLI/API endpoint or tool request creates approval.
   - Approval handler runs `sudo systemctl restart titan.service`.
   - Health check verifies service after restart.
   - Audit event records requester, approver, timestamp, and outcome.

3. Fix typecheck:
   - Add missing modules.
   - Add `escalated` to `driverAwareChat` phase labels.
   - Either implement Twilio exports or disable/remove advertised Twilio route registration.
   - Move/delete duplicate top-level files or exclude them explicitly.

4. Stabilize full tests:
   - Fix gateway/streaming fetch tests.
   - Fix computer-use expectation drift.
   - Reduce Vitest heap pressure or split heavy suites.

5. Make version single-source:
   - Sync `package.json`, `src/utils/constants.ts`, tests, API, doctor, README.

6. Clean source tree:
   - Remove stale `.bak` files.
   - Remove or relocate invalid duplicate top-level files.
   - Document any local-only deployment files.

## Do Not Do Yet

- Do not push to GitHub.
- Do not publish to npm.
- Do not re-add Claude Code runtime integration.
- Do not reset `/opt/TITAN`; it has many live-only changes.
- Do not delete user-created dirty files without explicit approval.

## Work Log — 2026-04-20 Foundation Repair Chunk 1

Before:
- Runtime was active, but gateway boot logs skipped identity/self-model/working-memory because `memory/identity`, `memory/meta`, and `memory/workingMemory` did not exist.
- Typecheck failed on missing self-awareness modules, missing experiment/provenance modules, Twilio voice exports, version drift, and stale duplicate source files.
- Goal: repair missing local memory/self-awareness surfaces without reintroducing Claude Code runtime use.

Changed:
- Added local-only `src/memory/identity.ts`, `src/memory/experiments.ts`, `src/memory/provenance.ts`, `src/memory/workingMemory.ts`, and `src/memory/meta.ts`.
- Replaced the Twilio voice one-method stub with a truthful stub surface that exports the functions the gateway imports.
- Synced `TITAN_VERSION` in `src/utils/constants.ts` to `package.json` version.
- Excluded known stale duplicate root files from typecheck instead of letting dead copies poison the live build.

Current result:
- Targeted memory tests still need small fixes in identity cache behavior and experiment similarity scoring.
- Typecheck progressed past missing memory modules and now exposes the next layer: Twilio function shape, organism history shape, watch humanize export, test-health skill typings, and a few testing helper typings.

## Work Log — 2026-04-20 Foundation Repair Chunk 2

Before:
- Chunk 1 exposed interface mismatches after the missing memory files were restored.
- Identity tests failed because in-memory cache ignored test file resets and external identity edits.
- Experiment similarity was too strict for the ant-colony prior test.
- Twilio voice exports existed but did not yet match the gateways expected function signatures.

## Work Log — 2026-04-20 Foundation Repair Chunk 2

Before:
- Chunk 1 exposed interface mismatches after the missing memory files were restored.
- Identity tests failed because in-memory cache ignored test file resets and external identity edits.
- Experiment similarity was too strict for the ant-colony prior test.
- Twilio voice exports existed but did not yet match the gateway's expected function signatures.

Changed:
- Fixed identity loading so disk remains the source of truth and deleted/edited identity files are observed.
- Loosened experiment similarity with a bounded containment score while keeping Jaccard-style matching.
- Re-shaped Twilio voice helper exports around the gateway's expected job/session/audio contracts.
- Added organism history compatibility fields and a watch humanize() export.

After:
- Targeted tests passed: tests/memory/identity.test.ts, tests/memory/experiments.test.ts, tests/memory/provenance.test.ts, and tests/adapters.test.ts all green: 41 tests passed.
- Typecheck is reduced to smaller remaining seams: email optional import comment, organism optional satisfaction narrowing, watch spread type, dependency-scan call shape, test-health/test-repair skill typings, test_failure episode kind, and Vitest reporter API drift.

## Work Log — 2026-04-20 Foundation Repair Chunk 3

Before:
- Goal: make npm run typecheck clean without rewrites.
- Remaining errors are local typing/contract issues rather than missing core runtime modules.
- Any changes in this chunk should preserve runtime behavior and keep all execution paths truthful.

After:
- npm run typecheck is now clean on the live TITAN PC.
- The remaining fixes were contract-level repairs: removed stale optional-import ts-expect-error, corrected dependency-scan registration, added local type definitions for test-health/test-repair tools, added test_failure as a valid episodic kind, and aligned the Vitest reporter with the current reporter API enough for typecheck.

## Work Log — 2026-04-20 Foundation Repair Chunk 4

Before:
- Goal: build the production bundle and restart the live system so `/opt/TITAN/dist` matches the repaired source.
- Risk: TITAN is live under systemd, so restart must be deliberate and followed by health/log checks.

After:
- npm run build succeeded.
- titan.service restarted and is active.
- Identity bootstrap now loads successfully: log shows Identity loaded.
- Remaining runtime issue: self-model bootstrap skipped with records.filter is not a function, likely because an existing live memory JSON file uses an older object shape while the new loader expected an array.

## Work Log — 2026-04-20 Foundation Repair Chunk 5

Before:
- Goal: make the self-model boot resilient against older live JSON memory shapes.
- Fix should be backward-tolerant and local-only; it must not delete existing memory.

After:
- Compatibility loader fix passed npm run typecheck.
- Targeted tests passed again: 41 tests passed across identity, experiments, provenance, and adapters.
- npm run build succeeded.
- titan.service restarted and remained active.
- Boot log now shows Gateway v4.12.0, Identity loaded, Self-model provider installed, Gateway listening, Skills loaded, and Tools registered.
- The previous missing-module skips and self-model records.filter error are no longer present in the checked boot log slice.

## Work Log — 2026-04-20 Foundation Repair Chunk 6

Before:
- Goal: inspect the existing approval/governance shape for the smallest safe approval-gated TITAN restart path.
- Constraint: do not create an alternate uncontrolled restart path. Restart must be local/system-level, approval/audit aware, and documented before implementation.

After:
- Approval-gated restart support was added through Command Post custom approvals with payload kind titan_restart.
- The restart action only allows titan.service, writes Command Post activity, records an episodic note, and then uses systemd restart after the approval response is saved.
- npm run typecheck passed after this change.
- npm run build passed after this change.
- titan.service was manually restarted to load the new build and remained active.
- Boot proof after restart: Identity loaded, Self-model provider installed, Gateway listening.
- npm run doctor now reports TITAN Doctor v4.12.0 and 17 passed / 34 warnings / 2 failed.

Remaining doctor blockers:
- Channel messenger is enabled but no token is visible to the CLI doctor. The running systemd service has Messenger env vars, so this may be a doctor visibility issue rather than live runtime failure.
- Channel twilio is enabled but no token is visible to the CLI doctor. Twilio voice routes are registered, but the voice implementation is still truthful stub mode.

Release status:
- Do not push or publish yet.
- The live runtime is healthier than before, but TITAN is not yet 100% release-clean because doctor still has failures and the full test suite has not been made green.

## Work Log — 2026-04-20 Live Runtime Check

Before:
- Goal: verify TITAN is running correctly on the live TITAN PC after the foundation repairs.
- Checks planned: systemd status, recent boot logs, gateway health, version, self-awareness boot, and doctor summary.
- Secrets must not be printed.

After:
- systemd reports titan.service active/running from /opt/TITAN with ExecStart node dist/cli/index.js gateway.
- Recent boot logs show Gateway v4.12.0, Identity loaded, Self-model provider installed, Gateway listening, 139 skills loaded, and 246 tools registered.
- No missing-module boot errors were observed in the checked log slice.
- Authenticated API check passed using the real /api/login route: /api/health, /api/stats, /api/skills, /api/models, and /api/command-post/approvals?status=pending returned 200.
- Unauthenticated /api/health returned 401, which is expected with gateway auth enabled.
- Version is consistent: package.json and src/utils/constants.ts both report 4.12.0; /api/health also reports 4.12.0.
- npm run doctor still reports 17 passed / 34 warnings / 2 failed.

Current runtime verdict:
- TITAN is running and reachable.
- Core gateway, auth, API, identity, self-model, skills, and tools are functioning at the checked level.
- Not release-clean yet: doctor still fails messenger/twilio token checks, config still warns about unknown specialists key, canary regression warnings are present, and the full test suite still needs stabilization.

## Work Log — 2026-04-20 SOMA Runtime Investigation

Before:
- Tony reports SOMA is not running correctly.
- Goal: inspect live SOMA/organism state before changing code.
- Checks planned: config shape, recent SOMA/drive/organism logs, daemon/watch registration, tests around organism pressure/drives, and runtime wiring.
- Do not print secrets.

Findings:
- SOMA daemon watcher is running, but pressure fusion was behaviorally stuck.
- Logs showed driveTick firing every minute, then GoalProposer repeatedly reporting soma:curiosity had hit the daily proposal limit.
- Organism tests confirmed regressions: pressure tests failed because _resetPressureDampingForTests was missing, and safety drive ignored VRAM saturation / gateway telemetry error-rate signals.

Changed:
- Restored safety drive telemetry inputs: vramSaturation, telemetryErrorRate, telemetryTotalRequests.
- Restored safety descriptions for VRAM saturation and gateway error-rate risk.
- Added pressure damping/cooldown for dominant drives when proposal generation returns no actionable proposals or is rate-limited.
- Added _resetPressureDampingForTests for deterministic pressure tests.

After test proof:
- npm run typecheck passed.
- SOMA focused tests passed: tests/organism/drives.test.ts and tests/organism/pressure.test.ts, 29 tests passed.

Next:
- Build and restart titan.service so live SOMA uses the repaired pressure damping and safety telemetry logic.

After live SOMA reload:
- npm run build passed.
- titan.service restarted and remained active.
- SOMA daemon watcher is registered and running.
- The old per-minute soma:curiosity daily-limit spam stopped after the first post-restart tick, indicating pressure damping is active.
- /api/soma/state returned 200 with enabled=true.
- Current SOMA state: curiosity is the only dominant drive; total pressure is about 0.17; safety is healthy; social is healthy; hunger is satiated; purpose is satiated.
- /api/soma/history returned 200 with 1440 history entries.

Current SOMA verdict:
- SOMA is running again and no longer loops every minute on the same rate-limited proposal path.
- Remaining tuning: pressureThreshold is configured very low at 0.15, so curiosity pressure around 0.17 still crosses threshold. Damping prevents spam, but threshold/setpoint tuning should be reviewed next if Tony wants SOMA to be less eager.
