# Hunt Finding #13 — 16 of 17 channel adapters had no outbound sanitizer

**Date:** 2026-04-14
**Severity:** HIGH — every non-Facebook channel was exposed
**Discovered during:** Phase 2 cross-channel audit

## Symptom

Phase 2's plan predicted: "The sanitizer is probably only wired to Facebook + Messenger paths. Discord/Telegram/Slack/IRC/Matrix/etc. are likely exposed."

Source audit confirmed it exactly. Running:
```bash
grep -l "sanitizeOutbound\|outboundSanitizer" src/channels/*.ts
```

Returned only `messenger.ts`. The other 16 channel adapters had ZERO sanitizer coverage:
- discord, telegram, slack, whatsapp, matrix, signal, msteams, irc, mattermost, lark, line, zulip, email_inbound, googlechat, qq, webchat

Any of these could have leaked:
- System prompts (Finding #11 class)
- Hallucinated tool output (Finding #05 class)
- Chain-of-thought (Finding #10 class)
- Tool call XML artifacts (Finding #12 class)
- PII (findings listed in sanitizer)
- Raw `<think>` tags

## Why per-channel opt-in was wrong

Every channel subclass had to REMEMBER to call the sanitizer. That's an invitation for:
- New channels (adding an 18th adapter) forgetting to add it
- Refactors removing it during cleanup
- Different channels sanitizing differently (Messenger had its own `cleanReply()` that's slightly different from `sanitizeOutbound()`)

## Fix — central `deliver()` in ChannelAdapter base

The fix is a single change in `src/channels/base.ts`:

```ts
export abstract class ChannelAdapter extends EventEmitter {
    // Subclasses still implement their own wire-level send()
    abstract send(message: OutboundMessage): Promise<void>;

    // NEW: concrete deliver() in the base class that:
    //   1. Runs content through sanitizeOutbound()
    //   2. Uses safe fallback on leak detection
    //   3. Calls the subclass's send()
    async deliver(message: OutboundMessage): Promise<void> {
        const { sanitizeOutbound } = await import('../utils/outboundSanitizer.js');
        const sanitized = sanitizeOutbound(
            message.content,
            `channel:${this.name}`,
            "I had trouble composing a response. Please try rephrasing your request.",
        );
        if (sanitized.hadIssues) {
            logger.warn('ChannelAdapter', `[OutboundGuard:${this.name}] Content sanitized: ${sanitized.issues.join(', ')}`);
        }
        return this.send({ ...message, content: sanitized.text });
    }
}
```

Then updated the gateway's `safeSend()` (the single chokepoint for sending messages back to channels) to call `deliver()` instead of `send()`:

```ts
async function safeSend(channelName: string, msg: ...): Promise<void> {
    const channel = channels.get(channelName);
    if (!channel) return;
    try {
        await channel.deliver(msg);  // ← was .send(msg)
    } catch (err) { ... }
}
```

## Coverage after the fix

All 17 channel adapters now route through the central sanitizer automatically:
- discord, email_inbound, googlechat, irc, lark, line, matrix, mattermost, messenger, msteams, qq, signal, slack, telegram, webchat, whatsapp, zulip

Any future channel adapter extending `ChannelAdapter` gets sanitization for free — it's impossible to forget because the `deliver()` method is in the base class, and the gateway uses `deliver()` by default.

Messenger still has its own `cleanReply()` for additional channel-specific cleaning, but now it also gets the centralized sanitizer layer on top.

## Files modified

- `src/channels/base.ts` — added concrete `deliver()` method with sanitizer
- `src/gateway/server.ts` — `safeSend()` now calls `deliver()` instead of `send()`

## Why this pattern

Principle: **push fixes as high up the stack as possible**. A central base-class fix is worth 17 per-channel fixes because:
- One place to reason about
- Impossible to forget when adding new channels
- Consistent behavior across all channels
- No drift between implementations

## Regression test

Test that `base.ts` contains the `deliver` method and that `safeSend` in server.ts calls `deliver` not `send` directly.
