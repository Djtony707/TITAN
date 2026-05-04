# Skill Candidates

> Workflows repeated 3+ times get drafted as skill candidates.
> Do not install or activate automatically. Save here for Tony review.

---

## Skill Candidate: TITAN Test Runner

- **trigger_count:** 2 (need 1 more to promote)
- **name:** titan-test-runner
- **purpose:** Run TITAN tests with correct flags for speed and reliability.
- **trigger_phrase:** "run TITAN tests" or "test TITAN" or "npm test"
- **inputs:** test_subset (optional: 'unit', 'full', or specific file)
- **steps:**
  1. Check if `vitest.config.ts` exists
  2. If unit subset: `npx vitest run --reporter=basic tests/unit/` (~8s)
  3. If full suite: `npx vitest run --reporter=basic` (~180s)
  4. If specific file: `npx vitest run --reporter=verbose <file>`
- **safety_limits:**
  - Never run with `--no-parallel` unless debugging
  - Use `--reporter=basic` to avoid output buffer issues
  - Set timeout to 300s for full suite
- **commands:**
  - `npx vitest run --reporter=basic tests/unit/`
  - `npx vitest run --reporter=basic`
- **verification:** Check exit code 0 and "Test Files X passed" in output.
- **rollback:** N/A — test command is read-only.
- **requires_tony_approval:** no

## Skill Candidate: TITAN Recon

- **trigger_count:** 1 (need 2 more to promote)
- **name:** titan-recon
- **purpose:** Map all TITAN-related folders, repos, and runtime data across machines.
- **trigger_phrase:** "where is TITAN" or "TITAN recon" or "find TITAN"
- **inputs:** machine (macbook, titan, or both)
- **steps:**
  1. Run `find ~ -maxdepth 4` with TITAN-related patterns
  2. Check `~/.gitnexus/registry.json`
  3. For each repo found: `git status`, `git branch`, `git remote -v`
  4. Check for `.titan` runtime folders
  5. Look for marketing/docs files in home dir
- **safety_limits:**
  - Exclude `node_modules`, `.git`, `.ssh`, keychain folders
  - Never print secrets
  - Read-only only
- **commands:**
  - `find ~ -maxdepth 4 \( -iname "*titan*" -o -iname "*gitnexus*" \) ...`
  - `cat ~/.gitnexus/registry.json`
- **verification:** Produces list of paths with git status for each.
- **rollback:** N/A — read-only.
- **requires_tony_approval:** no

## Skill Candidate: Repo Sync Check

- **trigger_count:** 1 (need 2 more to promote)
- **name:** titan-sync-check
- **purpose:** Compare MacBook and Titan PC repo states before syncing.
- **trigger_phrase:** "are we in sync" or "check sync" or "compare repos"
- **inputs:** repo_path_macbook, repo_path_titan_pc
- **steps:**
  1. Get MacBook: `git log --oneline -5`, `git status`
  2. Get Titan PC via ssh: `git log --oneline -5`, `git status`
  3. Compare commit hashes
  4. Check for uncommitted changes on both
  5. Report divergence
- **safety_limits:**
  - Read-only only
  - Never push or pull without approval
- **commands:**
  - `git log --oneline --graph --left-right --decorate origin/main...HEAD`
  - `ssh titan 'cd /opt/TITAN && git log --oneline -5 && git status'`
- **verification:** Produces clear divergence report.
- **rollback:** N/A — read-only.
- **requires_tony_approval:** no

---

*Last updated: 2026-05-03 by KIMI-COO 🧠*
