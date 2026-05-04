# TITAN Universe Recon Report

**Mission:** Map all TITAN-related code, docs, notes, prompts, GitNexus files, and runtime folders across MacBook and Titan PC.
**Date:** 2026-05-03
**Mode:** Recon only — no edits, no installs, no commits, no pushes, no remote changes.

---

## 1. Machines Inspected

| Machine | Hostname | User | Role |
|---|---|---|---|
| MacBook (local) | MacBook-Pro-2.lan | michaelelliott | Dev/COO workspace |
| Titan PC (remote) | dj-Z690-Steel-Legend-D5 | dj | Production build/runtime server |

---

## 2. Local MacBook Locations Found

### 2A. `~/Desktop/TitanBot/TITAN-main` ⭐ PRIMARY LOCAL REPO
- **Type:** Repo (source code)
- **Git branch:** `main`
- **Dirty state:** Clean working tree
- **Remote URL:** `https://github.com/Djtony707/TITAN.git`
- **Commits ahead of origin:** **1 commit** (`95fbb07` — adds `docs/HANDOFF-2026-05-03.md`, 114 lines)
- **Main files found:** `README.md`, `package.json` (v5.5.3), `ARCHITECTURE.md`, `ARCHITECTURE-TODO.md`, `src/`, `ui/`, `tests/`, `gateway/`, `skills/`, `.env.example`
- **GitNexus:** Indexed at `/Users/michaelelliott/Desktop/TitanBot/TITAN-main` (1342 files, 29918 nodes)
- **Importance score:** 5/5
- **Notes:** This is the primary local dev copy. It has a handoff document not yet pushed to origin. `npm test` hangs indefinitely (known issue). `.titan` runtime folder exists in home dir.

### 2B. `~/Desktop/TITAN.wiki`
- **Type:** Docs (GitHub wiki)
- **Git branch:** `master`
- **Dirty state:** Clean
- **Remote URL:** `https://github.com/Djtony707/TITAN.wiki.git`
- **Main files found:** Wiki pages
- **Importance score:** 3/5
- **Notes:** Public-facing documentation.

### 2C. `~/Desktop/titan-synapse`
- **Type:** Repo (AI model architecture)
- **Git branch:** `main`
- **Dirty state:** **Uncommitted changes** (modified Rust + Python files, untracked kaggle-kernel/ and scripts/)
- **Remote URL:** `https://github.com/Djtony707/titan-synapse.git`
- **Main files found:** `Cargo.toml`, `README.md`, `package.json`, `paper/synapse_architecture.md`, `crates/synapse/src/arch/`
- **Importance score:** 4/5
- **Notes:** Rust + Python project for model architecture. Active development with uncommitted changes.

### 2D. `~/Desktop/TitanBot` (parent folder)
- **Type:** Container (not a git repo itself)
- **Git branch:** N/A (no `.git` at this level)
- **Dirty state:** Untracked files: `TITAN-main/`, `docs/`, `node_modules/`, `tmp/`, `.DS_Store`, `1`
- **Importance score:** 2/5
- **Notes:** Contains TITAN-main as subdirectory. The parent folder has its own `docs/`, `node_modules/`, `tests/` — may be an older or wrapper project.

### 2E. `~/Projects/titan-eye`
- **Type:** Repo (small project)
- **Main files found:** `package.json`, `src/`, `server/`, `data/titan-eye.db`
- **Importance score:** 2/5
- **Notes:** Appears to be a separate utility project.

### 2F. `~/titan-workspace`
- **Type:** Runtime/legacy workspace
- **Main files found:** `titan.db`, `backups/titan-backup.db`
- **Importance score:** 2/5
- **Notes:** Older workspace. Last modified Feb 20.

### 2G. `~/titan-publish`
- **Type:** Legacy publish folder
- **Main files found:** `dist/`, `titan-voice-ui/`, `ui/`
- **Importance score:** 2/5
- **Notes:** Older published build artifacts.

### 2H. `~/.titan`
- **Type:** Runtime data
- **Main files found:** `config.toml`, `activity-log.jsonl`, `audit.jsonl`, `bug-reports.jsonl`, `checkpoints/`, `browser-state/`, `command-post.json`
- **Importance score:** 3/5
- **Notes:** Local runtime data for TITAN. Not a git repo.

### 2I. `~/recovered-titanbot`
- **Type:** Recovered data
- **Importance score:** 1/5
- **Notes:** Recovery artifacts.

### 2J. `~/TITAN` (home dir folder)
- **Type:** Empty folder
- **Importance score:** 1/5
- **Notes:** Completely empty.

### 2K. Marketing/Documentation Files
| File | Content | Date |
|---|---|---|
| `~/TITAN-Growth-Strategy.md` | Growth plan: 5,500 → 50,000 downloads | Mar 9 |
| `~/TITAN-Launch-Posts.md` | Launch content/posts | Mar 9 |
| `~/TITAN-Teaser-Scripts-V2.md` | Teaser video scripts | Mar 10 |
| `~/TITAN-Teaser.mp4` | Teaser video file | Mar 10 |

### 2L. `~/.gitnexus` (GitNexus local)
- **Type:** GitNexus index
- **Contains:** `registry.json`, `groups/`
- **TITAN reference:** Indexes `~/Desktop/TitanBot/TITAN-main` (lastCommit: `462a86ad`)
- **Importance score:** 3/5

### 2M. Other Related Projects (not Tony's)
| Path | Owner | Status |
|---|---|---|
| `~/Desktop/hermes-agent` | NousResearch | Clean on main |
| `~/Desktop/paperclip` | paperclipai | Clean on master |

---

## 3. Remote Titan PC Locations Found

### 3A. `/opt/TITAN` ⭐ LIVE PRODUCTION SOURCE OF TRUTH
- **Type:** Repo (running production instance)
- **Git branch:** `main`
- **Dirty state:** Clean, up to date with `origin/main`
- **Remote URL:** `https://github.com/Djtony707/TITAN.git`
- **Latest commit:** `7c3bfc16` — v5.5.3 test suite green, drift cleanup, gateway fixes
- **Main files found:** Same structure as MacBook repo but with `dist/` built
- **GitNexus:** Indexed at `/opt/TITAN` (2100 files, 58453 nodes — larger because of build artifacts)
- **Importance score:** 5/5
- **Notes:** **This is the live operational source of truth.** TITAN gateway is actively running here as a systemd service. The audit doc (2026-04-20) explicitly states: "Make runtime/code changes there first because TITAN is actively running from that checkout."

### 3B. `~/titan` (not `/opt/TITAN`)
- **Type:** Runtime data (NOT a git repo)
- **Main files found:** `backups/`, `memory/`, `memory_index/`, `models/`, `projects/`, `runtime/`, `snapshots/`, `venvs/`, `memory_index/titan_memory.py`
- **Importance score:** 4/5
- **Notes:** Separate from `/opt/TITAN`. Contains runtime data, Python memory index, models, backups. Not version controlled.

### 3C. `~/titan-publish`
- **Type:** Published/built version
- **Git branch:** HEAD detached at `v5.5.3`
- **Dirty state:** Clean
- **Remote URL:** `https://github.com/Djtony707/TITAN.git`
- **Main files found:** Built dist, docs, skills, scripts, services, voice UI, titan-voice-agent
- **Importance score:** 4/5
- **Notes:** This is the published/npm-ready version at tag v5.5.3. Contains systemd service files, analytics server, logrotate config. Has `.gitnexus` and `.claude/skills/`.

### 3D. `~/titan-saas`
- **Type:** Repo (SaaS version)
- **Git branch:** `main`
- **Dirty state:** **Many uncommitted changes** (modified: CLAUDE.md, README.md, eslint, next.config, package.json, postcss, globals.css, layout.tsx, page.tsx, tsconfig.json + many untracked files)
- **Main files found:** `package.json`, `README.md`, Next.js app with many pages (dashboard, auth, safety, proposals, breakthroughs, etc.)
- **Importance score:** 4/5
- **Notes:** Active SaaS development with significant uncommitted work. Next.js based.

### 3E. `~/Desktop/TITAN`
- **Type:** Docs/research folder
- **Main files found:** `TITAN_IS_COMPLETE.md`, `README_NEW.md`, `PROJECT_COMPLETION_SUMMARY.md`, `SECURITY.md`, `docs/`, `research/`, `scripts/`
- **Importance score:** 3/5
- **Notes:** Documentation and completion summaries. Not a git repo.

### 3F. `~/Desktop/NewTitan22626`
- **Type:** Folder with subfolder `titan/`
- **Main files found:** `.claude/`, `titan/`
- **Importance score:** 2/5
- **Notes:** Appears to be another copy or experiment.

### 3G. `~/Desktop/TITAN_GitHub`
- **Type:** Folder
- **Main files found:** `docs/openclaw_research.md`
- **Importance score:** 2/5
- **Notes:** Contains OpenClaw research docs.

### 3H. `~/Desktop/TITAN_Original_Project`
- **Type:** Folder
- **Main files found:** `openclaw_research.md`
- **Importance score:** 1/5
- **Notes:** Original project research.

### 3I. `~/workspace/titanbot`
- **Type:** Python workspace
- **Main files found:** `main.py`, `STATUS.md`, `apis/`, `execution/`, `monitoring/`, `wallets/`, `x_automation/`, `logs/`
- **Importance score:** 3/5
- **Notes:** Python-based workspace. Contains wallet and x_automation modules — may be experimental or separate.

### 3J. `~/.titan` (Titan PC runtime)
- **Type:** Runtime data
- **Main files found:** Massive: logs (daily from Apr 9–May 3), file-checkpoints (60+ checkpoint folders), certs, `titan-data.json`, `titan.json`, `soma-drive-state.json`, backups
- **Importance score:** 4/5
- **Notes:** Active runtime data. `titan.log` is 121MB. Many file checkpoints. Has cert backups.

### 3K. `~/titan-voice-server` & `~/titan-voice-stack`
- **Type:** Voice infrastructure
- **Importance score:** 3/5
- **Notes:** Voice server and stack components.

### 3L. `~/titan-api-test`
- **Type:** Test folder
- **Importance score:** 2/5
- **Notes:** API testing artifacts.

### 3M. `~/Desktop/AI_Projects_Info/`
- **Type:** Documentation
- **Main files found:** `TITAN_PROACTIVE_COMPLETE.txt`, `TITAN_Proactive_Mode.txt`, `TITAN_Project_Info.txt`
- **Importance score:** 2/5

### 3N. `~/.gitnexus` (Titan PC)
- **Type:** GitNexus index
- **Contains:** `registry.json`
- **TITAN reference:** Indexes `/opt/TITAN` (lastCommit: `462a86ad`)
- **Importance score:** 3/5

### 3O. Systemd Services
| Service | Status | Notes |
|---|---|---|
| `titan.service` | Active | Runs `node dist/cli/index.js gateway` from `/opt/TITAN` |
| `openclaw-gateway.service` | Configured | OpenClaw gateway |
| `openclaw-node.service` | Configured | OpenClaw node |

### 3P. `~/titan-audit.md`
- **Type:** Audit document
- **Date:** 2026-04-20
- **Importance score:** 4/5
- **Notes:** Comprehensive audit of the Titan PC TITAN state. Declares `/opt/TITAN` as live operational source of truth.

### 3Q. Backup Files
| File | Size | Date |
|---|---|---|
| `~/titanbot-final-backup-20260202-1952.tar.gz` | ~3.8 GB | Feb 2 |
| `~/.titan-backup-20260420T124049/` | Small | Apr 20 |
| `~/.titan/backups/titan-backup-2026-04-08T07-14-59.tar.gz` | Unknown | Apr 8 |

### 3R. `~/synapse_paper.md`
- **Type:** Research paper
- **Importance score:** 2/5
- **Notes:** Academic paper for titan-synapse model.

---

## 4. GitNexus Locations Found

| Machine | Path | Indexed Repo | lastCommit | Files/Nodes |
|---|---|---|---|---|
| MacBook | `~/.gitnexus` | `~/Desktop/TitanBot/TITAN-main` | `462a86ad` | 1342 / 29918 |
| Titan PC | `~/.gitnexus` | `/opt/TITAN` | `462a86ad` | 2100 / 58453 |
| Titan PC | `~/titan-publish/.gitnexus` | (same repo) | — | — |

**Note:** Both machines index the same commit `462a86ad`, but the Titan PC version has more files (2100 vs 1342) because it includes build artifacts like `dist/`.

---

## 5. Documents and Notes Found

### Architecture
- `~/Desktop/TitanBot/TITAN-main/ARCHITECTURE.md`
- `~/Desktop/TitanBot/TITAN-main/ARCHITECTURE-TODO.md`
- `~/Desktop/titan-synapse/paper/synapse_architecture.md`
- `~/Desktop/TitanBot/TITAN-main/docs/system-prompt-research.md`

### Roadmap / Plans
- `~/Desktop/TitanBot/TITAN-main/docs/HANDOFF-2026-05-03.md` ⭐ (new, only on MacBook)
- `~/TITAN-Growth-Strategy.md`
- `~/TITAN-Launch-Posts.md`
- `~/TITAN-Teaser-Scripts-V2.md`

### Bugs / Audit
- `~/Desktop/TitanBot/TITAN-main/titan-audit.md` (on Titan PC)
- `~/Desktop/TitanBot/TITAN-main/docs/TITAN-PC-AUDIT-2026-04-20.md` (in titan-publish)

### Install / Run Notes
- `~/Desktop/TitanBot/TITAN-main/README.md`
- `~/Desktop/TitanBot/TITAN-main/.env.example`
- `~/Desktop/titan-synapse/README.md`
- `~/Desktop/TitanBot/TITAN-main/titan-voice-ui/README.md`

### Random / Unknown
- `~/find_titan.py` — Python script to locate TITAN instances
- `~/ai-homelab/scripts/titan-full-test.sh`
- `~/hello-titan.ts`
- `~/titanbot.tail57901.ts.net.crt` / `.key` — Tailscale certs
- `~/Desktop/mission-control.html` — Standalone HTML file

---

## 6. Possible Duplicates or Conflicts

| Conflict | Description |
|---|---|
| **MacBook vs Titan PC main repo** | MacBook `TITAN-main` is 1 commit ahead (`95fbb07` handoff doc). Titan PC `/opt/TITAN` is clean at origin/main. Need to decide if the handoff doc stays local or gets pushed. |
| **Titan PC `/opt/TITAN` vs `~/titan`** | `/opt/TITAN` is the git repo source code. `~/titan` is runtime data (no git). Don't confuse them. |
| **Multiple "TITAN" folders on Titan PC Desktop** | `~/Desktop/TITAN`, `~/Desktop/NewTitan22626`, `~/Desktop/TITAN_GitHub`, `~/Desktop/TITAN_Original_Project` — appear to be copies or old versions. Most are stale. |
| **`~/titan-publish` vs `/opt/TITAN`** | `titan-publish` is detached at `v5.5.3` tag — this is a release snapshot. `/opt/TITAN` is on `main` branch and may have newer commits. |
| **`~/workspace/titanbot`** | This is a separate Python project (wallet, x_automation). Unclear if it's part of TITAN core or a separate experiment. |
| **`titan-synapse` uncommitted changes** | Active Rust/Python model work not committed. Risk of losing work. |
| **`titan-saas` uncommitted changes** | Large amount of Next.js work not committed. Significant risk of losing work. |

---

## 7. Current Best Source of Truth

**For source code:** `/opt/TITAN` on the Titan PC
- It is the live running instance
- It is clean and up to date with origin/main
- It has the systemd service running from it
- The audit doc explicitly names it as operational source of truth

**For local development:** `~/Desktop/TitanBot/TITAN-main` on the MacBook
- Has 1 uncommitted handoff document
- `npm test` hangs — needs investigation before it's a reliable dev environment
- Should be kept in sync with `/opt/TITAN` on Titan PC

**For published/npm:** `~/titan-publish` on Titan PC (detached at `v5.5.3`)

---

## 8. Risks

| Risk | Severity | Details |
|---|---|---|
| **Uncommitted work on titan-saas** | 🔴 High | Many modified and untracked files. Could lose significant SaaS work. |
| **Uncommitted work on titan-synapse** | 🔴 High | Rust/Python model changes not committed. |
| **MacBook 1 commit ahead of origin** | 🟡 Medium | The handoff doc (`docs/HANDOFF-2026-05-03.md`) exists only on MacBook. Needs push or deliberate decision. |
| **Titan PC running live with no branch protection** | 🟡 Medium | `/opt/TITAN` is live production. Any bad change directly affects the running gateway. |
| **Stale copies on Titan PC Desktop** | 🟡 Medium | Multiple old TITAN folders may confuse future work. |
| **Sensitive files found** | 🟡 Medium | `.env` files, Tailscale certs (`titanbot.tail57901.ts.net.crt/.key`), SSH keys exist but were not inspected/printed. |
| **Test hang on MacBook** | 🟡 Medium | `npm test` hangs with no output. Blocks reliable local development verification. |
| **No clear sync protocol between MacBook and Titan PC** | 🟡 Medium | No documented workflow for keeping the two dev environments in sync. |
| **`~/workspace/titanbot` unclear purpose** | 🟢 Low | Contains wallet and x_automation code. Could be experimental or abandoned. |
| **Large backup file (3.8GB)** | 🟢 Low | `titanbot-final-backup-20260202-1952.tar.gz` takes up space. |

---

## 9. Recommended Next Step

**Safest next step:** Before making any code changes, create a safe sync plan between the MacBook and Titan PC:

1. Compare the MacBook's `TITAN-main` with Titan PC's `/opt/TITAN` to see if there are any code differences beyond the handoff doc
2. Decide whether to push the handoff doc from MacBook or discard it
3. Establish a workflow: "MacBook for dev → Titan PC for build/test → `/opt/TITAN` for production"
4. Then investigate the `npm test` hang on the MacBook and the `titan-saas` / `titan-synapse` uncommitted work on the Titan PC

**Immediate command to run (safe, read-only):**
```bash
# On MacBook — compare with Titan PC's state
cd ~/Desktop/TitanBot/TITAN-main
git fetch origin
git log --oneline --graph --left-right --decorate origin/main...HEAD
```

---

*Report compiled by KIMI-COO 🧠 | Recon mode | No files modified.*
