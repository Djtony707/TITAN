# API Reference

> **Note:** Full API documentation coming soon. This is a placeholder for the upcoming release.

## Discord API

### Commands

| Command | Description | Permission |
|---------|-------------|------------|
| `!status` | Show system status and current mode | Any |
| `!goal <text>` | Submit a new goal to TITAN | Any |
| `!mode <mode>` | Change autonomy mode (supervised/collaborative/autonomous) | Admin |
| `!approve <id>` | Approve a pending action | Any |
| `!deny <id>` | Deny a pending action | Any |
| `!memory <query>` | Query episodic memory | Any |
| `!emergency` | Stop all operations immediately | Any |
| `!persona <name>` | Switch reasoning mode | Any |
| `!agents` | List active sub-agents | Any |

### Events

TITAN emits the following Discord events:

- `goal_created` — New goal submitted
- `action_pending` — Action awaiting approval
- `action_executed` — Action completed
- `mode_changed` — Autonomy mode changed
- `error` — Error occurred

## Web API

REST API endpoints for the web dashboard.

### Status

```
GET /api/status
```

Returns current system status.

### Goals

```
GET    /api/goals          # List all goals
POST   /api/goals          # Create new goal
GET    /api/goals/:id      # Get goal details
DELETE /api/goals/:id      # Cancel goal
```

### Approvals

```
GET  /api/approvals        # List pending approvals
POST /api/approvals/:id    # Approve action
DELETE /api/approvals/:id  # Deny action
```

### Memory

```
GET /api/memory/search?q=<query>  # Search memory
GET /api/memory/traces            # List execution traces
```

## WebSocket API

Real-time updates for the dashboard.

### Connection

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');
```

### Messages

```javascript
// Client → Server
{ "type": "subscribe", "channel": "approvals" }

// Server → Client
{ "type": "approval_pending", "data": { "id": "...", "action": "..." } }
```

---

**Full documentation with examples coming in v0.2.0**

For now, see:
- [Getting Started](GETTING_STARTED.md)
- [Discord Commands Reference](#discord-commands)

Need help? Join [Discord](https://discord.gg/titan)
