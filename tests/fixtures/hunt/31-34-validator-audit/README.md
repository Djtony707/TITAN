# Hunt Findings #31–#34 — Follow-up audit after #28

**Date:** 2026-04-14
**Severity:** MIXED (HIGH for #31 and #33, MEDIUM for #32 and #34)
**Discovered during:** Post-Finding-#28 security-validator audit

## Context

Finding #28 caught the shell tool shipping a critical `BLOCKED_COMMANDS` allowlist with zero unit tests AND a regex hole that wiped real user files on the live gateway. The class-level lesson from #28 was:

> **Audit every `validateCommand`-style allowlist for unit test coverage.** Other security boundaries (path validators, URL allowlists, content filters) should each have test files covering both must-block and must-pass cases.

This audit covers every file in `src/` matching security-validator naming patterns (`BLOCKED_*`, `ALLOWED_*`, `validate*`, `isBlocked*`, `isAllowed*`, `DANGEROUS_*`). I found four more validators with zero test coverage and at least one exploitable bug each.

## Findings

### #31 — `guardrails.ts` + `executeCode.ts` had the same `rm -rf /tmp` bypass as #28

Both files contained:

```ts
// guardrails.ts DANGEROUS_COMMANDS
{ pattern: /\brm\s+-rf\s+\/(?!tmp)/, rule: 'rm_rf_root', severity: 'critical' as const },

// executeCode.ts BLOCKED_PATTERNS
/rm\s+-rf\s+\/(?!tmp)/,
```

Both used `(?!tmp)` to carve out `/tmp` as a "safe exception". But as Finding #28 proved with real damage on the live gateway, `rm -rf /tmp` wholesale wipes every user-writable file in `/tmp`. The escape hatch defeats the purpose of the check.

Worse: these are TWO separate files with the SAME bug. There are THREE different places that block dangerous shell commands in TITAN (shell.ts, guardrails.ts, executeCode.ts), none of them shared a single source-of-truth for the pattern list, and all three had the same regex bug before #28. Even after #28, the other two were still vulnerable.

**Fix:** Rewrote `DANGEROUS_COMMANDS` in guardrails.ts and `BLOCKED_PATTERNS` in executeCode.ts to match the pattern library from shell.ts — explicit allowlist of top-level directories using the `(?!\/?[a-zA-Z0-9_])` lookahead that distinguishes "ends at top level" from "continues into a subdirectory". Scoped subpath `rm -rf /tmp/cache-123/build` still passes; bulk top-level wipes are blocked.

### #32 — `startsWith('/tmp')` let sibling paths through (4 files)

Four files had naive path-prefix checks:

```ts
// filesystem.ts validatePath
if (!resolved.startsWith(home) && !resolved.startsWith('/tmp')) { return 'denied'; }

// knowledge_base.ts isAllowedFilePath
if (!normalized.startsWith(home) && !normalized.startsWith('/tmp')) return false;

// event_triggers.ts isAllowedWatchPath
if (!normalized.startsWith(home) && !normalized.startsWith('/tmp')) return false;

// server.ts validateFilePath
if (!fullPath.startsWith(basePath)) { /* reject */ }
```

All four let sibling paths through:
- `/tmpfoo/evil` → `startsWith('/tmp')` is **true** → access granted to `/tmpfoo/evil` even though it's NOT inside `/tmp`
- If home is `/home/dj`, then `/home/djacob/secret` → `startsWith('/home/dj')` is **true** → access granted to a different user's directory
- server.ts: if basePath is `/home/dj/workspace`, then `/home/dj/workspace-evil/file` → `startsWith('/home/dj/workspace')` is **true** → attacker bypasses the root allowlist

**Fix:** Added an `isWithinDir(child, parent)` helper that requires either exact match or a path-separator boundary. Applied consistently to all four call sites:

```ts
function isWithinDir(child: string, parent: string): boolean {
    if (child === parent) return true;
    const parentWithSep = parent.endsWith('/') ? parent : parent + '/';
    return child.startsWith(parentWithSep);
}
```

Now `/tmpfoo` correctly fails to match `/tmp`, and `/home/djacob` correctly fails to match `/home/dj`. Scoped subdirectories (`/tmp/titan-cache`, `/home/dj/.cache`) still pass.

### #33 — SSRF: `knowledge_base.ts isBlockedUrl` didn't block private RFC 1918 ranges

The previous implementation:

```ts
function isBlockedUrl(url: string): boolean {
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === '169.254.169.254') return true;              // only EXACT cloud metadata
    if (hostname === 'metadata.google.internal') return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (parsed.protocol === 'file:') return true;
    return false;
}
```

This blocked the cloud metadata endpoint and exact loopback but left huge SSRF holes:

- **Entire 127.0.0.0/8** — only `127.0.0.1` was blocked, not `127.0.0.2`
- **All of 169.254.0.0/16 link-local** — only `169.254.169.254` was blocked
- **All private RFC 1918**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — completely unblocked
- **CGNAT (100.64.0.0/10)** — unblocked
- **IPv6 loopback/link-local/unique-local** (`::1`, `fe80::/10`, `fc00::/7`) — unblocked
- **IPv4-mapped IPv6**: `::ffff:127.0.0.1`, `::ffff:192.168.1.1` — unblocked
- **Non-HTTP schemes**: only `file:` was blocked. `gopher:`, `ftp:`, `dict:` etc. all passed through

An attacker using knowledge-base ingestion could point TITAN at `http://192.168.1.1/admin` (the user's router), `http://10.0.0.5/printer/config`, or `http://[fe80::1%eth0]/internal-api`, and the SSRF check passed it through.

**Fix:** Complete rewrite of `isBlockedUrl` to block:
- Only `http:` and `https:` schemes allowed (everything else rejected)
- All of `127.0.0.0/8`
- All of `169.254.0.0/16`
- All of `10.0.0.0/8`
- All of `172.16.0.0/12`
- All of `192.168.0.0/16`
- All of `100.64.0.0/10` (CGNAT)
- `0.0.0.0/8`
- IPv6: `::1`, `fe80::/10`, `fc00::/7`, `fd00::/8`
- IPv4-mapped IPv6
- `metadata.google.internal`, `metadata.aws.internal`, `metadata.azure.com`
- `localhost`, `*.localhost`, `localhost.localdomain`

### #34 — `server.ts validateFilePath` sibling path traversal

Same `startsWith` bug as #32 but in a different place — the Mission Control file manager's path validator. An attacker supplying `path=/home/dj/workspace-evil/file` where `basePath=/home/dj/workspace` would have the sibling path accepted as within-root.

**Fix:** Same `basePathWithSep` pattern from #32.

## Regression tests

New `tests/security-validators.test.ts` with **102 cases**:

- **#31 guardrails** — 25 MUST_BLOCK (every rm -rf variant on every top-level dir, dd to devices, mkfs variants, shutdown/reboot/halt/poweroff, curl|bash variants, fork bomb, chmod 777, redirect to /etc) + 10 MUST_PASS (scoped subpath rms, normal operations, curl without shell pipe)
- **#31 executeCode.isSafe** — 13 MUST_BLOCK + 6 MUST_PASS
- **#32 filesystem.validatePath** — path-boundary tests for `/tmpfoo` rejection, legitimate `/tmp/*` subdirs, exact `/tmp`, sibling home rejection, system directory rejection, plus direct `isWithinDir` helper tests (exact match, separator boundary, prefix false-positives)
- **#32 knowledge_base.isAllowedFilePath** — `/tmpfoo` rejection, legit `/tmp/*` subdirs, sensitive files in home blocked
- **#32 event_triggers.isAllowedWatchPath** — `/tmpfoo` rejection, legit `/tmp/*` watchers, system directories rejected, sensitive-pattern-in-home rejected
- **#33 knowledge_base.isBlockedUrl SSRF** — 28 MUST_BLOCK (all RFC 1918 ranges, 127/8, 169.254/16, CGNAT, IPv6 variants, IPv4-mapped IPv6, non-HTTP schemes, metadata hostnames) + 5 MUST_PASS (real public URLs)
- **#34 server.validateFilePath** — source-level lint asserting the `basePathWithSep` + exact-match check is in place

All 102 tests passing.

## Files modified

- `src/agent/guardrails.ts` — rewrote DANGEROUS_COMMANDS, exported for testing
- `src/skills/builtin/executeCode.ts` — rewrote BLOCKED_PATTERNS, exported `isSafe`
- `src/skills/builtin/filesystem.ts` — new `isWithinDir` helper, exported `validatePath`
- `src/skills/builtin/knowledge_base.ts` — full rewrite of `isBlockedUrl` (28-case SSRF coverage), exported `isBlockedUrl` + `isAllowedFilePath`
- `src/skills/builtin/event_triggers.ts` — `isAllowedWatchPath` uses boundary check, exported
- `src/gateway/server.ts` — `validateFilePath` uses `basePathWithSep`
- `tests/security-validators.test.ts` — NEW 102-case regression suite
- `tests/fixtures/hunt/31-34-validator-audit/README.md` — this doc

**5,291 tests pass.** Typecheck clean. Deployed to Titan PC and verified live.

## Class-level lessons (on top of #28)

1. **If one validator has a bug, search for copies of the same regex.** TITAN had THREE separate `rm -rf /` validators (shell.ts, guardrails.ts, executeCode.ts), all with the same `(?!tmp)` hole. There's no single source of truth for "dangerous commands" — fixing #28 only fixed 1 of 3. Consider consolidating to a single shared `src/security/danger.ts` module that all three call into.

2. **`startsWith` on paths is almost always wrong.** Use a path-separator boundary check (`child === parent || child.startsWith(parent + '/')`) or a proper path library. TITAN had FOUR copies of the naive startsWith bug in four different files. Add a lint rule.

3. **SSRF allowlists must cover ALL reserved IP ranges, not just the famous ones.** Cloud metadata (169.254.169.254) gets the headlines, but the entire 169.254.0.0/16 link-local space is reachable. Same for 127.0.0.0/8 (not just 127.0.0.1), 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, and every IPv6 private range. Any one of those pointed at a local service bypasses the entire SSRF guard.

4. **Scheme allowlisting beats scheme blocklisting.** `if (protocol === 'file:') return true` blocks exactly one bad scheme. `if (protocol !== 'http:' && protocol !== 'https:') return true` blocks everything unexpected. Finding #33's original code used the blocklist approach, leaving `gopher:`, `ftp:`, `dict:`, etc. open.
