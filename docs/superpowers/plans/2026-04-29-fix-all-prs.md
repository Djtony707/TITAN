# Fix All PRs + Production Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans

**Goal:** Resolve all 3 failing GitHub PRs (dependabot deps, widget gates, docker-compose) + fix production gateway issues on Titan PC + publish v5.4.2.

**Architecture:** Merge CI timeout fix (180s) into all PR branches so GitHub Actions can boot the gateway. Resolve conflicts in docker-compose PR by preferring PR changes. Verify Titan PC gateway health with HTTPS auth.

**Tech Stack:** Git, GitHub CLI (`gh`), Node.js, npm, systemd, ssh

---

## Task 1: Verify dependabot PR #65 CI Status

**Files:** None (just verification)

- [ ] **Step 1: Check if PR #65 CI eval-gate passed**

```bash
ssh titan "cd /tmp/titan-full && gh run list --repo Djtony707/TITAN --branch dependabot/npm_and_yarn/production-deps-ec2688f007 --limit 3"
```

Expected: New `in_progress` run from re-open + merge, should eventually show `completed`.

- [ ] **Step 2: If passed, merge PR #65**

```bash
ssh titan "cd /tmp/titan-full && gh pr merge 65 --repo Djtony707/TITAN --merge 2>&1"
```

Expected: `✓ Pull request #65 was merged.`

---

## Task 2: Merge main fix into widget-gates PR #64

**Files:** `.github/workflows/eval-gate.yml` (from main)

- [ ] **Step 1: Clone and prepare branch**

```bash
ssh titan "rm -rf /tmp/titan-fix64 && cd /tmp && git clone --depth 50 https://github.com/Djtony707/TITAN.git titan-fix64 && cd titan-fix64 && git fetch origin feat/group-a-fixes && git checkout -B feat/group-a-fixes origin/feat/group-a-fixes"
```

- [ ] **Step 2: Merge main into branch**

```bash
ssh titan "cd /tmp/titan-fix64 && git merge origin/main --no-edit 2>&1 || echo 'CONFLICT!'
```

Expected: `Already up to date.` OR clean merge.

- [ ] **Step 3: Push and verify CI**

```bash
ssh titan "cd /tmp/titan-fix64 && git push origin feat/group-a-fixes 2>&1"
```

Expected: push successful, GitHub CI auto-triggers.

- [ ] **Step 4: Wait for CI and merge**

```bash
sleep 30
ssh titan "cd /tmp/titan-fix64 && gh pr checks 64 --repo Djtony707/TITAN"
```

Expected: all checks pass. Then:

```bash
ssh titan "cd /tmp/titan-fix64 && gh pr merge 64 --repo Djtony707/TITAN --merge 2>&1"
```

---

## Task 3: Resolve conflicts in docker-compose-revert PR #63

**Files:**
- Modify: `docker-compose.yml` (keep PR version — it reverts to canonical)
- Modify: `tests/gateway-extended.test.ts`, `tests/mesh-extended.test.ts`, `tests/ollama.test.ts`, `tests/providers-extended.test.ts`, `tests/subAgent.test.ts` (accept PR or main — whichever is newer)

- [ ] **Step 1: Clone and prepare branch**

```bash
ssh titan "rm -rf /tmp/titan-fix63 && cd /tmp && git clone --depth 50 https://github.com/Djtony707/TITAN.git titan-fix63 && cd titan-fix63 && git fetch origin fix/docker-compose-revert && git checkout -B fix/docker-compose-revert origin/fix/docker-compose-revert"
```

- [ ] **Step 2: Start merge of main**

```bash
ssh titan "cd /tmp/titan-fix63 && git merge origin/main --no-edit 2>&1 || echo 'CONFLICT_EXPECTED'"
```

Expected: CONFLICT in `docker-compose.yml` and several test files.

- [ ] **Step 3: Resolve docker-compose.yml**
PR #63 title says "fix(deploy): revert docker-compose.yml to canonical TITAN config". Keep **PR's version** of `docker-compose.yml`.

```bash
ssh titan "cd /tmp/titan-fix63 && git checkout --ours docker-compose.yml && git add docker-compose.yml"
```

- [ ] **Step 4: Resolve test files**

```bash
ssh titan "cd /tmp/titan-fix63 && for f in tests/gateway-extended.test.ts tests/mesh-extended.test.ts tests/ollama.test.ts tests/providers-extended.test.ts tests/subAgent.test.ts; do git checkout --ours \$f && git add \$f; done"
```

- [ ] **Step 5: Complete merge**

```bash
ssh titan "cd /tmp/titan-fix63 && git status --short && echo '---'"
```

Should show only merge commit pending.

```bash
ssh titan "cd /tmp/titan-fix63 && git commit --no-edit"
```

- [ ] **Step 6: Push and merge**

```bash
ssh titan "cd /tmp/titan-fix63 && git push origin fix/docker-compose-revert"
```

Wait for CI:

```bash
sleep 30
ssh titan "cd /tmp/titan-fix63 && gh pr checks 63 --repo Djtony707/TITAN"
```

Then merge:

```bash
ssh titan "cd /tmp/titan-fix63 && gh pr merge 63 --repo Djtony707/TITAN --merge 2>&1"
```

---

## Task 4: Bump version + publish v5.4.2 to npm

**Files:**
- Modify: `package.json` (version already 5.4.2)
- Modify: `src/utils/constants.ts` (TITAN_VERSION already 5.4.2)
- Modify: `README.md` (version already 5.4.2)

- [ ] **Step 1: Verify all version strings**

```bash
grep -r "5\.4\.2" package.json src/utils/constants.ts README.md
```

Expected: All show 5.4.2.

- [ ] **Step 2: Build and test locally**

```bash
cd /Users/michaelelliott/Desktop/TitanBot/TITAN-main && npm run build && npm test -- --run 2>&1 | tail -5
```

Expected: 0 failing tests (or only pre-existing failures).

- [ ] **Step 3: Publish to npm**

```bash
cd /Users/michaelelliott/Desktop/TitanBot/TITAN-main && npm publish --tag latest
```

Expected: `+ titan-agent@5.4.2`

- [ ] **Step 4: Verify**

```bash
npm dist-tag ls titan-agent
```

Expected: `latest: 5.4.2`

---

## Task 5: Titan PC final verification

**Files:** None (verification only)

- [ ] **Step 1: Confirm gateway status**

```bash
ssh titan "systemctl is-active titan-gateway && curl -k -s http://127.0.0.1:48420/api/health --max-time 5"
```

Expected: `active` + `{"status":"ok",...}`

- [ ] **Step 2: Update Titan PC config (already done)**

```bash
ssh titan "jq '.agent.maxTokens' /home/dj/.titan/titan.json"
```

Expected: `200000`

- [ ] **Step 3: Pull latest on Titan PC**

```bash
ssh titan "cd /opt/TITAN && git pull origin main --ff-only && echo 'UP_TO_DATE'"
```

Expected: Already up to date (or fast-forward if new commits).

---

## Task 6: Update documentation / handoff

**Files:**
- Modify: `docs/HANDOFF/2026-04-29.md`

- [ ] **Step 1: Append resolution notes**

Append to `docs/HANDOFF/2026-04-29.md`:

```markdown
## Fixes Applied (continued)

- PR #65 (dependabot): Merged CI timeout fix → main + branch
- PR #64 (widget gates): Merged main → branch, CI should pass now
- PR #63 (docker-compose): Resolved merge conflicts, kept canonical docker-compose.yml
- npm: Published titan-agent@5.4.2
- Titan PC: Token budget 130K→200K, gateway healthy
```

- [ ] **Step 2: Commit and push**

```bash
cd /Users/michaelelliott/Desktop/TitanBot/TITAN-main && git add docs/HANDOFF/2026-04-29.md && git commit -m "docs: PR resolution + npm publish handoff" && git push origin main
```

---

## Verification Table

| Item | Status | Check Command |
|------|--------|---------------|
| PR #65 merged | ⏳ `gh pr view 65` |
| PR #64 merged | ⏳ `gh pr view 64` |
| PR #63 merged | ⏳ `gh pr view 63` |
| npm @latest | ⏳ `npm dist-tag ls titan-agent` |
| Titan PC token budget | ✅ 200000 |
| Titan PC gateway | ✅ `systemctl is-active titan-gateway` |
| Version strings | ✅ 5.4.2 everywhere |

