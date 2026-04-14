# Hunt Finding #25 — `/api/model/switch` accepts any string, bricks config

**Date:** 2026-04-14
**Severity:** HIGH — authenticated bad request persistently breaks the gateway model config
**Discovered during:** Phase 4 Mission Control API surface test

## Symptom

Stale `CLAUDE.md` documentation referenced `/api/wakeup` (404) — a follow-up
survey of API write paths turned up the real bug: `/api/model/switch` accepted
any arbitrary string as the active model.

```
POST /api/model/switch
{ "model": "notaprovider/notamodel-xyz123" }
→ 200 {"success":true,"model":"notaprovider/notamodel-xyz123"}
```

The switch:
1. Wrote the bogus value to `agent.model` in `~/.titan/titan.json`
2. Persisted across gateway restarts
3. Caused every subsequent chat request to fail with "Unknown provider"
4. Required manual JSON editing on disk to recover

## Root cause

`src/gateway/server.ts` — the switch handler validated Ollama models via the
local `/api/show` endpoint, but any OTHER provider prefix fell into a bare
`else if (providerName)` branch that just logged and accepted:

```ts
// BEFORE
if (providerName === 'ollama') {
    // ...check ollama...
} else if (providerName) {
    // 2. Other providers — just log the provider (allow the switch)
    // We trust the user to configure API keys; reject only happens at chat time
    logger.info(COMPONENT, `[ModelSwitch] Switching to provider '${providerName.toLowerCase()}' model '${modelName}'`);
}
// No check at all — falls through and writes to config.
updateConfig({ agent: { ...cfg.agent, model: resolved } });
```

A comment explicitly acknowledged the gap ("reject only happens at chat time")
but the next chat's failure is already too late — by then the bad value is
persisted to disk.

There was also no input-shape validation: no length cap, no character allowlist.
A 10 MB string or a shell-injection-looking value would be written verbatim.

## Fix

`src/gateway/server.ts` — three-layer validation before any config write:

```ts
// 1. Input shape: length cap
if (typeof model !== 'string' || model.length === 0 || model.length > 200) {
    res.status(400).json({ error: 'model must be a non-empty string up to 200 chars' });
    return;
}
// 2. Input shape: character allowlist
if (!/^[a-zA-Z0-9._:\-/]+$/.test(model)) {
    res.status(400).json({ error: 'model contains invalid characters (allowed: alnum, ._:-/)' });
    return;
}

// ...after resolving aliases and splitting provider/model...

// 3. Provider registration check
if (providerName && providerName !== 'ollama') {
    const { getProvider } = await import('../providers/router.js');
    if (!getProvider(providerName)) {
        logger.warn(COMPONENT, `[ModelSwitch] Unknown provider '${providerName}' — rejecting`);
        res.status(400).json({
            error: `Unknown provider '${providerName}'. Use /api/models to list available providers and models.`,
        });
        return;
    }
}
```

`getProvider` queries the router's registered provider map — the same map that
powers `/api/models`. If a provider isn't in the router, no chat can ever
succeed with it, so the switch must be rejected.

## Live verification

After deploying:

```
Test 1: bogus model name (should REJECT)
  → {"error":"Unknown provider 'notaprovider'. Use /api/models to list available providers and models."}

Test 2: invalid chars (drop table attempt) (should REJECT)
  → {"error":"model contains invalid characters (allowed: alnum, ._:-/)"}

Test 3: oversized model (250 chars) (should REJECT)
  → {"error":"model must be a non-empty string up to 200 chars"}

Test 4: valid model (should ACCEPT)
  → {"success":true,"model":"ollama/minimax-m2.7:cloud"}

Config after tests: agent.model = ollama/minimax-m2.7:cloud (unchanged)
```

All four test cases behave correctly. The valid model path still works; the
three invalid shapes are rejected before reaching `updateConfig()`.

## Recovery from the bad test

The initial reproduction actually corrupted the live config on Titan PC. I
reverted by patching `~/.titan/titan.json` on disk directly and restarting
the gateway process, then applied the fix.

## Regression test

`tests/hunt-regression.test.ts` — source-level lint:

```ts
// Must validate input shape
expect(block).toMatch(/model\.length === 0 \|\| model\.length > 200/);
expect(block).toMatch(/\[a-zA-Z0-9\._:\\-\/\]/);
// Must validate provider registration
expect(block).toMatch(/getProvider\(providerName\)/);
expect(block).toMatch(/Unknown provider/);
```

## Files modified

- `src/gateway/server.ts` — 3-layer validation in `/api/model/switch`
- `tests/hunt-regression.test.ts` — new lint test
- `tests/fixtures/hunt/25-model-switch-validation/` — this doc

## Class-level lesson

**Persistent write endpoints need validation at the HTTP layer, not at
consumption time.** The old "reject only happens at chat time" comment was a
red flag: any endpoint that writes to a persistent config file MUST validate
all inputs before the write, because by the time the bad value is read back,
the caller is long gone and only a human editing JSON can recover.

Every write endpoint should answer three questions before accepting the
payload:
1. Shape: length, types, allowed characters
2. Semantics: does this value make sense for this field?
3. Cross-reference: if this value references a registry (providers, skills,
   models, channels), does the target actually exist?

All three were missing on `/api/model/switch`. The fix adds all three.
