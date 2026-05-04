# Known Issues

> Bugs, broken things, workarounds, and suspicious behavior.
> Each entry is a typed memory.

---

## Issue: npm test appears to hang

- **type:** BUG
- **date:** 2026-05-03
- **source:** KIMI-COO observation
- **confidence:** high
- **verified_by:** `npx vitest run --reporter=basic` completed successfully
- **content:** Running `npm test` (which uses default vitest reporter) appears to hang with no output. Root cause: test suite takes ~181s to complete, and the default command timeout is too short. The tests are NOT broken — they just take ~3 minutes.
- **workaround:** Use `npx vitest run --reporter=basic` or wait longer. For fast feedback, run `npx vitest run tests/unit/` (~8s).
- **review_after:** 2026-05-10

## Issue: Version mismatch between package.json and README

- **type:** BUG
- **date:** 2026-05-03
- **source:** KIMI-COO observation
- **confidence:** high
- **verified_by:** File read
- **content:** `package.json` says v5.5.3 but `README.md` says v5.4.3. Needs sync.
- **workaround:** None — cosmetic issue.
- **review_after:** Next release

## Issue: MacBook repo 1 commit ahead of origin

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO observation
- **confidence:** high
- **verified_by:** `git status` and `git log`
- **content:** MacBook `TITAN-main` has commit `95fbb07` (handoff doc) not present on origin or Titan PC. Risk of divergence.
- **workaround:** Push the commit or reset to origin/main.
- **review_after:** Next session

## Issue: titan-saas has uncommitted work on Titan PC

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO recon
- **confidence:** high
- **verified_by:** `ssh titan 'cd ~/titan-saas && git status'`
- **content:** Titan PC `~/titan-saas` has many modified files and untracked files. Risk of losing work if machine crashes or disk fails.
- **workaround:** Commit the work or decide to discard.
- **review_after:** Next session

## Issue: titan-synapse has uncommitted work on MacBook

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO recon
- **confidence:** high
- **verified_by:** `git status` in titan-synapse folder
- **content:** MacBook `~/Desktop/titan-synapse` has uncommitted Rust/Python changes.
- **workaround:** Commit the work or decide to discard.
- **review_after:** Next session

## Issue: Stale TITAN folders on Titan PC Desktop

- **type:** RISK
- **date:** 2026-05-03
- **source:** KIMI-COO recon
- **confidence:** medium
- **verified_by:** `ssh titan 'ls -la ~/Desktop/'`
- **content:** Titan PC Desktop has `TITAN`, `NewTitan22626`, `TITAN_GitHub`, `TITAN_Original_Project` — potentially stale copies that could confuse future work.
- **workaround:** Archive and delete after Tony confirms they're not needed.
- **review_after:** Next session

---

*Last updated: 2026-05-03 by KIMI-COO 🧠*
