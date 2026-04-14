# Hunt Finding #08 — Autonomous mode forced tools on EVERY round, causing ping-pong loops

**Date:** 2026-04-14
**Severity:** HIGH — affects every autonomous mode request that needs a text summary
**Discovered during:** Phase 1 read_file test after Finding #07 fix

## Symptom

Sending `"Use read_file to read /tmp/hunt-readfile-test.txt and return its contents"` to an autonomous agent caused:

- Round 1: `read_file` called — correct
- Round 2: `shell` called (`ls -la && cat`) — unnecessary, model already has the content
- Round 3: `shell` called (`test -f && echo`) — pointless existence check
- Round 4: `read_file` called again (same file)
- Round 5+: `memory`, `goal_list`, `edit_file`, `list_dir`...
- Eventually: loop detector fires `"Ping-pong pattern detected: memory ↔ goal_list repeated 3+ times. Breaking loop."`

The agent called **6 different tools** for a single-file read request. Response was the loop-detector error message, not the file content.

## Root cause

The `forceToolUse` gate in `src/agent/agentLoop.ts` was:
```ts
forceToolUse: (ctx.activeTools.length > 0
    && (ctx.isAutonomous || ctx.taskEnforcementActive)
    && ...
    && phase !== 'respond'
    && ctx.completionStrategy !== 'single-round'
    && ctx.pipelineType !== 'chat')
    || forceWriteOnNextThink
    || (round === 0 && ... detectToolUseIntent(...))
```

The first condition fires on EVERY round in autonomous mode when pipeline isn't chat/single-round. So after the model correctly called `read_file` and got the content, round 2 was forced to call another tool — the model picked shell as a fallback, then read_file again, then memory, etc.

The ping-pong pattern was:
1. Read file (round 1)
2. Tool choice required → shell (round 2)
3. Tool choice required → test command (round 3)
4. Tool choice required → read_file again (round 4 — same file)
5. Tool choice required → memory (round 5)
6. Tool choice required → goal_list (round 6)
7. memory, goal_list, memory, goal_list → loop detector kills it

## Fix

Added `round === 0` to the autonomous force-tool gate:
```ts
forceToolUse: (
    round === 0  // ← NEW: only force tools on the initial call
    && ctx.activeTools.length > 0
    && (ctx.isAutonomous || ctx.taskEnforcementActive)
    && ...
)
|| forceWriteOnNextThink
|| (round === 0 && ... detectToolUseIntent(...))
```

Now:
- **Round 0**: if autonomous/enforcement/explicit-intent, force a tool call (correct behavior for "do something")
- **Round 1+**: model is free to call more tools OR generate text based on tool results already in context
- **forceWriteOnNextThink** (incomplete-task guard) still works — that's a specific signal, not a blanket force

The model now decides when to stop calling tools based on actual task state, not a blanket policy.

## Why this is the right layer

The blanket autonomous-forces-tools-every-round pattern was wrong because:
1. It conflates "autonomous mode" with "every round is incomplete"
2. It ignores the fact that tool results in context are the model's completion signal
3. It creates noise (unnecessary tool calls) that pollutes conversations and burns tokens
4. It triggers the loop detector, which then aborts even correct work

The system prompt already tells autonomous agents to use tools for real work. If the model chooses text after round 0, it's probably because:
- The task is done, OR
- It's summarizing a tool result, OR
- It needs to ask a question

All of those are correct responses. Forcing another tool call prevents them.

## Verification

After fix, same request:
```
POST /api/message {"content":"Use read_file to read /tmp/hunt-readfile-test.txt and return its contents exactly, verbatim."}
Response: "File: /tmp/hunt-readfile-test.txt (2 lines)
          ---
          1: hunt-regression-content-test
          2:"
Tools: ['read_file']
Duration: 6.7s
```

One tool call. Correct content. No loop. 6.7s vs minutes of looping.

## Files modified

- `src/agent/agentLoop.ts` — added `round === 0` to the autonomous forceToolUse gate

## Cumulative impact

This finding interacts with findings #05 and #07. Together:
- #05: minimax selfSelectsTools was wrong → forceToolUse now actually fires
- #07: forceToolUse broke simple chat → added pipeline-type gates
- #08: forceToolUse broke multi-round tasks → added round === 0 gate

The three fixes together mean: tool_choice=required fires ONLY when we have strong evidence the user wants a tool AND the model hasn't had a chance to respond yet. Otherwise the model uses its judgment.
