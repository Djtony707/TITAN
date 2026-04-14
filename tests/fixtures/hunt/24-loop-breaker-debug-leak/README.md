# Hunt Finding #24 — Loop breaker debug message leaking to user

**Date:** 2026-04-14
**Severity:** HIGH — raw internal debug text reaching end users
**Discovered during:** Phase 3 weather query

## Symptom

User asked: *"What is the current weather in San Francisco?"*

Weather tool ran successfully and returned real data. Then minimax-m2.7:cloud decided to call `memory(action: list)` for no clear reason, then weather again, then memory, and so on. The ping-pong loop detector correctly caught the pattern after 3 repetitions and broke the loop.

But the user's reply was:
> **"Ping-pong pattern detected: weather ↔ memory repeated 3+ times. Breaking loop."**

Raw internal debug text sent straight to a user who just wanted the weather.

## Root cause

`src/agent/agentLoop.ts` loop-breaker handler wrote the debug reason directly to `result.content` and transitioned to `done`:

```ts
// BEFORE
if (!loopCheck.allowed) {
    logger.warn(COMPONENT, `Loop breaker [${loopCheck.level}]: ${loopCheck.reason}`);
    result.content = loopCheck.reason || 'Loop detected — stopping to prevent runaway execution.';
    loopBroken = true;
    break;
}
// ...later...
if (loopBroken) { phase = 'done'; break; }
```

The respond phase was skipped entirely. Every collected tool result (including the perfectly valid weather data) was thrown away and replaced with the loop breaker's debug string.

## Fix

Route through the respond phase with a directive to summarize from the data the tools already collected:

```ts
if (!loopCheck.allowed) {
    logger.warn(COMPONENT, `Loop breaker [${loopCheck.level}]: ${loopCheck.reason}`);
    // Hunt Finding #24: instead of leaking the debug message, tell the
    // model to summarize from the tool data it already has.
    ctx.messages.push({
        role: 'user',
        content: '[SYSTEM] You were stuck in a tool loop and it has been broken. Now produce a DIRECT final answer to the user based on the tool results you already have above. Do NOT call any more tools. Do NOT mention the loop, the breaker, or any internal process. Just answer the user\'s original question using the data you collected.',
    });
    phase = 'respond';   // ← was implicit `done`, now explicit `respond`
    loopBroken = true;
    break;
}

// ...later...
// Previously this forced phase='done' after a break, bypassing respond.
// Now the breaker already set phase='respond' so we just exit the act loop
// and fall through.
if (loopBroken) { break; }
```

The key changes:
1. `phase = 'respond'` is set explicitly when the breaker fires.
2. The directive message tells the model to produce a direct answer from the data it collected.
3. The `if (loopBroken) { phase = 'done'; break; }` check no longer forces `done` — it just exits the act loop, letting the respond phase run.

The loop breaker's reason stays in logs for debugging but never reaches the user.

## Live verification

Retest of the same weather query after deploying:

```
User: "What is the current weather in San Francisco? Just the key facts."

Response: "Weather: San Francisco is 59°F (partly cloudy); Quebec is 41°F
(patchy rain) ..."
```

No "Ping-pong pattern detected" text anywhere in the reply. The user got the weather data that the weather tool successfully collected.

## Updated tests

Two existing tests encoded the old buggy behavior:

- `tests/agent-loop.test.ts` — "should break loop when checkForLoop disallows continuation" asserted `result.content` CONTAINS the breaker reason. Rewritten to assert the opposite: the breaker reason must NOT appear in `result.content`.
- `tests/agent.test.ts` — "should stop when loop detection triggers a circuit breaker" asserted `result.content` contains "Infinite loop detected". Rewritten to assert it does NOT, and that content is non-empty (because respond phase generates something useful).

## Regression test (source-level)

`tests/hunt-regression.test.ts`:
- Asserts `src/agent/agentLoop.ts` no longer contains `result.content = loopCheck.reason` pattern
- Asserts `phase = 'respond'` appears within 400 chars before the `loopBroken = true` line

## Files modified

- `src/agent/agentLoop.ts` — loop-breaker directive + respond routing
- `tests/agent-loop.test.ts` — updated test to match new behavior
- `tests/agent.test.ts` — updated test to match new behavior
- `tests/hunt-regression.test.ts` — new source-level lint
- `tests/fixtures/hunt/24-loop-breaker-debug-leak/` — this doc

## Class-level lesson

**Anything written to `result.content` becomes user-facing text.** If you need to communicate a failure to the model, write it as a `role: 'user'` message in `ctx.messages` instead — the model can react, the respond phase can incorporate it, and nothing raw-leaks to users. The debug channel is `logger.*`; the user channel is `result.content`. Never mix them.
