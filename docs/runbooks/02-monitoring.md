# TITAN Monitoring & Alerting Guide

## Health Endpoints

| Endpoint | Purpose | Expected Response |
|----------|---------|-------------------|
| `GET /api/health` | Liveness probe | `{"status":"ok","version":"..."}` |
| `GET /api/health/deep` | Readiness + dependency check | `{"status":"ok|degraded|down","checks":{...}}` |
| `GET /metrics` | Prometheus metrics | Text exposition format |
| `GET /api/metrics/summary` | JSON dashboard metrics | `{"totalRequests","avgLatencyMs","errorRate",...}` |

## Key Metrics to Watch

### Critical (page if exceeded)
- `titan_requests_total` with `status=error` > 10% of total
- `/api/health/deep` returns `status=down`
- Process RSS > 90% of `maxMemoryMB` config
- Event loop lag > 500ms

### Warning (alert in Slack)
- `titan_errors_total` > 5% of requests
- Heap usage > 1500 MB
- Ollama health check fails for > 2 consecutive minutes
- Active LLM requests stuck for > 5 minutes
- Disk usage in `~/.titan` > 80%

### Info (dashboard only)
- Request latency P99
- Active sessions gauge
- Model request distribution
- Tool call breakdown

## Webhook Alerting

Configure in `titan.json`:
```json
{
  "alerting": {
    "webhookUrl": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
    "minSeverity": "warning"
  }
}
```

Supported webhook formats:
- Slack (`hooks.slack.com`)
- Discord (`discord.com/api/webhooks`)
- Generic JSON (falls back to plain POST)

## Log Locations

| Log | Path | Rotation |
|-----|------|----------|
| Application | `/home/dj/titan.log` | systemd-managed |
| Daily files | `~/.titan/logs/titan-YYYY-MM-DD.log` | Daily |
| Audit | `~/.titan/audit.jsonl` | 90-day retention |
| systemd | `journalctl -u titan` | journald-managed |

## Quick Commands

```bash
# Live log tail
ssh titan "tail -f /home/dj/titan.log"

# Filter errors
ssh titan "grep ERROR /home/dj/titan.log | tail -20"

# Check metrics
ssh titan "curl -s http://127.0.0.1:48420/api/metrics/summary"

# Health check
ssh titan "curl -s http://127.0.0.1:48420/api/health/deep | jq"
```
