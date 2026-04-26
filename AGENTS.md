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
