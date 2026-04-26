# TITAN — v4.13 Status

Last updated: **2026-04-20 08:15 PDT**.

## 🟢 Service health — all green

| Metric | Value |
|---|---|
| Service | `active`, 171 MB resident |
| Errors since latest restart (08:14:16) | **0** (non-mesh) |
| Mesh retry storm | **0** (Mini PC peer removed from `mesh.staticPeers`) |
| OpenRouter leaks | **0** |
| `gemma4:cloud` 404s | **0** (config → `gemma4:31b-cloud`) |
| Default chat test | 1.9s on `ollama/qwen3.5:cloud` ✓ |

## ✅ All 3 blockers cleared

### 1. Stuck delegating drivers → **cancelled**

All 5 zombie drivers (2879837d, 532886ef, 58253c83, a2db49aa, f8277560)
cancelled via `POST /api/drivers/<id>/cancel`. Clean slate.

### 2. Failed-phase state files → **archived**

21 terminal state files moved to
`/home/dj/.titan/driver-state-archive/`. Driver-state dir now holds
only live drivers: **1 blocked, 7 delegating, 5 done**.

### 3. Mesh Mini PC peer → **removed**

`mesh.staticPeers` emptied in `~/.titan/titan.json`. 854+ reconnect
storm → 0 retries since restart. Mini PC can be re-added when it's
brought back online.

## Model lineup (current config)

| Role | Model | Why |
|---|---|---|
| agent.model (default) | `ollama/qwen3.5:cloud` | **Swapped from `gemini-3-flash-preview:cloud`** (see Known Issue A). 1.9s response time. |
| scout | `ollama/kimi-k2.5:cloud` | Long-context research + tools + thinking |
| builder | `ollama/qwen3-coder-next:cloud` | Code specialist |
| writer | `ollama/gemma4:31b-cloud` | Google comms quality, correct cloud tag |
| analyst | `ollama/qwen3.5:397b-cloud` | Frontier 397B for deep analysis |
| sage | `ollama/glm-5:cloud` | Critic/reviewer |

All routing to user's Ollama Max plan. `providers.ollama.cloudBypass: false`.

## ⚠️ Known issues (non-blocking)

### A. `gemini-3-flash-preview:cloud` rejects valid messages

Pulled out of the default agent slot because Ollama's Gemini proxy
kept returning:

```
HTTP 400: GenerateContentRequest.contents[N].parts[0].function_response.name: Name cannot be empty
```

Even after hardening the outbound serializer
(`src/providers/ollama.ts`) to stamp non-empty names on every
`tool_call` and `tool`-role message. The fix IS in the deployed
bundle (`grep "unknown_tool" /opt/TITAN/dist/gateway/server.js`
returns the expected line), but Gemini's proxy still rejects some
requests. Likely root cause: a message shape we're not accounting
for — possibly `tool_call_id` pairing, or a non-tool message with an
empty name field. Needs a request-body dump + replay to diagnose.

**Current workaround**: use `qwen3.5:cloud` as default. The gemini
model still works for explicit specialist calls that don't have
multi-turn tool_call history.

**Suggested next step**: add a `dumpRequestBody` debug flag to the
Ollama provider, catch one failing request, diff the constructed
body against Gemini's spec.

### B. 7 `delegating` + 1 `blocked` driver — normal working state

These are fresh drivers started after the restart. None stuck (all
have fresh attempts). The `blocked` one needs a human approval
decision from the Mission Control approvals queue. Not a bug.

### C. Unpushed commits

**9 commits stacked on `main`**:

```
[most recent first]
a8475136  fallbackChain: correct Ollama cloud tags (gemma4:31b-cloud)
4859e7c0  ollama: harden Gemini tool_calls name guard + drop gemma4:cloud
a81b1501  fallbackChain: prefer Ollama cloud over hardcoded OpenRouter
804dae77  router: CloudBypass to OpenRouter now opt-in (default off)
9313ee64  structuredSpawn: reformat pass using Ollama format: json_schema
0e40be14  goalDriver: escalated phase + thinking-pattern detection + oscillation fix
783f8743  safety: kill switch writes to audit log on fire + resume
fcb64dbf  dx: delete orphan layout dir + SetupWizard success + CLAUDE.md sync
(+ new config changes on Titan PC: agent.model, specialists.overrides, mesh.staticPeers, cloudBypass)
```

None pushed per user request ("don't push until we fix all issues").

**Recommendation when Tony's back**: tag `v4.13.0`, push `main` +
tag, `npm publish --tag latest` from fresh clone on Titan PC. Leave
Issue A (gemini-3-flash-preview) for a dedicated debugging session.
Not a release blocker since the model is optional.

## Watching for regressions

- Any new `ERROR [Router]` (non-mesh)
- Driver phase going to `escalated` (first live test of that code path)
- Driver stuck >30 min in `delegating` with `attempts ≥ 5`
- `/api/message` latency > 10s
- Memory climb past 500 MB
