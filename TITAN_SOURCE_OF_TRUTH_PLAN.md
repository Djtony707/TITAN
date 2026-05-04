# TITAN Source-of-Truth Plan

**Based on:** TITAN Universe Recon Report (2026-05-03)  
**Mission:** Decide active source of truth, identify stale copies, and organize everything safely.  
**Status:** Recommendation only — no files edited yet.  

---

## 1. Recommended Active TITAN Repo

### Primary Source of Truth: `titan:/opt/TITAN`

**Why this wins:**
- It is the **live production instance** — systemd `titan.service` runs from here
- It is **clean on `main`**, up to date with `origin/main`
- It has **already built successfully** (`npm run build` works, `dist/` exists)
- The **2026-04-20 audit doc** explicitly names it as "live operational source of truth"
- It is indexed by GitNexus on the Titan PC (2100 files, 58453 nodes)

### Secondary/Dev Copy: `macbook:~/Desktop/TitanBot/TITAN-main`

**Role:** Local development workspace on the MacBook.  
**Current issue:** 1 commit ahead of origin (handoff doc `95fbb07`). `npm test` hangs.  
**Rule:** Pull from `/opt/TITAN` before dev work. Push back through origin/main. Never direct-copy between machines.

### Published Snapshot: `titan:~/titan-publish`

**Role:** Release snapshot at tag `v5.5.3`. Contains built artifacts, systemd service files, voice UI.  
**Rule:** Keep as-is. Do not develop here. Use for reference only.

---

## 2. Folders That Appear Stale (Candidates for Archive/Delete)

These are old copies, empty folders, or recovered artifacts that clutter the workspace:

### MacBook
| Folder | Why Stale | Action |
|---|---|---|
| `~/TITAN` (home dir) | Completely empty | **Delete** |
| `~/titan-workspace` | Old runtime db from Feb 20 | **Archive to ~/Backups/ then delete** |
| `~/recovered-titanbot` | Recovery artifacts | **Archive or delete** |
| `~/titan-publish` | Old published build | **Delete** (superseded by Titan PC version) |

### Titan PC
| Folder | Why Stale | Action |
|---|---|---|
| `~/Desktop/TITAN` | Static docs folder (TITAN_IS_COMPLETE.md) | **Archive docs, then delete folder** |
| `~/Desktop/TITAN_GitHub` | Old copy with just openclaw_research.md | **Delete** |
| `~/Desktop/TITAN_Original_Project` | Original research | **Archive, then delete** |
| `~/Desktop/NewTitan22626` | Unknown purpose, contains `.claude/` and `titan/` | **Inspect contents, likely archive** |
| `~/titan-api-test` | Small test folder | **Delete** |
| `~/titan-voice-server` | May be superseded by voice stack in `/opt/TITAN` | **Verify, then delete if redundant** |
| `~/titanbot-final-backup-20260202-1952.tar.gz` | 3.8GB old backup | **Move to external/backup storage** |

### ⚠️ Before Deleting Anything
- Tony must approve each deletion
- Use `trash` or `mv to-archive/` — never `rm -rf`
- Document what was archived and where

---

## 3. Folders That Are Important But Separate

These are **not stale** — they are active, separate projects that should remain independent:

| Folder | Project | Relationship to TITAN | Git Status |
|---|---|---|---|
| `~/Desktop/titan-synapse` (MacBook) | Rust/Python AI model architecture | TITAN may use this model in the future | 🔴 Uncommitted changes |
| `~/titan-saas` (Titan PC) | Next.js SaaS dashboard | TITAN's commercial web UI | 🔴 Many uncommitted changes |
| `~/workspace/titanbot` (Titan PC) | Python bot (wallets, X automation) | Unclear — possibly experimental | Unknown |
| `~/Projects/titan-eye` (MacBook) | Small utility project | Separate tool | Unknown |
| `~/Desktop/TITAN.wiki` (MacBook) | GitHub wiki | Public docs for TITAN | Clean |

### Recommended Organization
```
~/projects/
  titan-core/          → symlink or clone of /opt/TITAN
  titan-synapse/       → move from Desktop, keep as separate repo
  titan-saas/          → move from home, keep as separate repo
  titan-eye/           → keep as-is
```

---

## 4. Files/Docs That Should Be Copied Into the Active Repo

The active repo (`/opt/TITAN`) currently lacks some docs that exist elsewhere. These should be consolidated:

### From MacBook
| File | Current Location | Target in Active Repo |
|---|---|---|
| `HANDOFF-2026-05-03.md` | `macbook:~/Desktop/TitanBot/TITAN-main/docs/` | Already in repo — **push to origin** |
| `TITAN-Growth-Strategy.md` | `~/TITAN-Growth-Strategy.md` | `docs/roadmap/growth-strategy.md` |
| `TITAN-Launch-Posts.md` | `~/TITAN-Launch-Posts.md` | `docs/roadmap/launch-posts.md` |
| `TITAN-Teaser-Scripts-V2.md` | `~/TITAN-Teaser-Scripts-V2.md` | `docs/marketing/teaser-scripts.md` |

### From Titan PC
| File | Current Location | Target in Active Repo |
|---|---|---|
| `TITAN-PC-AUDIT-2026-04-20.md` | `titan:~/titan-publish/docs/` | `docs/debugging/pc-audit-2026-04-20.md` |
| `TITAN_IS_COMPLETE.md` | `titan:~/Desktop/TITAN/` | `docs/roadmap/completion-summary.md` |
| `synapse_paper.md` | `titan:~/synapse_paper.md` | `docs/architecture/synapse-paper.md` |

### Teaser Video
| File | Action |
|---|---|
| `~/TITAN-Teaser.mp4` | Move to `assets/videos/` or host on CDN — do not commit 13MB video to git |

---

## 5. Suggested Docs Structure

Create this under `/opt/TITAN/docs/` (and mirror on MacBook):

```
docs/
├── README.md                    # "Start here" index
├── architecture/
│   ├── ARCHITECTURE.md          # (existing)
│   ├── ARCHITECTURE-TODO.md   # (existing)
│   ├── system-prompt-research.md
│   └── synapse-paper.md         # (from titan-synapse)
├── prompts/
│   ├── system-prompts/          # (move from src/promptincludes)
│   └── agent-prompts/
├── roadmap/
│   ├── growth-strategy.md       # (from home dir)
│   ├── launch-posts.md          # (from home dir)
│   ├── completion-summary.md    # (from Desktop/TITAN)
│   └── 100-plan.md            # (from titan-publish)
├── debugging/
│   ├── pc-audit-2026-04-20.md   # (from titan-publish)
│   ├── handoff-2026-05-03.md    # (existing)
│   └── common-issues.md         # (new)
├── guides/
│   ├── install.md
│   ├── gateway-setup.md
│   ├── ollama-setup.md
│   ├── discord-setup.md
│   └── voice-setup.md
├── marketing/
│   ├── teaser-scripts.md        # (from home dir)
│   └── social-posts.md          # (from home dir)
└── decisions/
    └── ADR-001-soma.md          # (from titan-publish)
```

**Rule:** Every doc gets a header with `date`, `author`, `status` (draft/proposed/approved/obsolete).

---

## 6. Git Cleanup Plan

### MacBook
```bash
cd ~/Desktop/TitanBot/TITAN-main

# Step 1: See what the handoff doc commit contains
git show 95fbb07 --stat

# Step 2: If Tony approves, push it
git push origin main

# Step 3: After push, verify Titan PC can pull it
ssh titan 'cd /opt/TITAN && git pull origin main'
```

### Titan PC
```bash
# titan-saas: Commit the work
ssh titan 'cd ~/titan-saas && git add -A && git commit -m "wip: saas dashboard — checkpoint $(date +%Y-%m-%d)"'

# titan-synapse: Commit the work
ssh titan 'cd ~/titan-synapse && git add -A && git commit -m "wip: synapse model architecture updates"'
```

### Global
- Add `docs/decisions/` to `.gitignore`? No — keep decisions in repo.
- Add `*.mp4` to `.gitignore` if not already there.
- Ensure `.env*` files are in `.gitignore` (already should be).

---

## 7. MacBook ↔ Titan PC Sync Plan

### Philosophy
- **Titan PC `/opt/TITAN`** = production. Changes here affect the live gateway.
- **MacBook `TITAN-main`** = development. Experiment freely here.
- **Sync method:** Git only. No `rsync`, no `scp`, no manual file copies.

### Workflow
```
MacBook dev → git commit → git push origin main
                                      ↓
Titan PC production ← git pull origin main ← npm run build ← systemctl restart titan
```

### Safe Sync Commands

**MacBook → Origin (push dev work):**
```bash
cd ~/Desktop/TitanBot/TITAN-main
git status          # verify clean
git log --oneline -5  # verify what you're pushing
git push origin main
```

**Titan PC → Origin (pull to production):**
```bash
ssh titan 'cd /opt/TITAN && git status && git pull origin main && npm run build'
# Then restart service:
ssh titan 'sudo systemctl restart titan'
```

### Emergency Rollback
If a push breaks production:
```bash
ssh titan 'cd /opt/TITAN && git log --oneline -5'
ssh titan 'cd /opt/TITAN && git revert HEAD --no-edit && npm run build'
ssh titan 'sudo systemctl restart titan'
```

### What Never to Do
- ❌ Never `rsync` or `scp` between MacBook and Titan PC
- ❌ Never edit files directly in `/opt/TITAN` without committing
- ❌ Never `npm install` in `/opt/TITAN` without testing on MacBook first
- ❌ Never run `git push --force` on main

---

## 8. GitNexus Integration Plan

### Current State
- MacBook GitNexus indexes `~/Desktop/TitanBot/TITAN-main`
- Titan PC GitNexus indexes `/opt/TITAN`
- Both point to commit `462a86ad` (but MacBook is now at `95fbb07`)

### Recommended Setup
1. **Re-index both machines** after the sync is complete:
   ```bash
   # On MacBook
   gitnexus analyze --name TITAN --path ~/Desktop/TitanBot/TITAN-main
   
   # On Titan PC
   gitnexus analyze --name TITAN --path /opt/TITAN
   ```
2. **Add titan-synapse and titan-saas** as separate GitNexus projects:
   ```bash
   gitnexus analyze --name titan-synapse --path ~/titan-synapse
   gitnexus analyze --name titan-saas --path ~/titan-saas
   ```
3. **Use GitNexus for cross-machine queries** — "What depends on `gateway/server.ts`?" should work regardless of which machine you're on.

---

## 9. What Needs Tony Approval Before Touching Anything

| Action | Why Approval Needed |
|---|---|
| **Push the handoff doc** (`95fbb07`) to origin/main | It changes the public repo. Need to review contents. |
| **Commit titan-saas uncommitted work** | Large WIP commit — need to know if it's ready to save or discard. |
| **Commit titan-synapse uncommitted work** | Model changes — may be experimental or proprietary. |
| **Delete any stale folder** | Could delete something important. Must review each. |
| **Move docs into active repo** | Restructures the repo. Need to agree on structure. |
| **Restart titan.service on Titan PC** | Affects live production. Only after build verification. |
| **Create `docs/` subdirectories** | Changes repo structure. Should align with Tony's preference. |
| **Re-index GitNexus** | Non-destructive but uses compute. Better to batch with other tasks. |
| **Investigate `~/workspace/titanbot`** | Contains wallet and X automation code. Could be sensitive. |

---

## 10. One Safest Next Action

**Do this first. Everything else waits.**

### Step: Review the handoff doc on the MacBook

```bash
cd ~/Desktop/TitanBot/TITAN-main
git show 95fbb07:docs/HANDOFF-2026-05-03.md
```

**Why this is the safest next step:**
1. It's **read-only** — zero risk
2. It tells us **what the previous agent already planned** — prevents duplicate work
3. It helps us decide **whether to push it** or keep it local
4. It's the **only difference** between MacBook and Titan PC repos
5. Once reviewed, we can decide the real next step (push, edit, or discard)

**After reviewing, Tony decides:**
- ✅ "Push it" → I push to origin, then pull to Titan PC
- 📝 "Edit it first" → I open it, we edit, then push
- 🗑️ "Discard it" → I reset the MacBook to origin/main

---

*Plan compiled by KIMI-COO 🧠 | No files edited | Awaiting Tony approval for all actions.*
