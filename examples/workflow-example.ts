/**
 * TITAN Workflow Example — spawn multiple sub-agents and coordinate their work.
 *
 * This demonstrates how to:
 * 1. Spawn browser sub-agents for parallel research
 * 2. Synthesize results from multiple sources
 * 3. Generate a structured report from aggregated findings
 *
 * Prerequisites: a running TITAN gateway (`titan gateway`).
 * Run: npx tsx examples/workflow-example.ts
 */

const TITAN_URL = process.env.TITAN_URL || "http://localhost:48420";

async function main() {
  console.log("Starting workflow example...\n");

  // Step 1: Create a workflow that spawns multiple sub-agents
  console.log("Sending multi-agent research task...\n");
  const res = await fetch(`${TITAN_URL}/api/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `I need a comprehensive analysis of three AI agent frameworks.

Please spawn browser sub-agents to research each framework separately:

1. **Agent A**: Research CrewAI — focus on architecture, tool ecosystem, and Python integration
2. **Agent B**: Research LangGraph — focus on state management, graph workflows, and LangChain integration
3. **Agent C**: Research AutoGen — focus on multi-agent collaboration, Microsoft ecosystem, and conversational patterns

For each framework, collect:
- Primary programming language
- Key architectural patterns
- Tool/function calling capabilities
- Community size and adoption metrics
- Strengths and weaknesses

Then synthesize all three into comparison table format.` }),
  });

  if (!res.ok) {
    throw new Error(`TITAN returned ${res.status}: ${await res.text()}`);
  }

  // Read SSE stream for real-time workflow progress
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") {
        console.log("\n\nWorkflow complete.");
        return;
      }
      try {
        const event = JSON.parse(payload);
        if (event.content) {
          // Show framework detection events
          if (event.content.includes("Agent") || event.content.includes("sub-agent")) {
            console.log(`\n${event.content}`);
          }
        }
        if (event.toolsUsed && event.toolsUsed.length > 0) {
          console.log(`\nTools used this round: ${event.toolsUsed.join(", ")}`);
        }
      } catch {
        // Skip non-JSON, show as content
        if (event.content && !Array.isArray(event.toolsUsed)) {
          process.stdout.write(event.content);
        }
      }
    }
  }
}

main().catch(console.error);
