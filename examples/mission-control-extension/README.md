# Mission Control Extension Example

A custom admin panel for TITAN's Mission Control v2 dashboard. Demonstrates how to build and integrate custom UI panels into the Mission Control interface.

## What This Example Shows

- Creating a React component that integrates with Mission Control v2
- Fetching data from TITAN's REST API
- Displaying real-time agent stats and metrics
- Adding custom controls and actions
- Registering the panel with the dashboard router

## Prerequisites

- Node.js >= 20
- A running TITAN gateway with Mission Control (`titan dev:gateway`)
- Familiarity with React 19 and TypeScript

## Setup

```bash
npm install
```

## Development

```bash
# Watch mode — edit src/panel.tsx and see changes live
npm run dev

# Typecheck
npm run typecheck
```

## How It Works

Mission Control v2 serves a React SPA from `ui/dist/`. Custom panels can be added by:

1. **Create a React component** — Use the same API client pattern as the built-in panels
2. **Register the route** — Add a route entry in the Mission Control router
3. **Add a menu item** — Include your panel in the admin sidebar

This example creates a "System Health" panel that displays:
- CPU and memory usage
- Active sessions
- Tool execution statistics
- Recent error logs

## Panel Structure

```tsx
// Minimal panel structure
export function CustomPanel() {
  const [data, setData] = useState<PanelData | null>(null);

  useEffect(() => {
    // Fetch data from TITAN API
    fetch("/api/stats").then((r) => r.json()).then(setData);
  }, []);

  return (
    <div className="panel">
      {/* Your panel UI here */}
    </div>
  );
}
```

## API Integration

The panel uses the same API client as the built-in panels:

```typescript
import { api } from "../../api/client";

// Fetch agent stats
const stats = await api.get("/api/stats");

// Send a command
await api.post("/api/message", { content: "Hello" });
```

## Adding to Mission Control

To register your custom panel:

1. Copy the compiled panel to `ui/src/components/admin/CustomPanel.tsx`
2. Add a route in `ui/src/App.tsx`:
   ```tsx
   <Route path="/admin/custom" element={<CustomPanel />} />
   ```
3. Add a menu item in the sidebar navigation

## Next Steps

- Explore the [existing 25 admin panels](../../ui/src/components/admin/) for reference patterns
- Study the [API client](../../ui/src/api/client.ts) for data fetching patterns
- Check out the [Multi-Agent Orchestration](../multi-agent-orchestration/) example for advanced agent patterns
