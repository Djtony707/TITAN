# TITAN Analytics Research & Recommendations

## What We Want to Know

1. **Hardware footprint** — What are people installing TITAN on? (CPU, RAM, GPU, OS)
2. **Active usage** — How many people are actually running TITAN day-to-day?
3. **Version adoption** — How quickly do users update to new releases?
4. **Feature usage** — Which features (voice, mesh, channels, tools) are most used?

## What We Collect (Privacy-First)

All TITAN analytics are **opt-in** (`telemetry.enabled: false` by default) and collect **zero personal data**:

- No IP addresses
- No conversation content
- No file names or paths
- No usernames or emails
- Only: anonymous install ID, hardware specs, version, uptime, feature flags

## Options for Remote Analytics

### Option 1: PostHog (Recommended for Scale)

**What it is:** Open-source product analytics platform. Self-hostable or cloud-hosted.

**Pros:**
- Full-featured: funnels, retention, cohorts, feature flags
- Self-hostable (Docker) — you own the data
- Great for 26,000-user scale
- Can track hardware profiles as user properties

**Cons:**
- Requires a server (PostgreSQL + ClickHouse)
- More complex setup than simple pings

**Setup:**
```bash
# Self-hosted via Docker
https://posthog.com/docs/self-host
```

**Cost:** Free self-hosted. Cloud starts at $0/month (generous free tier).

---

### Option 2: Plausible Analytics (Recommended for Simplicity)

**What it is:** Privacy-focused, lightweight analytics. No cookies, no personal data.

**Pros:**
- Extremely simple setup (single Docker container)
- GDPR/CCPA compliant by design
- Perfect for "how many users" + "what pages"
- Great dashboards out of the box

**Cons:**
- Less granular than PostHog (no funnels/retention)
- Not designed for hardware profiling natively

**Setup:**
```bash
docker run -d --name plausible \
  -p 8000:8000 plausible/analytics
```

**Cost:** Self-hosted is free. Managed starts at ~$9/month.

---

### Option 3: Self-Built Ping Endpoint (Recommended for Control)

**What it is:** A simple cloud function or VPS endpoint that receives POST requests from TITAN instances.

**Pros:**
- You own everything
- Minimal infrastructure (Cloudflare Worker, Vercel Edge Function, or small VPS)
- Can store data in any format (SQLite, Postgres, BigQuery)
- No third-party dependencies

**Cons:**
- You have to build the dashboard yourself
- No pre-built UI for viewing data

**Example receiver (Cloudflare Worker):**
```javascript
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');
    const data = await request.json();
    // Store in D1 or KV
    await env.DB.prepare('INSERT INTO pings (install_id, version, os, gpu, timestamp) VALUES (?, ?, ?, ?, ?)')
      .bind(data.installId, data.version, data.os, data.gpuName, Date.now())
      .run();
    return new Response('OK');
  }
};
```

**Cost:** Cloudflare Workers free tier handles 100k requests/day.

---

### Option 4: Umami (Middle Ground)

**What it is:** Open-source, privacy-focused analytics. Simpler than PostHog, more powerful than Plausible.

**Pros:**
- Single Next.js app + PostgreSQL
- Events API for custom events (perfect for hardware profiles)
- Nice dashboards

**Cons:**
- Still needs a database
- Less mature ecosystem than PostHog

---

## What I Implemented Today

### Backend (`src/analytics/collector.ts`)
- `collectSystemProfile()` — gathers: installId, version, Node version, OS, arch, CPU model/cores, RAM, GPU vendor/name/VRAM, disk, install method
- `buildHeartbeat()` — gathers: installId, version, uptime, active sessions, memory usage
- `recordStartupAnalytics()` — sends profile on boot
- `startHeartbeatAnalytics()` — sends heartbeat every 5 minutes
- `sendRemoteAnalytics()` — POSTs to configurable `telemetry.remoteUrl`

### Config
- Added `telemetry.remoteUrl` — optional endpoint for remote analytics
- Existing `telemetry.enabled` gates all collection (defaults to **false**)

### Gateway Endpoints
- `GET /api/analytics/profile` — returns the system profile JSON
- Existing `POST /api/telemetry` — receives events from UI
- Existing `GET /api/telemetry/events` — queries stored events

### UI
- `useUpdateCheck` hook — polls `/api/update` for version info
- StatusBar shows update badge with one-click update
- Canvas header shows version chip (top-right corner)

## Recommendation

**For your 26,000-user deployment:**

1. **Short term** — Use the self-built ping endpoint (Option 3). A Cloudflare Worker + D1 database costs basically nothing and gives you full control. You can query:
   ```sql
   SELECT os, arch, gpuVendor, COUNT(DISTINCT install_id) 
   FROM pings 
   WHERE timestamp > now() - interval '30 days'
   GROUP BY os, arch, gpuVendor;
   ```

2. **Medium term** — If you want richer dashboards without building them, self-host PostHog (Option 1). It can ingest the same JSON payloads and give you retention, funnels, and cohort analysis.

3. **Enable telemetry** — Set `telemetry.enabled: true` and `telemetry.remoteUrl: "https://your-worker.workers.dev"` in `~/.titan/titan.json`. Users stay anonymous, you get insights.
