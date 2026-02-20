# Getting Started with TITAN

Last updated: February 20, 2026

## Quick Start

```bash
git clone https://github.com/Djtony707/TITAN.git
cd TITAN
cargo build --release
./target/release/titan setup
```

## What onboarding does

`titan setup` is an interactive setup that configures:
1. Workspace directory
2. Safety mode (`supervised`, `collaborative`, `autonomous`)
3. Discord credentials (optional)
4. LLM provider and model

## Model setup commands

```bash
titan model show
titan model list-ollama
titan model set ollama llama3.2:latest --endpoint http://127.0.0.1:11434
```

Cloud providers:

```bash
titan model set openai gpt-4.1 --api-key-env OPENAI_API_KEY
titan model set anthropic claude-sonnet-4-5 --api-key-env ANTHROPIC_API_KEY
```

## Communication setup commands

```bash
titan comm list
titan comm status discord
titan comm send discord --target <channel_id> --message "TITAN online"
```

For full channel coverage and bridge adapters, see:
- `docs/TITAN_COMMUNICATION_INTEGRATIONS.md`

## Validate everything

```bash
titan doctor
titan model show
titan comm list
```

## Run dashboard

```bash
titan web serve --bind 127.0.0.1:3000
```

Then open `http://127.0.0.1:3000`.
