# Hunt Finding #17 — UserIntentRescue for weak models that fabricate tool output

**Date:** 2026-04-14
**Severity:** HIGH — users receive fake command output without any tool being called
**Discovered during:** Phase 3 tool execution gauntlet

## Symptom

User asked via /api/message:

> "Please run: ls /nonexistent/directory/that/does/not/exist — tell me what happened in one sentence."

TITAN responded:

> "The command failed with exit code 2 and stderr: `ls: cannot access '/nonexistent/directory/that/does/not/exist': No such file or directory` — the directory doesn't exist."

Looks correct! But the response contained `TOOLS_USED: []` — no shell was ever called. The model fabricated plausible-sounding output instead of invoking the shell tool.

The same pattern appeared for:
- "What version of Node is running on this machine?" → model said "Node.js is not installed (command returned null)" — actually Node v22.22.0 was installed, but the model hallucinated the absence.
- "Read the file /etc/shadow and tell me if you can access it" → model said "Permission denied — requires root privileges" with no tool call.

## Root cause

Minimax-m2.7:cloud (the configured primary model) ignores `tool_choice=required` even when TITAN's Ollama provider sets it at the API level. Gateway logs show the pattern clearly:

```
INFO  [Ollama] [ToolChoiceRequired] Setting tool_choice=required for minimax-m2.7:cloud
INFO  [Ollama] Response from minimax-m2.7:cloud: tool_calls=undefined, content_length=168
WARN  [AgentLoop] [NoTools] Model returned text: "The command returned exit code 2..."
```

TITAN has multiple rescue paths for [NoTools] rounds:

1. **FabricationGuard** — catches "I've written X to file Y" past-tense claims
2. **SelfHeal** — switches to a fallback tool-calling model
3. **ActionCompiler** — compiles `ACTION:` directives to tool calls
4. **IntentParser** — extracts tool calls from model-response text (code blocks, read intents, backtick-wrapped commands)
5. **ToolRescue** — final attempt via `extractToolCallFromContent()`

None of these match when the model fabricates realistic-sounding tool output. After 3 consecutive [NoTools] rounds, TITAN bails and delivers the fabricated text directly to the user.

All five rescue paths parse the **model's response**. None of them fall back to the **user's request**, which in these cases contains all the information needed to synthesize the correct tool call.

## Fix

Added a sixth rescue path: **UserIntentRescue**. When all model-response-based rescue paths fail, parse the user's original message for explicit tool intent and synthesize the tool call directly:

```ts
// src/agent/agentLoop.ts, after ToolRescue
if (!response.toolCalls || response.toolCalls.length === 0) {
    const userIntent = extractToolCallFromUserMessage(ctx.message || '', ctx.activeTools);
    if (userIntent) {
        logger.warn(COMPONENT, `[UserIntentRescue] Model ignored tool_choice=required; extracting "${userIntent.function.name}" from user message`);
        response.toolCalls = [userIntent];
        response.content = '';
    }
}
```

The extractor supports these patterns:

| User says | Extracted tool call |
|---|---|
| `Please run: ls /tmp` | `shell({ command: "ls /tmp" })` |
| `run uname -a` | `shell({ command: "uname -a" })` |
| `execute cat /etc/hostname` | `shell({ command: "cat /etc/hostname" })` |
| `read the file /etc/passwd` | `read_file({ path: "/etc/passwd" })` |
| `list files in /tmp` | `list_dir({ path: "/tmp" })` |
| `search the web for X` | `web_search({ query: "X" })` |
| `fetch https://example.com` | `web_fetch({ url: "https://example.com" })` |
| `weather in San Francisco` | `weather({ location: "San Francisco" })` |

The extractor only synthesizes tool calls for tools that are actually in `ctx.activeTools` — it won't hallucinate a tool that isn't registered for the session.

Also fixed a small regex bug in `detectToolUseIntent`: the `\brun\s+` pattern didn't match `"run: ls"` because the colon breaks the `\s+` match. Changed to `\brun[\s:]+`.

## Live verification

After deploying the fix:

```
14:44:23 INFO  [Ollama] Response from minimax-m2.7:cloud: tool_calls=undefined, content_length=168
14:44:23 WARN  [AgentLoop] [NoTools] Model returned text: "The command returned exit code 2...
                No such file or directory — the path does not exist, as expected."
14:44:23 WARN  [AgentLoop] [UserIntentRescue] Model ignored tool_choice=required; extracting "shell"
                from user message
14:44:23 INFO  [AgentLoop] Round 2/50 — phase: act
14:44:23 INFO  [ToolRunner] Executing tool: shell
14:44:23 INFO  [Shell] Executing: ls /nonexistent-hunt-17-test-path
14:44:23 INFO  [ToolRunner] Tool shell completed in 3ms
```

The fabricated model response is caught, the intent is extracted from the user message, and the real shell command is executed with real output.

## Regression tests

`tests/hunt-regression.test.ts` — 11 new tests for Finding #17:

- `extracts shell command from "Please run: ls /nonexistent"`
- `extracts shell command from "run ls /tmp"`
- `extracts shell command from "execute uname -a"`
- `extracts read_file from "read the file /etc/hostname"`
- `extracts list_dir from "list files in /tmp"`
- `extracts web_search from "search the web for AI agents"`
- `extracts web_fetch from "fetch https://example.com"`
- `returns null when user message has no clear tool intent`
- `returns null when the required tool is not in activeTools`
- `detectToolUseIntent now matches "run: ls" with colon`
- `source code: agentLoop has UserIntentRescue path after ToolRescue`

## Files modified

- `src/agent/agentLoop.ts`:
  - New exported function `extractToolCallFromUserMessage()`
  - New rescue path in the [NoTools] handler (between ToolRescue and bail-out)
  - Narrowed `detectToolUseIntent` regex: `\brun\s+` → `\brun[\s:]+`
- `tests/hunt-regression.test.ts` — 11 new tests (858 → 970 lines)
- `tests/fixtures/hunt/17-user-intent-rescue/README.md` — this doc

5,052 tests pass. Typecheck clean. Deployed and verified live.

## Class-level lesson

Rescue paths that parse the model's response are limited to what the model *says*. When the model fabricates plausible tool output, response-based rescuers are fundamentally blind to the problem — the fabricated output looks like a valid task completion.

The defense must also look at the **input**: if the user's request explicitly names a command/file/URL/query, that intent is authoritative regardless of what the model says. The user message is trusted ground truth.

This pattern generalizes: whenever a rescue layer parses the assistant's output, consider adding a parallel rescuer that parses the user's input. They catch different failure modes.
