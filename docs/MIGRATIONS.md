# Writing TITAN Migrations

> For TITAN contributors. End-users reading about an upgrade want
> [UPGRADING.md](./UPGRADING.md) instead.

## What this system is

`src/migrations/` is TITAN's data-shape migration system. It exists so that
every release shipping a change to user data (config, sessions, memory,
Spaces, Soma profile, anything under `~/.titan/`) carries a forward-and-
backward-safe upgrade path. The user **never** has to manually edit a JSON
file to keep their install working.

The architecture has three layers:

```
┌───────────────────────────────────────────────────────────────┐
│  src/cli/index.ts        titan migrate [--dry-run]            │
│  src/gateway/server.ts   safeRunMigrations() on boot          │
└─────────────────────────────┬─────────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────────┐
│  src/migrations/safeRun.ts                                    │
│    1. Plan pending                                            │
│    2. Pre-flight backup (createBackup)                        │
│    3. Run migrations                                          │
│    4. Smoke-check (config loads, spaces.json parses, ...)     │
│    5. Auto-rollback on failure (rollback() + restoreBackup)   │
└─────────────────────────────┬─────────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────────┐
│  src/migrations/runner.ts                                     │
│    - Loads ~/.titan/MIGRATION_STATE.json                      │
│    - Runs ALL_MIGRATIONS in id-ascending order                │
│    - Persists state after EACH successful migration           │
│  src/migrations/index.ts                                      │
│    - Registry of all migrations (kept in id order)            │
│  src/migrations/NNN-slug.ts                                   │
│    - One migration per file (up + optional rollback)          │
└───────────────────────────────────────────────────────────────┘
```

## Authoring a new migration

### 1. Pick an id

Format: `NNN-kebab-slug`, where `NNN` is the next zero-padded sequence
number after the current max in `src/migrations/index.ts`. The slug
should describe **what the migration does**, not when it was added.

Good ids:
- `006-personal-gallery-bootstrap`
- `007-soma-pattern-detection-defaults`
- `008-archive-old-cron-jobs`

Bad ids:
- `006-v6.1-changes` (vague)
- `006-fix-bug` (no actionable name)
- `006_kebab_with_underscores` (inconsistent style)

### 2. Create the file

```typescript
// src/migrations/006-personal-gallery-bootstrap.ts
import type { Migration } from './runner.js';

export const migration: Migration = {
    id: '006-personal-gallery-bootstrap',
    version: '6.1.0-beta.1',
    description: 'Seed an empty personal widget gallery file per user.',

    async up(ctx) {
        // ctx.titanHome — absolute path to ~/.titan/
        // ctx.titanVersion — current TITAN version
        // ctx.log(msg) — log channel into the migration's consolidated output
        // ctx.readJson<T>(relPath) — null on missing/malformed
        // ctx.writeJson(relPath, value) — pretty-printed
        // ctx.writeIfChanged(relPath, content) — idempotent string write
        const existing = ctx.readJson('users/default-user/gallery.json');
        if (existing) {
            ctx.log('Skipped — gallery already exists.');
            return;
        }
        ctx.writeJson('users/default-user/gallery.json', {
            schema: 1,
            widgets: [],
            createdAt: new Date().toISOString(),
        });
        ctx.log('Seeded empty personal gallery.');
    },

    async rollback(ctx) {
        // Called on auto-rollback. Be NON-DESTRUCTIVE of user data.
        // For seed-data migrations: only remove when the artifact is
        // untouched from your seed.
        const f = ctx.readJson<{ widgets: unknown[] }>('users/default-user/gallery.json');
        if (f && Array.isArray(f.widgets) && f.widgets.length === 0) {
            try {
                require('fs').unlinkSync(`${ctx.titanHome}/users/default-user/gallery.json`);
                ctx.log('Removed untouched gallery seed.');
            } catch { /* fine */ }
        } else {
            ctx.log('rollback: user has widgets in gallery — preserving.');
        }
    },
};
```

### 3. Register it

```typescript
// src/migrations/index.ts
import { migration as m006 } from './006-personal-gallery-bootstrap.js';

export const ALL_MIGRATIONS: Migration[] = [
    m001, m002, m003, m004, m005,
    m006,
];
```

### 4. Test it

Two tests are mandatory for every new migration:

```typescript
// tests/unit/migration-006-personal-gallery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations, __resetStateForTests } from '../../src/migrations/runner.js';
import { migration } from '../../src/migrations/006-personal-gallery-bootstrap.js';

// ... TMP_HOME setup ...

it('seeds gallery.json on fresh install', async () => {
    const r = await runMigrations([migration], '6.1.0-beta.1');
    expect(r.success).toBe(true);
    // Verify the file landed
});

it('is idempotent — second run is a no-op', async () => {
    await runMigrations([migration], '6.1.0-beta.1');
    // Mutate the file to prove migration won't overwrite
    // Re-run via direct up() call
    // Verify mutation is preserved
});
```

If your migration touches a file v5.x users may already have, add a third
test that simulates the v5.x state and asserts the data is preserved.

## The rules every migration MUST follow

1. **Idempotent.** Same input twice = same output. The runner skips already-
   applied migrations via state file, but your `up()` should also handle
   the case where the data is already in the post-migration shape (in case
   the state file got wiped but the data is fine).

2. **Non-destructive on rollback.** Never delete data the user created.
   Only undo what the migration itself wrote.

3. **No external services in `up()`.** Migrations run before the gateway
   is fully up. Don't call providers, channels, or network endpoints. If
   you need user input, do it in a follow-up gateway-side hook, not a
   migration.

4. **Small + focused.** One migration = one logical change. Bundling 5
   things into one migration makes rollback impossible to reason about.

5. **No hard dependencies between migrations.** They run in order, but
   each one should still work if you re-run from scratch.

## Smoke checks

`safeRunMigrations` runs default smoke checks after all migrations apply.
The defaults are:

- `config loads` — `loadConfig()` doesn't throw
- `spaces.json is parseable` — when present, valid JSON

If your migration introduces a new always-present file, **add a smoke
check** so a corrupted post-migration state gets caught + rolled back:

```typescript
import { safeRunMigrations, type SmokeCheck } from './safeRun.js';

const galleryParseable: SmokeCheck = {
    name: 'personal gallery is parseable',
    async check() {
        // throws if file is corrupt
    },
};

await safeRunMigrations(ALL_MIGRATIONS, {
    titanVersion: TITAN_VERSION,
    smokeChecks: [galleryParseable /* + defaults */],
});
```

## When NOT to write a migration

- **The data shape is fully optional.** Zod's `.optional()` + a default
  in the consumer handles the case. No migration needed.
- **The change is to a transient runtime store.** In-memory state, Yjs
  CRDT documents, things wiped on every boot — migrations are for
  persistent state.
- **A user-facing setting changed.** Add a UI affordance, not a migration.

## CI / pre-merge checks

Before submitting a PR with a new migration:

```bash
# 1. Lint + typecheck
npm run lint && npx tsc --noEmit

# 2. Migration tests
npx vitest run tests/unit/migration-

# 3. Full suite (catches downstream regressions)
npx vitest run

# 4. Dry-run plan to confirm registration order
node dist/cli/index.js migrate --dry-run
```

## Related files

- `src/migrations/runner.ts` — execution engine + state file
- `src/migrations/safeRun.ts` — backup + smoke check + rollback wrapper
- `src/migrations/index.ts` — registry
- `src/storage/backup.ts` — backup primitives (create/list/verify/restore)
- `src/skills/builtin/backup.ts` — agent-facing backup tools
- `tests/unit/migration-*.test.ts` — example tests for the existing 5
  migrations
- `docs/UPGRADING.md` — end-user facing upgrade narrative
