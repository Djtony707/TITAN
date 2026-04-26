# TITAN Analytics Collector — Deployment

This is the permanent home for the anonymous-stats collector that TITAN
installs POST events to. TITAN v5.0 "Spacewalk" shipped the client-side
pipeline — this doc covers the server side.

## TL;DR

- **Where it runs**: Titan PC (`/opt/titan-analytics/`), managed by systemd
- **Port**: `48422` (loopback); exposed publicly via Tailscale Funnel or a
  reverse proxy
- **Default `remoteUrl` in `titan.json`**:
  `https://dj-z690-steel-legend-d5.tail57901.ts.net/events`
- **Privacy**: IP address is masked to /24 before hashing, no prompts or
  file contents are ever accepted, consent is opt-in only
- **Status endpoint**: `GET /api/telemetry/status` inside TITAN shows
  live success/failure counts so Tony can see the pipe is flowing

## First-time install on Titan PC

```bash
# 1. Install the collector (one-shot, user = dj)
sudo mkdir -p /opt/titan-analytics/{src,data,logs}
sudo chown -R dj:dj /opt/titan-analytics
cd /opt/titan-analytics

# 2. Copy the collector source from /tmp (where we've been running it)
#    or clone from git if you have it published somewhere:
sudo -u dj cp /tmp/titan-analytics/src/server.js src/server.js
sudo -u dj cp /tmp/titan-analytics/package.json package.json
sudo -u dj npm install --omit=dev

# 3. Install the systemd unit
sudo cp /path/to/TITAN-main/scripts/titan-analytics.service \
        /etc/systemd/system/titan-analytics.service

# 4. (Optional) Drop in basic-auth creds for the read dashboard
sudo tee /opt/titan-analytics/.env > /dev/null <<EOF
BASIC_AUTH_USER=tony
BASIC_AUTH_PASS=change-me-before-exposing
EOF
sudo chmod 600 /opt/titan-analytics/.env
# Then `sudo systemctl edit titan-analytics` and uncomment the EnvironmentFile line

# 5. Enable and start
sudo systemctl daemon-reload
sudo systemctl enable --now titan-analytics

# 6. Verify
systemctl status titan-analytics
curl -s http://127.0.0.1:48422/healthz
```

## Exposing publicly

Two options. Both require no port-forwarding.

### Tailscale Funnel (current default)

```bash
sudo tailscale funnel --bg --https=443 http://127.0.0.1:48422
```

The URL shown in the output is what `remoteUrl` points at. Copy it into
`src/config/schema.ts` as the default `remoteUrl` if it changes.

### Cloudflare Tunnel (alternative — stable DNS)

```bash
cloudflared tunnel create titan-analytics
cloudflared tunnel route dns titan-analytics analytics.example.com
cloudflared tunnel run --url http://127.0.0.1:48422 titan-analytics
```

Then set `remoteUrl` to `https://analytics.example.com/events`.

## What lands in the DB

`/opt/titan-analytics/data/events.db` (SQLite, better-sqlite3). Tables:

- `events` — one row per POST. Fields are allowlisted in the collector:
  `installId`, `version`, `os`, `arch`, `cpuModel`, `cpuCores`, `ramTotalMB`,
  `gpuVendor`, `gpuName`, `gpuVramMB`, `diskTotalGB`, `installMethod`,
  `nodeVersion`, `type`, `timestamp`, `ipPrefix` (masked /24)
- `errors` — crash reports: `installId`, `version`, `kind`, `errorClass`,
  `errorMessage`, `stackHash`, `timestamp`

**What's never stored**: prompts, file contents, file paths (beyond `$HOME`
replacement), credentials, full IP, conversation state, tool arguments.

## Visibility inside TITAN

After v5.0.1 the Mission Control Canvas → Settings → Privacy widget shows
a live Delivery card with:

- FLOWING / ERROR / NO REMOTE chip
- sent / failed event counts since gateway start
- last-attempt timestamp
- last-success timestamp
- last error message (if any)

Backed by `GET /api/telemetry/status` in `src/gateway/server.ts`.

## Operational notes

- Restart via `sudo systemctl restart titan-analytics`
- Logs: `sudo journalctl -u titan-analytics -n 100`
- Quick row count: `sqlite3 /opt/titan-analytics/data/events.db 'SELECT COUNT(*) FROM events'`
- Rate limit: 120 POSTs/hour per masked IP; adjust in `server.js` if needed
- Basic-auth read endpoints: `/stats/summary`, `/dashboard`
- Public endpoints: `/events` (POST only), `/healthz`
