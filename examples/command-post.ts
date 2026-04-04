/**
 * TITAN Command Post Example — Paperclip-inspired agent governance.
 *
 * This demonstrates how to:
 * 1. List all agents in your registry
 * 2. Check out tasks with atomic task checkout
 * 3. Monitor agent activity feed
 * 4. Track budget enforcement
 *
 * Prerequisites:
 *   - Running TITAN gateway (`titan gateway`)
 *   - Valid Paperclip API key configured
 *
 * Run: npx tsx examples/command-post.ts
 */

const TITAN_URL = process.env.TITAN_URL || "http://localhost:48420";

async function listAgents() {
  console.log("\nRegistered Agents:");
  const res = await fetch(`${TITAN_URL}/api/agents`);
  if (!res.ok) {
    console.log("  Failed to fetch agents:", res.status);
    return [];
  }
  const data = await res.json();
  if (data.agents && data.agents.length > 0) {
    data.agents.forEach((agent: any) => {
      console.log(`  - ${agent.name} (${agent.role})`);
    });
    return data.agents;
  }
  console.log("  No agents found");
  return [];
}

async function getActivityFeed() {
  console.log("\nActivity Feed:");
  const res = await fetch(`${TITAN_URL}/api/agent-activity`);
  if (!res.ok) {
    console.log("  Failed to fetch activity:", res.status);
    return [];
  }
  const data = await res.json();
  if (data.activity && data.activity.length > 0) {
    data.activity.slice(0, 10).forEach((event: any) => {
      console.log(`  [${event.timestamp}] ${event.agent}: ${event.action}`);
    });
    return data.activity;
  }
  console.log("  No recent activity");
  return [];
}

async function checkBudgetCompliance() {
  console.log("\nBudget Compliance:");

  // Fetch agent registry to check budgets
  const res = await fetch(`${TITAN_URL}/api/agents/registry`);
  if (!res.ok) {
    console.log("  Failed to fetch registry:", res.status);
    return;
  }
  const data = await res.json();
  if (data.agents && data.agents.length > 0) {
    data.agents.forEach((agent: any) => {
      const budget = agent.budgetMonthlyCents;
      const spent = agent.spentMonthlyCents || 0;
      const percentage = budget ? ((spent / budget) * 100).toFixed(1) : "0";
      console.log(`  ${agent.name}: $${(spent / 100).toFixed(2)} / $${(budget / 100).toFixed(2)} (${percentage}%)`);
    });
  } else {
    console.log("  No budget data available");
  }
}

async function main() {
  console.log("TITAN Command Post Demo\n");
  console.log("=".repeat(50));

  // Step 1: List registered agents
  await listAgents();

  // Step 2: Show activity feed
  await getActivityFeed();

  // Step 3: Show budget compliance
  await checkBudgetCompliance();

  console.log("\nCommand Post is your governance layer for multi-agent systems.");
  console.log("Learn more: https://github.com/Djtony707/TITAN/blob/main/docs/COMMAND-POST.md");
}

main().catch(console.error);
