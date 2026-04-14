# Hunt Finding #23 — `system_info` renders cloud Ollama models as "(0 KB)"

**Date:** 2026-04-14
**Severity:** MEDIUM — users told TITAN claims models are corrupted when they aren't
**Discovered during:** Phase 3 remaining scenarios (ollama model listing)

## Symptom

User asked: *"List all ollama models installed on this machine."*

TITAN responded with a list that included "Issue detected: `glm-5.1:cloud` shows 0 KB — it may be corrupted or incomplete." and only mentioned 3 of 19 installed models.

The model wasn't hallucinating — the `system_info` tool's Ollama section was rendering every cloud-hosted model as `(0 KB)`, because `formatBytes(0)` produces the string `"0 KB"`. The LLM reasonably but incorrectly interpreted that as file corruption.

## Root cause

`src/skills/builtin/system_info.ts` rendered every model identically:

```ts
const models = (parsed.models || []).map((m: { name: string; size: number }) =>
    `  ${m.name} (${formatBytes(m.size)})`
);
```

Cloud-hosted Ollama models (names ending in `:cloud` or `-cloud`) have `size: 0` because they run on Ollama's remote infrastructure and have no local storage footprint. `formatBytes(0)` returns `"0 KB"`, which looks like a corrupt or empty file.

## Fix

Split Ollama output into Local vs Cloud sections with accurate labels:

```ts
const local: string[] = [];
const cloud: string[] = [];
for (const m of (parsed.models || [])) {
    const nameLooksCloud = /[-:]cloud(?::|$)/i.test(m.name);  // :cloud OR -cloud
    const sizeIsZero = !m.size || m.size === 0;
    const isCloud = nameLooksCloud || sizeIsZero;
    if (isCloud) {
        cloud.push(`  ${m.name} (cloud — no local storage)`);
    } else {
        local.push(`  ${m.name} (${formatBytes(m.size)})`);
    }
}
// Render:
//   ## Ollama Models
//   ### Local
//     gemma4:31b (18.5 GB)
//     ...
//   ### Cloud (remote, no local footprint)
//     minimax-m2.7:cloud (cloud — no local storage)
//     qwen3.5:397b-cloud (cloud — no local storage)
//     ...
```

The detection is broad:
- `:cloud` suffix (e.g. `minimax-m2.7:cloud`)
- `-cloud` inside a tag (e.g. `qwen3.5:397b-cloud`, `deepseek-v3.1:671b-cloud`)
- Null / missing / zero size (fallback for any other remote model shape)

## Live verification

After deploying:

```
## Ollama Models
### Local
  gemma4:31b (18.5 GB)
  aravhawk/qwen3.5-opus-4.6:27b (16.3 GB)
  nemotron-3-nano:latest (22.6 GB)
  nemotron-3-nano:4b (2.6 GB)
  titan-qwen3.5:4b (2.5 GB)
  titan-qwen:latest (18.5 GB)
  devstral-small-2:latest (14.1 GB)
  nomic-embed-text:latest (261.6 MB)
  qwen3:0.6b (498.4 MB)
  qwen3.5:35b (22.2 GB)
### Cloud (remote, no local footprint)
  glm-5.1:cloud (cloud — no local storage)
  qwen3-coder-next:cloud (cloud — no local storage)
  nemotron-3-super:cloud (cloud — no local storage)
  glm-5:cloud (cloud — no local storage)
  kimi-k2.5:cloud (cloud — no local storage)
  minimax-m2.7:cloud (cloud — no local storage)
  deepseek-v3.2:cloud (cloud — no local storage)
  qwen3.5:397b-cloud (cloud — no local storage)    ← hyphen variant caught
  minimax-m2:cloud (cloud — no local storage)
  glm-4.7:cloud (cloud — no local storage)
  deepseek-v3.1:671b-cloud (cloud — no local storage)
```

Model response after fix:
> "Ollama is installed and running. Here's what I found: **Installed Ollama Models:** gemma4:31b (18.5 GB), aravhawk/qwen3.5-opus-4.6:27b (16.3 GB), glm-5.1:cloud, plus several others. Status: Running."

No more "corrupted" claims.

## Regression test

`tests/hunt-regression.test.ts` — source-level lint that requires:
- `cloud — no local storage` label present in the source
- `### Cloud (remote, no local footprint)` section header
- `/[-:]cloud/` regex for the name detection
- `!m.size || m.size === 0` fallback for zero/missing size

## Files modified

- `src/skills/builtin/system_info.ts` — new split rendering logic
- `tests/hunt-regression.test.ts` — new lint test
- `tests/fixtures/hunt/23-ollama-cloud-rendering/` — this doc

## Class-level lesson

**Tool output shapes become LLM inputs** — a value that's technically correct (`size: 0` for a remote model) can still mislead the LLM into incorrect conclusions. When rendering tool output for model consumption, favor semantic labels ("cloud — no local storage") over raw numbers ("0 KB") when the number could be misinterpreted.
