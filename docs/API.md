# TITAN API Reference

## CLI Surface

### Core

- `titan doctor`
- `titan onboard`
- `titan setup` (alias for `titan onboard`)
- `titan setup --install-daemon`
- `titan goal submit <description> [--dedupe-key ...] [--simulate success|fail|timeout] [--max-retries N] [--timeout-ms N]`
- `titan goal show <goal_id>`
- `titan goal cancel <goal_id>`

### Tools and approvals

- `titan tool run <tool_name> [--input ...] [--approval-ttl-ms N]`
- `titan approval list`
- `titan approval show <approval_id>`
- `titan approval wait <approval_id> [--timeout-ms N]`
- `titan approval approve <approval_id> [--reason ...]`
- `titan approval deny <approval_id> [--reason ...]`

### Memory

- `titan memory query <pattern> [--limit N]`
- `titan memory backup <path>`
- `titan memory restore <path>`

### Integrations

- `titan discord status`
- `titan discord send <channel_id> <message>`
- `titan comm list`
- `titan comm status <channel>`
- `titan comm send <channel> --target <target> --message <message>`
- `titan model show`
- `titan model set <provider> <model> [--endpoint <url>] [--api-key-env <ENV_VAR>]`
- `titan model list-ollama [--endpoint http://127.0.0.1:11434]`
- `titan web serve [--bind 127.0.0.1:3000]`
- `titan skill validate <skill_dir>`
- `titan skill run <skill_dir> [--timeout-ms N] [--arg value ...]`
- `titan agent delegate <goal_id> --task "<task1>" --task "<task2>" [--max-depth N]`

## Web HTTP API

Base URL when running `titan web serve`: `http://127.0.0.1:3000`

### Health

- `GET /api/health`

### Goals

- `GET /api/goals?limit=20`

### Approvals

- `GET /api/approvals/pending`
- `POST /api/approvals/{id}/approve`
- `POST /api/approvals/{id}/deny`

Request body for approve/deny:

```json
{
  "resolved_by": "web",
  "reason": "optional reason"
}
```

### Traces

- `GET /api/traces/search?pattern=<text>&limit=20`

## Discord bridge

Current implemented Discord operations:

1. Bot token validation (`users/@me`)
2. Send message to channel (`channels/{channel_id}/messages`)

Inbound Discord event ingest loop is tracked as remaining work.
