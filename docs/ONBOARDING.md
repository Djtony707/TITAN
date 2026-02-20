# TITAN Onboarding Guide

Last updated: February 20, 2026

This guide matches the current CLI implementation.

## 1. Build TITAN

```bash
cargo build --release
```

## 2. Run the setup wizard

```bash
./target/release/titan setup
```

(`titan setup` is an alias for `titan onboard`.)  

The wizard configures:
1. Workspace path
2. Autonomy mode (`supervised`, `collaborative`, `autonomous`)
3. Discord integration (optional)
4. LLM provider and model selection

## 3. Model selection (including local Ollama)

When you select `ollama` in setup, TITAN discovers local models from:
1. Ollama API (`/api/tags`)
2. `ollama list` CLI output
3. Local manifest files under `~/.ollama/models/manifests`

You can manage models later with:

```bash
titan model show
titan model list-ollama
titan model set ollama llama3.2:latest --endpoint http://127.0.0.1:11434
```

Other providers:

```bash
titan model set openai gpt-4.1 --api-key-env OPENAI_API_KEY
titan model set anthropic claude-sonnet-4-5 --api-key-env ANTHROPIC_API_KEY
```

## 4. Verify your setup

```bash
titan doctor
titan model show
titan comm list
```

Optional channel checks:

```bash
titan comm status discord
titan comm status telegram
titan comm status slack
```

## 5. Config file location

By default TITAN writes config to:
- `~/.titan/config.toml`

Override path with:
- `TITAN_CONFIG=/custom/path/config.toml`

## 6. Next steps

1. Start web dashboard: `titan web serve`
2. Submit a goal: `titan goal submit "Summarize my workspace structure"`
3. Configure more channels: see `docs/TITAN_COMMUNICATION_INTEGRATIONS.md`
