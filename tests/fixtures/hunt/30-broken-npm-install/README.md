# Hunt Finding #30 — `npm install titan-agent@latest` was completely broken

**Date:** 2026-04-14
**Severity:** CRITICAL — every new user who tried to install titan-agent from npm got a hard failure
**Discovered during:** Phase 1 first-run gauntlet

## Symptom

I ran the literal "Phase 1.1: simulate a brand-new npm user" scenario:

```bash
mkdir /tmp/titan-firstrun-test
cd /tmp/titan-firstrun-test
npm init -y
npm install titan-agent@latest
```

Result:

```
npm error command failed
npm error command sh -c node scripts/postinstall.cjs
npm error Error: Cannot find module '/private/tmp/titan-firstrun-test/node_modules/titan-agent/scripts/postinstall.cjs'
npm error code: 'MODULE_NOT_FOUND'
```

**Every new user trying `npm install titan-agent` since v3.2.3 was published got this exact failure.** The package was effectively unusable from npm. The npm version (3.2.3 according to `npm view titan-agent version`) was published with `package.json` declaring `"postinstall": "node scripts/postinstall.cjs"` but the published tarball **did not contain the `scripts/` directory at all**.

Verification by inspecting the actual tarball:

```bash
cd /tmp && npm pack titan-agent@3.2.3
tar tzf titan-agent-3.2.3.tgz | grep scripts
# Output: only `package/assets/agent-skills/idea-refine/scripts/idea-refine.sh`
# (no package/scripts/ directory at all)
```

## Root cause

Two layered bugs:

### (1) Published tarball missing the `scripts/` directory

`package.json` declares:
```json
"files": ["dist/", "ui/dist/", "assets/", "docs/", "scripts/", ...]
```

And there's no `.npmignore`. A local `npm pack --dry-run` correctly includes every file under `scripts/`. So the source state is fine — but somehow when v3.2.3 was published (presumably via the `.github/workflows/publish.yml` GitHub Action, which runs `npm publish` after `npm ci`/`npm run build`), the `scripts/` directory ended up missing from the published tarball. Most likely cause: an older `.npmignore` was present at publish time and removed afterwards, or the publish was done from a different working tree.

We don't need to know exactly *why* it happened in the past — we need to make sure it can never happen again.

### (2) Postinstall script crashes the entire install on missing file

```json
"postinstall": "node scripts/postinstall.cjs"
```

The `node scripts/postinstall.cjs` command fails hard with `MODULE_NOT_FOUND` if the file isn't there. npm interprets the non-zero exit code from postinstall as install failure, leaves the package in a half-installed state, and aborts. **There's no graceful degradation.** A single missing optional script broke every install.

## Fix

### (a) Make postinstall self-healing — never crash on missing file

Changed the postinstall command to a defensive node `-e` that catches `MODULE_NOT_FOUND` and falls back to a friendly message:

```json
"postinstall": "node -e \"try{require('./scripts/postinstall.cjs')}catch(e){if(e.code==='MODULE_NOT_FOUND'){console.log('TITAN installed. Run: titan onboard')}else{throw e}}\""
```

This means:
- If `scripts/postinstall.cjs` is in the package → the real onboarding logic runs (current expected behavior)
- If it's missing for any reason → install completes successfully, user sees "TITAN installed. Run: titan onboard" instead of a crash
- If the script exists but throws a different error → the error still propagates (we don't silently swallow real bugs)

This is the kind of defense that should have always been there. A non-essential post-install hook should never be allowed to gate the entire install.

### (b) Bump version to 3.2.4

The broken version is permanently published to npm at 3.2.3. The only way to fix existing users is to publish a new version that overrides it.

Bumped `package.json` `version` and `src/utils/constants.ts` `TITAN_VERSION` from `3.2.3` → `3.2.4`. Updated test fixtures (`tests/core.test.ts` and `tests/mission-control.test.ts`) to expect the new version.

### (c) Verified install end-to-end against a local pack

Ran the full first-run flow with the fixed package:

**Test A — postinstall.cjs present (the normal case):**
```
$ npm install /tmp/titan-agent-3.2.4.tgz
✓ ok
$ node node_modules/titan-agent/dist/cli/index.js --version
3.2.4
```

**Test B — postinstall.cjs deliberately deleted from the tarball (simulating the historical npm bug):**
```
$ tar xzf titan-agent-3.2.4.tgz && rm package/scripts/postinstall.cjs && tar czf broken.tgz package
$ npm install broken.tgz
✓ ok  (prints "TITAN installed. Run: titan onboard")
$ node node_modules/titan-agent/dist/cli/index.js --version
3.2.4
```

Both scenarios complete successfully. The defense holds whether or not the script is present.

## Verification on deployed gateway

After deploying 3.2.4 to Titan PC:

```
$ curl https://192.168.1.11:48420/api/health
{"status":"ok","version":"3.2.4","uptime":11.96,"onboarded":true}
```

Live and healthy.

## Files modified

- `package.json` — version 3.2.3 → 3.2.4, postinstall hardened
- `src/utils/constants.ts` — `TITAN_VERSION` bumped
- `tests/core.test.ts` — expected version
- `tests/mission-control.test.ts` — expected version (4 occurrences)
- `tests/fixtures/hunt/30-broken-npm-install/README.md` — this doc

5,189 tests pass. Typecheck clean. Deployed.

**To unbreak existing npm users, run `npm publish` from a machine with the npm credentials.** Once 3.2.4 is on the registry, anyone running `npm install titan-agent@latest` gets the working version.

## Class-level lessons

1. **Lifecycle scripts must NEVER hard-fail on missing optional behavior.** Postinstall is for nice-to-have setup hooks (onboarding wizards, native module compilation, schema migrations). It must NEVER gate the install itself. If your postinstall references files outside `dist/` or core code, wrap them in defensive try/catch with a missing-file branch that exits 0.

2. **`npm install <package-name>@latest` is the single most-run command in your distribution chain.** It deserves an end-to-end test that runs in CI on every release. The current `.github/workflows/publish.yml` publishes the package but never installs it from the published registry afterward to verify it actually works. A 30-second post-publish sanity test (`npm pack` → install in a tmpdir → run `--version`) would have caught this immediately.

3. **The `files` array in package.json is necessary but not sufficient.** Even with the correct `files` declaration, the actual published tarball can drift from local expectations due to `.npmignore`, CI environment differences, or manual publishes. Always inspect what `npm pack --dry-run` outputs locally AND what `npm view <pkg>` shows is published — they should match.

4. **Critical user-facing failures should be tested by simulating the user, not by reading code.** This bug had been live on npm since v3.2.3 was published. The 5,041 mocked unit tests passing the entire time gave zero signal. The Phase 1 "literally run `npm install`" scenario caught it in the first 10 seconds. The hunt protocol works exactly as designed.
