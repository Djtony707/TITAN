<p align="center">
  <img src="Titanlogo.jpg" alt="TITAN Logo" width="240" />
</p>

<h1 align="center">TITAN</h1>

<p align="center"><strong>The Intelligent Task Automation Network</strong></p>

<p align="center">
  Rust-based AI agent platform with local-first execution, approval gates, and full traceability.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="experimental" />
  <img src="https://img.shields.io/badge/Rust-1.85%2B-blue" alt="Rust 1.85+" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license" />
  <img src="https://img.shields.io/badge/mode-local--first-6f42c1" alt="local-first" />
</p>

<p align="center">
  <a href="#quickstart-under-10-minutes">Quickstart</a> •
  <a href="#whats-working-now">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#documentation">Docs</a>
</p>

If you want an agent that gets work done and still asks before making big changes, TITAN exists for that.  
It is practical, inspectable, and built so you can see what happened, not just hope it worked.

## What’s Working Now

- Core goal lifecycle runtime
- Deterministic planning + tool execution pipeline
- Policy-gated approvals for risky actions
- SQLite persistence for goals, plans, steps, traces, approvals, and episodic memory
- Event-driven Discord runtime integration
- Local web dashboard + HTTP API
- Skills Registry v1 (search/install/list/inspect/update/remove/run/doctor)
- Onboarding wizard
- Model configuration, including local Ollama discovery

## Requirements

- Rust `1.85+`
- SQLite `3.x`
- Optional: Ollama at `http://127.0.0.1:11434` for local models

## Fast Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Djtony707/TITAN/main/scripts/install.ps1 | iex
```

Local installer usage (from this repo):

```bash
./scripts/install.sh
```

By default, the installer links `titan` into `~/.local/bin` and launches onboarding in interactive terminals.

Optional Homebrew source install (macOS/Linux):

```bash
brew install --HEAD ./packaging/homebrew/titan.rb
```

CLI-only non-interactive installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/scripts/install-cli.sh | bash
```

Winget templates are included at:

```text
packaging/winget/
```

## Quickstart (Under 10 Minutes)

Clone the repo:

```bash
cd /home/$USER/Desktop
git clone https://github.com/Djtony707/TITAN.git
cd TITAN
```

Build the release binary:

```bash
cargo build --release
```

Set Discord environment variables (`DISCORD_TOKEN` alias is also supported):

```bash
export DISCORD_BOT_TOKEN="your-discord-bot-token"
export DISCORD_CHANNEL_ID="your-channel-id"
```

Run onboarding:

```bash
./target/release/titan onboard
```

Fast non-interactive onboarding (uses env vars + safe defaults):

```bash
./target/release/titan onboard --yes
```

Run health checks:

```bash
./target/release/titan doctor
```

Start TITAN:

```bash
./target/release/titan run --bind 127.0.0.1:3000
```

Discord test flow:

- Send `scan workspace` (read-only flow)
- Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and verify run + trace + memory entries
- Send `update readme with install steps` (should create a pending approval in collaborative mode)
- Approve with `/titan approve <approval_id>`
- Verify approval trace + write trace + episodic memory in Web UI

Optional macOS path note:

- Use `/Users/$USER/Desktop/TITAN` instead of `/home/$USER/Desktop/TITAN`.

## First Run (Manual)

```bash
./target/release/titan onboard
# Optional: install startup daemon during setup
./target/release/titan setup --install-daemon
```

Then validate setup:

```bash
titan doctor
titan model show
titan comm list
titan run --bind 127.0.0.1:3000
```

## Core CLI

### Goals

```bash
titan goal submit "Summarize workspace status"
titan goal show <goal_id>
titan goal cancel <goal_id>
```

### Tools & Approvals

```bash
titan tool run list_dir --input .
titan approval list
titan approval approve <approval_id>
```

### Models

```bash
titan model show
titan model list-ollama
titan model set ollama llama3.2:latest --endpoint http://127.0.0.1:11434
```

### Communication

```bash
titan comm list
titan comm status discord
titan comm send discord --target <channel_id> --message "TITAN online"
```

### Web

```bash
titan web serve --bind 127.0.0.1:3000
```

### Skills

```bash
titan skill search docs
titan skill install list-docs@1.0.0 --source local
titan approval list
titan approval approve <approval_id>
titan skill list
titan skill inspect list-docs
titan skill run list-docs --input "docs"
titan skill doctor list-docs
titan skill update --all --source local
titan skill remove list-docs
```

## Install Your First Skill

```bash
# 1) Find a skill in your configured local registry
titan skill search "docs" --source local

# 2) Request install (creates an approval record with scopes/paths/hosts/signature status)
titan skill install list-docs@1.0.0 --source local

# 3) Approve and finalize install
titan approval approve <approval_id>

# 4) Run it through TITAN policy/tool broker
titan skill run list-docs --input "docs"
```

## Architecture

TITAN is split into focused Rust crates:

- `titan-core`: deterministic planning and run model
- `titan-gateway`: event processing and run orchestration
- `titan-memory`: SQLite persistence and approval state
- `titan-comms`: communication adapter layer
- `titan-tools`: tool broker + policy-gated execution
- `titan-skills`: extensibility runtime for skills
- `titan-cli`: onboarding, operations, and runtime entrypoint

## Documentation

- `docs/GETTING_STARTED.md`
- `docs/first_run.md`
- `docs/ONBOARDING.md`
- `docs/API.md`
- `docs/TITAN_COMMUNICATION_INTEGRATIONS.md`
- `docs/skills.md`
- `docs/architecture.md`
- `docs/originality.md`
- `docs/release_checklist.md`

## Quality Gates

Run these before each release:

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
./scripts/release-check.sh
```

## License

MIT. See `LICENSE`.
