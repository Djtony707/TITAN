# TITAN Agent Context

## Current Focus: v5.0.0 "Spacewalk" — STAGED FOR RELEASE

**Status (2026-04-25):** v5.0.0 commit + tag staged locally on Mac. Awaiting
push from Titan PC to GitHub + `npm publish --tag next`.

- Local HEAD: `bf57cf7c v5.0.0 — Spacewalk: full release`
- Tag: `v5.0.0`
- Stats: 450 files, +69,846 / −18,147 lines
- 11 commits ahead of `origin/main` (origin still at `1c04ca71 v4.13.0`)

See `docs/HANDOFF-2026-04-25.md` for the full release report.

### Headline features in v5.0

1. **Widget gallery** — 110 production templates + gallery-first chat agent.
   Skill `widget_gallery` exposes `gallery_search` / `gallery_get` /
   `gallery_list`. Canvas chat ALWAYS calls `gallery_search` first.
2. **Self-awareness layer** — companyPortability, conflictResolver,
   peerAdvise, runContinuations, subdirHints, trajectory.
3. **Multi-agent system prompt threading** — `systemPromptAppendix` carries
   live canvas context (URL, space, widgets, wall-clock) every turn.
4. **Observability** — PostHog telemetry with bucketed system fingerprint,
   `/api/bug-reports` endpoints, `~/.titan/bug-reports.jsonl` capture.
5. **F5-TTS voice** replaces Orpheus.
6. **Agent-bus IPC** — Claude Code ↔ Kimi CLI live co-working.

### Release commands (run on Titan PC, NOT this Mac)

```bash
ssh titan
cd ~/titan-publish    # fresh clone, not /opt/TITAN
git fetch --tags && git checkout v5.0.0
npm install && npm run build && npm run build:ui
git push origin main
git push origin v5.0.0
npm publish --tag next   # @next first per CHANGELOG; promote to @latest after 1 wk
```

If the v5.0 commit isn't on Titan PC yet, rsync from Mac first (excluding
`node_modules`, `dist`, `ui/dist`, `server/`, `space-app/`, `space-pages/`,
`packages/`).

### Excluded from the v5.0 commit (intentional)

- `server/` — separate Node project
- `space-app/`, `space-pages/`, `packages/` — earlier experiments
- `pnpm-workspace.yaml` — TITAN doesn't use pnpm
- `babel.standalone.min.js`, `debug_template.cjs`, `find_escapes.cjs` — scratch

---

## Co-Working Setup (Claude Code + Kimi CLI)

Both agents collaborate via `~/.local/bin/agent-bus`. Standing rules:

1. **At turn start:** `agent-bus read`
2. **Before editing TITAN files:** `agent-bus claim <path>` (TTL-based)
3. **After meaningful work:** `agent-bus send <other> "<status>"`
4. **Always explain WHY** — every fix announcement to the other agent must
   include the reasoning (WHAT / WHY this approach over alternatives /
   TRADE-OFF / FOLLOW-UP).
5. **Always have the other agent double-check** — Tony's standing rule:
   after Claude makes a fix, Kimi reviews before deploy. Vice versa when
   Kimi authors.
6. **End-of-session formal log** → `docs/HANDOFF-YYYY-MM-DD.md`.

Kimi runs Kimi K2.6 with effectively unlimited capacity for Tony, so heavy
bulk work (template authoring, exhaustive sweeps, big code searches) goes
to Kimi. Architecture/design judgment, cross-system reasoning, and code
review stay on Claude.

---

## Architecture Quick Reference

The TITAN Canvas (`/command` route) renders LLM-generated widgets as
draggable grid items. Each widget runs in a sandboxed `iframe` with
`sandbox="allow-scripts"`. The iframe loads React 18 UMD + ReactDOM 18 UMD
+ Babel standalone from local `/` paths and renders the component via
`render(<X/>)`.

**Server-side:**
- Serves static files: `/react.development.js`, `/react-dom.development.js`,
  `/babel.min.js` (self-hosted)
- CSP header includes `'unsafe-eval'` for `srcdoc` iframe compatibility
- `POST /api/message` accepts `systemPromptAppendix` for per-turn context

**Parent window (`TitanCanvas.tsx`):**
- Renders `react-grid-layout` with system widgets and sandboxed widgets
- `GridWidgetRaw` creates one `SandboxRuntime` per widget
- Passes `(format, source)` to sandbox via `postMessage`

**Iframe sandbox (`SandboxRuntime.ts`):**
- Uses `srcdoc` (NOT blob URL) to inject HTML directly
- CSP meta tag: `script-src 'self' 'unsafe-inline' 'unsafe-eval'`
- `window.eval` disabled; `window.Function` wrapped to block dynamic imports
- `handleRender`: strips exports → Babel JSX transform (classic runtime) →
  `new Function()` → returns component → `ReactDOM.createRoot().render()`
- `handleExecute`: `AsyncFunction` with forbidden globals shadowed
- Bidirectional postMessage protocol with numeric IDs

**Widget gallery loader (`src/skills/builtin/widget_gallery.ts`):**
- Loads `assets/widget-templates/**/*.json` at startup
- Primary path: `dist/skills/builtin/../../../assets/widget-templates`
- Fallback path: `process.cwd()/assets/widget-templates` (defensive for bundles)
- Templates have inline `REPLACE_WITH_X` or `{{X}}` placeholders; the
  `gallery_get` tool fills them with backslash + single-quote + backtick
  escaping.

---

## Testing Conventions

File-location rules — keep these consistent or `agent-live claim-safe` will scream at you.

| Test type | Location | Purpose | Speed |
|---|---|---|---|
| Pure-function unit | `tests/unit/*.test.ts` | Regex, classifiers, gate extraction, token math, secret scanner. Zero LLM calls, zero I/O. | < 1 ms each |
| Mock LLM provider | `tests/__mocks__/MockOllamaProvider.ts` + `tests/__mocks__/*.test.ts` | Replay/record harness for tape fixtures. | < 1 ms each |
| Tape fixtures | `tests/fixtures/tapes/<name>.json` | Recorded LLM responses for deterministic replay. Schema: `{ name, model, recorded_at, titan_version, exchanges: [{ request?, response }] }`. **Response side is what playback uses; request side is cosmetic for human reviewers.** | n/a |
| Trajectory eval | `tests/eval/trajectory.test.ts` | Asserts `expectedToolSequence` end-to-end through `MockOllamaProvider`. Catches "called the wrong tool first" / "hallucinated extras" / "forgot a step". | < 250 ms / suite |
| Cross-model parity | `tests/eval/parity.test.ts` | Replays the same scenario across multiple provider tapes; reports behavioural divergence (tool, args, finish reason, content presence). | < 1 s |
| Live eval harness | `src/eval/harness.ts` (cases) → `/api/eval/run` (runner) | 11 suites of behavioural tests against the running agent. CI gate at 80 % per suite. | 5–15 min |
| Auto-recorded tapes | `tests/fixtures/tapes/auto/*.json` (Phase 6) | Production traces that failed eval get recorded here for replay. 30-day retention by default. | n/a |

### Naming

- Files: `descriptive_name.test.ts` (kebab-case for multi-word, `.test.ts` suffix). Match the function/module under test where possible (`isDangerous` → `isDangerous.test.ts`).
- Tape fixtures: `<scenario>_<variant>.json` (e.g. `weather.json`, `safety_refusal.json`, `memory_stale_context.json`). Lowercase, underscore-separated.
- Eval suites: `*_SUITE` exported `const EvalCase[]` arrays in `src/eval/harness.ts`. Suite names in `/api/eval/run` body are kebab-case (`tool-routing-v2`, `gate-format-v2`).

### Adding a new test

1. **Unit test** — `tests/unit/my_func.test.ts`, run `npm test`.
2. **Tape** — `TITAN_RECORD_TAPE=my_scenario npm test -- tests/eval/trajectory.test.ts` against a real model, then commit the JSON in `tests/fixtures/tapes/`.
3. **Eval case** — edit the relevant `*_SUITE` in `src/eval/harness.ts`. Verify with `npm run test:eval -- --suite <name>`.
4. **Parity scenario** — record the same scenario as a tape per provider, then add a case to `tests/eval/parity.test.ts` calling `compareProviderBehavior`.

### CI gate

Push to `main` or open a PR triggers `.github/workflows/eval-gate.yml`. It boots the gateway, hits each of the 11 suites, and fails the job if any suite is below 80 % pass rate. Results upload as artifacts retained for 30 days.

---

## Open Items / Known Gaps

| Item | Severity | Notes |
|---|---|---|
| `titan.api.call` proxy bug in canvas widgets | medium | Stock Analyzer "Analyze" button returns "No response." Backend works via curl. Investigate after v5.0 ships. |
| Pomodoro UI generation 90s+ hang | medium | Direct curl 33s. SSE timing suspected. Non-blocking. |
| Vitest worker OOM on full suite | low | Tests pass individually; flake on full run. |
| Mini PC cannot build Tailwind 4 | infrastructural | Always build `ui/dist/` on Mac or Titan PC, never Mini PC. |

---

## v4.x Audit (preserved from prior session)

Self-awareness modules **restored and wired** in v5.0:
- identity + self-model inject into system prompt
- experiments feed `goalProposer`
- `workingMemory` tracks session state
- `provenance` tags episodic/graph writes

Telemetry/analytics system **implemented** (PostHog Cloud + local collector).

Approval-gated self-restart flow **implemented** (`POST /api/system/request-restart`).

`package.json` synced to 5.0.0 (was out of sync with `src/utils/constants.ts`).

Stale top-level files (`src/server.ts`, `src/schema.ts`, etc.) cleaned.

Persona token bloat fixed: `src/personas/manager.ts::getActivePersonaContent`
caps at 4 KB with section-aware truncation. Override via `TITAN_PERSONA_CAP`
env. Full content available via `get_persona` tool.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **TITAN** (29559 symbols, 50352 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/TITAN/context` | Codebase overview, check index freshness |
| `gitnexus://repo/TITAN/clusters` | All functional areas |
| `gitnexus://repo/TITAN/processes` | All execution flows |
| `gitnexus://repo/TITAN/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
