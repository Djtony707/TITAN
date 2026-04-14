# Hunt Finding #16 — "I'll write / I need to create" false positive in sanitizer

**Date:** 2026-04-14
**Severity:** MEDIUM — suppresses legitimate responses from reaching the user
**Discovered during:** Phase 3 tool execution gauntlet, multi-tool chain test
**Parallel to:** Finding #15 (same class — action verbs confused with chain-of-thought)

## Symptom

The multi-tool chain test prompted TITAN with:
> "Read /etc/hostname using shell (cat), then write its content exactly to /tmp/hostname-copy.txt using write_file"

The model produced the correct post-action explanation:
> "The hostname content is `dj-Z690-Steel-Legend-D5`. Now I'll write that exact content to the target file."

The gateway response logs showed:
```
WARN [OutboundSanitizer] [api_message] Content blocked (1 issue(s)): instruction_leak: I'll write
 | Original: "The hostname content is `dj-Z690-Steel-Legend-D5`. Now I'll write that exact content..."
WARN [Gateway] [OutboundGuard] /api/message response sanitized: instruction_leak: I'll write
```

The legitimate explanation was replaced with the generic fallback message.

## Root Cause

`src/utils/outboundSanitizer.ts` had these overly-broad chain-of-thought patterns:

```ts
/\bI need to (?:be|think|consider|respond|reply|brainstorm|come up|write|create|generate|figure out|decide)\b/i,
/\bI'll (?:start|begin|first|now|brainstorm|think|try|write|create|generate|come up|list|put together)\b/i,
/\bI (?:could|should|would|might|can) (?:highlight|brainstorm|list|write|create|generate|come up|think|try)\b/i,
```

The action verbs `write`, `create`, `generate`, `start`, `begin`, `now`, `first`, `try`, `list` are all
perfectly valid in post-action explanations:

- "I'll write the file now" ← fine
- "I need to create a new directory first" ← fine
- "I'll start the command" ← fine
- "I'll run the build now" ← fine

Only the deliberative verbs — `think`, `brainstorm`, `come up with`, `figure out`, `consider`, `decide`
— are actual chain-of-thought indicators that should be blocked.

This is the exact same class of bug as Finding #15, which fixed "Let me write/run/edit" getting
blocked by too-broad "Let me X" patterns.

## Fix (round 1)

`src/utils/outboundSanitizer.ts` — narrowed the three "I'll/I need to/I could" patterns to only match COT verbs:

```ts
// Hunt Finding #16: narrowed to only COT verbs, removed action
// verbs like write/create/generate that appear in legitimate post-action
// explanations ("Now I'll write the file", "I need to create a test").
/\bI need to (?:think|consider|brainstorm|come up with|figure out|decide)\b/i,
/\bI'll (?:brainstorm|think about|come up with|put together|list out)\b/i,
/\bI (?:could|should|would|might) (?:highlight|brainstorm|think about|come up with)\b/i,
```

## Fix (round 2) — same class, different pattern

After deploying round 1 the retest surfaced ANOTHER pattern blocking mid-text "Let me try":

```
2026-04-14 14:25:15 WARN [OutboundSanitizer] [api_message] Content blocked (1 issue(s)):
instruction_leak: Let me try | Original: "The file was created but was empty...
Let me try..."
```

The mid-text regex `\blet me (?:think|check|consider|brainstorm|come up|start|begin|try|figure out|see|explore)\b`
still had action verbs (try/check/start/begin/see). Narrowed to match the start-of-line COT-only list:

```ts
/\blet me (?:think|brainstorm|consider|come up with|figure out|decide|plan|investigate|reconsider|reflect)\b/i,
```

And aligned the start-of-line `let me` pattern to the same minimal COT list:

```ts
/^\s*let me\s+(?:think|brainstorm|consider|come up with|figure out|decide|plan|investigate|reconsider|reflect|explore)\b/i,
```

Also removed `try`, `see` from the `let's` start-of-line pattern, and removed `see` from the Hmm/Okay-prefix pattern (already caught by other patterns when prefixed with "Hmm,").

## Deployed verification

After round-2 fix + redeploy:

```
Request: "Read /etc/hostname using shell (cat), then write its content exactly to
/tmp/hostname-copy2.txt using write_file. After both tools run, tell me what you did."

Response: "The file is empty. The /etc/hostname file appears to be empty. Let me
try a different approach - maybe I should use shell to get the hostname value and
then write it."

TOOLS_USED: ['shell', 'read_file', 'write_file']
DURATION_MS: 18519
```

The response is now delivered instead of replaced with the fallback. The "Let me try a different approach"
mid-text text passes through cleanly.

(Note: the model is still producing empty content via write_file — that's a separate model-accuracy
issue tracked outside this finding.)

## Regression test

`tests/outboundSanitizer.test.ts`:

```ts
it('REGRESSION Hunt #16: allows "I\'ll write/create/run" as legit post-action explanation', () => {
    const real = "The hostname content is `dj-Z690-Steel-Legend-D5`. Now I'll write that exact content to the target file.";
    expect(sanitizeOutbound(real, 'test').hadIssues).toBe(false);

    expect(sanitizeOutbound("I'll write the file now.", 'test').hadIssues).toBe(false);
    expect(sanitizeOutbound("I'll create a new test file.", 'test').hadIssues).toBe(false);
    expect(sanitizeOutbound("I'll run the shell command.", 'test').hadIssues).toBe(false);
    expect(sanitizeOutbound("I'll generate the report now.", 'test').hadIssues).toBe(false);
    expect(sanitizeOutbound("I need to write a config file.", 'test').hadIssues).toBe(false);
    expect(sanitizeOutbound("I need to create the directory first.", 'test').hadIssues).toBe(false);
});

it('REGRESSION Hunt #16: still blocks "I\'ll brainstorm/think about/come up with"', () => {
    expect(sanitizeOutbound("I'll brainstorm some ideas.", 'test').hadIssues).toBe(true);
    expect(sanitizeOutbound("I'll think about this carefully.", 'test').hadIssues).toBe(true);
    expect(sanitizeOutbound("I'll come up with something fresh.", 'test').hadIssues).toBe(true);
    expect(sanitizeOutbound("I need to think about the best approach.", 'test').hadIssues).toBe(true);
    expect(sanitizeOutbound("I need to brainstorm some capabilities.", 'test').hadIssues).toBe(true);
    expect(sanitizeOutbound("I need to figure out what to do.", 'test').hadIssues).toBe(true);
});
```

Plus existing pattern coverage in the `cotSamples` table:
- `"I'll brainstorm"`, `"I need to come up with"`, `"I could highlight"`, `"I should brainstorm"` — all still blocked.

## Class-level lesson

Chain-of-thought detection must target **deliberative verbs**, not **action verbs**. Any time a
pattern includes `write|create|run|edit|start|generate`, it will eventually block a legitimate
post-action explanation. The canonical COT verbs are:

- think, brainstorm, consider, figure out, decide, come up with, plan, explore, investigate,
  put together, list out, think about, highlight (as in "highlight some ideas")

Actions that follow a tool call (write/create/run/edit/start/build/install/restart) are legitimate
and must not be flagged.

This lesson now covers Findings #15 and #16. Any future pattern change that reintroduces action verbs
into the COT patterns will fail these tests.

## Files modified

- `src/utils/outboundSanitizer.ts` — narrowed 3 COT patterns
- `tests/outboundSanitizer.test.ts` — 2 new regression tests (13 assertions total)
