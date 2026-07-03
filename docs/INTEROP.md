# TITAN ↔ Hermes ↔ OpenClaw — Agent Interop

TITAN plays well with other agents. The backbone is **MCP** (Model Context
Protocol) in both directions — every edge below ships today, no adapters, no
custom protocols.

## TITAN as a tool inside other agents

First, enable the server surface (off by default — exposing an agent on your
gateway port is an explicit choice):

```jsonc
// titan.json
{ "mcp": { "server": { "enabled": true } } }
```

TITAN's MCP server (stdio or HTTP at `POST /mcp`) then exposes **agent-level
tools** in addition to its granular toolset:

| Tool | What it does |
|---|---|
| `titan_chat` | One conversational turn — TITAN runs its full agent loop (tools included) and returns the answer. `sessionId` continues a conversation. |
| `titan_delegate_task` | Fire-and-forget a long job; returns a `taskId` immediately. |
| `titan_task_status` | Poll a delegated task: running / done (+result) / failed. |
| `titan_moa` | Ask TITAN's Mixture-of-Agents council — several models advise, one aggregator answers. |
| `titan_status` | Identity + health for peer discovery. |

These are MCP-surface only — TITAN's own model never sees them, so there is
no recursion path. They respect `security.deniedTools` / `security.allowedTools`.

### Register TITAN in Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  titan:
    command: titan
    args: ["mcp", "serve"]
```

Then `/reload-mcp` in Hermes — TITAN's tools appear as `mcp_titan_*`.
(HTTP transport works too: point at `http://<host>:48420/mcp` if your TITAN
gateway is remote.)

### Register TITAN in OpenClaw

```bash
openclaw mcp add titan --command titan --arg mcp --arg serve
```

## Other agents as tools inside TITAN

TITAN's MCP client can consume any MCP server. Both peers ship one:

```jsonc
// titan.json → mcp.servers
{
  "hermes":   { "command": "hermes",   "args": ["mcp", "serve"] },
  "openclaw": { "command": "openclaw", "args": ["mcp", "serve", "--token-file", "~/.openclaw/gateway.token"] }
}
```

Hermes exposes conversations/messages/events/approvals; OpenClaw bridges its
gateway (conversations, messages, permissions). TITAN can then message either
agent, await their events, and delegate work — from inside any TITAN
conversation or automation.

### Bonus: peers as models

Both Hermes (`:8642`) and OpenClaw (`:18789`, disabled by default) expose
OpenAI-compatible chat endpoints — add either as a TITAN `litellm`-style
provider route and a whole agent becomes a callable "model", including as a
**MoA advisor**: a mixture whose references are other *agents*, not just
models.

## Why MCP (and not A2A / proprietary meshes)

Evaluated July 2026: A2A has no support in either peer (open issues only);
hosted agent networks are cloud-dependent (wrong for local-first); OpenClaw's
raw gateway WebSocket is already wrapped by its own `mcp serve`. MCP is the
one surface all three systems ship natively, and the upcoming MCP Tasks spec
maps directly onto `titan_delegate_task`/`titan_task_status`.
