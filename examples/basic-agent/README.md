# Basic Agent Example

A minimal CLI agent that demonstrates TITAN's core capabilities: sending messages, using tools, and managing sessions.

## What This Example Shows

- Connecting to a TITAN gateway
- Sending messages and receiving responses
- Using tools (shell, filesystem, web search)
- Session management
- Streaming responses with SSE
- Error handling and retries

## Prerequisites

- Node.js >= 20
- A running TITAN gateway (`titan gateway` or `npx titan-agent gateway`)
- An API key configured in `~/.titan/titan.json`

## Setup

```bash
npm install
```

## Running

```bash
# Quick interactive chat
npm start

# Or run with a specific message
npm start -- "What's the weather in Tokyo?"

# Watch mode for development
npm run dev
```

## How It Works

The basic agent connects to TITAN's REST API at `http://localhost:48420/api/message`. Each message can:

1. **Use tools automatically**: If the LLM decides a tool is needed, TITAN executes it and continues the conversation
2. **Maintain session context**: Pass a `sessionId` to continue a previous conversation
3. **Stream responses**: Add `Accept: text/event-stream` for real-time updates

## Key Files

- `src/index.ts` — Main agent logic (150 lines)
- `src/chat.ts` — Interactive readline chat loop
- `src/tools.ts` — Demonstrates available tools

## API Reference

```typescript
// Send a message
const response = await fetch(`${TITAN_URL}/api/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Your message here" }),
});

const data = await response.json();
// data = { content, sessionId, toolsUsed, durationMs, model }
```

## Next Steps

- Try the [Mission Control Extension](../mission-control-extension/) for custom UI panels
- Explore [Multi-Agent Orchestration](../multi-agent-orchestration/) for sub-agent spawning
- Check out the [Voice Integration](../voice-integration/) for LiveKit voice agents
