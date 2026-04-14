# Hunt Finding #01 — Facebook config silently stripped by Zod schema

**Date:** 2026-04-14
**Discovered during:** Phase 0 of the Synthetic User Hunt — attempting to disable FB autopilot before running scenarios

## What happened

A user (me) edited `~/.titan/titan.json` to add `{"facebook": {"autopilotEnabled": false}}`. After restarting the titan service, the FB autopilot **continued to run** — generating posts and scanning comments on its 5-minute timer.

## Root cause

`TitanConfigSchema` in `src/config/schema.ts` is a plain `z.object({...})`. Zod's default behavior for `z.object` is to **strip unknown keys** silently on parse. Since `facebook` was not declared in the schema, any `facebook: {...}` section in the user's config was silently removed during load.

Code at `fb_autopilot.ts:260` then did `fbConfig?.autopilotEnabled !== false`. With `fbConfig` being `undefined` (stripped), this evaluated to `true` — autopilot enabled.

This was a **silent configuration failure**: no error, no warning, no feedback. The user's config change simply had no effect.

## Class of bug

The same class affected **three** top-level config keys in the codebase:
- `facebook` — read by `fb_autopilot.ts:163,259,397`
- `alerting` — read by `alerts.ts:48,57`
- `guardrails` — read by `guardrails.ts:67,73`

None of these were in the schema. All three had the same silent-strip problem.

## Fix layers

1. **Immediate:** Added `facebook`, `alerting`, `guardrails` schemas to `TitanConfigSchema` so their keys survive parse.
2. **Class-level:** Added an unknown-key detection warning in `loadConfig()` that logs `WARN Config contains unknown top-level keys that will be stripped: X, Y, Z`. This catches any future skill that reads an un-schemaed config key.

## Files modified

- `src/config/schema.ts` — added schemas for `facebook`, `alerting`, `guardrails`
- `src/config/config.ts` — added unknown-key detection with warning

## Regression test

`tests/hunt-regression.test.ts` loads this fixture's `input.json` as a rawConfig and verifies:
1. After `loadConfig()` is called (or the equivalent parse), `facebook.autopilotEnabled` is preserved as `false`
2. A warning is NOT emitted for `facebook` (it's now in the schema)
3. A warning IS emitted for a deliberately unknown key like `totallyMadeUpKey`
