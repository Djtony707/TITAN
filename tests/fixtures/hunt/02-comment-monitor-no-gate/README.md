# Hunt Finding #02 — `monitorComments()` ignores autopilotEnabled flag

**Date:** 2026-04-14
**Discovered during:** Phase 0 verification — after fixing Finding #01 (schema), comment monitor was still running

## Symptom

After fixing Finding #01 (adding `facebook.autopilotEnabled` to the schema), `runFBAutopilot()` correctly returns early when the flag is false. But the **comment scan still runs every 5 minutes**:

```
2026-04-14 10:11:11 INFO [FBAutopilot] Comment scan: 5 posts, 2 comments, 0 new
```

This means even with `autopilotEnabled: false`, TITAN is still monitoring Facebook comments and would auto-reply to any new ones.

## Root cause

`src/skills/builtin/fb_autopilot.ts:454 monitorComments()` only checks for credentials:

```ts
async function monitorComments(): Promise<void> {
    if (!process.env.FB_PAGE_ACCESS_TOKEN || !process.env.FB_PAGE_ID) {
        logger.debug(COMPONENT, 'Comment monitor: no FB credentials');
        return;
    }
    // ... scan runs unconditionally
}
```

The function does NOT check `facebook.autopilotEnabled` or `facebook.replyMonitorEnabled`. The watcher is registered unconditionally at line 629:

```ts
registerWatcher('fb-autopilot-comments', monitorComments, 5 * 60 * 1000);
```

So a user disabling `autopilotEnabled` only stops post generation, not comment replies — counter-intuitive and unsafe.

## Fix

Add config checks at the top of `monitorComments()`:
- `autopilotEnabled !== false` (master switch — disables everything)
- `replyMonitorEnabled !== false` (finer-grained — disables only replies)

Either being false should early-return from monitorComments.

## Files modified

- `src/skills/builtin/fb_autopilot.ts` — added config gate to `monitorComments()`

## Regression test

Load a config with `autopilotEnabled: false` and verify that calling `monitorComments()` exits before fetching the FB feed. Since we can't mock fetch easily in unit tests, we'll test the CHECK logic directly by extracting it.
