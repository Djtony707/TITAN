# Hunt Finding #09 — Context trim broke tool_call/tool_result pairs, causing message loss

**Date:** 2026-04-14
**Severity:** HIGH — affects any multi-round conversation in autonomous mode
**Discovered during:** Phase 1 web_search test after Finding #08 fix

## Symptom

Sending `"Use web_search to find one news article about Node.js 24"` produced a nonsensical reply:

> "I don't see a specific file or change request in your message. Could you clarify what needs to be edited or written? The repeated prompts suggest I may have missed something — please share the file path and the change you'd like made."

Tools actually called: `['web_search', 'web_fetch', 'memory']` — three separate tools, with the final response being completely unrelated to any of them.

## Root cause

Looking at the trace log:
```
2026-04-14 11:03:55 WARN [AgentLoop] [ToolPairValidation] Removing assistant msg with 1 orphaned tool call(s): web_search
2026-04-14 11:03:55 WARN [AgentLoop] [ToolPairValidation] Removing assistant msg with 1 orphaned tool call(s): web_fetch
2026-04-14 11:03:55 WARN [AgentLoop] [ToolPairValidation] Removing assistant msg with 1 orphaned tool call(s): web_search
2026-04-14 11:03:55 INFO [AgentLoop] [ContextTrim] Trimmed to 6 messages
```

The chain:
1. Model called `web_search`, got results (round 1)
2. Context grew past 12 messages
3. Hard trim kicked in: `slice(-8)` on non-system messages
4. `.slice(-8)` cut through tool_call/tool_result pairs — it kept the tool results but NOT their parent assistant-with-tool_calls messages (or vice versa)
5. `validateToolPairs` ran and found "orphaned" tool calls (assistants whose tool results were trimmed away)
6. validateToolPairs DROPPED those assistant messages entirely
7. Model's next turn had incomplete context — no record of what tools it had called
8. Model got confused, tried to ask for clarification about "files and changes" (completely unrelated to the original query)

## Why `slice(-8)` is wrong

A tool call flow looks like:
```
[0] system
[1] user: "search for Node.js news"
[2] assistant: (calls web_search, toolCallId: abc)
[3] tool: (result for abc)
[4] assistant: (calls web_fetch, toolCallId: def)
[5] tool: (result for def)
[6] assistant: "Here's what I found..."
```

If messages are 12+, `.slice(-8)` would keep indices 4-11. But if index 4 is a tool message and its parent assistant is at index 3, the tool is now orphaned (no parent). validateToolPairs then drops something else (or the assistant if the tool is kept with no parent).

The slice boundary has a 50% chance of landing in the middle of a tool pair, breaking it.

## Fix

New `trimPairAware(messages, maxTotal)` function in `agentLoop.ts` that walks messages backwards and keeps tool_call + tool_result PAIRS together atomically:

```ts
if (msg.role === 'tool' && msg.toolCallId) {
    // Find and keep the parent assistant message
    for (let j = i - 1; j >= 0; j--) {
        if (nonSystem[j].role === 'assistant' && nonSystem[j].toolCalls?.some(tc => tc.id === msg.toolCallId)) {
            keepIdx.add(j);
            break;
        }
    }
    keepIdx.add(i);
} else if (msg.role === 'assistant' && msg.toolCalls) {
    // Keep this + all its tool results
    keepIdx.add(i);
    for (let j = i + 1; j < nonSystem.length; j++) {
        if (nonSystem[j].role !== 'tool') break;
        keepIdx.add(j);
    }
}
```

This preserves the invariant that `validateToolPairs` checks: every assistant-tool_calls message has matching tool_result messages.

## Files modified

- `src/agent/agentLoop.ts` — added `trimPairAware()` and replaced the `.slice(-8)` trim

## Verification

After fix, same request:
```
POST /api/message {"content":"Use web_search to find one news article about Node.js 24."}
Response: "No news articles found — Node.js 24 likely hasn't been released yet. The current stable version is Node.js 22..."
Tools: ['web_search']
Duration: 9.7s
```

One tool call, coherent response, no orphan warnings, no ping-pong.

## Cumulative impact

This was the LAST missing piece after findings #05+#07+#08. The full story of "tool calls break on autonomous mode" was:

- #05: Minimax marked selfSelectsTools=true (wrong) → never forced tool_choice
- #05: Fix was flip to false, but then...
- #07: Broke simple chat (fixed by pipeline-type gate)
- #08: Broke multi-round tasks by forcing on every round (fixed by round === 0 gate)
- #09: Even with all of the above, context trim was BREAKING pairs, making the model see fragmented history and redo work

Together these four fixes mean: autonomous mode now handles tool calls correctly. Force on round 0, let the model decide after, preserve history across trims.
