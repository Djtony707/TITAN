# TITAN Connectors (Phase 2)

TITAN connectors add external API integrations while keeping policy, approvals, and traces enforced through the same runtime controls.

## Connector Types

- `github`
- `google_calendar`

## Security Model

- Connector metadata is stored in SQLite (`connectors`, `connector_tool_usage`).
- Secrets are never stored in SQLite.
- Secrets are sourced from:
  - Environment variables (for env-only setups), or
  - Encrypted local secrets store (`~/.titan/secrets.enc`).
- Connector writes in `secure` risk mode + `collaborative` autonomy require approval.
- Connector writes in `yolo` execute immediately but are still traced.

## CLI

```bash
titan connector list
titan connector add github --name "GitHub Main"
titan connector configure <connector_id>
titan connector test <connector_id>
titan connector remove <connector_id>
```

## Configure Fields

### GitHub

- Non-secret (SQLite): `owner`, `repo`, `base_url`
- Secret (encrypted/env): token (`connector:<uuid>:github_token` or `GITHUB_TOKEN`)

### Google Calendar

- Non-secret (SQLite): `calendar_id`, `base_url`, `access_token_env`
- Secret (encrypted/env): token (`connector:<uuid>:gcal_token` or env var)

## Web API

- `GET /api/connectors`
- `POST /api/connectors/{id}/test`
- `GET /api/mission-control` includes:
  - `connectors`
  - `connector_summary` (`total`, `failing`)

## Approvals

Connector tool calls that need approval create a `connector_tool` approval record.
Approving executes through the same mediated connector path (policy + trace + goal persistence).
