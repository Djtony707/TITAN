# TITAN Outage Response Runbook

## Immediate Checks (< 2 minutes)

1. **Is the process running?**
   ```bash
   ssh titan "systemctl status titan --no-pager"
   ```

2. **Check health endpoint**
   ```bash
   ssh titan "curl -sk https://127.0.0.1:48420/api/health/deep"
   ```

3. **Check recent logs**
   ```bash
   ssh titan "journalctl -u titan -n 50 --no-pager"
   ssh titan "tail -n 100 /home/dj/titan.log"
   ```

4. **Check resource usage**
   ```bash
   ssh titan "free -h && df -h / && ps -o pid,etime,%mem,rss,command -p \$(pgrep -f 'node dist/cli/index.js')"
   ```

## Common Scenarios

### Scenario A: Process crashed / not running
**Symptoms**: `systemctl status` shows inactive, health endpoint unreachable.

**Response**:
```bash
ssh titan "sudo systemctl restart titan && sleep 3 && systemctl status titan --no-pager"
```

If it crashes repeatedly, check for:
- Disk full (`df -h`)
- OOM killer (`dmesg | grep -i kill`)
- Corrupted state files (`ls -la ~/.titan/`)

### Scenario B: Ollama unreachable
**Symptoms**: `/api/health/deep` shows `providers` down, users see "no models available."

**Response**:
```bash
ssh titan "curl http://localhost:11434/api/tags"  # Should return model list
ssh titan "systemctl status ollama --no-pager"
ssh titan "sudo systemctl restart ollama"
```

If Ollama is healthy but TITAN can't reach it, check:
- Firewall rules
- `OLLAMA_HOST` env var
- Network connectivity (`curl -v http://localhost:11434`)

### Scenario C: High memory / OOM
**Symptoms**: `health/deep` shows `eventLoop` degraded, process killed by OOM.

**Response**:
1. Restart TITAN to clear in-memory state
2. Check for runaway sessions: `curl /api/sessions` — close stale ones
3. Reduce concurrent load: edit `titan.json` → `gateway.maxConcurrentMessages = 2`
4. If persistent, check for memory leaks in logs

### Scenario D: Disk full
**Symptoms**: Writes fail, state not persisted, `df -h` shows 100%.

**Response**:
```bash
ssh titan "du -sh ~/.titan/* | sort -rh | head -10"
ssh titan "ls -la ~/.titan/logs/ | tail -20"
```

Clean up:
- Old logs: `find ~/.titan/logs -name '*.log' -mtime +7 -delete`
- Old vectors: check `~/.titan/vectors/`
- Audit logs: `find ~/.titan -name 'audit*' -mtime +30 -delete`

### Scenario E: Rate limiting / 429 errors
**Symptoms**: Users see "Too many requests" despite low actual usage.

**Response**:
1. Check if single IP is abusing: look for repeated IPs in logs
2. Temporarily raise limit in `titan.json`: `gateway.rateLimitMax = 60`
3. Restart TITAN to clear in-memory rate limit store

## Escalation

If the above doesn't resolve within 10 minutes:
1. Post in #titan-ops Slack with symptoms and checks done
2. Tag on-call engineer
3. Consider rolling back to last known good state (see `03-rollback.md`)
