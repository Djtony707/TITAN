# TITAN FAQ — Frequently Asked Questions

> New to TITAN? Start here. This FAQ covers the most common questions from developers getting started with TITAN.

## General

### What is TITAN?

TITAN (The Intelligent Task Automation Network) is an open-source, autonomous AI agent framework built in TypeScript. It's published as `titan-agent` on npm and can be self-hosted on your own hardware.

Key features:
- **Autonomous** — Runs without constant supervision
- **Self-improving** — LoRA fine-tuning on your GPU
- **Multi-agent** — Spawns and coordinates sub-agents
- **36 providers** — Connects to Anthropic, OpenAI, Google, Ollama, and more
- **15 channels** — Discord, Slack, Telegram, WhatsApp, etc.
- **Voice** — LiveKit WebRTC voice integration
- **Dashboard** — React Mission Control with 26 admin panels
- **GPU VRAM management** — Auto-swap models for limited memory
- **Mesh networking** — Multi-machine agent communication
- **Open source** — MIT licensed, 5,500+ npm installs

### What is TITAN NOT?

- **Not a chatbot wrapper** — It's a framework for building autonomous agents
- **Not just orchestration** — It has built-in self-improvement, voice, GUI, and mesh
- **Not cloud-only** — Runs entirely locally with Ollama/LLMs on your hardware

### System Requirements

- **Node.js**: 20+
- **OS**: macOS, Linux, Windows (WSL recommended)
- **RAM**: 8GB minimum, 16GB+ recommended
- **GPU** (optional): NVIDIA CUDA for VRAM management, Apple Silicon for Metal

## Installation

### How do I install TITAN?

```bash
npm install -g titan-agent
titan onboard  # Run the onboarding wizard
```

### Can I use TITAN without API keys?

Yes! Install [Ollama](https://ollama.ai) for local inference:

```bash
brew install ollama  # macOS
ollama pull llama3.2  # Download a model
titan onboard  # TITAN will auto-detect Ollama
```

### What's the fastest way to get started?

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/Djtony707/TITAN/main/scripts/install.sh | bash

# Or via npm
npm install -g titan-agent
titan onboard
titan gateway
```

## Concepts

### What is an "agent"?

An agent is an LLM-powered loop that:
1. Receives a task
2. Plans steps
3. Executes tools
4. Observes results
5. Repeats until the task is done

TITAN runs agents in multi-round mode (up to 25 turns) for autonomous task completion.

### What is a "tool"?

Tools are functions the agent can call. TITAN includes 100+ built-in tools:
- `shell` — Execute commands
- `file_read` / `file_write` — File operations
- `web_search` — Web search
- `browser` — Browser automation
- `sub_agent` — Spawn new agents

### What is a "provider"?

Providers connect to LLM APIs. TITAN supports 36 providers:
- **Cloud**: Anthropic, OpenAI, Google, xAI, DeepSeek
- **Local**: Ollama, LM Studio
- **Self-hosted**: LiteLLM, vLLM, Together

### What is a "skill"?

Skills are bundles of tools. For example:
- `weather` — Weather API tools
- `github` — GitHub integration
- `browser` — Browser automation

### What is the "gateway"?

The gateway is TITAN's HTTP API server and dashboard:
- REST API at `/api/*`
- WebSocket for real-time streaming
- Mission Control dashboard (React SPA)

### What is "Mission Control"?

Mission Control is TITAN's React dashboard with 26 admin panels:
- Chat interface
- Model management
- Agent registry
- Goals & tasks
- VRAM monitoring
- Settings & configuration

## Common Questions

### How do I change the model?

Via Mission Control dashboard → Models panel, or:

```bash
curl -X POST http://localhost:48420/api/model/switch \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-sonnet-4-20250514"}'
```

### How do I add a Discord bot?

1. Create a Discord bot at https://discord.com/developers
2. Add to `~/.titan/titan.json`:
```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN",
      "prefix": "!titan"
    }
  }
}
```
3. Restart the gateway

### How do I use local models?

Install Ollama, pull a model, and TITAN will auto-detect it:

```bash
ollama pull qwen2.5:7b
# TITAN will show it in the Models panel
```

### How do I enable voice?

Voice requires Orpheus TTS or browser TTS fallback:

```bash
# Auto-install Orpheus
titan voice install

# Or use browser TTS (no setup needed)
# Enable in Mission Control → Voice panel
```

### How does self-improvement work?

TITAN's autopilot analyzes its own performance and generates training data. It fine-tunes itself on your GPU using LoRA:

1. Enable autopilot: `POST /api/autopilot/toggle`
2. TITAN reviews conversations
3. Generates training examples
4. Fine-tunes with unsloth → GGUF → Ollama
5. Loads the improved model

### Can I run TITAN on a server?

Yes! TITAN supports production deployment with:
- systemd service unit
- Health monitoring
- Log rotation
- Docker deployment

See [docs/DEPLOYMENT.md](DEPLOYMENT.md) (coming soon).

### What is Command Post?

Command Post is TITAN's agent governance system (inspired by Paperclip):
- **Task checkout** — Atomic task assignment
- **Budget enforcement** — Monthly spending limits
- **Agent registry** — List all running agents
- **Activity feed** — Real-time agent monitoring
- **Goal ancestry** — Track goal relationships

### How do I connect multiple machines?

TITAN's mesh networking uses mDNS + WebSocket:
1. Run `titan gateway` on each machine
2. Agents auto-discover via mDNS
3. Communication over HMAC-authenticated WebSocket

## Troubleshooting

### "Cannot connect to gateway"

Check the gateway is running:
```bash
titan gateway
```

### "Model not found"

Run diagnostics:
```bash
titan doctor
```

### "Tool execution failed"

Some tools need specific setup. Run `titan doctor` to check.

### "Agent is stuck in a loop"

TITAN has a 25-turn limit by default. Increase it in `~/.titan/titan.json`:
```json
{ "agent": { "maxTurns": 50 } }
```

### High memory usage

Enable VRAM management for GPU users:
```bash
# TITAN auto-manages VRAM when enabled
# Check status in Mission Control → VRAM panel
```

## Contributing

### How do I contribute?

1. Fork the repo: https://github.com/Djtony707/TITAN
2. Create a branch
3. Make your changes
4. Submit a PR

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### How do I report a bug?

Open an issue: https://github.com/Djtony707/TITAN/issues

### Where's the documentation?

- **This FAQ** — Common questions
- **[FIRST-STEPS.md](FIRST-STEPS.md)** — Beginner tutorial
- **[README.md](../README.md)** — Full documentation
- **[docs/](./)** — Deep-dive docs

## Getting Help

- **GitHub Issues**: https://github.com/Djtony707/TITAN/issues
- **Discussions**: https://github.com/Djtony707/TITAN/discussions
- **Email**: djtony707@gmail.com (Tony Elliott)

---

*Last updated: April 2026. TITAN is actively developed with monthly releases.*
