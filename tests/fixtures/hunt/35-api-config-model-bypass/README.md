# Hunt Finding #35 — `/api/config` model field bypassed the #25 validator

**Date:** 2026-04-14
**Severity:** HIGH — a second path to the same "brick the config" bug that #25 fixed
**Discovered during:** Post-#25 follow-up audit of persistent-write endpoints

## Symptom

Finding #25 added input-shape + provider-registry validation to `/api/model/switch`. But TITAN has a SECOND endpoint that writes `agent.model` to config: `POST /api/config`. This endpoint accepts a full nested config object including a top-level `model` field which is then forwarded into `draft.agent.model`. The validation added to `/api/model/switch` did NOT apply to `/api/config`.

Reproduced pre-fix:

```
POST /api/config { "model": "evilprovider/bogus" }
→ 200 {"ok":true,"restartRequired":false,...}
→ persisted to ~/.titan/titan.json
```

Same "brick the config" outcome as #25, just via a different path. Zod validation inside `updateConfig()` only checks that the value is a string — which `"evilprovider/bogus"` trivially satisfies.

## Root cause

Two handlers, one shared field, one-sided validation. The `/api/model/switch` handler gained three layers of checks in #25 (shape, allowlist, provider-registry). `/api/config` had none — it trusted Zod to catch everything, and Zod's `z.string()` is happy with any string.

Pattern smell: whenever the same data gets written through two endpoints, they MUST share the same validator. Duplicating the checks in both is wrong; extracting to a helper and calling from both is right.

## Fix

Extracted the shape check into a shared helper `validateModelId(model: unknown): string | null` inside `startGateway()`. The helper is called from BOTH endpoints:

```ts
function validateModelId(model: unknown): string | null {
    if (typeof model !== 'string' || model.length === 0 || model.length > 200) {
        return 'model must be a non-empty string up to 200 chars';
    }
    if (!/^[a-zA-Z0-9._:\-/]+$/.test(model)) {
        return 'model contains invalid characters (allowed: alnum, ._:-/)';
    }
    return null;
}
```

### `/api/model/switch`

Refactored to call `validateModelId(model)` instead of inlining the shape check. No behavior change — same validation, just deduplicated.

### `/api/config`

Added the same validation to the `body.model` branch, PLUS the provider-registry check (mirroring #25):

```ts
if (body.model) {
    const modelShapeErr = validateModelId(body.model);
    if (modelShapeErr) {
        res.status(400).json({ error: `model: ${modelShapeErr}` });
        return;
    }
    const modelStr = body.model as string;
    const providerPrefix = modelStr.split('/')[0];
    if (providerPrefix && providerPrefix !== 'ollama') {
        const { getProvider } = await import('../providers/router.js');
        if (!getProvider(providerPrefix)) {
            res.status(400).json({
                error: `Unknown provider '${providerPrefix}'. Use /api/models to list available providers and models.`,
            });
            return;
        }
    }
    draft.agent.model = modelStr;
    changedFields.push('agent.model');
}
```

The handler signature also had to change from `(req, res) => {...}` to `async (req, res) => {...}` because of the `await import(...)`.

## Live verification

After deploying to Titan PC:

```
=== Current model (before) ===
ollama/minimax-m2.7:cloud

=== /api/config with bogus model (should reject) ===
{"error":"Unknown provider 'evilprovider'. Use /api/models to list available providers and models."}
HTTP 400

=== /api/config with model containing special chars (should reject) ===
{"error":"model: model contains invalid characters (allowed: alnum, ._:-/)"}
HTTP 400

=== /api/config with valid model (should accept) ===
{"ok":true,"restartRequired":false,"restartFields":[]}
HTTP 200

=== Model after (should still be minimax) ===
ollama/minimax-m2.7:cloud
```

All three test cases behave correctly. The valid-model path still works; invalid shapes and unknown providers are rejected before any config write.

## Regression test

Updated `tests/hunt-regression.test.ts`:

```ts
it('source code: /api/config validates model field via shared helper (Hunt #35)', () => {
    const src = readFileSync(..., 'utf-8');
    expect(src).toMatch(/function validateModelId\(model: unknown\)/);
    const cfgBlock = src.slice(cfgIdx, cfgIdx + 5000);
    expect(cfgBlock).toMatch(/validateModelId\(body\.model\)/);
    expect(cfgBlock).toMatch(/getProvider\(providerPrefix\)/);
});
```

Also updated the existing #25 test to verify the helper is being called (rather than expecting the inline regex that no longer exists after extraction).

## Files modified

- `src/gateway/server.ts` — new `validateModelId` helper; both endpoints call it; `/api/config` handler is now async
- `tests/hunt-regression.test.ts` — new #35 source-lint test, updated #25 test to match refactored code
- `tests/fixtures/hunt/35-api-config-model-bypass/README.md` — this doc

**5,292 tests pass.** Typecheck clean. Deployed.

## Class-level lesson

**Every endpoint that writes the same persistent field must share the same validator.** If you fix validation at one callsite but leave others un-updated, you've just moved the bug, not fixed it. When adding a validator for a value that might be written by multiple endpoints, extract it to a helper in step 1 of the fix, not step 3.

The post-#25 audit immediately found this bug because #25's recommendation was "every endpoint that writes to persistent config needs validation". That recommendation pointed straight at `/api/config` as the highest-impact unchecked write path. **Recommendations you write during a hunt should point at the next findings.**
