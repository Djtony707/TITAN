# TITAN

TITAN is a Rust-based AI agent platform with local-first operation, explicit approval gates, and multi-channel communication support.

## Current Status

- Core goal lifecycle runtime is implemented.
- Tool policy and approval flow are implemented.
- SQLite memory and trace persistence are implemented.
- Web dashboard and API are implemented.
- Multi-channel communication surface is implemented (native + bridge adapters).
- Onboarding wizard and model configuration (including local Ollama discovery) are implemented.

## Requirements

- Rust 1.85+
- SQLite 3.x
- Optional: Ollama for local models (`http://127.0.0.1:11434`)

## Build

```bash
cargo build --release
```

## First Run

```bash
./target/release/titan onboard
```

Then validate:

```bash
./target/release/titan doctor
./target/release/titan model show
./target/release/titan comm list
```

## Key CLI Commands

### Goal runtime

```bash
titan goal submit "Summarize workspace status"
titan goal show <goal_id>
titan goal cancel <goal_id>
```

### Tools and approvals

```bash
titan tool run list_dir --input .
titan approval list
titan approval approve <approval_id>
```

### Model configuration

```bash
titan model show
titan model list-ollama
titan model set ollama llama3.2:latest --endpoint http://127.0.0.1:11434
```

### Communication integrations

```bash
titan comm list
titan comm status discord
titan comm send discord --target <channel_id> --message "TITAN online"
```

### Web dashboard

```bash
titan web serve --bind 127.0.0.1:3000
```

## Documentation

- `docs/GETTING_STARTED.md`
- `docs/ONBOARDING.md`
- `docs/API.md`
- `docs/TITAN_COMMUNICATION_INTEGRATIONS.md`
- `docs/architecture.md`
- `docs/originality.md`

## Quality Gates

```bash
cargo fmt --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
./scripts/release-check.sh
```

## License

MIT. See `LICENSE`.
