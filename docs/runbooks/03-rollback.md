# TITAN Rollback & Recovery Runbook

## Standard Rollback (last known good)

1. **Stop TITAN**
   ```bash
   ssh <titan-host> "sudo systemctl stop titan"
   ```

2. **Restore from backup** (if available)
   ```bash
   ssh <titan-host> "cd /opt/TITAN && git stash && git checkout <last-good-tag>"
   ```

3. **Rebuild**
   ```bash
   ssh <titan-host> "cd /opt/TITAN && npm run build"
   ```

4. **Restart**
   ```bash
   ssh <titan-host> "sudo systemctl start titan && sleep 3 && systemctl status titan --no-pager"
   ```

## Emergency State Reset

If corrupted state files are causing crashes:

1. **Backup current state**
   ```bash
   ssh <titan-host> "mkdir -p ~/.titan/backup-$(date +%Y%m%d-%H%M%S) && cp -r ~/.titan/*.json ~/.titan/backup-*/"
   ```

2. **Reset specific subsystems**
   ```bash
   # Reset graph (keeps episodes/entities)
   ssh <titan-host> "curl -X POST http://127.0.0.1:48420/api/graph/clear"

   # Reset sessions (forces re-authentication)
   ssh <titan-host> "curl -X POST http://127.0.0.1:48420/api/sessions/cleanup"

   # Reset approvals (clears stuck approvals)
   ssh <titan-host> "curl -X POST http://127.0.0.1:48420/api/command-post/clear"
   ```

3. **Nuclear option: wipe all state**
   ```bash
   ssh <titan-host> "sudo systemctl stop titan"
   ssh <titan-host> "mv ~/.titan ~/.titan-bak-$(date +%Y%m%d-%H%M%S)"
   ssh <titan-host> "mkdir -p ~/.titan/logs"
   ssh <titan-host> "sudo systemctl start titan"
   ```
   ⚠️ This loses all conversation history, memories, and learned strategies.

## Docker Rollback

```bash
ssh <titan-host> "cd /opt/TITAN && docker-compose down"
ssh <titan-host> "cd /opt/TITAN && docker-compose pull"
ssh <titan-host> "cd /opt/TITAN && docker-compose up -d"
```

## Verification After Rollback

1. Check health: `curl /api/health/deep`
2. Check version: matches expected rollback tag
3. Send a test message via UI or API
4. Verify Ollama connectivity: `curl /api/providers`
5. Check logs for errors in first 2 minutes
