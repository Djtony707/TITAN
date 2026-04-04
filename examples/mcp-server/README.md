# MCP Server Example

A Model Context Protocol (MCP) server that exposes TITAN's tools to Claude Desktop, Cursor, and other MCP-compatible clients via JSON-RPC 2.0 over stdio and HTTP.

## What This Example Shows

- Implementing an MCP server with TITAN
- Exposing 200+ tools via JSON-RPC 2.0
- Configuring stdio and HTTP transports
- Integrating with Claude Desktop and Cursor
- Tool discovery and capabilities advertising
- Error handling and response formatting

## Prerequisites

- Node.js >= 20
- Claude Desktop, Cursor, or another MCP client
- A running TITAN gateway (`titan gateway`)

## Setup

```bash
npm install
```

## Running

```bash
# Start MCP server in stdio mode
npm start

# Or use directly with TITAN
npx titan-agent mcp
```

## Configuring MCP Clients

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "titan": {
      "command": "npx",
      "args": ["titan-agent", "mcp"]
    }
  }
}
```

### Cursor

Add `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "titan": {
      "command": "npx",
      "args": ["titan-agent", "mcp"]
    }
  }
}
```

## How MCP Works

MCP (Model Context Protocol) is a JSON-RPC 2.0 protocol that allows AI clients to discover and call tools from external servers. The flow:

1. **Discovery**: Client requests available tools via `tools/list`
2. **Call**: Client invokes a tool via `tools/call` with parameters
3. **Response**: Server returns the result

TITAN exposes all 200+ tools through this protocol:
- `shell` — Execute shell commands
- `read_file` / `write_file` — File operations
- `web_search` — Web search via providers
- `memory_*` — Memory graph operations
- `goal_*` — Goal management
- And many more...

## Architecture

```
┌──────────────┐     JSON-RPC 2.0     ┌──────────────┐
│  MCP Client  │  (stdio or HTTP)     │ TITAN MCP    │
│ (Claude, etc)│◄────────────────────►│   Server     │
└──────────────┘                      └──────┬───────┘
                                             │
                                     ┌───────▼───────┐
                                     │  TITAN Agent  │
                                     │  (200+ tools) │
                                     └───────────────┘
```

## Tools Exposed

All TITAN tools are available via MCP. Get the full list:

```bash
curl http://localhost:48420/api/tools
```

Popular tools include:
- `shell` — Run shell commands
- `read_file` / `write_file` / `edit_file` — File operations
- `web_search` — Web search
- `fetch` — HTTP requests
- `memory_query` / `memory_add` — Memory operations
- `goal_create` / `goal_list` — Goal management

## Next Steps

- Explore the [Basic Agent](../basic-agent/) for direct API usage
- Check out [Multi-Agent Orchestration](../multi-agent-orchestration/) for advanced patterns
- Read the [MCP specification](https://modelcontextprotocol.io/) for protocol details
