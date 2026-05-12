# Upgrading TITAN

> **TL;DR for v5.x → v6.0:** When v6.0 boots for the first time it will
> auto-backup your `~/.titan/` data, run a small set of data migrations,
> verify everything still loads, and roll back from the backup if anything
> breaks. **You don't have to do anything manually** — but reading this once
> means you'll know what's happening.

## What v6.0 changes that touches your data

| Area | v5.x | v6.0 |
|---|---|---|
| Workspaces | Browser localStorage only | `~/.titan/spaces.json` server-side + still synced to localStorage via Yjs |
| Admin pages | 49 fixed routes under `/admin/*` and `/command-post/*` | 7 fixed admin pages + 36 admin views become pinnable widgets |
| Per-user data | Mixed under `~/.titan/` | Isolated under `~/.titan/users/<userId>/` |
| Soma | Drives measured but not used | Drives modulate behaviour + per-user profile persists |

## What gets backed up (always, automatically)

When v6.0 first boots on your install, the migration runner creates a
pre-flight backup before touching anything. The backup includes:

- **Config files** — `config.yaml`, `config.json`
- **Persistent data** — `titan-data.json`, `knowledge.json`, `graph.json`,
  `vectors.json`, `vault.enc`, `disabled-skills.json`, `command-post.json`,
  `command-post-activity.jsonl`
- **Per-area subdirs** — `plans/`, `deliberations/`, `tool-results/`,
  `workspace/`

The backup lands in `~/.titan/backups/titan-backup-<timestamp>-pre-migration.tar.gz`.

> If the migration runner can't create the pre-flight backup, **it aborts
> the entire migration.** No half-states. Either v6.0 takes you cleanly
> forward or you stay on the v5.x layout.

## What happens at first boot

1. **Plan.** Runner reads `~/.titan/MIGRATION_STATE.json` (or creates one)
   and figures out which migrations are pending.
2. **Backup.** A pre-flight backup is created and labelled
   `pre-migration`.
3. **Run.** Each pending migration runs in id-ascending order. After each
   one completes, state is persisted — so a crash mid-run never redoes
   work.
4. **Smoke check.** The runner verifies the gateway can still load config
   and that any new files (e.g. `spaces.json`) parse correctly.
5. **If a smoke check fails:**
   - First the runner calls each migration's own `rollback()` in reverse
     order.
   - Then it restores from the pre-flight backup.
   - You end up exactly where you started, with the backup still on disk
     for review.
6. **If everything passes:** Migration state is locked in. v6.0 is now
   running normally.

## The 5 initial v6.0 migrations

| ID | What it does | Affects |
|---|---|---|
| `001-config-schema-v6` | Lifts your existing config through the v6 Zod parser so new optional fields populate to defaults | `config.yaml` / `config.json` |
| `002-seed-default-space` | If you have no Spaces yet, creates a Default Space with sensible `agentInstructions` | `spaces.json` |
| `003-soma-profile-default` | Creates a neutral-baseline Soma profile for you so TITAN has a starting model of who you are | `users/<userId>/soma.json` |
| `004-user-data-dirs` | Creates `~/.titan/users/<userId>/{widgets,patterns,gallery}/` so v6.0 features have somewhere to write | (directories only) |
| `005-route-redirects` | Writes a v5→v6 route redirect map so existing browser bookmarks land on the right Space + auto-pin the matching widget | `route-redirects.json` |

Each migration is **idempotent** — running v6.0 twice doesn't re-apply
them, and a crash mid-run lets you restart where you left off.

## CLI commands you might want

### Manual backup before doing something risky

```bash
titan backup --create --label before-experiment
```

### See what backups you have

```bash
titan backup --list
```

### Restore from a backup (if you need to)

```bash
titan backup --restore latest        # newest backup
titan backup --restore titan-backup-2026-05-11  # by prefix
```

### Verify a backup's integrity (without restoring)

```bash
titan backup --verify latest
```

### See pending migrations without applying

```bash
titan migrate --dry-run
```

### Apply pending migrations manually (normally automatic on boot)

```bash
titan migrate
```

## Rolling back to v5.x

If you genuinely need to go back to v5.x after upgrading to v6.0:

1. Find the pre-migration backup:
   ```bash
   ls -t ~/.titan/backups/*pre-migration* | head -1
   ```
2. Install the v5.x version of `titan-agent`:
   ```bash
   npm i -g titan-agent@5.7.1
   ```
3. Restore the backup:
   ```bash
   titan backup --restore <filename-from-step-1>
   ```
4. Restart the gateway.

This restores your `~/.titan/` to the state it was in immediately before
v6.0 first ran.

> The migration runner state at `~/.titan/MIGRATION_STATE.json` is included
> in the backup, so v6.0 won't try to re-migrate on a subsequent re-upgrade.

## Things that DO NOT change in v6.0

Just so you know what's preserved:

- All your chat sessions
- All your memory graph entries, dreams, personas
- All your cron jobs, recipes, autopilot config
- All your custom skills under `~/.titan/custom-skills/`
- All your auth tokens (and the 30-day TTL fix from v5.7.2 means they
  stop getting wiped overnight)
- All your provider API keys + integrations
- All your installed channels (Discord, Slack, IRC, etc.) and their
  configurations

## Help / disaster recovery

If you hit a state where the gateway won't start after upgrade:

1. Stop the service: `sudo systemctl stop titan` (or `pkill titan`)
2. Restore from the most recent pre-migration backup:
   ```bash
   ~/.local/bin/titan backup --restore latest --skip-verify
   ```
3. Check `~/titan.log` (or wherever you've configured logging) for the
   migration runner's last successful step.
4. File an issue at https://github.com/Djtony707/TITAN/issues with the
   `MIGRATION_STATE.json` contents.

## Behind the scenes

The migration system is documented in detail in
[`docs/MIGRATIONS.md`](./MIGRATIONS.md) — for authors of v6.x and beyond
who'll be writing their own migrations against this same runner.
