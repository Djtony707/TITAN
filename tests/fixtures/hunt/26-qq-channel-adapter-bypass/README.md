# Hunt Finding #26 — QQ channel scaffold bypasses sanitizer

**Date:** 2026-04-14
**Severity:** MEDIUM — latent leak that would activate the moment QQ integration is completed
**Discovered during:** Phase 6 channel adapter audit

## Symptom

A source-level audit of `src/channels/*.ts` checking that every channel class `extends ChannelAdapter` (the central sanitizer layer from Finding #13) found:

```
discord              extends=OK  send_methods=1
email_inbound        extends=OK  send_methods=1
googlechat           extends=OK  send_methods=1
...
qq                   extends=MISSING  send_methods=0    ← scaffold, bypasses base class
...
```

`src/channels/qq.ts` was a standalone scaffold exporting a `QQChannel` class that did NOT extend `ChannelAdapter`. The commented-out SDK integration called `client.messageApi.postMessage(channel_id, { content: reply })` directly — bypassing the centralized `deliver()` → `sanitizeOutbound()` wrapper that Finding #13 put in place for the other 16 channels.

Nobody currently imports `QQChannel` (`grep -r "new QQChannel"` returns nothing), so production isn't leaking through it today. But the moment someone installs `qq-bot-sdk` and uncomments the commented-out block, QQ becomes the 17th channel with zero outbound sanitization. It's a latent Finding #13 regression waiting to happen.

## Root cause

QQ was written before Finding #13 introduced the `ChannelAdapter` base class, and the scaffold never got migrated. It used the old pattern: a standalone class with `setMessageHandler(...)` and raw transport calls in the websocket handlers.

## Fix

Refactored `src/channels/qq.ts` to extend `ChannelAdapter`:

1. `extends ChannelAdapter` with required `name`, `displayName`, `connect()`, `disconnect()`, `send()`, `getStatus()` methods
2. Inbound messages are emitted via `this.emit('message', ...)` following the ChannelAdapter pattern — the routing layer will pick them up and call `this.deliver(reply)` for the response, which runs through `sanitizeOutbound` before the raw `send()` fires
3. The raw `send()` method does the actual `client.messageApi.postMessage(...)` call, but only when called via `deliver()`
4. Added a comment block explicitly warning future maintainers NOT to call `send()` directly from the routing layer

With this refactor, when the QQ SDK integration is eventually wired in, it inherits the centralized sanitizer automatically — no opt-in required.

## Regression test

`tests/hunt-regression.test.ts` — a new source-level lint that walks every `.ts` file in `src/channels/` (except `base.ts`), finds any `export class` declaration, and fails the test if the class doesn't extend `ChannelAdapter`:

```ts
it('source lint: every channel adapter extends ChannelAdapter (Hunt #26)', async () => {
    // Walk src/channels/, find class declarations, enforce `extends ChannelAdapter`.
    // Any future scaffold that ships a standalone channel class fails this test,
    // preventing Finding #13 regressions from recurring channel-by-channel.
    ...
});
```

This is an invariant test: it will catch ANY future channel file that forgets to extend the base class, regardless of whether it's a scaffold or a live integration. The class-level guarantee from Finding #13 (every channel auto-sanitizes) is now enforced by test.

## Files modified

- `src/channels/qq.ts` — rewritten to extend `ChannelAdapter`
- `tests/hunt-regression.test.ts` — new invariant lint test
- `tests/fixtures/hunt/26-qq-channel-adapter-bypass/` — this doc

## Class-level lesson

**Finding #13 established "every channel routes through `deliver()`", but only for channels that existed at the time.** Scaffolds and unfinished integrations that were written earlier still lived in a different pattern and bypassed the new invariant.

Architectural invariants need enforcement at the lint level, not just the code review level. The invariant test added here means any future channel file — scaffold or not — must conform, making the Finding #13 fix self-healing against future regressions.
