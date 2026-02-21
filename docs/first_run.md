# TITAN First Run (Ubuntu Desktop)

Use this exact flow to validate the release-grade DONE path.

## 1) Clone

```bash
cd /home/$USER/Desktop
git clone https://github.com/Djtony707/TITAN.git
cd TITAN
```

## 2) Install Build Prerequisites

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev ca-certificates curl git
```

## 3) Build

```bash
cargo build --release
```

## 4) Set Discord Environment Variables

TITAN accepts `DISCORD_BOT_TOKEN` (and `DISCORD_TOKEN` alias) plus optional `DISCORD_CHANNEL_ID`.

```bash
export DISCORD_BOT_TOKEN="your-discord-bot-token"
export DISCORD_CHANNEL_ID="your-channel-id"
```

## 5) Onboard

```bash
./target/release/titan onboard
```

Non-interactive shortcut (recommended when env vars are already set):

```bash
./target/release/titan onboard --yes
```

Recommended onboarding choices:
- mode: `collaborative`
- discord enabled: `true`
- default discord channel id: same as `DISCORD_CHANNEL_ID`

## 6) Run

```bash
./target/release/titan run --bind 127.0.0.1:3000
```

## 7) Discord E2E Validation

Send:

```text
scan workspace
```

Expected:
- bot reply with goal summary
- traces and episodic memory persisted

Then send:

```text
update readme with install steps
```

Expected in collaborative mode:
- write blocked
- pending approval id returned

Approve:

```text
/titan approve <approval_id>
```

Expected:
- write executes after approval
- trace shows approval execution + write diff
- episodic memory updated

## 8) Verify in Web UI

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and confirm:
- mode and queue
- pending approvals
- recent runs/traces
- episodic memory list

## Optional Local Smoke Script

```bash
./scripts/smoke_ubuntu.sh
```

This validates build + doctor + run startup without printing secrets.

## Optional macOS Path Note

If you are on macOS, use:

```text
/Users/$USER/Desktop/TITAN
```
