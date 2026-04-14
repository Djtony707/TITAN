# Hunt Finding #07 — Chat-classified messages forced to use tools (regression from Finding #05)

**Date:** 2026-04-14
**Severity:** MEDIUM — regression introduced by Finding #05 fix
**Discovered during:** Phase 1 retest of session isolation (Finding #06)

## Symptom

After Finding #05 flipped `minimax-m2.7`'s `selfSelectsTools` to `false`, sending a simple math question `"What is 2+2?"` in autonomous mode failed with:
```
I reached the maximum number of tool rounds without a complete answer.
Please try again with a more specific request.
```

The model correctly answered "4" on every round but was penalized for not calling a tool. The agent loop's stall detector marked "4" as an "empty_response" and kept retrying.

## Root cause

The chain of causation:
1. Finding #05 flipped minimax `selfSelectsTools: true → false` so `forceToolUse` would actually fire `tool_choice: required`.
2. But `forceToolUse` in `agentLoop.ts` was set unconditionally for autonomous mode whenever there were tools available and phase !== 'respond'.
3. Before Finding #05, this didn't matter because minimax was marked self-selecting and the provider skipped setting `tool_choice: required`.
4. After Finding #05, every autonomous chat message to minimax got `tool_choice: required`, forcing a tool call.
5. For simple chat (`"what is 2+2?"`) there's nothing to do with a tool. The model returned text "4" (correct), but the loop saw "no tool call" and bailed after 3 rounds.

The pipeline classifier already correctly identified this as `"chat"` with `completionStrategy: 'single-round'`:
```
[Pipeline] Classified as "chat": What is 2+2?
[Pipeline:chat] rounds=3, smartExit=true, completion=single-round
```

But the agent loop ignored those hints when deciding whether to force tool use.

## Fix

Added two additional gates to the `forceToolUse` condition in `agentLoop.ts`:
```ts
&& ctx.completionStrategy !== 'single-round'
&& ctx.pipelineType !== 'chat'
```

Now autonomous mode only forces tools when the pipeline hasn't identified the request as pure chat. Simple questions get direct answers; real tasks still force tool use.

## Files modified

- `src/agent/agentLoop.ts` — added pipeline-type gates to `forceToolUse`

## Verification

After fix (same deployed gateway, same model):

Test 1 — simple chat:
```
POST /api/message {"content":"What is 2+2? Just the number."}
Response: "2+2 = **4**"
Tools: []
```
Correct answer, no tool call, fast.

Test 2 — explicit tool request:
```
POST /api/message {"content":"Use the shell tool to run: uptime. Return verbatim."}
Response: " 10:52:10 up 44 days, 19:36, 10 users, load avg 0.04 0.01 0.00"
Tools: ['shell']
```
Real uptime output, tool was called. Finding #05 still working.

Both scenarios now behave correctly.

## Lesson

When fixing a bug, rerun ALL the scenarios that exercised the nearby behavior to catch regressions. Finding #05's fix was correct in isolation but broke the unrelated "simple chat" path because they shared the same `forceToolUse` gate. This is why the hunt-regression test suite needs scenarios that cover BOTH sides of every decision.
