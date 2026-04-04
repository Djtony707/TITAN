# Multi-Agent Orchestration Example

Demonstrates TITAN's multi-agent capabilities: spawning sub-agents with constrained toolsets, managing goal hierarchies, and enforcing Command Post budgets.

## What This Example Shows

- Spawning sub-agents with specific toolsets (explorer, coder, analyst)
- Running sub-agents in parallel and sequential modes
- Creating goal hierarchies with subtask dependencies
- Using Command Post for budget enforcement
- Orchestrating complex multi-step workflows
- Aggregating results from multiple agents

## Prerequisites

- Node.js >= 20
- A running TITAN gateway (`titan gateway`)
- API key configured for your chosen model

## Setup

```bash
npm install
```

## Running

```bash
# Run the full orchestration demo
npm start

# Try a custom workflow
npm start -- "Research and compare AI frameworks"
```

## How It Works

### Sub-Agent Spawning

TITAN supports four sub-agent templates, each with a constrained toolset:

| Template | Tools | Use Case |
|----------|-------|----------|
| `explorer` | web_search, fetch, browse | Research and gathering |
| `coder` | shell, filesystem, edit | Code generation |
| `browser` | browser pool, Stagehand | Web automation |
| `analyst` | memory, data analysis | Analysis and synthesis |

Sub-agents are isolated — they can't spawn further sub-agents (max depth = 1).

### Goal Hierarchy

Goals have a tree structure with parent goals and subtasks. Each subtask tracks:
- Status (pending, in_progress, complete, blocked)
- Progress percentage
- Budget allocation
- Dependencies on other subtasks

### Command Post Budgets

The Command Post system (inspired by Paperclip) enforces:
- Token budgets per goal/subtask
- Time limits for execution
- Approval gates for dangerous operations
- Audit logging of all agent actions

## Orchestration Patterns

### Parallel Delegation

```
Task: "Research 5 AI frameworks"
  ├── Sub-agent 1 (explorer): Research framework A
  ├── Sub-agent 2 (explorer): Research framework B
  ├── Sub-agent 3 (explorer): Research framework C
  ├── Sub-agent 4 (explorer): Research framework D
  └── Sub-agent 5 (explorer): Research framework E
```

### Sequential Pipeline

```
Task: "Build a web scraper"
  ├── Sub-agent 1 (explorer): Research target website structure
  ├── Sub-agent 2 (coder): Generate scraper code
  └── Sub-agent 3 (analyst): Validate and optimize
```

### Mixed Mode

```
Task: "Create a blog post"
  ├── Parallel research (3 explorers)
  │   ├── Research topic
  │   ├── Analyze competitors
  │   └── Find keywords
  └── Sequential creation
      ├── Outline (analyst)
      ├── Draft (coder)
      └── Review (analyst)
```

## API Reference

```typescript
// Spawn a sub-agent
const result = await fetch(`${TITAN_URL}/api/agents/spawn`, {
  method: "POST",
  body: JSON.stringify({
    template: "explorer",
    task: "Research X",
    tools: ["web_search", "fetch"],
  }),
});

// Create a goal with subtasks
await fetch(`${TITAN_URL}/api/goals`, {
  method: "POST",
  body: JSON.stringify({
    title: "My Goal",
    subtasks: [
      { title: "Step 1", dependsOn: [] },
      { title: "Step 2", dependsOn: ["Step 1"] },
    ],
  }),
});
```

## Next Steps

- Explore the [Command Post dashboard](http://localhost:48420/admin/command-post) in Mission Control
- Check out the [MCP Server](../mcp-server/) for tool exposure to external clients
- Read about [TITAN's autonomy system](../../README.md#autonomy-system) in the main README
