# Hunt Finding #21 — Respond-phase internal monologue + XML leak

**Date:** 2026-04-14
**Severity:** HIGH — raw chain-of-thought and tool-call XML reaching users
**Discovered during:** Phase 3b empty write_file investigation

## Symptoms

Two closely-related respond-phase failure modes captured in a tool chain test:

### Symptom 1 — Internal narrator monologue

```
CONTENT: "The user asked me to run echo rep1, write it to a file, and verify
  with cat. The shell commands returned 'null' which seems like an empty output.
  Let me try again with a different approach - I'll run the echo command and
  capture the actual output properly. Actually, looking at the results - the
  shell commands returned null which..."
```

The model responded in third-person narrative, reading its own task understanding to itself and narrating its reasoning. Classic chain-of-thought leaking into the final answer.

### Symptom 2 — Raw minimax:tool_call XML in content

```
CONTENT: "File written. Confirming with a read verification.
<minimax:tool_call>
<invoke name=\"shell\">
<parameter name=\"command\">cat /tmp/titan-hunt-20-test.txt</parameter>
</invoke>
</minimax:tool_call>"
```

In the respond phase (`tools: undefined`), minimax tried to continue calling tools by encoding them as XML text. The XML reached `result.content`, bypassing the agent loop's empty-response retry, and only the gateway-level sanitizer caught it — but at the cost of replacing the whole reply with the generic fallback, losing task confirmation.

## Root causes

Two interacting issues in the respond phase (`src/agent/agentLoop.ts`):

**1. No respond-phase instruction to the model.**

The respond phase just called the LLM with the conversation history and no additional directive. Weak models default to "think out loud" prose instead of a direct answer. Strong models (Claude, GPT-4) happen to behave correctly without a directive; minimax-m2.7:cloud does not.

**2. `stripToolJson` didn't strip minimax XML.**

```ts
// BEFORE
function stripToolJson(text: string): string {
    return text.replace(/\s*\{"(?:name|tool_call)":\s*"[^"]+",\s*"(?:parameters|arguments)":\s*\{[^}]*\}\s*\}\s*/g, '').trim();
}
```

It only stripped JSON-shaped tool calls, not `<minimax:tool_call>` / `<invoke>` / `<parameter>` XML. The result was:

1. Model responds with raw XML text in the respond phase
2. `stripToolJson` passes the XML through unchanged
3. `result.content` now contains the XML
4. The empty-response retry path checks `!result.content` — but content is *not* empty, it's full of XML, so the retry never fires
5. The gateway sanitizer (`src/gateway/server.ts`) eventually strips the XML, leaving empty content, and uses the safe fallback

The sanitizer saved safety, but task confirmation was lost and the empty-response retry was bypassed.

**3. Sanitizer didn't catch the narrator opener.**

The existing CoT patterns caught `the user wants\b` but NOT `the user asked me to\b`, nor the mid-text reflection tells like `actually, looking at` or `null which (means|suggests)`.

## Fix

### (a) Respond-phase directive injection

`src/agent/agentLoop.ts` — appends a strong directive message to the context only for the respond phase, not persisted to session history:

```ts
const respondDirective: ChatMessage = {
    role: 'user',
    content: '[System directive for this reply only] Write the final answer for the user. RULES: (1) Do NOT narrate what the user asked — they already know. (2) Do NOT describe your reasoning, thinking, or past tool attempts. (3) Do NOT start with "The user asked", "Let me", "Actually", "Looking at", "Wait" — start with the result. (4) Report outcomes as facts in 1-3 sentences. (5) No XML, no tool call blocks, no meta-commentary. Just the answer.',
};
smartMessages = [...smartMessages, respondDirective];
```

### (b) `stripToolJson` now strips minimax XML

```ts
function stripToolJson(text: string): string {
    let cleaned = text.replace(/\s*\{"(?:name|tool_call)":\s*"[^"]+",\s*"(?:parameters|arguments)":\s*\{[^}]*\}\s*\}\s*/g, '').trim();
    // Hunt Finding #21: strip minimax XML so that if a respond-phase model
    // returns ONLY a tool-call block, result.content ends up empty and
    // triggers the empty-response retry path instead of leaking raw XML.
    cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '').trim();
    cleaned = cleaned.replace(/<minimax:tool_call>[\s\S]*$/g, '').trim(); // unclosed
    cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*?<\/invoke>/g, '').trim();
    cleaned = cleaned.replace(/<invoke\s+name=["'][^"']*["']>[\s\S]*$/g, '').trim(); // unclosed
    cleaned = cleaned.replace(/<parameter\s+name=["'][^"']*["']>[\s\S]*?<\/parameter>/g, '').trim();
    cleaned = cleaned.replace(/<\/?(?:invoke|parameter|minimax:tool_call)[^>]*>/g, '').trim();
    return cleaned;
}
```

After this fix, a respond-phase reply consisting entirely of `<minimax:tool_call>...</minimax:tool_call>` now produces an empty `result.content`, which triggers the existing `[EmptyResponse] Recovery retry succeeded` path (verified in live logs).

### (c) Sanitizer patterns for narrator openers and reflections

`src/utils/outboundSanitizer.ts`:

```ts
// Narrative third-person framing — always a CoT leak at response start
/^\s*(?:the user|user)\s+(?:asked|wants|said|requested|mentioned|told|wrote)\s+me\b/i,
/^\s*(?:the user|user)\s+(?:asked|wants|requested)\s+(?:me\s+)?to\s+\w+/i,
// Mid-text reflection on tool output
/\bactually,?\s+looking\s+at\s+(?:the\s+)?(?:results?|output|this|that)\b/i,
/\bnull\s+which\s+(?:means|might\s+mean|seems|suggests)\b/i,
/\bwait,?\s+(?:let me|I need to|that's not)\b/i,
```

## Live verification

Five consecutive tool chain runs after deploying:

```
v2-1: clean (model hallucinated "tool calls returned null" — Finding #17 class, pre-existing)
v2-2: "Done. Created /tmp/v2-2.txt with content 'v2-2', verified with cat."  CLEAN
v2-3: "I ran echo v2-3... The verification with cat was"  CLEAN (EmptyResponse retry fired)
v2-4: "v2-4 written to /tmp/v2-4.txt and verified."  CLEAN
v2-5: "Done. Created /tmp/v2-5.txt with content 'v2-5' and verified it exists."  CLEAN
```

- Zero XML leaks in 5 runs
- Zero narrator openers in 5 runs
- `[EmptyResponse] Recovery retry succeeded` observed in logs for v2-3 (where the respond-phase initial return was stripped to empty)

## Regression tests

`tests/outboundSanitizer.test.ts` — 4 new tests for Finding #21:

- `blocks "The user asked me to..." narrative opener` — uses the exact captured leak as input
- `blocks narrative openers from revealing internal framing`
- `blocks mid-text reflection on tool results`
- `allows legitimate third-person references to "the user"` (false-positive guard)

## Files modified

- `src/agent/agentLoop.ts` — respond-phase directive injection + stripToolJson XML handling
- `src/utils/outboundSanitizer.ts` — 5 new patterns
- `tests/outboundSanitizer.test.ts` — 4 new regression tests
- `tests/fixtures/hunt/21-narrator-respond-phase/` — this fixture doc

5,065 tests pass. Typecheck clean. Deployed and verified live.

## Class-level lesson

**Respond-phase content needs two layers of defense**: (1) a directive to steer the model away from internal-monologue-style output in the first place, and (2) post-generation stripping that leaves the content empty rather than leaky, so the existing empty-response retry path can activate. Passing partially-leaky content through to the gateway sanitizer is worst-case — the content ends up either leaking or replaced with a generic fallback.

Also: `stripToolJson`'s name implies JSON-only but it's actually the "strip tool-shaped garbage" function — should handle every tool-call textual form the model might emit (JSON, XML, DeepSeek-style, etc.). Missing XML was a blindspot that cost the empty-response retry path its trigger.
