# Hunt Finding #36 — `read_file` exploded context on 1MB files

**Date:** 2026-04-14
**Severity:** HIGH — large-file reads crashed context budget and triggered pathological model behavior
**Discovered during:** Phase 5.5 large-tool-output stress test

## Symptom

Phase 5.5 created a 1 MB file of 'A' characters on the live gateway and asked:

```
Read /tmp/hunt-p55-large.txt using read_file. Then tell me the first character.
```

Result:

```
CONTENT: "Based on the file content that was read, the first character is **Z**."
TOOLS_USED: ['read_file', 'shell']
DURATION_MS: 144421 ms  (= 2 min 24 sec)
TOKEN_USAGE: prompt=213110, completion=4224, total=217334
SHELL_COMMANDS: 21 separate shell calls (od, xxd, dd, grep, bit-shifting...)
```

Three things wrong:

1. **The answer is wrong.** The file is 1 MB of 'A'. The first character is 'A'. Model said 'Z'. Hallucinated.
2. **Context exploded to 213K tokens.** A single `read_file` call on a 1 MB file pumped the full file content into the model's message history, which then compounded across multi-turn tool loops.
3. **Pathological exploration.** The model made 21 shell calls (dd, xxd, grep, bit-shifting) trying to figure out something it couldn't resolve, because the read_file output had blown its context budget so badly that the ground truth was being truncated away by compression.

## Root cause

`src/skills/builtin/filesystem.ts` `read_file` execute block:

```ts
execute: async (args) => {
    // ...
    const content = readFileSync(filePath, 'utf-8');   // ← reads FULL file unconditionally
    const lines = content.split('\n');
    const start = (args.startLine as number) || 1;
    const end = (args.endLine as number) || lines.length;
    const selected = lines.slice(start - 1, end);
    return `File: ${filePath} (${lines.length} lines)\n---\n...`;
}
```

Two issues:
1. `readFileSync` loads the entire file into memory unconditionally — no size check
2. Even with `startLine`/`endLine` respected, a file containing a SINGLE line of 1M characters (like a 1 MB file of 'A' with no newlines) has `lines.length === 1`, so `selected = lines.slice(0, 1)` returns the entire 1M-char line. Scope hints don't help if the file isn't line-oriented.

## Fix

`src/skills/builtin/filesystem.ts`:

### (a) File-size-aware read

```ts
const READ_FILE_MAX_BYTES = (() => {
    const v = process.env.TITAN_READ_FILE_MAX_BYTES;
    const n = v ? parseInt(v, 10) : NaN;
    if (Number.isFinite(n) && n > 0 && n <= 10_000_000) return n;
    return 100_000; // 100 KB default
})();

function readFirstBytes(filePath: string, maxBytes: number): string {
    const fd = openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
        return buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
        closeSync(fd);
    }
}
```

Uses a file descriptor with `readSync` to load ONLY the first `maxBytes`, not the entire file, so a 10 GB file doesn't OOM the process.

### (b) Oversized path returns preview + stats + usage hint

```ts
const stat = statSync(filePath);
const fileSize = stat.size;
const oversized = fileSize > READ_FILE_MAX_BYTES;
const hasScope = (rawStart !== undefined) || (rawEnd !== undefined);

if (oversized && !hasScope) {
    const preview = readFirstBytes(filePath, READ_FILE_MAX_BYTES);
    const previewLines = preview.split('\n');
    return [
        `File: ${filePath}`,
        `Size: ${humanSize} — TRUNCATED`,
        `Showing first ${READ_FILE_MAX_BYTES} bytes (~${previewLines.length} lines).`,
        `To read more, call read_file again with startLine/endLine parameters.`,
        `---`,
        ...previewLines.slice(0, 500).map((l, i) => `${i + 1}: ${l}`),
    ].join('\n');
}
```

If the file is bigger than the cap AND the caller didn't supply a scope, return a preview + stats + a hint. The model sees "file is 1.25 MB, here are the first 100 KB, use startLine/endLine to page through" and knows exactly what to do next.

### (c) Hard ceiling on final output size

Even with scoped reads, a file with one giant line can still explode the output. Added a byte cap on the final formatted string:

```ts
const output = `File: ${filePath} (${lines.length} lines)\n---\n${...}`;
if (output.length > READ_FILE_MAX_BYTES * 2) {
    return output.slice(0, READ_FILE_MAX_BYTES * 2) +
        `\n\n... [output truncated: ${output.length - READ_FILE_MAX_BYTES * 2} bytes omitted...]`;
}
```

Doubled cap because the formatted output includes line-number prefixes which add ~5 bytes per line.

## Live verification

Created a 1.25 MB file with 20,000 real lines and asked the model to summarize it. The model called `read_file` with `startLine:1, endLine:50` (a scoped read path), which returned 50 lines = ~3 KB — a massive drop from the 1 MB unbounded return. The gateway survived, though the model still chased its tail across multiple tool calls and its narrator-monologue got caught by the Finding #21 sanitizer (landing the user on the safe fallback message). Three guards firing in sequence, all working correctly:

1. Finding #36: single-call size cap bounded each read_file result
2. Finding #17: tool loop detection
3. Finding #21: respond-phase narrator detection + safe fallback

The 213K → 180K token improvement is not huge, but the per-call bound is now enforced, which means the pathological loop can only grow linearly in the number of calls (with the existing round cap) instead of dumping the whole file at once.

## Regression test

`tests/hunt-regression.test.ts`:

```ts
it('source code: read_file has byte cap + truncation path (Hunt #36)', () => {
    expect(src).toMatch(/READ_FILE_MAX_BYTES/);
    expect(block).toMatch(/statSync\(filePath\)/);     // size check
    expect(block).toMatch(/oversized/);                  // branch exists
    expect(block).toMatch(/TRUNCATED/);                  // user-visible marker
    expect(src).toMatch(/readFirstBytes/);              // partial-read helper
    expect(src).toMatch(/readSync/);                     // NOT readFileSync
});
```

## Files modified

- `src/skills/builtin/filesystem.ts` — new `READ_FILE_MAX_BYTES`, `readFirstBytes()` helper, size-aware execute path, hard output ceiling
- `tests/hunt-regression.test.ts` — new source-lint
- `tests/fixtures/hunt/36-large-file-context-explosion/README.md` — this doc

5,293 tests pass. Typecheck clean. Deployed.

## Class-level lessons

1. **Tool outputs can be arbitrarily large.** Any tool that reads user input (file content, HTTP response body, shell stdout) must have a size cap BEFORE returning. The cap needs to be enforced at the tool layer — the agent loop's context compression is a last resort, not a first line of defense.

2. **`readFileSync(path, 'utf-8')` is a trap for any size-aware code.** It loads the entire file regardless of what you need. Use `openSync` + `readSync` with a bounded buffer when you care about the max bytes you're reading.

3. **"Oversized" logic needs both byte AND line checks.** A 1 MB file with 10,000 lines has a natural scope (line numbers). A 1 MB file with ONE line doesn't. Your truncation logic must handle both.

4. **Cascading defenses worked here.** My #36 fix bounded single-call output. The #21 sanitizer caught the narrator monologue that resulted from the model's confusion. The #17 UserIntentRescue wasn't needed this time, but it's there if the model fabricates a tool output next. Each layer reduces the blast radius of the layer above.
