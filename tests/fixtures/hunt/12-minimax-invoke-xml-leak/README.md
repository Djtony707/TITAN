# Hunt Finding #12 — Bare `<invoke>`/`<parameter>` XML tags leaked through sanitizer

**Date:** 2026-04-14
**Severity:** MEDIUM — affects minimax model users, occasional
**Discovered during:** Phase 2 retest of system prompt leak (#11)

## Symptom

A response from minimax-m2.7 contained raw XML:

```
The path `/minimax-m2.7` is outside the allowed directory. Let me write to `/tmp/minimax-m2.7` instead.
<minimax:tool_call>
<invoke name="write_file">
<parameter name="content">TITAN v2.7</parameter>
<parameter name="path">/tmp/minimax-m2.7</parameter>
</invoke>
</minimax:tool_call>
```

Or sometimes WITHOUT the outer wrapper:

```
The answer is:
<invoke name="shell"><parameter name="cmd">ls</parameter></invoke>
```

Both shapes were reaching the user — the sanitizer stripped `<minimax:tool_call>` when wrapped but not the inner `<invoke>`/`<parameter>` tags alone.

## Root cause

The existing sanitizer had:
```ts
cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
```

This required BOTH the opening AND closing `<minimax:tool_call>` tags. When minimax emitted tool call XML without the outer wrapper (just `<invoke>...</invoke>`) or with a missing closing tag, the regex didn't match and the XML passed through.

## Fix

Added additional sanitizer passes:

```ts
// Strip bare <invoke> / <parameter> XML tags (with or without closing)
cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*?<\/invoke>/g, '').trim();
cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*$/g, '').trim();
cleaned = cleaned.replace(/<parameter\s+name=["'][^"']*["']>[\s\S]*?<\/parameter>/g, '').trim();
cleaned = cleaned.replace(/<\/?(?:invoke|parameter|minimax:tool_call)[^>]*>/g, '').trim();
```

Also added new patterns to INSTRUCTION_LEAK_PATTERNS so `<invoke name="...">` and `<parameter name="...">` are detected and blocked as tool-call artifacts:
```ts
/<invoke\s+name=["']/,
/<parameter\s+name=["']/,
```

The stripping pass runs before the leak-pattern check, so clean surrounding content survives if the XML is successfully removed. Falls back to blocking if the content becomes empty or still matches other patterns.

## Files modified

- `src/utils/outboundSanitizer.ts` — added invoke/parameter stripping + detection patterns

## Regression test

`tests/outboundSanitizer.test.ts` now has 3 new cases:
1. Bare `<invoke>` XML without minimax wrapper → stripped
2. Closed minimax XML with multiline content → stripped
3. Detection via `isSafeToPost` (fails fast)

All 80 tests pass.
