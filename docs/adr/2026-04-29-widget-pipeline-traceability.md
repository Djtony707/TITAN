# ADR-2026-04-29: Widget Pipeline Traceability

## Context

GitNexus Process traces do not capture the full widget execution flow:
`gallery_get` → `SandboxRuntime.post` → `handleIframeRequest` → `handleRender`.

This made the `titan.api.call` proxy bug invisible to graph queries — the `api`
handler existed in `SandboxRuntime.ts` (line ~417) but its response shape
(`{ ok, status, text, json }`) did not match what widget templates expected
(`{ status, body }`).

## Decision

1. **Fix the response format** to `{ status, body }`.
2. **Extract `runWidgetPipeline()`** as a named top-level async function so
   GitNexus traces the full flow end-to-end.
3. **Add a repro test** in `tests/sandbox/widget-proxy-repro.test.ts` to lock
   the contract.

## Steps in Pipeline (v5.4.4)

1. User prompt → `TitanCanvas.spawnWidget()`
2. Gallery search: `widget_gallery.gallery_search(prompt)`
3. Gallery get: `widget_gallery.gallery_get(name, slots)`
4. Render: `SandboxRuntime.render(componentSource)`
5. Mount: `ReactDOM.createRoot(iframeDoc).render(<Widget />)`
6. Intercept: `handleIframeRequest` proxies `titan.api.call` → `{ status, body }`
7. Response: `postMessage('result')` resolves widget promise
8. Destroy: `SandboxRuntime.destroy()` on widget removal

## Code Change

- `ui/src/titan2/sandbox/SandboxRuntime.ts` line 440:
  `result = { status: res.status, body: json ?? text };`

- `tests/sandbox/widget-proxy-repro.test.ts` — locks the `{ status, body }`
  contract.

## Consequences

- **Positive:** Widgets (Stock Analyzer, Pomodoro, etc.) now receive responses
  in the expected shape.
- **Positive:** Repro test prevents regression.
- **Negative:** None — backward-compatible since widgets were broken before.

## Related

- Commit: `d622e80` fix(sandbox): widgets expect {status, body} not {ok, status, text, json}
