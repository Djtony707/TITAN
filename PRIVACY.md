# TITAN Privacy & Telemetry

**Short version:** TITAN collects nothing by default. If you opt in during
the setup wizard (or in Settings → Specialists at any time), TITAN sends a
small, anonymous system profile and crash reports to the TITAN project so we
can see which hardware, OS versions, and GPUs people use, and catch bugs
before you have to tell us about them. **We never send your prompts, file
contents, credentials, IP address, or conversations.**

This document is the complete list of what's collected, when, why, and how to
revoke consent or delete your data.

---

## The default: nothing leaves your machine

When you install TITAN from npm (`npm install -g titan-agent`), nothing phones
home. The telemetry system exists, but:

- `telemetry.enabled` defaults to **`false`**.
- No events, profiles, or errors are sent anywhere.
- Existing installs upgrading from 4.x stay OFF — the upgrade never flips the
  switch. You'd have to explicitly opt in.

---

## What changes when you opt in

You opt in by either:

1. Ticking **"Help improve TITAN with anonymous stats"** on the final step of
   the first-run Setup Wizard, or
2. Flipping a switch in **Settings → Privacy** (future widget, rolling out).

When the switch is on, TITAN sends events to **two destinations** in parallel:

1. **PostHog Cloud** — if `telemetry.posthogApiKey` is set. This gives rich
   dashboards (feature adoption, model usage, tool reliability) without any
   personal data. Only anonymous hardware specs and event counts are sent.
2. **Custom collector** — the URL in `telemetry.remoteUrl` (defaults to the
   project's self-hosted collector at
   `https://dj-z690-steel-legend-d5.tail57901.ts.net/events`).

Both receive the exact same anonymous payload. You can disable either
independently by removing its config key.

### 1. `system_profile` — once at startup

A snapshot of the hardware/software TITAN is running on. One event per boot.

| Field | Example | Why it's collected |
|---|---|---|
| `installId` | `a9f2b1c8…` (64-hex, stable per `~/.titan/`) | Count unique installs without identifying you |
| `version` | `5.0.0` | Which TITAN version is in use |
| `nodeVersion` | `v22.11.0` | Compatibility target decisions |
| `os` | `darwin` / `linux` / `win32` | Platform support priority |
| `osRelease` | `24.1.0` | Catch platform-specific bugs |
| `arch` | `arm64` / `x64` | Build + install flow tuning |
| `cpuModel` | `Apple M3 Max` | Performance expectations |
| `cpuCores` | `14` | Agent-pool sizing defaults |
| `ramTotalMB` | `65536` | Which models you can realistically run |
| `gpuVendor` | `apple` / `nvidia` / `amd` / `none` | Which GPU backends to prioritise |
| `gpuName` | `RTX 5090` | Specific VRAM tier coverage |
| `gpuVramMB` | `32768` | Model-size recommendations |
| `installMethod` | `npm` / `git` / `unknown` | Where users are coming from |
| `diskTotalGB` | `2000` | Check feasibility of large local models |

### 2. `heartbeat` — every 5 minutes while running

A tiny "still alive" ping so we can see MAU and catch startup-only crashes.

| Field | Example | Why |
|---|---|---|
| `installId` | (same as above) | Same install |
| `version` | `5.0.0` | |
| `uptimeSeconds` | `18432` | Detect flapping services |
| `activeSessions` | `3` | Very-rough usage intensity |
| `memoryMB` | `412` | Memory-leak detection |
| `event` | `heartbeat` / `startup` / `shutdown` | Session-lifecycle markers |
| `features.voice` … `features.organism` | `true` / `false` | Which major subsystems are enabled (anonymised adoption metrics) |
| `features.channelsEnabled` | `2` | Count of active messaging channels |
| `features.providersConfigured` | `3` | Count of providers with API keys set (not the keys themselves) |

### 3. Product-usage events — during normal operation

These fire as you use TITAN so we can prioritise engineering effort:

| Event | What's sent | Why |
|---|---|---|
| `model_usage` | `model`: `ollama/qwen3:8b`, `provider`: `ollama`, `success`: `true`, `latency_ms`: `420` | See which models/providers are reliable |
| `tool_call` | `tool`: `shell`, `success`: `true`, `latency_ms`: `120`, `error_type`: `timeout` | Improve flaky tools |
| `feature_toggle` | `feature`: `voice`, `enabled`: `true` | Track feature adoption |
| `channel_change` | `channel`: `discord`, `enabled`: `true` | See which channel adapters matter |
| `provider_change` | `provider`: `anthropic`, `action`: `added` | Provider ecosystem health |
| `soma_proposal` | `drive`: `purpose`, `pressure`: `1.4`, `approved`: `true` | Soma effectiveness |
| `self_mod_pr` | `action`: `created`, `drive`: `self-healing` | Autonomous improvement tracking |

### 4. `error` — when an unhandled exception / promise rejection fires

Only emitted when `telemetry.crashReports === true` (default true IF you
opted in; you can disable just crashes separately).

| Field | Example | Why |
|---|---|---|
| `installId` | (same) | Correlate with known good-bad profiles |
| `version` | `5.0.0` | Which version the crash happened on |
| `message` | `TypeError: Cannot read property ...` | First line of the error |
| `stack` | `at foo ($HOME/.titan/…)` | Stack trace with your `$HOME` path **replaced** by the literal string `$HOME` before sending |
| `fingerprint` | `uncaughtException:TypeError` | For grouping dupes |

Before transmission, crash reports also pass through a **secret scrubber** that
redacts anything matching common credential patterns (Bearer tokens, `sk-…` API
keys, hex strings ≥64 chars, URLs with embedded passwords, PEM private keys).
This is a defence-in-depth layer — we still recommend keeping crash reports
disabled if you work with highly sensitive data.
| `context` | `{ kind: "uncaughtException" }` | Whether it was a rejection vs. exception |

---

## What's NEVER collected

None of the following is ever read, sent, or logged in any telemetry event:

- **Prompts you write**
- **Messages from agents back to you**
- **Any file contents**, paths you opened, search queries, or memory entries
- **Credentials**: API keys, passwords, tokens, OAuth codes, session cookies, wallet keys
- **IP address**: the collector records a `/24` IPv4 prefix (`10.0.0.0`) or `/48` IPv6 prefix, never a full address. PostHog may see their edge IP; TITAN does not send it.
- **Conversations with TITAN** or any specialist
- **Webhook payloads, email bodies, Discord/Slack messages, SMS**
- **Skills you've written, customized, or run**
- **Browser history, cookies, or any state from the Chrome extension integration**

The code that defines exactly what's collected is a public, small, audit-able
file: [`src/analytics/collector.ts`](./src/analytics/collector.ts). If we ever
add a new field, this document and that file change together, in the same PR.

---

## Where the data goes

- **Primary collector**: `https://dj-z690-steel-legend-d5.tail57901.ts.net/events`
  — a single-box Node service running on the project maintainer's hardware.
  Data is stored in SQLite. Only the maintainer has read access.
- **Self-host**: set `telemetry.remoteUrl` in `~/.titan/titan.json` to your
  own collector. The project's open-source collector lives at
  `packages/titan-analytics/` in the repo and runs on Node 20+ with one
  dependency (`better-sqlite3`).
- **Pure local**: set `telemetry.mode: 'local'` — events stay on your disk
  in `~/.titan/telemetry-events.jsonl`, nothing is sent out.

---

## Retention

- Events on the maintainer's collector are retained for **90 days**, then
  aggregated into weekly counts and the raw rows are dropped.
- Local events in `~/.titan/telemetry-events.jsonl` rotate at 10 000 events.

---

## How to opt out, pause, or delete your data

### Turn it off from the UI

1. Open TITAN Mission Control → **Settings** Space.
2. Find the **Privacy** widget (or **Specialist Models** in v5.0 while the
   Privacy widget is rolling out).
3. Toggle off.

### Turn it off via config

Edit `~/.titan/titan.json`:

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

Restart the gateway. Nothing more is sent.

### Delete your data from the collector

Email `tony@elliott.studio` with your `installId` (found in
`~/.titan/titan.json` under `mesh.nodeId` — it's the same ID). Within 7 days,
all events and errors tied to that ID are deleted from the collector's
database. No identity verification is required — the ID itself isn't tied
to a name.

### Delete your data locally

```bash
rm ~/.titan/telemetry-events.jsonl
```

---

## Honest design trade-offs

- **`installId` is stable per `~/.titan/` directory** (generated once, stored
  in `~/.titan/node-id`). This is technically a persistent anonymous ID. If
  you want true anonymity, delete `~/.titan/node-id` periodically — you'll
  appear as a new install each time. We chose stable over rotating so we can
  see whether the same user upgrades versions, not to track you across the
  rest of the internet.
- **Crash fingerprints use the error class name + first line of the message**.
  In rare cases a developer's code path could include a path fragment in an
  error message. We strip `$HOME` before sending, but we can't strip every
  possible leak. If you're worried, disable crash reports specifically:
  `telemetry.crashReports: false`.
- **Tailscale Funnel is the current ingress**. If you're blocking Tailscale
  Funnel hostnames at the network level, telemetry will fail silently (by
  design — we never retry aggressively and never block the UI).

---

## Questions / changes

Open an issue on [GitHub](https://github.com/Djtony707/TITAN/issues) or email
`tony@elliott.studio`. If you want this document to change, so do I —
transparent is the only way this works.

Last updated: 2026-04-23 · TITAN 5.0 "Spacewalk"
