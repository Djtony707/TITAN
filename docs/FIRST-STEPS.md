# First Steps with TITAN — A Developer's Tutorial

> This guide walks you through your first hour with TITAN. By the end, you'll have a running agent, understand the core concepts, and know how to build your first TITAN application.

## Prerequisites

- **Node.js 20+** installed (check with `node --version`)
- **API key** for at least one LLM provider (OpenAI, Anthropic, etc.) or [Ollama](https://ollama.ai) for local models
- Basic familiarity with TypeScript/JavaScript

## Step 1: Install TITAN

```bash
# Install globally
npm install -g titan-agent

# Verify installation
titan --version
```

## Step 2: First-Time Setup

Run the onboarding wizard:

```bash
titan onboard
```

This interactive wizard will:
1. Detect your system capabilities
2. Prompt you to select an LLM provider
3. Configure API keys (stored in `~/.titan/titan.json`)
4. Run a health check to verify everything works

**Pro tip**: For local inference without API keys, install [Ollama](https://ollama.ai) first. TITAN will auto-detect it.

## Step 3: Start the Gateway

The gateway is TITAN's HTTP API server and dashboard:

```bash
titan gateway
```

This starts the gateway on **http://localhost:48420** where:
- **/** — Mission Control dashboard (React SPA with 26 admin panels)
- **/api/\*** — REST API for programmatic access
- **/ws** — WebSocket for real-time agent streaming

## Step 4: Try the Dashboard

Open your browser to http://localhost:48420 and:
1. Click the **Chat** tab to send messages to TITAN
2. Explore **Models** to see available LLM providers
3. Check **Stats** for usage metrics
4. Browse **Goals** to see TITAN's autonomous tasks

## Step 5: Run Your First Example

TITAN ships with runnable examples. Start with the quick-start:

```bash
npx tsx examples/quick-start.ts
```

This sends a message to TITAN and prints the response. Study the code to understand the API format.

## Step 6: Understand the Architecture

TITAN is built on these core concepts:

### Agent
The agent is the core loop: receives input, routes to LLM, executes tools, loops until task complete. TITAN runs multi-round (up to 25 turns in autonomous mode).

### Tools
Tools are functions the agent can call. TITAN includes 100+ built-in tools:
- `shell` — Execute shell commands
- `file_read` / `file_write` — Filesystem operations
- `web_search` — Web search
- `browser` — Browser automation
- `sub_agent` — Spawn a new agent

Tools are defined with Zod schemas for type safety.

### Providers
Providers connect to LLM APIs. TITAN supports 36 providers:
- Cloud: Anthropic, OpenAI, Google, xAI, DeepSeek, etc.
- Local: Ollama, LM Studio, Ollama-compatible
- Self-hosted: LiteLLM, vLLM, Together

Model format: `"provider/model-name"` (e.g., `"anthropic/claude-sonnet-4-20250514"`)

### Skills
Skills are bundles of tools. For example:
- `weather` — Weather API tools
- `github` — GitHub integration
- `browser` — Browser automation

Skills can be loaded from npm or your local filesystem.

### Channels
Channels connect TITAN to communication platforms:
- Discord, Slack, Telegram, WhatsApp, Signal, Matrix, IRC, iMessage, Facebook Messenger, etc.

TITAN listens on all enabled channels and responds to messages.

### Gateway
The gateway is an Express server that provides:
- REST API (`/api/message`, `/api/config`, `/api/models`, etc.)
- WebSocket streaming for real-time agent output
- Mission Control dashboard (React SPA)

## Step 7: Create Your First TITAN App

Let's create a simple research agent. Create a new file `my-research-agent.ts`:

```typescript
import { TITAN } from 'titan-agent';

// Create a TITAN client (auto-detects gateway URL)
const titan = new TITAN({
  apiUrl: 'http://localhost:48420',
});

async function main() {
  console.log('Researching AI frameworks...');

  // Send a message (streaming response)
  const response = await titan.sendMessage({
    content: 'Research the top 3 AI agent frameworks in 2026 and compare their features.',
    model: 'anthropic/claude-sonnet-4-20250514',
    onStream: (chunk) => {
      if (chunk.content) process.stdout.write(chunk.content);
    },
  });

  console.log(`\n\nTools used: ${response.toolsUsed?.join(', ')}`);
  console.log(`Model: ${response.model}`);
  console.log(`Duration: ${response.durationMs}ms`);
}

main();
```

Run it:

```bash
npx tsx my-research-agent.ts
```

## Step 8: Configure TITAN for Your Use Case

TITAN's config lives at `~/.titan/titan.json`. Key settings:

```json
{
  "agent": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "maxTurns": 25
  },
  "gateway": {
    "port": 48420,
    "auth": {
      "mode": "token",
      "token": "your-secret-token"
    }
  },
  "channels": {
    "discord": {
      "enabled": true,
      "token": "YOUR_DISCORD_BOT_TOKEN",
      "prefix": "!titan"
    }
  },
  "providers": {
    "ollama": {
      "url": "http://localhost:11434"
    }
  }
}
```

## Step 9: Explore Advanced Features

Once you're comfortable with the basics:

- **Self-improvement** — Enable autopilot for TITAN to improve itself
- **VRAM management** — Manage GPU memory for local models
- **Sub-agents** — Spawn parallel agents for multi-agent workflows
- **Command Post** — Multi-agent governance with task checkout and budgets
- **Voice** — LiveKit WebRTC voice integration
- **Mesh networking** — Multi-machine agent communication

See the [examples](../examples/) directory for code samples.

## Where to Go Next

- **[Full README](../README.md)** — Complete documentation
- **[Architecture](ARCHITECTURE.md)** — Deep dive into TITAN's internals
- **[API Reference](API.md)** — REST API documentation
- **[Skills](../src/skills/builtin/)** — Browse built-in skills
- **[Mission Control](../ui/)** — React dashboard source

## Common Issues

### "Cannot connect to gateway"
Make sure the gateway is running: `titan gateway`

### "Model not found"
Verify your API key is configured. Run `titan doctor` for diagnostics.

### "Tool execution failed"
Some tools require specific setup (e.g., Ollama for local models, Docker for sandbox). Run `titan doctor` to check.

## Getting Help

- **GitHub Issues**: https://github.com/Djtony707/TITAN/issues
- **Discussions**: https://github.com/Djtony707/TITAN/discussions
- **Docs**: See the `docs/` directory in the repo

---

**Welcome to TITAN!** If you have questions, don't hesitate to reach out on GitHub.
