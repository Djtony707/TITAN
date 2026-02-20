# TITAN

TITAN is a Rust-based AI agent platform with local-first operation, explicit approval gates, and multi-channel communication support.

If you want an agent that is useful, auditable, and less likely to do something dramatic at 2 AM, this is the project.

## What’s Working Now

- Core goal lifecycle runtime
- Tool policy engine + approval workflow
- SQLite memory + trace persistence
- Web dashboard + HTTP API
- Multi-channel communication surface (native + bridge adapters)
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

NPM global install (release assets required):

```bash
npm install -g @titan-ai/cli@latest
# or: pnpm add -g @titan-ai/cli@latest
```

Local installer usage (from this repo):

```bash
./scripts/install.sh
```

By default, the installer links `titan` into `~/.local/bin` and starts onboarding automatically in interactive terminals.

Optional Homebrew source install (macOS/Linux):

```bash
brew install --HEAD ./packaging/homebrew/titan.rb
```

CLI-only non-interactive installer:

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/scripts/install-cli.sh | bash
```

Winget manifest templates are included at:

```text
packaging/winget/
```

## Build

```bash
cargo build --release
```

## First Run

```bash
./target/release/titan setup
# Optional: install startup daemon as part of setup
./target/release/titan setup --install-daemon
```

Then validate setup:

```bash
./target/release/titan doctor
./target/release/titan model show
./target/release/titan comm list
```

## Core CLI

### Goal Runtime

```bash
titan goal submit "Summarize workspace status"
titan goal show <goal_id>
titan goal cancel <goal_id>
```

### Tools and Approvals

```bash
titan tool run list_dir --input .
titan approval list
titan approval approve <approval_id>
```

### Model Configuration

```bash
titan model show
titan model list-ollama
titan model set ollama llama3.2:latest --endpoint http://127.0.0.1:11434
```

### Communication Integrations

```bash
titan comm list
titan comm status discord
titan comm send discord --target <channel_id> --message "TITAN online"
```

### Web Dashboard

```bash
titan web serve --bind 127.0.0.1:3000
```

Open `http://127.0.0.1:3000` and you’re in business.

## Documentation

- `docs/GETTING_STARTED.md`
- `docs/ONBOARDING.md`
- `docs/API.md`
- `docs/TITAN_COMMUNICATION_INTEGRATIONS.md`
- `docs/architecture.md`
- `docs/originality.md`

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
