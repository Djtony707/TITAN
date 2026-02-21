# TITAN Skills v1

TITAN skills are installable bundles with explicit permissions, approval-gated install/run, lockfile reproducibility, and SQLite audit visibility.

## Bundle Layout

Install target:

- `<workspace>/skills/<slug>/<version>/`

Required files:

- `skill.toml`
- `SKILL.md`

Optional:

- `prompts/`
- `assets/`
- `src/`

## `skill.toml` schema (v1)

```toml
name = "List Docs"
slug = "list-docs"
version = "1.0.0"
description = "List docs folder"
author = "Example"
license = "MIT"
entrypoint_type = "prompt" # prompt | http | wasm | script_stub
entrypoint = "tool:list_dir docs"

[permissions]
scopes = ["READ"]          # READ | WRITE | EXEC | NET
allowed_paths = ["docs"]
allowed_hosts = []

[signature]
public_key_id = "team-key"
ed25519_sig_base64 = "..."
```

## Registry Adapters

TITAN supports:

- `local` adapter (folder registry with `index.json`)
- `git:` adapter (read-only clone + `index.json`)
- `http:` adapter (read-only `index.json`; bundle fetch is `file://` in v1)

Index format:

```json
{
  "skills": [
    {
      "slug": "list-docs",
      "name": "List Docs",
      "latest": "1.0.0",
      "versions": [
        {
          "version": "1.0.0",
          "download_url": "bundles/list-docs-1.0.0",
          "sha256": "<bundle_sha256>"
        }
      ]
    }
  ]
}
```

## Install Flow

1. Resolve skill/version from registry index.
2. Stage bundle under `<workspace>/.titan/staging/skills/...`.
3. Verify registry SHA-256 (required).
4. Verify optional ed25519 signature from trust store `~/.titan/trust/keys/<id>.pub`.
5. Create approval record with:
   - slug/version
   - scopes
   - allowed paths/hosts
   - signature status
   - bundle hash
6. Finalize only after approval (mode-dependent auto-approve exceptions below).
7. Write/update `skills.lock`.
8. Upsert installed-skill metadata in SQLite.

## Mode Policy

- `Collaborative`: install finalization requires approval.
- `Supervised`: READ-only skills can auto-finalize; other scopes require approval.
- `Autonomous`: auto-finalize.

## Default-Deny Safety

Denied by default:

- unsigned skills requesting `EXEC`
- unsigned `NET` skills with `allowed_hosts = ["*"]` or empty host allowlist

Run-time dangerous approval:

- `EXEC` skills require an explicit dangerous approval grant before first run.

## Lockfile

`skills.lock` stores exact slug/version/source/hash.

- Installs honor lock pin by default.
- Use `--force` on install/update to bypass lock pin and pull latest requested version.

## CLI

```bash
titan skill search <query> [--source local|local:<path>|git:<url>|http:<url>]
titan skill install <slug>[@version] [--source <registry>] [--force]
titan skill list
titan skill inspect <slug> [--source <registry>]
titan skill update [--all] [slug] [--source <registry>] [--force]
titan skill remove <slug>
titan skill run <slug> [--input <text>]
titan skill doctor <slug>
```

## Execution Model

- Skill run always routes through `titan-tools` (`ToolRegistry` + `ToolExecutor`) and `PolicyEngine`.
- No direct process execution path is used by `titan skill run`.
- Prompt entrypoints must use `tool:<tool_name> [args_template]`.
- `http|wasm|script_stub` entrypoints are explicit not-implemented stubs in v1.

## Web UI

Dashboard `/` includes a Skills panel showing:

- installed slug/version
- signature status
- requested scopes
- last-run goal link id

Pending skill installs are visible via pending approvals (`tool_name=skill_install`).
