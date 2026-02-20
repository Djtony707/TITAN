# Installation Guide

## Requirements

- Rust 1.85+
- SQLite 3.x
- Git

## Install (Manual)

```bash
git clone https://github.com/Djtony707/TITAN.git
cd TITAN
cargo build --release
```

## Fast Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/scripts/install.sh | bash
```

The installer will:
1. Ensure Rust toolchain is present (installs via `rustup` if missing)
2. Clone or update TITAN in `~/TITAN`
3. Build TITAN (release profile)
4. Install `titan` into `~/.local/bin` (with PATH guidance)
5. Launch setup in interactive terminals

Installer flags:

```bash
./scripts/install.sh --help
./scripts/install.sh --dir ~/code/TITAN --skip-onboard
./scripts/install.sh --debug
./scripts/install.sh --no-link
```

## First Setup

```bash
./target/release/titan setup
```

The setup wizard configures workspace, autonomy mode, optional Discord integration, and model provider/model.

## Validate Install

```bash
./target/release/titan doctor
./target/release/titan model show
./target/release/titan comm list
```

## Optional: Run Web Dashboard

```bash
./target/release/titan web serve --bind 127.0.0.1:3000
```

Then open `http://127.0.0.1:3000`.

## Optional: Security and Release Checks

```bash
./scripts/security-check.sh
./scripts/release-check.sh
```

## Troubleshooting

### Build issues

```bash
rustc --version
cargo --version
```

Make sure Rust is installed and up to date.

### Workspace permission issues

Use setup again and choose a writable workspace path:

```bash
./target/release/titan setup
```

### Model discovery issues (Ollama)

If Ollama models are not found:

```bash
./target/release/titan model list-ollama --endpoint http://127.0.0.1:11434
```

Ensure Ollama is running locally.
