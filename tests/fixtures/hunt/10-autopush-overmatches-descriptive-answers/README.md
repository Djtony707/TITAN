# Hunt Finding #10 — AutoPush regex rejected valid descriptive answers

**Date:** 2026-04-14
**Severity:** HIGH — affects every descriptive/educational question in autonomous mode
**Discovered during:** Phase 5 injection/unicode edge-case tests

## Symptom

Sending `"'; DROP TABLE users; --<script>alert(1)</script> What category of attacks do these strings represent?"` should have returned a clear explanation of SQL injection and XSS. Instead the agent returned meta-commentary:

> "Your question was asking for explanatory information about attack categories — not a task requiring file edits or command execution. There's no code to fix, no file to create, and no command to run based on your question. If you'd like me to **actually do something** with this security knowledge, tell me..."

The same broken pattern appeared for `"What do these emojis suggest: 🎯🤖✨🚀?"` and similar pure-descriptive questions.

## Root cause

The agent loop has an `AutoPush` detector designed to catch the model describing work instead of doing it (e.g., "I'll check the file and fix the bug" without actually calling a tool). The old regexes were:

```ts
const describesWork = /\b(need to|should|would|will|let me|I'll|going to|plan to|we can|you can|I can|check|look at|examine|investigate|verify|confirm|test)\b.*\b(fix|edit|change|update|create|write|modify|run|install|build|start|restart|read|open|debug|set up)\b/i.test(response.content);

const startsWithDescription = /^(Let me|I('ll| will| need| should| can| have| found| see| read| checked)|First|Now|Next|The|To fix|To resolve|To complete|Here'?s|Looking|Based on|After)/i.test(response.content.trim());
```

**Two bugs in the regexes:**

1. `|The` has NO word boundary. It matches the prefix "The" in:
   - "These represent SQL injection..." ✗ FALSE POSITIVE
   - "This is a classic XSS attack..." ✗ FALSE POSITIVE
   - "Then the database deletes..." ✗ FALSE POSITIVE
   - "There are two categories..." ✗ FALSE POSITIVE
   - "They are both common..." ✗ FALSE POSITIVE

2. `describesWork` matches any sentence with a soft indicator like "check" or "look at" combined with any action verb anywhere. "Check out the attack categories — they can both fix or edit the database" would match even though it's descriptive.

3. **The biggest problem: the two regexes are OR'd (`describesWork || startsWithDescription`)** — one weak match fires the nudge. A descriptive answer that accidentally starts with "These" gets treated as avoidance.

## What happened in the trace

```
Round 1: Model returned "These represent two classic categories of web application attacks:
  1. SQL Injection (SQLi) — '; DROP TABLE users; --
  ..." (864 chars, correct answer)

[AutoPush] Model described instead of acting (2/3): "These represent two classic..."
  ← `^These` matched `^The` in startsWithDescription

Nudge: "STOP describing. Call a tool RIGHT NOW..."

Round 2: Model responded with "Your question was asking for explanatory
  information about attack categories — not a task requiring file edits..."
  (505 chars, meta-commentary)

[NoTools] Bailing after 3 consecutive no-tool rounds — accepting text response
```

The user got the meta-commentary instead of the real answer.

## Fix

Three tightening changes:

1. **Word boundaries on all common words** — no more `|The` matching "These".

2. **Both regexes require explicit future-action phrasing** — "Let me VERB", "I'll VERB", "I will VERB", "I need to VERB", "First I", "To fix/resolve/...". Common openers like "The", "This", "Based on", "Here's" no longer match.

3. **Logic changed from `describesWork || startsWithDescription` to `describesWork && futureIntentOpener`** — BOTH must match. One weak indicator isn't enough. This prevents single false positives from firing the nudge.

New regexes:
```ts
const futureIntentOpener = /^(let me\s+\w+|I['']?ll\s+(?:start|begin|check|look|read|run|edit|write|create|try|go|investigate|verify|test|install|build|fix|update|change|set)|I\s+(?:will|need to|should|can|am going to|plan to)\s+\w+|first,?\s+I|now\s+I|to\s+(?:fix|resolve|complete|edit|write|create|update|change|run))\b/i;

const describesWork = /\b(?:I['']?ll|I (?:will|need to|should|plan to|am going to)|let me)\b[^.]{0,80}\b(?:fix|edit|change|update|create|write|modify|run|install|build|start|restart|read|open|debug|set up|check|look at|examine|investigate|verify|confirm|test)\b/i;

if (futureIntentOpener && describesWork && noToolsRetryCount < 3) {
    // fire nudge
}
```

## Verification

After fix, same question:
```
Reply: "These strings represent two classic security attack vectors:

1. **`'; DROP TABLE users; --`** — **SQL Injection (SQLi)**
   - Attempts to manipulate database queries by injecting malicious SQL syntax
   ...

2. **`<script>alert(1)</script>`** — **Cross-Site Scripting (XSS)**
   ..."
Tools: []
```

Full descriptive answer returned, no nudge, no meta-commentary.

## Files modified

- `src/agent/agentLoop.ts` — tightened `describesWork`/`futureIntentOpener` regexes and changed OR to AND

## Cumulative impact

Findings #05, #07, #08, #09, #10 are all about tool-forcing and the agent loop's handling of text responses. Together they form the "autonomous mode text handling" bugfix set:

- #05: Model fabricated tool output (fixed by tool_choice=required + HallucinationGuard)
- #07: Chat pipeline was forced to call tools (fixed by pipeline-type gate)
- #08: Autonomous mode forced tools every round (fixed by round === 0 gate)
- #09: Context trim broke tool pairs (fixed by trimPairAware)
- #10: AutoPush rejected valid descriptive answers (fixed by tighter regexes + AND logic)

Together: autonomous mode now correctly handles tool calls on round 0, lets the model choose after, preserves history, and accepts valid descriptive answers without nudging.
