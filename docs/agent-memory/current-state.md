# Current State

> What was last shipped + current operational state.
> Updated every session.

---

## Last Mission

**Mission:** 7-hour stabilization pass to bring TITAN to operational completeness across all subsystems.
**Status:** Complete (2026-05-07, ~75 min elapsed)
**Outcome:** All bleeders silenced, releases caught up, demo green, comprehensive handoff written.

---

## Repositories

| Repo | Path | Role | Branch | Status |
|---|---|---|---|---|
| TITAN (main) | `~/Desktop/TitanBot/TITAN-main` | Dev workspace | `main` | Clean, at v5.5.6 + post-release docs (`18f6904`) |
| TITAN (production) | `titan:/opt/TITAN` | Live production | `main` | Clean, at v5.5.6, systemd-managed, NRestarts=0 |
| TITAN.wiki | `~/Desktop/TITAN.wiki` | Public docs | `master` | Refreshed Home.md to v5.5.6 (other pages still stale) |
| titan-publish | `titan:~/titan-publish` | Release snapshot | tag `v5.5.6` | Detached, ready for next publish |
| titan-synapse | `~/Desktop/titan-synapse` | Rust+Python sister project | `main` | WIP commit `66024c3` (NOT pushed — review/amend) |
| titan-saas | `titan:~/titan-saas` | Next.js SaaS dashboard | `main` | WIP commit `795a15f` (148 files, NOT pushed) |

## Live Production State (Titan PC)

- **Gateway version:** v5.5.6
- **Uptime:** since 2026-05-07 08:06:10 PDT
- **NRestarts:** 0 (was 3+ before fix)
- **Live error count:** 0
- **Direct routing:** `ollama/kimi-k2.6:cloud` (no failover noise)
- **Self-repair sweep:** dedupe working — 6+ min between log entries (was every 5 min before)
- **Health-check cron:** firing every 5 min, all OK responses

## npm

- `titan-agent@5.5.6` published as `@next`
- `@latest` on **5.4.2** — soak ends 2026-05-08

## Test Suite

- 250 files / 6,602 passed / 2 documented-skipped / 0 failing
- Runtime: ~3:25
- Typecheck: clean
- Build: clean

## Key Fixes Shipped This Session

1. **Kimi 401 storm** (v5.5.4 + v5.5.5) — provider preset corrected
2. **Self-repair sweep dedupe** (v5.5.6) — `dedupeKey` field stops drive_stuck_high spam
3. **fix-oscillation /tmp/ false positives** (v5.5.6) — `TRANSIENT_FILE_PATTERNS` skip-list
4. **Sage advisor timeout** (v5.5.6) — 20s → 30s default
5. **Gateway 5-min restart loop** (live-only) — rewrote `~/.titan/health-check.sh` as passive monitor (root cause: stale auth token from May-3 session)
6. **5 unskipped tests** — adapter shape contracts + goals mock ordering
7. **titan.service enabled for boot autostart**
8. **Stale `titan-gateway.service` disabled**
9. **5 stale TITAN folders archived** to `~/.titan-archive/`

---

## Pending (Phase 1 — separate session)

See `docs/HANDOFF-2026-05-07.md` § "Risks Remaining" for the full list. Top 5:

1. 27 Dependabot vulnerabilities (1 critical, 3 high, 23 moderate)
2. GitHub CI status check not running
3. Organism / Doctor / Eval API not mounted
4. Widget-gallery first-routing too aggressive
5. `@latest` promotion on 2026-05-08

---

*Last updated: 2026-05-07 by Claude Opus 4.7 (1M context)*
