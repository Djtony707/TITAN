/**
 * TITAN Multi-Agent Orchestration — Sub-agents, goals, and budgets.
 *
 * Demonstrates:
 * - Spawning sub-agents with constrained toolsets (explorer, coder, analyst)
 * - Running sub-agents in parallel and sequential modes
 * - Creating goal hierarchies with subtask dependencies
 * - Using Command Post for budget enforcement
 * - Orchestrating complex multi-step workflows
 * - Aggregating results from multiple agents
 *
 * Prerequisites: titan gateway running (titan gateway)
 * Run: npx tsx src/index.ts
 */

const TITAN_URL = process.env.TITAN_URL ?? "http://localhost:48420";

// ============================================================
// Types
// ============================================================

interface SubAgentResult {
  id: string;
  status: string;
  result?: unknown;
  error?: string;
  durationMs: number;
}

interface Goal {
  id: string;
  title: string;
  subtasks: Array<{ id: string; title: string; status: string }>;
}

interface BudgetConfig {
  maxTokens: number;
  maxTimeSeconds: number;
  requireApproval: boolean;
}

// ============================================================
// Multi-Agent Orchestrator
// ============================================================

class Orchestrator {
  private sessionId: string | null = null;

  /**
   * Spawn a sub-agent with a specific template and task.
   */
  async spawnSubAgent(
    template: "explorer" | "coder" | "browser" | "analyst",
    task: string,
    tools?: string[],
  ): Promise<SubAgentResult> {
    const res = await fetch(`${TITAN_URL}/api/agents/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template,
        task,
        tools,
        sessionId: this.sessionId,
      }),
    });

    if (!res.ok) {
      throw new Error(`Spawn failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    this.sessionId = data.sessionId;

    return {
      id: data.agentId,
      status: data.status,
      result: data.result,
      durationMs: data.durationMs,
    };
  }

  /**
   * Run multiple sub-agents in parallel and collect results.
   */
  async runParallel(
    tasks: Array<{
      template: "explorer" | "coder" | "browser" | "analyst";
      task: string;
      tools?: string[];
    }>,
  ): Promise<SubAgentResult[]> {
    console.log(`\nRunning ${tasks.length} sub-agents in parallel...\n`);

    const results = await Promise.all(
      tasks.map(async (t, i) => {
        console.log(`  [${i + 1}/${tasks.length}] Spawning ${t.template}: ${t.task}`);
        try {
          const result = await this.spawnSubAgent(t.template, t.task, t.tools);
          console.log(`  [${i + 1}/${tasks.length}] Done (${result.durationMs}ms)\n`);
          return result;
        } catch (err) {
          console.error(`  [${i + 1}/${tasks.length}] Error: ${(err as Error).message}\n`);
          return {
            id: "error",
            status: "failed",
            error: (err as Error).message,
            durationMs: 0,
          };
        }
      }),
    );

    return results;
  }

  /**
   * Run sub-agents sequentially, passing context between steps.
   */
  async runSequential(
    tasks: Array<{
      template: "explorer" | "coder" | "browser" | "analyst";
      task: string;
      tools?: string[];
    }>,
  ): Promise<SubAgentResult[]> {
    console.log("\nRunning sub-agents sequentially...\n");

    const results: SubAgentResult[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      console.log(`  [${i + 1}/${tasks.length}] Spawning ${t.template}: ${t.task}`);

      try {
        const result = await this.spawnSubAgent(t.template, t.task, t.tools);
        console.log(`  [${i + 1}/${tasks.length}] Done (${result.durationMs}ms)\n`);
        results.push(result);

        // Pass result context to next agent
        if (i < tasks.length - 1 && result.result) {
          const context = JSON.stringify(result.result).slice(0, 500);
          console.log(`  Context for next agent: ${context}...\n`);
        }
      } catch (err) {
        console.error(`  [${i + 1}/${tasks.length}] Error: ${(err as Error).message}\n`);
        results.push({
          id: "error",
          status: "failed",
          error: (err as Error).message,
          durationMs: 0,
        });
      }
    }

    return results;
  }

  /**
   * Create a goal with subtasks and budget.
   */
  async createGoal(
    title: string,
    subtasks: Array<{ title: string; dependsOn?: string[] }>,
    budget?: BudgetConfig,
  ): Promise<Goal> {
    const res = await fetch(`${TITAN_URL}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        subtasks,
        budget,
      }),
    });

    if (!res.ok) {
      throw new Error(`Goal creation failed: ${res.status}`);
    }

    return res.json();
  }

  /**
   * Set a budget for the current session via Command Post.
   */
  async setBudget(budget: BudgetConfig): Promise<void> {
    const res = await fetch(`${TITAN_URL}/api/command-post/budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.sessionId,
        ...budget,
      }),
    });

    if (!res.ok) {
      console.warn(`Warning: Budget setting failed (${res.status})`);
      return;
    }

    console.log(`Budget set: ${budget.maxTokens} tokens, ${budget.maxTimeSeconds}s timeout`);
  }

  /**
   * Get all goals and their status.
   */
  async listGoals(): Promise<Goal[]> {
    const res = await fetch(`${TITAN_URL}/api/goals`);
    if (!res.ok) {
      throw new Error(`Failed to list goals: ${res.status}`);
    }
    return res.json();
  }
}

// ============================================================
// Demo: Research and Code Generation Pipeline
// ============================================================

async function demoParallelResearch() {
  console.log("=== Parallel Research Demo ===\n");
  const orchestrator = new Orchestrator();

  // Set a token budget
  await orchestrator.setBudget({
    maxTokens: 50000,
    maxTimeSeconds: 300,
    requireApproval: false,
  });

  // Run 3 explorers in parallel to research different frameworks
  const results = await orchestrator.runParallel([
    {
      template: "explorer",
      task: "Research TITAN agent framework architecture and capabilities",
    },
    {
      template: "explorer",
      task: "Research OpenClaw agent framework features and design",
    },
    {
      template: "explorer",
      task: "Research Auto-GPT framework limitations and strengths",
    },
  ]);

  console.log("\n=== Results Summary ===\n");
  for (const result of results) {
    console.log(`Agent ${result.id}: ${result.status} (${result.durationMs}ms)`);
    if (result.result) {
      console.log(`  Result: ${JSON.stringify(result.result).slice(0, 200)}...`);
    }
  }
}

async function demoSequentialPipeline() {
  console.log("\n=== Sequential Pipeline Demo ===\n");
  const orchestrator = new Orchestrator();

  // Create a goal
  const goal = await orchestrator.createGoal("Build a CLI tool", [
    { title: "Research requirements" },
    { title: "Design architecture" },
    { title: "Generate code" },
    { title: "Write tests" },
  ]);

  console.log(`Goal created: ${goal.title} (${goal.id})\n`);

  // Run a sequential pipeline: research -> design -> code
  await orchestrator.runSequential([
    {
      template: "explorer",
      task: "Research best practices for building a Node.js CLI tool with TypeScript",
    },
    {
      template: "analyst",
      task: "Analyze the research and create a design document with architecture recommendations",
    },
    {
      template: "coder",
      task: "Generate a CLI tool based on the design document, using TypeScript and ESM",
    },
  ]);

  console.log("\nPipeline complete. Check the Mission Control dashboard for full goal status.");
}

// ============================================================
// Entry Point
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("parallel")) {
    await demoParallelResearch();
  } else if (args.includes("sequential")) {
    await demoSequentialPipeline();
  } else {
    // Run both demos
    await demoParallelResearch();
    await demoSequentialPipeline();
  }
}

main().catch(console.error);
